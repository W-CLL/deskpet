const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { validatePetMarketPackage } = require('../lib/pet-market-package');
const { canonicalPetMarketPayload, PetMarketService } = require('../src/services/pet-market-service');
const { PetMarketStore } = require('../lib/pet-market-store');
const { pngDataUrl } = require('./helpers/payment-image-fixtures');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const BRIDGE_TOKEN = 'pet-market-bridge-token-00000001';
const COLLECTION_ACCOUNT = 'wx-pet-market-collection-account';
const PAYMENT_SETTINGS = { enabled: true, method: 'personal_transfer', recipientName: '测试收款人',
  recipientAccount: 'test_pay01', qrCodeDataUrl: '', instructions: '转账说明只填写订单短码' };

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, data);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function petPackage(productId, version, title, options = {}) {
  const filePaths = options.filePaths || [options.filePath || 'idle.gif'];
  const fileHash = crypto.createHash('sha256').update(GIF).digest('hex');
  const manifest = {
    schemaVersion: 1,
    productId,
    version,
    title,
    files: filePaths.map((filePath, index) => ({
      path: filePath,
      sha256: options.badHash && index === 0 ? '0'.repeat(64) : fileHash,
      sizeBytes: GIF.length
    }))
  };
  return storedZip([
    { name: 'pet-market.json', data: Buffer.from(JSON.stringify(manifest)) },
    ...filePaths.map((filePath) => ({ name: filePath, data: GIF })),
    ...(options.extraEntries || [])
  ]);
}

async function fixture(context, { bridge = true } = {}) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-pet-market-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const password = 'pet market admin password';
  await fs.promises.writeFile(
    path.join(dataDirectory, 'auth.json'),
    JSON.stringify(await hashPassword(password)),
    { mode: 0o600 }
  );
  let now = Date.parse('2026-10-29T02:00:00.000Z');
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    dataDirectory,
    cookieSecure: false,
    signingPrivateKey: privateKey,
    petMarketNow: () => now,
    petMarketBridgeToken: bridge ? BRIDGE_TOKEN : undefined,
    petMarketCollectionAccountId: bridge ? COLLECTION_ACCOUNT : undefined
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    application.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  async function request(url, { method = 'GET', headers = {}, body, bytes } = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: bytes !== undefined ? bytes : body === undefined ? undefined : JSON.stringify(body)
    });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return { response, status: response.status, body: await response.json() };
    }
    return { response, status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  }

  const login = await request('/api/admin/login', {
    method: 'POST', body: { username: 'admin', password }
  });
  assert.equal(login.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const adminHeaders = {
    Cookie: cookie,
    'X-CSRF-Token': login.body.csrfToken
  };

  async function createProduct(product) {
    return request('/api/admin/pet-market/products', {
      method: 'POST', headers: adminHeaders, body: product
    });
  }

  async function updateProduct(productId, patch) {
    return request(`/api/admin/pet-market/products/${encodeURIComponent(productId)}`, {
      method: 'PATCH', headers: adminHeaders, body: patch
    });
  }

  async function upload(productId, version, title, zip = petPackage(productId, version, title)) {
    const preflight = await request(
      `/api/admin/pet-market/products/${encodeURIComponent(productId)}/versions`,
      {
        method: 'POST', headers: adminHeaders,
        body: { version, fileName: `${productId}-${version}.zip`, fileSize: zip.length }
      }
    );
    assert.equal(preflight.status, 201);
    return request(preflight.body.uploadUrl, {
      method: 'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/octet-stream' },
      bytes: zip
    });
  }

  async function trial() {
    const installationId = crypto.randomBytes(16).toString('hex');
    const credential = crypto.randomBytes(32).toString('base64url');
    const response = await request('/api/trial', {
      method: 'POST',
      body: { installationId, credential, appVersion: '3.3.0' },
      headers: { 'X-DeskPet-Platform': 'windows' }
    });
    assert.equal(response.status, 200);
    return {
      installationId,
      credential,
      headers: { Authorization: `Trial ${installationId}.${credential}` }
    };
  }

  async function activate(device) {
    const code = application.activationStore.createCodes({ count: 1 }).codes[0];
    const response = await request('/api/activate', {
      method: 'POST',
      headers: { 'X-DeskPet-Platform': 'windows' },
      body: {
        code,
        installationId: device.installationId,
        credential: device.credential,
        appVersion: '3.3.0'
      }
    });
    assert.equal(response.status, 200);
    return {
      ...response.body,
      headers: { Authorization: `Bearer ${response.body.licenseId}.${device.credential}` }
    };
  }

  return {
    application, dataDirectory, publicKey, request, adminHeaders, createProduct, updateProduct,
    upload, trial, activate, setNow(value) { now = Date.parse(value); },
    paymentSettings(settings = PAYMENT_SETTINGS) {
      return request('/api/admin/pet-market/payment-settings', { method: 'PUT', headers: adminHeaders, body: settings });
    },
    heartbeat(overrides = {}, headers = { Authorization: `Bearer ${BRIDGE_TOKEN}` }) {
      return request('/api/pet-market/payment-heartbeat', { method: 'POST', headers, body: {
        accountId: COLLECTION_ACCOUNT, noticeReady: true, transferReady: true,
        noticePollSuccess: true, transferPollSuccess: true, pollLimitSaturated: false, ...overrides
      } });
    }
  };
}

function product(id, chargingMode, priceFen, overrides = {}) {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    chargingMode,
    priceFen,
    status: 'published',
    isDefault: false,
    sortOrder: 0,
    previewMode: 'first5',
    previewPaths: [],
    ...overrides
  };
}

function verifyEnvelope(envelope, publicKey, kind) {
  assert.equal(envelope.payload.kind, kind);
  const canonical = canonicalPetMarketPayload(envelope.payload);
  assert.deepEqual(Buffer.from(envelope.signedPayload, 'base64'), canonical);
  assert.equal(envelope.sha256, crypto.createHash('sha256').update(canonical).digest('hex'));
  assert.equal(envelope.signatureAlgorithm, 'ed25519');
  assert.equal(crypto.verify(
    null,
    canonical,
    publicKey,
    Buffer.from(envelope.signature, 'base64')
  ), true);
}

async function manualConfirmationFixture(context) {
  const f = await fixture(context);
  assert.equal((await f.createProduct(product('manual-pet', 'paid', 280))).status, 201);
  assert.equal((await f.upload('manual-pet', '1.0.0', 'manual-pet title')).status, 201);
  await f.paymentSettings();
  await f.heartbeat();
  const buyer = await f.activate(await f.trial());
  const createOrder = async () => {
    const response = await f.request('/api/pet-market/orders', {
      method: 'POST', headers: buyer.headers, body: { productId: 'manual-pet' }
    });
    assert.equal(response.status, 201);
    return response.body.order;
  };
  const order = await createOrder();
  const confirmation = { note: '已与买家核对无备注转账及付款时间', expectedAmountFen: 280, received: true };
  const confirm = (id = order.id, body = confirmation, headers = f.adminHeaders) => f.request(
    `/api/admin/pet-market/orders/${id}/confirm-payment`, { method: 'POST', headers, body }
  );
  return { ...f, buyer, order, confirmation, confirm, createOrder };
}

