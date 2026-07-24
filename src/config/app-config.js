const path = require('node:path');
const { normalizeVersion } = require('../../lib/storage');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_JSON_BODY = 32 * 1024;
const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

function loadConfig(overrides = {}) {
  const publicUrl = new URL(
    overrides.publicUrl || process.env.DESKPET_PUBLIC_URL || 'http://127.0.0.1:3100'
  );
  if (!['https:', 'http:'].includes(publicUrl.protocol)) {
    throw new Error('DESKPET_PUBLIC_URL 必须使用 HTTP 或 HTTPS');
  }

  const dataDirectory = path.resolve(
    overrides.dataDirectory || process.env.DESKPET_DATA_DIR || path.join(PROJECT_ROOT, 'data')
  );

  return {
    publicUrl,
    dataDirectory,
    projectRoot: PROJECT_ROOT,
    brandIconPath: path.resolve(
      overrides.brandIconPath
        || process.env.DESKPET_BRAND_ICON
        || path.join(PROJECT_ROOT, 'public', 'app-icon.png')
    ),
    httpHost: overrides.httpHost || process.env.DESKPET_HTTP_HOST || '0.0.0.0',
    httpPort: Number(overrides.httpPort ?? process.env.DESKPET_HTTP_PORT ?? 80),
    signingPrivateKeyPath: path.resolve(
      overrides.signingPrivateKeyPath
        || process.env.DESKPET_SIGNING_PRIVATE_KEY
        || path.join(dataDirectory, 'signing-private.pem')
    ),
    bootstrapVersion: normalizeVersion(
      overrides.bootstrapVersion || process.env.DESKPET_BOOTSTRAP_VERSION || '2.1.0'
    ),
    cookieSecure: overrides.cookieSecure ?? publicUrl.protocol === 'https:',
    trustProxy: overrides.trustProxy ?? /^true$/i.test(process.env.DESKPET_TRUST_PROXY || ''),
    maxUploadSize: Number(overrides.maxUploadSize || MAX_UPLOAD_SIZE)
  };
}

module.exports = {
  MAX_JSON_BODY,
  MAX_UPLOAD_SIZE,
  PROJECT_ROOT,
  UPLOAD_TTL_MS,
  loadConfig
};
