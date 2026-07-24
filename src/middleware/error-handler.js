const { HttpError } = require('../errors/http-error');

function notFound(_req, _res, next) {
  next(new HttpError(404, 'Not found', 'NOT_FOUND'));
}

function normalizeExpressError(error) {
  if (error instanceof HttpError) return error;
  if (error?.type === 'entity.too.large') {
    return new HttpError(413, '请求内容过大', 'BODY_TOO_LARGE');
  }
  if (error?.type === 'entity.parse.failed') {
    return new HttpError(400, 'JSON 格式无效', 'INVALID_JSON');
  }
  if (error instanceof URIError) {
    return new HttpError(400, '请求路径无效', 'INVALID_PATH');
  }
  return error;
}

function errorHandler(sourceError, _req, res, next) {
  const error = normalizeExpressError(sourceError);
  if (res.headersSent) return next(error);

  const status = Number(error.status) || 500;
  if (status >= 500) console.error('request-failed', error);
  if (status === 416 && error.totalSize) {
    res.setHeader('Content-Range', `bytes */${error.totalSize}`);
  }
  const message = status >= 500 ? '服务器内部错误' : error.message || '请求失败';
  return res.status(status).json({
    error: message,
    code: error.code || 'INTERNAL_ERROR'
  });
}

module.exports = { errorHandler, notFound, normalizeExpressError };