test('manual payment confirmation requires admin write authentication and explicit validated reconciliation', async context => {
  const f = await manualConfirmationFixture(context);
  for (const headers of [{}, f.buyer.headers, { Authorization: `Bearer ${BRIDGE_TOKEN}` }]) {
    assert.equal((await f.confirm(f.order.id, f.confirmation, headers)).status, 401);
  }
  for (const headers of [{ Cookie: f.adminHeaders.Cookie },
    { ...f.adminHeaders, 'X-CSRF-Token': 'invalid' },
    { ...f.adminHeaders, Origin: 'https://other.example' }]) {
    assert.equal((await f.confirm(f.order.id, f.confirmation, headers)).status, 403);
  }
  for (const patch of [{ note: '' }, { note: ' '.repeat(10) }, { note: null }, { note: {} },
    { note: '字'.repeat(601) }, { note: 'bad\u0000note' }, { received: false }, { received: 'true' },
    { expectedAmountFen: 0 }, { expectedAmountFen: 2.8 }, { expectedAmountFen: '280' },
    { confirmedBy: 'another-admin' }, { accountId: 'another-buyer' }, { productVersion: '2.0.0' }]) {
    assert.equal((await f.confirm(f.order.id, { ...f.confirmation, ...patch })).status, 400);
  }
  const mismatch = await f.confirm(f.order.id, { ...f.confirmation, expectedAmountFen: 580 });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'ORDER_AMOUNT_MISMATCH');
  assert.equal((await f.confirm('not-an-order')).status, 404);
  assert.equal((await f.confirm(crypto.randomUUID())).status, 404);
  assert.equal(f.application.petMarketStore.entitlement(f.buyer.accountId, 'manual-pet'), null);
  assert.equal(f.application.petMarketStore.database.prepare('SELECT COUNT(*) AS count FROM local_market_manual_confirmations').get().count, 0);
});

test('manual order confirmation atomically grants the frozen version and retains private immutable audit on retry', async context => {
  const f = await manualConfirmationFixture(context);
  const store = f.application.petMarketStore;
  assert.equal((await f.upload('manual-pet', '2.0.0', 'manual-pet title')).status, 201);
  assert.equal((await f.updateProduct('manual-pet', { priceFen: 580 })).status, 200);
  const results = await Promise.all([f.confirm(), f.confirm()]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.deepEqual(results.map(result => result.body.duplicate).sort(), [false, true]);
  const paid = results.find(result => !result.body.duplicate).body;
  assert.equal(paid.order.status, 'paid');
  assert.equal(paid.order.productVersion, '1.0.0');
  assert.equal(paid.order.amountFen, 280);
  assert.equal(paid.order.confirmationMethod, 'manual');
  assert.deepEqual(paid.order.manualConfirmation, {
    note: f.confirmation.note, confirmedAt: paid.serverTime, confirmedBy: 'admin', previousStatus: 'pending_payment'
  });
  const retry = await f.confirm(f.order.id, { ...f.confirmation, note: '不能覆盖第一次核对记录' });
  assert.equal(retry.body.duplicate, true);
  assert.deepEqual(retry.body.order.manualConfirmation, paid.order.manualConfirmation);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_payment_events').get().count, 0);
  const entitlement = store.database.prepare('SELECT * FROM local_market_entitlements WHERE order_id = ?').get(f.order.id);
  assert.equal(entitlement.payment_event_id, null);
  assert.equal(entitlement.manual_confirmation_order_id, f.order.id);
  const audit = store.listAudit().filter(item => item.action === 'admin_confirm_order');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].payment_event_id, null);
  assert.equal(JSON.parse(audit[0].details_json).confirmedBy, 'admin');
  assert.equal(JSON.parse(audit[0].details_json).productVersion, '1.0.0');
  const adminOrders = await f.request('/api/admin/pet-market/orders', { headers: f.adminHeaders });
  assert.deepEqual(adminOrders.body.orders[0].manualConfirmation, paid.order.manualConfirmation);
  const descriptor = await f.request('/api/pet-market/products/manual-pet/download-descriptor', { headers: f.buyer.headers });
  assert.equal(descriptor.status, 200);
  assert.equal(descriptor.body.payload.version, '1.0.0');
  verifyEnvelope(descriptor.body, f.publicKey, 'pet-market-download');
  const download = await f.request(descriptor.body.payload.downloadPath, { headers: f.buyer.headers });
  assert.equal(download.status, 200);
  assert.equal(crypto.createHash('sha256').update(download.bytes).digest('hex'), descriptor.body.payload.sha256);
  const grant = await f.request('/api/pet-market/products/manual-pet/authorize-use', { method: 'POST', headers: f.buyer.headers });
  assert.equal(grant.status, 200);
  verifyEnvelope(grant.body, f.publicKey, 'pet-market-use-grant');
  for (const url of ['/api/pet-market/catalog', '/api/pet-market/orders', `/api/pet-market/orders/${f.order.id}`]) {
    const response = await f.request(url, { headers: f.buyer.headers });
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(response.body);
    for (const privateValue of [f.confirmation.note, 'manualConfirmation', 'confirmedBy', 'confirmationMethod']) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }

  const event = { eventKey: `delayed-${f.order.id}`, accountId: COLLECTION_ACCOUNT, category: 'personal_transfer',
    direction: 'incoming', status: 'observed', amountFen: 280, currency: 'CNY', reference: f.order.paymentReference,
    transactionId: `delayed-transaction-${f.order.id}`, occurredAt: f.order.createdAt,
    observedAt: f.order.createdAt, verified: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.request('/api/pet-market/payment-events', {
      method: 'POST', headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` }, body: event
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.autoApproved, false);
    assert.equal(response.body.paymentEvent.reviewStatus, 'candidate_review');
    assert.equal(response.body.paymentEvent.verified, false);
  }
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_entitlements').get().count, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_manual_confirmations').get().count, 1);
  assert.equal(store.entitlement(f.buyer.accountId, 'manual-pet').productVersion, '1.0.0');
});

test('manual confirmation accepts expired and canceled orders and prevents duplicate ownership', async context => {
  const f = await manualConfirmationFixture(context);
  const store = f.application.petMarketStore;
  f.setNow('2026-10-29T02:16:00.000Z');
  const expired = await f.confirm();
  assert.equal(expired.status, 200);
  assert.equal(expired.body.order.manualConfirmation.previousStatus, 'expired');

  const other = await f.activate(await f.trial());
  await f.heartbeat();
  const createOtherOrder = async () => {
    const result = await f.request('/api/pet-market/orders', {
      method: 'POST', headers: other.headers, body: { productId: 'manual-pet' }
    });
    assert.equal(result.status, 201);
    return result.body.order;
  };
  const canceled = await createOtherOrder();
  assert.equal((await f.request(`/api/pet-market/orders/${canceled.id}/cancel`, { method: 'POST', headers: other.headers })).status, 200);
  const newer = await createOtherOrder();
  const approved = await f.confirm(canceled.id);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.order.manualConfirmation.previousStatus, 'canceled');
  assert.ok(approved.body.order.canceledAt);
  const duplicatePurchase = await f.confirm(newer.id);
  assert.equal(duplicatePurchase.status, 409);
  assert.equal(duplicatePurchase.body.code, 'ALREADY_ENTITLED');
  assert.equal(store.getOrder(other.accountId, newer.id).order.status, 'pending_payment');
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_manual_confirmations').get().count, 2);
});

test('manual confirmation refuses missing locked resources and rolls back all changes if its audit fails', async context => {
  const f = await manualConfirmationFixture(context);
  const store = f.application.petMarketStore;
  const lockedPath = store.versionPath(store.versionRow('manual-pet', '1.0.0'));
  const savedPath = `${lockedPath}.saved`;
  await fs.promises.rename(lockedPath, savedPath);
  const unavailable = await f.confirm();
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.code, 'ORDER_RESOURCE_UNAVAILABLE');
  await fs.promises.rename(savedPath, lockedPath);
  assert.equal((await f.updateProduct('manual-pet', { status: 'draft' })).status, 200);
  assert.equal((await f.confirm()).body.code, 'ORDER_RESOURCE_UNAVAILABLE');
  assert.equal((await f.updateProduct('manual-pet', { status: 'unlisted' })).status, 200);
  store.database.exec(`CREATE TRIGGER test_refuse_manual_audit BEFORE INSERT ON local_market_audit
    WHEN NEW.action = 'admin_confirm_order' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;`);
  const failed = await f.confirm();
  assert.equal(failed.status, 500);
  assert.equal(store.getOrder(f.buyer.accountId, f.order.id).order.status, 'pending_payment');
  assert.equal(store.entitlement(f.buyer.accountId, 'manual-pet'), null);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_manual_confirmations').get().count, 0);
  store.database.exec('DROP TRIGGER test_refuse_manual_audit');
  assert.equal((await f.confirm()).status, 200);
});

test('manual confirmation does not create a paid entitlement over an existing free grant', async context => {
  const f = await manualConfirmationFixture(context);
  assert.equal((await f.updateProduct('manual-pet', { chargingMode: 'free', priceFen: 0 })).status, 200);
  const claimed = await f.request('/api/pet-market/products/manual-pet/claim', { method: 'POST', headers: f.buyer.headers });
  assert.equal(claimed.status, 200);
  const response = await f.confirm();
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ALREADY_ENTITLED');
  const store = f.application.petMarketStore;
  assert.equal(store.entitlement(f.buyer.accountId, 'manual-pet').source, 'free');
  assert.equal(store.getOrder(f.buyer.accountId, f.order.id).order.status, 'pending_payment');
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_manual_confirmations').get().count, 0);
});

test('manual confirmation of an automatically paid order is idempotent and preserves the original event source', async context => {
  const f = await manualConfirmationFixture(context);
  const store = f.application.petMarketStore;
  const event = { eventKey: `automatic-${f.order.id}`, accountId: COLLECTION_ACCOUNT, category: 'personal_transfer',
    direction: 'incoming', status: 'observed', amountFen: 280, currency: 'CNY', reference: f.order.paymentReference,
    transactionId: `automatic-transaction-${f.order.id}`, occurredAt: f.order.createdAt,
    observedAt: f.order.createdAt, verified: false };
  const automatic = await f.request('/api/pet-market/payment-events', {
    method: 'POST', headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` }, body: event
  });
  assert.equal(automatic.body.autoApproved, true);
  const response = await f.confirm();
  assert.equal(response.status, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(response.body.order.confirmationMethod, 'automatic');
  assert.equal(response.body.order.manualConfirmation, null);
  assert.equal(response.body.order.paidAt, automatic.body.order.paidAt);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_manual_confirmations').get().count, 0);
  assert.equal(store.listAudit().filter(item => item.action === 'admin_confirm_order').length, 0);
});

