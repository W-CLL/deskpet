const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomToken } = require('../../lib/security');
const { normalizeCategory, RESOURCE_PACK_STATUSES } = require('../../lib/resource-pack-store');
const { validateResourcePackPackage } = require('../../lib/resource-pack-package');
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
    return { packs: this.resourcePackStore.list().map((item) => ({ ...this.publicItem(item),
      installable: item.installable, validationError: item.validationError || '' })) };
  }

  publicList(category = '') {
    let filter = '';
    if (category) {
      try { filter = normalizeCategory(category); }
      catch (error) { throw new HttpError(400, error.message, 'INVALID_RESOURCE_PACK_CATEGORY'); }
    }
    return this.resourcePackStore.list()
      .filter(item => item.status === 'published' && item.installable && (!filter || item.category === filter))
      .map((item) => this.publicItem(item));
  }

  publicItem(item) {
    return {
      id: item.id, category: item.category, kind: item.category === 'theater-scripts' ? 'theater' : 'wordpack',
      title: item.title, description: item.description, originalName: item.originalName,
      size: item.size, sizeBytes: item.size, sha256: item.sha256, createdAt: item.createdAt,
      updatedAt: item.updatedAt, status: item.status, version: item.version, fileCount: item.fileCount,
      free: true, chargingMode: 'free', priceFen: 0,
      downloadPath: `/resource-packs/${encodeURIComponent(item.id)}/download`,
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
    const status = body.status === undefined ? 'published' : body.status;
    const version = body.version === undefined ? '1.0.0' : body.version;
    if (!RESOURCE_PACK_STATUSES.includes(status) || typeof version !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version)) {
      throw new HttpError(400, '资源包状态或版本格式无效', 'INVALID_RESOURCE_PACK');
    }
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
      status,
      version,
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
      let packageInfo;
      try { packageInfo = validateResourcePackPackage(await fs.promises.readFile(temporaryPath), pending.category); }
      catch (error) { throw new HttpError(400, error.message, 'INVALID_RESOURCE_PACK_PACKAGE'); }
      const pack = await this.resourcePackStore.commitUpload({
        temporaryPath,
        category: pending.category,
        title: pending.title,
        description: pending.description,
        originalName: pending.originalName,
        size: received,
        sha256: hash.digest('hex'),
        status: pending.status, version: pending.version, fileCount: packageInfo.fileCount
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

  async update(req, id, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length
        || Object.keys(body).some(key => !['title', 'description', 'category', 'status'].includes(key))) {
      throw new HttpError(400, '只允许修改标题、简介、分类和上下架状态', 'INVALID_RESOURCE_PACK');
    }
    const patch = {};
    if (body.title !== undefined) patch.title = cleanText(body.title, 80, '资源包标题');
    if (body.description !== undefined) patch.description = cleanText(body.description, 600, '资源包简介');
    if (body.category !== undefined) {
      try { patch.category = normalizeCategory(body.category); }
      catch (error) { throw new HttpError(400, error.message, 'INVALID_RESOURCE_PACK_CATEGORY'); }
    }
    if (body.status !== undefined) {
      if (!RESOURCE_PACK_STATUSES.includes(body.status)) throw new HttpError(400, '资源包状态无效', 'INVALID_RESOURCE_PACK');
      patch.status = body.status;
    }
    let pack;
    try { pack = await this.resourcePackStore.update(id, patch); }
    catch (error) {
      if (error.message === '资源包不存在') throw new HttpError(404, error.message, 'RESOURCE_PACK_NOT_FOUND');
      if (error.code === 'INVALID_RESOURCE_PACK_PACKAGE' || error.message.includes('完整性')) {
        throw new HttpError(400, error.message, 'INVALID_RESOURCE_PACK_PACKAGE');
      }
      throw error;
    }
    await this.auditService.write({ action: 'resource_pack_update', outcome: 'success', ip: clientIp(req, this.config),
      resourcePackId: id, category: pack.category, status: pack.status });
    return { pack: this.publicItem(pack) };
  }

  async download(id) {
    const pack = this.resourcePackStore.find(id);
    if (!pack || pack.status !== 'published' || !pack.installable) throw new HttpError(404, '资源包不存在或已下架', 'RESOURCE_PACK_NOT_FOUND');
    let handle;
    try {
      handle = await fs.promises.open(this.resourcePackStore.filePath(pack), 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== pack.size || stat.size > MAX_RESOURCE_PACK_SIZE) throw new Error('invalid_pack_size');
      const bytes = await handle.readFile();
      if (bytes.length !== pack.size || crypto.createHash('sha256').update(bytes).digest('hex') !== pack.sha256) {
        throw new Error('invalid_pack_hash');
      }
      // Return precisely the bytes whose hash was checked, even if the path is replaced later.
      return { bytes, pack, size: bytes.length };
    } catch {
      pack.installable = false;
      pack.validationError = '资源包文件缺失或完整性校验失败，请重新上传';
      throw new HttpError(404, '资源包文件缺失或完整性校验失败', 'RESOURCE_PACK_NOT_FOUND');
    } finally { await handle?.close().catch(() => {}); }
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
