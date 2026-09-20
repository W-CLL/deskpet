const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { CONTENT_TYPES, LEGACY_CONTENT_TYPES } = require('../lib/content-types');
const { supportedContentTypes } = require('../src/services/content-service');
const { OverviewService } = require('../src/services/overview-service');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

async function fixture(context, companionOptions = {}) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-experience-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const app = await createApplication({ dataDirectory, publicUrl: 'http://127.0.0.1',
    cookieSecure: false, signingPrivateKey: privateKey, companionOptions });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  async function request(url, headers = {}, method = 'GET', body) {
    const response = await fetch(`${base}${url}`, { method, headers: {
      ...headers, ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'image/gif' : 'application/json' } : {})
    }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function trial(platform = 'windows') {
    const installationId = crypto.randomBytes(16).toString('hex');
    const credential = crypto.randomBytes(32).toString('base64url');
    const headers = { Authorization: `Trial ${installationId}.${credential}`,
      'X-DeskPet-Platform': platform, 'X-DeskPet-Version': platform === 'android' ? '1.3.12' : '3.2.10' };
    assert.equal((await request('/api/trial', {}, 'POST', { installationId, credential,
      appVersion: headers['X-DeskPet-Version'] })).status, 200);
    return { installationId, credential, accountId: `trial:${installationId}`, headers };
  }
  async function activate(device, code = app.activationStore.createCodes({ count: 1 }).codes[0]) {
    const result = await request('/api/activate', { 'X-DeskPet-Platform': 'windows' }, 'POST', {
      code, installationId: device.installationId, credential: device.credential, appVersion: '3.2.10'
    });
    assert.equal(result.status, 200);
    return { ...result.body, headers: { Authorization: `Bearer ${result.body.licenseId}.${device.credential}` } };
  }
  return { app, request, trial, activate };
}

test('trial hall is opt-in, supports sending and receiving, and does not unlock private pairing', async (context) => {
  const { app, request, trial, activate } = await fixture(context);
  const first = await trial('android');
  const second = await activate(await trial('macos'));
  const profile = await request('/api/companion', first.headers);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.hallEnabled, false);
  assert.equal(profile.body.online, false);
  assert.equal(profile.body.pairingCode, '');
  assert.equal(profile.body.partner, null);
  assert.equal((await request('/api/companion', second.headers)).body.hallEnabled, false);
  assert.deepEqual((await request('/api/companion/hall', first.headers)).body.people, []);

  const trialCode = app.companionStore.ensureProfile(first.accountId).pairing_code;
  assert.equal((await request('/api/companion/pair', second.headers, 'POST', { code: trialCode })).status, 404);
  for (const [url, method, body] of [
    ['/api/companion/pair', 'POST', { code: 'ABCDEFGH' }],
    ['/api/companion/pair', 'DELETE'],
    ['/api/companion/deliveries', 'POST', GIF]
  ]) assert.equal((await request(url, first.headers, method, body)).status, 403);

  assert.equal((await request('/api/companion', first.headers, 'PATCH', { displayName: '体验朋友' })).status, 200);
  assert.equal((await request('/api/companion', first.headers, 'PATCH', { displayName: '长'.repeat(13) })).status, 400);
  await request('/api/companion/hall', second.headers, 'PATCH', { enabled: true });
  const target = `/api/companion/hall/deliveries/${encodeURIComponent(second.accountId)}`;
  assert.equal((await request(target, first.headers, 'POST', GIF)).body.code, 'COMPANION_HALL_DISABLED');
  assert.equal((await request('/api/companion/hall', first.headers, 'PATCH', { enabled: true })).body.pairingCode, '');
  assert.equal((await request('/api/companion/hall', first.headers)).body.people[0].id, second.accountId);
  const sent = await request(`${target}?message=${encodeURIComponent('送你一只小猫')}`, first.headers, 'POST', GIF);
  assert.equal(sent.status, 201);
  assert.equal(Date.parse(sent.body.expiresAt) - Date.parse(sent.body.createdAt), 24 * 60 * 60 * 1000);
  const inbox = await request('/api/companion/deliveries', second.headers);
  assert.equal(inbox.body.deliveries[0].senderName, '体验朋友');
  assert.equal(inbox.body.deliveries[0].message, '送你一只小猫');
  assert.equal((await request(target, first.headers, 'POST', GIF)).status, 429);

  const reply = await request(`/api/companion/hall/deliveries/${encodeURIComponent(first.accountId)}`,
    second.headers, 'POST', GIF);
  assert.equal(reply.status, 201);
  const trialInbox = await request('/api/companion/deliveries', first.headers);
  assert.equal(trialInbox.body.deliveries.length, 1);
  assert.equal((await request(`/api/companion/deliveries/${reply.body.id}/acknowledge`, first.headers, 'POST')).status, 200);
  assert.deepEqual((await request('/api/companion/deliveries', first.headers)).body.deliveries, []);

  await request('/api/companion/hall', second.headers, 'PATCH', { enabled: false });
  assert.deepEqual((await request('/api/companion/hall', first.headers)).body.people, []);
  assert.equal((await request(target, first.headers, 'POST', GIF)).body.code, 'COMPANION_HALL_RECIPIENT_OFFLINE');
  app.activationStore.database.prepare('UPDATE trials SET expires_at = ? WHERE installation_id = ?')
    .run('2000-01-01T00:00:00.000Z', first.installationId);
  assert.equal((await request('/api/companion/hall', first.headers)).status, 401);
  assert.equal((await request(target, first.headers, 'POST', GIF)).status, 401);
});