test('admin publishes one default free pet and only activated accounts can claim and download it', async (context) => {
  const f = await fixture(context);
  const created = await f.createProduct(product('starter-free', 'free', 0));
  assert.equal(created.status, 201);
  assert.equal((await f.updateProduct('starter-free', { isDefault: true })).status, 409);

  const uploaded = await f.upload(
    'starter-free',
    '1.0.0',
    'starter-free title',
    petPackage('starter-free', '1.0.0', 'starter-free title', {
      filePaths: ['shown.gif', 'hidden.gif']
    })
  );
  assert.equal(uploaded.status, 201);
  const madeDefault = await f.updateProduct('starter-free', {
    isDefault: true,
    previewMode: 'selected',
    previewPaths: ['shown.gif']
  });
  assert.equal(madeDefault.status, 200);
  assert.equal(madeDefault.body.product.isDefault, true);

  const anonymous = await f.request('/api/pet-market/catalog');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.defaultProductId, 'starter-free');
  assert.equal(anonymous.body.products[0].activationRequired, true);
  assert.equal(anonymous.body.products[0].claimable, false);
  assert.equal(anonymous.body.products[0].previewFiles.length, 1);
  assert.equal(anonymous.body.products[0].previewFiles[0].path, 'shown.gif');
  assert.match(anonymous.body.products[0].previewFiles[0].url, /\/preview\?file=shown\.gif$/);
  const preview = await f.request(anonymous.body.products[0].previewFiles[0].downloadPath);
  assert.equal(preview.status, 200);
  assert.equal(preview.response.headers.get('content-type'), 'image/gif');
  assert.equal(preview.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(preview.bytes, GIF);
  const unselectedPreview = await f.request(
    '/api/pet-market/products/starter-free/versions/1.0.0/preview?file=hidden.gif'
  );
  assert.equal(unselectedPreview.status, 404);
  const traversalPreview = await f.request(
    '/api/pet-market/products/starter-free/versions/1.0.0/preview?file=..%2Fshown.gif'
  );
  assert.equal(traversalPreview.status, 404);

  const trial = await f.trial();
  const trialCatalog = await f.request('/api/pet-market/catalog', { headers: trial.headers });
  assert.equal(trialCatalog.status, 200);
  assert.equal(trialCatalog.body.products[0].activationRequired, true);
  const trialClaim = await f.request('/api/pet-market/products/starter-free/claim', {
    method: 'POST', headers: trial.headers
  });
  assert.equal(trialClaim.status, 403);
  assert.equal(trialClaim.body.code, 'ACTIVATION_REQUIRED');

  const license = await f.activate(trial);
  const firstClaim = await f.request('/api/pet-market/products/starter-free/claim', {
    method: 'POST', headers: license.headers
  });
  const secondClaim = await f.request('/api/pet-market/products/starter-free/claim', {
    method: 'POST', headers: license.headers
  });
  assert.equal(firstClaim.status, 200);
  assert.equal(secondClaim.status, 200);
  assert.equal(firstClaim.body.entitlement.source, 'free');
  assert.equal(firstClaim.body.entitlement.productVersion, '1.0.0');
  assert.equal(secondClaim.body.entitlement.grantedAt, firstClaim.body.entitlement.grantedAt);

  const descriptor = await f.request('/api/pet-market/products/starter-free/download-descriptor', {
    headers: license.headers
  });
  assert.equal(descriptor.status, 200);
  assert.equal(descriptor.body.payload.accountId, license.accountId);
  assert.equal(descriptor.body.payload.licenseId, license.licenseId);
  assert.equal(
    Date.parse(descriptor.body.payload.expiresAt) - Date.parse(descriptor.body.payload.issuedAt),
    10 * 60 * 1000
  );
  verifyEnvelope(descriptor.body, f.publicKey, 'pet-market-download');

  const useGrant = await f.request('/api/pet-market/products/starter-free/authorize-use', {
    method: 'POST', headers: license.headers
  });
  assert.equal(useGrant.status, 200);
  assert.equal(
    Date.parse(useGrant.body.payload.expiresAt) - Date.parse(useGrant.body.payload.issuedAt),
    10 * 60 * 1000
  );
  verifyEnvelope(useGrant.body, f.publicKey, 'pet-market-use-grant');

  const download = await f.request(descriptor.body.payload.downloadPath, { headers: license.headers });
  assert.equal(download.status, 200);
  assert.equal(download.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.response.headers.get('content-type'), 'application/zip');
  assert.equal(
    crypto.createHash('sha256').update(download.bytes).digest('hex'),
    descriptor.body.payload.sha256
  );

  const hidden = await f.updateProduct('starter-free', { status: 'unlisted', isDefault: true });
  assert.equal(hidden.status, 409);
  await f.createProduct(product('second-free', 'free', 0));
  await f.upload('second-free', '1.0.0', 'second-free title');
  const switched = await f.updateProduct('second-free', { isDefault: true });
  assert.equal(switched.status, 200);
  const unlisted = await f.updateProduct('starter-free', { status: 'unlisted' });
  assert.equal(unlisted.status, 200);
  assert.equal((await f.request(
    '/api/pet-market/products/starter-free/versions/1.0.0/preview?file=shown.gif'
  )).status, 404);
  const hiddenPublic = await f.request('/api/pet-market/catalog');
  assert.equal(hiddenPublic.body.products.some((item) => item.id === 'starter-free'), false);
  const ownedCatalog = await f.request('/api/pet-market/catalog', { headers: license.headers });
  assert.equal(ownedCatalog.body.products.find((item) => item.id === 'starter-free').owned, true);
  assert.equal(ownedCatalog.body.products.find((item) => item.id === 'starter-free').downloadable, true);
  const reinstallDescriptor = await f.request(
    '/api/pet-market/products/starter-free/download-descriptor',
    { headers: license.headers }
  );
  assert.equal(reinstallDescriptor.status, 200);
  assert.equal((await f.request(reinstallDescriptor.body.payload.downloadPath, {
    headers: license.headers
  })).status, 200);

  f.application.activationStore.revoke(license.licenseId);
  const revokedDescriptor = await f.request(
    '/api/pet-market/products/starter-free/download-descriptor',
    { headers: license.headers }
  );
  assert.equal(revokedDescriptor.status, 401);
  const revokedUse = await f.request('/api/pet-market/products/starter-free/authorize-use', {
    method: 'POST', headers: license.headers
  });
  assert.equal(revokedUse.status, 401);
  const revokedDownload = await f.request(descriptor.body.payload.downloadPath, {
    headers: license.headers
  });
  assert.equal(revokedDownload.status, 401);

  const other = await f.activate(await f.trial());
  const forbidden = await f.request(descriptor.body.payload.downloadPath, { headers: other.headers });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'ENTITLEMENT_REQUIRED');

  const listing = await f.request('/api/admin/pet-market/products', {
    headers: { Cookie: f.adminHeaders.Cookie }
  });
  assert.equal(listing.body.products.filter((item) => item.isDefault).length, 1);
  assert.equal(listing.body.products.find((item) => item.isDefault).id, 'second-free');
});

