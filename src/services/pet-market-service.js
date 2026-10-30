const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { LocalMarketError } = require('../../lib/local-market-store');
const { parseStrictZip, validatePetMarketPackage } = require('../../lib/pet-market-package');
const { validateGifUploadFiles, createPetMarketPackageFromFiles } = require('../../lib/pet-market-upload');
const { normalizePetMarketPaymentSettings } = require('../../lib/pet-market-payment-settings');
const { equalText, randomToken } = require('../../lib/security');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');
const { UPLOAD_TTL_MS } = require('../config/app-config');

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ORDER_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const EVENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_PACKAGE_SIZE = 64 * 1024 * 1024;
const MAX_PENDING_UPLOADS = 20;
const SIGNED_GRANT_TTL_MS = 10 * 60 * 1000;
// Structured source reads and bounded Busy retries can take over 30 seconds.
// Only server receipt time renews this lease; explicit failures still invalidate it immediately.
const PAYMENT_HEARTBEAT_TTL_MS = 60 * 1000;
const PAYMENT_FIELDS = Object.freeze([
  'eventKey', 'accountId', 'category', 'direction', 'status', 'amountFen',
  'currency', 'reference', 'transactionId', 'occurredAt', 'observedAt', 'verified'
]);

function canonicalPetMarketPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function cleanText(value, maximum, fieldName, { allowEmpty = false } = {}) {
  const text = String(value ?? '').replace(/\r/g, '').trim();
  if ((!allowEmpty && !text) || text.length > maximum) {
    const requirement = allowEmpty ? `不能超过 ${maximum}` : `不能为空且不能超过 ${maximum}`;
    throw new HttpError(400, `${fieldName}${requirement} 个字符`, 'INVALID_PET_MARKET_PRODUCT');
  }
  return text;
}

function safeInteger(value, fieldName, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new HttpError(400, `${fieldName}无效`, 'INVALID_PET_MARKET_PRODUCT');
  }
  return number;
}

function objectBody(body, allowedFields, code = 'INVALID_REQUEST') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求内容必须是 JSON 对象', code);
  }
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new HttpError(400, `请求包含不支持的字段：${unexpected.join(',')}`, code);
  }
  return body;
}

function marketError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof LocalMarketError) {
    return new HttpError(error.status || 400, error.message, error.code || 'PET_MARKET_FAILED');
  }
  if (error?.code === 'INVALID_PET_MARKET_PACKAGE') {
    return new HttpError(400, error.message, error.code);
  }
  if (error?.code === 'INVALID_PET_MARKET_PAYMENT_SETTINGS') {
    return new HttpError(400, error.message, error.code);
  }
  if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
    return new HttpError(409, '商品状态与现有数据冲突', 'PET_MARKET_CONFLICT');
  }
  return error;
}

function normalizePreviewPaths(value) {
  if (!Array.isArray(value) || value.length > 5) {
    throw new HttpError(400, '精选预览最多允许 5 个文件', 'INVALID_PET_MARKET_PRODUCT');
  }
  const paths = value.map((item) => String(item || '').trim());
  if (paths.some((item) => !item || item.includes('\\') || item.startsWith('/')
      || item.split('/').some((part) => !part || part === '.' || part === '..')
      || !/\.gif$/i.test(item)) || new Set(paths).size !== paths.length) {
    throw new HttpError(400, '预览文件必须是唯一的安全 GIF 相对路径', 'INVALID_PET_MARKET_PRODUCT');
  }
  return paths;
}

function normalizeTags(value) {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new HttpError(400, '桌宠标签必须是文字数组', 'INVALID_PET_MARKET_PRODUCT');
  }
  const tags = [...new Set(value.map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length > 4 || tags.some((tag) => [...tag].length > 12 || /[\x00-\x1f\x7f]/.test(tag))) {
    throw new HttpError(400, '最多设置 4 个标签，每个不超过 12 个字符且不能包含控制字符', 'INVALID_PET_MARKET_PRODUCT');
  }
  return tags;
}

function bearerToken(header) {
  const match = /^Bearer ([^\s]+)$/.exec(String(header || '').trim());
  return match ? match[1] : '';
}

class PetMarketService {
  constructor({ config, petMarketStore, activationService, activationStore, companionStore,
    auditService, signingPrivateKey }) {
    this.config = config;
    this.petMarketStore = petMarketStore;
    this.activationService = activationService;
    this.activationStore = activationStore || activationService.activationStore;
    this.companionStore = companionStore || activationService.companionStore;
    this.auditService = auditService;
    this.signingPrivateKey = signingPrivateKey;
    this.pendingUploads = new Map();
    this.paymentListener = null;
  }

