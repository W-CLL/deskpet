const crypto = require('node:crypto');
const { CONTENT_TYPES } = require('../../lib/content-store');
const { compareVersions } = require('../../lib/storage');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');

const CONTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_BATCH_SIZE = 30;
const MAX_CLIENT_EXCLUSIONS = 500;
const MAX_IMPORT_ITEMS = 500;
const RECENT_CONTENT_DAYS = 30;
const LEGACY_CONTENT_TYPES = Object.freeze(['joke', 'math', 'trivia']);
const SIX_TYPE_MINIMUM_VERSION = Object.freeze({ windows: '2.5.2' });

function cleanSingleLine(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, maxLength);
}

function contentError(message, code = 'INVALID_CONTENT_ITEM') {
  return new HttpError(400, message, code);
}

function supportedContentTypes(req) {
  const platform = cleanSingleLine(req.headers['x-deskpet-platform'], 20).toLowerCase();
  const version = cleanSingleLine(req.headers['x-deskpet-version'], 40);
  const minimumVersion = SIX_TYPE_MINIMUM_VERSION[platform];
  if (!minimumVersion || !version) return [...LEGACY_CONTENT_TYPES];
  try {
    return compareVersions(version, minimumVersion) >= 0
      ? [...CONTENT_TYPES]
      : [...LEGACY_CONTENT_TYPES];
  } catch {
    return [...LEGACY_CONTENT_TYPES];
  }
}

function normalizeStringArray(value, { maximum, itemLength, label }) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw contentError(`${label}最多允许 ${maximum} 项`);
  }
  const items = value.map((item) => cleanSingleLine(item, itemLength)).filter(Boolean);
  if (items.length !== value.length || new Set(items).size !== items.length) {
    throw contentError(`${label}包含空值或重复项`);
  }
  return items;
}

function normalizeContentItem(source, { requireId = false, index = null } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw contentError(index === null ? '内容格式无效' : `第 ${index + 1} 条内容格式无效`);
  }
  const prefix = index === null ? '' : `第 ${index + 1} 条内容`;
  const rawId = cleanSingleLine(source.id, 128);
  if ((requireId || rawId) && !CONTENT_ID_PATTERN.test(rawId)) {
    throw contentError(`${prefix} ID 无效`);
  }
  const type = cleanSingleLine(source.type, 20).toLowerCase();
  if (!CONTENT_TYPES.includes(type)) throw contentError(`${prefix}类型无效`);
  const prompt = cleanMultiline(source.prompt, 500);
  const answer = cleanMultiline(source.answer, 500);
  const explanation = cleanMultiline(source.explanation, 1000);
  if (prompt.length < 2) throw contentError(`${prefix}题面至少需要 2 个字符`);
  if (!answer) throw contentError(`${prefix}答案不能为空`);
  const choices = normalizeStringArray(source.choices, {
    maximum: 6,
    itemLength: 200,
    label: `${prefix}选项`
  });
  if (choices.length > 0 && (choices.length < 2 || !choices.includes(answer))) {
    throw contentError(`${prefix}选项至少两项且必须包含答案`);
  }
  const tags = normalizeStringArray(source.tags, {
    maximum: 10,
    itemLength: 30,
    label: `${prefix}标签`
  });
  const difficulty = Number(source.difficulty ?? 1);
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
    throw contentError(`${prefix}难度必须为 1 至 5`);
  }
  const locale = cleanSingleLine(source.locale || 'zh-CN', 40);
  if (!LOCALE_PATTERN.test(locale)) throw contentError(`${prefix}语言标识无效`);
  if (source.active !== undefined && typeof source.active !== 'boolean') {
    throw contentError(`${prefix}启用状态必须是布尔值`);
  }
  const revision = source.revision === undefined ? undefined : Number(source.revision);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw contentError(`${prefix} revision 无效`);
  }
  return {
    ...(rawId ? { id: rawId } : {}),
    type,
    prompt,
    answer,
    explanation,
    choices,
    tags,
    difficulty,
    locale,
    active: source.active ?? true,
    ...(revision === undefined ? {} : { revision })
  };
}

function canonicalContentPayload(payload) {
  return Buffer.from(JSON.stringify({
    schemaVersion: payload.schemaVersion,
    kind: payload.kind,
    catalogVersion: payload.catalogVersion,
    catalogUpdatedAt: payload.catalogUpdatedAt,
    items: payload.items,
    disabledIds: payload.disabledIds
  }), 'utf8');
}

class ContentService {
  constructor({
    config,
    contentStore,
    interactionStore,
    activationService,
    auditService,
    signingPrivateKey
  }) {
    this.config = config;
    this.contentStore = contentStore;
    this.interactionStore = interactionStore;
    this.activationService = activationService;
    this.auditService = auditService;
    this.signingPrivateKey = signingPrivateKey;
  }

