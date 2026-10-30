const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');

async function fixture(context) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-uninstall-'));
  const password = 'isolated uninstall admin password';
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'), JSON.stringify(await hashPassword(password)));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    dataDirectory,
    cookieSecure: false,
    signingPrivateKey: privateKey
  });
  const server = http.createServer(application.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    application.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(url, options = {}) {
    const response = await fetch(`${baseUrl}${url}`, options);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  const login = await request('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password })
  });
  assert.equal(login.status, 200);
  const adminHeaders = { Cookie: login.headers.get('set-cookie').split(';', 1)[0] };

  async function activate(platform = 'windows') {
    const installationId = crypto.randomBytes(16).toString('hex');
    const credential = crypto.randomBytes(32).toString('base64url');
    const code = application.activationStore.createCodes({ count: 1 }).codes[0];
    const activation = await request('/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DeskPet-Platform': platform, 'X-DeskPet-Architecture': 'x64' },
      body: JSON.stringify({ code, installationId, credential, appVersion: '3.4.4' })
    });
    assert.equal(activation.status, 200);
    return {
      installationId,
      credential,
      accountId: activation.body.accountId,
      licenseId: activation.body.licenseId,
      authorization: `Bearer ${activation.body.licenseId}.${credential}`,
      platform
    };
  }

  function installEvent(device, eventType, batch, extra = {}) {
    return request('/api/device/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DeskPet-Platform': device.platform, 'X-DeskPet-Version': '3.4.4' },
      body: JSON.stringify({
        schemaVersion: 1,
        eventId: crypto.randomUUID(),
        eventType,
        installationId: device.installationId,
        credential: device.credential,
        installBatchId: batch.id,
        installBatchCreatedAt: batch.createdAt,
        platform: device.platform,
        appVersion: '3.4.4',
        occurredAt: new Date().toISOString(),
        ...extra
      })
    });
  }

  function complete(intent, override = {}) {
    return request('/api/device/install-events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        eventId: crypto.randomUUID(),
        eventType: 'uninstall_completed',
        intentEventId: intent.body.eventId,
        completionToken: intent.body.completionToken,
        occurredAt: new Date().toISOString(),
        ...override
      })
    });
  }

  return { application, request, adminHeaders, activate, installEvent, complete };
}

function batch(minutesAgo) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
  };
}

test('confirmed uninstall is token-gated, idempotent, visible to admins, and preserves account rights', async context => {
  const f = await fixture(context);
  const device = await f.activate();
  const install = batch(30);
  const profile = await f.request('/api/companion', {
    method: 'PATCH',
    headers: { Authorization: device.authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: '卸载验收搭子' })
  });
  assert.equal(profile.status, 200);

  f.application.petMarketStore.createProduct({
    id: 'preserved-owned-pet', title: '保留权益桌宠', description: '', chargingMode: 'free',
    priceFen: 0, status: 'unlisted', isDefault: false, sortOrder: 0,
    previewMode: 'none', previewPaths: []
  });
  f.application.petMarketStore.database.prepare(`
    INSERT INTO pet_market_free_entitlements (account_id, product_id, product_version, granted_at)
    VALUES (?, 'preserved-owned-pet', '1.0.0', ?)
  `).run(device.accountId, new Date().toISOString());
  const licenseBefore = f.application.activationStore.database.prepare('SELECT * FROM licenses WHERE id = ?')
    .get(device.licenseId);

  const started = await f.installEvent(device, 'installed_start', install);
  assert.equal(started.status, 200);
  assert.equal(started.body.deviceState, 'installed');
  assert.equal(started.body.completionToken, undefined);

  const intent = await f.installEvent(device, 'uninstall_intent', install, {
    reason: 'other', comment: '需要重新整理本机环境'
  });
  assert.equal(intent.status, 200);
  assert.match(intent.body.completionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(intent.body.deviceState, 'installed', 'An intent must never claim uninstall completion.');

  const beforeCompletion = await f.request('/api/admin/uninstalls?status=installed', { headers: f.adminHeaders });
  assert.equal(beforeCompletion.status, 200);
  assert.equal(beforeCompletion.headers.get('cache-control'), 'no-store');
  assert.equal(beforeCompletion.body.devices[0].displayName, '卸载验收搭子');
  assert.equal(beforeCompletion.body.devices[0].latestReason, 'other');
  assert.equal(JSON.stringify(beforeCompletion.body).includes(intent.body.completionToken), false);

  const completionEventId = crypto.randomUUID();
  const completed = await f.complete(intent, { eventId: completionEventId });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.deviceState, 'uninstall_reported');
  assert.equal(completed.body.stateChanged, true);

  const duplicate = await f.complete(intent, { eventId: completionEventId });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const reusedToken = await f.complete(intent);
  assert.equal(reusedToken.status, 409);
  assert.equal(reusedToken.body.code, 'UNINSTALL_COMPLETION_USED');

  const admin = await f.request(`/api/admin/uninstalls/${device.installationId}`, { headers: f.adminHeaders });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.device.status, 'uninstall_reported');
  assert.equal(admin.body.device.installationId, device.installationId);
  assert.equal(admin.body.device.accountId, device.accountId);
  assert.equal(admin.body.device.platform, 'windows');
  assert.equal(admin.body.device.appVersion, '3.4.4');
  assert.deepEqual(admin.body.events.map(item => item.eventType), [
    'uninstall_completed', 'uninstall_intent', 'installed_start'
  ]);
  assert.equal(admin.body.events[0].reason, 'other');
  assert.equal(admin.body.events[0].comment, '需要重新整理本机环境');
  assert.equal(JSON.stringify(admin.body).includes(intent.body.completionToken), false);

  const licenseAfter = f.application.activationStore.database.prepare('SELECT * FROM licenses WHERE id = ?')
    .get(device.licenseId);
  assert.deepEqual(licenseAfter, licenseBefore, 'Uninstall reporting must not revoke or free a device slot.');
  assert.equal(f.application.petMarketStore.hasEntitlement(device.accountId, 'preserved-owned-pet'), true,
    'Uninstall reporting must not remove purchases or free claims.');
});

