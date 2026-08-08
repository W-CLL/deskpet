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
  const first = service.trial(request, { installationId, credential, appVersion: '2.5.7' });
  assert.equal(first.allowed, true);
  assert.equal(first.remainingSeconds, 600);
  const authenticated = service.authenticate({
    headers: { authorization: `Trial ${installationId}.${credential}` }
  });
  assert.equal(authenticated.installationId, installationId);
  assert.equal(authenticated.trial, true);

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
