const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { trialDeviceKey } = require('../src/middleware/usage-tracking');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

async function fixture(context, { admin = false } = {}) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-device-activity-'));
  if (admin) await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'),
    JSON.stringify(await hashPassword('device activity regression password')), { mode: 0o600 });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const app = await createApplication({ dataDirectory, publicUrl: 'http://127.0.0.1',
    cookieSecure: false, signingPrivateKey: privateKey });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  async function request(url, headers = {}, method = 'GET', body) {
    const response = await fetch(`${baseUrl}${url}`, { method,
      headers: { ...headers, ...(body === undefined ? {} : {
        'Content-Type': Buffer.isBuffer(body) ? 'image/gif' : 'application/json'
      }) }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  function newDevice(platform = 'windows') {
    const installationId = crypto.randomBytes(16).toString('hex');
    const credential = crypto.randomBytes(32).toString('base64url');
    const appVersion = platform === 'android' ? '1.5.0' : '3.4.0';
    const headers = { 'X-DeskPet-Platform': platform, 'X-DeskPet-Version': appVersion,
      'X-DeskPet-Architecture': platform === 'windows' ? 'x64' : 'arm64' };
    return { installationId, credential, appVersion, headers, accountId: `trial:${installationId}`,
      authorization: `Trial ${installationId}.${credential}`, deviceKey: trialDeviceKey(installationId) };
  }

  function body(device) {
    return { installationId: device.installationId, credential: device.credential, appVersion: device.appVersion };
  }

  async function trial(platform) {
    const device = newDevice(platform);
    const created = await request('/api/trial', device.headers, 'POST', body(device));
    assert.equal(created.status, 200);
    assert.equal(created.body.allowed, true);
    return device;
  }

  async function activate(platform = 'windows') {
    const device = newDevice(platform);
    const code = app.activationStore.createCodes({ count: 1 }).codes[0];
    const created = await request('/api/activate', device.headers, 'POST', { ...body(device), code });
    assert.equal(created.status, 200);
    return { ...device, ...created.body, deviceKey: created.body.licenseId,
      authorization: `Bearer ${created.body.licenseId}.${device.credential}` };
  }

  function expire(device) {
    const expiresAt = new Date(Date.now() - MINUTE).toISOString();
    app.activationStore.database.prepare('UPDATE trials SET expires_at = ? WHERE installation_id = ?')
      .run(expiresAt, device.installationId);
    return expiresAt;
  }

  function storedTrial(device) {
    return app.activationStore.database.prepare('SELECT * FROM trials WHERE installation_id = ?').get(device.installationId);
  }

  function storedUsage(device) {
    return app.analyticsStore.database.prepare('SELECT * FROM usage_devices WHERE device_key = ?').get(device.deviceKey);
  }

  function summary(now = Date.now()) {
    return app.services.analyticsService.usageSummary(app.activationStore.deviceInventory(), now);
  }

  function counts() {
    return {
      trials: app.activationStore.database.prepare('SELECT COUNT(*) AS total FROM trials').get().total,
      licenses: app.activationStore.database.prepare('SELECT COUNT(*) AS total FROM licenses').get().total,
      profiles: app.companionStore.database.prepare('SELECT COUNT(*) AS total FROM companion_profiles').get().total,
      usage: app.analyticsStore.database.prepare('SELECT COUNT(*) AS total FROM usage_devices').get().total
    };
  }

  async function heartbeat(device, override = {}) {
    // Presence uses the existing installation credential in JSON, never a premium Authorization header.
    assert.equal(device.headers.Authorization, undefined);
    return request('/api/device/heartbeat', device.headers, 'POST', { ...body(device), ...override });
  }

  async function login() {
    const response = await request('/api/admin/login', {}, 'POST', {
      username: 'admin', password: 'device activity regression password'
    });
    assert.equal(response.status, 200);
    return { Cookie: response.headers.get('set-cookie').split(';', 1)[0], 'X-CSRF-Token': response.body.csrfToken };
  }

  return { app, request, newDevice, body, trial, activate, expire, storedTrial, storedUsage, summary, counts, heartbeat, login };
}

test('expired trial cold starts on Windows, macOS and Android remain visible without renewing access', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(context, { admin: true });
  const adminHeaders = await f.login();
  const devices = [];
  for (const platform of ['windows', 'macos', 'android']) {
    const device = await f.trial(platform);
    const expiresAt = f.expire(device);
    const baseline = f.storedTrial(device);
    const counts = f.counts();
    const before = f.storedUsage(device);
    context.mock.timers.tick(MINUTE);
    const heartbeat = await f.heartbeat(device);
    assert.equal(heartbeat.status, 200);
    assert.deepEqual(Object.keys(heartbeat.body).sort(), ['ok', 'serverTime']);
    assert.equal(heartbeat.body.ok, true);
    assert.equal(heartbeat.headers.get('cache-control'), 'no-store');
    assert.equal(heartbeat.body.serverTime, new Date().toISOString());
    assert.deepEqual(f.storedTrial(device), baseline, 'Activity must not write trial validity or account metadata.');
    assert.deepEqual(f.counts(), counts, 'Activity must not create a trial, license, profile or second device identity.');
    const usage = f.storedUsage(device);
    assert.ok(Date.parse(usage.last_seen_at) > Date.parse(before.last_seen_at));
    assert.equal(usage.request_count, before.request_count + 1);
    assert.equal(usage.last_path, '/api/device/heartbeat');
    assert.equal(usage.platform, platform);
    assert.equal(usage.app_version, device.appVersion);

    const premium = await f.request('/api/interactions/profile', { ...device.headers, Authorization: device.authorization });
    assert.equal(premium.status, 401, 'An activity success cannot make an expired trial premium again.');
    assert.equal((await f.request('/api/companion', { ...device.headers, Authorization: device.authorization })).status, 401);
    assert.deepEqual(f.counts(), counts);
    assert.equal(f.storedTrial(device).expires_at, expiresAt);

    // Older desktop builds still check /trial on cold start; denied access must also identify the real device.
    context.mock.timers.tick(MINUTE);
    const legacy = await f.request('/api/trial', device.headers, 'POST', f.body(device));
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.allowed, false);
    assert.equal(legacy.body.remainingSeconds, 0);
    assert.equal(legacy.body.expiresAt, expiresAt);
    assert.equal(f.storedUsage(device).last_path, '/api/trial');
    assert.equal(f.storedUsage(device).request_count, usage.request_count + 1);
    assert.deepEqual(f.counts(), counts);
    devices.push(device);
  }
  // Refresh all three after the simulated sequential cold starts.
  for (const device of devices) assert.equal((await f.heartbeat(device)).status, 200);
  const result = await f.request('/api/admin/analytics', adminHeaders);
  assert.equal(result.status, 200);
  assert.equal(result.body.usage.summary.onlineDevices, 3);
  assert.equal(result.body.usage.summary.activeTrials, 0);
  for (const device of devices) {
    const row = result.body.usage.devices.find((item) => item.deviceKey === device.deviceKey);
    assert.equal(row.online, true);
    assert.equal(row.activityStatus, 'online');
    assert.equal(row.authorizationType, 'trial');
    assert.equal(row.authorizationState, 'expired');
  }
  assert.equal(f.counts().profiles, 0);
});

