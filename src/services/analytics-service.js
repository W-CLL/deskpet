const crypto = require('node:crypto');
const {
  normalizeArchitecture,
  normalizePlatform,
  normalizeVersion
} = require('../../lib/storage');
const { collapseNewlines: clean } = require('../../lib/text');
const { HttpError } = require('../errors/http-error');
const { clientIp } = require('../http/request-context');

const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{12,100}$/;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{20,80}$/;
const MAX_EVENTS_PER_BATCH = 25;
const MAX_EVENT_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_IP = 120;

const PUBLIC_EVENT_TYPES = new Set([
  'page_view',
  'download_click',
  'resource_download_click',
  'app_first_launch',
  'app_session_start',
  'app_daily_active'
]);

function dateKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function hashInstallationId(value) {
  return crypto.createHash('sha256').update(`deskpet-analytics-v1:${value}`).digest('hex');
}

function invalidEvent(index, message) {
  throw new HttpError(400, `第 ${index + 1} 条数据${message}`, 'INVALID_ANALYTICS_EVENT');
}

class AnalyticsService {
  constructor({ analyticsStore, authenticateLicense, config }) {
    this.analyticsStore = analyticsStore;
    this.authenticateLicense = authenticateLicense || null;
    this.config = config;
    this.rateLimits = new Map();
  }

  async recordPublic(req, body) {
    this.assertRateLimit(req);
    const source = Array.isArray(body?.events) ? body.events : [body];
    if (source.length < 1 || source.length > MAX_EVENTS_PER_BATCH) {
      throw new HttpError(400, `每批必须包含 1 至 ${MAX_EVENTS_PER_BATCH} 条数据`, 'INVALID_ANALYTICS_BATCH');
    }
    let license = null;
    if (req.headers.authorization && this.authenticateLicense) {
      license = this.authenticateLicense(req);
    }
    const events = source.map((item, index) => this.normalizeEvent(item, index, license));
    const result = this.analyticsStore.recordEvents(events);
    return { ...result, accepted: result.accepted };
  }

