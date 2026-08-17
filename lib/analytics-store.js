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
