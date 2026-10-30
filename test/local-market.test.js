const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createLocalMarketApp,
  normalizeLocalMarketConfig,
  startLocalMarketServer
} = require('../scripts/local-market-server');

const TOKENS = Object.freeze({
  client: 'client-local-token-0000000000000001',
  bridge: 'bridge-local-token-000000000000001',
  admin: 'admin-local-token-0000000000000001'
});

function testConfig(dataDirectory, overrides = {}) {
  return {
    dataDirectory,
    clientToken: TOKENS.client,
    bridgeToken: TOKENS.bridge,
    adminToken: TOKENS.admin,
    collectionAccountId: 'wxlocal-test-collection-account',
    host: '127.0.0.1',
    port: 0,
    ...overrides
  };
}

async function fixture(context, { initialTime = '2026-10-28T10:00:00.000Z', randomInt, dataSubdirectory = '' } = {}) {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-local-market-'));
  const dataDirectory = path.join(temporaryDirectory, dataSubdirectory);
  let now = Date.parse(initialTime);
  const config = testConfig(dataDirectory);
  const application = await createLocalMarketApp({ config, now: () => now, randomInt });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    application.close();
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function request(url, { token, method = 'GET', body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return { response, status: response.status, body: await response.json() };
    }
    return {
      response,
      status: response.status,
      bytes: Buffer.from(await response.arrayBuffer())
    };
  }

  return {
    application,
    config,
    dataDirectory,
    request,
    setNow(value) { now = typeof value === 'number' ? value : Date.parse(value); },
    tick(milliseconds) { now += milliseconds; },
    now() { return now; }
  };
}

function auth(role) {
  return TOKENS[role];
}

function paymentPayload(f, order, overrides = {}) {
  return {
    eventKey: `local-event-${order.id}`,
    accountId: f.config.collectionAccountId,
    category: 'receipt',
    direction: 'incoming',
    status: 'completed',
    amountFen: 1,
    currency: 'CNY',
    reference: order.paymentReference.toLowerCase(),
    transactionId: `local-transaction-${order.id}`,
    occurredAt: new Date(f.now() + 60_000).toISOString(),
    observedAt: new Date(f.now() + 90_000).toISOString(),
    verified: false,
    ...overrides
  };
}

function personalTransferPayload(f, order, overrides = {}) {
  return paymentPayload(f, order, {
    category: 'personal_transfer',
    status: 'observed',
    transactionId: `wxlocal-transfer:${order.id}`,
    ...overrides
  });
}

function persistPersonalTransferCandidate(f, order, payload, receivedAt) {
  const normalized = {
    ...payload,
    eventKey: String(payload.eventKey).trim(),
    accountId: String(payload.accountId).trim(),
    category: 'personal_transfer',
    direction: String(payload.direction).trim().toLowerCase(),
    status: 'observed',
    reference: String(payload.reference).trim().toUpperCase(),
    currency: String(payload.currency).trim().toUpperCase(),
    occurredAt: new Date(payload.occurredAt).toISOString(),
    observedAt: new Date(payload.observedAt).toISOString(),
    transactionId: String(payload.transactionId).trim(),
    verified: false
  };
  const fingerprints = f.application.store.paymentFingerprints(normalized);
  const id = `persisted-${normalized.eventKey}`;
  f.application.store.database.prepare(`
    INSERT INTO local_market_payment_events
      (id, event_key, event_fingerprint, transaction_fingerprint,
       collection_account_id, category, direction, event_status, amount_fen,
       currency, payment_reference, transaction_id, occurred_at, observed_at,
       verified, review_status, review_reason, is_late, matched_order_id, received_at)
    VALUES (?, ?, ?, ?, ?, 'personal_transfer', ?, 'observed', ?, ?, ?, ?, ?, ?,
      0, 'candidate_review', 'personal_transfer_requires_review,source_unverified', 0, ?, ?)
  `).run(
    id,
    normalized.eventKey,
    fingerprints.event,
    fingerprints.transaction,
    normalized.accountId,
    normalized.direction,
    normalized.amountFen,
    normalized.currency,
    normalized.reference,
    normalized.transactionId,
    normalized.occurredAt,
    normalized.observedAt,
    order.id,
    receivedAt
  );
  return id;
}

test('local config refuses external listeners, external base URLs, shared tokens and relative stop files', () => {
  const dataDirectory = path.join(os.tmpdir(), 'deskpet-local-market-config');
  assert.throws(
    () => normalizeLocalMarketConfig(testConfig(dataDirectory, { host: '0.0.0.0' })),
    /只能绑定/
  );
  assert.throws(
    () => normalizeLocalMarketConfig(testConfig(dataDirectory, { baseUrl: 'https://example.com' })),
    /只允许/
  );
  assert.throws(
    () => normalizeLocalMarketConfig(testConfig(dataDirectory, { stopFile: 'relative.stop' })),
    /绝对路径/
  );
  assert.throws(
    () => normalizeLocalMarketConfig(testConfig(dataDirectory, { adminToken: TOKENS.client })),
    /互不相同/
  );
  const normalized = normalizeLocalMarketConfig(testConfig(dataDirectory, {
    stopFile: path.join(dataDirectory, 'stop.signal')
  }));
  assert.equal(normalized.host, '127.0.0.1');
  assert.equal(normalized.stopFile, path.resolve(dataDirectory, 'stop.signal'));
});