  signedPayload(kind, items) {
    const catalog = this.contentStore.catalog();
    const payload = {
      schemaVersion: 1,
      kind,
      catalogVersion: catalog.version,
      catalogUpdatedAt: catalog.updatedAt,
      items,
      disabledIds: this.contentStore.disabledIds()
    };
    const bytes = canonicalContentPayload(payload);
    return {
      ...payload,
      signedPayload: bytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      signatureAlgorithm: 'ed25519',
      signature: crypto.sign(null, bytes, this.signingPrivateKey).toString('base64')
    };
  }

  batch(req, body) {
    const license = this.activationService.requireLicense(req);
    const supportedTypes = supportedContentTypes(req);
    const requestedTypes = body?.types === undefined ? supportedTypes : body.types;
    if (!Array.isArray(requestedTypes) || requestedTypes.length < 1) {
      throw contentError('至少选择一种内容类型', 'INVALID_CONTENT_BATCH');
    }
    const types = [...new Set(requestedTypes.map((type) => cleanSingleLine(type, 20).toLowerCase()))];
    if (types.some((type) => !supportedTypes.includes(type))) {
      throw contentError('内容类型无效', 'INVALID_CONTENT_BATCH');
    }
    const limit = Number(body?.limit ?? 15);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw contentError(`每批内容数量必须为 1 至 ${MAX_BATCH_SIZE}`, 'INVALID_CONTENT_BATCH');
    }
    const clientExclusions = body?.excludeIds || [];
    if (!Array.isArray(clientExclusions) || clientExclusions.length > MAX_CLIENT_EXCLUSIONS) {
      throw contentError('客户端排除列表过长', 'INVALID_CONTENT_BATCH');
    }
    const normalizedExclusions = clientExclusions.map((id) => cleanSingleLine(id, 128));
    if (normalizedExclusions.some((id) => !CONTENT_ID_PATTERN.test(id))) {
      throw contentError('客户端排除列表包含无效 ID', 'INVALID_CONTENT_BATCH');
    }
    const since = new Date(Date.now() - RECENT_CONTENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const recentIds = this.interactionStore.recentContentIds(license.accountId, since)
      .map((item) => item.contentId);
    const items = this.contentStore.selectBatch(
      types,
      [...normalizedExclusions, ...recentIds],
      limit
    );
    return this.signedPayload('batch', items);
  }

  offlinePack(req) {
    this.activationService.requireLicense(req);
    const supportedTypes = new Set(supportedContentTypes(req));
    const items = this.contentStore.activeItems().filter((item) => supportedTypes.has(item.type));
    return this.signedPayload('offline-pack', items);
  }

  listAll() {
    return this.contentStore.listAll();
  }

  async create(req, body) {
    const item = normalizeContentItem(body);
    let result;
    try {
      result = this.contentStore.create(item);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        throw new HttpError(409, '内容 ID 已存在', 'CONTENT_ID_EXISTS');
      }
      throw error;
    }
    await this.auditService.write({
      action: 'content-create',
      outcome: 'success',
      ip: clientIp(req, this.config),
      contentId: result.item.id,
      contentType: result.item.type,
      catalogVersion: result.catalog.version
    });
    return result;
  }

  async update(req, id, body, auditAction = 'content-update') {
    const existing = this.contentStore.get(id);
    if (!existing) throw new HttpError(404, '内容不存在', 'CONTENT_NOT_FOUND');
    const item = normalizeContentItem({ ...existing, ...body, id });
    const result = this.contentStore.update(id, item);
    await this.auditService.write({
      action: auditAction,
      outcome: 'success',
      ip: clientIp(req, this.config),
      contentId: id,
      contentType: result.item.type,
      changed: result.changed,
      catalogVersion: result.catalog.version
    });
    return result;
  }

  async disable(req, id) {
    return this.update(req, id, { active: false }, 'content-disable');
  }

  async import(req, body) {
    if (!Array.isArray(body?.items) || body.items.length < 1
      || body.items.length > MAX_IMPORT_ITEMS) {
      throw contentError(
        `导入文件必须包含 1 至 ${MAX_IMPORT_ITEMS} 条内容`,
        'INVALID_CONTENT_IMPORT'
      );
    }
    if (body.disableMissing !== undefined && typeof body.disableMissing !== 'boolean') {
      throw contentError('disableMissing 必须是布尔值', 'INVALID_CONTENT_IMPORT');
    }
    const items = body.items.map((item, index) => normalizeContentItem(item, {
      requireId: true,
      index
    }));
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw contentError('导入文件包含重复 ID', 'INVALID_CONTENT_IMPORT');
    }
    const result = this.contentStore.importItems(items, {
      disableMissing: body.disableMissing === true
    });
    await this.auditService.write({
      action: 'content-import',
      outcome: 'success',
      ip: clientIp(req, this.config),
      itemCount: items.length,
      disableMissing: body.disableMissing === true,
      ...result
    });
    return result;
  }
}

module.exports = {
  CONTENT_ID_PATTERN,
  MAX_IMPORT_ITEMS,
  LEGACY_CONTENT_TYPES,
  ContentService,
  canonicalContentPayload,
  normalizeContentItem,
  supportedContentTypes
};
