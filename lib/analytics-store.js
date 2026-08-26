const path = require('node:path');
const { openMigratedDatabase } = require('./sqlite-migrations');

const ANALYTICS_EVENT_TYPES = Object.freeze([
  'page_view',
  'download_click',
  'resource_download_click',
  'app_first_launch',
  'app_session_start',
  'app_daily_active',
  'activation_success'
]);
const ANALYTICS_MIGRATION_SCOPE = 'analytics';
const RAW_EVENT_RETENTION_DAYS = 180;

function nowIso() {
  return new Date().toISOString();
}

const ANALYTICS_MIGRATIONS = [
  {
    version: 1,
    name: 'analytics-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS analytics_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL CHECK (event_type IN (
            'page_view', 'download_click', 'app_first_launch',
            'app_session_start', 'app_daily_active', 'activation_success'
          )),
          visitor_id TEXT,
          session_id TEXT,
          installation_hash TEXT,
          account_id TEXT,
          page_path TEXT,
          referrer TEXT,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
          platform TEXT,
          architecture TEXT,
          version TEXT,
          event_date TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_events_type_date
          ON analytics_events(event_type, event_date);
        CREATE INDEX IF NOT EXISTS idx_analytics_events_install_date
          ON analytics_events(installation_hash, event_date);
        CREATE INDEX IF NOT EXISTS idx_analytics_events_visitor_date
          ON analytics_events(visitor_id, event_date);
        CREATE INDEX IF NOT EXISTS idx_analytics_events_received
          ON analytics_events(received_at);
      `);
    }
  },
  {
    version: 2,
    name: 'separate-resource-downloads',
    up(database) {
      database.exec(`
        ALTER TABLE analytics_events RENAME TO analytics_events_v1;
        CREATE TABLE analytics_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL CHECK (event_type IN (
            'page_view', 'download_click', 'resource_download_click',
            'app_first_launch', 'app_session_start', 'app_daily_active',
            'activation_success'
          )),
          visitor_id TEXT,
          session_id TEXT,
          installation_hash TEXT,
          account_id TEXT,
          page_path TEXT,
          referrer TEXT,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
          platform TEXT,
          architecture TEXT,
          version TEXT,
          event_date TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        INSERT INTO analytics_events (
          event_id, event_type, visitor_id, session_id, installation_hash,
          account_id, page_path, referrer, utm_source, utm_medium, utm_campaign,
          platform, architecture, version, event_date, occurred_at, received_at
        )
        SELECT
          event_id,
          CASE
            WHEN event_type = 'download_click' AND page_path LIKE '/resources%'
              THEN 'resource_download_click'
            ELSE event_type
          END,
          visitor_id, session_id, installation_hash,
          account_id, page_path, referrer, utm_source, utm_medium, utm_campaign,
          platform, architecture, version, event_date, occurred_at, received_at
        FROM analytics_events_v1;
        DROP TABLE analytics_events_v1;
        CREATE INDEX idx_analytics_events_type_date
          ON analytics_events(event_type, event_date);
        CREATE INDEX idx_analytics_events_install_date
          ON analytics_events(installation_hash, event_date);
        CREATE INDEX idx_analytics_events_visitor_date
          ON analytics_events(visitor_id, event_date);
        CREATE INDEX idx_analytics_events_received
          ON analytics_events(received_at);
      `);
    }
  },
  {
    version: 3,
    name: 'server-usage-details',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS usage_devices (
          device_key TEXT PRIMARY KEY,
          license_id TEXT,
          account_id TEXT,
          installation_suffix TEXT NOT NULL,
          authorization_type TEXT NOT NULL,
          platform TEXT NOT NULL,
          architecture TEXT NOT NULL,
          app_version TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_path TEXT NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          successful_requests INTEGER NOT NULL DEFAULT 0,
          last_status INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_devices_last_seen
          ON usage_devices(last_seen_at DESC);
        CREATE TABLE IF NOT EXISTS usage_api_daily (
          date TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          platform TEXT NOT NULL,
          app_version TEXT NOT NULL,
          status_group TEXT NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          successful_requests INTEGER NOT NULL DEFAULT 0,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (date, method, path, platform, app_version, status_group)
        );
        CREATE INDEX IF NOT EXISTS idx_usage_api_daily_path
          ON usage_api_daily(path, date DESC);
        CREATE TABLE IF NOT EXISTS usage_release_downloads (
          date TEXT NOT NULL,
          platform TEXT NOT NULL,
          architecture TEXT NOT NULL,
          version TEXT NOT NULL,
          download_count INTEGER NOT NULL DEFAULT 0,
          last_download_at TEXT NOT NULL,
          PRIMARY KEY (date, platform, architecture, version)
        );
        CREATE TABLE IF NOT EXISTS usage_feature_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          feature TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          account_id TEXT,
          device_key TEXT,
          installation_suffix TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT 'unknown',
          app_version TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT '',
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_feature_events_feature_time
          ON usage_feature_events(feature, occurred_at DESC);
      `);
    }
  }
];

class AnalyticsStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'analytics.db');
    this.database = null;
    this.migrationState = null;
  }

  async initialize() {
    const opened = await openMigratedDatabase({
      dataDirectory: this.dataDirectory,
      fileName: 'analytics.db',
      scope: ANALYTICS_MIGRATION_SCOPE,
      migrations: ANALYTICS_MIGRATIONS
    });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.migrationState = opened.migrationState;
  }

  recordEvents(events) {
    const receivedAt = nowIso();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO analytics_events (
        event_id, event_type, visitor_id, session_id, installation_hash,
        account_id, page_path, referrer, utm_source, utm_medium, utm_campaign,
        platform, architecture, version, event_date, occurred_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let accepted = 0;
    let duplicates = 0;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        const result = insert.run(
          event.eventId,
          event.type,
          event.visitorId || null,
          event.sessionId || null,
          event.installationHash || null,
          event.accountId || null,
          event.pagePath || null,
          event.referrer || null,
          event.utmSource || null,
          event.utmMedium || null,
          event.utmCampaign || null,
          event.platform || null,
          event.architecture || null,
          event.version || null,
          event.eventDate,
          event.occurredAt,
          receivedAt
        );
        if (result.changes === 1) accepted += 1;
        else duplicates += 1;
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    return { accepted, duplicates, receivedAt };
  }

  recordRequest(event) {
    const occurredAt = event.occurredAt || nowIso();
    const successful = event.status >= 200 && event.status < 400 ? 1 : 0;
    const statusGroup = `${Math.floor(event.status / 100)}xx`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO usage_api_daily (
          date, method, path, platform, app_version, status_group,
          request_count, successful_requests, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(date, method, path, platform, app_version, status_group)
        DO UPDATE SET
          request_count = request_count + 1,
          successful_requests = successful_requests + excluded.successful_requests,
          last_seen_at = excluded.last_seen_at
      `).run(
        dateKey(new Date(occurredAt)),
        event.method,
        event.path,
        event.platform || 'unknown',
        event.appVersion || '',
        statusGroup,
        successful,
        occurredAt
      );
      if (event.identity?.deviceKey) {
        const identity = event.identity;
        this.database.prepare(`
          INSERT INTO usage_devices (
            device_key, license_id, account_id, installation_suffix,
            authorization_type, platform, architecture, app_version,
            first_seen_at, last_seen_at, last_path, request_count,
            successful_requests, last_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(device_key) DO UPDATE SET
            license_id = COALESCE(excluded.license_id, usage_devices.license_id),
            account_id = COALESCE(excluded.account_id, usage_devices.account_id),
            installation_suffix = excluded.installation_suffix,
            authorization_type = excluded.authorization_type,
            platform = excluded.platform,
            architecture = excluded.architecture,
            app_version = excluded.app_version,
            last_seen_at = excluded.last_seen_at,
            last_path = excluded.last_path,
            request_count = request_count + 1,
            successful_requests = successful_requests + excluded.successful_requests,
            last_status = excluded.last_status
        `).run(
          identity.deviceKey,
          identity.licenseId || null,
          identity.accountId || null,
          identity.installationSuffix || '',
          identity.authorizationType || 'license',
          event.platform || identity.platform || 'unknown',
          event.architecture || identity.architecture || 'unknown',
          event.appVersion || identity.appVersion || '',
          occurredAt,
          occurredAt,
          event.path,
          successful,
          event.status
        );
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  recordReleaseDownload({ release, occurredAt = nowIso() }) {
    this.database.prepare(`
      INSERT INTO usage_release_downloads (
        date, platform, architecture, version, download_count, last_download_at
      ) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(date, platform, architecture, version)
      DO UPDATE SET
        download_count = download_count + 1,
        last_download_at = excluded.last_download_at
    `).run(
      dateKey(new Date(occurredAt)),
      release.platform,
      release.architecture,
      release.version,
      occurredAt
    );
  }

  recordFeature({
    feature,
    category = '',
    identity = null,
    platform = 'unknown',
    appVersion = '',
    detail = '',
    occurredAt = nowIso()
  }) {
    this.database.prepare(`
      INSERT INTO usage_feature_events (
        feature, category, account_id, device_key, installation_suffix,
        platform, app_version, detail, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feature,
      category,
      identity?.accountId || null,
      identity?.deviceKey || null,
      identity?.installationSuffix || '',
      platform,
      appVersion,
      detail,
      occurredAt
    );
  }

  usageDetails() {
    const devices = this.database.prepare(`
      SELECT device_key AS deviceKey, license_id AS licenseId, account_id AS accountId,
        installation_suffix AS installationSuffix,
        authorization_type AS authorizationType, platform, architecture,
        app_version AS appVersion, first_seen_at AS firstSeenAt,
        last_seen_at AS lastSeenAt, last_path AS lastPath,
        request_count AS requestCount, successful_requests AS successfulRequests,
        last_status AS lastStatus
      FROM usage_devices
      ORDER BY last_seen_at DESC
    `).all();
    const downloads = this.database.prepare(`
      SELECT platform, architecture, version,
        SUM(download_count) AS download_count,
        MAX(last_download_at) AS last_download_at
      FROM usage_release_downloads
      GROUP BY platform, architecture, version
      ORDER BY last_download_at DESC
    `).all().map((row) => ({
      platform: row.platform,
      architecture: row.architecture,
      version: row.version,
      downloadCount: Number(row.download_count),
      lastDownloadAt: row.last_download_at
    }));
    const apiRoutes = this.database.prepare(`
      SELECT method, path, platform, app_version,
        SUM(request_count) AS request_count,
        SUM(successful_requests) AS successful_requests,
        MAX(last_seen_at) AS last_seen_at
      FROM usage_api_daily
      GROUP BY method, path, platform, app_version
      ORDER BY request_count DESC, last_seen_at DESC
      LIMIT 200
    `).all().map((row) => ({
      method: row.method,
      path: row.path,
      platform: row.platform,
      appVersion: row.app_version,
      requestCount: Number(row.request_count),
      successfulRequests: Number(row.successful_requests),
      lastSeenAt: row.last_seen_at
    }));
    const featureTotals = this.database.prepare(`
      SELECT feature, category, COUNT(*) AS count, MAX(occurred_at) AS last_occurred_at
      FROM usage_feature_events
      GROUP BY feature, category
      ORDER BY count DESC, last_occurred_at DESC
    `).all().map((row) => ({
      feature: row.feature,
      category: row.category,
      count: Number(row.count),
      lastOccurredAt: row.last_occurred_at
    }));
    const featureEvents = this.database.prepare(`
      SELECT feature, category, account_id AS accountId, device_key AS deviceKey,
        installation_suffix AS installationSuffix, platform,
        app_version AS appVersion, detail, occurred_at AS occurredAt
      FROM usage_feature_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT 200
    `).all();
    return { devices, downloads, apiRoutes, featureTotals, featureEvents };
  }

  summary({ from, to }) {
    const metrics = this.database.prepare(`
      SELECT
        SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) AS page_views,
        COUNT(DISTINCT CASE WHEN event_type = 'page_view' THEN visitor_id END) AS unique_visitors,
        SUM(CASE WHEN event_type = 'download_click' THEN 1 ELSE 0 END) AS download_clicks,
        COUNT(DISTINCT CASE WHEN event_type = 'download_click' THEN visitor_id END) AS download_visitors,
        SUM(CASE WHEN event_type = 'resource_download_click' THEN 1 ELSE 0 END) AS resource_download_clicks,
        COUNT(DISTINCT CASE WHEN event_type = 'resource_download_click' THEN visitor_id END) AS resource_download_visitors,
        COUNT(DISTINCT CASE WHEN event_type = 'app_first_launch' THEN installation_hash END) AS first_launches,
        COUNT(DISTINCT CASE WHEN event_type = 'activation_success' THEN installation_hash END) AS activated_installations,
        COUNT(DISTINCT CASE WHEN event_type IN ('app_daily_active', 'app_session_start') THEN installation_hash END) AS active_devices,
        COUNT(DISTINCT CASE WHEN event_type = 'app_daily_active' THEN installation_hash END) AS daily_active_devices
      FROM analytics_events
      WHERE event_date BETWEEN ? AND ?
    `).get(from, to);

    const platformRows = this.database.prepare(`
      SELECT platform,
        SUM(CASE WHEN event_type = 'download_click' THEN 1 ELSE 0 END) AS download_clicks,
        COUNT(DISTINCT CASE WHEN event_type = 'activation_success' THEN installation_hash END) AS activations,
        COUNT(DISTINCT CASE WHEN event_type = 'app_daily_active' THEN installation_hash END) AS active_devices
      FROM analytics_events
      WHERE event_date BETWEEN ? AND ? AND platform IS NOT NULL AND platform <> ''
      GROUP BY platform
      ORDER BY platform
    `).all(from, to);

    const activeByWeek = this.database.prepare(`
      SELECT strftime('%Y-W%W', event_date) AS week,
        COUNT(DISTINCT installation_hash) AS active_devices
      FROM analytics_events
      WHERE event_type = 'app_daily_active' AND event_date BETWEEN ? AND ?
      GROUP BY strftime('%Y-W%W', event_date)
      ORDER BY week
    `).all(from, to);

    const activationRows = this.database.prepare(`
      SELECT installation_hash, MIN(event_date) AS cohort_date
      FROM analytics_events
      WHERE event_type = 'activation_success'
        AND installation_hash IS NOT NULL
      GROUP BY installation_hash
    `).all();
    const activityRows = this.database.prepare(`
      SELECT DISTINCT installation_hash, event_date
      FROM analytics_events
      WHERE event_type IN ('app_daily_active', 'app_session_start')
        AND installation_hash IS NOT NULL
    `).all();
    const activity = new Set(activityRows.map((row) => `${row.installation_hash}|${row.event_date}`));
    const cohorts = new Map();
    for (const row of activationRows) {
      if (row.cohort_date < from || row.cohort_date > to) continue;
      const current = cohorts.get(row.cohort_date) || {
        date: row.cohort_date,
        size: 0,
        d1: null,
        d7: null,
        d30: null
      };
      current.size += 1;
      for (const days of [1, 7, 30]) {
        const target = addDays(row.cohort_date, days);
        if (target > to) continue;
        const key = days === 1 ? 'd1' : days === 7 ? 'd7' : 'd30';
        if (current[key] === null) current[key] = 0;
        if (activity.has(`${row.installation_hash}|${target}`)) current[key] += 1;
      }
      cohorts.set(row.cohort_date, current);
    }

    const cohortRows = [...cohorts.values()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((row) => ({
        ...row,
        d1Rate: ratio(row.d1, row.size),
        d7Rate: ratio(row.d7, row.size),
        d30Rate: ratio(row.d30, row.size)
      }));
    const completed = cohortRows.filter((row) => row.d1 !== null);
    const retention = {
      cohorts: cohortRows,
      d1Rate: weightedRate(completed, 'd1'),
      d7Rate: weightedRate(completed.filter((row) => row.d7 !== null), 'd7'),
      d30Rate: weightedRate(completed.filter((row) => row.d30 !== null), 'd30')
    };

    const pageViews = Number(metrics.page_views || 0);
    const uniqueVisitors = Number(metrics.unique_visitors || 0);
    const downloadClicks = Number(metrics.download_clicks || 0);
    const downloadVisitors = Number(metrics.download_visitors || 0);
    const resourceDownloadClicks = Number(metrics.resource_download_clicks || 0);
    const resourceDownloadVisitors = Number(metrics.resource_download_visitors || 0);
    const firstLaunches = Number(metrics.first_launches || 0);
    const activations = Number(metrics.activated_installations || 0);
    return {
      range: { from, to, timeZone: 'Asia/Shanghai' },
      funnel: {
        pageViews,
        uniqueVisitors,
        downloadClicks,
        downloadVisitors,
        firstLaunches,
        activatedInstallations: activations,
        clickRate: ratio(downloadVisitors, uniqueVisitors),
        installRate: ratio(firstLaunches, downloadVisitors),
        downloadToActivationRate: ratio(activations, firstLaunches),
        downloadVisitorActivationRate: ratio(activations, downloadVisitors),
        activationRate: ratio(activations, firstLaunches)
      },
      resourceDownloads: {
        downloadClicks: resourceDownloadClicks,
        downloadVisitors: resourceDownloadVisitors
      },
      activity: {
        activeDevices: Number(metrics.active_devices || 0),
        dailyActiveDevices: Number(metrics.daily_active_devices || 0),
        weeklyActiveDevices: this.weeklyActiveDevices(to),
        byWeek: activeByWeek.map((row) => ({
          week: row.week,
          activeDevices: Number(row.active_devices || 0)
        }))
      },
      platforms: platformRows.map((row) => ({
        platform: row.platform,
        downloadClicks: Number(row.download_clicks || 0),
        activations: Number(row.activations || 0),
        activeDevices: Number(row.active_devices || 0)
      })),
      retention
    };
  }

  weeklyActiveDevices(to) {
    const end = parseDate(to);
    const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
    return Number(this.database.prepare(`
      SELECT COUNT(DISTINCT installation_hash) AS count
      FROM analytics_events
      WHERE event_type = 'app_daily_active'
        AND event_date BETWEEN ? AND ?
    `).get(dateKey(start), to).count || 0);
  }

  pruneRawEvents(retentionDays = RAW_EVENT_RETENTION_DAYS) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.database.prepare('DELETE FROM analytics_events WHERE received_at < ?').run(cutoff);
    return { deleted: Number(result.changes), cutoff };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.migrationState = null;
  }
}

function parseDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error('日期格式无效');
  return date;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function ratio(value, total) {
  return total > 0 ? Number((value / total).toFixed(4)) : null;
}

function weightedRate(rows, field) {
  const size = rows.reduce((total, row) => total + row.size, 0);
  const retained = rows.reduce((total, row) => total + (row[field] || 0), 0);
  return ratio(retained, size);
}

module.exports = {
  ANALYTICS_EVENT_TYPES,
  AnalyticsStore,
  RAW_EVENT_RETENTION_DAYS
};