test('client token owns the fixed account and orders use authoritative expiry and non-reused codes', async (context) => {
  const values = [7, 0, 0, 7, 0, 0, 8, 1, 2, 9, 3, 4];
  const f = await fixture(context, {
    randomInt(max) {
      const value = values.shift();
      assert.ok(Number.isInteger(value) && value >= 0 && value < max);
      return value;
    }
  });
  assert.equal((await f.request('/health')).status, 200);
  assert.equal((await f.request('/api/local-market/catalog')).status, 401);
  assert.equal((await f.request('/api/local-market/catalog', { token: 'wrong-token-value-that-is-long' })).status, 403);
  const catalog = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.data.products[0].normalPriceOptionsFen, [280, 580]);
  assert.equal(catalog.body.data.products[0].testPriceFen, 1);
  assert.equal(catalog.body.data.currentOrder, null);

  const forged = await f.request('/api/local-market/orders', {
    token: auth('client'),
    method: 'POST',
    body: { productId: 'local-test-pet-pack', accountId: 'chosen-by-client' }
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'INVALID_REQUEST');

  const created = await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.order.paymentReference, '007AA');
  assert.match(created.body.data.order.paymentReference, /^[0-9]{3}[A-Z]{2}$/);
  assert.equal(created.body.data.order.amountFen, 1);
  assert.equal(created.body.data.serverTime, '2026-10-28T10:00:00.000Z');
  assert.equal(
    Date.parse(created.body.data.order.expiresAt) - Date.parse(created.body.data.order.createdAt),
    15 * 60 * 1000
  );
  const recoveredPending = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.deepEqual(recoveredPending.body.data.currentOrder, created.body.data.order);
  assert.equal(recoveredPending.body.data.serverTime, '2026-10-28T10:00:00.000Z');
  const reused = await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  });
  assert.equal(reused.status, 200);
  assert.equal(reused.body.data.reused, true);
  assert.equal(reused.body.data.order.id, created.body.data.order.id);

  const unavailable = await f.request('/api/local-market/products/local-test-pet-pack/download', {
    token: auth('client')
  });
  assert.equal(unavailable.status, 403);
  assert.equal(unavailable.body.error.code, 'ENTITLEMENT_REQUIRED');

  const canceled = await f.request(`/api/local-market/orders/${created.body.data.order.id}/cancel`, {
    token: auth('client'), method: 'POST'
  });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.data.order.status, 'canceled');
  const recoveredCanceled = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.equal(recoveredCanceled.body.data.currentOrder.id, created.body.data.order.id);
  assert.equal(recoveredCanceled.body.data.currentOrder.status, 'canceled');
  const second = await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.data.order.paymentReference, '008BC');
  assert.notEqual(second.body.data.order.paymentReference, created.body.data.order.paymentReference);
  const recoveredSecond = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.equal(recoveredSecond.body.data.currentOrder.id, second.body.data.order.id);
  assert.equal(recoveredSecond.body.data.currentOrder.status, 'pending_payment');

  f.tick(15 * 60 * 1000);
  const recoveredExpired = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.equal(recoveredExpired.body.data.currentOrder.id, second.body.data.order.id);
  assert.equal(recoveredExpired.body.data.currentOrder.status, 'expired');
  assert.equal(recoveredExpired.body.data.serverTime, '2026-10-28T10:15:00.000Z');
  const cannotCancel = await f.request(`/api/local-market/orders/${second.body.data.order.id}/cancel`, {
    token: auth('client'), method: 'POST'
  });
  assert.equal(cannotCancel.status, 409);
  assert.equal(cannotCancel.body.error.code, 'ORDER_NOT_PAYABLE');
});

test('catalog prioritizes a paid entitled order over a newer pending order', async (context) => {
  const f = await fixture(context);
  const paidOrder = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const candidate = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: paymentPayload(f, paidOrder)
  });
  assert.equal(candidate.status, 202);
  await f.request(`/api/local-market/orders/${paidOrder.id}/cancel`, {
    token: auth('client'), method: 'POST'
  });
  f.tick(1000);
  const pendingOrder = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  assert.notEqual(pendingOrder.id, paidOrder.id);

  const confirmed = await f.request(
    `/api/local-market/payment-events/${candidate.body.data.paymentEvent.id}/confirm`,
    {
      token: auth('admin'),
      method: 'POST',
      body: { note: '人工确认较早订单实际到账', orderId: paidOrder.id }
    }
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.order.status, 'paid');
  assert.equal(
    f.application.store.database.prepare('SELECT status FROM local_market_orders WHERE id = ?')
      .get(pendingOrder.id).status,
    'pending_payment'
  );

  const catalog = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.data.currentOrder.id, paidOrder.id);
  assert.equal(catalog.body.data.currentOrder.status, 'paid');
});