test('paid orders lock amount and version, bridge matching grants one account entitlement', async (context) => {
  const f = await fixture(context);
  assert.equal((await f.paymentSettings()).status, 200);
  assert.equal((await f.heartbeat()).body.available, true);
  await f.createProduct(product('premium-pet', 'paid', 280));
  assert.equal((await f.upload('premium-pet', '1.0.0', 'premium-pet title')).status, 201);

  const trial = await f.trial();
  const denied = await f.request('/api/pet-market/orders', {
    method: 'POST', headers: trial.headers, body: { productId: 'premium-pet' }
  });
  assert.equal(denied.status, 403);
  const buyer = await f.activate(trial);
  const forged = await f.request('/api/pet-market/orders', {
    method: 'POST', headers: buyer.headers,
    body: { productId: 'premium-pet', accountId: 'forged' }
  });
  assert.equal(forged.status, 400);

  const orderResponse = await f.request('/api/pet-market/orders', {
    method: 'POST', headers: buyer.headers, body: { productId: 'premium-pet' }
  });
  assert.equal(orderResponse.status, 201);
  const order = orderResponse.body.order;
  assert.equal(order.amountFen, 280);
  assert.equal(order.productVersion, '1.0.0');

  assert.equal((await f.upload('premium-pet', '2.0.0', 'premium-pet title')).status, 201);
  assert.equal((await f.request(
    '/api/pet-market/products/premium-pet/versions/1.0.0/preview?file=idle.gif'
  )).status, 404);
  assert.equal((await f.request(
    '/api/pet-market/products/premium-pet/versions/2.0.0/preview?file=idle.gif'
  )).status, 200);
  const other = await f.activate(await f.trial());
  const hiddenOrder = await f.request(`/api/pet-market/orders/${order.id}`, {
    headers: other.headers
  });
  assert.equal(hiddenOrder.status, 404);

  const event = {
    eventKey: `payment-${order.id}`,
    accountId: COLLECTION_ACCOUNT,
    category: 'personal_transfer',
    direction: 'incoming',
    status: 'observed',
    amountFen: 280,
    currency: 'CNY',
    reference: order.paymentReference.toLowerCase(),
    transactionId: `wx-transfer-${order.id}`,
    occurredAt: '2026-10-29T02:01:00.000Z',
    observedAt: '2026-10-29T02:02:00.000Z',
    verified: false
  };
  const bridgeDenied = await f.request('/api/pet-market/payment-events', {
    method: 'POST', body: event
  });
  assert.equal(bridgeDenied.status, 401);
  const paid = await f.request('/api/pet-market/payment-events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: event
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.autoApproved, true);
  assert.equal(paid.body.order.status, 'paid');

  const descriptor = await f.request('/api/pet-market/products/premium-pet/download-descriptor', {
    headers: buyer.headers
  });
  assert.equal(descriptor.status, 200);
  assert.equal(descriptor.body.payload.version, '1.0.0');
  verifyEnvelope(descriptor.body, f.publicKey, 'pet-market-download');
  const ownedCatalog = await f.request('/api/pet-market/catalog', { headers: buyer.headers });
  const ownedProduct = ownedCatalog.body.products.find((item) => item.id === 'premium-pet');
  assert.equal(ownedProduct.activeVersion, '2.0.0');
  assert.equal(ownedProduct.entitlementVersion, '1.0.0');
  assert.equal(ownedProduct.ownedVersion, '1.0.0');
  const repeatEvent = await f.request('/api/pet-market/payment-events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: event
  });
  assert.equal(repeatEvent.status, 200);
  assert.equal(repeatEvent.body.duplicate, true);
  assert.equal(f.application.petMarketStore.entitlement(buyer.accountId, 'premium-pet').productVersion, '1.0.0');
  const history = await f.request('/api/pet-market/orders', { headers: buyer.headers });
  assert.equal(history.status, 200);
  assert.equal(history.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(history.body.orders.length, 1);
  assert.equal(history.body.orders[0].id, order.id);
  assert.equal(history.body.orders[0].status, 'paid');
  assert.equal(history.body.orders[0].productTitle, 'premium-pet title');
  assert.equal(history.body.orders[0].productVersion, '1.0.0');
  assert.equal(history.body.orders[0].paidAt, paid.body.order.paidAt);
  assert.equal(history.body.orders[0].payment.recipientAccount, PAYMENT_SETTINGS.recipientAccount);
  assert.equal(history.body.orders[0].payment.available, false);
  assert.equal(JSON.stringify(history.body).includes(COLLECTION_ACCOUNT), false);
  assert.equal(JSON.stringify(history.body).includes(BRIDGE_TOKEN), false);
  assert.deepEqual((await f.request(`/api/pet-market/orders?accountId=${buyer.accountId}`, { headers: other.headers })).body.orders, []);
});

