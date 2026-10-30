const crypto = require('node:crypto');
const {
  INSTALL_EVENT_TYPES,
  INSTALL_STATES,
  UNINSTALL_REASONS
} = require('../../lib/uninstall-store');
const { cleanMultiline, cleanSingleLine } = require('../../lib/text');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,80}$/;
const VALID_PLATFORMS = new Set(['windows', 'macos']);
const TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;

function requiredUuid(value, label) {
  const normalized = cleanSingleLine(value, 80).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new HttpError(400, `${label}无效`, 'INVALID_INSTALL_EVENT');
  }
  return normalized;
}

function requiredDate(value, label, { futureToleranceMs = 10 * 60 * 1000 } = {}) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || parsed > Date.now() + futureToleranceMs) {
    throw new HttpError(400, `${label}无效`, 'INVALID_INSTALL_EVENT');
  }
  return new Date(parsed).toISOString();
}

function responseFor(result, completionToken) {
  return {
    ok: true,
    eventId: result.event.id,
    duplicate: result.duplicate,
    recordedAt: result.event.receivedAt,
    deviceState: result.device?.status || 'installed',
    stateChanged: result.event.stateChanged,
    ignoredAsStale: result.event.ignoredAsStale,
    ...(completionToken ? { completionToken } : {})
  };
}

class UninstallService {
  constructor({ config, uninstallStore, activationService, companionStore, auditService }) {
    this.config = config;
    this.uninstallStore = uninstallStore;
    this.activationService = activationService;
    this.companionStore = companionStore;
    this.auditService = auditService;
  }

  async record(req, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.schemaVersion !== 1) {
      throw new HttpError(400, '安装状态事件格式无效', 'INVALID_INSTALL_EVENT');
    }
    const eventType = cleanSingleLine(body.eventType, 40).toLowerCase();
    if (!INSTALL_EVENT_TYPES.includes(eventType)) {
      throw new HttpError(400, '安装状态事件类型无效', 'INVALID_INSTALL_EVENT_TYPE');
    }
    if (eventType === 'uninstall_completed') return this.complete(req, body);

    const id = requiredUuid(body.eventId, '事件标识');
    const installBatchId = requiredUuid(body.installBatchId, '安装批次');
    const installBatchCreatedAt = requiredDate(body.installBatchCreatedAt, '安装批次时间', {
      futureToleranceMs: 24 * 60 * 60 * 1000
    });
    const occurredAt = requiredDate(body.occurredAt, '事件时间');
    const device = this.activationService.identifyActivityDevice(body);
    if (!device) throw new HttpError(401, '设备身份无效', 'INSTALL_EVENT_DEVICE_INVALID');

    const platform = cleanSingleLine(body.platform || req.headers['x-deskpet-platform'], 20).toLowerCase();
    if (!VALID_PLATFORMS.has(platform)) {
      throw new HttpError(400, '客户端平台无效', 'INVALID_INSTALL_EVENT_PLATFORM');
    }
    const appVersion = cleanSingleLine(body.appVersion || req.headers['x-deskpet-version'], 40);
    if (!appVersion || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(appVersion)) {
      throw new HttpError(400, '客户端版本无效', 'INVALID_INSTALL_EVENT_VERSION');
    }

    let reason = null;
    let comment = '';
    if (eventType === 'uninstall_intent') {
      reason = body.reason === null || body.reason === undefined || body.reason === ''
        ? null
        : cleanSingleLine(body.reason, 40).toLowerCase();
      if (reason !== null && !UNINSTALL_REASONS.includes(reason)) {
        throw new HttpError(400, '卸载原因无效', 'INVALID_UNINSTALL_REASON');
      }
      comment = cleanMultiline(body.comment, 500);
      if (comment && reason !== 'other') {
        throw new HttpError(400, '补充说明仅用于“其他”原因', 'INVALID_UNINSTALL_COMMENT');
      }
    } else if (body.reason !== undefined || body.comment !== undefined) {
      throw new HttpError(400, '启动事件不能包含卸载反馈', 'INVALID_INSTALL_EVENT');
    }