test('bridge events remain candidates until a matching audited admin confirmation grants entitlement', async (context) => {
  const f = await fixture(context);
  const created = await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  });
  const order = created.body.data.order;
  const payload = paymentPayload(f, order);

  assert.equal((await f.request('/api/local-market/payment-events', {
    token: auth('client'), method: 'POST', body: payload
  })).status, 403);
  const candidate = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: payload
  });
  assert.equal(candidate.status, 202);
  assert.equal(candidate.body.data.paymentEvent.reviewStatus, 'candidate_review');
  assert.match(candidate.body.data.paymentEvent.reviewReason, /source_unverified/);
  assert.equal(candidate.body.data.paymentEvent.reference, order.paymentReference);
  assert.match(candidate.body.data.paymentEvent.eventKey, /^sha256:/);
  assert.equal(JSON.stringify(candidate.body).includes(f.config.collectionAccountId), false);
  assert.equal(
    (await f.request(`/api/local-market/orders/${order.id}`, { token: auth('client') })).body.data.order.status,
    'pending_payment'
  );

  const duplicate = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: payload
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.data.duplicate, true);
  const conflict = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: { ...payload, amountFen: 2 }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const adminList = await f.request('/api/local-market/payment-events', { token: auth('admin') });
  assert.equal(adminList.status, 200);
  assert.equal(adminList.body.data.events.length, 1);
  assert.equal(adminList.body.data.events[0].id, candidate.body.data.paymentEvent.id);
  assert.equal((await f.request('/api/local-market/payment-events', { token: auth('client') })).status, 403);

  const wrongOrder = await f.request(
    `/api/local-market/payment-events/${candidate.body.data.paymentEvent.id}/confirm`,
    {
      token: auth('admin'),
      method: 'POST',
      body: { note: '本地人工核对0.01元到账', orderId: 'not-the-matched-order' }
    }
  );
  assert.equal(wrongOrder.status, 409);
  assert.equal(wrongOrder.body.error.code, 'PAYMENT_ORDER_MISMATCH');

  const confirmed = await f.request(
    `/api/local-market/payment-events/${candidate.body.data.paymentEvent.id}/confirm`,
    {
      token: auth('admin'),
      method: 'POST',
      body: { note: '本地人工核对0.01元到账', orderId: order.id }
    }
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.paymentEvent.reviewStatus, 'approved');
  assert.equal(confirmed.body.data.order.status, 'paid');
  assert.equal(confirmed.body.data.order.paidAt, payload.occurredAt);
  assert.equal(confirmed.body.data.entitlement.productId, 'local-test-pet-pack');
  assert.equal(confirmed.body.data.serverTime, '2026-10-28T10:00:00.000Z');
  const audit = f.application.store.listAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'admin_confirm');
  assert.equal(audit[0].note, '本地人工核对0.01元到账');

  const repeatedConfirm = await f.request(
    `/api/local-market/payment-events/${candidate.body.data.paymentEvent.id}/confirm`,
    {
      token: auth('admin'),
      method: 'POST',
      body: { note: '再次确认不会重复发放', orderId: order.id }
    }
  );
  assert.equal(repeatedConfirm.status, 200);
  assert.equal(repeatedConfirm.body.data.duplicate, true);
  assert.equal(f.application.store.listAudit().length, 1);

  const duplicateTransaction = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: { ...payload, eventKey: `${payload.eventKey}-retry`, observedAt: new Date(f.now() + 120_000).toISOString() }
  });
  assert.equal(duplicateTransaction.status, 200);
  assert.equal(duplicateTransaction.body.data.duplicate, true);
  const changedReceiptTime = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: {
      ...payload,
      eventKey: `${payload.eventKey}-different-receipt-time`,
      occurredAt: new Date(Date.parse(payload.occurredAt) + 1000).toISOString()
    }
  });
  assert.equal(changedReceiptTime.status, 409);
  assert.equal(changedReceiptTime.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const download = await f.request('/api/local-market/products/local-test-pet-pack/download', {
    token: auth('client')
  });
  assert.equal(download.status, 200);
  assert.match(download.response.headers.get('content-type'), /application\/zip/);
  assert.equal(download.bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(download.bytes.readUInt32LE(download.bytes.length - 22), 0x06054b50);
  assert.equal(download.bytes.includes(Buffer.from('no production pet assets')), true);
});

