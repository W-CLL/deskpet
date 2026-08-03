const { isLoopbackRequest, isTrustedProxy } = require('../http/request-context');

function applySecurityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; "
      + "frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; "
      + "script-src 'self'; style-src 'self'"
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

function requestHostname(req) {
  try {
    return new URL(`http://${req.headers.host || ''}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function requestProtocol(req, config) {
  if (isTrustedProxy(req, config)) {
    const forwarded = String(
      req.headers['x-forwarded-proto'] || req.headers['x-scheme'] || ''
    ).split(',', 1)[0].trim().toLowerCase();
    if (forwarded === 'http' || forwarded === 'https') return `${forwarded}:`;
  }
  return req.protocol === 'https' ? 'https:' : 'http:';
}

function canonicalOrigin(config) {
  const hostname = config.publicUrl.hostname.toLowerCase().replace(/\.$/, '');
  const protocol = config.publicUrl.protocol;
  const origin = config.publicUrl.origin;
  return function redirectToCanonicalOrigin(req, res, next) {
    const hasProxyHeaders = Boolean(
      req.headers['x-forwarded-for']
      || req.headers['x-forwarded-proto']
      || req.headers['x-scheme']
    );
    if (isLoopbackRequest(req) && !hasProxyHeaders) return next();
    if (requestHostname(req) === hostname && requestProtocol(req, config) === protocol) {
      return next();
    }
    const originalUrl = String(req.originalUrl || req.url || '/');
    const path = originalUrl.startsWith('/') ? originalUrl : `/${originalUrl}`;
    return res.redirect(308, `${origin}${path}`);
  };
}

function accessPolicy() {
  return function setResponsePolicy(_req, res, next) {
    applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    return next();
  };
}

module.exports = { accessPolicy, applySecurityHeaders, canonicalOrigin };
