const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomToken } = require('../../lib/security');
const { extractZipFiles } = require('../../lib/zip-files');
const {
  CATEGORY_LABELS,
  VISIT_STICKER_CATEGORIES,
  categoryLabel,
  normalizeCategory
} = require('../../lib/visit-sticker-store');
const { inspectGif } = require('./companion-service');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');
const { UPLOAD_TTL_MS } = require('../config/app-config');

const MAX_PACK_SIZE = 50 * 1024 * 1024;
const MAX_PENDING_UPLOADS = 8;
const MAX_GIF_FILES = 40;
const COOLDOWN_MS = 8 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;

function cleanText(value, maximum, fieldName) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (!text || text.length > maximum) {
    throw new HttpError(400, `${fieldName}不能为空且不能超过 ${maximum} 个字符`, 'INVALID_VISIT_STICKER');
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

function senderName(category) {
  return {
    girlfriend: '女友',
    friend: '好友',
    companion: '搭子'
  }[category] || '桌搭子';
}

class VisitStickerService {
  constructor({ config, visitStickerStore, activationService, auditService }) {
    this.config = config;
    this.visitStickerStore = visitStickerStore;
    this.activationService = activationService;
    this.auditService = auditService;
    this.pendingUploads = new Map();
    this.playRecords = new Map();
  }

  requireTrial(req) {
    const license = this.activationService.requireLicense(req);
    if (!license.trial) {
      throw new HttpError(403, '体验结束后，点一下发给对象才需要激活。', 'VISIT_STICKER_TRIAL_ONLY');
    }
    return license;
  }

  requireCategory(value) {
    try {
      return normalizeCategory(value);
    } catch (error) {
      throw new HttpError(400, error.message, 'INVALID_VISIT_STICKER_CATEGORY');
    }
  }

  publicSticker(sticker) {
    return {
      id: sticker.id,
      category: sticker.category,
      categoryLabel: categoryLabel(sticker.category),
      senderName: senderName(sticker.category),
      sha256: sticker.sha256,
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
      downloadPath: `/api/trial/visit-stickers/${encodeURIComponent(sticker.id)}/file`
    };
  }

  catalog(_req) {
    const counts = this.visitStickerStore.counts();
    return {
      categories: VISIT_STICKER_CATEGORIES.map((id) => ({
        id,
        label: CATEGORY_LABELS[id],
        count: counts[id]
      }))
    };
  }

  adminList() {
    return {
      counts: this.visitStickerStore.counts(),
      packs: this.visitStickerStore.listPacks().map((pack) => ({
        ...pack,
        categoryLabel: categoryLabel(pack.category)
      })),
      stickers: this.visitStickerStore.listStickers()
    };
  }

  createUpload(body, session) {
    if (this.pendingUploads.size >= MAX_PENDING_UPLOADS) {
      throw new HttpError(429, '当前上传任务较多，请稍后重试。', 'UPLOAD_QUEUE_FULL');
    }
    const category = this.requireCategory(body?.category);
    const title = cleanText(body?.title, 80, '表情包标题');
    const note = String(body?.note || body?.description || '').replace(/\r/g, '').trim().slice(0, 600);
    const originalName = path.basename(String(body?.fileName || '')).slice(0, 160);
    const fileSize = Number(body?.fileSize);
    if (!originalName.toLowerCase().endsWith('.zip')) {
      throw new HttpError(400, '请上传包含 GIF 的 ZIP 压缩包', 'INVALID_FILE_TYPE');
    }
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_PACK_SIZE) {
      throw new HttpError(400, '压缩包大小无效或超过 50 MB', 'INVALID_FILE_SIZE');
    }
    const uploadId = randomToken(24);
    this.pendingUploads.set(uploadId, {
      sessionToken: session.token,
      category,
      title,
      note,
      originalName,
      fileSize,
      expiresAt: Date.now() + UPLOAD_TTL_MS
    });
    return { uploadId, uploadUrl: `/api/admin/visit-sticker-uploads/${uploadId}` };
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

    const temporaryPath = this.visitStickerStore.uploadPath(uploadId);
    const hash = crypto.createHash('sha256');
    let received = 0;
    let header = Buffer.alloc(0);
    const chunks = [];
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > pending.fileSize || received > MAX_PACK_SIZE) {
          callback(new HttpError(413, '压缩包超过允许大小', 'UPLOAD_TOO_LARGE'));
          return;
        }
        if (header.length < 4) header = Buffer.concat([header, chunk]).subarray(0, 4);
        hash.update(chunk);
        chunks.push(chunk);
        callback(null, chunk);
      }
    });

    this.pendingUploads.delete(uploadId);
    try {
      await pipeline(req, meter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
      if (received !== pending.fileSize) throw new HttpError(400, '上传未完整完成', 'UPLOAD_INCOMPLETE');
      if (!isZipHeader(header)) throw new HttpError(400, '上传文件不是有效的 ZIP 压缩包', 'INVALID_ZIP');
      const zip = Buffer.concat(chunks);
      const stickers = this.parseZip(zip);
      const pack = await this.visitStickerStore.commitPack({
        category: pending.category,
        title: pending.title,
        note: pending.note,
        originalName: pending.originalName,
        stickers
      });
      await this.auditService.write({
        action: 'visit_sticker_upload',
        outcome: 'success',
        ip: clientIp(req, this.config),
        packId: pack.id,
        category: pack.category,
        stickerCount: pack.stickerCount,
        sha256: hash.digest('hex')
      });
      return { pack: { ...pack, categoryLabel: categoryLabel(pack.category) } };
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      if (error instanceof HttpError) throw error;
      if (/ZIP|压缩包|GIF/.test(error.message || '')) {
        throw new HttpError(400, error.message, 'INVALID_VISIT_STICKER_PACK');
      }
      throw error;
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  parseZip(buffer) {
    let files;
    try {
      files = extractZipFiles(buffer, {
        maxFiles: MAX_GIF_FILES + 8,
        maxFileBytes: 8 * 1024 * 1024
      });
    } catch (error) {
      throw new HttpError(400, error.message || '压缩包无法打开', 'INVALID_ZIP');
    }
    const stickers = [];
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.gif')) continue;
      let inspected;
      try {
        inspected = inspectGif(file.data);
      } catch {
        continue;
      }
      stickers.push({
        originalName: path.posix.basename(file.name),
        buffer: file.data,
        size: file.data.length,
        sha256: crypto.createHash('sha256').update(file.data).digest('hex'),
        width: inspected.width,
        height: inspected.height
      });
      if (stickers.length >= MAX_GIF_FILES) break;
    }
    if (stickers.length === 0) {
      throw new HttpError(400, '压缩包里没有可用的 GIF', 'EMPTY_VISIT_STICKER_PACK');
    }
    return stickers;
  }

  async deletePack(req, id) {
    let pack;
    try {
      pack = await this.visitStickerStore.deletePack(id);
    } catch (error) {
      if (error.message === '来访表情包不存在') {
        throw new HttpError(404, error.message, 'VISIT_STICKER_PACK_NOT_FOUND');
      }
      throw error;
    }
    await this.auditService.write({
      action: 'visit_sticker_pack_delete',
      outcome: 'success',
      ip: clientIp(req, this.config),
      packId: pack.id,
      category: pack.category
    });
    return { ok: true };
  }

  async deleteSticker(req, id) {
    let sticker;
    try {
      sticker = await this.visitStickerStore.deleteSticker(id);
    } catch (error) {
      if (error.message === '来访表情不存在') {
        throw new HttpError(404, error.message, 'VISIT_STICKER_NOT_FOUND');
      }
      throw error;
    }
    await this.auditService.write({
      action: 'visit_sticker_delete',
      outcome: 'success',
      ip: clientIp(req, this.config),
      stickerId: sticker.id
    });
    return { ok: true };
  }

  consumePlayLimit(installationId) {
    const now = Date.now();
    const record = this.playRecords.get(installationId) || { lastAt: 0, stamps: [] };
    record.stamps = record.stamps.filter((stamp) => stamp > now - RATE_WINDOW_MS);
    if (now - record.lastAt < COOLDOWN_MS) {
      throw new HttpError(429, '来访还在演，稍等几秒再点。', 'VISIT_STICKER_COOLDOWN');
    }
    if (record.stamps.length >= RATE_MAX) {
      throw new HttpError(429, '体验期来访有点频繁，过一会儿再点。', 'VISIT_STICKER_RATE_LIMITED');
    }
    record.lastAt = now;
    record.stamps.push(now);
    this.playRecords.set(installationId, record);
  }

  play(req, body) {
    const license = this.requireTrial(req);
    const category = this.requireCategory(body?.category);
    if (this.visitStickerStore.activeCount(category) === 0) {
      throw new HttpError(404, `还没有「${senderName(category)}」表情，等作者传一批。`, 'VISIT_STICKER_EMPTY');
    }
    this.consumePlayLimit(license.installationId);
    const sticker = this.visitStickerStore.pickRandom(category, { excludeId: body?.excludeId });
    if (!sticker) {
      throw new HttpError(404, `还没有「${senderName(category)}」表情，等作者传一批。`, 'VISIT_STICKER_EMPTY');
    }
    return this.publicSticker(sticker);
  }

  file(req, id) {
    this.requireTrial(req);
    const sticker = this.visitStickerStore.findActive(id);
    if (!sticker) throw new HttpError(404, '来访表情不存在或已下架', 'VISIT_STICKER_NOT_FOUND');
    return {
      filePath: this.visitStickerStore.filePath(sticker.fileName),
      size: sticker.size,
      sha256: sticker.sha256
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [uploadId, upload] of this.pendingUploads) {
      if (upload.expiresAt <= now) {
        this.pendingUploads.delete(uploadId);
        fs.promises.rm(this.visitStickerStore.uploadPath(uploadId), { force: true }).catch(() => {});
      }
    }
    for (const [installationId, record] of this.playRecords) {
      record.stamps = record.stamps.filter((stamp) => stamp > now - RATE_WINDOW_MS);
      if (record.stamps.length === 0 && now - record.lastAt > RATE_WINDOW_MS) {
        this.playRecords.delete(installationId);
      }
    }
  }
}

module.exports = { VisitStickerService, VISIT_STICKER_CATEGORIES };