test('ambiguous bridge notifications with missing payment fields are retained for review and never approved', async (context) => {
  const f = await fixture(context);
  const order = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const observedAt = new Date(f.now()).toISOString();
  const unknown = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: {
      eventKey: 'ambiguous-notification-with-no-fields',
      accountId: f.config.collectionAccountId,
      category: 'other',
      direction: 'unknown',
      status: 'unknown',
      amountFen: null,
      currency: '',
      reference: '',
      transactionId: '',
      occurredAt: null,
      observedAt,
      verified: false
    }
  });
  assert.equal(unknown.status, 202);
  assert.equal(unknown.body.data.paymentEvent.amountFen, null);
  assert.equal(unknown.body.data.paymentEvent.occurredAt, null);
  for (const reason of [
    'reference_invalid', 'amount_missing', 'currency_missing', 'occurred_at_missing',
    'transaction_id_missing', 'category_not_receipt', 'direction_not_incoming',
    'status_not_completed'
  ]) assert.match(unknown.body.data.paymentEvent.reviewReason, new RegExp(reason));

  const missingForKnownOrder = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: {
      eventKey: 'known-order-notification-with-missing-fields',
      accountId: f.config.collectionAccountId,
      category: 'receipt',
      direction: 'incoming',
      status: 'completed',
      amountFen: null,
      currency: '',
      reference: order.paymentReference.toLowerCase(),
      transactionId: '',
      occurredAt: null,
      observedAt,
      verified: false
    }
  });
  assert.equal(missingForKnownOrder.status, 202);
  assert.equal(missingForKnownOrder.body.data.paymentEvent.orderId, order.id);
  const refused = await f.request(
    `/api/local-market/payment-events/${missingForKnownOrder.body.data.paymentEvent.id}/confirm`,
    {
      token: auth('admin'),
      method: 'POST',
      body: { note: '缺少关键字段，不能批准', orderId: order.id }
    }
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'PAYMENT_REVIEW_REQUIRED');
  assert.match(refused.body.error.message, /amount_missing/);
  assert.match(refused.body.error.message, /currency_missing/);
  assert.match(refused.body.error.message, /occurred_at_missing/);
  assert.match(refused.body.error.message, /transaction_id_missing/);
  assert.equal(
    (await f.request(`/api/local-market/orders/${order.id}`, { token: auth('client') })).body.data.order.status,
    'pending_payment'
  );
});

