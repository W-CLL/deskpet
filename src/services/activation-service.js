const { LoginRateLimiter } = require('../../lib/security');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');

const DEFAULT_IP_RATE_OPTIONS = {
  maxFailures: 8,
  windowMs: 15 * 60 * 1000,
  blockMs: 30 * 60 * 1000
};
const DEFAULT_DEVICE_RATE_OPTIONS = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 30 * 60 * 1000
};

class ActivationService {
  constructor({
    config,
    activationStore,
    auditService,
    activationIpRateOptions,
    activationDeviceRateOptions
  }) {
    this.config = config;
    this.activationStore = activationStore;
    this.auditService = auditService;
    this.ipLimiter = new LoginRateLimiter(activationIpRateOptions || DEFAULT_IP_RATE_OPTIONS);
    this.deviceLimiter = new LoginRateLimiter(
      activationDeviceRateOptions || DEFAULT_DEVICE_RATE_OPTIONS
    );
  }

  list() {
    return this.activationStore.list();
  }

  async createCodes(req, body) {
    let generated;
    try {
      generated = this.activationStore.createCodes({
        count: Number(body?.count),
        expiresInDays: Number(body?.expiresInDays),
        note: body?.note
      });
    } catch (error) {
      throw new HttpError(400, error.message, 'INVALID_ACTIVATION_CODE_REQUEST');
    }
    await this.auditService.write({
      action: 'activation-code-generate',
      outcome: 'success',
      ip: clientIp(req, this.config),
      count: generated.codes.length,
      expiresAt: generated.expiresAt
    });
    return generated;
  }

  async reveal(req, codeId) {
    const revealed = this.activationStore.reveal(codeId);
    if (!revealed) {
      throw new HttpError(
        404,
        '该激活码为旧记录，无法恢复完整内容',
        'ACTIVATION_CODE_NOT_REVEALABLE'
      );
    }
    await this.auditService.write({
      action: 'activation-code-reveal',
      outcome: 'success',
      ip: clientIp(req, this.config),
      activationCodeId: revealed.id
    });
    return { code: revealed.code };
  }

  async revoke(req, licenseId) {
    const license = this.activationStore.revoke(licenseId);
    if (!license) throw new HttpError(404, '有效授权不存在', 'LICENSE_NOT_FOUND');
    await this.auditService.write({
      action: 'license-revoke',
      outcome: 'success',
      ip: clientIp(req, this.config),
      licenseId: license.id
    });
    return { license };
  }

  authenticate(req, markUpdate = false) {
    return this.activationStore.authenticate(req.headers.authorization, {
      appVersion: req.headers['x-deskpet-version'],
      markUpdate
    });
  }

  requireLicense(req, markUpdate = false) {
    const license = this.authenticate(req, markUpdate);
    if (!license) {
      throw new HttpError(401, '设备授权无效或已撤销', 'LICENSE_REQUIRED');
    }
    return license;
  }

  async activate(req, body) {
    const ip = clientIp(req, this.config);
    const ipStatus = this.ipLimiter.status(ip);
    if (!ipStatus.allowed) {
      throw new HttpError(
        429,
        `激活尝试过多，请在 ${ipStatus.retryAfterSeconds} 秒后重试`,
        'ACTIVATION_RATE_LIMITED'
      );
    }

    const installationId = String(body?.installationId || '');
    const deviceKey = installationId || 'invalid';
    const deviceStatus = this.deviceLimiter.status(deviceKey);
    if (!deviceStatus.allowed) {
      throw new HttpError(
        429,
        `激活尝试过多，请在 ${deviceStatus.retryAfterSeconds} 秒后重试`,
        'ACTIVATION_RATE_LIMITED'
      );
    }

    const license = this.activationStore.activate({
      code: body?.code,
      installationId,
      credential: body?.credential,
      appVersion: body?.appVersion
    });
    if (!license) {
      const nextIpStatus = this.ipLimiter.fail(ip);
      const nextDeviceStatus = this.deviceLimiter.fail(deviceKey);
      await this.auditService.write({ action: 'activate', outcome: 'denied', ip });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const retryAfter = Math.max(
        nextIpStatus.retryAfterSeconds,
        nextDeviceStatus.retryAfterSeconds
      );
      if (retryAfter > 0) {
        throw new HttpError(
          429,
          `激活尝试过多，请在 ${retryAfter} 秒后重试`,
          'ACTIVATION_RATE_LIMITED'
        );
      }
      throw new HttpError(401, '激活码无效、已使用或已过期', 'ACTIVATION_REJECTED');
    }

    this.ipLimiter.reset(ip);
    this.deviceLimiter.reset(installationId);
    await this.auditService.write({
      action: 'activate',
      outcome: license.alreadyActivated ? 'retry' : 'success',
      ip,
      licenseId: license.licenseId
    });
    return license;
  }
}

module.exports = { ActivationService };
