class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function mapStoreError(error) {
  if (error instanceof HttpError) return error;
  if (error?.message === '发布平台无效' || /不支持该架构$/.test(error?.message || '')) {
    return new HttpError(400, error.message, 'INVALID_RELEASE_TARGET');
  }
  const mappings = new Map([
    ['版本不存在', [404, 'VERSION_NOT_FOUND']],
    ['该版本已经存在', [409, 'VERSION_EXISTS']],
    ['该平台和架构的版本已经存在', [409, 'VERSION_EXISTS']],
    ['当前发布版本不能删除', [409, 'ACTIVE_VERSION_DELETE_REJECTED']],
    ['版本号格式无效', [400, 'INVALID_VERSION']]
  ]);
  const mapping = mappings.get(error?.message);
  return mapping ? new HttpError(mapping[0], error.message, mapping[1]) : error;
}

module.exports = { HttpError, mapStoreError };