test('admin reparses a persisted candidate without changing source identity or granting entitlement', async (context) => {
  const referenceParts = [510, 15, 22];
  const f = await fixture(context, {
    randomInt(max) {
      const value = referenceParts.shift();
      assert.ok(Number.isInteger(value) && value >= 0 && value < max);
      return value;
    }
  });
  const order = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  assert.equal(order.paymentReference, '510PW');

  const original = paymentPayload(f, order, {
    eventKey: 'persisted-real-notice',
    category: 'other',
    direction: 'unknown',
    status: 'unknown',
    reference: ''
  });
  const captured = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: original
  });
  assert.equal(captured.status, 202);
  const eventId = captured.body.data.paymentEvent.id;
  assert.equal(captured.body.data.paymentEvent.orderId, null);
  assert.match(captured.body.data.paymentEvent.reviewReason, /reference_invalid/);
  f.tick(16 * 60 * 1000);
  assert.equal(
    f.application.store.database.prepare('SELECT status FROM local_market_orders WHERE id = ?').get(order.id).status,
    'pending_payment'
  );

  const corrected = {
    ...original,
    category: 'receipt',
    direction: 'incoming',
    status: 'completed',
    reference: '510pw'
  };
  assert.equal((await f.request(`/api/local-market/payment-events/${eventId}/reparse`, {
    token: auth('bridge'), method: 'POST', body: corrected
  })).status, 403);

  const identityVariants = [
    { eventKey: `${corrected.eventKey}-changed` },
    { accountId: `${corrected.accountId}-changed` },
    { amountFen: 2 },
    { currency: 'USD' },
    { transactionId: `${corrected.transactionId}-changed` },
    { occurredAt: new Date(Date.parse(corrected.occurredAt) + 1000).toISOString() },
    { observedAt: new Date(Date.parse(corrected.observedAt) + 1000).toISOString() },
    { verified: true }
  ];
  for (const changedIdentity of identityVariants) {
    const refused = await f.request(`/api/local-market/payment-events/${eventId}/reparse`, {
      token: auth('admin'),
      method: 'POST',
      body: { ...corrected, ...changedIdentity }
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'PAYMENT_SOURCE_IDENTITY_MISMATCH');
  }
  assert.equal(f.application.store.listAudit().length, 0);

  const reparsed = await f.request(`/api/local-market/payment-events/${eventId}/reparse`, {
    token: auth('admin'), method: 'POST', body: corrected
  });
  assert.equal(reparsed.status, 200);
  assert.equal(reparsed.body.data.duplicate, false);
  assert.equal(reparsed.body.data.paymentEvent.id, eventId);
  assert.equal(reparsed.body.data.paymentEvent.reference, '510PW');
  assert.equal(reparsed.body.data.paymentEvent.category, 'receipt');
  assert.equal(reparsed.body.data.paymentEvent.direction, 'incoming');
  assert.equal(reparsed.body.data.paymentEvent.status, 'completed');
  assert.equal(reparsed.body.data.paymentEvent.orderId, order.id);
  assert.equal(reparsed.body.data.paymentEvent.reviewStatus, 'candidate_review');
  assert.equal(reparsed.body.data.paymentEvent.reviewReason, 'source_unverified');

  assert.equal(
    f.application.store.database.prepare('SELECT status FROM local_market_orders WHERE id = ?').get(order.id).status,
    'pending_payment'
  );
  assert.equal((await f.request('/api/local-market/products/local-test-pet-pack/download', {
    token: auth('client')
  })).status, 403);

  const audit = f.application.store.listAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'admin_reparse');
  assert.equal(audit[0].payment_event_id, eventId);
  assert.equal(audit[0].order_id, order.id);
  const details = JSON.parse(audit[0].details_json);
  assert.deepEqual(
    {
      category: details.before.category,
      direction: details.before.direction,
      status: details.before.status,
      reference: details.before.reference,
      matchedOrderId: details.before.matchedOrderId
    },
    { category: 'other', direction: 'unknown', status: 'unknown', reference: '', matchedOrderId: null }
  );
  assert.deepEqual(
    {
      category: details.after.category,
      direction: details.after.direction,
      status: details.after.status,
      reference: details.after.reference,
      matchedOrderId: details.after.matchedOrderId
    },
    {
      category: 'receipt', direction: 'incoming', status: 'completed',
      reference: '510PW', matchedOrderId: order.id
    }
  );

  const repeated = await f.request(`/api/local-market/payment-events/${eventId}/reparse`, {
    token: auth('admin'), method: 'POST', body: corrected
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.data.duplicate, true);
  assert.equal(f.application.store.listAudit().length, 1);

  const correctedEventRetry = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: corrected
  });
  assert.equal(correctedEventRetry.status, 200);
  assert.equal(correctedEventRetry.body.data.duplicate, true);
  assert.equal(correctedEventRetry.body.data.paymentEvent.id, eventId);
  const correctedTransactionRetry = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: { ...corrected, eventKey: 'same-transaction-after-reparse' }
  });
  assert.equal(correctedTransactionRetry.status, 200);
  assert.equal(correctedTransactionRetry.body.data.duplicate, true);
  assert.equal(correctedTransactionRetry.body.data.paymentEvent.id, eventId);

  const confirmed = await f.request(`/api/local-market/payment-events/${eventId}/confirm`, {
    token: auth('admin'),
    method: 'POST',
    body: { note: '重新解析后人工确认真实0.01元到账', orderId: order.id }
  });
  assert.equal(confirmed.status, 200);
  const approvedReparse = await f.request(`/api/local-market/payment-events/${eventId}/reparse`, {
    token: auth('admin'), method: 'POST', body: corrected
  });
  assert.equal(approvedReparse.status, 409);
  assert.equal(approvedReparse.body.error.code, 'PAYMENT_EVENT_NOT_REPARSABLE');
});

