const path = require('node:path');
const { normalizeVersion } = require('../../lib/storage');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CANONICAL_PUBLIC_URL = 'https://in.desktoppet.online';
const MAX_JSON_BODY = 32 * 1024;
const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

function optionalText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeOssDownloadDomain(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash
      || !url.hostname.includes('.')
      || !url.hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      throw new Error();
    }
    return url.hostname;
  } catch {
    throw new Error('OSS_DOWNLOAD_DOMAIN 必须是已绑定 OSS 且配置 HTTPS 的域名，不含路径、端口或查询参数');
  }
}

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

  const ossValues = {
    region: overrides.ossRegion || process.env.OSS_REGION || '',
    endpoint: overrides.ossEndpoint || process.env.OSS_ENDPOINT || '',
    bucket: overrides.ossBucket || process.env.OSS_BUCKET || '',
    accessKeyId: overrides.ossAccessKeyId || process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: overrides.ossAccessKeySecret || process.env.OSS_ACCESS_KEY_SECRET || '',
    prefix: overrides.ossPrefix ?? process.env.OSS_PREFIX ?? '',
    urlExpires: Number(overrides.ossUrlExpires || process.env.OSS_URL_EXPIRES || 900),
    downloadDomain: normalizeOssDownloadDomain(overrides.ossDownloadDomain ?? process.env.OSS_DOWNLOAD_DOMAIN)
  };
  const ossConfigured = Object.values(ossValues).slice(0, 5).some(Boolean);
  if (ossConfigured && Object.values(ossValues).slice(0, 5).some((value) => !value)) {
    throw new Error('OSS 配置不完整，需要 OSS_REGION、OSS_ENDPOINT、OSS_BUCKET、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET');
  }
  if (!Number.isInteger(ossValues.urlExpires) || ossValues.urlExpires < 60 || ossValues.urlExpires > 86400) {
    throw new Error('OSS_URL_EXPIRES 必须是 60 到 86400 秒之间的整数');
  }

  const bootstrapVersion = normalizeVersion(
    overrides.bootstrapVersion || process.env.DESKPET_BOOTSTRAP_VERSION || '2.5.7'
  );
  const macosBootstrapVersion = overrides.macosBootstrapVersion || process.env.DESKPET_MACOS_BOOTSTRAP_VERSION;
  const bootstrapVersions = {
    'windows/x64': bootstrapVersion
  };
  if (macosBootstrapVersion) {
    bootstrapVersions['macos/arm64'] = normalizeVersion(macosBootstrapVersion);
    bootstrapVersions['macos/x86_64'] = normalizeVersion(macosBootstrapVersion);
  }

  const petMarketBridgeToken = optionalText(
    overrides.petMarketBridgeToken ?? process.env.DESKPET_PET_MARKET_BRIDGE_TOKEN
  );
  const petMarketCollectionAccountId = optionalText(
    overrides.petMarketCollectionAccountId
      ?? process.env.DESKPET_PET_MARKET_COLLECTION_ACCOUNT_ID
  );
  if (Boolean(petMarketBridgeToken) !== Boolean(petMarketCollectionAccountId)) {
    throw new Error('桌宠市场付款桥接令牌与收款账号必须同时配置');
  }
  if (petMarketBridgeToken && (petMarketBridgeToken.length < 24
      || petMarketBridgeToken.length > 256)) {
    throw new Error('桌宠市场付款桥接令牌长度必须为 24 至 256 个字符');
  }
  if (petMarketCollectionAccountId && petMarketCollectionAccountId.length > 256) {
    throw new Error('桌宠市场收款账号不能超过 256 个字符');
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
    maxUploadSize: Number(overrides.maxUploadSize || MAX_UPLOAD_SIZE),
    petMarketBridgeToken,
    petMarketCollectionAccountId,
    oss: ossConfigured ? ossValues : null,
    // Service-to-service credentials are never persisted in the application DB.
    wechatInternalClientId: String(
      overrides.wechatInternalClientId
        ?? process.env.DESKPET_WECHAT_INTERNAL_CLIENT_ID
        ?? process.env.DESKPET_INTERNAL_CLIENT_ID
        ?? ''
    ).trim(),
    wechatInternalSecret: String(
      overrides.wechatInternalSecret
        ?? process.env.DESKPET_WECHAT_INTERNAL_SECRET
        ?? process.env.DESKPET_INTERNAL_SECRET
        ?? ''
    )
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
