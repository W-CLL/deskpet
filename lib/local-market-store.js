const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openMigratedDatabase } = require('./sqlite-migrations');

const LOCAL_TEST_ACCOUNT_ID = 'local-test-account';
const ORDER_TTL_MS = 15 * 60 * 1000;
const PAYMENT_REFERENCE_PATTERN = /^[0-9]{3}[A-Z]{2}$/;
const PERSONAL_TRANSFER_CATEGORY = 'personal_transfer';
const MARKET_MIGRATION_SCOPE = 'local-market';

const LOCAL_TEST_PRODUCT = Object.freeze({
  id: 'local-test-pet-pack',
  title: '本地支付测试角色包',
  assetCount: 25,
  testPriceFen: 1,
  normalPriceOptionsFen: Object.freeze([280, 580]),
  currency: 'CNY',
  localOnly: true,
  downloadFileName: 'local-test-pet-pack.zip'
});

const MARKET_MIGRATIONS = [
  {
    version: 1,
    name: 'local-market-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE local_market_orders (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
          currency TEXT NOT NULL,
          collection_account_id TEXT NOT NULL,
          payment_reference TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL
            CHECK (status IN ('pending_payment', 'expired', 'canceled', 'paid')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          canceled_at TEXT,
          paid_at TEXT,
          payment_event_id TEXT UNIQUE,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_local_market_orders_account_product
          ON local_market_orders(account_id, product_id, created_at DESC);
        CREATE INDEX idx_local_market_orders_pending_expiry
          ON local_market_orders(status, expires_at);

        CREATE TABLE local_market_payment_events (
          id TEXT PRIMARY KEY,
          event_key TEXT NOT NULL UNIQUE,
          event_fingerprint TEXT NOT NULL,
          transaction_fingerprint TEXT NOT NULL,
          collection_account_id TEXT NOT NULL,
          category TEXT NOT NULL,
          direction TEXT NOT NULL,
          event_status TEXT NOT NULL,
          amount_fen INTEGER,
          currency TEXT NOT NULL,
          payment_reference TEXT NOT NULL,
          transaction_id TEXT NOT NULL DEFAULT '',
          occurred_at TEXT,
          observed_at TEXT NOT NULL,
          verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
          review_status TEXT NOT NULL
            CHECK (review_status IN ('candidate_review', 'approved')),
          review_reason TEXT NOT NULL,
          is_late INTEGER NOT NULL CHECK (is_late IN (0, 1)),
          matched_order_id TEXT,
          received_at TEXT NOT NULL,
          approved_at TEXT,
          approved_order_id TEXT,
          admin_note TEXT,
          FOREIGN KEY (matched_order_id) REFERENCES local_market_orders(id),
          FOREIGN KEY (approved_order_id) REFERENCES local_market_orders(id)
        );
        CREATE UNIQUE INDEX idx_local_market_payment_transaction
          ON local_market_payment_events(transaction_id)
          WHERE transaction_id <> '';
        CREATE INDEX idx_local_market_payment_review
          ON local_market_payment_events(review_status, received_at DESC);

        CREATE TABLE local_market_entitlements (
          account_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          order_id TEXT NOT NULL UNIQUE,
          payment_event_id TEXT NOT NULL UNIQUE,
          granted_at TEXT NOT NULL,
          PRIMARY KEY (account_id, product_id),
          FOREIGN KEY (order_id) REFERENCES local_market_orders(id),
          FOREIGN KEY (payment_event_id) REFERENCES local_market_payment_events(id)
        );

        CREATE TABLE local_market_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          order_id TEXT,
          payment_event_id TEXT,
          note TEXT NOT NULL DEFAULT '',
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_local_market_audit_created
          ON local_market_audit(created_at DESC, id DESC);
      `);
    }
  },
  {
    version: 2,
    name: 'local-market-order-product-version',
    up(database) {
      const columns = database.prepare('PRAGMA table_info(local_market_orders)').all();
      if (!columns.some((column) => column.name === 'product_version')) {
        database.exec("ALTER TABLE local_market_orders ADD COLUMN product_version TEXT NOT NULL DEFAULT ''");
      }
    }
  },
  {
    version: 3,
    name: 'local-market-manual-order-confirmations',
    up(database) {
      database.exec(`
        CREATE TABLE local_market_manual_confirmations (
          order_id TEXT PRIMARY KEY,
          note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 600),
          confirmed_at TEXT NOT NULL,
          confirmed_by TEXT NOT NULL CHECK (length(confirmed_by) BETWEEN 1 AND 80),
          previous_status TEXT NOT NULL
            CHECK (previous_status IN ('pending_payment', 'expired', 'canceled')),
          expected_amount_fen INTEGER NOT NULL CHECK (expected_amount_fen > 0),
          FOREIGN KEY (order_id) REFERENCES local_market_orders(id)
        );

        -- Manual checks are separate evidence, never synthetic WeChat payment events.
        CREATE TABLE local_market_entitlements_next (
          account_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          order_id TEXT NOT NULL UNIQUE,
          payment_event_id TEXT UNIQUE,
          manual_confirmation_order_id TEXT UNIQUE,
          granted_at TEXT NOT NULL,
          PRIMARY KEY (account_id, product_id),
          FOREIGN KEY (order_id) REFERENCES local_market_orders(id),
          FOREIGN KEY (payment_event_id) REFERENCES local_market_payment_events(id),
          FOREIGN KEY (manual_confirmation_order_id) REFERENCES local_market_manual_confirmations(order_id),
          CHECK ((payment_event_id IS NOT NULL) + (manual_confirmation_order_id IS NOT NULL) = 1),
          CHECK (manual_confirmation_order_id IS NULL OR manual_confirmation_order_id = order_id)
        );
        INSERT INTO local_market_entitlements_next
          (account_id, product_id, order_id, payment_event_id, granted_at)
          SELECT account_id, product_id, order_id, payment_event_id, granted_at
          FROM local_market_entitlements;
        DROP TABLE local_market_entitlements;
        ALTER TABLE local_market_entitlements_next RENAME TO local_market_entitlements;
        CREATE UNIQUE INDEX idx_local_market_manual_order_audit
          ON local_market_audit(order_id) WHERE action = 'admin_confirm_order';
      `);
    }
  }
];

class LocalMarketError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LocalMarketError';
    this.code = code;
    this.status = status;
  }
}

function isoFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new LocalMarketError('INVALID_REQUEST', '时间格式无效');
  }
  return date.toISOString();
}

function nullableIsoFrom(value) {
  return value === null || value === undefined || value === '' ? null : isoFrom(value);
}

function canonicalReference(value) {
  return String(value || '').trim().toUpperCase();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function normalizePaymentPayload(input) {
  return {
    ...input,
    eventKey: String(input.eventKey).trim(),
    accountId: String(input.accountId).trim(),
    category: String(input.category).trim().toLowerCase(),
    direction: String(input.direction).trim().toLowerCase(),
    status: String(input.status).trim().toLowerCase(),
    reference: canonicalReference(input.reference),
    currency: String(input.currency).trim().toUpperCase(),
    occurredAt: nullableIsoFrom(input.occurredAt),
    observedAt: isoFrom(input.observedAt),
    transactionId: String(input.transactionId || '').trim()
  };
}

function maskedSuffix(value) {
  const text = String(value || '');
  if (!text) return '';
  return `***${text.slice(-4)}`;
}

function publicEventKey(value) {
  return `sha256:${sha256(String(value)).slice(0, 16)}`;
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_id,
    productVersion: row.product_version || '',
    status: row.status,
    amountFen: row.amount_fen === null ? null : Number(row.amount_fen),
    currency: row.currency,
    paymentReference: row.payment_reference,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at || null,
    canceledAt: row.canceled_at || null
  };
}

function mapPaymentEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventKey: publicEventKey(row.event_key),
    accountIdSuffix: maskedSuffix(row.collection_account_id),
    category: row.category,
    direction: row.direction,
    status: row.event_status,
    amountFen: row.amount_fen === null ? null : Number(row.amount_fen),
    currency: row.currency,
    reference: row.payment_reference,
    transactionIdSuffix: maskedSuffix(row.transaction_id),
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    verified: row.verified === 1,
    reviewStatus: row.review_status,
    reviewReason: row.review_reason,
    late: row.is_late === 1,
    receivedAt: row.received_at,
    approvedAt: row.approved_at || null,
    orderId: row.approved_order_id || row.matched_order_id || null
  };
}

function mapEntitlement(row) {
  if (!row) return null;
  return {
    productId: row.product_id,
    productVersion: row.product_version || '',
    orderId: row.order_id,
    grantedAt: row.granted_at
  };
}

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

function createStoredZip(fileName, content) {
  const name = Buffer.from(fileName, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + data.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([local, name, data, central, name, end]);
}

class LocalMarketStore {
  constructor(dataDirectory, {
    collectionAccountId,
    now = () => Date.now(),
    randomInt = crypto.randomInt,
    databaseFile = 'local-market.db',
    migrationScope = MARKET_MIGRATION_SCOPE,
    productLookup = null,
    productCatalog = null,
    downloadResolver = null,
    createFixture = true
  } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.collectionAccountId = collectionAccountId;
    this.now = now;
    this.randomInt = randomInt;
    this.databaseFile = databaseFile;
    this.migrationScope = migrationScope;
    this.productLookup = productLookup;
    this.productCatalog = productCatalog;
    this.downloadResolver = downloadResolver;
    this.createFixture = createFixture;
    this.database = null;
    this.migrationState = null;
    this.databasePath = path.join(this.dataDirectory, this.databaseFile);
    this.fixtureDirectory = path.join(this.dataDirectory, 'fixtures');
    this.fixturePath = path.join(this.fixtureDirectory, LOCAL_TEST_PRODUCT.downloadFileName);
  }

  async initialize() {
    const opened = await openMigratedDatabase({
      dataDirectory: this.dataDirectory,
      fileName: this.databaseFile,
      scope: this.migrationScope,
      migrations: MARKET_MIGRATIONS,
      foreignKeys: true,
      extraDirectories: this.createFixture ? [this.fixtureDirectory] : []
    });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.migrationState = opened.migrationState;
    if (this.createFixture) {
      await fs.promises.writeFile(
        this.fixturePath,
        createStoredZip(
          'README.txt',
          'DeskPet local payment test fixture. This archive contains no production pet assets.\n'
        ),
        { mode: 0o600 }
      );
    }
  }

  serverTime() {
    return isoFrom(this.now());
  }

  catalog() {
    if (this.productCatalog) return this.productCatalog();
    return [{
      ...LOCAL_TEST_PRODUCT,
      normalPriceOptionsFen: [...LOCAL_TEST_PRODUCT.normalPriceOptionsFen]
    }];
  }

  catalogFor(accountId) {
    const serverTime = this.serverTime();
    this.expireOrders(serverTime);
    const currentOrder = this.database.prepare(`
      SELECT orders.*
      FROM local_market_orders AS orders
      LEFT JOIN local_market_entitlements AS entitlements
        ON entitlements.order_id = orders.id
      WHERE orders.account_id = ? AND orders.product_id = ?
      ORDER BY
        CASE
          WHEN entitlements.order_id IS NOT NULL OR orders.status = 'paid' THEN 0
          WHEN orders.status = 'pending_payment' THEN 1
          ELSE 2
        END,
        orders.created_at DESC,
        orders.rowid DESC
      LIMIT 1
    `).get(accountId, LOCAL_TEST_PRODUCT.id);
    return {
      products: this.catalog(),
      currentOrder: mapOrder(currentOrder),
      serverTime
    };
  }

  product(productId) {
    if (this.productLookup) return this.productLookup(productId);
    return productId === LOCAL_TEST_PRODUCT.id ? LOCAL_TEST_PRODUCT : null;
  }

  expireOrders(serverTime = this.serverTime()) {
    this.database.prepare(`
      UPDATE local_market_orders
      SET status = 'expired', updated_at = ?
      WHERE status = 'pending_payment' AND expires_at <= ?
    `).run(serverTime, serverTime);
  }

  generateReference() {
    for (let attempt = 0; attempt < 4096; attempt += 1) {
      const digits = String(this.randomInt(1000)).padStart(3, '0');
      const letters = String.fromCharCode(65 + this.randomInt(26), 65 + this.randomInt(26));
      const reference = `${digits}${letters}`;
      const exists = this.database.prepare(`
        SELECT 1 FROM local_market_orders WHERE payment_reference = ?
      `).get(reference);
      if (!exists) return reference;
    }
    throw new LocalMarketError(
      'REFERENCE_SPACE_UNAVAILABLE',
      '暂时无法分配新的付款备注码，请稍后重试',
      503
    );
  }

  createOrder(accountId, productId) {
    const product = this.product(productId);
    if (!product) throw new LocalMarketError('NOT_FOUND', '商品不存在', 404);
    const serverTime = this.serverTime();
    this.expireOrders(serverTime);
    const entitlement = this.database.prepare(`
      SELECT 1 FROM local_market_entitlements WHERE account_id = ? AND product_id = ?
    `).get(accountId, productId);
    if (entitlement) {
      throw new LocalMarketError('ALREADY_ENTITLED', '该本地测试账号已经拥有此商品', 409);
    }
    const existing = this.database.prepare(`
      SELECT * FROM local_market_orders
      WHERE account_id = ? AND product_id = ? AND status = 'pending_payment'
      ORDER BY created_at DESC LIMIT 1
    `).get(accountId, productId);
    if (existing) return { order: mapOrder(existing), reused: true, serverTime };

    const createdAt = serverTime;
    const expiresAt = new Date(Date.parse(createdAt) + ORDER_TTL_MS).toISOString();
    const id = crypto.randomUUID();
    const reference = this.generateReference();
    this.database.prepare(`
      INSERT INTO local_market_orders
        (id, account_id, product_id, amount_fen, currency, collection_account_id,
         payment_reference, status, created_at, expires_at, updated_at, product_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?)
    `).run(
      id,
      accountId,
      product.id,
      product.priceFen ?? product.testPriceFen,
      product.currency,
      this.collectionAccountId,
      reference,
      createdAt,
      expiresAt,
      createdAt,
      product.version || ''
    );
    return {
      order: mapOrder(this.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(id)),
      reused: false,
      serverTime
    };
  }

  getOrder(accountId, orderId) {
    const serverTime = this.serverTime();
    this.expireOrders(serverTime);
    const row = this.database.prepare(`
      SELECT * FROM local_market_orders WHERE id = ? AND account_id = ?
    `).get(orderId, accountId);
    if (!row) throw new LocalMarketError('NOT_FOUND', '订单不存在', 404);
    return { order: mapOrder(row), serverTime };
  }

  cancelOrder(accountId, orderId) {
    const serverTime = this.serverTime();
    this.expireOrders(serverTime);
    const row = this.database.prepare(`
      SELECT * FROM local_market_orders WHERE id = ? AND account_id = ?
    `).get(orderId, accountId);
    if (!row) throw new LocalMarketError('NOT_FOUND', '订单不存在', 404);
    if (row.status === 'canceled') return { order: mapOrder(row), serverTime };
    if (row.status !== 'pending_payment') {
      throw new LocalMarketError('ORDER_NOT_PAYABLE', '该订单已经不能取消', 409);
    }
    this.database.prepare(`
      UPDATE local_market_orders
      SET status = 'canceled', canceled_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_payment'
    `).run(serverTime, serverTime, orderId);
    return {
      order: mapOrder(this.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(orderId)),
      serverTime
    };
  }

  paymentFingerprints(payload) {
    const common = {
      accountId: payload.accountId,
      amountFen: payload.amountFen,
      category: payload.category,
      currency: payload.currency,
      direction: payload.direction,
      occurredAt: payload.occurredAt,
      reference: payload.reference,
      status: payload.status,
      transactionId: payload.transactionId
    };
    const transaction = payload.category === PERSONAL_TRANSFER_CATEGORY
      ? Object.fromEntries(Object.entries(common).filter(([key]) => key !== 'occurredAt'))
      : common;
    return {
      event: sha256(stableJson({
        ...common,
        eventKey: payload.eventKey,
        observedAt: payload.observedAt,
        verified: payload.verified
      })),
      transaction: sha256(stableJson(transaction))
    };
  }

  reviewPayment(payload, order, receivedAt) {
    const reasons = [];
    let late = false;
    if (!PAYMENT_REFERENCE_PATTERN.test(payload.reference)) reasons.push('reference_invalid');
    if (!order) {
      reasons.push('reference_not_found');
      if (payload.amountFen === null) reasons.push('amount_missing');
      if (!payload.currency) reasons.push('currency_missing');
      if (!payload.occurredAt) reasons.push('occurred_at_missing');
    } else {
      if (payload.accountId !== order.collection_account_id) reasons.push('collection_account_mismatch');
      if (payload.amountFen === null) reasons.push('amount_missing');
      else if (payload.amountFen !== Number(order.amount_fen)) reasons.push('amount_mismatch');
      if (!payload.currency) reasons.push('currency_missing');
      else if (payload.currency !== order.currency) reasons.push('currency_mismatch');
      if (order.status !== 'pending_payment') {
        reasons.push(order.status === 'paid' ? 'order_paid_by_other_event' : `order_${order.status}`);
      }
      if (!payload.occurredAt) {
        reasons.push('occurred_at_missing');
      } else if (Date.parse(payload.occurredAt) > Date.parse(order.expires_at)) {
        reasons.push('payment_after_expiry');
        late = true;
      }
      if (Date.parse(receivedAt) > Date.parse(order.expires_at)) {
        reasons.push('notification_after_expiry');
        late = true;
      }
    }
    const personalTransfer = payload.category === PERSONAL_TRANSFER_CATEGORY;
    if (personalTransfer) reasons.push('personal_transfer_requires_review');
    else if (payload.category !== 'receipt') reasons.push('category_not_receipt');
    if (payload.direction !== 'incoming') reasons.push('direction_not_incoming');
    if (personalTransfer) {
      if (payload.status !== 'observed') reasons.push('status_not_observed');
    } else if (payload.status !== 'completed') {
      reasons.push('status_not_completed');
    }
    if (!payload.transactionId) reasons.push('transaction_id_missing');
    if (!payload.verified) reasons.push('source_unverified');
    return { reasons: [...new Set(reasons)], late };
  }

  autoApprovePersonalTransferEvent(eventId, { allowExpiredReplay = false, approvedAt } = {}) {
    const autoApprovedAt = approvedAt || this.serverTime();
    let result = null;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const event = this.database.prepare(`
        SELECT * FROM local_market_payment_events WHERE id = ?
      `).get(eventId);
      if (!event || event.category !== PERSONAL_TRANSFER_CATEGORY) {
        this.database.exec('COMMIT');
        return null;
      }
      const order = PAYMENT_REFERENCE_PATTERN.test(event.payment_reference)
        ? this.database.prepare(`
            SELECT * FROM local_market_orders WHERE payment_reference = ?
          `).get(event.payment_reference)
        : null;
      if (event.review_status === 'approved') {
        const entitlement = event.approved_order_id
          ? this.database.prepare(`
              SELECT * FROM local_market_entitlements WHERE order_id = ?
            `).get(event.approved_order_id)
          : null;
        this.database.exec('COMMIT');
        return {
          approved: false,
          duplicate: true,
          paymentEvent: mapPaymentEvent(event),
          order: mapOrder(order),
          entitlement: mapEntitlement(entitlement)
        };
      }
      if (event.review_status !== 'candidate_review' || !order) {
        this.database.exec('COMMIT');
        return null;
      }

      const occurredAt = event.occurred_at ? Date.parse(event.occurred_at) : Number.NaN;
      const observedAt = event.observed_at ? Date.parse(event.observed_at) : Number.NaN;
      const receivedAt = event.received_at ? Date.parse(event.received_at) : Number.NaN;
      const createdAt = Date.parse(order.created_at);
      const expiresAt = Date.parse(order.expires_at);
      const acceptableOrderStatus = order.status === 'pending_payment'
        || (allowExpiredReplay && order.status === 'expired');
      if (order.status === 'paid' && order.payment_event_id !== event.id) {
        this.database.prepare(`
          UPDATE local_market_payment_events
          SET review_reason = 'order_paid_by_other_event,source_unverified'
          WHERE id = ? AND review_status = 'candidate_review'
        `).run(eventId);
        const retainedEvent = this.database.prepare(`
          SELECT * FROM local_market_payment_events WHERE id = ?
        `).get(eventId);
        this.database.exec('COMMIT');
        return {
          approved: false,
          duplicate: true,
          paymentEvent: mapPaymentEvent(retainedEvent),
          order: mapOrder(order),
          entitlement: null
        };
      }
      const eligible = event.direction === 'incoming'
        && event.event_status === 'observed'
        && event.verified === 0
        && event.collection_account_id === this.collectionAccountId
        && event.collection_account_id === order.collection_account_id
        && event.amount_fen !== null
        && Number(event.amount_fen) === Number(order.amount_fen)
        && Boolean(event.currency)
        && event.currency === order.currency
        && Boolean(event.transaction_id)
        && Number.isFinite(occurredAt)
        && Number.isFinite(observedAt)
        && Number.isFinite(receivedAt)
        && occurredAt >= createdAt
        && occurredAt <= expiresAt
        && observedAt >= createdAt
        && observedAt <= expiresAt
        && receivedAt >= createdAt
        && receivedAt <= expiresAt
        && acceptableOrderStatus;
      if (!eligible) {
        this.database.exec('COMMIT');
        return null;
      }

      const existingEntitlement = this.database.prepare(`
        SELECT * FROM local_market_entitlements WHERE account_id = ? AND product_id = ?
      `).get(order.account_id, order.product_id);
      if (existingEntitlement) {
        this.database.exec('COMMIT');
        return null;
      }

      this.database.prepare(`
        UPDATE local_market_payment_events
        SET review_status = 'approved',
          review_reason = 'auto_personal_transfer_policy,source_unverified',
          is_late = 0, approved_at = ?, approved_order_id = ?, admin_note = NULL
        WHERE id = ? AND review_status = 'candidate_review'
      `).run(autoApprovedAt, order.id, eventId);
      this.database.prepare(`
        UPDATE local_market_orders
        SET status = 'paid', paid_at = ?, payment_event_id = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(autoApprovedAt, eventId, autoApprovedAt, order.id, order.status);
      this.database.prepare(`
        INSERT INTO local_market_entitlements
          (account_id, product_id, order_id, payment_event_id, granted_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(order.account_id, order.product_id, order.id, eventId, autoApprovedAt);
      this.database.prepare(`
        INSERT INTO local_market_audit
          (action, entity_type, entity_id, order_id, payment_event_id,
           note, details_json, created_at)
        VALUES ('auto_personal_transfer', 'payment_event', ?, ?, ?, '', ?, ?)
      `).run(
        eventId,
        order.id,
        eventId,
        JSON.stringify({
          policy: 'strict_personal_transfer_match',
          verified: false,
          eventStatus: event.event_status,
          occurredAt: event.occurred_at,
          receivedAt: event.received_at,
          recoveredExpiredCandidate: order.status === 'expired'
        }),
        autoApprovedAt
      );
      const paymentEvent = this.database.prepare(`
        SELECT * FROM local_market_payment_events WHERE id = ?
      `).get(eventId);
      const paidOrder = this.database.prepare(`
        SELECT * FROM local_market_orders WHERE id = ?
      `).get(order.id);
      const entitlement = this.database.prepare(`
        SELECT * FROM local_market_entitlements WHERE order_id = ?
      `).get(order.id);
      result = {
        approved: true,
        duplicate: false,
        paymentEvent: mapPaymentEvent(paymentEvent),
        order: mapOrder(paidOrder),
        entitlement: mapEntitlement(entitlement)
      };
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    return result;
  }

  recordPaymentEvent(input) {
    const receivedAt = this.serverTime();
    this.expireOrders(receivedAt);
    const payload = normalizePaymentPayload(input);
    const fingerprints = this.paymentFingerprints(payload);
    const duplicateEvent = this.database.prepare(`
      SELECT * FROM local_market_payment_events WHERE event_key = ?
    `).get(payload.eventKey);
    if (duplicateEvent) {
      if (duplicateEvent.event_fingerprint !== fingerprints.event) {
        throw new LocalMarketError(
          'IDEMPOTENCY_CONFLICT',
          '相同事件键对应了不同内容',
          409
        );
      }
      const automatic = this.autoApprovePersonalTransferEvent(duplicateEvent.id, {
        allowExpiredReplay: true,
        approvedAt: receivedAt
      });
      return {
        paymentEvent: automatic?.paymentEvent || mapPaymentEvent(duplicateEvent),
        order: automatic?.order,
        entitlement: automatic?.entitlement,
        autoApproved: automatic?.approved === true,
        duplicate: true,
        serverTime: receivedAt
      };
    }
    if (payload.transactionId) {
      const duplicateTransaction = this.database.prepare(`
        SELECT * FROM local_market_payment_events WHERE transaction_id = ?
      `).get(payload.transactionId);
      if (duplicateTransaction) {
        if (duplicateTransaction.transaction_fingerprint !== fingerprints.transaction) {
          throw new LocalMarketError(
            'IDEMPOTENCY_CONFLICT',
            '相同交易号对应了不同付款内容',
            409
          );
        }
        const automatic = this.autoApprovePersonalTransferEvent(duplicateTransaction.id, {
          allowExpiredReplay: false,
          approvedAt: receivedAt
        });
        return {
          paymentEvent: automatic?.paymentEvent || mapPaymentEvent(duplicateTransaction),
          order: automatic?.order,
          entitlement: automatic?.entitlement,
          autoApproved: automatic?.approved === true,
          duplicate: true,
          serverTime: receivedAt
        };
      }
    }

    const order = PAYMENT_REFERENCE_PATTERN.test(payload.reference)
      ? this.database.prepare(`
          SELECT * FROM local_market_orders WHERE payment_reference = ?
        `).get(payload.reference)
      : null;
    const review = this.reviewPayment(payload, order, receivedAt);
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO local_market_payment_events
        (id, event_key, event_fingerprint, transaction_fingerprint,
         collection_account_id, category, direction, event_status, amount_fen,
         currency, payment_reference, transaction_id, occurred_at, observed_at,
         verified, review_status, review_reason, is_late, matched_order_id, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate_review', ?, ?, ?, ?)
    `).run(
      id,
      payload.eventKey,
      fingerprints.event,
      fingerprints.transaction,
      payload.accountId,
      payload.category,
      payload.direction,
      payload.status,
      payload.amountFen,
      payload.currency,
      payload.reference,
      payload.transactionId,
      payload.occurredAt,
      payload.observedAt,
      Number(payload.verified),
      review.reasons.join(','),
      Number(review.late),
      order?.id || null,
      receivedAt
    );
    const row = this.database.prepare(`
      SELECT * FROM local_market_payment_events WHERE id = ?
    `).get(id);
    const automatic = this.autoApprovePersonalTransferEvent(id, {
      allowExpiredReplay: false,
      approvedAt: receivedAt
    });
    return {
      paymentEvent: automatic?.paymentEvent || mapPaymentEvent(row),
      order: automatic?.order,
      entitlement: automatic?.entitlement,
      autoApproved: automatic?.approved === true,
      duplicate: false,
      serverTime: receivedAt
    };
  }

  reparsePaymentEvent(eventId, input) {
    const reparsedAt = this.serverTime();
    const payload = normalizePaymentPayload(input);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const event = this.database.prepare(`
        SELECT * FROM local_market_payment_events WHERE id = ?
      `).get(eventId);
      if (!event) throw new LocalMarketError('NOT_FOUND', '付款候选事件不存在', 404);
      if (event.review_status !== 'candidate_review') {
        throw new LocalMarketError(
          'PAYMENT_EVENT_NOT_REPARSABLE',
          '只有待人工复核的付款候选可以重新解析',
          409
        );
      }

      const identityMismatches = [];
      const identityChecks = [
        ['eventKey', event.event_key, payload.eventKey],
        ['accountId', event.collection_account_id, payload.accountId],
        ['amountFen', event.amount_fen === null ? null : Number(event.amount_fen), payload.amountFen],
        ['currency', event.currency, payload.currency],
        ['transactionId', event.transaction_id, payload.transactionId],
        ['occurredAt', event.occurred_at, payload.occurredAt],
        ['observedAt', event.observed_at, payload.observedAt],
        ['verified', event.verified === 1, payload.verified]
      ];
      for (const [name, before, after] of identityChecks) {
        if (before !== after) identityMismatches.push(name);
      }
      if (identityMismatches.length > 0) {
        throw new LocalMarketError(
          'PAYMENT_SOURCE_IDENTITY_MISMATCH',
          `付款来源身份字段不能修改：${identityMismatches.join(',')}`,
          409
        );
      }

      const sameParse = event.category === payload.category
        && event.direction === payload.direction
        && event.event_status === payload.status
        && event.payment_reference === payload.reference;
      if (sameParse) {
        this.database.exec('COMMIT');
        return {
          paymentEvent: mapPaymentEvent(event),
          duplicate: true,
          serverTime: reparsedAt
        };
      }

      const order = PAYMENT_REFERENCE_PATTERN.test(payload.reference)
        ? this.database.prepare(`
            SELECT * FROM local_market_orders WHERE payment_reference = ?
          `).get(payload.reference)
        : null;
      const review = this.reviewPayment(payload, order, event.received_at);
      const fingerprints = this.paymentFingerprints(payload);
      const before = {
        category: event.category,
        direction: event.direction,
        status: event.event_status,
        reference: event.payment_reference,
        reviewReason: event.review_reason,
        late: event.is_late === 1,
        matchedOrderId: event.matched_order_id || null
      };
      const after = {
        category: payload.category,
        direction: payload.direction,
        status: payload.status,
        reference: payload.reference,
        reviewReason: review.reasons.join(','),
        late: review.late,
        matchedOrderId: order?.id || null
      };

      this.database.prepare(`
        UPDATE local_market_payment_events
        SET event_fingerprint = ?, transaction_fingerprint = ?, category = ?,
          direction = ?, event_status = ?, payment_reference = ?, review_reason = ?,
          is_late = ?, matched_order_id = ?
        WHERE id = ? AND review_status = 'candidate_review'
      `).run(
        fingerprints.event,
        fingerprints.transaction,
        payload.category,
        payload.direction,
        payload.status,
        payload.reference,
        after.reviewReason,
        Number(review.late),
        after.matchedOrderId,
        eventId
      );
      this.database.prepare(`
        INSERT INTO local_market_audit
          (action, entity_type, entity_id, order_id, payment_event_id,
           note, details_json, created_at)
        VALUES ('admin_reparse', 'payment_event', ?, ?, ?, '', ?, ?)
      `).run(
        eventId,
        after.matchedOrderId,
        eventId,
        JSON.stringify({ before, after }),
        reparsedAt
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }

    const reparsed = this.database.prepare(`
      SELECT * FROM local_market_payment_events WHERE id = ?
    `).get(eventId);
    return {
      paymentEvent: mapPaymentEvent(reparsed),
      duplicate: false,
      serverTime: reparsedAt
    };
  }

  listPaymentEvents(limit = 100) {
    const rows = this.database.prepare(`
      SELECT * FROM local_market_payment_events
      ORDER BY received_at DESC, id DESC LIMIT ?
    `).all(limit);
    return { events: rows.map(mapPaymentEvent), serverTime: this.serverTime() };
  }

  confirmPaymentEvent(eventId, orderId, note, { transferReceived = false } = {}) {
    const approvedAt = this.serverTime();
    this.expireOrders(approvedAt);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const event = this.database.prepare(`
        SELECT * FROM local_market_payment_events WHERE id = ?
      `).get(eventId);
      if (!event) throw new LocalMarketError('NOT_FOUND', '付款候选事件不存在', 404);
      const personalTransfer = event.category === PERSONAL_TRANSFER_CATEGORY;
      if (personalTransfer && transferReceived !== true) {
        throw new LocalMarketError(
          'TRANSFER_RECEIPT_CONFIRMATION_REQUIRED',
          '个人转账候选必须明确确认已在微信中实际收款',
          409
        );
      }
      const matchedOrder = this.database.prepare(`
        SELECT * FROM local_market_orders WHERE payment_reference = ?
      `).get(event.payment_reference);
      if (!matchedOrder || matchedOrder.id !== orderId) {
        throw new LocalMarketError(
          'PAYMENT_ORDER_MISMATCH',
          '付款候选与指定订单不匹配',
          409
        );
      }
      if (event.review_status === 'approved') {
        if (event.approved_order_id !== orderId) {
          throw new LocalMarketError(
            'PAYMENT_ORDER_MISMATCH',
            '付款候选已经批准给其他订单',
            409
          );
        }
        const entitlement = this.database.prepare(`
          SELECT * FROM local_market_entitlements WHERE order_id = ?
        `).get(orderId);
        this.database.exec('COMMIT');
        return {
          paymentEvent: mapPaymentEvent(event),
          order: mapOrder(matchedOrder),
          entitlement: mapEntitlement(entitlement),
          duplicate: true,
          serverTime: approvedAt
        };
      }

      const failures = [];
      if (!PAYMENT_REFERENCE_PATTERN.test(event.payment_reference)) failures.push('reference_invalid');
      if (event.collection_account_id !== this.collectionAccountId
          || event.collection_account_id !== matchedOrder.collection_account_id) {
        failures.push('collection_account_mismatch');
      }
      if (event.amount_fen === null) failures.push('amount_missing');
      else if (Number(event.amount_fen) !== Number(matchedOrder.amount_fen)) failures.push('amount_mismatch');
      if (!event.currency) failures.push('currency_missing');
      else if (event.currency !== matchedOrder.currency) failures.push('currency_mismatch');
      if (!personalTransfer && event.category !== 'receipt') failures.push('category_not_receipt');
      if (event.direction !== 'incoming') failures.push('direction_not_incoming');
      if (personalTransfer) {
        if (event.event_status !== 'observed') failures.push('status_not_observed');
      } else if (event.event_status !== 'completed') {
        failures.push('status_not_completed');
      }
      if (!event.transaction_id) failures.push('transaction_id_missing');
      if (!event.occurred_at) failures.push('occurred_at_missing');
      if (matchedOrder.status === 'paid' && matchedOrder.payment_event_id !== event.id) {
        failures.push('order_paid_by_other_event');
      }
      if (failures.length > 0) {
        throw new LocalMarketError(
          'PAYMENT_REVIEW_REQUIRED',
          `付款候选仍不满足人工批准条件：${failures.join(',')}`,
          409
        );
      }

      const existingEntitlement = this.database.prepare(`
        SELECT * FROM local_market_entitlements WHERE account_id = ? AND product_id = ?
      `).get(matchedOrder.account_id, matchedOrder.product_id);
      if (existingEntitlement && existingEntitlement.order_id !== matchedOrder.id) {
        throw new LocalMarketError(
          'PAYMENT_REVIEW_REQUIRED',
          '该账号已有其他订单发放的商品权益',
          409
        );
      }

      this.database.prepare(`
        UPDATE local_market_payment_events
        SET review_status = 'approved', approved_at = ?, approved_order_id = ?, admin_note = ?
        WHERE id = ? AND review_status = 'candidate_review'
      `).run(approvedAt, orderId, note, eventId);
      this.database.prepare(`
        UPDATE local_market_orders
        SET status = 'paid', paid_at = ?, payment_event_id = ?, updated_at = ?
        WHERE id = ?
      `).run(personalTransfer ? approvedAt : event.occurred_at, eventId, approvedAt, orderId);
      this.database.prepare(`
        INSERT INTO local_market_entitlements
          (account_id, product_id, order_id, payment_event_id, granted_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        matchedOrder.account_id,
        matchedOrder.product_id,
        matchedOrder.id,
        eventId,
        approvedAt
      );
      this.database.prepare(`
        INSERT INTO local_market_audit
          (action, entity_type, entity_id, order_id, payment_event_id,
           note, details_json, created_at)
        VALUES ('admin_confirm', 'payment_event', ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        orderId,
        eventId,
        note,
        JSON.stringify({
          before: event.review_status,
          after: 'approved',
          late: event.is_late === 1,
           priorReviewReason: event.review_reason,
           transferReceived: personalTransfer ? true : null
        }),
        approvedAt
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }

    const paymentEvent = this.database.prepare(`
      SELECT * FROM local_market_payment_events WHERE id = ?
    `).get(eventId);
    const order = this.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(orderId);
    const entitlement = this.database.prepare(`
      SELECT * FROM local_market_entitlements WHERE order_id = ?
    `).get(orderId);
    return {
      paymentEvent: mapPaymentEvent(paymentEvent),
      order: mapOrder(order),
      entitlement: mapEntitlement(entitlement),
      duplicate: false,
      serverTime: approvedAt
    };
  }

  downloadFor(accountId, productId) {
    const product = this.product(productId);
    if (!product) throw new LocalMarketError('NOT_FOUND', '商品不存在', 404);
    const entitlement = this.database.prepare(`
      SELECT * FROM local_market_entitlements WHERE account_id = ? AND product_id = ?
    `).get(accountId, productId);
    if (!entitlement) {
      throw new LocalMarketError('ENTITLEMENT_REQUIRED', '需要先完成本地测试购买', 403);
    }
    const resolved = this.downloadResolver
      ? this.downloadResolver(product, mapEntitlement(entitlement))
      : { path: this.fixturePath, fileName: product.downloadFileName };
    return { ...resolved, entitlement: mapEntitlement(entitlement) };
  }

  entitlementFor(accountId, productId) {
    return mapEntitlement(this.database.prepare(`
      SELECT entitlements.*, orders.product_version
      FROM local_market_entitlements AS entitlements
      JOIN local_market_orders AS orders ON orders.id = entitlements.order_id
      WHERE entitlements.account_id = ? AND entitlements.product_id = ?
    `).get(accountId, productId));
  }

  listAudit(limit = 100) {
    return this.database.prepare(`
      SELECT action, entity_type, entity_id, order_id, payment_event_id,
        note, details_json, created_at
      FROM local_market_audit ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(limit);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

module.exports = {
  LOCAL_TEST_ACCOUNT_ID,
  LOCAL_TEST_PRODUCT,
  LocalMarketError,
  LocalMarketStore,
  ORDER_TTL_MS,
  PAYMENT_REFERENCE_PATTERN,
  canonicalReference,
  createStoredZip,
  mapOrder
};