test('strict personal transfer auto-approves while preserving unverified source semantics', async (context) => {
  const f = await fixture(context);
  const order = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const payload = personalTransferPayload(f, order, {
    eventKey: 'real-transfer-observed-before-message-time',
    transactionId: 'wxlocal-transfer:real-first',
    observedAt: '2026-10-28T10:01:13.966Z',
    occurredAt: '2026-10-28T10:01:17.000Z'
  });
  f.tick(2 * 60 * 1000);
  const autoApprovedAt = new Date(f.now()).toISOString();
  const approved = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: payload
  });
  assert.equal(approved.status, 202);
  assert.equal(approved.body.data.autoApproved, true);
  assert.equal(approved.body.data.duplicate, false);
  assert.equal(approved.body.data.paymentEvent.category, 'personal_transfer');
  assert.equal(approved.body.data.paymentEvent.status, 'observed');
  assert.equal(approved.body.data.paymentEvent.verified, false);
  assert.equal(approved.body.data.paymentEvent.reviewStatus, 'approved');
  assert.match(approved.body.data.paymentEvent.reviewReason, /auto_personal_transfer_policy/);
  assert.match(approved.body.data.paymentEvent.reviewReason, /source_unverified/);
  assert.doesNotMatch(approved.body.data.paymentEvent.reviewReason, /manual_confirmation/);
  assert.equal(approved.body.data.paymentEvent.approvedAt, autoApprovedAt);
  assert.equal(approved.body.data.order.status, 'paid');
  assert.equal(approved.body.data.order.paidAt, autoApprovedAt);
  assert.notEqual(approved.body.data.order.paidAt, payload.occurredAt);
  assert.equal(approved.body.data.entitlement.grantedAt, autoApprovedAt);

  const catalog = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.equal(catalog.body.data.currentOrder.id, order.id);
  assert.equal(catalog.body.data.currentOrder.status, 'paid');
  const download = await f.request('/api/local-market/products/local-test-pet-pack/download', {
    token: auth('client')
  });
  assert.equal(download.status, 200);
  assert.equal(download.bytes.readUInt32LE(0), 0x04034b50);

  const audits = f.application.store.listAudit();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'auto_personal_transfer');
  assert.equal(audits[0].created_at, autoApprovedAt);
  const auditDetails = JSON.parse(audits[0].details_json);
  assert.equal(auditDetails.policy, 'strict_personal_transfer_match');
  assert.equal(auditDetails.verified, false);
  assert.equal(auditDetails.eventStatus, 'observed');
  assert.equal(auditDetails.occurredAt, payload.occurredAt);
  assert.equal(auditDetails.receivedAt, autoApprovedAt);
  assert.equal(Object.hasOwn(auditDetails, 'transferReceived'), false);
  assert.equal(audits.some((entry) => entry.action === 'admin_confirm'), false);

  const exactRetry = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: payload
  });
  assert.equal(exactRetry.status, 200);
  assert.equal(exactRetry.body.data.duplicate, true);
  assert.equal(exactRetry.body.data.autoApproved, false);
  assert.equal(exactRetry.body.data.paymentEvent.id, approved.body.data.paymentEvent.id);
  const lifecycleRetry = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: {
      ...payload,
      eventKey: 'real-transfer-second-lifecycle',
      occurredAt: '2026-10-28T10:01:47.000Z',
      observedAt: '2026-10-28T10:01:43.966Z'
    }
  });
  assert.equal(lifecycleRetry.status, 200);
  assert.equal(lifecycleRetry.body.data.duplicate, true);
  assert.equal(lifecycleRetry.body.data.paymentEvent.id, approved.body.data.paymentEvent.id);

  for (const conflicting of [
    { eventKey: 'real-transfer-conflicting-amount', amountFen: 2 },
    { eventKey: 'real-transfer-conflicting-reference', reference: '999ZZ' }
  ]) {
    const conflict = await f.request('/api/local-market/payment-events', {
      token: auth('bridge'), method: 'POST', body: { ...payload, ...conflicting }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  }

  const secondTransfer = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: personalTransferPayload(f, order, {
      eventKey: 'real-transfer-distinct-second-payment',
      transactionId: 'wxlocal-transfer:real-second'
    })
  });
  assert.equal(secondTransfer.status, 202);
  assert.equal(secondTransfer.body.data.autoApproved, false);
  assert.equal(secondTransfer.body.data.paymentEvent.reviewStatus, 'candidate_review');
  assert.match(secondTransfer.body.data.paymentEvent.reviewReason, /order_paid_by_other_event/);
  assert.equal(
    f.application.store.database.prepare('SELECT payment_event_id FROM local_market_orders WHERE id = ?')
      .get(order.id).payment_event_id,
    approved.body.data.paymentEvent.id
  );
  assert.equal(
    f.application.store.database.prepare('SELECT COUNT(*) AS count FROM local_market_entitlements').get().count,
    1
  );
  assert.equal(f.application.store.listAudit().length, 1);
});

test('entitled ZIP download works under a dot-prefixed local state directory', async (context) => {
  const f = await fixture(context, {
    dataSubdirectory: path.join('.local-review', 'local-market-transfer', 'server')
  });
  const url = '/api/local-market/products/local-test-pet-pack/download';
  assert.equal((await f.request(url)).status, 401);
  assert.equal((await f.request(url, { token: auth('client') })).status, 403);
  const order = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const payload = personalTransferPayload(f, order);
  f.tick(2 * 60 * 1000);
  const approved = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: payload
  });
  assert.equal(approved.body.data.autoApproved, true);
  const download = await f.request(url, { token: auth('client') });
  assert.equal(download.status, 200);
  assert.match(download.response.headers.get('content-type'), /application\/zip/);
  assert.match(download.response.headers.get('content-disposition'), /attachment/);
  assert.equal(download.response.headers.get('cache-control'), 'no-store');
  assert.equal(download.response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(download.bytes, await fs.promises.readFile(f.application.store.fixturePath));
  assert.equal(download.bytes.readUInt32LE(0), 0x04034b50);
});

