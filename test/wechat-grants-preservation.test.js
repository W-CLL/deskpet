const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { ActivationStore } = require('../lib/activation-store');
const { WechatGrantStore } = require('../lib/wechat-grant-store');

test('gift authorization survives reopen and keeps source tracking through rebind and revocation', async context => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-preserve-grants-'));
  const activation = new ActivationStore(directory);
  const grants = new WechatGrantStore(directory, { activationStore: activation });
  context.after(async () => {
    grants.close();
    activation.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  await activation.initialize();
  const paidCode = activation.createCodes().codes[0];
  const paidIdentity = { installationId: crypto.randomBytes(16).toString('hex'),
    credential: crypto.randomBytes(32).toString('base64url'), platform: 'windows', architecture: 'x64' };
  const paid = activation.activate({ code: paidCode, ...paidIdentity });
  await grants.initialize();
  const input = { claimId: 'claim-local', externalSubjectId: 'subject-local', campaignId: 'campaign-local' };
  const gift = grants.create(input);
  assert.equal(grants.create(input).code, gift.code);
  const gifted = activation.activate({ code: gift.code,
    installationId: crypto.randomBytes(16).toString('hex'),
    credential: crypto.randomBytes(32).toString('base64url'), platform: 'macos', architecture: 'arm64' });
  assert.equal(grants.get(gift.grantId).status, 'redeemed');
  const rebind = activation.createRebindCode(gifted.accountId).codes[0];
  const replacementIdentity = { installationId: crypto.randomBytes(16).toString('hex'),
    credential: crypto.randomBytes(32).toString('base64url'), platform: 'macos', architecture: 'arm64' };
  const replacement = activation.activate({ code: rebind, ...replacementIdentity });
  assert.equal(replacement.accountId, gifted.accountId);
  assert.equal(activation.listLicensesForGrant(gift.grantId).length, 2);
  assert.equal(activation.orderBuyerDeviceReferences().get(gifted.accountId).length, 2);

  grants.close();
  activation.close();
  await activation.initialize();
  await grants.initialize();
  assert.deepEqual(grants.migrationState.applied, []);
  assert.equal(grants.get(gift.grantId).accountId, gifted.accountId);
  assert.equal(grants.revoke(gift.grantId).status, 'revoked');
  assert.equal(grants.revoke(gift.grantId).status, 'revoked');
  assert.equal(activation.authenticate(`Bearer ${replacement.licenseId}.${replacementIdentity.credential}`), null);
  assert.equal(activation.createRebindCode(gifted.accountId), null);
  assert.equal(activation.authenticate(`Bearer ${paid.licenseId}.${paidIdentity.credential}`).accountId, paid.accountId);
});

test('merged application retains signed internal grant routes and protects them from unsigned requests', async context => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-preserve-grant-api-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const application = await createApplication({ dataDirectory: directory, publicUrl: 'http://127.0.0.1',
    signingPrivateKey: crypto.generateKeyPairSync('ed25519').privateKey,
    wechatInternalClientId: 'local-grants-test', wechatInternalSecret: secret });
  const server = http.createServer(application.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    application.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = '/api/internal/wechat/grants';
  const body = JSON.stringify({ claimId: 'api-local', externalSubjectId: 'api-subject', campaignId: 'local' });
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update([
    'POST', route, timestamp, nonce, crypto.createHash('sha256').update(body).digest('hex')
  ].join('\n')).digest('hex');
  const headers = { 'Content-Type': 'application/json', 'X-Client-Id': 'local-grants-test',
    'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature };
  assert.equal((await fetch(base + route, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json' } })).status, 401);
  const created = await fetch(base + route, { method: 'POST', headers, body });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).status, 'issued');
  assert.equal((await fetch(base + route, { method: 'POST', headers, body })).status, 409);
  assert.equal(application.petMarketStore.catalogForAccount().products.length, 0);
  assert.equal(application.petMarketStore.paymentSettings().enabled, false);
});