test('only a newer started batch restores use and stale uninstall completion cannot overwrite it', async context => {
  const f = await fixture(context);
  const device = await f.activate();
  const oldBatch = batch(60);
  const replacementBatch = batch(20);
  const newestBatch = batch(1);

  assert.equal((await f.installEvent(device, 'installed_start', oldBatch)).body.deviceState, 'installed');
  const oldIntent = await f.installEvent(device, 'uninstall_intent', oldBatch, { reason: 'temporary_pause' });

  const replacementStart = await f.installEvent(device, 'installed_start', replacementBatch);
  assert.equal(replacementStart.body.deviceState, 'installed');
  const lateOldCompletion = await f.complete(oldIntent);
  assert.equal(lateOldCompletion.status, 200);
  assert.equal(lateOldCompletion.body.ignoredAsStale, true);
  assert.equal(lateOldCompletion.body.deviceState, 'installed');

  const currentIntent = await f.installEvent(device, 'uninstall_intent', replacementBatch, { reason: 'not_often_used' });
  assert.equal((await f.complete(currentIntent)).body.deviceState, 'uninstall_reported');

  const heartbeat = await f.request('/api/device/heartbeat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DeskPet-Platform': 'windows' },
    body: JSON.stringify({ installationId: device.installationId, credential: device.credential, appVersion: '3.4.4' })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(f.application.uninstallStore.details(device.installationId).device.status, 'uninstall_reported',
    'Activity from an old process must not imply reinstall.');

  const sameBatchStart = await f.installEvent(device, 'installed_start', replacementBatch);
  assert.equal(sameBatchStart.body.deviceState, 'uninstall_reported');
  assert.equal(sameBatchStart.body.ignoredAsStale, true);

  const secondIntent = await f.installEvent(device, 'uninstall_intent', replacementBatch, { reason: null });
  const restored = await f.installEvent(device, 'installed_start', newestBatch);
  assert.equal(restored.body.deviceState, 'restored');
  assert.equal(restored.body.stateChanged, true);
  const delayedCompletion = await f.complete(secondIntent);
  assert.equal(delayedCompletion.body.ignoredAsStale, true);
  assert.equal(delayedCompletion.body.deviceState, 'restored');

  const state = f.application.uninstallStore.details(device.installationId);
  assert.equal(state.device.currentInstallBatchId, newestBatch.id);
  assert.equal(state.device.lastUninstallAt !== null, true);
  assert.equal(state.device.lastRestoredAt !== null, true);
  assert.equal(state.events.filter(item => item.eventType === 'uninstall_completed').length, 3);
});