    const displayName = device.trial
      ? '体验设备'
      : (this.companionStore.findDisplayName(device.accountId) || '桌搭子');
    let completionToken = null;
    let completionTokenHash = null;
    let completionTokenExpiresAt = null;
    if (eventType === 'uninstall_intent') {
      completionToken = crypto.randomBytes(32).toString('base64url');
      completionTokenHash = crypto.createHash('sha256').update(completionToken, 'ascii').digest();
      completionTokenExpiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();
    }

    let result;
    try {
      result = this.uninstallStore.recordIdentityEvent({
        id,
        eventType,
        installationId: device.installationId,
        accountId: device.accountId,
        licenseId: device.id,
        displayName,
        installBatchId,
        installBatchCreatedAt,
        platform,
        appVersion,
        reason,
        comment,
        occurredAt
      }, completionTokenHash, completionTokenExpiresAt);
    } catch (error) {
      if (error?.code === 'INSTALL_EVENT_ID_CONFLICT') {
        throw new HttpError(409, error.message, error.code);
      }
      throw error;
    }

    await this.auditService.write({
      action: eventType,
      outcome: result.event.ignoredAsStale ? 'ignored' : 'success',
      ip: clientIp(req, this.config),
      eventId: result.event.id,
      installationId: device.installationId,
      accountId: device.accountId,
      installBatchId,
      duplicate: result.duplicate,
      ignoredReason: result.event.ignoredReason
    });
    return responseFor(result, result.duplicate ? null : completionToken);
  }

  async complete(req, body) {
    const id = requiredUuid(body.eventId, '事件标识');
    const intentEventId = requiredUuid(body.intentEventId, '卸载意向标识');
    const occurredAt = requiredDate(body.occurredAt, '卸载完成时间');
    const completionToken = cleanSingleLine(body.completionToken, 100);
    if (!COMPLETION_TOKEN_PATTERN.test(completionToken)) {
      throw new HttpError(401, '卸载完成凭据无效', 'UNINSTALL_COMPLETION_INVALID');
    }
    let result;
    try {
      result = this.uninstallStore.completeWithToken({
        id,
        intentEventId,
        completionToken,
        occurredAt
      });
    } catch (error) {
      if (String(error?.code || '').startsWith('UNINSTALL_COMPLETION_')) {
        const status = ['UNINSTALL_COMPLETION_USED', 'UNINSTALL_COMPLETION_EVENT_CONFLICT'].includes(error.code)
          ? 409 : 401;
        throw new HttpError(status, error.message, error.code);
      }
      throw error;
    }
    await this.auditService.write({
      action: 'uninstall_completed',
      outcome: result.event.ignoredAsStale ? 'ignored' : 'success',
      ip: clientIp(req, this.config),
      eventId: result.event.id,
      intentEventId,
      installationId: result.event.installationId,
      installBatchId: result.event.installBatchId,
      duplicate: result.duplicate,
      ignoredReason: result.event.ignoredReason
    });
    return responseFor(result);
  }

  listAdmin(query) {
    const status = cleanSingleLine(query?.status, 40).toLowerCase();
    if (status && !INSTALL_STATES.includes(status)) {
      throw new HttpError(400, '安装状态筛选无效', 'INVALID_INSTALL_STATE');
    }
    const q = cleanSingleLine(query?.q, 100);
    const page = Math.max(1, Math.min(100000, Number.parseInt(query?.page, 10) || 1));
    const requestedPageSize = Number.parseInt(query?.pageSize, 10) || 25;
    const pageSize = [25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 25;
    return this.uninstallStore.list({ status, q, page, pageSize });
  }

  details(installationId) {
    const normalized = cleanSingleLine(installationId, 80);
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(normalized)) {
      throw new HttpError(404, 'Not found', 'NOT_FOUND');
    }
    const result = this.uninstallStore.details(normalized);
    if (!result) throw new HttpError(404, '设备卸载记录不存在', 'UNINSTALL_DEVICE_NOT_FOUND');
    return result;
  }
}

module.exports = { UninstallService };
