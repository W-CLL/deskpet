const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');

const NOW = '2026-10-29T10:15:00.000Z';
const orderId = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const endpoint = '/api/admin/pet-market/orders';
const BRIDGE_TOKEN = 'admin-orders-isolated-bridge-token';
const COLLECTION_ACCOUNT = 'admin-orders-isolated-collection';

async function fixture(context, { seed = true } = {}) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-admin-orders-'));
  const password = 'isolated admin order test password';
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'), JSON.stringify(await hashPassword(password)));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1', dataDirectory, cookieSecure: false,
    signingPrivateKey: privateKey, petMarketNow: () => Date.parse(NOW),
    petMarketBridgeToken: BRIDGE_TOKEN, petMarketCollectionAccountId: COLLECTION_ACCOUNT
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
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const login = await request('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password })
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';', 1)[0] };
  if (seed) {
    const store = application.petMarketStore;
    for (const [id, title, priceFen] of [['kitty', '云朵猫', 280], ['pup', 'Sunny Pup', 580]]) {
      store.createProduct({
        id, title, description: '', chargingMode: 'paid', priceFen,
        status: 'unlisted', isDefault: false, sortOrder: 0, previewMode: 'none', previewPaths: []
      });
    }
    const insert = store.database.prepare(`
      INSERT INTO local_market_orders (id, account_id, product_id, product_version, amount_fen, currency,
        collection_account_id, payment_reference, status, created_at, expires_at, canceled_at, paid_at,
        payment_event_id, updated_at)
      VALUES (?, ?, ?, '1.0.0', ?, 'CNY', 'private-collection-sentinel', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = [
      [1, 'account-amy', 'kitty', 280, 'paid', '10:00', '10:15'],
      [2, 'account-bo', 'pup', 580, 'paid', '10:01', '10:16'],
      [3, 'account-amy', 'kitty', 280, 'canceled', '10:02', '10:17'],
      [4, 'account-amy', 'kitty', 280, 'pending_payment', '10:03', '10:18'],
      [5, 'account-bo', 'pup', 580, 'expired', '09:00', '09:15'],
      [6, 'account-bo', 'pup', 580, 'pending_payment', '09:59', '10:14'],
      [7, 'account-legacy', 'legacy-removed', 1, 'pending_payment', '10:03', '10:18']
    ];
    for (const [number, account, product, amount, status, created, expires] of rows) {
      insert.run(orderId(number), account, product, amount, `${100 + number}AA`, status,
        `2026-10-29T${created}:00.000Z`, `2026-10-29T${expires}:00.000Z`,
        status === 'canceled' ? NOW : null, status === 'paid' ? NOW : null,
        status === 'paid' ? `private-event-sentinel-${number}` : null, NOW);
    }
    store.database.prepare('UPDATE pet_market_products SET price_fen = 990, active_version = ? WHERE id = ?')
      .run('2.0.0', 'kitty');
    store.database.prepare(`INSERT INTO pet_market_order_payment_snapshots
      (order_id, collection_account_id, payment_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(orderId(1), 'private-collection-sentinel', JSON.stringify({
        qrCodeDataUrl: 'private-qr-sentinel', rawNotification: 'private-notification-sentinel'
      }), NOW);
  }
  return { application, request, list: query => request(`${endpoint}${query || ''}`, { headers }) };
}

function activateBuyer(application, { code, platform = 'windows' } = {}) {
  const installationId = crypto.randomBytes(16).toString('hex');
  const credential = crypto.randomBytes(32).toString('base64url');
  code ||= application.activationStore.createCodes({ count: 1 }).codes[0];
  const license = application.activationStore.activate({ code, installationId, credential, platform });
  assert.ok(license);
  return { ...license, installationId, credential, code, platform,
    headers: { Authorization: `Bearer ${license.licenseId}.${credential}` } };
}

function enablePayments(application) {
  application.petMarketStore.savePaymentSettings({ enabled: true, method: 'personal_transfer',
    recipientName: 'isolated payee', recipientAccount: 'isolated-account', qrCodeDataUrl: '', instructions: '' });
  application.services.petMarketService.paymentHeartbeat({
    headers: { authorization: `Bearer ${BRIDGE_TOKEN}` }
  }, { accountId: COLLECTION_ACCOUNT, noticeReady: true, transferReady: true,
    noticePollSuccess: true, transferPollSuccess: true, pollLimitSaturated: false });
}

function publishOrderProduct(store, id = 'snapshot-pet') {
  store.createProduct({ id, title: '购买者快照桌宠', description: '', chargingMode: 'paid', priceFen: 280,
    status: 'published', isDefault: false, sortOrder: 0, previewMode: 'none', previewPaths: [] });
  store.database.prepare('UPDATE pet_market_products SET active_version = ? WHERE id = ?').run('1.0.0', id);
}

function createOrder(f, buyer, body = { productId: 'snapshot-pet' }) {
  return f.request('/api/pet-market/orders', { method: 'POST',
    headers: { ...buyer.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('admin order history requires an administrator session and disables caching', async context => {
  const f = await fixture(context);
  for (const headers of [{}, { Authorization: 'Bearer not-an-admin' }, { Cookie: 'deskpet_session=invalid' }]) {
    const response = await f.request(endpoint, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.body.orders, undefined);
  }
  const response = await f.list();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.serverTime, NOW);
  const serialized = JSON.stringify(response.body);
  for (const marker of ['private-collection-sentinel', 'private-event-sentinel', 'private-qr-sentinel',
    'private-notification-sentinel', 'credential', 'token']) assert.equal(serialized.includes(marker), false);
});

test('admin order history has stable pagination, expired status, and globally frozen revenue', async context => {
  const f = await fixture(context);
  const response = await f.list('?page=1&pageSize=2');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 7);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageSize, 2);
  assert.deepEqual(response.body.orders.map(order => order.id), [orderId(7), orderId(4)]);
  assert.equal(response.body.orders[0].productTitle, 'legacy-removed');
  assert.deepEqual(response.body.summary, {
    total: 7, pending: 2, paid: 2, canceled: 1, expired: 2, paidAmountFen: 860
  });
  const page2 = await f.list('?page=2&pageSize=2');
  assert.deepEqual(page2.body.orders.map(order => order.id), [orderId(3), orderId(2)]);
  const paid = await f.list('?status=paid');
  assert.equal(paid.body.total, 2);
  assert.equal(paid.body.pageSize, 25);
  assert.deepEqual(paid.body.summary, response.body.summary);
  const kitty = paid.body.orders.find(order => order.productId === 'kitty');
  assert.equal(kitty.amountFen, 280);
  assert.equal(kitty.productVersion, '1.0.0');
  assert.equal(kitty.productTitle, '云朵猫');
  assert.equal(kitty.accountId, 'account-amy');
  assert.equal(kitty.paidAt, NOW);
  assert.equal(kitty.canceledAt, null);
  assert.equal(kitty.paymentReference, '101AA');
  assert.equal(kitty.confirmationMethod, null);
  assert.equal(kitty.manualConfirmation, null);
  const expired = await f.list('?status=expired');
  assert.deepEqual(expired.body.orders.map(order => order.id), [orderId(6), orderId(5)]);
  const beyond = await f.list('?page=999&pageSize=100');
  assert.deepEqual(beyond.body.orders, []);
  assert.equal(beyond.body.total, 7);
});

test('legacy order confirmation labels use the recorded audit source without inventing manual details', async context => {
  const f = await fixture(context);
  const insert = f.application.petMarketStore.database.prepare(`
    INSERT INTO local_market_audit (action, entity_type, entity_id, order_id, payment_event_id, note, created_at)
    VALUES (?, 'payment_event', ?, ?, ?, '历史审核说明', ?)
  `);
  insert.run('admin_confirm', 'private-event-sentinel-1', orderId(1), 'private-event-sentinel-1', NOW);
  insert.run('auto_personal_transfer', 'private-event-sentinel-2', orderId(2), 'private-event-sentinel-2', NOW);
  const orders = (await f.list('?status=paid')).body.orders;
  assert.equal(orders.find(order => order.id === orderId(1)).confirmationMethod, 'manual');
  assert.equal(orders.find(order => order.id === orderId(2)).confirmationMethod, 'automatic');
  for (const order of orders) assert.equal(order.manualConfirmation, null);
});

test('admin order history filters before paging and searches literal references, products, and accounts', async context => {
  const f = await fixture(context);
  const cases = [
    ['101aa', [1]], ['云朵猫', [4, 3, 1]], ['KITTY', [4, 3, 1]],
    ['ACCOUNT-AMY', [4, 3, 1]], [orderId(2), [2]], ['Sunny Pup', [2, 6, 5]],
    ['%', []], ['_', []], ["' OR 1=1 --", []]
  ];
  for (const [q, ids] of cases) {
    const response = await f.list(`?q=${encodeURIComponent(q)}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.total, ids.length);
    assert.deepEqual(response.body.orders.map(order => order.id), ids.map(orderId), q);
  }
  const combined = await f.list('?q=kitty&status=paid&pageSize=1');
  assert.equal(combined.body.total, 1);
  assert.equal(combined.body.orders[0].id, orderId(1));
  const paged = await f.list('?q=kitty&page=2&pageSize=1');
  assert.equal(paged.body.total, 3);
  assert.equal(paged.body.orders[0].id, orderId(3));
});

test('admin order history validates pagination and search and returns zero summaries for empty stores', async context => {
  const f = await fixture(context, { seed: false });
  const response = await f.list();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.orders, []);
  assert.equal(response.body.total, 0);
  assert.deepEqual(response.body.summary, {
    total: 0, pending: 0, paid: 0, canceled: 0, expired: 0, paidAmountFen: 0
  });
  for (const query of ['status=unknown', 'page=0', 'page=-1', 'page=1.5', 'page=1e3',
    'pageSize=0', 'pageSize=101', 'pageSize=nope', 'page=9007199254740991&pageSize=100',
    `q=${'x'.repeat(101)}`, 'q=%00']) {
    const invalid = await f.list(`?${query}`);
    assert.equal(invalid.status, 400, query);
    assert.equal(invalid.body.code, 'INVALID_ORDER_QUERY', query);
  }
  assert.equal((await f.list('?pageSize=100')).status, 200);
});

test('new orders freeze verified device and profile identity, reject spoofing, and keep buyer data admin-only', async context => {
  const f = await fixture(context, { seed: false });
  const { application } = f;
  const buyer = activateBuyer(application);
  const secondDevice = activateBuyer(application, { code: buyer.code, platform: 'macos' });
  assert.equal(secondDevice.accountId, buyer.accountId);
  application.companionStore.updateProfile(buyer.accountId, '原始小王');
  publishOrderProduct(application.petMarketStore);
  enablePayments(application);

  for (const injected of [{ installationId: secondDevice.installationId }, { buyerDisplayName: '伪造昵称' },
    { accountId: 'another-account' }, { licenseId: secondDevice.licenseId }]) {
    const rejected = await createOrder(f, buyer, { productId: 'snapshot-pet', ...injected });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'INVALID_REQUEST');
  }
  assert.equal((await f.list()).body.total, 0);

  const created = await createOrder(f, buyer);
  assert.equal(created.status, 201);
  assert.equal(created.body.order.buyerInstallationId, undefined);
  const snapshotRow = application.petMarketStore.database.prepare(
    'SELECT * FROM pet_market_order_buyer_snapshots WHERE order_id = ?'
  ).get(created.body.order.id);
  assert.equal(snapshotRow.license_id, buyer.licenseId);
  assert.equal(snapshotRow.installation_id, buyer.installationId);
  assert.equal(snapshotRow.display_name, '原始小王');

  application.companionStore.updateProfile(buyer.accountId, '后来小王');
  const reused = await createOrder(f, secondDevice);
  assert.equal(reused.status, 200);
  assert.equal(reused.body.reused, true);
  assert.equal(reused.body.order.id, created.body.order.id);
  // The lower-level transaction also protects retries, even without the service fast path.
  const storeRetry = application.petMarketStore.createOrderWithPayment(buyer.accountId, 'snapshot-pet',
    application.petMarketStore.paymentSettings(), { licenseId: secondDevice.licenseId,
      installationId: secondDevice.installationId, platform: 'macos', displayName: '后来小王' });
  assert.equal(storeRetry.reused, true);
  const order = (await f.list()).body.orders[0];
  assert.equal(order.buyerDisplayName, '原始小王');
  assert.equal(order.buyerNameSource, 'order_snapshot');
  assert.equal(order.buyerInstallationId, buyer.installationId);
  assert.equal(order.buyerDeviceCode, buyer.installationId.slice(-12));
  assert.equal(order.buyerPlatform, 'windows');
  assert.equal(order.buyerDeviceSource, 'order_snapshot');
  assert.deepEqual(order.accountDevices, []);
  assert.equal((await f.list(`?q=${encodeURIComponent('原始小王')}`)).body.total, 1);
  assert.equal((await f.list(`?q=${buyer.installationId.slice(-12).toUpperCase()}`)).body.total, 1);
  assert.equal((await f.list(`?q=${encodeURIComponent('后来小王')}`)).body.total, 0);
  assert.equal((await f.list(`?q=${secondDevice.installationId}`)).body.total, 0);

  const denied = await f.request(endpoint, { headers: buyer.headers });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.orders, undefined);
  for (const url of ['/api/pet-market/orders', `/api/pet-market/orders/${order.id}`]) {
    const clientResult = await f.request(url, { headers: buyer.headers });
    assert.equal(clientResult.status, 200);
    const publicOrders = clientResult.body.orders || [clientResult.body.order];
    for (const publicOrder of publicOrders) {
      for (const key of ['buyerDisplayName', 'buyerNameSource', 'buyerInstallationId', 'buyerDeviceCode',
        'buyerPlatform', 'buyerDeviceSource', 'accountDevices', 'licenseId', 'credential',
        'manualConfirmation', 'confirmationMethod']) {
        assert.equal(publicOrder[key], undefined, key);
      }
    }
  }
  const serialized = JSON.stringify(order);
  for (const secret of [buyer.licenseId, buyer.credential, buyer.code, BRIDGE_TOKEN, COLLECTION_ACCOUNT]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('legacy orders show current profile and associated devices only as references and search before paging', async context => {
  const f = await fixture(context);
  const { application } = f;
  const buyer = activateBuyer(application);
  const secondDevice = activateBuyer(application, { code: buyer.code, platform: 'macos' });
  application.companionStore.updateProfile(buyer.accountId, '现在的昵称');
  application.petMarketStore.database.prepare("UPDATE local_market_orders SET account_id = ? WHERE account_id = 'account-amy'")
    .run(buyer.accountId);
  const page = await f.list(`?q=${encodeURIComponent('现在的昵称')}&page=2&pageSize=1`);
  assert.equal(page.body.total, 3);
  assert.equal(page.body.orders[0].id, orderId(3));
  const legacy = page.body.orders[0];
  assert.equal(legacy.buyerDisplayName, '现在的昵称');
  assert.equal(legacy.buyerNameSource, 'current_profile');
  assert.equal(legacy.buyerDeviceSource, 'unknown');
  assert.equal(legacy.buyerInstallationId, null);
  assert.equal(legacy.buyerDeviceCode, null);
  assert.equal(legacy.buyerPlatform, null);
  assert.deepEqual(legacy.accountDevices.map(device => device.installationId).sort(),
    [buyer.installationId, secondDevice.installationId].sort());
  for (const device of legacy.accountDevices) assert.equal(device.deviceCode, device.installationId.slice(-12));

  const byDevice = await f.list(`?q=${secondDevice.installationId.slice(-12).toUpperCase()}&status=paid&pageSize=1`);
  assert.equal(byDevice.body.total, 1);
  assert.equal(byDevice.body.orders[0].id, orderId(1));
  const unknown = (await f.list('?q=account-legacy')).body.orders[0];
  assert.equal(unknown.buyerDisplayName, null);
  assert.equal(unknown.buyerNameSource, 'unknown');
  assert.equal(unknown.buyerInstallationId, null);
  assert.deepEqual(unknown.accountDevices, []);

  // Retrying a historical pending order must not invent an original device or name.
  application.petMarketStore.database.prepare("UPDATE pet_market_products SET status = 'published' WHERE id = 'kitty'").run();
  const retry = await createOrder(f, secondDevice, { productId: 'kitty' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.order.id, orderId(4));
  assert.equal(application.petMarketStore.database.prepare(
    'SELECT COUNT(*) AS count FROM pet_market_order_buyer_snapshots'
  ).get().count, 0);
  application.companionStore.updateProfile(buyer.accountId, '参考新昵称');
  assert.equal((await f.list(`?q=${encodeURIComponent('现在的昵称')}`)).body.total, 0);
  const renamed = await f.list(`?q=${encodeURIComponent('参考新昵称')}`);
  assert.equal(renamed.body.total, 3);
  assert.equal(renamed.body.orders[0].buyerNameSource, 'current_profile');
  assert.equal(renamed.body.orders[0].buyerDeviceSource, 'unknown');
});

test('a new order without a profile preserves an empty name snapshot rather than a future nickname', async context => {
  const f = await fixture(context, { seed: false });
  const buyer = activateBuyer(f.application);
  publishOrderProduct(f.application.petMarketStore);
  enablePayments(f.application);
  assert.equal((await createOrder(f, buyer)).status, 201);
  assert.equal(f.application.companionStore.findDisplayName(buyer.accountId), null);
  f.application.companionStore.updateProfile(buyer.accountId, '后来设置的昵称');
  const order = (await f.list()).body.orders[0];
  assert.equal(order.buyerDisplayName, null);
  assert.equal(order.buyerNameSource, 'order_snapshot');
  assert.equal(order.buyerInstallationId, buyer.installationId);
  assert.equal(order.buyerDeviceSource, 'order_snapshot');
  assert.equal((await f.list(`?q=${encodeURIComponent('后来设置的昵称')}`)).body.total, 0);
});
