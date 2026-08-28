const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { ActivationStore } = require('../lib/activation-store');
const { ActivationService } = require('../src/services/activation-service');

test('online trial starts once and cannot be extended by the local clock', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-trial-'));
  const store = new ActivationStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  const installationId = crypto.randomBytes(16).toString('hex');
  const credential = crypto.randomBytes(32).toString('base64url');
  const service = new ActivationService({
    config: { trustProxy: false },
    activationStore: store,
    auditService: { write: async () => {} }
  });
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const first = service.trial(request, { installationId, credential, appVersion: '2.5.8' });
  assert.equal(first.allowed, true);
  assert.ok(first.remainingSeconds > 23 * 60 * 60);
  assert.ok(first.remainingSeconds <= 24 * 60 * 60);
  const trialRecord = store.database.prepare(`
    SELECT started_at, expires_at FROM trials WHERE installation_id = ?
  `).get(installationId);
  assert.equal(first.expiresAt, trialRecord.expires_at);
  assert.ok(first.serverTime);
  const storedDuration = Date.parse(trialRecord.expires_at) - Date.parse(trialRecord.started_at);
  assert.ok(storedDuration >= 7 * 24 * 60 * 60 * 1000 - 1000);
  assert.ok(storedDuration <= 7 * 24 * 60 * 60 * 1000 + 1000);
  const authenticated = service.authenticate({
    headers: { authorization: `Trial ${installationId}.${credential}` }
  });
  assert.equal(authenticated.installationId, installationId);
  assert.equal(authenticated.trial, true);

  store.database.prepare('UPDATE trials SET expires_at = ? WHERE installation_id = ?')
    .run(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), installationId);
  const midWindow = store.trialStatus({ installationId, credential });
  assert.equal(midWindow.allowed, true);
  assert.equal(midWindow.remainingSeconds, 24 * 60 * 60);
  assert.equal(store.authenticateTrial(`Trial ${installationId}.${credential}`)?.installationId, installationId);

  store.database.prepare('UPDATE trials SET expires_at = ? WHERE installation_id = ?')
    .run(new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), installationId);
  const lastDay = store.trialStatus({ installationId, credential });
  assert.equal(lastDay.allowed, true);
  assert.ok(lastDay.remainingSeconds > 11 * 60 * 60);
  assert.ok(lastDay.remainingSeconds <= 12 * 60 * 60);
  assert.equal(store.authenticateTrial(`Trial ${installationId}.${credential}`)?.installationId, installationId);

  store.database.prepare('UPDATE trials SET expires_at = ? WHERE installation_id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), installationId);
  const expired = store.trialStatus({ installationId, credential });
  assert.equal(expired.allowed, false);
  assert.equal(expired.remainingSeconds, 0);
  assert.equal(store.authenticateTrial(`Trial ${installationId}.${credential}`), null);
  assert.equal(store.trialStatus({
    installationId,
    credential: crypto.randomBytes(32).toString('base64url')
  }), null);
});

test('activating a device clears its trial and does not start another', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-trial-activate-'));
  const store = new ActivationStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  const firstInstallationId = crypto.randomBytes(16).toString('hex');
  const firstCredential = crypto.randomBytes(32).toString('base64url');
  const secondInstallationId = crypto.randomBytes(16).toString('hex');
  const secondCredential = crypto.randomBytes(32).toString('base64url');
  assert.equal(store.trialStatus({
    installationId: firstInstallationId,
    credential: firstCredential,
    appVersion: '3.2.5'
  }).allowed, true);
  assert.equal(store.trialStatus({
    installationId: secondInstallationId,
    credential: secondCredential,
    appVersion: '3.2.5'
  }).allowed, true);

  const code = store.createCodes({ count: 1, expiresInDays: 30 }).codes[0];
  const first = store.activate({
    code,
    installationId: firstInstallationId,
    credential: firstCredential,
    appVersion: '3.2.5',
    platform: 'windows'
  });
  assert.ok(first.licenseId);
  assert.equal(store.database.prepare(
    'SELECT COUNT(*) AS count FROM trials WHERE installation_id = ?'
  ).get(firstInstallationId).count, 0);
  assert.equal(store.authenticateTrial(`Trial ${firstInstallationId}.${firstCredential}`), null);
  const afterActivate = store.trialStatus({
    installationId: firstInstallationId,
    credential: firstCredential
  });
  assert.equal(afterActivate.allowed, false);
  assert.equal(afterActivate.remainingSeconds, 0);
  assert.equal(store.database.prepare(
    'SELECT COUNT(*) AS count FROM trials WHERE installation_id = ?'
  ).get(firstInstallationId).count, 0);

  const second = store.activate({
    code,
    installationId: secondInstallationId,
    credential: secondCredential,
    appVersion: '3.2.5',
    platform: 'android'
  });
  assert.equal(second.accountId, first.accountId);
  assert.equal(store.database.prepare(
    'SELECT COUNT(*) AS count FROM trials WHERE installation_id = ?'
  ).get(secondInstallationId).count, 0);
  const inventory = store.deviceInventory();
  assert.equal(inventory.filter((item) => item.authorizationType === 'trial').length, 0);
  assert.equal(
    inventory.filter((item) => item.authorizationType === 'license' && item.authorizationState === 'active').length,
    2
  );
});
