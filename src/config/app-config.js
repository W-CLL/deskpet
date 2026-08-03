const path = require('node:path');
const { normalizeVersion } = require('../../lib/storage');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CANONICAL_PUBLIC_URL = 'https://in.desktoppet.online';
const MAX_JSON_BODY = 32 * 1024;
const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

function loadConfig(overrides = {}) {
  const configuredPublicUrl = new URL(
    overrides.publicUrl || process.env.DESKPET_PUBLIC_URL || CANONICAL_PUBLIC_URL
  );
  if (!['https:', 'http:'].includes(configuredPublicUrl.protocol)) {
    throw new Error('DESKPET_PUBLIC_URL 必须使用 HTTP 或 HTTPS');
  }
  const isLoopbackPublicUrl = ['127.0.0.1', 'localhost', '[::1]']
    .includes(configuredPublicUrl.hostname.toLowerCase());
  const publicUrl = isLoopbackPublicUrl
    ? configuredPublicUrl
    : new URL(CANONICAL_PUBLIC_URL);

  const dataDirectory = path.resolve(
    overrides.dataDirectory || process.env.DESKPET_DATA_DIR || path.join(PROJECT_ROOT, 'data')
  );

  const bootstrapVersion = normalizeVersion(
    overrides.bootstrapVersion || process.env.DESKPET_BOOTSTRAP_VERSION || '2.1.0'
  );
  const macosBootstrapVersion = overrides.macosBootstrapVersion || process.env.DESKPET_MACOS_BOOTSTRAP_VERSION;
  const bootstrapVersions = {
    'windows/x64': bootstrapVersion
  };
  if (macosBootstrapVersion) {
    bootstrapVersions['macos/arm64'] = normalizeVersion(macosBootstrapVersion);
    bootstrapVersions['macos/x86_64'] = normalizeVersion(macosBootstrapVersion);
  }

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
    // Kept for deployments and callers that only serve the original Windows client.
    bootstrapVersion,
    bootstrapVersions,
    cookieSecure: overrides.cookieSecure ?? publicUrl.protocol === 'https:',
    trustProxy: overrides.trustProxy ?? /^true$/i.test(process.env.DESKPET_TRUST_PROXY || ''),
    maxUploadSize: Number(overrides.maxUploadSize || MAX_UPLOAD_SIZE)
  };
}

module.exports = {
  CANONICAL_PUBLIC_URL,
  MAX_JSON_BODY,
  MAX_UPLOAD_SIZE,
  PROJECT_ROOT,
  UPLOAD_TTL_MS,
  loadConfig
};