test('heartbeat advances usage timestamps and obeys five-minute, seven-day and fifteen-day boundaries', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(context);
  const device = await f.trial('windows');
  f.expire(device);
  const baseline = f.storedTrial(device);
  context.mock.timers.tick(4 * MINUTE);
  assert.equal((await f.heartbeat(device)).status, 200);
  const heartbeatAt = Date.parse(f.storedUsage(device).last_seen_at);
  const rowAt = (time) => f.summary(time).devices.find((item) => item.deviceKey === device.deviceKey);
  assert.equal(rowAt(heartbeatAt + 5 * MINUTE).activityStatus, 'online');
  assert.equal(f.summary(heartbeatAt + 5 * MINUTE).summary.onlineDevices, 1);
  assert.equal(rowAt(heartbeatAt + 5 * MINUTE + 1).activityStatus, 'recent');
  assert.equal(f.summary(heartbeatAt + 5 * MINUTE + 1).summary.onlineDevices, 0);
  assert.equal(rowAt(heartbeatAt + 7 * DAY - 1).activityStatus, 'recent');
  assert.equal(rowAt(heartbeatAt + 7 * DAY).activityStatus, 'inactive7');
  assert.equal(f.summary(heartbeatAt + 7 * DAY).summary.inactive7Days, 1);
  assert.equal(rowAt(heartbeatAt + 15 * DAY - 1).activityStatus, 'inactive7');
  assert.equal(rowAt(heartbeatAt + 15 * DAY).activityStatus, 'inactive15');
  assert.equal(f.summary(heartbeatAt + 15 * DAY).summary.inactive7Days, 1);
  assert.equal(f.summary(heartbeatAt + 15 * DAY).summary.inactive15Days, 1);
  assert.equal(rowAt(heartbeatAt + 15 * DAY).authorizationState, 'expired');
  context.mock.timers.tick(5 * MINUTE + 1);
  assert.equal(f.summary().summary.onlineDevices, 0);
  assert.equal((await f.heartbeat(device)).status, 200);
  assert.equal(f.summary().summary.onlineDevices, 1);
  assert.ok(Date.parse(f.storedUsage(device).last_seen_at) > heartbeatAt);
  assert.deepEqual(f.storedTrial(device), baseline);
  assert.equal(f.counts().profiles, 0);
});