test('personal transfer auto-approval rejects mismatches, canceled orders and late first receipt', async (context) => {
  const f = await fixture(context);
  const order = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const invalidCandidates = [
    { eventKey: 'personal-bad-amount', transactionId: 'personal-bad-amount', amountFen: 2 },
    { eventKey: 'personal-bad-currency', transactionId: 'personal-bad-currency', currency: 'USD' },
    { eventKey: 'personal-bad-account', transactionId: 'personal-bad-account', accountId: 'wrong-account' },
    { eventKey: 'personal-empty-transaction', transactionId: '' },
    { eventKey: 'personal-missing-occurred', transactionId: 'personal-missing-occurred', occurredAt: null },
    {
      eventKey: 'personal-occurred-before-order',
      transactionId: 'personal-occurred-before-order',
      occurredAt: '2026-10-28T09:59:59.000Z'
    },
    {
      eventKey: 'personal-observed-after-expiry',
      transactionId: 'personal-observed-after-expiry',
      observedAt: '2026-10-28T10:15:01.000Z'
    }
  ];
  for (const overrides of invalidCandidates) {
    const retained = await f.request('/api/local-market/payment-events', {
      token: auth('bridge'),
      method: 'POST',
      body: personalTransferPayload(f, order, overrides)
    });
    assert.equal(retained.status, 202);
    assert.equal(retained.body.data.autoApproved, false);
    assert.equal(retained.body.data.paymentEvent.reviewStatus, 'candidate_review');
  }
  assert.equal(
    (await f.request(`/api/local-market/orders/${order.id}`, { token: auth('client') })).body.data.order.status,
    'pending_payment'
  );

  await f.request(`/api/local-market/orders/${order.id}/cancel`, {
    token: auth('client'), method: 'POST'
  });
  const canceled = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: personalTransferPayload(f, order, {
      eventKey: 'personal-canceled-order',
      transactionId: 'personal-canceled-order'
    })
  });
  assert.equal(canceled.body.data.autoApproved, false);
  assert.equal(canceled.body.data.paymentEvent.reviewStatus, 'candidate_review');
  assert.match(canceled.body.data.paymentEvent.reviewReason, /order_canceled/);

  const lateOrder = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const latePayload = personalTransferPayload(f, lateOrder, {
    eventKey: 'personal-first-received-after-expiry',
    transactionId: 'personal-first-received-after-expiry',
    occurredAt: '2026-10-28T10:05:00.000Z',
    observedAt: '2026-10-28T10:06:00.000Z'
  });
  f.tick(16 * 60 * 1000);
  const late = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: latePayload
  });
  assert.equal(late.status, 202);
  assert.equal(late.body.data.autoApproved, false);
  assert.equal(late.body.data.paymentEvent.reviewStatus, 'candidate_review');
  assert.match(late.body.data.paymentEvent.reviewReason, /order_expired/);
  assert.match(late.body.data.paymentEvent.reviewReason, /notification_after_expiry/);
  assert.equal(
    (await f.request(`/api/local-market/orders/${lateOrder.id}`, { token: auth('client') })).body.data.order.status,
    'expired'
  );
  assert.equal(
    f.application.store.database.prepare('SELECT COUNT(*) AS count FROM local_market_entitlements').get().count,
    0
  );
  assert.equal(f.application.store.listAudit().length, 0);
});

test('exact replay recovers one expired persisted transfer without approving sibling candidates', async (context) => {
  const f = await fixture(context);
  const order = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const firstPayload = personalTransferPayload(f, order, {
    eventKey: 'persisted-real-transfer-one',
    transactionId: 'persisted-real-transfer-one',
    observedAt: '2026-10-28T10:05:13.966Z',
    occurredAt: '2026-10-28T10:05:17.000Z'
  });
  const secondPayload = personalTransferPayload(f, order, {
    eventKey: 'persisted-real-transfer-two',
    transactionId: 'persisted-real-transfer-two',
    observedAt: '2026-10-28T10:09:40.000Z',
    occurredAt: '2026-10-28T10:09:41.000Z'
  });
  const firstId = persistPersonalTransferCandidate(
    f, order, firstPayload, '2026-10-28T10:10:00.000Z'
  );
  const secondId = persistPersonalTransferCandidate(
    f, order, secondPayload, '2026-10-28T10:11:00.000Z'
  );
  const originalExpiresAt = order.expiresAt;
  f.tick(16 * 60 * 1000);
  const expired = await f.request('/api/local-market/catalog', { token: auth('client') });
  assert.equal(expired.body.data.currentOrder.status, 'expired');
  assert.equal(
    f.application.store.database.prepare('SELECT review_status FROM local_market_payment_events WHERE id = ?')
      .get(secondId).review_status,
    'candidate_review'
  );

  const nonExactLifecycle = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: {
      ...firstPayload,
      eventKey: 'persisted-real-transfer-one-later-lifecycle',
      occurredAt: '2026-10-28T10:05:18.000Z'
    }
  });
  assert.equal(nonExactLifecycle.status, 200);
  assert.equal(nonExactLifecycle.body.data.duplicate, true);
  assert.equal(nonExactLifecycle.body.data.autoApproved, false);
  assert.equal(nonExactLifecycle.body.data.paymentEvent.id, firstId);
  assert.equal(f.application.store.listAudit().length, 0);

  const recoveredAt = new Date(f.now()).toISOString();
  const recovered = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: firstPayload
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.duplicate, true);
  assert.equal(recovered.body.data.autoApproved, true);
  assert.equal(recovered.body.data.paymentEvent.id, firstId);
  assert.equal(recovered.body.data.paymentEvent.reviewStatus, 'approved');
  assert.equal(recovered.body.data.order.status, 'paid');
  assert.equal(recovered.body.data.order.expiresAt, originalExpiresAt);
  assert.equal(recovered.body.data.order.paidAt, recoveredAt);
  assert.equal(recovered.body.data.entitlement.grantedAt, recoveredAt);
  const recoveredAudit = f.application.store.listAudit();
  assert.equal(recoveredAudit.length, 1);
  assert.equal(recoveredAudit[0].action, 'auto_personal_transfer');
  const recoveredDetails = JSON.parse(recoveredAudit[0].details_json);
  assert.equal(recoveredDetails.recoveredExpiredCandidate, true);
  assert.equal(recoveredDetails.receivedAt, '2026-10-28T10:10:00.000Z');

  assert.equal(
    f.application.store.database.prepare('SELECT review_status FROM local_market_payment_events WHERE id = ?')
      .get(secondId).review_status,
    'candidate_review'
  );
  const siblingReplay = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'), method: 'POST', body: secondPayload
  });
  assert.equal(siblingReplay.status, 200);
  assert.equal(siblingReplay.body.data.autoApproved, false);
  assert.equal(siblingReplay.body.data.paymentEvent.id, secondId);
  assert.equal(siblingReplay.body.data.paymentEvent.reviewStatus, 'candidate_review');
  assert.match(siblingReplay.body.data.paymentEvent.reviewReason, /order_paid_by_other_event/);
  assert.equal(
    f.application.store.database.prepare('SELECT COUNT(*) AS count FROM local_market_entitlements').get().count,
    1
  );
  assert.equal(f.application.store.listAudit().length, 1);
});