  paymentStatus(target = this.petMarketStore.paymentSettings(), binding = this.config.petMarketCollectionAccountId) {
    const current = this.petMarketStore.paymentSettings();
    const configured = Boolean(this.config.petMarketBridgeToken && this.config.petMarketCollectionAccountId
      && this.config.petMarketCollectionAccountId !== 'local-demo-collection');
    const heartbeat = this.paymentListener;
    const age = heartbeat ? this.petMarketStore.now() - heartbeat.receivedAt : Infinity;
    const sourceReady = target.method === 'personal_transfer'
      ? heartbeat?.transferReady && heartbeat?.transferPollSuccess
      : heartbeat?.noticeReady && heartbeat?.noticePollSuccess;
    const listenerOnline = Boolean(configured && heartbeat && age >= 0 && age <= PAYMENT_HEARTBEAT_TTL_MS
      && heartbeat.accountId === this.config.petMarketCollectionAccountId && sourceReady && !heartbeat.pollLimitSaturated);
    const targetComplete = Boolean(target.recipientName && (target.method === 'personal_transfer'
      ? target.recipientAccount : target.qrCodeDataUrl));
    let unavailableReason = '';
    if (!current.enabled) unavailableReason = '商家暂未开启收款，请稍后再试';
    else if (!configured) unavailableReason = '商家收款服务尚未配置完成';
    else if (!targetComplete) unavailableReason = '商家收款信息尚未填写完整';
    else if (binding !== this.config.petMarketCollectionAccountId) unavailableReason = '此订单的原收款目标当前不可用，请联系商家；请勿向其他账号付款';
    else if (!listenerOnline) unavailableReason = '收款监听暂未连接，请稍后再试，不要付款';
    return { enabled: current.enabled, available: !unavailableReason, method: target.method,
      recipientName: target.recipientName, recipientAccount: target.recipientAccount,
      qrCodeDataUrl: target.qrCodeDataUrl, instructions: target.instructions, listenerOnline, unavailableReason };
  }

  paymentSettings() {
    return { payment: this.paymentStatus() };
  }

  async savePaymentSettings(req, body) {
    try {
      const settings = normalizePetMarketPaymentSettings(body);
      this.petMarketStore.savePaymentSettings(settings);
      await this.auditService.write({ action: 'pet-market-payment-settings', outcome: 'success',
        ip: clientIp(req, this.config), enabled: settings.enabled, method: settings.method });
      return this.paymentSettings();
    } catch (error) { throw marketError(error); }
  }

  paymentHeartbeat(req, body) {
    this.requirePaymentBridge(req);
    const fields = ['accountId', 'noticeReady', 'transferReady', 'noticePollSuccess', 'transferPollSuccess', 'pollLimitSaturated'];
    objectBody(body, fields, 'INVALID_PAYMENT_HEARTBEAT');
    if (typeof body.accountId !== 'string' || body.accountId !== this.config.petMarketCollectionAccountId
        || body.accountId === 'local-demo-collection') {
      throw new HttpError(403, '收款监听账号不匹配', 'PAYMENT_HEARTBEAT_ACCOUNT_MISMATCH');
    }
    if (fields.slice(1).some(field => typeof body[field] !== 'boolean')) {
      throw new HttpError(400, '收款监听状态必须是布尔值', 'INVALID_PAYMENT_HEARTBEAT');
    }
    this.paymentListener = { ...body, receivedAt: this.petMarketStore.now() };
    const payment = this.paymentStatus();
    return { ok: true, receivedAt: this.petMarketStore.serverTime(), listenerOnline: payment.listenerOnline,
      available: payment.available };
  }

  attachOrderPayment(result) {
    let snapshot = this.petMarketStore.paymentSnapshot(result.order.id);
    if (!snapshot && result.order.status !== 'pending_payment') {
      return { ...result, order: { ...result.order, payment: null } };
    }
    if (!snapshot && result.order.status === 'pending_payment' && this.paymentStatus().available) {
      snapshot = this.petMarketStore.ensurePaymentSnapshot(result.order.id, this.petMarketStore.paymentSettings());
    }
    let payment = snapshot ? this.paymentStatus(snapshot.payment, snapshot.collectionAccountId) : this.paymentStatus();
    if (!snapshot && result.order.status === 'pending_payment') {
      payment = { ...payment, available: false, unavailableReason: payment.unavailableReason
        || '此订单的原收款目标当前不可用，请联系商家后再付款' };
    } else if (result.order.status !== 'pending_payment') {
      payment = { ...payment, available: false, unavailableReason: '此订单已结束，请勿继续付款' };
    }
    return { ...result, order: { ...result.order, payment } };
  }

