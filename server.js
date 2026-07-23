const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  LoginRateLimiter,
  SessionStore,
  equalText,
  parseCookies,
  randomToken,
  verifyPassword
} = require('./lib/security');
const { ReleaseStore, normalizeVersion } = require('./lib/storage');
const { ActivationStore } = require('./lib/activation-store');

const APP_ROOT = __dirname;
const MAX_JSON_BODY = 32 * 1024;
const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;
const SESSION_COOKIE = 'deskpet_session';
const UPLOAD_TTL_MS = 15 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function loadConfig(overrides = {}) {
  const publicUrl = new URL(overrides.publicUrl || process.env.DESKPET_PUBLIC_URL || 'https://desktoppet.online');
  if (!['https:', 'http:'].includes(publicUrl.protocol)) throw new Error('DESKPET_PUBLIC_URL 必须使用 HTTP 或 HTTPS');
  const dataDirectory = path.resolve(overrides.dataDirectory || process.env.DESKPET_DATA_DIR || path.join(APP_ROOT, 'data'));
  return {
    publicUrl,
    dataDirectory,
    brandIconPath: path.resolve(overrides.brandIconPath || process.env.DESKPET_BRAND_ICON || path.join(APP_ROOT, 'public', 'app-icon.png')),
    httpHost: overrides.httpHost || process.env.DESKPET_HTTP_HOST || '0.0.0.0',
    httpPort: Number(overrides.httpPort ?? process.env.DESKPET_HTTP_PORT ?? 80),
    signingPrivateKeyPath: path.resolve(overrides.signingPrivateKeyPath || process.env.DESKPET_SIGNING_PRIVATE_KEY || path.join(dataDirectory, 'signing-private.pem')),
    bootstrapVersion: normalizeVersion(overrides.bootstrapVersion || process.env.DESKPET_BOOTSTRAP_VERSION || '2.1.0'),
    requireHttps: overrides.requireHttps ?? publicUrl.protocol === 'https:',
    cookieSecure: overrides.cookieSecure ?? publicUrl.protocol === 'https:',
    enforceHost: overrides.enforceHost ?? true,
    trustProxy: overrides.trustProxy ?? /^true$/i.test(process.env.DESKPET_TRUST_PROXY || ''),
    adminLoopbackOnly: overrides.adminLoopbackOnly ?? !/^false$/i.test(process.env.DESKPET_ADMIN_LOOPBACK_ONLY || ''),
    maxUploadSize: Number(overrides.maxUploadSize || MAX_UPLOAD_SIZE)
  };
}

function applySecurityHeaders(res, config) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (config.publicUrl.protocol === 'https:') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendJson(res, config, status, payload, extraHeaders = {}) {
  applySecurityHeaders(res, config);
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendRedirect(res, config, location) {
  applySecurityHeaders(res, config);
  res.statusCode = 308;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', location);
  res.end();
}

async function readJson(req, limit = MAX_JSON_BODY) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, '请求必须使用 application/json', 'CONTENT_TYPE_REQUIRED');
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new HttpError(413, '请求内容过大', 'BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求内容过大', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式无效', 'INVALID_JSON');
  }
}