test('order history is scoped to activated account and retains canceled and expired orders newest first', async (context) => {
  const f = await fixture(context);
  await f.createProduct(product('history-pet', 'paid', 280));
  await f.upload('history-pet', '1.0.0', 'history-pet title');
  const trial = await f.trial();
  assert.equal((await f.request('/api/pet-market/orders')).status, 401);
  assert.equal((await f.request('/api/pet-market/orders', { headers: trial.headers })).status, 403);
  const buyer = await f.activate(trial);
  await f.paymentSettings();
  await f.heartbeat();
  const create = () => f.request('/api/pet-market/orders', {
    method: 'POST', headers: buyer.headers, body: { productId: 'history-pet' }
  });
  const first = (await create()).body.order;
  const canceled = await f.request(`/api/pet-market/orders/${first.id}/cancel`, { method: 'POST', headers: buyer.headers });
  assert.equal(canceled.body.order.status, 'canceled');
  f.setNow('2026-10-29T02:00:01.000Z');
  const second = (await create()).body.order;
  f.setNow('2026-10-29T02:16:00.000Z');
  const history = (await f.request('/api/pet-market/orders', { headers: buyer.headers })).body;
  assert.equal(history.serverTime, '2026-10-29T02:16:00.000Z');
  assert.deepEqual(history.orders.map(order => order.id), [second.id, first.id]);
  assert.deepEqual(history.orders.map(order => order.status), ['expired', 'canceled']);
  assert.equal(history.orders[1].canceledAt, canceled.body.order.canceledAt);
  for (const item of history.orders) {
    assert.equal(item.productTitle, 'history-pet title');
    assert.equal(item.amountFen, 280);
    assert.equal(item.payment.recipientAccount, PAYMENT_SETTINGS.recipientAccount);
    assert.equal(item.payment.available, false);
  }
  f.application.activationStore.revoke(buyer.licenseId);
  assert.equal((await f.request('/api/pet-market/orders', { headers: buyer.headers })).status, 401);
});

test('order history pages without omissions and bounds QR payloads while preserving frozen summaries', async (context) => {
  const f = await fixture(context);
  await f.createProduct(product('page-pet', 'paid', 280));
  await f.upload('page-pet', '1.0.0', 'page-pet title');
  const buyer = await f.activate(await f.trial());
  const store = f.application.petMarketStore;
  for (let index = 0; index < 103; index += 1) {
    const order = store.createOrder(buyer.accountId, 'page-pet').order;
    store.cancelOrder(buyer.accountId, order.id);
  }
  const first = await f.request('/api/pet-market/orders', { headers: buyer.headers });
  assert.equal(first.body.orders.length, 100);
  assert.equal(first.body.orders.every(order => order.payment === null), true, 'legacy terminal orders do not invent current payment targets');
  assert.ok(first.body.nextCursor);
  const second = await f.request('/api/pet-market/orders?cursor=' + first.body.nextCursor, { headers: buyer.headers });
  assert.equal(second.body.orders.length, 3);
  assert.equal(second.body.nextCursor, null);
  assert.equal(new Set([...first.body.orders, ...second.body.orders].map(order => order.id)).size, 103);
  const other = await f.activate(await f.trial());
  assert.deepEqual((await f.request('/api/pet-market/orders?cursor=' + first.body.nextCursor, { headers: other.headers })).body.orders, []);
  assert.equal((await f.request('/api/pet-market/orders?cursor=invalid', { headers: buyer.headers })).status, 400);

  const qrSettings = { ...PAYMENT_SETTINGS, method: 'collection_qr', qrCodeDataUrl: pngDataUrl(1, 1, 250 * 1024) };
  assert.equal((await f.paymentSettings(qrSettings)).status, 200);
  await f.heartbeat();
  const pendingIds = [];
  for (let index = 0; index < 3; index += 1) {
    const account = await f.activate(await f.trial());
    const order = store.createOrderWithPayment(account.accountId, 'page-pet', qrSettings).order;
    pendingIds.push(order.id);
  }
  const viewer = await f.activate(await f.trial());
  // Consolidate only isolated fixture orders under one account to cover multiple large pending QRs.
  for (const id of pendingIds) store.database.prepare('UPDATE local_market_orders SET account_id = ? WHERE id = ?').run(viewer.accountId, id);
  const qrFirst = await f.request('/api/pet-market/orders', { headers: viewer.headers });
  assert.equal(qrFirst.body.orders.length, 2);
  assert.ok(qrFirst.body.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(qrFirst.body)) < 1024 * 1024);
  assert.equal(qrFirst.body.orders[0].payment.qrCodeDataUrl, qrSettings.qrCodeDataUrl);
  const qrNext = await f.request('/api/pet-market/orders?cursor=' + qrFirst.body.nextCursor, { headers: viewer.headers });
  assert.equal(qrNext.body.orders.length, 1);
  assert.equal(qrNext.body.nextCursor, null);
  for (const id of pendingIds) store.cancelOrder(viewer.accountId, id);
  const terminal = await f.request('/api/pet-market/orders', { headers: viewer.headers });
  assert.equal(terminal.body.orders.length, 3);
  assert.equal(terminal.body.orders.every(order => order.payment.qrCodeDataUrl === '' && order.payment.recipientName === PAYMENT_SETTINGS.recipientName), true);
});

