const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');

const MAX_GIF_BYTES = 8 * 1024 * 1024;
const MAX_GIF_DIMENSION = 2048;

function inspectGif(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || buffer.length > MAX_GIF_BYTES) {
    throw new HttpError(400, '请选择不超过 8 MB 的 GIF 文件', 'INVALID_COMPANION_GIF');
  }
  const signature = buffer.subarray(0, 6).toString('ascii');
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (!['GIF87a', 'GIF89a'].includes(signature) || width < 1 || height < 1
    || width > MAX_GIF_DIMENSION || height > MAX_GIF_DIMENSION) {
    throw new HttpError(400, 'GIF 文件格式或尺寸无效', 'INVALID_COMPANION_GIF');
  }
  return { width, height };
}

const ACCOUNT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const RECIPIENT_ID_PATTERN = /^(?:[0-9a-f-]{36}|trial:[0-9a-f]{64})$/i;

function mapStoreError(error) {
  const mappings = new Map([
    ['昵称不能为空', [400, 'INVALID_COMPANION_NAME']],
    ['搭子码无效', [404, 'PAIRING_CODE_NOT_FOUND']],
    ['其中一方已经绑定搭子', [409, 'COMPANION_ALREADY_PAIRED']],
    ['请先绑定搭子', [409, 'COMPANION_NOT_PAIRED']],
    ['发送太快，请稍后再试', [429, 'COMPANION_RATE_LIMITED']],
    ['对方还有未查看的来访', [409, 'COMPANION_QUEUE_FULL']],
    ['不能发给自己', [400, 'COMPANION_ADMIN_SELF']]
  ]);
  mappings.set('HALL_SENDER_DISABLED', [409, 'COMPANION_HALL_DISABLED', '请先打开桌宠大厅']);
  mappings.set('HALL_RECIPIENT_OFFLINE', [409, 'COMPANION_HALL_RECIPIENT_OFFLINE', '对方已经离线']);
  const mapping = mappings.get(error?.message);
  return mapping ? new HttpError(mapping[0], mapping[2] || error.message, mapping[1]) : error;
}

function isActiveLicenseDevice(device) {
  return device?.authorizationType === 'license'
    && device?.authorizationState === 'active'
    && Boolean(device.accountId)
    && Boolean(device.licenseId);
}

function isOnlineRecipientDevice(device) {
  if (device?.authorizationState !== 'active' || !device.accountId || !device.licenseId) return false;
  if (device.authorizationType === 'license') return true;
  return device.authorizationType === 'trial';
}

function isValidSenderAccountId(value) {
  return ACCOUNT_ID_PATTERN.test(value);
}

function isValidRecipientId(value) {
  return RECIPIENT_ID_PATTERN.test(value);
}

class CompanionService {
  constructor({ companionStore, activationService, analyticsService, auditService, config }) {
    this.companionStore = companionStore;
    this.activationService = activationService;
    this.analyticsService = analyticsService || null;
    this.auditService = auditService || null;
    this.config = config || null;
  }

  requireAccount(req, { allowTrial = false } = {}) {
    const license = this.activationService.requireLicense(req);
    if (license.trial && !allowTrial) {
      throw new HttpError(403, '激活完整版本后可以使用搭子联机', 'COMPANION_ACTIVATION_REQUIRED');
    }
    return license;
  }

  profile(req) {
    const license = this.requireAccount(req);
    return this.companionStore.profile(license.accountId);
  }

  hall(req) {
    const license = this.requireAccount(req);
    return this.companionStore.hall(license.accountId);
  }

  updateHall(req, body) {
    const license = this.requireAccount(req);
    if (typeof body?.enabled !== 'boolean') {
      throw new HttpError(400, 'Invalid companion hall setting', 'INVALID_COMPANION_HALL_SETTING');
    }
    return this.companionStore.setHallEnabled(license.accountId, body.enabled);
  }