  validateProduct(body, existing = null) {
    const fields = [
      'id', 'title', 'description', 'chargingMode', 'priceFen', 'status',
      'isDefault', 'tags', 'isFeatured', 'sortOrder', 'previewMode', 'previewPaths'
    ];
    objectBody(body, fields, 'INVALID_PET_MARKET_PRODUCT');
    const merged = { ...(existing || {}), ...body };
    const id = String(merged.id || existing?.id || '').trim();
    if (!PRODUCT_ID_PATTERN.test(id) || (existing && id !== existing.id)) {
      throw new HttpError(400, '商品 ID 格式无效且创建后不能修改', 'INVALID_PET_MARKET_PRODUCT');
    }
    const chargingMode = String(merged.chargingMode || '');
    if (!['free', 'paid'].includes(chargingMode)) {
      throw new HttpError(400, '收费方式必须为 free 或 paid', 'INVALID_PET_MARKET_PRODUCT');
    }
    const priceFen = safeInteger(merged.priceFen, '商品价格', { maximum: 580 });
    if ((chargingMode === 'free' && priceFen !== 0)
        || (chargingMode === 'paid' && ![280, 580].includes(priceFen))) {
      throw new HttpError(400, '免费商品价格必须为 0，付费商品只能为 280 或 580 分', 'INVALID_PET_MARKET_PRICE');
    }
    const status = String(merged.status || '');
    if (!['draft', 'published', 'unlisted'].includes(status)) {
      throw new HttpError(400, '商品状态无效', 'INVALID_PET_MARKET_PRODUCT');
    }
    if (typeof merged.isDefault !== 'boolean') {
      throw new HttpError(400, '默认商品标记必须是布尔值', 'INVALID_PET_MARKET_PRODUCT');
    }
    const tags = normalizeTags(merged.tags === undefined ? [] : merged.tags);
    const isFeatured = merged.isFeatured === undefined ? false : merged.isFeatured;
    if (typeof isFeatured !== 'boolean') {
      throw new HttpError(400, '精选标记必须是布尔值', 'INVALID_PET_MARKET_PRODUCT');
    }
    const sortOrder = safeInteger(merged.sortOrder, '排序值', { minimum: -100000, maximum: 100000 });
    const previewMode = String(merged.previewMode || '');
    if (!['first5', 'selected', 'none'].includes(previewMode)) {
      throw new HttpError(400, '预览方式无效', 'INVALID_PET_MARKET_PRODUCT');
    }
    const previewPaths = previewMode === 'selected'
      ? normalizePreviewPaths(merged.previewPaths)
      : [];
    const activeVersion = existing?.activeVersion || '';
    const activeFiles = existing?.versions?.find((item) => item.version === activeVersion)?.files || [];
    if (previewMode === 'selected') {
      if (!activeVersion || previewPaths.some((item) => !activeFiles.some((file) => file.path === item))) {
        throw new HttpError(400, '精选预览必须来自当前已上传版本', 'INVALID_PET_MARKET_PREVIEW');
      }
    }
    if (merged.isDefault && (chargingMode !== 'free' || priceFen !== 0
        || status !== 'published' || !activeVersion)) {
      throw new HttpError(
        409,
        '默认桌宠必须免费、已发布且已上传有效版本',
        'INVALID_DEFAULT_PET_PRODUCT'
      );
    }
    if (existing?.isDefault && merged.isDefault === false) {
      throw new HttpError(409, '请直接把另一个有效商品设为默认，不能留下无默认商品状态', 'DEFAULT_PET_REQUIRED');
    }
    return {
      id,
      title: cleanText(merged.title, 80, '商品标题'),
      description: cleanText(merged.description, 600, '商品简介', { allowEmpty: true }),
      chargingMode,
      priceFen,
      status,
      isDefault: merged.isDefault,
      tags,
      isFeatured,
      sortOrder,
      previewMode,
      previewPaths
    };
  }

