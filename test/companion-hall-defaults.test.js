const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { ReleaseStore } = require('../lib/storage');

async function fixture(context, { admin = false } = {}) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-hall-defaults-'));
  if (admin) {
    await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'),
      JSON.stringify(await hashPassword('hall defaults test password')), { mode: 0o600 });
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const app = await createApplication({
    dataDirectory, publicUrl: 'http://127.0.0.1', cookieSecure: false, signingPrivateKey: privateKey,
    activationIpRateOptions: { max: 100 }
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  async function request(url, headers = {}, method = 'GET', body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  async function trial(platform = 'windows') {
    const installationId = crypto.randomBytes(16).toString('hex');
    const credential = crypto.randomBytes(32).toString('base64url');
    const headers = {
      Authorization: `Trial ${installationId}.${credential}`,
      'X-DeskPet-Version': platform === 'android' ? '1.5.0' : '3.4.0',
      ...(platform ? { 'X-DeskPet-Platform': platform } : {})
    };
    const created = await request('/api/trial', {}, 'POST', {
      installationId, credential, appVersion: headers['X-DeskPet-Version']
    });
    assert.equal(created.status, 200);
    return { installationId, credential, accountId: `trial:${installationId}`, headers };
  }

  async function activate(device, code = app.activationStore.createCodes({ count: 1 }).codes[0]) {
    const result = await request('/api/activate', { 'X-DeskPet-Platform': 'windows' }, 'POST', {
      code, installationId: device.installationId, credential: device.credential, appVersion: '3.4.0'
    });
    assert.equal(result.status, 200);
    return {
      ...device, ...result.body,
      headers: { ...device.headers, Authorization: `Bearer ${result.body.licenseId}.${device.credential}` }
    };
  }

  function stored(device) {
    return app.companionStore.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?')
      .get(device.accountId);
  }

  return { app, request, trial, activate, stored, dataDirectory };
}

test('admin can save the default and older settings payloads preserve the persisted value', async (context) => {
  const { request, trial, dataDirectory } = await fixture(context, { admin: true });
  const login = await request('/api/admin/login', {}, 'POST', {
    username: 'admin', password: 'hall defaults test password'
  });
  assert.equal(login.status, 200);
  const adminHeaders = {
    Cookie: login.headers.get('set-cookie').split(';', 1)[0],
    'X-CSRF-Token': login.body.csrfToken
  };
  const saved = await request('/api/admin/site-settings', adminHeaders, 'PUT', {
    defaults: { desktopHallEnabled: true }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.defaults.desktopHallEnabled, true);
  const oldPayload = await request('/api/admin/site-settings', adminHeaders, 'PUT', {
    defaults: { interactionMode: 'lively' }
  });
  assert.equal(oldPayload.status, 200);
  assert.equal(oldPayload.body.defaults.desktopHallEnabled, true);
  assert.equal(oldPayload.body.defaults.interactionMode, 'lively');
  assert.equal((await request('/api/public/site-settings')).body.defaults.desktopHallEnabled, true);
  const reopened = new ReleaseStore(dataDirectory);
  await reopened.initialize();
  assert.equal(reopened.siteSettings().defaults.desktopHallEnabled, true);
  const device = await trial('windows');
  assert.equal((await request('/api/companion', device.headers)).body.hallEnabled, true);
});

test('desktop hall stays off when the remote default is absent or disabled', async (context) => {
  const { app, request, trial } = await fixture(context);
  assert.equal(app.store.siteSettings().defaults.desktopHallEnabled, false);
  for (const platform of ['windows', 'macos']) {
    const device = await trial(platform);
    const profile = await request('/api/companion', device.headers);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.hallEnabled, false);
    assert.equal(profile.body.online, false);
  }
  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: false } });
  const device = await trial('windows');
  assert.equal((await request('/api/companion', device.headers)).body.hallEnabled, false);
});

test('enabled default applies to Windows and macOS across first-use companion endpoints', async (context) => {
  const { app, request, trial, stored } = await fixture(context);
  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: true } });
  const endpoints = [
    ['/api/companion', 'GET'],
    ['/api/companion/hall', 'GET'],
    ['/api/companion/deliveries', 'GET'],
    ['/api/companion', 'PATCH', { displayName: '新朋友' }]
  ];
  for (const platform of ['windows', 'macos']) {
    for (const [url, method, body] of endpoints) {
      const device = await trial(platform);
      assert.equal(stored(device), undefined, 'trial creation alone must not join the hall');
      assert.equal((await request(url, device.headers, method, body)).status, 200);
      assert.equal(stored(device).hall_enabled, 1, `${platform} first request to ${url}`);
      const profile = (await request('/api/companion', device.headers)).body;
      assert.equal(profile.hallEnabled, true);
      assert.equal(profile.online, true);
      assert.equal(profile.pairingCode, '', 'default does not unlock trial private pairing');
    }
  }
});

