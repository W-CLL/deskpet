const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LocalMarketError, LocalMarketStore, mapOrder } = require('./local-market-store');
const { DEFAULT_PET_MARKET_PAYMENT_SETTINGS } = require('./pet-market-payment-settings');

function mapProduct(row, versions = []) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    chargingMode: row.charging_mode,
    priceFen: Number(row.price_fen),
    currency: row.currency,
    status: row.status,
    isDefault: row.is_default === 1,
    tags: JSON.parse(row.tags_json || '[]'),
    isFeatured: row.is_featured === 1,
    sortOrder: Number(row.sort_order),
    previewMode: row.preview_mode,
    previewPaths: JSON.parse(row.preview_paths_json || '[]'),
    activeVersion: row.active_version || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versions
  };
}

function mapVersion(row) {
  if (!row) return null;
  const manifest = JSON.parse(row.manifest_json);
  return {
    productId: row.product_id,
    version: row.version,
    fileName: row.original_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    manifestSha256: row.manifest_sha256,
    assetCount: manifest.files.length,
    files: manifest.files,
    createdAt: row.created_at
  };
}

class PetMarketStore extends LocalMarketStore {
  constructor(dataDirectory, options = {}) {
    super(dataDirectory, {
      collectionAccountId: options.collectionAccountId,
      now: options.now,
      randomInt: options.randomInt,
      databaseFile: 'pet-market.db',
      migrationScope: 'pet-market-payments',
      createFixture: false
    });
    this.assetsDirectory = path.join(this.dataDirectory, 'pet-market-assets');
    this.uploadsDirectory = path.join(this.dataDirectory, 'pet-market-uploads');
    this.productLookup = (productId) => this.paymentProduct(productId);
  }

