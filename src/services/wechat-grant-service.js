const { HttpError } = require('../errors/http-error');

class WechatGrantService {
  constructor({ grantStore }) {
    this.grantStore = grantStore;
  }

  create(body) {
    try {
      return this.grantStore.create({
        claimId: body?.claimId,
        externalSubjectId: body?.externalSubjectId,
        campaignId: body?.campaignId,
        retentionDays: body?.retentionDays ?? 30
      });
    } catch (error) {
      if (error?.code === 'GRANT_IDEMPOTENCY_MISMATCH') {
        throw new HttpError(409, error.message, error.code);
      }
      if (error?.code === 'SUBJECT_ALREADY_CLAIMED') {
        throw new HttpError(409, error.message, error.code);
      }
      if (error?.code === 'INVALID_GRANT_REQUEST') {
        throw new HttpError(400, error.message, error.code);
      }
      throw error;
    }
  }

  get(grantId) {
    const grant = this.grantStore.get(grantId);
    if (!grant) throw new HttpError(404, '赠送权益不存在', 'GRANT_NOT_FOUND');
    return grant;
  }

  revoke(grantId, reason) {
    try {
      const grant = this.grantStore.revoke(grantId, reason || 'unfollow_before_30_days');
      if (!grant) throw new HttpError(404, '赠送权益不存在', 'GRANT_NOT_FOUND');
      return grant;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error?.code === 'INVALID_GRANT_REQUEST') {
        throw new HttpError(400, error.message, error.code);
      }
      throw error;
    }
  }
}

module.exports = { WechatGrantService };
