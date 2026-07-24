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

function accessPolicy() {
  return function setResponsePolicy(_req, res, next) {
    applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    return next();
  };
}

module.exports = { accessPolicy, applySecurityHeaders };