  updateProfile(req, body) {
    const license = this.requireAccount(req);
    try {
      return this.companionStore.updateProfile(license.accountId, body?.displayName);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  pair(req, body) {
    const license = this.requireAccount(req);
    if (!/^[23456789A-HJ-NP-Z]{8}$/.test(String(body?.code || '').trim().toUpperCase())) {
      throw new HttpError(400, '请输入有效的 8 位搭子码', 'INVALID_PAIRING_CODE');
    }
    try {
      return this.companionStore.pair(license.accountId, body.code);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  unpair(req) {
    const license = this.requireAccount(req);
    return this.companionStore.unpair(license.accountId);
  }

  async send(req, buffer) {
    const license = this.requireAccount(req);
    const { width, height } = inspectGif(buffer);
    const id = crypto.randomUUID();
    const fileName = `${id}.gif`;
    const filePath = path.join(this.companionStore.filesDirectory, fileName);
    await fs.promises.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
    try {
      return this.companionStore.createDelivery(license.accountId, {
        id,
        fileName,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        width,
        height
      });
    } catch (error) {
      await fs.promises.rm(filePath, { force: true });
      throw mapStoreError(error);
    }
  }

  async sendHall(req, buffer, recipientId, message) {
    const license = this.requireAccount(req);
    const target = String(recipientId || '').trim();
    if (!target || target.length > 128) {
      throw new HttpError(400, 'Invalid hall recipient', 'INVALID_COMPANION_HALL_RECIPIENT');
    }
    const { width, height } = inspectGif(buffer);
    const id = crypto.randomUUID();
    const fileName = `${id}.gif`;
    const filePath = path.join(this.companionStore.filesDirectory, fileName);
    await fs.promises.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
    try {
      return this.companionStore.createHallDelivery(license.accountId, target, {
        id,
        fileName,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        width,
        height,
        message
      });
    } catch (error) {
      await fs.promises.rm(filePath, { force: true });
      throw mapStoreError(error);
    }
  }

  pending(req) {
    const license = this.requireAccount(req, { allowTrial: true });
    return { deliveries: this.companionStore.pending(license.accountId, license.id) };
  }

  file(req) {
    const license = this.requireAccount(req, { allowTrial: true });
    const delivery = this.companionStore.delivery(license.accountId, license.id, req.params.id);
    if (!delivery) throw new HttpError(404, '来访 GIF 不存在或已失效', 'COMPANION_DELIVERY_NOT_FOUND');
    return {
      filePath: path.join(this.companionStore.filesDirectory, delivery.file_name),
      size: Number(delivery.size),
      sha256: delivery.sha256
    };
  }

  acknowledge(req) {
    const license = this.requireAccount(req, { allowTrial: true });
    const result = this.companionStore.acknowledge(license.accountId, license.id, req.params.id);
    if (!result) throw new HttpError(404, '来访 GIF 不存在或已处理', 'COMPANION_DELIVERY_NOT_FOUND');
    return result;
  }

  usageDevices() {
    if (!this.analyticsService) return [];
    return this.analyticsService.usageSummary(this.activationService.devices()).devices || [];
  }

  adminSendOptions(profiles = []) {
    const devices = this.usageDevices();
    const profileByAccount = new Map(profiles.map((item) => [item.accountId, item]));
    const licensedDevices = devices.filter(isActiveLicenseDevice);
    const onlineDevices = devices.filter((item) => (
      isOnlineRecipientDevice(item) && item.activityStatus === 'online'
    ));
    const senderIds = new Set(licensedDevices.map((item) => item.accountId));
    const senders = [...senderIds].map((accountId) => ({
      accountId,
      accountSuffix: String(accountId).slice(-8),
      displayName: profileByAccount.get(accountId)?.displayName || '桌搭子'
    })).sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh')
      || left.accountSuffix.localeCompare(right.accountSuffix));
    return {
      onlineWindowMinutes: 5,
      senders,
      devices: onlineDevices.map((item) => ({
        licenseId: item.licenseId,
        accountId: item.accountId,
        accountSuffix: String(item.accountId).slice(-8),
        installationSuffix: item.installationSuffix,
        displayName: item.authorizationType === 'trial'
          ? '体验设备'
          : (profileByAccount.get(item.accountId)?.displayName || '桌搭子'),
        platform: item.platform || 'unknown',
        architecture: item.architecture || '',
        appVersion: item.appVersion || '',
        lastSeenAt: item.lastSeenAt,
        authorizationType: item.authorizationType
      }))
    };
  }

  async adminStats() {
    const stats = this.companionStore.adminStats();
    let storageBytes = 0;
    const entries = await fs.promises.readdir(this.companionStore.filesDirectory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.gif')) continue;
      try {
        const file = await fs.promises.stat(path.join(this.companionStore.filesDirectory, entry.name));
        storageBytes += file.size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    stats.summary.storageBytes = storageBytes;
    stats.sendOptions = this.adminSendOptions(stats.profiles);
    return stats;
  }

  async adminSend(req, buffer, { senderAccountId, recipientLicenseId, message } = {}) {
    const sender = String(senderAccountId || '').trim();
    const licenseId = String(recipientLicenseId || '').trim();
    if (!isValidSenderAccountId(sender) || !isValidRecipientId(licenseId)) {
      throw new HttpError(400, '请选择发送账号和对方设备', 'INVALID_COMPANION_ADMIN_TARGET');
    }
    const devices = this.usageDevices();
    const senderAccount = devices.find((item) => isActiveLicenseDevice(item) && item.accountId === sender)
      || this.activationService.devices().find((item) => isActiveLicenseDevice(item) && item.accountId === sender);
    if (!senderAccount) {
      throw new HttpError(404, '发送账号不存在或未授权', 'COMPANION_ADMIN_SENDER_NOT_FOUND');
    }
    const recipientDevice = devices.find((item) => (
      item.licenseId === licenseId
      && isOnlineRecipientDevice(item)
      && item.activityStatus === 'online'
    ));
    if (!recipientDevice) {
      throw new HttpError(409, '对方设备当前不在线', 'COMPANION_ADMIN_RECIPIENT_OFFLINE');
    }
    if (recipientDevice.accountId === sender) {
      throw new HttpError(400, '不能发给自己的设备', 'COMPANION_ADMIN_SELF');
    }
    const { width, height } = inspectGif(buffer);
    const id = crypto.randomUUID();
    const fileName = `${id}.gif`;
    const filePath = path.join(this.companionStore.filesDirectory, fileName);
    await fs.promises.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
    try {
      const result = this.companionStore.createAdminDelivery(sender, recipientDevice.accountId, {
        id,
        fileName,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        width,
        height,
        message
      });
      if (this.auditService && this.config) {
        await this.auditService.write({
          action: 'companion-admin-send',
          outcome: 'success',
          ip: clientIp(req, this.config),
          senderAccountId: sender,
          recipientAccountId: recipientDevice.accountId,
          recipientLicenseId: licenseId,
          deliveryId: result.id,
          size: buffer.length
        });
      }
      return result;
    } catch (error) {
      await fs.promises.rm(filePath, { force: true });
      throw mapStoreError(error);
    }
  }

  async cleanup() {
    for (const fileName of this.companionStore.expiredFiles()) {
      await fs.promises.rm(path.join(this.companionStore.filesDirectory, fileName), { force: true });
    }
    this.companionStore.removeExpired();
  }
}

module.exports = { CompanionService, MAX_GIF_BYTES, inspectGif };