test('invalid and unknown heartbeat credentials neither create records nor update a target device', async (context) => {
  const f = await fixture(context);
  const active = await f.trial('windows');
  const expired = await f.trial('macos');
  f.expire(expired);
  const licensed = await f.activate();
  const revoked = await f.activate('macos');
  f.app.activationStore.revoke(revoked.licenseId);
  const devices = [active, expired, licensed, revoked];
  const snapshots = devices.map((device) => f.storedUsage(device));
  const counts = f.counts();
  for (const device of devices) {
    const rejected = await f.heartbeat(device, { credential: crypto.randomBytes(32).toString('base64url') });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.code, 'ACTIVITY_DEVICE_INVALID');
  }
  for (const body of [f.body(f.newDevice()), {}, [], { installationId: 'invalid', credential: 'short' },
    { installationId: expired.installationId, credential: '' },
    { installationId: [expired.installationId], credential: expired.credential },
    { installationId: expired.installationId, credential: [expired.credential] },
    { installationId: expired.installationId, credential: null },
    { installationId: expired.installationId, credential: 123 },
    { installationId: expired.installationId, credential: {} },
    { installationId: null, credential: expired.credential }]) {
    assert.equal((await f.request('/api/device/heartbeat', expired.headers, 'POST', body)).status, 401);
  }
  for (const body of [null, 'not-an-object', 123]) {
    assert.equal((await f.request('/api/device/heartbeat', expired.headers, 'POST', body)).status, 400,
      'The strict JSON parser rejects scalar bodies before identity extraction.');
  }
  assert.deepEqual(f.counts(), counts);
  devices.forEach((device, index) => assert.deepEqual(f.storedUsage(device), snapshots[index]));
});

test('trial access expires exactly at its deadline while recent activity stays online', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(context);
  const device = await f.trial('macos');
  const expiresAt = new Date(Date.now() + MINUTE).toISOString();
  f.app.activationStore.database.prepare('UPDATE trials SET expires_at = ? WHERE installation_id = ?')
    .run(expiresAt, device.installationId);
  context.mock.timers.tick(MINUTE - 1);
  assert.equal((await f.heartbeat(device)).status, 200);
  assert.equal(f.summary().devices[0].authorizationState, 'active');
  assert.equal((await f.request('/api/interactions/profile', { ...device.headers, Authorization: device.authorization })).status, 200);
  context.mock.timers.tick(1);
  assert.equal((await f.heartbeat(device)).status, 200);
  assert.equal(f.summary().devices[0].authorizationState, 'expired');
  assert.equal(f.summary().devices[0].activityStatus, 'online');
  assert.equal(f.summary().summary.onlineDevices, 1);
  assert.equal(f.summary().summary.activeTrials, 0);
  assert.equal((await f.request('/api/interactions/profile', { ...device.headers, Authorization: device.authorization })).status, 401);
  assert.equal(f.storedTrial(device).expires_at, expiresAt);
  assert.equal(f.counts().profiles, 0);
});

