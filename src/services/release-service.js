const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomToken } = require('../../lib/security');
const {
  RELEASE_PLATFORMS,
  expectedReleaseFileName,
  normalizeArchitecture,
  normalizePlatform,
  normalizeVersion,
  releaseKey
} = require('../../lib/storage');
const { HttpError, mapStoreError } = require('../errors/http-error');
const { clientIp, parseRange, querySearchParams } = require('../http/request-context');
const { UPLOAD_TTL_MS } = require('../config/app-config');

const MAX_PENDING_UPLOADS = 20;

function signedManifestPayload(manifest) {
  return Buffer.from(JSON.stringify({
    version: manifest.version,
    url: manifest.url,
    sha256: manifest.sha256,
    notes: manifest.notes
  }), 'utf8');
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function validateReleaseArtifact({
  releaseStore,
  publicUrl,
  signingPrivateKey,
  signingPublicKey = crypto.createPublicKey(signingPrivateKey),
  platform,
  architecture,
  version
}) {
  const normalizedVersion = normalizeVersion(version);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArchitecture = normalizeArchitecture(normalizedPlatform, architecture);
  const release = releaseStore.find(normalizedPlatform, normalizedArchitecture, normalizedVersion);
  if (!release) throw new HttpError(404, '版本不存在', 'VERSION_NOT_FOUND');

  const expectedFileName = expectedReleaseFileName(normalizedPlatform, normalizedArchitecture, normalizedVersion);
  if (release.platform !== normalizedPlatform
    || release.architecture !== normalizedArchitecture
    || release.version !== normalizedVersion
    || release.fileName !== expectedFileName
    || release.originalName.toLowerCase() !== expectedFileName.toLowerCase()) {
    throw new HttpError(409, '安装包文件名与版本号不一致', 'RELEASE_VERSION_MISMATCH');
  }

  const filePath = releaseStore.filePath(release);
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HttpError(409, '安装包文件不存在，无法发布', 'RELEASE_FILE_MISSING');
    }
    throw error;
  }
  if (!stat.isFile()) throw new HttpError(409, '安装包文件无效，无法发布', 'RELEASE_FILE_INVALID');
  if (stat.size !== release.size) {
    throw new HttpError(409, '安装包大小校验失败，无法发布', 'RELEASE_SIZE_MISMATCH');
  }

  const sha256 = await hashFile(filePath);
  if (sha256 !== release.sha256) {
    throw new HttpError(409, '安装包 SHA-256 校验失败，无法发布', 'RELEASE_HASH_MISMATCH');
  }

  const manifest = {
    version: release.version,
    url: new URL(`/downloads/${encodeURIComponent(release.fileName)}`, publicUrl).href,
    sha256: release.sha256,
    notes: release.notes
  };
  const payload = signedManifestPayload(manifest);
  const signature = crypto.sign(null, payload, signingPrivateKey);
  if (!crypto.verify(null, payload, signingPublicKey, signature)) {
    throw new HttpError(500, '更新清单签名校验失败，无法发布', 'SIGNATURE_VERIFICATION_FAILED');
  }
  return {
    version: release.version,
    size: stat.size,
    sha256,
    signatureVerified: true,
    checkedAt: new Date().toISOString()
  };
}

class ReleaseService {
  constructor({ config, releaseStore, activationService, auditService, signingPrivateKey }) {
    this.config = config;
    this.releaseStore = releaseStore;
    this.activationService = activationService;
    this.auditService = auditService;
    this.signingPrivateKey = signingPrivateKey;
    this.signingPublicKey = crypto.createPublicKey(signingPrivateKey);
    this.pendingUploads = new Map();
  }

  list() {
    return {
      publicUrl: this.config.publicUrl.href.replace(/\/$/, ''),
      adminUrl: new URL('/admin', this.config.publicUrl).href,
      manifestUrl: new URL('/api/update/latest', this.config.publicUrl).href,
      bootstrapVersions: this.config.bootstrapVersions,
      releaseTargets: RELEASE_PLATFORMS,
      activeVersions: this.releaseStore.data.activeVersions,
      publicVersions: this.releaseStore.data.publicVersions,
      releases: this.releaseStore.list()
    };
  }