  async initialize() {
    await Promise.all([
      fs.promises.mkdir(this.assetsDirectory, { recursive: true, mode: 0o700 }),
      fs.promises.mkdir(this.uploadsDirectory, { recursive: true, mode: 0o700 })
    ]);
    await super.initialize();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS pet_market_products (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        charging_mode TEXT NOT NULL CHECK (charging_mode IN ('free', 'paid')),
        price_fen INTEGER NOT NULL CHECK (price_fen >= 0),
        currency TEXT NOT NULL DEFAULT 'CNY',
        status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'unlisted')),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        tags_json TEXT NOT NULL DEFAULT '[]',
        is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        preview_mode TEXT NOT NULL CHECK (preview_mode IN ('first5', 'selected', 'none')),
        preview_paths_json TEXT NOT NULL DEFAULT '[]',
        active_version TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pet_market_default
        ON pet_market_products(is_default) WHERE is_default = 1;
      CREATE INDEX IF NOT EXISTS idx_pet_market_product_status_sort
        ON pet_market_products(status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS pet_market_versions (
        product_id TEXT NOT NULL,
        version TEXT NOT NULL,
        file_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (product_id, version),
        FOREIGN KEY (product_id) REFERENCES pet_market_products(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pet_market_free_entitlements (
        account_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_version TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (account_id, product_id),
        FOREIGN KEY (product_id) REFERENCES pet_market_products(id)
      );
      CREATE TABLE IF NOT EXISTS pet_market_payment_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pet_market_order_payment_snapshots (
        order_id TEXT PRIMARY KEY,
        collection_account_id TEXT NOT NULL,
        payment_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES local_market_orders(id)
      );
      CREATE TABLE IF NOT EXISTS pet_market_order_buyer_snapshots (
        order_id TEXT PRIMARY KEY,
        license_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        display_name TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES local_market_orders(id)
      );
      CREATE INDEX IF NOT EXISTS idx_pet_market_order_history
        ON local_market_orders(account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_pet_market_admin_order_history
        ON local_market_orders(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_pet_market_admin_order_status
        ON local_market_orders(status, created_at DESC, id DESC);
    `);
    const productColumns = new Set(this.database.prepare('PRAGMA table_info(pet_market_products)').all()
      .map((column) => column.name));
    if (!productColumns.has('tags_json')) {
      this.database.exec("ALTER TABLE pet_market_products ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!productColumns.has('is_featured')) {
      this.database.exec('ALTER TABLE pet_market_products ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1))');
    }
  }

  uploadPath(uploadId) {
    return path.join(this.uploadsDirectory, `${uploadId}.part`);
  }

  paymentSettings() {
    const row = this.database.prepare('SELECT settings_json FROM pet_market_payment_settings WHERE singleton = 1').get();
    return row ? JSON.parse(row.settings_json) : { ...DEFAULT_PET_MARKET_PAYMENT_SETTINGS };
  }

  savePaymentSettings(settings) {
    this.database.prepare(`
      INSERT INTO pet_market_payment_settings (singleton, settings_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(settings), this.serverTime());
    return this.paymentSettings();
  }

  pendingOrderId(accountId, productId) {
    return this.database.prepare(`
      SELECT id FROM local_market_orders WHERE account_id = ? AND product_id = ?
        AND status = 'pending_payment' AND expires_at > ? ORDER BY created_at DESC LIMIT 1
    `).get(accountId, productId, this.serverTime())?.id || null;
  }

  ordersForAccount(accountId, cursor = null) {
    const serverTime = this.serverTime();
    this.expireOrders(serverTime);
    const rows = this.database.prepare(`
      SELECT orders.*, products.title AS product_title
      FROM local_market_orders AS orders
      LEFT JOIN pet_market_products AS products ON products.id = orders.product_id
      WHERE orders.account_id = ?
        AND (? = '' OR orders.created_at < ? OR (orders.created_at = ? AND orders.id < ?))
      ORDER BY orders.created_at DESC, orders.id DESC
      LIMIT 101
    `).all(accountId, cursor?.createdAt || '', cursor?.createdAt || '', cursor?.createdAt || '', cursor?.id || '');
    return { orders: rows.map(row => ({ ...mapOrder(row), productTitle: row.product_title || row.product_id })), serverTime };
  }

  adminConfirmation(order) {
    const confirmation = this.database.prepare(
      'SELECT * FROM local_market_manual_confirmations WHERE order_id = ?'
    ).get(order.id);
    const eventAudit = !confirmation && order.status === 'paid' && order.payment_event_id
      ? this.database.prepare(`SELECT action FROM local_market_audit
          WHERE order_id = ? AND payment_event_id = ? AND action IN ('admin_confirm', 'auto_personal_transfer')
          ORDER BY id ASC LIMIT 1`).get(order.id, order.payment_event_id)
      : null;
    return {
      confirmationMethod: confirmation || eventAudit?.action === 'admin_confirm' ? 'manual'
        : eventAudit?.action === 'auto_personal_transfer' ? 'automatic' : null,
      manualConfirmation: confirmation ? {
        note: confirmation.note,
        confirmedAt: confirmation.confirmed_at,
        confirmedBy: confirmation.confirmed_by,
        previousStatus: confirmation.previous_status
      } : null
    };
  }

  confirmOrderPayment(orderId, { note, expectedAmountFen, confirmedBy }) {
    const serverTime = this.serverTime();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.expireOrders(serverTime);
      const order = this.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(orderId);
      if (!order) throw new LocalMarketError('NOT_FOUND', '订单不存在', 404);
      if (Number(order.amount_fen) !== expectedAmountFen) {
        throw new LocalMarketError('ORDER_AMOUNT_MISMATCH', '核对金额与订单金额不一致，请刷新订单后重新核对', 409);
      }
      if (order.status === 'paid') {
        const result = { order: { ...mapOrder(order), ...this.adminConfirmation(order) }, duplicate: true, serverTime };
        this.database.exec('COMMIT');
        return result;
      }
      if (!['pending_payment', 'expired', 'canceled'].includes(order.status)) {
        throw new LocalMarketError('ORDER_NOT_CONFIRMABLE', '当前订单状态不支持手动确认', 409);
      }
      if (this.hasEntitlement(order.account_id, order.product_id)) {
        throw new LocalMarketError('ALREADY_ENTITLED', '该账号已通过其他订单或免费领取拥有此桌宠，请先核对重复付款', 409);
      }
      const product = this.productRow(order.product_id);
      const version = this.versionRow(order.product_id, order.product_version);
      const archive = version ? fs.statSync(this.versionPath(version), { throwIfNoEntry: false }) : null;
      if (!product || product.status === 'draft' || !version || !archive?.isFile()
          || archive.size !== Number(version.size_bytes)) {
        throw new LocalMarketError('ORDER_RESOURCE_UNAVAILABLE', '订单对应的桌宠版本暂不可下载，请先恢复资源后再确认', 409);
      }

      this.database.prepare(`
        INSERT INTO local_market_manual_confirmations
          (order_id, note, confirmed_at, confirmed_by, previous_status, expected_amount_fen)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(order.id, note, serverTime, confirmedBy, order.status, expectedAmountFen);
      this.database.prepare(`
        UPDATE local_market_orders SET status = 'paid', paid_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(serverTime, serverTime, order.id, order.status);
      this.database.prepare(`
        INSERT INTO local_market_entitlements
          (account_id, product_id, order_id, manual_confirmation_order_id, granted_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(order.account_id, order.product_id, order.id, order.id, serverTime);
      this.database.prepare(`
        INSERT INTO local_market_audit
          (action, entity_type, entity_id, order_id, note, details_json, created_at)
        VALUES ('admin_confirm_order', 'order', ?, ?, ?, ?, ?)
      `).run(order.id, order.id, note, JSON.stringify({
        confirmedBy, previousStatus: order.status, confirmationMethod: 'manual',
        expectedAmountFen, productId: order.product_id, productVersion: order.product_version,
        accountId: order.account_id, received: true
      }), serverTime);
      const paidOrder = this.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(order.id);
      const result = { order: { ...mapOrder(paidOrder), ...this.adminConfirmation(paidOrder) }, duplicate: false, serverTime };
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  adminOrders({ status = '', q = '', page = 1, pageSize = 25,
    currentBuyerNames = new Map(), currentAccountDevices = new Map() }) {
    const serverTime = this.serverTime();
    this.expireOrders(serverTime);
    const filters = [];
    const parameters = [];
    if (status) {
      filters.push('orders.status = ?');
      parameters.push(status);
    }
    if (q) {
      const needle = q.toLowerCase();
      const referenceAccounts = new Set();
      for (const [accountId, name] of currentBuyerNames) {
        if (name.toLowerCase().includes(needle)) referenceAccounts.add(accountId);
      }
      for (const [accountId, devices] of currentAccountDevices) {
        if (devices.some(device => device.installationId.toLowerCase().includes(needle))) {
          referenceAccounts.add(accountId);
        }
      }
      filters.push(`(instr(lower(orders.id), lower(?)) > 0
        OR instr(lower(orders.payment_reference), lower(?)) > 0
        OR instr(lower(orders.product_id), lower(?)) > 0
        OR instr(lower(COALESCE(products.title, '')), lower(?)) > 0
        OR instr(lower(orders.account_id), lower(?)) > 0
        OR instr(lower(COALESCE(buyer.display_name, '')), lower(?)) > 0
        OR instr(lower(COALESCE(buyer.installation_id, '')), lower(?)) > 0
        OR (buyer.order_id IS NULL AND orders.account_id IN (SELECT value FROM json_each(?))))`);
      parameters.push(q, q, q, q, q, q, q, JSON.stringify([...referenceAccounts]));
    }
    const source = `FROM local_market_orders AS orders
      LEFT JOIN pet_market_products AS products ON products.id = orders.product_id
      LEFT JOIN pet_market_order_buyer_snapshots AS buyer ON buyer.order_id = orders.id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`;
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS count ${source}`).get(...parameters).count);
    const rows = this.database.prepare(`
      SELECT orders.*, products.title AS product_title, buyer.order_id AS buyer_snapshot_id,
        buyer.display_name AS buyer_display_name, buyer.installation_id AS buyer_installation_id,
        buyer.platform AS buyer_platform ${source}
      ORDER BY orders.created_at DESC, orders.id DESC LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (page - 1) * pageSize);
    // Summary intentionally covers every order; filters only affect the table and total.
    const summaryRow = this.database.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'pending_payment'), 0) AS pending,
        COALESCE(SUM(status = 'paid'), 0) AS paid,
        COALESCE(SUM(status = 'canceled'), 0) AS canceled,
        COALESCE(SUM(status = 'expired'), 0) AS expired,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_fen ELSE 0 END), 0) AS paidAmountFen
      FROM local_market_orders
    `).get();
    return {
      orders: rows.map(row => {
        const snapshot = Boolean(row.buyer_snapshot_id);
        const displayName = (snapshot ? row.buyer_display_name : currentBuyerNames.get(row.account_id)) || null;
        return {
          ...mapOrder(row),
          ...this.adminConfirmation(row),
          accountId: row.account_id,
          productTitle: row.product_title || row.product_id,
          buyerDisplayName: displayName,
          buyerNameSource: snapshot ? 'order_snapshot' : (displayName ? 'current_profile' : 'unknown'),
          buyerInstallationId: snapshot ? row.buyer_installation_id : null,
          buyerDeviceCode: snapshot ? row.buyer_installation_id.slice(-12) : null,
          buyerPlatform: snapshot ? row.buyer_platform : null,
          buyerDeviceSource: snapshot ? 'order_snapshot' : 'unknown',
          accountDevices: snapshot ? [] : (currentAccountDevices.get(row.account_id) || [])
        };
      }),
      total,
      page,
      pageSize,
      summary: Object.fromEntries(Object.entries(summaryRow).map(([key, value]) => [key, Number(value)])),
      serverTime
    };
  }

  paymentSnapshot(orderId) {
    const row = this.database.prepare('SELECT * FROM pet_market_order_payment_snapshots WHERE order_id = ?').get(orderId);
    return row ? { payment: JSON.parse(row.payment_json), collectionAccountId: row.collection_account_id } : null;
  }

  freezePaymentTarget(orderId, settings) {
    const existing = this.paymentSnapshot(orderId);
    if (existing) return existing;
    const row = this.database.prepare('SELECT * FROM local_market_orders WHERE id = ?').get(orderId);
    if (!row || row.status !== 'pending_payment' || row.expires_at <= this.serverTime()) return null;
    const legacyPlaceholder = row.collection_account_id === 'local-demo-collection';
    if (row.collection_account_id !== this.collectionAccountId && !legacyPlaceholder) return null;
    if (legacyPlaceholder) {
      this.database.prepare('UPDATE local_market_orders SET collection_account_id = ? WHERE id = ?')
        .run(this.collectionAccountId, orderId);
      this.database.prepare(`
        INSERT INTO local_market_audit (action, entity_type, entity_id, order_id, note, details_json, created_at)
        VALUES ('bind_payment_target', 'order', ?, ?, ?, ?, ?)
      `).run(orderId, orderId, '首次绑定原开发占位收款目标；订单短码、金额、版本和有效期保持不变',
        JSON.stringify({ fromDevelopmentPlaceholder: true, targetBound: true }), this.serverTime());
    }
    this.database.prepare(`
      INSERT INTO pet_market_order_payment_snapshots (order_id, collection_account_id, payment_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(orderId, this.collectionAccountId, JSON.stringify(settings), this.serverTime());
    return this.paymentSnapshot(orderId);
  }

  ensurePaymentSnapshot(orderId, settings) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.freezePaymentTarget(orderId, settings);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  createOrderWithPayment(accountId, productId, settings, buyer = null) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.createOrder(accountId, productId);
      // A retry from another device must never become the original buyer. Legacy
      // orders intentionally keep their missing snapshot instead of being backfilled.
      if (!result.reused && buyer) {
        this.database.prepare(`
          INSERT INTO pet_market_order_buyer_snapshots
            (order_id, license_id, installation_id, platform, display_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(result.order.id, buyer.licenseId, buyer.installationId,
          buyer.platform || 'unknown', buyer.displayName || null, result.order.createdAt);
      }
      if (!this.freezePaymentTarget(result.order.id, settings)) {
        throw new LocalMarketError('PAYMENT_TARGET_UNAVAILABLE', '订单收款目标暂不可用，请联系商家', 409);
      }
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  versionFileName(productId, version) {
    return `${productId}-${version}-${crypto.randomUUID()}.zip`;
  }

  versionPath(version) {
    return path.join(this.assetsDirectory, version.file_name);
  }

  productRow(productId) {
    return this.database.prepare('SELECT * FROM pet_market_products WHERE id = ?')
      .get(String(productId || '')) || null;
  }

  versionRow(productId, version) {
    return this.database.prepare(`
      SELECT * FROM pet_market_versions WHERE product_id = ? AND version = ?
    `).get(String(productId || ''), String(version || '')) || null;
  }

  versionsFor(productId) {
    return this.database.prepare(`
      SELECT * FROM pet_market_versions WHERE product_id = ? ORDER BY created_at DESC, version DESC
    `).all(productId).map(mapVersion);
  }

  listProducts() {
    return this.database.prepare(`
      SELECT * FROM pet_market_products ORDER BY sort_order ASC, created_at ASC, id ASC
    `).all().map((row) => mapProduct(row, this.versionsFor(row.id)));
  }

  findProduct(productId) {
    const row = this.productRow(productId);
    return row ? mapProduct(row, this.versionsFor(row.id)) : null;
  }

  createProduct(product) {
    const now = this.serverTime();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (product.isDefault) this.database.prepare('UPDATE pet_market_products SET is_default = 0').run();
      this.database.prepare(`
        INSERT INTO pet_market_products
          (id, title, description, charging_mode, price_fen, currency, status, is_default,
           tags_json, is_featured, sort_order, preview_mode, preview_paths_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.id,
        product.title,
        product.description,
        product.chargingMode,
        product.priceFen,
        product.status,
        Number(product.isDefault),
        JSON.stringify(product.tags || []),
        Number(product.isFeatured || false),
        product.sortOrder,
        product.previewMode,
        JSON.stringify(product.previewPaths),
        now,
        now
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    return this.findProduct(product.id);
  }

  updateProduct(productId, product) {
    const now = this.serverTime();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.productRow(productId);
      if (!existing) {
        this.database.exec('ROLLBACK');
        return null;
      }
      if (product.isDefault) {
        this.database.prepare('UPDATE pet_market_products SET is_default = 0 WHERE id <> ?').run(productId);
      }
      this.database.prepare(`
        UPDATE pet_market_products
        SET title = ?, description = ?, charging_mode = ?, price_fen = ?, status = ?,
          is_default = ?, tags_json = ?, is_featured = ?, sort_order = ?, preview_mode = ?, preview_paths_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        product.title,
        product.description,
        product.chargingMode,
        product.priceFen,
        product.status,
        Number(product.isDefault),
        JSON.stringify(product.tags || []),
        Number(product.isFeatured || false),
        product.sortOrder,
        product.previewMode,
        JSON.stringify(product.previewPaths),
        now,
        productId
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    return this.findProduct(productId);
  }

  async commitVersion({ temporaryPath, productId, version, originalName, packageInfo }) {
    const product = this.productRow(productId);
    if (!product) throw new LocalMarketError('PRODUCT_NOT_FOUND', '商品不存在', 404);
    if (this.versionRow(productId, version)) {
      throw new LocalMarketError('PRODUCT_VERSION_EXISTS', '该商品版本已经存在', 409);
    }
    const fileName = this.versionFileName(productId, version);
    const finalPath = path.join(this.assetsDirectory, fileName);
    await fs.promises.rename(temporaryPath, finalPath);
    const createdAt = this.serverTime();
    try {
      this.database.exec('BEGIN IMMEDIATE');
      this.database.prepare(`
        INSERT INTO pet_market_versions
          (product_id, version, file_name, original_name, size_bytes, sha256,
           manifest_sha256, manifest_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        productId,
        version,
        fileName,
        originalName,
        packageInfo.sizeBytes,
        packageInfo.packageSha256,
        packageInfo.manifestSha256,
        JSON.stringify(packageInfo.manifest),
        createdAt
      );
      this.database.prepare(`
        UPDATE pet_market_products SET active_version = ?, updated_at = ? WHERE id = ?
      `).run(version, createdAt, productId);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
      throw error;
    }
    return mapVersion(this.versionRow(productId, version));
  }

  paymentProduct(productId) {
    const row = this.productRow(productId);
    if (!row || row.status !== 'published' || row.charging_mode !== 'paid' || !row.active_version) {
      return null;
    }
    return {
      id: row.id,
      priceFen: Number(row.price_fen),
      currency: row.currency,
      version: row.active_version,
      downloadFileName: `${row.id}-${row.active_version}.zip`
    };
  }

  hasEntitlement(accountId, productId) {
    const free = this.database.prepare(`
      SELECT product_id FROM pet_market_free_entitlements WHERE account_id = ? AND product_id = ?
    `).get(accountId, productId);
    return Boolean(free || this.entitlementFor(accountId, productId));
  }

  entitlement(accountId, productId) {
    const free = this.database.prepare(`
      SELECT * FROM pet_market_free_entitlements WHERE account_id = ? AND product_id = ?
    `).get(accountId, productId);
    if (free) {
      return {
        productId: free.product_id,
        productVersion: free.product_version,
        source: 'free',
        grantedAt: free.granted_at
      };
    }
    const paid = this.entitlementFor(accountId, productId);
    return paid ? { ...paid, source: 'paid' } : null;
  }

  claimFree(accountId, productId) {
    const row = this.productRow(productId);
    if (!row || row.status !== 'published') {
      throw new LocalMarketError('PRODUCT_NOT_FOUND', '商品不存在或尚未上架', 404);
    }
    if (row.charging_mode !== 'free') {
      throw new LocalMarketError('FREE_PRODUCT_REQUIRED', '该商品不是免费商品', 409);
    }
    if (!row.active_version) {
      throw new LocalMarketError('PRODUCT_VERSION_NOT_FOUND', '商品尚未上传可用版本', 409);
    }
    const existing = this.entitlement(accountId, productId);
    if (existing) return { entitlement: existing, duplicate: true };
    const grantedAt = this.serverTime();
    this.database.prepare(`
      INSERT INTO pet_market_free_entitlements
        (account_id, product_id, product_version, granted_at)
      VALUES (?, ?, ?, ?)
    `).run(accountId, productId, row.active_version, grantedAt);
    return { entitlement: this.entitlement(accountId, productId), duplicate: false };
  }

  createOrder(accountId, productId) {
    if (this.hasEntitlement(accountId, productId)) {
      throw new LocalMarketError('ALREADY_ENTITLED', '该账号已经拥有此商品', 409);
    }
    const row = this.productRow(productId);
    if (!row || row.status !== 'published') {
      throw new LocalMarketError('PRODUCT_NOT_FOUND', '商品不存在或尚未上架', 404);
    }
    if (row.charging_mode !== 'paid') {
      throw new LocalMarketError('PAID_PRODUCT_REQUIRED', '免费商品不需要创建付款订单', 409);
    }
    return super.createOrder(accountId, productId);
  }

  catalogForAccount(accountId = null) {
    const rows = this.database.prepare(`
      SELECT * FROM pet_market_products WHERE status IN ('published', 'unlisted')
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `).all();
    const products = rows.map((row) => {
      const versionRow = row.active_version ? this.versionRow(row.id, row.active_version) : null;
      if (!versionRow) return null;
      const version = mapVersion(versionRow);
      const entitlement = accountId ? this.entitlement(accountId, row.id) : null;
      const owned = Boolean(entitlement);
      if (row.status === 'unlisted' && !owned) return null;
      const previewPaths = JSON.parse(row.preview_paths_json || '[]');
      const selectedPreviewPaths = row.status !== 'published' || row.preview_mode === 'none'
        ? []
        : row.preview_mode === 'selected'
          ? previewPaths
          : version.files.slice(0, 5).map((item) => item.path);
      return {
        ...mapProduct(row),
        versions: undefined,
        assetCount: version.assetCount,
        previewPaths: selectedPreviewPaths,
        previewFiles: selectedPreviewPaths.map((previewPath) => version.files.find((item) => item.path === previewPath))
          .filter(Boolean),
        owned,
        entitlementVersion: entitlement?.productVersion || null,
        ownedVersion: entitlement?.productVersion || null,
        claimable: Boolean(accountId && !owned && row.charging_mode === 'free'),
        purchasable: Boolean(accountId && !owned && row.charging_mode === 'paid'),
        downloadable: owned,
        activationRequired: !accountId
      };
    }).filter(Boolean);
    return {
      generatedAt: this.serverTime(),
      defaultProductId: products.find((item) => item.isDefault)?.id || null,
      products
    };
  }

  versionForDownload(accountId, productId, requestedVersion = '') {
    const entitlement = this.entitlement(accountId, productId);
    if (!entitlement) {
      throw new LocalMarketError('ENTITLEMENT_REQUIRED', '需要先领取或购买此商品', 403);
    }
    const product = this.productRow(productId);
    if (!product || product.status === 'draft') {
      throw new LocalMarketError('PRODUCT_NOT_FOUND', '商品不存在', 404);
    }
    const versionName = entitlement.productVersion;
    if (requestedVersion && requestedVersion !== versionName) {
      throw new LocalMarketError('ENTITLEMENT_VERSION_MISMATCH', '当前权益不包含该商品版本', 403);
    }
    const versionRow = this.versionRow(productId, versionName);
    if (!versionRow) {
      throw new LocalMarketError('PRODUCT_VERSION_NOT_FOUND', '商品版本不存在', 404);
    }
    const version = mapVersion(versionRow);
    return {
      product: mapProduct(product),
      version,
      entitlement,
      filePath: this.versionPath(versionRow)
    };
  }

  previewFile(productId, versionName, requestedPath) {
    const product = this.productRow(productId);
    if (!product || product.status !== 'published' || product.active_version !== versionName) {
      throw new LocalMarketError('PREVIEW_NOT_FOUND', '预览文件不存在', 404);
    }
    const versionRow = this.versionRow(productId, versionName);
    if (!versionRow) throw new LocalMarketError('PREVIEW_NOT_FOUND', '预览文件不存在', 404);
    const version = mapVersion(versionRow);
    const configured = product.preview_mode === 'none'
      ? []
      : product.preview_mode === 'selected'
        ? JSON.parse(product.preview_paths_json || '[]')
        : version.files.slice(0, 5).map((item) => item.path);
    if (!configured.includes(requestedPath)) {
      throw new LocalMarketError('PREVIEW_NOT_FOUND', '预览文件不存在', 404);
    }
    const file = version.files.find((item) => item.path === requestedPath);
    if (!file) throw new LocalMarketError('PREVIEW_NOT_FOUND', '预览文件不存在', 404);
    return { filePath: this.versionPath(versionRow), file, product: mapProduct(product), version };
  }
}

module.exports = { PetMarketStore, mapProduct, mapVersion };