function directIp(req) {
  return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function isLoopbackIp(value) {
  return ['127.0.0.1', '::1'].includes(String(value));
}

function isLoopbackHost(value) {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackRequest(req) {
  return isLoopbackIp(directIp(req)) && isLoopbackHost(req.headers.host);
}

function isAdminPath(pathname) {
  return pathname === '/'
    || pathname === '/admin'
    || pathname.startsWith('/api/admin/')
    || ['/assets/admin.css', '/assets/admin.js', '/assets/app-icon.png'].includes(pathname);
}

function isTrustedProxy(req, config) {
  return config.trustProxy && ['127.0.0.1', '::1'].includes(directIp(req));
}

function clientIp(req, config) {
  if (!isTrustedProxy(req, config)) return directIp(req);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded && forwarded.length <= 64 ? forwarded : directIp(req);
}

function isSecureRequest(req, config) {
  if (req.socket.encrypted) return true;
  if (!isTrustedProxy(req, config)) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function sessionCookie(config, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function assertSafeOrigin(req, config) {
  const origin = req.headers.origin;
  let allowedOrigin = config.publicUrl.origin;
  if (isLoopbackRequest(req)) allowedOrigin = new URL(`http://${req.headers.host}`).origin;
  if (origin && origin !== allowedOrigin) throw new HttpError(403, '请求来源无效', 'ORIGIN_REJECTED');
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw new HttpError(403, '跨站请求已拒绝', 'CROSS_SITE_REJECTED');
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, '下载范围无效', 'INVALID_RANGE');
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) throw new HttpError(416, '下载范围无效', 'INVALID_RANGE');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
    throw new HttpError(416, '下载范围无效', 'INVALID_RANGE');
  }
  return { start, end: Math.min(end, size - 1) };
}

function mapStoreError(error) {
  if (error instanceof HttpError) return error;
  const mappings = new Map([
    ['版本不存在', [404, 'VERSION_NOT_FOUND']],
    ['该版本已经存在', [409, 'VERSION_EXISTS']],
    ['当前发布版本不能删除', [409, 'ACTIVE_VERSION_DELETE_REJECTED']],
    ['版本号格式无效', [400, 'INVALID_VERSION']]
  ]);
  const mapping = mappings.get(error?.message);
  return mapping ? new HttpError(mapping[0], error.message, mapping[1]) : error;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, '请求路径无效', 'INVALID_PATH');
  }
}