test('paid ordering is unavailable without bridge configuration and invalid packages never commit', async (context) => {
  const f = await fixture(context, { bridge: false });
  assert.equal((await f.paymentSettings()).status, 200);
  assert.equal((await f.heartbeat()).status, 503);
  await f.createProduct(product('offline-paid', 'paid', 580));
  await f.upload('offline-paid', '1.0.0', 'offline-paid title');
  const buyer = await f.activate(await f.trial());
  const unavailable = await f.request('/api/pet-market/orders', {
    method: 'POST', headers: buyer.headers, body: { productId: 'offline-paid' }
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, 'PAYMENT_UNAVAILABLE');

  await f.createProduct(product('invalid-pack', 'free', 0));
  const badHash = await f.upload(
    'invalid-pack',
    '1.0.0',
    'invalid-pack title',
    petPackage('invalid-pack', '1.0.0', 'invalid-pack title', { badHash: true })
  );
  assert.equal(badHash.status, 400);
  assert.equal(badHash.body.code, 'INVALID_PET_MARKET_PACKAGE');
  const traversal = petPackage('invalid-pack', '1.0.1', 'invalid-pack title', {
    filePath: '../escape.gif'
  });
  assert.throws(
    () => validatePetMarketPackage(traversal, {
      productId: 'invalid-pack', version: '1.0.1', title: 'invalid-pack title'
    }),
    /不安全路径/
  );
  const backslash = petPackage('invalid-pack', '1.0.2', 'invalid-pack title', {
    filePath: 'folder\\idle.gif'
  });
  assert.throws(
    () => validatePetMarketPackage(backslash, {
      productId: 'invalid-pack', version: '1.0.2', title: 'invalid-pack title'
    }),
    /正斜杠/
  );
  for (const invalidPath of [
    '.hidden.gif',
    'CON.gif',
    'folder/x:ads.gif',
    'trailing. /idle.gif',
    'bad<name.gif',
    'control\u0001.gif'
  ]) {
    assert.throws(
      () => validatePetMarketPackage(
        petPackage('invalid-pack', '1.0.3', 'invalid-pack title', { filePath: invalidPath }),
        { productId: 'invalid-pack', version: '1.0.3', title: 'invalid-pack title' }
      ),
      /Windows 不支持/
    );
  }
  const invalidDeflate = Buffer.from(
    petPackage('invalid-pack', '1.0.4', 'invalid-pack title')
  );
  invalidDeflate.writeUInt16LE(8, 8);
  const firstCentralHeader = invalidDeflate.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  invalidDeflate.writeUInt16LE(8, firstCentralHeader + 10);
  const invalidDeflateUpload = await f.upload(
    'invalid-pack',
    '1.0.4',
    'invalid-pack title',
    invalidDeflate
  );
  assert.equal(invalidDeflateUpload.status, 400);
  assert.equal(invalidDeflateUpload.body.code, 'INVALID_PET_MARKET_PACKAGE');
  const listing = await f.request('/api/admin/pet-market/products', {
    headers: { Cookie: f.adminHeaders.Cookie }
  });
  assert.equal(listing.body.products.find((item) => item.id === 'invalid-pack').activeVersion, '');
});

test('payment settings require admin CSRF, persist safely, and expose only payment display fields', async (context) => {
  const f = await fixture(context);
  const endpoint = '/api/admin/pet-market/payment-settings';
  assert.equal((await f.request(endpoint)).status, 401);
  const defaults = await f.request(endpoint, { headers: f.adminHeaders });
  assert.equal(defaults.body.payment.enabled, false);
  assert.equal(defaults.body.payment.available, false);
  assert.equal(defaults.response.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request(endpoint, { method: 'PUT', headers: { Cookie: f.adminHeaders.Cookie }, body: PAYMENT_SETTINGS })).status, 403);
  assert.equal((await f.paymentSettings()).status, 200);
  for (const patch of [{ enabled: 'true' }, { method: 'card' }, { recipientName: '' },
    { recipientAccount: 'invalid 微信' }, { qrCodeDataUrl: 'data:image/png;base64,AAAA' },
    { bridgeToken: 'fake-token' }, { collectionAccountId: 'fake-account' }]) {
    assert.equal((await f.paymentSettings({ ...PAYMENT_SETTINGS, ...patch })).status, 400);
    assert.deepEqual(f.application.petMarketStore.paymentSettings(), PAYMENT_SETTINGS);
  }
  const reopened = new PetMarketStore(f.dataDirectory, { collectionAccountId: COLLECTION_ACCOUNT });
  await reopened.initialize();
  try { assert.deepEqual(reopened.paymentSettings(), PAYMENT_SETTINGS); } finally { reopened.close(); }
  // Even data from a future migration cannot accidentally disclose internal fields.
  f.application.petMarketStore.savePaymentSettings({ ...PAYMENT_SETTINGS, bridgeToken: BRIDGE_TOKEN, collectionAccountId: COLLECTION_ACCOUNT });
  const catalog = await f.request('/api/pet-market/catalog');
  assert.deepEqual(Object.keys(catalog.body.payment).sort(), ['available', 'enabled', 'instructions', 'listenerOnline',
    'method', 'qrCodeDataUrl', 'recipientAccount', 'recipientName', 'unavailableReason'].sort());
  assert.equal(JSON.stringify(catalog.body).includes(BRIDGE_TOKEN), false);
  assert.equal(JSON.stringify(catalog.body).includes(COLLECTION_ACCOUNT), false);
});

test('payment heartbeat is authenticated, rejects client clocks, and gates ordering on source readiness and receipt TTL', async (context) => {
  const f = await fixture(context);
  await f.createProduct(product('listen-pet', 'paid', 280));
  await f.upload('listen-pet', '1.0.0', 'listen-pet title');
  const buyer = await f.activate(await f.trial());
  const createOrder = () => f.request('/api/pet-market/orders', {
    method: 'POST', headers: buyer.headers, body: { productId: 'listen-pet' }
  });
  const countOrders = () => Number(f.application.petMarketStore.database.prepare('SELECT COUNT(*) AS n FROM local_market_orders').get().n);
  assert.equal((await createOrder()).status, 503);
  await f.paymentSettings();
  assert.equal((await createOrder()).status, 503);
  assert.equal((await f.heartbeat({}, {})).status, 401);
  assert.equal((await f.heartbeat({}, { Authorization: 'Bearer wrong-token' })).status, 403);
  assert.equal((await f.heartbeat({ accountId: 'wrong-account' })).status, 403);
  assert.equal((await f.heartbeat({ transferReady: 'true' })).status, 400);
  assert.equal((await f.heartbeat({ receivedAt: '2999-01-01T00:00:00Z' })).status, 400);
  for (const state of [{ transferReady: false }, { transferPollSuccess: false }, { pollLimitSaturated: true }]) {
    assert.equal((await f.heartbeat()).body.available, true);
    assert.equal((await f.heartbeat(state)).body.available, false);
    assert.equal((await createOrder()).status, 503);
  }
  assert.equal(countOrders(), 0);
  const heartbeat = await f.heartbeat({ noticeReady: false, noticePollSuccess: false });
  assert.equal(heartbeat.body.receivedAt, '2026-10-29T02:00:00.000Z');
  assert.equal(heartbeat.body.available, true, 'transfer orders need the transfer source, independent of notice source');
  f.setNow('2026-10-29T02:00:30.001Z');
  assert.equal((await f.request('/api/pet-market/catalog')).body.payment.available, true,
    'a structured read taking over 30 seconds does not expire the last successful heartbeat');
  f.setNow('2026-10-29T02:01:00.000Z');
  assert.equal((await f.request('/api/pet-market/catalog')).body.payment.available, true);
  f.setNow('2026-10-29T02:01:00.001Z');
  assert.equal((await createOrder()).status, 503);
  f.setNow('2026-10-29T01:59:59.999Z');
  assert.equal((await f.request('/api/pet-market/catalog')).body.payment.available, false);
  assert.equal(countOrders(), 0);
  f.setNow('2026-10-29T02:00:00.000Z');
  const order = await createOrder();
  assert.equal(order.status, 201);
  assert.equal(order.body.order.payment.available, true);
  assert.equal(Date.parse(order.body.order.expiresAt) - Date.parse(order.body.order.createdAt), 15 * 60 * 1000,
    'the listener lease does not change the 15 minute order lifetime');
  assert.equal(countOrders(), 1);
  const service = f.application.services.petMarketService;
  const restarted = new PetMarketService({ config: service.config, petMarketStore: service.petMarketStore,
    activationService: service.activationService, auditService: service.auditService, signingPrivateKey: service.signingPrivateKey });
  assert.equal(restarted.paymentStatus().listenerOnline, false, 'a restarted service cannot reuse an old in-memory heartbeat');
  assert.equal(restarted.paymentStatus().available, false);
});

