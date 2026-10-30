const crypto = require('node:crypto');
const path = require('node:path');
const { openMigratedDatabase } = require('./sqlite-migrations');

const INSTALL_STATES = Object.freeze(['installed', 'uninstall_reported', 'restored']);
const INSTALL_EVENT_TYPES = Object.freeze(['installed_start', 'uninstall_intent', 'uninstall_completed']);
const UNINSTALL_REASONS = Object.freeze([
  'not_often_used',
  'resource_usage',
  'experience_issue',
  'temporary_pause',
  'other'
]);
const UNINSTALL_MIGRATION_SCOPE = 'uninstall';

const UNINSTALL_MIGRATIONS = [
  {
    version: 1,
    name: 'uninstall-events-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS device_installation_state (
          installation_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          license_id TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL,
          app_version TEXT NOT NULL DEFAULT '',
          current_batch_id TEXT NOT NULL,
          current_batch_created_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('installed', 'uninstall_reported', 'restored')),
          last_event_at TEXT NOT NULL,
          last_received_at TEXT NOT NULL,
          last_uninstall_at TEXT,
          last_restored_at TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS install_events (
          id TEXT PRIMARY KEY,
          installation_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          license_id TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          install_batch_id TEXT NOT NULL,
          install_batch_created_at TEXT NOT NULL,
          event_type TEXT NOT NULL
            CHECK (event_type IN ('installed_start', 'uninstall_intent', 'uninstall_completed')),
          platform TEXT NOT NULL,
          app_version TEXT NOT NULL DEFAULT '',
          reason TEXT,
          comment TEXT NOT NULL DEFAULT '',
          occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          state_changed INTEGER NOT NULL DEFAULT 0 CHECK (state_changed IN (0, 1)),
          ignored_reason TEXT,
          intent_event_id TEXT,
          completion_token_hash BLOB,
          completion_token_expires_at TEXT,
          completion_consumed_at TEXT,
          FOREIGN KEY (intent_event_id) REFERENCES install_events(id)
        );

        CREATE INDEX IF NOT EXISTS idx_install_events_device_received
          ON install_events(installation_id, received_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_install_events_type_received
          ON install_events(event_type, received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_device_installation_state_status
          ON device_installation_state(status, updated_at DESC);
      `);
    }
  }
];

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    installationId: row.installation_id,
    accountId: row.account_id,
    licenseId: row.license_id,
    displayName: row.display_name,
    installBatchId: row.install_batch_id,
    installBatchCreatedAt: row.install_batch_created_at,
    eventType: row.event_type,
    platform: row.platform,
    appVersion: row.app_version,
    reason: row.reason,
    comment: row.comment,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    stateChanged: Number(row.state_changed) === 1,
    ignoredAsStale: Boolean(row.ignored_reason),
    ignoredReason: row.ignored_reason,
    intentEventId: row.intent_event_id
  };
}

function mapDevice(row) {
  if (!row) return null;
  return {
    installationId: row.installation_id,
    deviceCode: String(row.installation_id).slice(-12),
    accountId: row.account_id,
    licenseId: row.license_id,
    displayName: row.display_name,
    platform: row.platform,
    appVersion: row.app_version,
    currentInstallBatchId: row.current_batch_id,
    currentInstallBatchCreatedAt: row.current_batch_created_at,
    status: row.status,
    lastEventAt: row.last_event_at,
    lastReceivedAt: row.last_received_at,
    lastUninstallAt: row.last_uninstall_at,
    lastRestoredAt: row.last_restored_at,
    updatedAt: row.updated_at,
    latestReason: row.latest_reason ?? null,
    latestComment: row.latest_comment ?? '',
    latestFeedbackAt: row.latest_feedback_at ?? null
  };
}

function compareBatch(existing, input) {
  if (existing.current_batch_id === input.installBatchId) return 'same';
  const incoming = Date.parse(input.installBatchCreatedAt);
  const current = Date.parse(existing.current_batch_created_at);
  return Number.isFinite(incoming) && Number.isFinite(current) && incoming > current ? 'newer' : 'stale';
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class UninstallStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'uninstall.db');
    this.database = null;
    this.migrationState = null;
  }

  async initialize() {
    const opened = await openMigratedDatabase({
      dataDirectory: this.dataDirectory,
      fileName: 'uninstall.db',
      scope: UNINSTALL_MIGRATION_SCOPE,
      migrations: UNINSTALL_MIGRATIONS,
      foreignKeys: true
    });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.migrationState = opened.migrationState;
  }

  event(id) {
    return this.database.prepare('SELECT * FROM install_events WHERE id = ?').get(id);
  }

  state(installationId) {
    return this.database.prepare('SELECT * FROM device_installation_state WHERE installation_id = ?')
      .get(installationId);
  }

  recordIdentityEvent(input, completionTokenHash = null, completionTokenExpiresAt = null) {
    const receivedAt = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.event(input.id);
      if (duplicate) {
        const sameIdentityEvent = duplicate.installation_id === input.installationId
          && duplicate.event_type === input.eventType
          && duplicate.install_batch_id === input.installBatchId;
        if (!sameIdentityEvent) {
          throw codedError('事件标识已经绑定到其他安装事件', 'INSTALL_EVENT_ID_CONFLICT');
        }
        const state = this.state(duplicate.installation_id);
        this.database.exec('COMMIT');
        return { duplicate: true, event: mapEvent(duplicate), device: mapDevice(state) };
      }

      const existing = this.state(input.installationId);
      let stateChanged = false;
      let ignoredReason = null;
      let nextStatus = existing?.status || 'installed';
      let replaceBatch = !existing;

      if (existing) {
        const batchOrder = compareBatch(existing, input);
        if (input.eventType === 'installed_start') {
          if (batchOrder === 'newer') {
            replaceBatch = true;
            nextStatus = existing.status === 'uninstall_reported' ? 'restored' : 'installed';
            stateChanged = true;
          } else if (batchOrder === 'same') {
            if (existing.status === 'uninstall_reported') ignoredReason = 'same_batch_after_uninstall';
          } else {
            ignoredReason = 'stale_batch';
          }
        } else if (input.eventType === 'uninstall_intent' && batchOrder !== 'same') {
          ignoredReason = batchOrder === 'newer' ? 'batch_not_started' : 'stale_batch';
        }
      } else {
        stateChanged = true;
      }

      this.database.prepare(`
        INSERT INTO install_events (
          id, installation_id, account_id, license_id, display_name,
          install_batch_id, install_batch_created_at, event_type, platform, app_version,
          reason, comment, occurred_at, received_at, state_changed, ignored_reason,
          completion_token_hash, completion_token_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.installationId, input.accountId, input.licenseId, input.displayName,
        input.installBatchId, input.installBatchCreatedAt, input.eventType, input.platform,
        input.appVersion, input.reason, input.comment, input.occurredAt, receivedAt,
        stateChanged ? 1 : 0, ignoredReason, completionTokenHash, completionTokenExpiresAt
      );

      if (!existing) {
        this.database.prepare(`
          INSERT INTO device_installation_state (
            installation_id, account_id, license_id, display_name, platform, app_version,
            current_batch_id, current_batch_created_at, status, last_event_at,
            last_received_at, last_restored_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.installationId, input.accountId, input.licenseId, input.displayName,
          input.platform, input.appVersion, input.installBatchId, input.installBatchCreatedAt,
          nextStatus, input.occurredAt, receivedAt, nextStatus === 'restored' ? input.occurredAt : null,
          receivedAt
        );
      } else if (!ignoredReason && (replaceBatch || input.installBatchId === existing.current_batch_id)) {
        this.database.prepare(`
          UPDATE device_installation_state SET
            account_id = ?, license_id = ?, display_name = ?, platform = ?, app_version = ?,
            current_batch_id = ?, current_batch_created_at = ?, status = ?,
            last_event_at = ?, last_received_at = ?,
            last_restored_at = CASE WHEN ? = 'restored' THEN ? ELSE last_restored_at END,
            updated_at = ?
          WHERE installation_id = ?
        `).run(
          input.accountId, input.licenseId, input.displayName, input.platform, input.appVersion,
          replaceBatch ? input.installBatchId : existing.current_batch_id,
          replaceBatch ? input.installBatchCreatedAt : existing.current_batch_created_at,
          nextStatus, input.occurredAt, receivedAt, nextStatus, input.occurredAt, receivedAt,
          input.installationId
        );
      }

      this.database.exec('COMMIT');
      return {
        duplicate: false,
        event: mapEvent(this.event(input.id)),
        device: mapDevice(this.state(input.installationId))
      };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  completeWithToken({ id, intentEventId, completionToken, occurredAt }) {
    const receivedAt = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const intent = this.event(intentEventId);
      if (!intent || intent.event_type !== 'uninstall_intent' || !intent.completion_token_hash) {
        throw codedError('卸载意向或完成凭据无效', 'UNINSTALL_COMPLETION_INVALID');
      }
      const expected = Buffer.from(intent.completion_token_hash);
      const actual = crypto.createHash('sha256').update(completionToken, 'ascii').digest();
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw codedError('卸载完成凭据无效', 'UNINSTALL_COMPLETION_INVALID');
      }

      const duplicate = this.event(id);
      if (duplicate) {
        const sameCompletion = duplicate.event_type === 'uninstall_completed'
          && duplicate.intent_event_id === intent.id
          && duplicate.installation_id === intent.installation_id;
        if (!sameCompletion) {
          throw codedError('完成事件标识已经绑定到其他安装事件', 'UNINSTALL_COMPLETION_EVENT_CONFLICT');
        }
        const state = this.state(duplicate.installation_id);
        this.database.exec('COMMIT');
        return { duplicate: true, event: mapEvent(duplicate), device: mapDevice(state) };
      }

      if (intent.completion_consumed_at) {
        throw codedError('卸载完成凭据已经使用', 'UNINSTALL_COMPLETION_USED');
      }
      if (Date.parse(intent.completion_token_expires_at) <= Date.now()) {
        throw codedError('卸载完成凭据已经过期', 'UNINSTALL_COMPLETION_EXPIRED');
      }

      const existing = this.state(intent.installation_id);
      const currentBatch = !intent.ignored_reason
        && existing
        && existing.current_batch_id === intent.install_batch_id;
      const ignoredReason = currentBatch ? null : (intent.ignored_reason || 'stale_batch');
      const stateChanged = Boolean(currentBatch && existing.status !== 'uninstall_reported');

      this.database.prepare(`
        INSERT INTO install_events (
          id, installation_id, account_id, license_id, display_name,
          install_batch_id, install_batch_created_at, event_type, platform, app_version,
          reason, comment, occurred_at, received_at, state_changed, ignored_reason, intent_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uninstall_completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, intent.installation_id, intent.account_id, intent.license_id, intent.display_name,
        intent.install_batch_id, intent.install_batch_created_at, intent.platform, intent.app_version,
        intent.reason, intent.comment, occurredAt, receivedAt, stateChanged ? 1 : 0,
        ignoredReason, intent.id
      );
      this.database.prepare('UPDATE install_events SET completion_consumed_at = ? WHERE id = ?')
        .run(receivedAt, intent.id);

      if (currentBatch) {
        this.database.prepare(`
          UPDATE device_installation_state SET
            account_id = ?, license_id = ?, display_name = ?, platform = ?, app_version = ?,
            status = 'uninstall_reported', last_event_at = ?, last_received_at = ?,
            last_uninstall_at = ?, updated_at = ?
          WHERE installation_id = ?
        `).run(
          intent.account_id, intent.license_id, intent.display_name, intent.platform,
          intent.app_version, occurredAt, receivedAt, occurredAt, receivedAt,
          intent.installation_id
        );
      }

      this.database.exec('COMMIT');
      return {
        duplicate: false,
        event: mapEvent(this.event(id)),
        device: mapDevice(this.state(intent.installation_id))
      };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  list({ status = '', q = '', page = 1, pageSize = 25 } = {}) {
    const clauses = [];
    const parameters = [];
    if (status) {
      clauses.push('s.status = ?');
      parameters.push(status);
    }
    if (q) {
      const term = `%${q.toLowerCase()}%`;
      clauses.push(`(
        LOWER(s.installation_id) LIKE ? OR LOWER(s.account_id) LIKE ? OR
        LOWER(s.display_name) LIKE ? OR LOWER(s.platform) LIKE ? OR
        LOWER(s.app_version) LIKE ? OR EXISTS (
          SELECT 1 FROM install_events search_event
          WHERE search_event.installation_id = s.installation_id
            AND (LOWER(COALESCE(search_event.reason, '')) LIKE ?
              OR LOWER(search_event.comment) LIKE ?)
        )
      )`);
      parameters.push(term, term, term, term, term, term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM device_installation_state s ${where}
    `).get(...parameters)?.count || 0);
    const offset = (page - 1) * pageSize;
    const rows = this.database.prepare(`
      SELECT s.*,
        latest.reason AS latest_reason,
        latest.comment AS latest_comment,
        latest.occurred_at AS latest_feedback_at
      FROM device_installation_state s
      LEFT JOIN install_events latest ON latest.id = (
        SELECT e.id FROM install_events e
        WHERE e.installation_id = s.installation_id
          AND e.event_type IN ('uninstall_intent', 'uninstall_completed')
        ORDER BY e.received_at DESC, e.id DESC LIMIT 1
      )
      ${where}
      ORDER BY s.updated_at DESC, s.installation_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, offset);
    const counts = this.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'installed' THEN 1 ELSE 0 END) AS installed,
        SUM(CASE WHEN status = 'uninstall_reported' THEN 1 ELSE 0 END) AS uninstall_reported,
        SUM(CASE WHEN status = 'restored' THEN 1 ELSE 0 END) AS restored
      FROM device_installation_state
    `).get();
    const eventCounts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN event_type = 'uninstall_intent' THEN 1 ELSE 0 END) AS intents,
        SUM(CASE WHEN event_type = 'uninstall_completed' THEN 1 ELSE 0 END) AS completed
      FROM install_events
    `).get();
    return {
      devices: rows.map(mapDevice),
      total,
      page,
      pageSize,
      summary: {
        total: Number(counts.total || 0),
        installed: Number(counts.installed || 0),
        uninstallReported: Number(counts.uninstall_reported || 0),
        restored: Number(counts.restored || 0),
        intents: Number(eventCounts.intents || 0),
        completedEvents: Number(eventCounts.completed || 0)
      },
      serverTime: new Date().toISOString()
    };
  }

  details(installationId) {
    const device = mapDevice(this.state(installationId));
    if (!device) return null;
    const events = this.database.prepare(`
      SELECT * FROM install_events WHERE installation_id = ?
      ORDER BY received_at DESC, id DESC LIMIT 200
    `).all(installationId).map(mapEvent);
    return { device, events };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.migrationState = null;
  }
}

module.exports = {
  INSTALL_EVENT_TYPES,
  INSTALL_STATES,
  UNINSTALL_REASONS,
  UninstallStore
};