  assertRateLimit(req) {
    const now = Date.now();
    if (this.rateLimits.size > 10_000) {
      for (const [address, record] of this.rateLimits) {
        if (record.resetAt <= now) this.rateLimits.delete(address);
      }
    }
    const key = clientIp(req, this.config);
    const current = this.rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }
    if (current.count >= MAX_REQUESTS_PER_IP) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      const error = new HttpError(429, `统计上报过于频繁，请在 ${retryAfter} 秒后重试`, 'ANALYTICS_RATE_LIMITED');
      error.retryAfterSeconds = retryAfter;
      throw error;
    }
    current.count += 1;
  }

  recordActivation(req, license, body) {
    const installationId = clean(body?.installationId, 80);
    if (!INSTALLATION_ID_PATTERN.test(installationId)) return;
    const occurredAt = new Date().toISOString();
    try {
      this.analyticsStore.recordEvents([{
        eventId: `activation:${license.licenseId}`,
        type: 'activation_success',
        installationHash: hashInstallationId(installationId),
        accountId: license.accountId,
        platform: clean(req.headers['x-deskpet-platform'] || 'windows', 20).toLowerCase(),
        architecture: clean(req.headers['x-deskpet-architecture'] || '', 20).toLowerCase(),
        version: normalizeOptionalVersion(body?.appVersion),
        eventDate: dateKey(new Date(occurredAt)),
        occurredAt
      }]);
    } catch {
      // Analytics must never prevent a successful activation.
    }
  }

  summary(range = {}) {
    const { from, to } = normalizeRange(range.from, range.to);
    return this.analyticsStore.summary({ from, to });
  }

  normalizeEvent(source, index, license = null, now = Date.now()) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) invalidEvent(index, '格式无效');
    const eventId = clean(source.eventId, 160);
    if (!EVENT_ID_PATTERN.test(eventId)) invalidEvent(index, '缺少有效 eventId');
    const type = clean(source.type, 40).toLowerCase();
    if (!PUBLIC_EVENT_TYPES.has(type)) invalidEvent(index, '类型无效');

    const occurredTimestamp = Date.parse(source.occurredAt || new Date(now).toISOString());
    if (!Number.isFinite(occurredTimestamp)) invalidEvent(index, '发生时间无效');
    if (occurredTimestamp < now - MAX_EVENT_AGE_MS) invalidEvent(index, '发生时间过早');
    if (occurredTimestamp > now + MAX_FUTURE_SKEW_MS) invalidEvent(index, '发生时间晚于服务器时间');

    const event = {
      eventId,
      type,
      visitorId: normalizeOptionalId(source.visitorId, VISITOR_ID_PATTERN, index, '访客标识'),
      sessionId: normalizeOptionalId(source.sessionId, VISITOR_ID_PATTERN, index, '会话标识'),
      pagePath: clean(source.pagePath, 240),
      referrer: clean(source.referrer, 500),
      utmSource: clean(source.utmSource, 80),
      utmMedium: clean(source.utmMedium, 80),
      utmCampaign: clean(source.utmCampaign, 120),
      platform: '',
      architecture: '',
      version: normalizeOptionalVersion(source.version),
      occurredAt: new Date(occurredTimestamp).toISOString(),
      eventDate: dateKey(new Date(occurredTimestamp))
    };

    const installationId = clean(source.installationId, 80);
    if (type.startsWith('app_')) {
      if (!INSTALLATION_ID_PATTERN.test(installationId)) invalidEvent(index, '缺少有效安装标识');
      event.installationHash = hashInstallationId(installationId);
      event.platform = normalizeEventPlatform(source.platform || 'windows', index);
      event.architecture = normalizeEventArchitecture(event.platform, source.architecture, index);
      if (license) event.accountId = license.accountId;
    }
    if (type === 'page_view' && !event.visitorId) invalidEvent(index, '缺少访客标识');
    if (['download_click', 'resource_download_click'].includes(type)
      && (!event.visitorId || !event.pagePath)) {
      invalidEvent(index, '缺少访客标识或页面路径');
    }
    return event;
  }
}

function normalizeOptionalId(value, pattern, index, label) {
  const normalized = clean(value, 100);
  if (!normalized) return '';
  if (!pattern.test(normalized)) invalidEvent(index, `${label}格式无效`);
  return normalized;
}

function normalizeOptionalVersion(value) {
  const normalized = clean(value, 40);
  return normalized ? normalizeVersion(normalized) : '';
}

function normalizeEventPlatform(value, index) {
  try {
    return normalizePlatform(value);
  } catch {
    invalidEvent(index, '平台无效');
  }
}

function normalizeEventArchitecture(platform, value, index) {
  try {
    return normalizeArchitecture(platform, value || (platform === 'windows' ? 'x64' : 'arm64'));
  } catch {
    invalidEvent(index, '架构无效');
  }
}

function normalizeRange(fromValue, toValue) {
  const today = dateKey(new Date());
  const to = toValue || today;
  const end = parseDateOnly(to);
  const defaultStart = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  const from = fromValue || dateKey(defaultStart);
  const start = parseDateOnly(from);
  if (start > end) throw new HttpError(400, '统计开始日期不能晚于结束日期', 'INVALID_ANALYTICS_RANGE');
  if ((end - start) > 366 * 24 * 60 * 60 * 1000) {
    throw new HttpError(400, '统计区间不能超过 367 天', 'INVALID_ANALYTICS_RANGE');
  }
  return { from: dateKey(start), to: dateKey(end) };
}

function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new HttpError(400, '日期格式必须为 YYYY-MM-DD', 'INVALID_ANALYTICS_RANGE');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, '日期格式无效', 'INVALID_ANALYTICS_RANGE');
  }
  return date;
}

module.exports = {
  AnalyticsService,
  hashInstallationId,
  normalizeRange
};