test('orders freeze their payment mode and target while settings and listener readiness change', async (context) => {
  const f = await fixture(context);
  await f.createProduct(product('frozen-pet', 'paid', 580));
  await f.upload('frozen-pet', '1.0.0', 'frozen-pet title');
  const buyer = await f.activate(await f.trial());
  const other = await f.activate(await f.trial());
  const createOrder = headers => f.request('/api/pet-market/orders', {
    method: 'POST', headers, body: { productId: 'frozen-pet' }
  });
  await f.paymentSettings();
  await f.heartbeat();
  const original = (await createOrder(buyer.headers)).body.order;
  const qrSettings = { ...PAYMENT_SETTINGS, method: 'collection_qr', recipientName: '新的收款人',
    recipientAccount: 'next_pay01', qrCodeDataUrl: pngDataUrl(), instructions: '新的付款说明' };
  await f.paymentSettings(qrSettings);
  await f.heartbeat({ noticeReady: false, noticePollSuccess: false });
  assert.equal((await f.request('/api/pet-market/catalog')).body.payment.available, false);
  const frozen = await f.request(`/api/pet-market/orders/${original.id}`, { headers: buyer.headers });
  assert.equal(frozen.response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(frozen.body.order, original, 'old transfer order remains online with its original method and target');
  assert.equal((await createOrder(other.headers)).status, 503);
  await f.heartbeat({ transferReady: false, transferPollSuccess: false });
  const unavailableOld = (await f.request(`/api/pet-market/orders/${original.id}`, { headers: buyer.headers })).body.order;
  assert.equal(unavailableOld.payment.available, false, 'old transfer order still needs transfer source even while QR source is online');
  assert.equal(unavailableOld.payment.recipientName, PAYMENT_SETTINGS.recipientName);
  const newer = await createOrder(other.headers);
  assert.equal(newer.status, 201);
  assert.equal(newer.body.order.payment.method, 'collection_qr');
  assert.equal(newer.body.order.payment.qrCodeDataUrl, qrSettings.qrCodeDataUrl);
  await f.paymentSettings({ ...qrSettings, enabled: false });
  const reused = await createOrder(buyer.headers);
  assert.equal(reused.body.reused, true);
  assert.equal(reused.body.order.payment.available, false);
  assert.equal(reused.body.order.payment.enabled, false);
  for (const key of ['id', 'paymentReference', 'amountFen', 'productVersion', 'expiresAt', 'status']) {
    assert.equal(reused.body.order[key], original[key]);
  }
  const third = await f.activate(await f.trial());
  assert.equal((await createOrder(third.headers)).status, 503);
  assert.equal(Number(f.application.petMarketStore.database.prepare('SELECT COUNT(*) AS n FROM local_market_orders').get().n), 2);
  const reopened = new PetMarketStore(f.dataDirectory, { collectionAccountId: COLLECTION_ACCOUNT });
  await reopened.initialize();
  try { assert.deepEqual(reopened.paymentSnapshot(original.id).payment, PAYMENT_SETTINGS); } finally { reopened.close(); }
  const canceled = await f.request(`/api/pet-market/orders/${newer.body.order.id}/cancel`, { method: 'POST', headers: other.headers });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.order.payment.available, false);
});

test('only an unsnapshotted legacy placeholder order binds once without changing order terms', async (context) => {
  const f = await fixture(context);
  await f.createProduct(product('legacy-pet', 'paid', 280));
  await f.upload('legacy-pet', '1.0.0', 'legacy-pet title');
  const buyer = await f.activate(await f.trial());
  const other = await f.activate(await f.trial());
  const store = f.application.petMarketStore;
  const legacy = store.createOrder(buyer.accountId, 'legacy-pet').order;
  const mismatch = store.createOrder(other.accountId, 'legacy-pet').order;
  store.database.prepare('UPDATE local_market_orders SET collection_account_id = ? WHERE id = ?').run('local-demo-collection', legacy.id);
  store.database.prepare('UPDATE local_market_orders SET collection_account_id = ? WHERE id = ?').run('other-real-collection', mismatch.id);
  const rowBefore = { ...store.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(legacy.id) };
  const getLegacy = () => f.request(`/api/pet-market/orders/${legacy.id}`, { headers: buyer.headers });
  assert.equal((await getLegacy()).body.order.payment.available, false);
  assert.equal(store.paymentSnapshot(legacy.id), null);
  await f.paymentSettings();
  assert.equal((await getLegacy()).body.order.payment.available, false);
  assert.equal(store.paymentSnapshot(legacy.id), null);
  await f.heartbeat();
  const bound = await getLegacy();
  assert.equal(bound.body.order.payment.available, true);
  const rowAfter = { ...store.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(legacy.id) };
  assert.deepEqual(rowAfter, { ...rowBefore, collection_account_id: COLLECTION_ACCOUNT });
  assert.equal(store.paymentSnapshot(legacy.id).collectionAccountId, COLLECTION_ACCOUNT);
  await getLegacy();
  assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM local_market_audit WHERE action = 'bind_payment_target' AND order_id = ?").get(legacy.id).n), 1);
  await f.paymentSettings({ ...PAYMENT_SETTINGS, recipientName: '后来改名', recipientAccount: 'next_pay01' });
  assert.equal((await getLegacy()).body.order.payment.recipientAccount, PAYMENT_SETTINGS.recipientAccount);
  const mismatchResult = await f.request(`/api/pet-market/orders/${mismatch.id}`, { headers: other.headers });
  assert.equal(mismatchResult.body.order.payment.available, false);
  assert.equal(store.paymentSnapshot(mismatch.id), null);
  assert.equal(store.database.prepare('SELECT collection_account_id AS target FROM local_market_orders WHERE id = ?').get(mismatch.id).target, 'other-real-collection');
  f.application.services.petMarketService.config.petMarketCollectionAccountId = 'changed-real-account';
  assert.equal((await getLegacy()).body.order.payment.available, false);
  assert.equal(store.paymentSnapshot(legacy.id).collectionAccountId, COLLECTION_ACCOUNT);
});