test('trial hall retains the queue limit and validates oversized messages', async (context) => {
  const { request, trial } = await fixture(context, { cooldownMs: 0 });
  const sender = await trial();
  const recipient = await trial();
  for (const device of [sender, recipient]) await request('/api/companion/hall', device.headers, 'PATCH', { enabled: true });
  const target = `/api/companion/hall/deliveries/${encodeURIComponent(recipient.accountId)}`;
  assert.equal((await request(`${target}?message=${'x'.repeat(121)}`, sender.headers, 'POST', GIF)).status, 400);
  for (let index = 0; index < 3; index += 1) assert.equal((await request(target, sender.headers, 'POST', GIF)).status, 201);
  assert.equal((await request(target, sender.headers, 'POST', GIF)).body.code, 'COMPANION_QUEUE_FULL');
});

test('activating after hall trial preserves nickname, choice, pending visits and receipts', async (context) => {
  const { app, request, trial, activate } = await fixture(context, { cooldownMs: 0 });
  const sender = await trial();
  const recipient = await trial();
  for (const device of [sender, recipient]) await request('/api/companion/hall', device.headers, 'PATCH', { enabled: true });
  await request('/api/companion', recipient.headers, 'PATCH', { displayName: '我的昵称' });
  const target = `/api/companion/hall/deliveries/${encodeURIComponent(recipient.accountId)}`;
  const received = await request(target, sender.headers, 'POST', GIF);
  await request(`/api/companion/deliveries/${received.body.id}/acknowledge`, recipient.headers, 'POST');
  const pending = await request(target, sender.headers, 'POST', GIF);
  const activated = await activate(recipient);
  const profile = (await request('/api/companion', activated.headers)).body;
  assert.equal(profile.displayName, '我的昵称');
  assert.equal(profile.hallEnabled, true);
  assert.match(profile.pairingCode, /^[23456789A-HJ-NP-Z]{8}$/);
  assert.deepEqual((await request('/api/companion/deliveries', activated.headers)).body.deliveries.map((item) => item.id), [pending.body.id]);
  assert.equal(app.companionStore.database.prepare('SELECT 1 FROM companion_profiles WHERE account_id = ?').get(recipient.accountId), undefined);
});

test('adding a trial device to an existing account preserves that account hall choice', async (context) => {
  const { app, request, trial, activate } = await fixture(context);
  const code = app.activationStore.createCodes({ count: 1 }).codes[0];
  const existing = await activate(await trial(), code);
  await request('/api/companion', existing.headers, 'PATCH', { displayName: '原账号' });
  await request('/api/companion/hall', existing.headers, 'PATCH', { enabled: false });
  const joining = await trial();
  await request('/api/companion/hall', joining.headers, 'PATCH', { enabled: true });
  const added = await activate(joining, code);
  assert.equal(added.accountId, existing.accountId);
  const profile = (await request('/api/companion', added.headers)).body;
  assert.equal(profile.hallEnabled, false);
  assert.equal(profile.displayName, '原账号');
});