test('strict matching blocks bad candidates while explicit admin review may approve a late payment', async (context) => {
  const f = await fixture(context);
  const first = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  const bad = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: paymentPayload(f, first, {
      eventKey: 'bad-amount-event',
      amountFen: 2,
      transactionId: 'bad-amount-transaction'
    })
  });
  assert.match(bad.body.data.paymentEvent.reviewReason, /amount_mismatch/);
  const rejected = await f.request(`/api/local-market/payment-events/${bad.body.data.paymentEvent.id}/confirm`, {
    token: auth('admin'),
    method: 'POST',
    body: { note: '金额不符，不应批准', orderId: first.id }
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'PAYMENT_REVIEW_REQUIRED');

  await f.request(`/api/local-market/orders/${first.id}/cancel`, {
    token: auth('client'), method: 'POST'
  });
  const lateOrder = (await f.request('/api/local-market/orders', {
    token: auth('client'), method: 'POST', body: { productId: 'local-test-pet-pack' }
  })).body.data.order;
  f.tick(16 * 60 * 1000);
  const late = await f.request('/api/local-market/payment-events', {
    token: auth('bridge'),
    method: 'POST',
    body: paymentPayload(f, lateOrder, {
      eventKey: 'late-payment-event',
      transactionId: 'late-payment-transaction',
      occurredAt: new Date(f.now()).toISOString(),
      observedAt: new Date(f.now() + 10_000).toISOString(),
      verified: true
    })
  });
  assert.equal(late.status, 202);
  assert.equal(late.body.data.paymentEvent.late, true);
  assert.match(late.body.data.paymentEvent.reviewReason, /payment_after_expiry/);
  assert.equal(
    (await f.request(`/api/local-market/orders/${lateOrder.id}`, { token: auth('client') })).body.data.order.status,
    'expired'
  );

  const approved = await f.request(`/api/local-market/payment-events/${late.body.data.paymentEvent.id}/confirm`, {
    token: auth('admin'),
    method: 'POST',
    body: { note: '本地人工确认逾期0.01元真实到账', orderId: lateOrder.id }
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.order.status, 'paid');
  assert.equal(approved.body.data.paymentEvent.late, true);
  const auditDetails = JSON.parse(f.application.store.listAudit()[0].details_json);
  assert.equal(auditDetails.late, true);
});

test('standalone launcher reads an absolute config and closes cleanly when its stop file appears', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-local-market-launcher-'));
  const stopFile = path.join(directory, 'stop.signal');
  const configPath = path.join(directory, 'local-market.json');
  await fs.promises.writeFile(configPath, JSON.stringify(testConfig(
    path.join(directory, 'runtime'),
    { stopFile }
  )), { mode: 0o600 });
  const running = await startLocalMarketServer(configPath, {
    installSignalHandlers: false,
    log: false,
    stopPollMs: 20
  });
  context.after(async () => {
    await running.shutdown();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const health = await fetch(`${running.baseUrl}/health`);
  assert.equal(health.status, 200);
  await health.text();
  await fs.promises.writeFile(stopFile, 'stop', { mode: 0o600 });
  await Promise.race([
    running.closed,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('stop file timeout')), 2000))
  ]);
  assert.equal(running.server.listening, false);
});