test('380 fen products stay private as drafts, preserve their price on edits, and create exact-price orders', async (context) => {
  const f = await fixture(context);
  const created = await f.createProduct(product('middle-price-pet', 'paid', 380, { status: 'draft' }));
  assert.equal(created.status, 201);
  assert.equal(created.body.product.priceFen, 380);
  assert.equal(created.body.product.status, 'draft');
  assert.equal((await f.upload('middle-price-pet', '1.0.0', 'middle-price-pet title')).status, 201);
  const edited = await f.updateProduct('middle-price-pet', { description: 'Updated draft description' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.product.priceFen, 380);
  assert.equal(edited.body.product.status, 'draft');
  assert.equal((await f.request('/api/pet-market/catalog')).body.products.length, 0);

  for (const priceFen of [0, 100, 279, 381, 500]) {
    const rejected = await f.updateProduct('middle-price-pet', { priceFen });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'INVALID_PET_MARKET_PRICE');
  }
  const freeWithPrice = await f.updateProduct('middle-price-pet', { chargingMode: 'free', priceFen: 380 });
  assert.equal(freeWithPrice.status, 400);
  assert.equal(freeWithPrice.body.code, 'INVALID_PET_MARKET_PRICE');
  for (const priceFen of [280, 580, 380]) {
    const updated = await f.updateProduct('middle-price-pet', { priceFen });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.product.priceFen, priceFen);
  }

  assert.equal((await f.updateProduct('middle-price-pet', { status: 'published' })).status, 200);
  assert.equal((await f.request('/api/pet-market/catalog')).body.products[0].priceFen, 380);
  await f.paymentSettings();
  await f.heartbeat();
  const buyer = await f.activate(await f.trial());
  const order = await f.request('/api/pet-market/orders', {
    method: 'POST', headers: buyer.headers, body: { productId: 'middle-price-pet' }
  });
  assert.equal(order.status, 201);
  assert.equal(order.body.order.amountFen, 380);
});

test('direct GIF upload, product labels and public covers follow the verified publishing flow', async (context) => {
  const f = await fixture(context);
  const created = await f.createProduct(product('warm-cat', 'paid', 280, {
    status: 'draft', tags: [' 治愈 ', '萌宠', '治愈'], isFeatured: true
  }));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.product.tags, ['治愈', '萌宠']);
  assert.equal(created.body.product.isFeatured, true);
  for (const invalid of [null, '治愈', [1], [{}], ['1', '2', '3', '4', '5'], ['超过十二个字的标签不应该被保存'], ['a\nb']]) {
    assert.equal((await f.updateProduct('warm-cat', { tags: invalid })).status, 400);
  }
  assert.equal((await f.updateProduct('warm-cat', { isFeatured: 'true' })).status, 400);
  assert.equal((await f.request('/api/pet-market/catalog')).body.products.length, 0);
  const preflightBody = {
    version: '1.0.0', sourceType: 'gif-files', fileSize: GIF.length * 2,
    files: [{ path: '角色/陪伴.gif', sizeBytes: GIF.length }, { path: '角色/招手.gif', sizeBytes: GIF.length }]
  };
  const preflight = await f.request('/api/admin/pet-market/products/warm-cat/versions', {
    method: 'POST', headers: f.adminHeaders, body: preflightBody
  });
  assert.equal(preflight.status, 201);
  const uploaded = await f.request(preflight.body.uploadUrl, {
    method: 'PUT', headers: { ...f.adminHeaders, 'Content-Type': 'application/octet-stream' },
    bytes: Buffer.concat([GIF, GIF])
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.version.assetCount, 2);
  assert.equal(uploaded.body.product.status, 'draft');
  assert.equal((await f.request('/api/pet-market/catalog')).body.products.length, 0);
  assert.equal((await f.updateProduct('warm-cat', {
    status: 'published', previewMode: 'selected', previewPaths: ['角色/陪伴.gif']
  })).status, 200);
  const catalog = await f.request('/api/pet-market/catalog');
  const shown = catalog.body.products[0];
  assert.deepEqual(shown.tags, ['治愈', '萌宠']);
  assert.equal(shown.isFeatured, true);
  assert.equal(shown.assetCount, 2);
  assert.equal(shown.previewFiles.length, 1);
  assert.equal(shown.previewFiles[0].path, '角色/陪伴.gif');
  assert.equal(shown.versions, undefined);
  const listing = await f.request('/api/admin/pet-market/products', { headers: f.adminHeaders });
  assert.deepEqual(listing.body.products[0].previewFiles, shown.previewFiles);
  assert.deepEqual((await f.request(shown.previewFiles[0].downloadPath)).bytes, GIF);
  assert.equal((await f.request('/api/pet-market/products/warm-cat/versions/1.0.0/preview?file=' + encodeURIComponent('角色/招手.gif'))).status, 404);
  assert.equal((await f.request('/api/pet-market/products/warm-cat/download-descriptor')).status, 401);
  assert.equal((await f.updateProduct('warm-cat', {
    previewPaths: ['角色/招手.gif', '角色/陪伴.gif']
  })).status, 200);
  const reordered = (await f.request('/api/pet-market/catalog')).body.products[0];
  assert.deepEqual(reordered.previewFiles.map(file => file.path), ['角色/招手.gif', '角色/陪伴.gif']);
  const reorderedAdmin = (await f.request('/api/admin/pet-market/products', { headers: f.adminHeaders })).body.products[0];
  assert.deepEqual(reorderedAdmin.previewFiles, reordered.previewFiles);
  assert.equal((await f.updateProduct('warm-cat', { tags: ['陪伴'], isFeatured: false })).status, 200);
  const refreshed = (await f.request('/api/pet-market/catalog')).body.products[0];
  assert.deepEqual(refreshed.tags, ['陪伴']);
  assert.equal(refreshed.isFeatured, false);
});

test('direct GIF API rejects invalid registration and never commits malformed image bytes', async (context) => {
  const f = await fixture(context);
  await f.createProduct(product('invalid-gif', 'free', 0, { status: 'draft' }));
  const route = '/api/admin/pet-market/products/invalid-gif/versions';
  for (const files of [[], [{ path: '../secret.gif', sizeBytes: 1 }],
    [{ path: 'a.gif', sizeBytes: 1 }, { path: 'A.gif', sizeBytes: 1 }],
    [{ path: 'a.gif', sizeBytes: 8 * 1024 * 1024 + 1 }]]) {
    const result = await f.request(route, { method: 'POST', headers: f.adminHeaders,
      body: { version: '1.0.0', sourceType: 'gif-files', fileSize: 1, files } });
    assert.equal(result.status, 400);
  }
  const bytes = Buffer.from('GIF89a is not a valid image');
  const registration = { version: '1.0.0', sourceType: 'gif-files', fileSize: bytes.length,
    files: [{ path: 'a.gif', sizeBytes: bytes.length }] };
  assert.equal((await f.request(route, { method: 'POST', body: registration })).status, 401);
  const task = await f.request(route, { method: 'POST', headers: f.adminHeaders, body: registration });
  assert.equal(task.status, 201);
  const result = await f.request(task.body.uploadUrl, {
    method: 'PUT', headers: { ...f.adminHeaders, 'Content-Type': 'application/octet-stream' }, bytes
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_PET_MARKET_PACKAGE');
  assert.equal(f.application.petMarketStore.findProduct('invalid-gif').activeVersion, '');
  assert.equal(f.application.petMarketStore.findProduct('invalid-gif').status, 'draft');
});
