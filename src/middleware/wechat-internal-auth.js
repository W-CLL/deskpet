const crypto = require('node:crypto');
const { HttpError } = require('../errors/http-error');

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function header(req, name) {
  return String(req.get(name) || '').trim();
}

function rawRequestBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  return Buffer.alloc(0);
}

function requestPath(req) {
  // originalUrl keeps the query string and the full mounted prefix, which is
  // exactly what the sender signs.
  return String(req.originalUrl || req.url || '/');
}

function signatureText(req, timestamp, nonce, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return [req.method.toUpperCase(), requestPath(req), timestamp, nonce, bodyHash].join('\n');
}

function createWechatInternalAuth({ config, grantStore }) {
  return function wechatInternalAuth(req, _res, next) {
    try {
      const clientId = header(req, 'X-Client-Id');
      const timestampText = header(req, 'X-Timestamp');
      const nonce = header(req, 'X-Nonce');
      const suppliedSignature = header(req, 'X-Signature').toLowerCase();
      const configuredClientId = String(config.wechatInternalClientId || '').trim();
      const secret = String(config.wechatInternalSecret || '');
      if (!configuredClientId || secret.length < 32) {
        throw new HttpError(503, '公众号内部接口尚未配置', 'INTERNAL_API_NOT_CONFIGURED');
      }
      if (clientId !== configuredClientId) {
        throw new HttpError(401, '内部接口客户端无效', 'INTERNAL_CLIENT_INVALID');
      }
      if (!/^\d{10,16}$/.test(timestampText)) {
        throw new HttpError(401, '内部接口时间戳无效', 'INTERNAL_TIMESTAMP_INVALID');
      }
      const timestamp = Number(timestampText);
      if (!Number.isSafeInteger(timestamp)
        || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
        throw new HttpError(401, '内部接口请求已过期', 'INTERNAL_TIMESTAMP_EXPIRED');
      }
      if (!/^[a-f0-9]{16,128}$/i.test(nonce)) {
        throw new HttpError(401, '内部接口 nonce 无效', 'INTERNAL_NONCE_INVALID');
      }
      if (!/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
        throw new HttpError(401, '内部接口签名无效', 'INTERNAL_SIGNATURE_INVALID');
      }
      const body = rawRequestBody(req);
      const expected = crypto.createHmac('sha256', secret)
        .update(signatureText(req, timestampText, nonce, body), 'utf8')
        .digest('hex');
      const expectedBuffer = Buffer.from(expected, 'ascii');
      const suppliedBuffer = Buffer.from(suppliedSignature, 'ascii');
      if (expectedBuffer.length !== suppliedBuffer.length
        || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        throw new HttpError(401, '内部接口签名无效', 'INTERNAL_SIGNATURE_INVALID');
      }
      if (!grantStore.consumeNonce(clientId, nonce)) {
        throw new HttpError(409, '内部接口请求重复提交', 'INTERNAL_NONCE_REPLAY');
      }
      req.wechatInternalClientId = clientId;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  MAX_CLOCK_SKEW_MS,
  createWechatInternalAuth,
  requestPath,
  signatureText
};