  siteSettings() {
    return this.releaseStore.siteSettings();
  }

  async updateSiteSettings(req, body) {
    let settings;
    try {
      settings = await this.releaseStore.updateSiteSettings(body);
    } catch (error) {
      const message = error?.message || '';
      if (/闲鱼链接|闲鱼 HTTPS 链接/.test(message)) {
        throw new HttpError(400, message, 'INVALID_XIANYU_URL');
      }
      if (/微信号/.test(message)) {
        throw new HttpError(400, message, 'INVALID_WECHAT_ID');
      }
      throw error;
    }
    await this.auditService.write({
      action: 'update_site_settings',
      outcome: 'success',
      ip: clientIp(req, this.config),
      xianyuEnabled: Boolean(settings.xianyuUrl),
      features: settings.features
    });
    return settings;
  }

  createUpload(body, session) {
    if (this.pendingUploads.size >= MAX_PENDING_UPLOADS) {
      throw new HttpError(429, '当前上传任务较多，请稍后重试。', 'UPLOAD_QUEUE_FULL');
    }
    let platform;
    let architecture;
    let version;
    try {
      platform = normalizePlatform(body?.platform || 'windows');
      architecture = normalizeArchitecture(platform, body?.architecture || 'x64');
      version = normalizeVersion(body?.version);
    } catch (error) {
      throw mapStoreError(error);
    }
    const originalName = path.basename(String(body?.fileName || '')).slice(0, 160);
    const fileSize = Number(body?.fileSize);
    const notes = String(body?.notes || '').replace(/\r/g, '').trim();
    const expectedFileName = expectedReleaseFileName(platform, architecture, version);
    const expectedExtension = {
      windows: '.exe',
      macos: '.zip',
      android: '.apk'
    }[platform];
    if (!originalName.toLowerCase().endsWith(expectedExtension)) {
      throw new HttpError(400, `只允许上传 ${expectedExtension.toUpperCase()} 文件`, 'INVALID_FILE_TYPE');
    }
    if (originalName.toLowerCase() !== expectedFileName.toLowerCase()) {
      throw new HttpError(
        400,
        `安装包文件名必须为 ${expectedFileName}`,
        'FILE_VERSION_MISMATCH'
      );
    }
    if (!Number.isSafeInteger(fileSize)
      || fileSize <= 0
      || fileSize > this.config.maxUploadSize) {
      throw new HttpError(400, '安装包大小无效或超过 300 MB', 'INVALID_FILE_SIZE');
    }
    if (notes.length > 1200) {
      throw new HttpError(400, '更新说明不能超过 1200 个字符', 'NOTES_TOO_LONG');
    }
    if (this.releaseStore.has(platform, architecture, version)) {
      throw new HttpError(409, '该平台和架构的版本已经存在', 'VERSION_EXISTS');
    }

    const uploadId = randomToken(24);
    this.pendingUploads.set(uploadId, {
      sessionToken: session.token,
      platform,
      architecture,
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
          platform: pending.platform,
          architecture: pending.architecture,
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
        platform: release.platform,
        architecture: release.architecture,
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
        platform: pending.platform,
        architecture: pending.architecture,
        version: pending.version
      });
      throw error;
    }
  }

  async publish(req, platform, architecture, version) {
    let result;
    try {
      const validation = await this.validateRelease(platform, architecture, version);
      const release = await this.releaseStore.publish(platform, architecture, version);
      result = { release, validation };
    } catch (error) {
      const mappedError = mapStoreError(error);
      await this.auditService.write({
        action: 'publish',
        outcome: 'failed',
        ip: clientIp(req, this.config),
        platform,
        architecture,
        version,
        code: mappedError.code || 'PUBLISH_FAILED'
      });
      throw mappedError;
    }
    await this.auditService.write({
      action: 'publish',
      outcome: 'success',
      ip: clientIp(req, this.config),
      platform: result.release.platform,
      architecture: result.release.architecture,
      version: result.release.version,
      sha256: result.validation.sha256,
      signatureVerified: result.validation.signatureVerified
    });
    return result;
  }

  async validateRelease(platform, architecture, version) {
    try {
      return await validateReleaseArtifact({
        releaseStore: this.releaseStore,
        publicUrl: this.config.publicUrl,
        signingPrivateKey: this.signingPrivateKey,
        signingPublicKey: this.signingPublicKey,
        platform,
        architecture,
        version
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async delete(req, platform, architecture, version) {
    let release;
    try {
      const target = releaseKey(platform, architecture);
      if (version === this.publicVersionFor(platform, architecture)
        && this.releaseStore.data.activeVersions[target] !== version) {
        throw new HttpError(
          409,
          '激活过渡版本不能删除',
          'BOOTSTRAP_VERSION_DELETE_REJECTED'
        );
      }
      release = await this.releaseStore.delete(platform, architecture, version);
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.auditService.write({
      action: 'delete',
      outcome: 'success',
      ip: clientIp(req, this.config),
      platform: release.platform,
      architecture: release.architecture,
      version: release.version
    });
    return { ok: true };
  }

  latestManifest(req) {
    const { platform, architecture } = this.releaseTarget(req);
    let manifest;
    if (req.headers.authorization) {
      this.activationService.requireLicense(req, true);
      manifest = this.releaseStore.manifest(this.config.publicUrl, platform, architecture);
    } else {
      const publicVersion = this.publicVersionFor(platform, architecture);
      manifest = publicVersion
        ? this.releaseStore.manifest(this.config.publicUrl, platform, architecture, publicVersion)
        : null;
    }

    if (!manifest) {
      if (!this.releaseStore.active(platform, architecture)) {
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
    const isPublic = release.version === this.publicVersionFor(release.platform, release.architecture);
    if (!isPublic) this.activationService.requireLicense(req);

    const filePath = this.releaseStore.filePath(release);
    const stat = await fs.promises.stat(filePath);
    let range;
    try {
      range = parseRange(req.headers.range, stat.size);
    } catch (error) {
      if (error.status === 416) error.totalSize = stat.size;
      throw error;
    }
    return { filePath, isBootstrap: isPublic, range, release, size: stat.size };
  }

  publicDownloads() {
    return Object.entries(this.releaseStore.data.publicVersions)
      .map(([key, version]) => {
        const [platform, architecture] = key.split('/');
        const release = this.releaseStore.public(platform, architecture);
        if (!release?.publishedAt) return null;
        return {
          platform,
          architecture,
          version: release.version,
          fileName: release.fileName,
          size: release.size,
          sha256: release.sha256,
          notes: release.notes,
          url: new URL(`/downloads/latest/${platform}/${architecture}`, this.config.publicUrl).href
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.platform.localeCompare(right.platform)
        || left.architecture.localeCompare(right.architecture));
  }

  publicDownload(platform, architecture) {
    const release = this.releaseStore.public(platform, architecture);
    if (!release?.publishedAt) throw new HttpError(404, '暂未发布公开安装包', 'NO_PUBLIC_RELEASE');
    return release;
  }

  cleanup() {
    const now = Date.now();
    for (const [uploadId, upload] of this.pendingUploads) {
      if (upload.expiresAt <= now) {
        this.pendingUploads.delete(uploadId);
        fs.promises.rm(this.releaseStore.uploadPath(uploadId), { force: true }).catch(() => {});
      }
    }
  }

  publicVersionFor(platform, architecture) {
    const key = releaseKey(platform, architecture);
    return this.releaseStore.data.publicVersions[key]
      || this.config.bootstrapVersions[key]
      || this.releaseStore.data.activeVersions[key]
      || null;
  }

  bootstrapVersionFor(platform, architecture) {
    return this.publicVersionFor(platform, architecture);
  }

  releaseTarget(req) {
    const searchParams = querySearchParams(req);
    try {
      const platform = normalizePlatform(searchParams.get('platform') || 'windows');
      const defaultArchitecture = platform === 'windows'
        ? 'x64'
        : platform === 'android' ? 'arm64-v8a' : '';
      const architecture = normalizeArchitecture(
        platform,
        searchParams.get('architecture') || defaultArchitecture
      );
      return { platform, architecture };
    } catch (error) {
      throw new HttpError(400, error.message, 'INVALID_RELEASE_TARGET');
    }
  }
}

module.exports = {
  ReleaseService,
  expectedReleaseFileName,
  signedManifestPayload,
  validateReleaseArtifact
};