async function createApplication(options = {}) {
  process.umask(0o077);
  const config = loadConfig(options);
  const store = new ReleaseStore(config.dataDirectory);
  await store.initialize();
  const activationStore = new ActivationStore(config.dataDirectory);
  await activationStore.initialize();
  const signingKeySource = options.signingPrivateKey || await fs.promises.readFile(config.signingPrivateKeyPath);
  const signingPrivateKey = signingKeySource?.type === 'private'
    ? signingKeySource
    : crypto.createPrivateKey(signingKeySource);
  if (signingPrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('更新签名私钥必须使用 Ed25519');

  const sessions = new SessionStore(options.sessionOptions);
  const loginLimiter = new LoginRateLimiter(options.loginRateOptions);
  const activationIpLimiter = new LoginRateLimiter(options.activationIpRateOptions || {
    maxFailures: 8,
    windowMs: 15 * 60 * 1000,
    blockMs: 30 * 60 * 1000
  });
  const activationDeviceLimiter = new LoginRateLimiter(options.activationDeviceRateOptions || {
    maxFailures: 5,
    windowMs: 15 * 60 * 1000,
    blockMs: 30 * 60 * 1000
  });
  const pendingUploads = new Map();
  const authPath = path.join(config.dataDirectory, 'auth.json');
  const staticFiles = new Map([
    ['/admin', { path: path.join(APP_ROOT, 'public', 'admin.html'), type: 'text/html; charset=utf-8' }],
    ['/assets/admin.css', { path: path.join(APP_ROOT, 'public', 'admin.css'), type: 'text/css; charset=utf-8' }],
    ['/assets/admin.js', { path: path.join(APP_ROOT, 'public', 'admin.js'), type: 'text/javascript; charset=utf-8' }],
    ['/assets/app-icon.png', { path: config.brandIconPath, type: 'image/png' }]
  ]);

  const maintenanceTimer = setInterval(() => {
    sessions.cleanup();
    const now = Date.now();
    for (const [uploadId, upload] of pendingUploads) {
      if (upload.expiresAt <= now) pendingUploads.delete(uploadId);
    }
  }, 60_000);
  maintenanceTimer.unref();

  async function loadAuthRecord() {
    try {
      return JSON.parse(await fs.promises.readFile(authPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function currentSession(req) {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const session = sessions.get(token);
    if (!session || session.ip !== clientIp(req, config)) return null;
    return session;
  }

  function requireSession(req) {
    const session = currentSession(req);
    if (!session) throw new HttpError(401, '请先登录', 'AUTH_REQUIRED');
    return session;
  }

  function requireWriteSession(req) {
    assertSafeOrigin(req, config);
    const session = requireSession(req);
    if (!equalText(req.headers['x-csrf-token'], session.csrfToken)) {
      throw new HttpError(403, '安全令牌无效，请重新登录', 'CSRF_REJECTED');
    }
    return session;
  }

  async function safeAudit(entry) {
    await store.audit(entry).catch((error) => console.error('audit-write-failed', error.message));
  }

  function authenticatedLicense(req, markUpdate = false) {
    return activationStore.authenticate(req.headers.authorization, {
      appVersion: req.headers['x-deskpet-version'],
      markUpdate
    });
  }

  function requireLicense(req, markUpdate = false) {
    const license = authenticatedLicense(req, markUpdate);
    if (!license) throw new HttpError(401, '设备授权无效或已撤销', 'LICENSE_REQUIRED');
    return license;
  }

  async function serveStatic(req, res, route) {
    const item = staticFiles.get(route);
    if (!item) return false;
    try {
      const stat = await fs.promises.stat(item.path);
      if (!stat.isFile()) return false;
      applySecurityHeaders(res, config);
      res.statusCode = 200;
      res.setHeader('Content-Type', item.type);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', route === '/admin' ? 'no-store' : 'public, max-age=3600');
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(item.path).pipe(res);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function serveDownload(req, res, pathname) {
    const prefix = '/downloads/';
    if (!pathname.startsWith(prefix) || !['GET', 'HEAD'].includes(req.method)) return false;
    let fileName;
    try {
      fileName = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      throw new HttpError(400, '下载地址无效', 'INVALID_DOWNLOAD_PATH');
    }
    if (!fileName || path.basename(fileName) !== fileName) throw new HttpError(404, '版本文件不存在', 'NOT_FOUND');
    const release = store.findPublishedFile(fileName);
    if (!release) throw new HttpError(404, '版本文件不存在', 'NOT_FOUND');
    const isBootstrap = release.version === config.bootstrapVersion;
    if (!isBootstrap) requireLicense(req);
    const filePath = store.filePath(release);
    const stat = await fs.promises.stat(filePath);
    let range;
    try {
      range = parseRange(req.headers.range, stat.size);
    } catch (error) {
      if (error.status === 416) error.totalSize = stat.size;
      throw error;
    }
    applySecurityHeaders(res, config);
    res.statusCode = range ? 206 : 200;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', isBootstrap ? 'public, max-age=31536000, immutable' : 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${release.fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('ETag', `"${release.sha256}"`);
    if (range) {
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.setHeader('Content-Length', stat.size);
    }
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, range || undefined).pipe(res);
    return true;
  }

  async function handleAdminApi(req, res, url) {
    const route = url.pathname;
    if (route === '/api/admin/login' && req.method === 'POST') {
      assertSafeOrigin(req, config);
      const ip = clientIp(req, config);
      const rateStatus = loginLimiter.status(ip);
      if (!rateStatus.allowed) {
        throw new HttpError(429, `登录尝试过多，请在 ${rateStatus.retryAfterSeconds} 秒后重试`, 'LOGIN_RATE_LIMITED');
      }
      const authRecord = await loadAuthRecord();
      if (!authRecord) throw new HttpError(503, '管理员密码尚未配置', 'ADMIN_NOT_CONFIGURED');
      const body = await readJson(req);
      const usernameValid = body?.username === 'admin';
      const passwordValid = await verifyPassword(body?.password, authRecord);
      if (!usernameValid || !passwordValid) {
        const nextStatus = loginLimiter.fail(ip);
        await safeAudit({ action: 'login', outcome: 'denied', ip });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const message = nextStatus.allowed ? '用户名或密码错误' : `登录尝试过多，请在 ${nextStatus.retryAfterSeconds} 秒后重试`;
        throw new HttpError(nextStatus.allowed ? 401 : 429, message, nextStatus.allowed ? 'LOGIN_FAILED' : 'LOGIN_RATE_LIMITED');
      }
      loginLimiter.reset(ip);
      const session = sessions.create(ip);
      await safeAudit({ action: 'login', outcome: 'success', ip });
      return sendJson(res, config, 200, {
        authenticated: true,
        username: 'admin',
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString()
      }, { 'Set-Cookie': sessionCookie(config, session.token, Math.floor((session.expiresAt - Date.now()) / 1000)) });
    }

    if (route === '/api/admin/session' && req.method === 'GET') {
      const session = currentSession(req);
      if (!session) return sendJson(res, config, 200, { authenticated: false });
      return sendJson(res, config, 200, {
        authenticated: true,
        username: 'admin',
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString()
      });
    }

    if (route === '/api/admin/logout' && req.method === 'POST') {
      const session = requireWriteSession(req);
      sessions.destroy(session.token);
      await safeAudit({ action: 'logout', outcome: 'success', ip: clientIp(req, config) });
      return sendJson(res, config, 200, { ok: true }, { 'Set-Cookie': sessionCookie(config, '', 0) });
    }

    if (route === '/api/admin/releases' && req.method === 'GET') {
      requireSession(req);
      return sendJson(res, config, 200, {
        publicUrl: config.publicUrl.href.replace(/\/$/, ''),
        manifestUrl: new URL('/api/update/latest', config.publicUrl).href,
        bootstrapVersion: config.bootstrapVersion,
        activeVersion: store.data.activeVersion,
        releases: store.list()
      });
    }

    if (route === '/api/admin/activation-codes' && req.method === 'GET') {
      requireSession(req);
      return sendJson(res, config, 200, activationStore.list());
    }

    if (route === '/api/admin/activation-codes' && req.method === 'POST') {
      requireWriteSession(req);
      const body = await readJson(req);
      let generated;
      try {
        generated = activationStore.createCodes({
          count: Number(body?.count),
          expiresInDays: Number(body?.expiresInDays),
          note: body?.note
        });
      } catch (error) {
        throw new HttpError(400, error.message, 'INVALID_ACTIVATION_CODE_REQUEST');
      }
      await safeAudit({
        action: 'activation-code-generate',
        outcome: 'success',
        ip: clientIp(req, config),
        count: generated.codes.length,
        expiresAt: generated.expiresAt
      });
      return sendJson(res, config, 201, generated);
    }

    const revealActivationCodeMatch = /^\/api\/admin\/activation-codes\/([0-9a-f-]{36})\/reveal$/i.exec(route);
    if (revealActivationCodeMatch && req.method === 'POST') {
      requireWriteSession(req);
      const revealed = activationStore.reveal(revealActivationCodeMatch[1]);
      if (!revealed) {
        throw new HttpError(404, '该激活码为旧记录，无法恢复完整内容', 'ACTIVATION_CODE_NOT_REVEALABLE');
      }
      await safeAudit({
        action: 'activation-code-reveal',
        outcome: 'success',
        ip: clientIp(req, config),
        activationCodeId: revealed.id
      });
      return sendJson(res, config, 200, { code: revealed.code });
    }

    const revokeLicenseMatch = /^\/api\/admin\/licenses\/([0-9a-f-]{36})\/revoke$/i.exec(route);
    if (revokeLicenseMatch && req.method === 'POST') {
      requireWriteSession(req);
      const license = activationStore.revoke(revokeLicenseMatch[1]);
      if (!license) throw new HttpError(404, '有效授权不存在', 'LICENSE_NOT_FOUND');
      await safeAudit({
        action: 'license-revoke',
        outcome: 'success',
        ip: clientIp(req, config),
        licenseId: license.id
      });
      return sendJson(res, config, 200, { license });
    }

    if (route === '/api/admin/releases' && req.method === 'POST') {
      const session = requireWriteSession(req);
      const body = await readJson(req);
      const version = normalizeVersion(body?.version);
      const originalName = path.basename(String(body?.fileName || '')).slice(0, 160);
      const fileSize = Number(body?.fileSize);
      const notes = String(body?.notes || '').replace(/\r/g, '').trim();
      if (!originalName.toLowerCase().endsWith('.exe')) throw new HttpError(400, '只允许上传 EXE 文件', 'INVALID_FILE_TYPE');
      if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > config.maxUploadSize) {
        throw new HttpError(400, '安装包大小无效或超过 300 MB', 'INVALID_FILE_SIZE');
      }
      if (notes.length > 1200) throw new HttpError(400, '更新说明不能超过 1200 个字符', 'NOTES_TOO_LONG');
      if (store.has(version)) throw new HttpError(409, '该版本已经存在', 'VERSION_EXISTS');
      const uploadId = randomToken(24);
      pendingUploads.set(uploadId, {
        sessionToken: session.token,
        version,
        originalName,
        fileSize,
        notes,
        expiresAt: Date.now() + UPLOAD_TTL_MS
      });
      return sendJson(res, config, 201, { uploadId, uploadUrl: `/api/admin/uploads/${uploadId}` });
    }

    const uploadMatch = /^\/api\/admin\/uploads\/([A-Za-z0-9_-]{20,80})$/.exec(route);
    if (uploadMatch && req.method === 'PUT') {
      const session = requireWriteSession(req);
      const uploadId = uploadMatch[1];
      const pending = pendingUploads.get(uploadId);
      if (!pending || pending.expiresAt <= Date.now() || pending.sessionToken !== session.token) {
        pendingUploads.delete(uploadId);
        throw new HttpError(404, '上传任务不存在或已过期', 'UPLOAD_NOT_FOUND');
      }
      const contentLength = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(contentLength) || contentLength !== pending.fileSize) {
        throw new HttpError(400, '上传文件大小与登记信息不一致', 'UPLOAD_SIZE_MISMATCH');
      }
      if (req.headers['content-encoding']) throw new HttpError(400, '上传文件不能使用内容编码', 'UPLOAD_ENCODING_REJECTED');
      const temporaryPath = store.uploadPath(uploadId);
      const hash = crypto.createHash('sha256');
      let received = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > pending.fileSize || received > config.maxUploadSize) {
            return callback(new HttpError(413, '上传文件超过允许大小', 'UPLOAD_TOO_LARGE'));
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      pendingUploads.delete(uploadId);
      try {
        await pipeline(req, meter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
        if (received !== pending.fileSize) throw new HttpError(400, '上传未完整完成', 'UPLOAD_INCOMPLETE');
        let release;
        try {
          release = await store.commitUpload({
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
        await safeAudit({ action: 'upload', outcome: 'success', ip: clientIp(req, config), version: release.version, sha256: release.sha256 });
        return sendJson(res, config, 201, { release });
      } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        await safeAudit({ action: 'upload', outcome: 'failed', ip: clientIp(req, config), version: pending.version });
        throw error;
      }
    }

    const publishMatch = /^\/api\/admin\/releases\/([^/]+)\/publish$/.exec(route);
    if (publishMatch && req.method === 'POST') {
      requireWriteSession(req);
      const version = decodePathSegment(publishMatch[1]);
      let release;
      try {
        release = await store.publish(version);
      } catch (error) {
        throw mapStoreError(error);
      }
      await safeAudit({ action: 'publish', outcome: 'success', ip: clientIp(req, config), version: release.version });
      return sendJson(res, config, 200, { release });
    }

    const deleteMatch = /^\/api\/admin\/releases\/([^/]+)$/.exec(route);
    if (deleteMatch && req.method === 'DELETE') {
      requireWriteSession(req);
      const version = decodePathSegment(deleteMatch[1]);
      if (version === config.bootstrapVersion && store.data.activeVersion !== version) {
        throw new HttpError(409, '激活过渡版本不能删除', 'BOOTSTRAP_VERSION_DELETE_REJECTED');
      }
      let release;
      try {
        release = await store.delete(version);
      } catch (error) {
        throw mapStoreError(error);
      }
      await safeAudit({ action: 'delete', outcome: 'success', ip: clientIp(req, config), version: release.version });
      return sendJson(res, config, 200, { ok: true });
    }

    return false;
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const localAdminRequest = isAdminPath(url.pathname) && isLoopbackRequest(req);
      if (config.adminLoopbackOnly && isAdminPath(url.pathname) && !localAdminRequest) {
        throw new HttpError(404, 'Not found', 'NOT_FOUND');
      }
      if (config.enforceHost && req.headers.host !== config.publicUrl.host && !localAdminRequest) {
        throw new HttpError(421, '请求主机无效', 'HOST_REJECTED');
      }
      if (config.requireHttps && !isSecureRequest(req, config) && !localAdminRequest && url.pathname !== '/healthz') {
        return sendRedirect(res, config, new URL(`${url.pathname}${url.search}`, config.publicUrl).href);
      }
      if (url.pathname === '/healthz' && req.method === 'GET') {
        const configured = Boolean(await loadAuthRecord());
        return sendJson(res, config, 200, {
          ok: true,
          service: 'deskpet-update',
          configured,
          activeVersion: store.data.activeVersion,
          tls: isSecureRequest(req, config)
        });
      }
      if (url.pathname === '/api/activate' && req.method === 'POST') {
        const ip = clientIp(req, config);
        const ipStatus = activationIpLimiter.status(ip);
        if (!ipStatus.allowed) {
          throw new HttpError(429, `激活尝试过多，请在 ${ipStatus.retryAfterSeconds} 秒后重试`, 'ACTIVATION_RATE_LIMITED');
        }
        const body = await readJson(req, 4096);
        const installationId = String(body?.installationId || '');
        const deviceStatus = activationDeviceLimiter.status(installationId || 'invalid');
        if (!deviceStatus.allowed) {
          throw new HttpError(429, `激活尝试过多，请在 ${deviceStatus.retryAfterSeconds} 秒后重试`, 'ACTIVATION_RATE_LIMITED');
        }
        const license = activationStore.activate({
          code: body?.code,
          installationId,
          credential: body?.credential,
          appVersion: body?.appVersion
        });
        if (!license) {
          const nextIpStatus = activationIpLimiter.fail(ip);
          const nextDeviceStatus = activationDeviceLimiter.fail(installationId || 'invalid');
          await safeAudit({ action: 'activate', outcome: 'denied', ip });
          await new Promise((resolve) => setTimeout(resolve, 300));
          const retryAfter = Math.max(nextIpStatus.retryAfterSeconds, nextDeviceStatus.retryAfterSeconds);
          if (retryAfter > 0) {
            throw new HttpError(429, `激活尝试过多，请在 ${retryAfter} 秒后重试`, 'ACTIVATION_RATE_LIMITED');
          }
          throw new HttpError(401, '激活码无效、已使用或已过期', 'ACTIVATION_REJECTED');
        }
        activationIpLimiter.reset(ip);
        activationDeviceLimiter.reset(installationId);
        await safeAudit({
          action: 'activate',
          outcome: license.alreadyActivated ? 'retry' : 'success',
          ip,
          licenseId: license.licenseId
        });
        return sendJson(res, config, 200, license);
      }
      if (url.pathname === '/api/update/latest' && req.method === 'GET') {
        let manifest;
        if (req.headers.authorization) {
          requireLicense(req, true);
          manifest = store.manifest(config.publicUrl);
        } else {
          manifest = store.manifest(config.publicUrl, config.bootstrapVersion);
          if (!manifest && !store.find(config.bootstrapVersion)) manifest = store.manifest(config.publicUrl);
        }
        if (!manifest) {
          if (!store.active()) throw new HttpError(404, '暂未发布版本', 'NO_RELEASE');
          throw new HttpError(401, '请先激活桌搭子', 'ACTIVATION_REQUIRED');
        }
        const signature = crypto.sign(null, signedManifestPayload(manifest), signingPrivateKey).toString('base64');
        return sendJson(res, config, 200, {
          ...manifest,
          signatureAlgorithm: 'ed25519',
          signature
        });
      }
      if (await serveDownload(req, res, url.pathname)) return;
      if (url.pathname.startsWith('/api/admin/')) {
        const handled = await handleAdminApi(req, res, url);
        if (handled !== false) return;
      }
      if (url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) return sendRedirect(res, config, '/admin');
      if (['GET', 'HEAD'].includes(req.method) && await serveStatic(req, res, url.pathname)) return;
      throw new HttpError(404, 'Not found', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error('request-failed', error);
      const headers = {};
      if (status === 416 && error.totalSize) headers['Content-Range'] = `bytes */${error.totalSize}`;
      if (!res.headersSent) {
        const message = status >= 500 ? '服务器内部错误' : error.message || '请求失败';
        sendJson(res, config, status, { error: message, code: error.code || 'INTERNAL_ERROR' }, headers);
      } else {
        res.destroy();
      }
    }
  }

  return {
    config,
    handler,
    store,
    activationStore,
    close() {
      clearInterval(maintenanceTimer);
      activationStore.close();
    }
  };
}

function configureServer(server) {
  server.headersTimeout = 20_000;
  server.requestTimeout = 20 * 60 * 1000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
}

async function listen(server, port, host) {
  configureServer(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function start() {
  const application = await createApplication();
  const servers = [];
  const httpServer = http.createServer(application.handler);
  await listen(httpServer, application.config.httpPort, application.config.httpHost);
  servers.push(httpServer);
  console.log(`deskpet-update http listening on ${application.config.httpHost}:${application.config.httpPort}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    application.close();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  };
  process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function signedManifestPayload(manifest) {
  return Buffer.from(JSON.stringify({
    version: manifest.version,
    url: manifest.url,
    sha256: manifest.sha256,
    notes: manifest.notes
  }), 'utf8');
}

module.exports = { HttpError, createApplication, loadConfig, signedManifestPayload, start };
