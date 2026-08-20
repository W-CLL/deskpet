const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('../errors/http-error');

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

function mapStoreError(error) {
  const mappings = new Map([
    ['昵称不能为空', [400, 'INVALID_COMPANION_NAME']],
    ['搭子码无效', [404, 'PAIRING_CODE_NOT_FOUND']],
    ['其中一方已经绑定搭子', [409, 'COMPANION_ALREADY_PAIRED']],
    ['请先绑定搭子', [409, 'COMPANION_NOT_PAIRED']],
    ['发送太快，请稍后再试', [429, 'COMPANION_RATE_LIMITED']],
    ['对方还有未查看的来访', [409, 'COMPANION_QUEUE_FULL']]
  ]);
  const mapping = mappings.get(error?.message);
  return mapping ? new HttpError(mapping[0], error.message, mapping[1]) : error;
}

class CompanionService {
  constructor({ companionStore, activationService }) {
    this.companionStore = companionStore;
    this.activationService = activationService;
  }

  requireAccount(req) {
    const license = this.activationService.requireLicense(req);
    if (license.trial) {
      throw new HttpError(403, '激活完整版本后可以使用搭子联机', 'COMPANION_ACTIVATION_REQUIRED');
    }
    return license;
  }

  profile(req) {
    const license = this.requireAccount(req);
    return this.companionStore.profile(license.accountId);
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

  pending(req) {
    const license = this.requireAccount(req);
    return { deliveries: this.companionStore.pending(license.accountId, license.id) };
  }

  file(req) {
    const license = this.requireAccount(req);
    const delivery = this.companionStore.delivery(license.accountId, license.id, req.params.id);
    if (!delivery) throw new HttpError(404, '来访 GIF 不存在或已失效', 'COMPANION_DELIVERY_NOT_FOUND');
    return {
      filePath: path.join(this.companionStore.filesDirectory, delivery.file_name),
      size: Number(delivery.size),
      sha256: delivery.sha256
    };
  }

  acknowledge(req) {
    const license = this.requireAccount(req);
    const result = this.companionStore.acknowledge(license.accountId, license.id, req.params.id);
    if (!result) throw new HttpError(404, '来访 GIF 不存在或已处理', 'COMPANION_DELIVERY_NOT_FOUND');
    return result;
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
    return stats;
  }

  async cleanup() {
    for (const fileName of this.companionStore.expiredFiles()) {
      await fs.promises.rm(path.join(this.companionStore.filesDirectory, fileName), { force: true });
    }
    this.companionStore.removeExpired();
  }
}

module.exports = { CompanionService, MAX_GIF_BYTES, inspectGif };
