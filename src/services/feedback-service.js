const { FEEDBACK_STATUSES, FEEDBACK_TYPES } = require('../../lib/feedback-store');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');

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

class FeedbackService {
  constructor({ config, feedbackStore, activationService, auditService }) {
    this.config = config;
    this.feedbackStore = feedbackStore;
    this.activationService = activationService;
    this.auditService = auditService;
  }

  listForDevice(req) {
    const license = this.activationService.requireLicense(req);
    return this.feedbackStore.listForInstallation(license.installationId);
  }

  async submit(req, body) {
    const license = this.activationService.requireLicense(req);
    const type = cleanSingleLine(body?.type, 20).toLowerCase();
    const title = cleanSingleLine(body?.title, 80);
    const content = cleanMultiline(body?.content, 2000);
    if (!FEEDBACK_TYPES.includes(type)) {
      throw new HttpError(400, '请选择问题反馈或功能建议', 'INVALID_FEEDBACK_TYPE');
    }
    if (title.length < 2) {
      throw new HttpError(400, '反馈标题至少需要 2 个字符', 'INVALID_FEEDBACK_TITLE');
    }
    if (content.length < 5) {
      throw new HttpError(400, '请补充至少 5 个字符的详细说明', 'INVALID_FEEDBACK_CONTENT');
    }

    let result;
    try {
      result = this.feedbackStore.create({
        licenseId: license.id,
        installationId: license.installationId,
        type,
        title,
        content,
        appVersion: cleanSingleLine(req.headers['x-deskpet-version'], 40),
        platform: cleanSingleLine(req.headers['x-deskpet-platform'] || 'windows', 20)
      });
    } catch (error) {
      if (error.code === 'FEEDBACK_LIMIT_REACHED') {
        throw new HttpError(409, error.message, error.code);
      }
      throw error;
    }
    await this.auditService.write({
      action: 'feedback-submit',
      outcome: 'success',
      ip: clientIp(req, this.config),
      feedbackId: result.item.id,
      licenseId: license.id,
      type
    });
    return result;
  }

  listAll() {
    return this.feedbackStore.listAll();
  }

  async updateStatus(req, feedbackId, body) {
    const status = cleanSingleLine(body?.status, 30).toLowerCase();
    if (!FEEDBACK_STATUSES.includes(status)) {
      throw new HttpError(400, '反馈状态无效', 'INVALID_FEEDBACK_STATUS');
    }
    const adminNote = body && Object.hasOwn(body, 'adminNote')
      ? cleanMultiline(body.adminNote, 1000)
      : undefined;
    let item;
    try {
      item = this.feedbackStore.updateStatus(feedbackId, status, adminNote);
    } catch (error) {
      if (error.code === 'FEEDBACK_LIMIT_REACHED') {
        throw new HttpError(409, error.message, error.code);
      }
      throw error;
    }
    if (!item) throw new HttpError(404, '反馈不存在', 'FEEDBACK_NOT_FOUND');
    await this.auditService.write({
      action: 'feedback-status-update',
      outcome: 'success',
      ip: clientIp(req, this.config),
      feedbackId: item.id,
      status: item.status
    });
    return { item };
  }
}

module.exports = { FeedbackService };
