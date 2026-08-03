const { HttpError } = require('../errors/http-error');

const SESSION_COOKIE = 'deskpet_session';

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

function isTrustedProxy(req, config) {
  return config.trustProxy && isLoopbackIp(directIp(req));
}

function clientIp(req, config) {
  if (!isTrustedProxy(req, config)) return directIp(req);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded && forwarded.length <= 64 ? forwarded : directIp(req);
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
  if (origin && origin !== allowedOrigin) {
    throw new HttpError(403, '请求来源无效', 'ORIGIN_REJECTED');
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw new HttpError(403, '跨站请求已拒绝', 'CROSS_SITE_REJECTED');
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) {
    throw new HttpError(416, '下载范围无效', 'INVALID_RANGE');
  }

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) {
      throw new HttpError(416, '下载范围无效', 'INVALID_RANGE');
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || start > end
    || start >= size) {
    throw new HttpError(416, '下载范围无效', 'INVALID_RANGE');
  }
  return { start, end: Math.min(end, size - 1) };
}

module.exports = {
  SESSION_COOKIE,
  assertSafeOrigin,
  clientIp,
  directIp,
  isLoopbackRequest,
  isTrustedProxy,
  parseRange,
  sessionCookie
};