test('online expired and revoked devices remain excluded from admin visits and premium APIs', async (context) => {
  const f = await fixture(context, { admin: true });
  const active = await f.activate('windows');
  const revoked = await f.activate('macos');
  const activeTrial = await f.trial('android');
  const expired = await f.trial('windows');
  f.expire(expired);
  f.app.activationStore.revoke(revoked.licenseId);
  const revokedRecord = f.app.activationStore.database.prepare('SELECT * FROM licenses WHERE id = ?').get(revoked.licenseId);
  const counts = f.counts();
  for (const device of [active, revoked, activeTrial, expired]) assert.equal((await f.heartbeat(device)).status, 200);
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(f.app.activationStore.database.prepare('SELECT * FROM licenses WHERE id = ?').get(revoked.licenseId), revokedRecord);
  for (const device of [revoked, expired]) {
    assert.equal((await f.request('/api/interactions/profile', { ...device.headers, Authorization: device.authorization })).status, 401);
    assert.equal((await f.request('/api/companion/hall', { ...device.headers, Authorization: device.authorization })).status, 401);
  }
  for (const device of [active, activeTrial]) {
    assert.equal((await f.request('/api/interactions/profile', { ...device.headers, Authorization: device.authorization })).status, 200);
  }
  const adminHeaders = await f.login();
  const analytics = await f.request('/api/admin/analytics', adminHeaders);
  assert.equal(analytics.status, 200);
  assert.equal(analytics.body.usage.summary.onlineDevices, 4);
  assert.equal(analytics.body.usage.summary.activeAuthorizedDevices, 2);
  for (const [device, authorizationState] of [[active, 'active'], [revoked, 'revoked'], [activeTrial, 'active'], [expired, 'expired']]) {
    const row = analytics.body.usage.devices.find((item) => item.deviceKey === device.deviceKey);
    assert.equal(row.authorizationState, authorizationState);
    assert.equal(row.activityStatus, 'online');
    assert.equal(row.online, true);
  }
  const companions = await f.request('/api/admin/companions', adminHeaders);
  assert.equal(companions.status, 200);
  assert.deepEqual(new Set(companions.body.sendOptions.devices.map((item) => item.licenseId)),
    new Set([active.licenseId, activeTrial.deviceKey]));
  assert.deepEqual(companions.body.sendOptions.senders.map((item) => item.accountId), [active.accountId]);
  for (const recipient of [revoked, expired]) {
    const query = new URLSearchParams({ senderAccountId: active.accountId, recipientLicenseId: recipient.deviceKey });
    const denied = await f.request(`/api/admin/companions/deliveries?${query}`, adminHeaders, 'POST', GIF);
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'COMPANION_ADMIN_RECIPIENT_OFFLINE');
  }
  assert.equal(f.counts().profiles, 0, 'Heartbeat and denied admin sends must not create companion profiles.');
});

test('legacy trial calls with wrong credentials cannot fabricate a trial usage identity for a licensed device', async (context) => {
  const f = await fixture(context);
  const devices = [await f.activate('windows'), await f.activate('macos')];
  f.app.activationStore.revoke(devices[1].licenseId);
  const trial = await f.trial('android');
  f.expire(trial);
  const counts = f.counts();
  for (const device of devices) {
    const before = f.storedUsage(device);
    const rejected = await f.request('/api/trial', device.headers, 'POST', {
      ...f.body(device), credential: crypto.randomBytes(32).toString('base64url')
    });
    // The legacy endpoint may report "not allowed" for a licensed installation, but must not attribute it.
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.allowed, false);
    assert.deepEqual(f.storedUsage(device), before);
    assert.equal(f.app.analyticsStore.database.prepare('SELECT * FROM usage_devices WHERE device_key = ?')
      .get(trialDeviceKey(device.installationId)), undefined);
    assert.equal(f.storedTrial(device), undefined);
    const valid = await f.request('/api/trial', device.headers, 'POST', f.body(device));
    assert.equal(valid.status, 200);
    assert.equal(valid.body.allowed, false);
    assert.equal(f.storedUsage(device).request_count, before.request_count + 1);
    assert.equal(f.storedUsage(device).authorization_type, 'license');
    assert.equal(f.app.analyticsStore.database.prepare('SELECT * FROM usage_devices WHERE device_key = ?')
      .get(trialDeviceKey(device.installationId)), undefined);
  }
  const beforeTrial = f.storedUsage(trial);
  const beforeAuthorization = f.storedTrial(trial);
  const rejectedTrial = await f.request('/api/trial', trial.headers, 'POST', {
    ...f.body(trial), credential: crypto.randomBytes(32).toString('base64url')
  });
  assert.equal(rejectedTrial.status, 400);
  assert.deepEqual(f.storedUsage(trial), beforeTrial);
  assert.deepEqual(f.storedTrial(trial), beforeAuthorization);
  assert.deepEqual(f.counts(), counts);
});