test('Android, unknown platforms and the disabled hall feature ignore the desktop default', async (context) => {
  const { app, request, trial } = await fixture(context);
  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: true } });
  for (const platform of ['android', 'linux', '']) {
    const device = await trial(platform);
    const profile = (await request('/api/companion', device.headers)).body;
    assert.equal(profile.hallEnabled, false, platform || 'missing platform');
    assert.equal(profile.online, false);
  }
  await app.store.updateSiteSettings({ features: { companionHall: false } });
  for (const platform of ['windows', 'macos']) {
    const device = await trial(platform);
    assert.equal((await request('/api/companion', device.headers)).body.hallEnabled, false);
  }
});

test('live setting changes affect only new profiles and never override an existing hall choice', async (context) => {
  const { app, request, trial } = await fixture(context);
  const existingOff = await trial();
  assert.equal((await request('/api/companion', existingOff.headers)).body.hallEnabled, false);
  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: true } });
  assert.equal((await request('/api/companion', existingOff.headers)).body.hallEnabled, false);
  const enabled = await trial('macos');
  assert.equal((await request('/api/companion', enabled.headers)).body.hallEnabled, true);
  const optedOut = await trial();
  assert.equal((await request('/api/companion/hall', optedOut.headers, 'PATCH', { enabled: false })).body.hallEnabled, false);
  assert.equal((await request('/api/companion', optedOut.headers)).body.hallEnabled, false);

  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: false } });
  assert.equal((await request('/api/companion', enabled.headers)).body.hallEnabled, true);
  const newOff = await trial();
  assert.equal((await request('/api/companion', newOff.headers)).body.hallEnabled, false);
  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: true } });
  assert.equal((await request('/api/companion', optedOut.headers)).body.hallEnabled, false);
});

test('activation preserves both trial choices and gives an existing account choice priority', async (context) => {
  const { app, request, trial, activate } = await fixture(context);
  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: true } });
  for (const keepEnabled of [true, false]) {
    const device = await trial();
    assert.equal((await request('/api/companion', device.headers)).body.hallEnabled, true);
    if (!keepEnabled) await request('/api/companion/hall', device.headers, 'PATCH', { enabled: false });
    const activated = await activate(device);
    assert.equal((await request('/api/companion', activated.headers)).body.hallEnabled, keepEnabled);
  }
  const code = app.activationStore.createCodes({ count: 1 }).codes[0];
  const existing = await activate(await trial(), code);
  await request('/api/companion/hall', existing.headers, 'PATCH', { enabled: false });
  const joining = await trial('macos');
  assert.equal((await request('/api/companion', joining.headers)).body.hallEnabled, true);
  const added = await activate(joining, code);
  assert.equal(added.accountId, existing.accountId);
  assert.equal((await request('/api/companion', added.headers)).body.hallEnabled, false);
});

test('passive and admin-created profiles stay out of the hall without an owner request', async (context) => {
  const { app, request, trial, activate, stored } = await fixture(context);
  await app.store.updateSiteSettings({ defaults: { desktopHallEnabled: true } });
  const sender = await activate(await trial());
  const recipient = await trial();
  app.companionStore.createAdminDelivery(sender.accountId, recipient.accountId, {
    id: crypto.randomUUID(), fileName: 'admin-test.gif', size: 1, width: 1, height: 1, sha256: 'a'.repeat(64)
  });
  for (const device of [sender, recipient]) {
    assert.equal(stored(device).hall_enabled, 0);
    assert.equal(stored(device).last_seen_at, null);
    assert.equal((await request('/api/companion', device.headers)).body.hallEnabled, false,
      'an existing passive profile must not be silently overwritten');
  }
  const denied = await trial();
  assert.equal((await request('/api/companion/pair', denied.headers, 'POST', { code: 'ABCDEFGH' })).status, 403);
  assert.equal(stored(denied), undefined, 'rejected private-pairing access must not create or join a profile');
});