test('event ids stay bound to one authenticated event and completion duplicates still prove the token', async context => {
  const f = await fixture(context);
  const firstDevice = await f.activate();
  const secondDevice = await f.activate();
  const firstBatch = batch(30);
  const secondBatch = batch(20);
  const sharedEventId = crypto.randomUUID();

  const started = await f.installEvent(firstDevice, 'installed_start', firstBatch, { eventId: sharedEventId });
  assert.equal(started.status, 200);
  const exactStartRetry = await f.installEvent(firstDevice, 'installed_start', firstBatch, { eventId: sharedEventId });
  assert.equal(exactStartRetry.status, 200);
  assert.equal(exactStartRetry.body.duplicate, true);

  const crossDeviceReuse = await f.installEvent(secondDevice, 'installed_start', secondBatch, { eventId: sharedEventId });
  assert.equal(crossDeviceReuse.status, 409);
  assert.equal(crossDeviceReuse.body.code, 'INSTALL_EVENT_ID_CONFLICT');
  const typeReuse = await f.installEvent(firstDevice, 'uninstall_intent', firstBatch, {
    eventId: sharedEventId, reason: null
  });
  assert.equal(typeReuse.status, 409);
  assert.equal(typeReuse.body.code, 'INSTALL_EVENT_ID_CONFLICT');
  const batchReuse = await f.installEvent(firstDevice, 'installed_start', secondBatch, { eventId: sharedEventId });
  assert.equal(batchReuse.status, 409);
  assert.equal(batchReuse.body.code, 'INSTALL_EVENT_ID_CONFLICT');

  const intent = await f.installEvent(firstDevice, 'uninstall_intent', firstBatch, { reason: 'resource_usage' });
  const completionId = crypto.randomUUID();
  const reusedStartId = await f.complete(intent, { eventId: sharedEventId });
  assert.equal(reusedStartId.status, 409);
  assert.equal(reusedStartId.body.code, 'UNINSTALL_COMPLETION_EVENT_CONFLICT');

  const completed = await f.complete(intent, { eventId: completionId });
  assert.equal(completed.status, 200);
  const wrongTokenDuplicate = await f.complete(intent, {
    eventId: completionId,
    completionToken: crypto.randomBytes(32).toString('base64url')
  });
  assert.equal(wrongTokenDuplicate.status, 401);
  assert.equal(wrongTokenDuplicate.body.code, 'UNINSTALL_COMPLETION_INVALID');
  const validDuplicate = await f.complete(intent, { eventId: completionId });
  assert.equal(validDuplicate.status, 200);
  assert.equal(validDuplicate.body.duplicate, true);

  const secondIntent = await f.installEvent(firstDevice, 'uninstall_intent', firstBatch, { reason: null });
  const differentIntentReuse = await f.complete(secondIntent, { eventId: completionId });
  assert.equal(differentIntentReuse.status, 409);
  assert.equal(differentIntentReuse.body.code, 'UNINSTALL_COMPLETION_EVENT_CONFLICT');
});

test('an intent ignored before its batch starts can never uninstall that later batch', async context => {
  const f = await fixture(context);
  const device = await f.activate();
  const currentBatch = batch(60);
  const futureBatch = batch(10);
  assert.equal((await f.installEvent(device, 'installed_start', currentBatch)).status, 200);

  const prematureIntent = await f.installEvent(device, 'uninstall_intent', futureBatch, {
    reason: 'temporary_pause'
  });
  assert.equal(prematureIntent.status, 200);
  assert.equal(prematureIntent.body.ignoredAsStale, true);
  assert.equal((await f.installEvent(device, 'installed_start', futureBatch)).body.deviceState, 'installed');

  const delayedCompletion = await f.complete(prematureIntent);
  assert.equal(delayedCompletion.status, 200);
  assert.equal(delayedCompletion.body.ignoredAsStale, true);
  assert.equal(delayedCompletion.body.deviceState, 'installed');
  const details = f.application.uninstallStore.details(device.installationId);
  assert.equal(details.device.currentInstallBatchId, futureBatch.id);
  assert.equal(details.device.status, 'installed');
  assert.equal(details.events[0].ignoredReason, 'batch_not_started');
});

test('invalid feedback and untrusted completion are rejected while expired devices can report intent', async context => {
  const f = await fixture(context);
  const device = await f.activate('macos');
  const install = batch(5);

  const invalidReason = await f.installEvent(device, 'uninstall_intent', install, { reason: 'made_up' });
  assert.equal(invalidReason.status, 400);
  assert.equal(invalidReason.body.code, 'INVALID_UNINSTALL_REASON');
  const commentWithoutOther = await f.installEvent(device, 'uninstall_intent', install, {
    reason: 'experience_issue', comment: 'should not be accepted'
  });
  assert.equal(commentWithoutOther.status, 400);
  assert.equal(commentWithoutOther.body.code, 'INVALID_UNINSTALL_COMMENT');

  const forged = await f.request('/api/device/install-events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, eventId: crypto.randomUUID(), eventType: 'uninstall_completed',
      intentEventId: crypto.randomUUID(), completionToken: crypto.randomBytes(32).toString('base64url'),
      occurredAt: new Date().toISOString() })
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.code, 'UNINSTALL_COMPLETION_INVALID');

  f.application.activationStore.revoke(device.licenseId);
  const revokedIntent = await f.installEvent(device, 'uninstall_intent', install, { reason: null });
  assert.equal(revokedIntent.status, 200, 'A revoked entitlement must not erase the authenticated device identity.');
  assert.equal(revokedIntent.body.deviceState, 'installed');

  const noAdmin = await f.request('/api/admin/uninstalls');
  assert.equal(noAdmin.status, 401);
  const searched = await f.request(`/api/admin/uninstalls?q=${device.installationId.slice(-12)}`, {
    headers: f.adminHeaders
  });
  assert.equal(searched.status, 200);
  assert.equal(searched.body.total, 1);
  assert.equal(searched.body.devices[0].platform, 'macos');
});
