const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomToken } = require('../../lib/security');
const { normalizeVersion } = require('../../lib/storage');
const { HttpError, mapStoreError } = require('../errors/http-error');
const { clientIp, parseRange } = require('../http/request-context');
const { UPLOAD_TTL_MS } = require('../config/app-config');

function signedManifestPayload(manifest) {
  return Buffer.from(JSON.stringify({
    version: manifest.version,
    url: manifest.url,
    sha256: manifest.sha256,
    notes: manifest.notes
  }), 'utf8');
}

class ReleaseService {
  constructor({ config, releaseStore, activationService, auditService, signingPrivateKey }) {
    this.config = config;
    this.releaseStore = releaseStore;
    this.activationService = activationService;
    this.auditService = auditService;
    this.signingPrivateKey = signingPrivateKey;
    this.pendingUploads = new Map();
  }

  list() {
    return {
      publicUrl: this.config.publicUrl.href.replace(/\/$/, ''),
      manifestUrl: new URL('/api/update/latest', this.config.publicUrl).href,
      bootstrapVersion: this.config.bootstrapVersion,
      activeVersion: this.releaseStore.data.activeVersion,
      releases: this.releaseStore.list()
    };
  }

  createUpload(body, session) {
    let version;
    try {
      version = normalizeVersion(body?.version);
    } catch (error) {
      throw mapStoreError(error);
    }
    const originalName = path.basename(String(body?.fileName || '')).slice(0, 160);
    const fileSize = Number(body?.fileSize);
    const notes = String(body?.notes || '').replace(/\r/g, '').trim();
    if (!originalName.toLowerCase().endsWith('.exe')) {
      throw new HttpError(400, '只允许上传 EXE 文件', 'INVALID_FILE_TYPE');
    }
    if (!Number.isSafeInteger(fileSize)
      || fileSize <= 0
      || fileSize > this.config.maxUploadSize) {
      throw new HttpError(400, '安装包大小无效或超过 300 MB', 'INVALID_FILE_SIZE');
    }
    if (notes.length > 1200) {
      throw new HttpError(400, '更新说明不能超过 1200 个字符', 'NOTES_TOO_LONG');
    }
    if (this.releaseStore.has(version)) {
      throw new HttpError(409, '该版本已经存在', 'VERSION_EXISTS');
    }

    const uploadId = randomToken(24);
    this.pendingUploads.set(uploadId, {
      sessionToken: session.token,
      version,
      originalName,
      fileSize,
      notes,
      expiresAt: Date.now() + UPLOAD_TTL_MS
    });
    return { uploadId, uploadUrl: `/api/admin/uploads/${uploadId}` };
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

    const temporaryPath = this.releaseStore.uploadPath(uploadId);
    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > pending.fileSize || received > this.config.maxUploadSize) {
          callback(new HttpError(413, '上传文件超过允许大小', 'UPLOAD_TOO_LARGE'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    this.pendingUploads.delete(uploadId);
    try {
      await pipeline(
        req,
        meter,
        fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
      );
      if (received !== pending.fileSize) {
        throw new HttpError(400, '上传未完整完成', 'UPLOAD_INCOMPLETE');
      }
      let release;
      try {
        release = await this.releaseStore.commitUpload({
          temporaryPath,
          version: pending.version,
          originalName: pending.originalName,
          size: received,
          sha256: hash.digest('hex'),
          notes: pending.notes
        });
      } catch (error) {
        throw mapStoreError(error);
      }
      await this.auditService.write({
        action: 'upload',
        outcome: 'success',
        ip: clientIp(req, this.config),
        version: release.version,
        sha256: release.sha256
      });
      return { release };
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      await this.auditService.write({
        action: 'upload',
        outcome: 'failed',
        ip: clientIp(req, this.config),
        version: pending.version
      });
      throw error;
    }
  }

  async publish(req, version) {
    let release;
    try {
      release = await this.releaseStore.publish(version);
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.auditService.write({
      action: 'publish',
      outcome: 'success',
      ip: clientIp(req, this.config),
      version: release.version
    });
    return { release };
  }

  async delete(req, version) {
    if (version === this.config.bootstrapVersion
      && this.releaseStore.data.activeVersion !== version) {
      throw new HttpError(
        409,
        '激活过渡版本不能删除',
        'BOOTSTRAP_VERSION_DELETE_REJECTED'
      );
    }
    let release;
    try {
      release = await this.releaseStore.delete(version);
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.auditService.write({
      action: 'delete',
      outcome: 'success',
      ip: clientIp(req, this.config),
      version: release.version
    });
    return { ok: true };
  }

  latestManifest(req) {
    let manifest;
    if (req.headers.authorization) {
      this.activationService.requireLicense(req, true);
      manifest = this.releaseStore.manifest(this.config.publicUrl);
    } else {
      manifest = this.releaseStore.manifest(
        this.config.publicUrl,
        this.config.bootstrapVersion
      );
      if (!manifest && !this.releaseStore.find(this.config.bootstrapVersion)) {
        manifest = this.releaseStore.manifest(this.config.publicUrl);
      }
    }

    if (!manifest) {
      if (!this.releaseStore.active()) {
        throw new HttpError(404, '暂未发布版本', 'NO_RELEASE');
      }
      throw new HttpError(401, '请先激活桌搭子', 'ACTIVATION_REQUIRED');
    }
    const signature = crypto
      .sign(null, signedManifestPayload(manifest), this.signingPrivateKey)
      .toString('base64');
    return { ...manifest, signatureAlgorithm: 'ed25519', signature };
  }

  async download(req, fileName) {
    if (!fileName || path.basename(fileName) !== fileName) {
      throw new HttpError(404, '版本文件不存在', 'NOT_FOUND');
    }
    const release = this.releaseStore.findPublishedFile(fileName);
    if (!release) throw new HttpError(404, '版本文件不存在', 'NOT_FOUND');
    const isBootstrap = release.version === this.config.bootstrapVersion;
    if (!isBootstrap) this.activationService.requireLicense(req);

    const filePath = this.releaseStore.filePath(release);
    const stat = await fs.promises.stat(filePath);
    let range;
    try {
      range = parseRange(req.headers.range, stat.size);
    } catch (error) {
      if (error.status === 416) error.totalSize = stat.size;
      throw error;
    }
    return { filePath, isBootstrap, range, release, size: stat.size };
  }

  cleanup() {
    const now = Date.now();
    for (const [uploadId, upload] of this.pendingUploads) {
      if (upload.expiresAt <= now) this.pendingUploads.delete(uploadId);
    }
  }
}

module.exports = { ReleaseService, signedManifestPayload };