  listProducts() {
    const publicProducts = new Map(this.petMarketStore.catalogForAccount().products
      .map((product) => [product.id, product]));
    return {
      products: this.petMarketStore.listProducts().map((product) => ({
        ...product,
        previewFiles: this.previewFilesWithUrls(publicProducts.get(product.id) || { ...product, previewFiles: [] })
      }))
    };
  }

  async createProduct(req, body) {
    try {
      const product = this.petMarketStore.createProduct(this.validateProduct(body));
      await this.auditService.write({
        action: 'pet-market-product-create', outcome: 'success',
        ip: clientIp(req, this.config), productId: product.id
      });
      return { product };
    } catch (error) {
      throw marketError(error);
    }
  }

  async updateProduct(req, productId, body) {
    try {
      const existing = this.petMarketStore.findProduct(productId);
      if (!existing) throw new HttpError(404, '商品不存在', 'PET_PRODUCT_NOT_FOUND');
      const product = this.petMarketStore.updateProduct(
        productId,
        this.validateProduct(body, existing)
      );
      await this.auditService.write({
        action: 'pet-market-product-update', outcome: 'success',
        ip: clientIp(req, this.config), productId
      });
      return { product };
    } catch (error) {
      throw marketError(error);
    }
  }

  createVersionUpload(productId, body, session) {
    objectBody(body, ['version', 'fileName', 'fileSize', 'sourceType', 'files'], 'INVALID_PET_MARKET_UPLOAD');
    if (this.pendingUploads.size >= MAX_PENDING_UPLOADS) {
      throw new HttpError(429, '当前桌宠上传任务较多，请稍后重试', 'UPLOAD_QUEUE_FULL');
    }
    const product = this.petMarketStore.findProduct(productId);
    if (!product) throw new HttpError(404, '商品不存在', 'PET_PRODUCT_NOT_FOUND');
    const version = String(body.version || '').trim();
    if (!VERSION_PATTERN.test(version)) {
      throw new HttpError(400, '商品版本格式无效', 'INVALID_PET_MARKET_VERSION');
    }
    if (product.versions.some((item) => item.version === version)) {
      throw new HttpError(409, '该商品版本已经存在', 'PRODUCT_VERSION_EXISTS');
    }
    const sourceType = body.sourceType === undefined ? 'zip' : body.sourceType;
    if (!['zip', 'gif-files'].includes(sourceType) || (sourceType === 'zip' && body.files !== undefined)) {
      throw new HttpError(400, '上传类型必须为 ZIP 或 GIF 文件', 'INVALID_PET_MARKET_UPLOAD');
    }
    let files;
    if (sourceType === 'gif-files') {
      try {
        const selection = validateGifUploadFiles(body.files);
        files = selection.files;
        if (selection.totalBytes !== body.fileSize) {
          throw new HttpError(400, 'GIF 文件总大小与登记信息不一致', 'UPLOAD_SIZE_MISMATCH');
        }
      } catch (error) {
        throw marketError(error);
      }
    }
    const originalName = path.basename(String(body.fileName
      || (sourceType === 'gif-files' ? `${productId}-${version}.zip` : ''))).slice(0, 160);
    const fileSize = Number(body.fileSize);
    if (!originalName.toLowerCase().endsWith('.zip')) {
      throw new HttpError(400, '只允许上传 ZIP 桌宠包', 'INVALID_FILE_TYPE');
    }
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0
        || fileSize > Math.min(this.config.maxUploadSize, MAX_PACKAGE_SIZE)) {
      throw new HttpError(400, '桌宠包大小无效或超过 64 MB', 'INVALID_FILE_SIZE');
    }
    const uploadId = randomToken(24);
    this.pendingUploads.set(uploadId, {
      sessionToken: session.token,
      productId,
      title: product.title,
      version,
      originalName,
      fileSize,
      sourceType,
      files,
      expiresAt: Date.now() + UPLOAD_TTL_MS
    });
    return { uploadId, uploadUrl: `/api/admin/pet-market/product-uploads/${uploadId}` };
  }

  async receiveVersionUpload(req, uploadId, session) {
    const pending = this.pendingUploads.get(uploadId);
    if (!pending || pending.expiresAt <= Date.now() || pending.sessionToken !== session.token) {
      this.pendingUploads.delete(uploadId);
      throw new HttpError(404, '上传任务不存在或已过期', 'UPLOAD_NOT_FOUND');
    }
    const contentLength = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(contentLength) || contentLength !== pending.fileSize) {
      throw new HttpError(400, '上传文件大小与登记信息不一致', 'UPLOAD_SIZE_MISMATCH');
    }
    if (req.headers['content-encoding']) {
      throw new HttpError(400, '上传文件不能使用内容编码', 'UPLOAD_ENCODING_REJECTED');
    }
    const temporaryPath = this.petMarketStore.uploadPath(uploadId);
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > pending.fileSize || received > MAX_PACKAGE_SIZE) {
          callback(new HttpError(413, '桌宠包超过允许大小', 'UPLOAD_TOO_LARGE'));
          return;
        }
        callback(null, chunk);
      }
    });
    this.pendingUploads.delete(uploadId);
    try {
      await pipeline(req, meter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
      if (received !== pending.fileSize) {
        throw new HttpError(400, '上传未完整完成', 'UPLOAD_INCOMPLETE');
      }
      const buffer = await fs.promises.readFile(temporaryPath);
      const expected = {
        productId: pending.productId,
        version: pending.version,
        title: pending.title
      };
      let packageInfo;
      if (pending.sourceType === 'gif-files') {
        const assembled = createPetMarketPackageFromFiles(buffer, pending.files, expected);
        if (assembled.archive.length > this.config.maxUploadSize) {
          throw new HttpError(413, '组包后的桌宠 ZIP 超过上传大小限制', 'UPLOAD_TOO_LARGE');
        }
        packageInfo = assembled.packageInfo;
        await fs.promises.writeFile(temporaryPath, assembled.archive, { mode: 0o600 });
      } else {
        packageInfo = validatePetMarketPackage(buffer, expected);
      }
      const productBeforeCommit = this.petMarketStore.findProduct(pending.productId);
      if (productBeforeCommit.previewMode === 'selected'
          && productBeforeCommit.previewPaths.some((previewPath) => (
            !packageInfo.manifest.files.some((file) => file.path === previewPath)
          ))) {
        throw new HttpError(
          409,
          '新版本缺少当前配置的精选预览文件',
          'PET_MARKET_PREVIEW_MISSING'
        );
      }
      const version = await this.petMarketStore.commitVersion({
        temporaryPath,
        productId: pending.productId,
        version: pending.version,
        originalName: pending.originalName,
        packageInfo
      });
      await this.auditService.write({
        action: 'pet-market-version-upload', outcome: 'success',
        ip: clientIp(req, this.config), productId: pending.productId,
        version: pending.version, sha256: packageInfo.packageSha256
      });
      return { version, product: this.petMarketStore.findProduct(pending.productId) };
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      throw marketError(error);
    }
  }

  catalog(req) {
    const identity = this.activationService.authenticate(req);
    const catalog = this.petMarketStore.catalogForAccount(
      identity && !identity.trial ? identity.accountId : null
    );
    return {
      ...catalog,
      payment: this.paymentStatus(),
      products: catalog.products.map((product) => ({
        ...product,
        previewFiles: this.previewFilesWithUrls(product)
      }))
    };
  }

  previewFilesWithUrls(product) {
    return product.previewFiles.map((file) => {
      const downloadPath = `/api/pet-market/products/${encodeURIComponent(product.id)}/versions/${encodeURIComponent(product.activeVersion)}/preview?file=${encodeURIComponent(file.path)}`;
      return { ...file, url: new URL(downloadPath, this.config.publicUrl).href, downloadPath };
    });
  }

  async preview(productId, version, filePath) {
    if (!filePath || filePath.length > 240 || filePath.includes('\\')
        || filePath.startsWith('/') || filePath.split('/').some((part) => (
          !part || part === '.' || part === '..'
        ))) {
      throw new HttpError(404, '预览文件不存在', 'PREVIEW_NOT_FOUND');
    }
    try {
      const item = this.petMarketStore.previewFile(productId, version, filePath);
      const archive = await fs.promises.readFile(item.filePath);
      const entry = parseStrictZip(archive).find((candidate) => candidate.name === filePath);
      if (!entry || entry.data.length !== item.file.sizeBytes
          || crypto.createHash('sha256').update(entry.data).digest('hex') !== item.file.sha256) {
        throw new Error('桌宠预览文件完整性校验失败');
      }
      return { bytes: entry.data, file: item.file };
    } catch (error) {
      throw marketError(error);
    }
  }

  claim(req, productId) {
    const identity = this.activationService.requireActivatedLicense(req, true);
    try {
      const result = this.petMarketStore.claimFree(identity.accountId, productId);
      return {
        entitlement: result.entitlement,
        product: this.petMarketStore.findProduct(productId)
      };
    } catch (error) {
      throw marketError(error);
    }
  }

  createOrder(req, body) {
    const identity = this.activationService.requireActivatedLicense(req, true);
    objectBody(body, ['productId']);
    const productId = String(body.productId || '').trim();
    const product = this.petMarketStore.findProduct(productId);
    if (!product || product.status !== 'published') {
      throw new HttpError(404, '商品不存在或尚未上架', 'PRODUCT_NOT_FOUND');
    }
    if (product.chargingMode !== 'paid') {
      throw new HttpError(409, '免费商品不需要创建付款订单', 'PAID_PRODUCT_REQUIRED');
    }
    try {
      const existing = this.petMarketStore.pendingOrderId(identity.accountId, productId);
      if (existing) return { ...this.attachOrderPayment(this.petMarketStore.getOrder(identity.accountId, existing)), reused: true };
      const payment = this.paymentStatus();
      if (!payment.available) throw new HttpError(503, payment.unavailableReason, 'PAYMENT_UNAVAILABLE');
      return this.attachOrderPayment(this.petMarketStore.createOrderWithPayment(
        identity.accountId, productId, this.petMarketStore.paymentSettings(), {
          licenseId: identity.id,
          installationId: identity.installationId,
          platform: identity.platform,
          displayName: this.companionStore?.findDisplayName(identity.accountId) || null
        }
      ));
    } catch (error) {
      throw marketError(error);
    }
  }

  listOrders(req, cursorText = '') {
    const identity = this.activationService.requireActivatedLicense(req);
    try {
      let cursor = null;
      if (cursorText) {
        try {
          if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursorText)) throw new Error();
          const bytes = Buffer.from(cursorText, 'base64url');
          if (bytes.toString('base64url') !== cursorText) throw new Error();
          cursor = JSON.parse(bytes.toString('utf8'));
          if (!cursor || typeof cursor !== 'object' || Object.keys(cursor).length !== 2
              || !ORDER_ID_PATTERN.test(cursor.id || '') || typeof cursor.createdAt !== 'string'
              || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new Error();
        } catch { throw new HttpError(400, '订单分页游标无效', 'INVALID_ORDER_CURSOR'); }
      }
      const result = this.petMarketStore.ordersForAccount(identity.accountId, cursor);
      const orders = [];
      let size = 0;
      for (const row of result.orders) {
        if (orders.length === 100) break;
        const order = this.attachOrderPayment({ order: row }).order;
        if (order.status !== 'pending_payment' && order.payment) {
          order.payment = { ...order.payment, qrCodeDataUrl: '' };
        }
        const bytes = Buffer.byteLength(JSON.stringify(order), 'utf8') + 1;
        if (size + bytes > 700 * 1024) break;
        orders.push(order);
        size += bytes;
      }
      if (!orders.length && result.orders.length) {
        throw new HttpError(503, '订单信息过大，请联系商家', 'ORDER_HISTORY_ENTRY_TOO_LARGE');
      }
      const last = orders.at(-1);
      const nextCursor = orders.length < result.orders.length
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') : null;
      return { orders, serverTime: result.serverTime, nextCursor };
    } catch (error) { throw marketError(error); }
  }

  listAdminOrders(query = {}) {
    const status = String(query.status || '').trim();
    const q = String(query.q || '').trim();
    const pageText = String(query.page || '1').trim();
    const pageSizeText = String(query.pageSize || '25').trim();
    const page = Number(pageText);
    const pageSize = Number(pageSizeText);
    if (!['', 'pending_payment', 'paid', 'canceled', 'expired'].includes(status)
        || [...q].length > 100 || /[\x00-\x1f\x7f]/.test(q)
        || !/^[1-9][0-9]*$/.test(pageText) || !Number.isSafeInteger(page)
        || !/^[1-9][0-9]*$/.test(pageSizeText) || !Number.isSafeInteger(pageSize)
        || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) {
      throw new HttpError(400, '订单筛选参数无效：每页最多 100 条，搜索最多 100 个字符', 'INVALID_ORDER_QUERY');
    }
    try {
      return this.petMarketStore.adminOrders({ status, q, page, pageSize,
        currentBuyerNames: this.companionStore?.displayNameByAccountId() || new Map(),
        currentAccountDevices: this.activationStore?.orderBuyerDeviceReferences() || new Map()
      });
    } catch (error) { throw marketError(error); }
  }

  getOrder(req, orderId) {
    const identity = this.activationService.requireActivatedLicense(req);
    if (!ORDER_ID_PATTERN.test(String(orderId || ''))) {
      throw new HttpError(404, '订单不存在', 'NOT_FOUND');
    }
    try {
      return this.attachOrderPayment(this.petMarketStore.getOrder(identity.accountId, orderId));
    } catch (error) {
      throw marketError(error);
    }
  }

  confirmOrderPayment(orderId, body, confirmedBy) {
    if (!ORDER_ID_PATTERN.test(String(orderId || ''))) {
      throw new HttpError(404, '订单不存在', 'NOT_FOUND');
    }
    objectBody(body, ['note', 'expectedAmountFen', 'received'], 'INVALID_PAYMENT_CONFIRMATION');
    const note = typeof body.note === 'string' ? body.note.replace(/\r/g, '').trim() : '';
    if (!note || note.length > 600 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note)) {
      throw new HttpError(400, '请填写核对说明，最多 600 个字符', 'INVALID_PAYMENT_CONFIRMATION');
    }
    if (body.received !== true) {
      throw new HttpError(400, '请先确认已核实收到这笔订单对应的付款', 'PAYMENT_RECEIPT_CONFIRMATION_REQUIRED');
    }
    if (!Number.isSafeInteger(body.expectedAmountFen) || body.expectedAmountFen <= 0) {
      throw new HttpError(400, '核对金额必须是以分为单位的正整数', 'INVALID_PAYMENT_CONFIRMATION');
    }
    if (typeof confirmedBy !== 'string' || !confirmedBy.trim() || confirmedBy.length > 80) {
      throw new HttpError(401, '请先登录', 'AUTH_REQUIRED');
    }
    try {
      return this.petMarketStore.confirmOrderPayment(orderId, {
        note, expectedAmountFen: body.expectedAmountFen, confirmedBy
      });
    } catch (error) { throw marketError(error); }
  }

  cancelOrder(req, orderId) {
    const identity = this.activationService.requireActivatedLicense(req, true);
    if (!ORDER_ID_PATTERN.test(String(orderId || ''))) {
      throw new HttpError(404, '订单不存在', 'NOT_FOUND');
    }
    try {
      return this.attachOrderPayment(this.petMarketStore.cancelOrder(identity.accountId, orderId));
    } catch (error) {
      throw marketError(error);
    }
  }

  requirePaymentBridge(req) {
    if (!this.config.petMarketBridgeToken || !this.config.petMarketCollectionAccountId) {
      throw new HttpError(503, '付款服务暂未配置', 'PAYMENT_UNAVAILABLE');
    }
    const presented = bearerToken(req.headers.authorization);
    if (!presented) {
      throw new HttpError(401, '需要付款桥接令牌', 'PAYMENT_BRIDGE_AUTH_REQUIRED');
    }
    if (!equalText(presented, this.config.petMarketBridgeToken)) {
      throw new HttpError(403, '付款桥接令牌无效', 'PAYMENT_BRIDGE_FORBIDDEN');
    }
  }

  normalizePayment(body) {
    objectBody(body, PAYMENT_FIELDS, 'INVALID_PAYMENT_EVENT');
    for (const field of PAYMENT_FIELDS) {
      if (!(field in body)) {
        throw new HttpError(400, `付款事件缺少字段：${field}`, 'INVALID_PAYMENT_EVENT');
      }
    }
    const amountFen = body.amountFen === null ? null : Number(body.amountFen);
    if (amountFen !== null && (!Number.isSafeInteger(amountFen) || amountFen < 0)) {
      throw new HttpError(400, '付款金额无效', 'INVALID_PAYMENT_EVENT');
    }
    if (typeof body.verified !== 'boolean') {
      throw new HttpError(400, '付款来源验证标记无效', 'INVALID_PAYMENT_EVENT');
    }
    const requiredStrings = ['eventKey', 'accountId', 'category', 'direction', 'status', 'currency'];
    if (requiredStrings.some((field) => typeof body[field] !== 'string'
        || !body[field].trim() || body[field].length > 256)
        || typeof body.reference !== 'string' || body.reference.length > 256) {
      throw new HttpError(400, '付款事件文本字段无效', 'INVALID_PAYMENT_EVENT');
    }
    if (typeof body.transactionId !== 'string' || body.transactionId.length > 256) {
      throw new HttpError(400, '付款交易号无效', 'INVALID_PAYMENT_EVENT');
    }
    for (const field of ['observedAt']) {
      if (!body[field] || !Number.isFinite(Date.parse(body[field]))) {
        throw new HttpError(400, `${field} 时间无效`, 'INVALID_PAYMENT_EVENT');
      }
    }
    if (body.occurredAt !== null && body.occurredAt !== ''
        && !Number.isFinite(Date.parse(body.occurredAt))) {
      throw new HttpError(400, 'occurredAt 时间无效', 'INVALID_PAYMENT_EVENT');
    }
    return { ...body, amountFen };
  }

  paymentEvent(req, body) {
    this.requirePaymentBridge(req);
    try {
      return this.petMarketStore.recordPaymentEvent(this.normalizePayment(body));
    } catch (error) {
      throw marketError(error);
    }
  }

  listPaymentEvents() {
    return this.petMarketStore.listPaymentEvents();
  }

  reparsePaymentEvent(eventId, body) {
    if (!EVENT_ID_PATTERN.test(String(eventId || ''))) {
      throw new HttpError(404, '付款候选事件不存在', 'NOT_FOUND');
    }
    try {
      return this.petMarketStore.reparsePaymentEvent(eventId, this.normalizePayment(body));
    } catch (error) {
      throw marketError(error);
    }
  }

  confirmPaymentEvent(eventId, body) {
    if (!EVENT_ID_PATTERN.test(String(eventId || ''))) {
      throw new HttpError(404, '付款候选事件不存在', 'NOT_FOUND');
    }
    objectBody(body, ['orderId', 'note', 'transferReceived']);
    const orderId = String(body.orderId || '');
    if (!ORDER_ID_PATTERN.test(orderId)) {
      throw new HttpError(400, '订单 ID 无效', 'INVALID_PAYMENT_CONFIRMATION');
    }
    const note = cleanText(body.note, 600, '审核备注', { allowEmpty: true });
    try {
      return this.petMarketStore.confirmPaymentEvent(eventId, orderId, note, {
        transferReceived: body.transferReceived === true
      });
    } catch (error) {
      throw marketError(error);
    }
  }

  signedEnvelope(payload) {
    const bytes = canonicalPetMarketPayload(payload);
    return {
      payload,
      signedPayload: bytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      signatureAlgorithm: 'ed25519',
      signature: crypto.sign(null, bytes, this.signingPrivateKey).toString('base64')
    };
  }

  entitledPackage(req, productId, requestedVersion = '') {
    const identity = this.activationService.requireActivatedLicense(req, true);
    try {
      return {
        identity,
        item: this.petMarketStore.versionForDownload(
          identity.accountId,
          productId,
          requestedVersion
        )
      };
    } catch (error) {
      throw marketError(error);
    }
  }

  signedTimes() {
    const issuedAt = this.petMarketStore.serverTime();
    return {
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + SIGNED_GRANT_TTL_MS).toISOString()
    };
  }

  downloadDescriptor(req, productId) {
    const { identity, item } = this.entitledPackage(req, productId);
    const times = this.signedTimes();
    return this.signedEnvelope({
      schemaVersion: 1,
      kind: 'pet-market-download',
      accountId: identity.accountId,
      licenseId: identity.id,
      installationId: identity.installationId,
      productId,
      version: item.version.version,
      fileName: item.version.fileName,
      sizeBytes: item.version.sizeBytes,
      sha256: item.version.sha256,
      manifestSha256: item.version.manifestSha256,
      downloadPath: `/api/pet-market/products/${encodeURIComponent(productId)}/versions/${encodeURIComponent(item.version.version)}/download`,
      ...times
    });
  }

  authorizeUse(req, productId) {
    const { identity, item } = this.entitledPackage(req, productId);
    return this.signedEnvelope({
      schemaVersion: 1,
      kind: 'pet-market-use-grant',
      accountId: identity.accountId,
      licenseId: identity.id,
      installationId: identity.installationId,
      productId,
      version: item.version.version,
      manifestSha256: item.version.manifestSha256,
      ...this.signedTimes()
    });
  }

  download(req, productId, version) {
    return this.entitledPackage(req, productId, version).item;
  }

  cleanup() {
    const now = Date.now();
    for (const [uploadId, upload] of this.pendingUploads) {
      if (upload.expiresAt <= now) {
        this.pendingUploads.delete(uploadId);
        fs.promises.rm(this.petMarketStore.uploadPath(uploadId), { force: true }).catch(() => {});
      }
    }
  }
}

module.exports = {
  MAX_PACKAGE_SIZE,
  PetMarketService,
  canonicalPetMarketPayload,
  marketError
};
