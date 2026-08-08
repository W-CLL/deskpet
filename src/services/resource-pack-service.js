const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomToken } = require('../../lib/security');
const { normalizeCategory } = require('../../lib/resource-pack-store');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');
const { UPLOAD_TTL_MS } = require('../config/app-config');

const MAX_RESOURCE_PACK_SIZE = 50 * 1024 * 1024;
const MAX_PENDING_UPLOADS = 20;

function cleanText(value, maximum, fieldName) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (!text || text.length > maximum) {
    throw new HttpError(400, `${fieldName}不能为空且不能超过 ${maximum} 个字符`, 'INVALID_RESOURCE_PACK');
  }
  return text;
}

function isZipHeader(header) {
  return header.length >= 4
    && header[0] === 0x50
    && header[1] === 0x4b
    && ((header[2] === 0x03 && header[3] === 0x04)
      || (header[2] === 0x05 && header[3] === 0x06)
      || (header[2] === 0x07 && header[3] === 0x08));
}

class ResourcePackService {
  constructor({ config, resourcePackStore, auditService }) {
    this.config = config;
    this.resourcePackStore = resourcePackStore;
    this.auditService = auditService;
    this.pendingUploads = new Map();
  }

  list() {
    return { packs: this.resourcePackStore.list().map((item) => this.publicItem(item)) };
  }

  publicList() {
    return this.resourcePackStore.list().map((item) => this.publicItem(item));
  }

  publicItem(item) {
    return {
      ...item,
      url: new URL(`/resource-packs/${encodeURIComponent(item.id)}/download`, this.config.publicUrl).href
    };
  }

  createUpload(body, session) {
    if (this.pendingUploads.size >= MAX_PENDING_UPLOADS) {
      throw new HttpError(429, '当前上传任务较多，请稍后重试。', 'UPLOAD_QUEUE_FULL');
    }
    let category;
    try {
      category = normalizeCategory(body?.category);
    } catch (error) {
      throw new HttpError(400, error.message, 'INVALID_RESOURCE_PACK_CATEGORY');
    }
    const title = cleanText(body?.title, 80, '资源包标题');
    const description = cleanText(body?.description, 600, '资源包简介');
    const originalName = path.basename(String(body?.fileName || '')).slice(0, 160);
    const fileSize = Number(body?.fileSize);
    if (!originalName.toLowerCase().endsWith('.zip')) {
      throw new HttpError(400, '只允许上传 ZIP 资源包', 'INVALID_FILE_TYPE');
    }
    if (!Number.isSafeInteger(fileSize)
      || fileSize <= 0
      || fileSize > Math.min(this.config.maxUploadSize, MAX_RESOURCE_PACK_SIZE)) {
      throw new HttpError(400, '资源包大小无效或超过 50 MB', 'INVALID_FILE_SIZE');
    }

    const uploadId = randomToken(24);
    this.pendingUploads.set(uploadId, {
      sessionToken: session.token,
      category,
      title,
      description,
      originalName,
      fileSize,
      expiresAt: Date.now() + UPLOAD_TTL_MS
    });
    return { uploadId, uploadUrl: `/api/admin/resource-pack-uploads/${uploadId}` };
  }

  async receiveUpload(req, uploadId, session) {
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

    const temporaryPath = this.resourcePackStore.uploadPath(uploadId);
    const hash = crypto.createHash('sha256');
    let received = 0;
    let header = Buffer.alloc(0);
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > pending.fileSize || received > MAX_RESOURCE_PACK_SIZE) {
          callback(new HttpError(413, '资源包超过允许大小', 'UPLOAD_TOO_LARGE'));
          return;
        }
        if (header.length < 4) header = Buffer.concat([header, chunk]).subarray(0, 4);
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    this.pendingUploads.delete(uploadId);
    try {
      await pipeline(req, meter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
      if (received !== pending.fileSize) throw new HttpError(400, '上传未完整完成', 'UPLOAD_INCOMPLETE');
      if (!isZipHeader(header)) throw new HttpError(400, '上传文件不是有效的 ZIP 资源包', 'INVALID_ZIP');
      const pack = await this.resourcePackStore.commitUpload({
        temporaryPath,
        category: pending.category,
        title: pending.title,
        description: pending.description,
        originalName: pending.originalName,
        size: received,
        sha256: hash.digest('hex')
      });
      await this.auditService.write({
        action: 'resource_pack_upload',
        outcome: 'success',
        ip: clientIp(req, this.config),
        resourcePackId: pack.id,
        category: pack.category,
        sha256: pack.sha256
      });
      return { pack: this.publicItem(pack) };
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async delete(req, id) {
    let pack;
    try {
      pack = await this.resourcePackStore.delete(id);
    } catch (error) {
      if (error.message === '资源包不存在') {
        throw new HttpError(404, error.message, 'RESOURCE_PACK_NOT_FOUND');
      }
      throw error;
    }
    await this.auditService.write({
      action: 'resource_pack_delete',
      outcome: 'success',
      ip: clientIp(req, this.config),
      resourcePackId: pack.id,
      category: pack.category
    });
    return { ok: true };
  }

  async download(id) {
    const pack = this.resourcePackStore.find(id);
    if (!pack) throw new HttpError(404, '资源包不存在', 'RESOURCE_PACK_NOT_FOUND');
    const filePath = this.resourcePackStore.filePath(pack);
    const stat = await fs.promises.stat(filePath);
    return { filePath, pack, size: stat.size };
  }

  cleanup() {
    const now = Date.now();
    for (const [uploadId, upload] of this.pendingUploads) {
      if (upload.expiresAt <= now) {
        this.pendingUploads.delete(uploadId);
        fs.promises.rm(this.resourcePackStore.uploadPath(uploadId), { force: true }).catch(() => {});
      }
    }
  }
}

module.exports = { ResourcePackService };