test('new interaction profiles use current remote defaults without overwriting existing preferences', async (context) => {
  const { app, request, trial } = await fixture(context);
  await app.store.updateSiteSettings({ defaults: { interactionMode: 'lively' } });
  const existing = await trial();
  assert.equal((await request('/api/interactions/profile', existing.headers)).body.profile.mode, 'lively');
  await request('/api/interactions/profile', existing.headers, 'PATCH', { mode: 'quiet', promptsEnabled: false });
  await app.store.updateSiteSettings({ defaults: { interactionMode: 'standard' } });
  const profile = (await request('/api/interactions/profile', existing.headers)).body.profile;
  assert.equal(profile.mode, 'quiet');
  assert.equal(profile.promptsEnabled, false);
  const fresh = await trial();
  assert.equal((await request('/api/interactions/profile', fresh.headers)).body.profile.mode, 'standard');
});

test('current Windows, macOS and Android support six content types while older clients remain compatible', async (context) => {
  const { request, trial } = await fixture(context);
  const device = await trial();
  for (const [platform, current, legacy] of [['windows', '3.2.9', '2.5.1'], ['macos', '3.2.9', '3.2.8'], ['android', '1.3.11', '1.3.10']]) {
    const headers = { ...device.headers, 'X-DeskPet-Platform': platform, 'X-DeskPet-Version': current };
    assert.deepEqual(supportedContentTypes({ headers: { 'x-deskpet-platform': platform, 'x-deskpet-version': current } }), CONTENT_TYPES);
    assert.equal((await request('/api/content/batch', headers, 'POST', { types: CONTENT_TYPES })).status, 200);
    assert.deepEqual(supportedContentTypes({ headers: { 'x-deskpet-platform': platform, 'x-deskpet-version': legacy } }), LEGACY_CONTENT_TYPES);
  }
});

test('update checks never count as usage and historical route totals exclude them', async (context) => {
  const { app, request, trial } = await fixture(context);
  const device = await trial();
  const before = app.analyticsStore.usageDetails();
  for (const suffix of ['', '?platform=windows&architecture=x64', '/', '?platform=android']) {
    await request(`/api/update/latest${suffix}`, device.headers);
  }
  assert.equal(app.analyticsStore.usageDetails().apiRequestTotal, before.apiRequestTotal);
  app.analyticsStore.recordRequest({ method: 'GET', path: '/api/update/latest', status: 200 });
  assert.equal(app.analyticsStore.usageDetails().apiRequestTotal, before.apiRequestTotal);
  app.analyticsStore.database.prepare(`
    INSERT INTO usage_api_daily (date, method, path, platform, app_version, status_group, request_count, successful_requests, last_seen_at)
    VALUES ('2026-09-01', 'GET', '/api/update/latest', 'windows', '3.2.9', '2xx', 999, 999, '2026-09-01T00:00:00.000Z')
  `).run();
  const after = app.analyticsStore.usageDetails();
  assert.equal(after.apiRequestTotal, before.apiRequestTotal);
  assert.equal(after.apiRoutes.some((item) => item.path === '/api/update/latest'), false);
  await request('/api/companion', device.headers);
  assert.equal(app.analyticsStore.usageDetails().apiRequestTotal, before.apiRequestTotal + 1);
});

test('overview classifies published versions by publishedAt', async (context) => {
  const { app } = await fixture(context);
  app.services.releaseService.list = () => ({ activeVersions: {}, releases: [
    { version: '3.2.9', publishedAt: '2026-09-01T00:00:00.000Z' },
    { version: '3.2.10', publishedAt: null }
  ] });
  const overview = await new OverviewService(app.services).build();
  assert.equal(overview.tech.releaseCounts.published, 1);
  assert.equal(overview.tech.releaseCounts.drafts, 1);
});
