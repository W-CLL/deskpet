const crypto = require('node:crypto');
const path = require('node:path');
const { openMigratedDatabase } = require('./sqlite-migrations');

const FEEDBACK_TYPES = Object.freeze(['problem', 'suggestion']);
const FEEDBACK_STATUSES = Object.freeze(['pending', 'in_progress', 'resolved', 'closed']);
const ACTIVE_FEEDBACK_STATUSES = Object.freeze(['pending', 'in_progress']);
const MAX_ACTIVE_FEEDBACK = 3;
const FEEDBACK_MIGRATION_SCOPE = 'feedback';

const FEEDBACK_MIGRATIONS = [
  {
    version: 1,
    name: 'feedback-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          id TEXT PRIMARY KEY,
          license_id TEXT NOT NULL,
          installation_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('problem', 'suggestion')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'in_progress', 'resolved', 'closed')),
          admin_note TEXT NOT NULL DEFAULT '',
          app_version TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_installation_status
          ON feedback(installation_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_feedback_status_created
          ON feedback(status, created_at DESC);
      `);
    }
  }
];

function nowIso() {
  return new Date().toISOString();
}

function mapFeedback(row, includeDevice = false) {
  const item = {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    status: row.status,
    adminNote: row.admin_note,
    appVersion: row.app_version,
    platform: row.platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at
  };
  if (includeDevice) {
    item.licenseId = row.license_id;
    item.installationSuffix = String(row.installation_id).slice(-8);
  }
  return item;
}

class FeedbackStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'feedback.db');
    this.database = null;
    this.migrationState = null;
  }

  async initialize() {
    const opened = await openMigratedDatabase({
      dataDirectory: this.dataDirectory,
      fileName: 'feedback.db',
      scope: FEEDBACK_MIGRATION_SCOPE,
      migrations: FEEDBACK_MIGRATIONS
    });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.migrationState = opened.migrationState;
  }

  quota(installationId) {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS active_count FROM feedback
      WHERE installation_id = ? AND status IN ('pending', 'in_progress')
    `).get(installationId);
    const active = Number(row?.active_count || 0);
    return {
      active,
      maximum: MAX_ACTIVE_FEEDBACK,
      remaining: Math.max(0, MAX_ACTIVE_FEEDBACK - active)
    };
  }

  listForInstallation(installationId) {
    const items = this.database.prepare(`
      SELECT * FROM feedback WHERE installation_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 50
    `).all(installationId).map((row) => mapFeedback(row));
    return { quota: this.quota(installationId), items };
  }

  create({ licenseId, installationId, type, title, content, appVersion, platform }) {
    const createdAt = nowIso();
    const id = crypto.randomUUID();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const quota = this.quota(installationId);
      if (quota.remaining === 0) {
        const error = new Error('每台设备最多同时提交 3 条待处理或进行中的反馈');
        error.code = 'FEEDBACK_LIMIT_REACHED';
        throw error;
      }
      this.database.prepare(`
        INSERT INTO feedback
          (id, license_id, installation_id, type, title, content, app_version, platform, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        licenseId,
        installationId,
        type,
        title,
        content,
        appVersion,
        platform,
        createdAt,
        createdAt
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    const item = this.database.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    return { item: mapFeedback(item), quota: this.quota(installationId) };
  }

  listAll() {
    const rows = this.database.prepare(`
      SELECT * FROM feedback ORDER BY created_at DESC, id DESC LIMIT 1000
    `).all();
    const counts = this.database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
      FROM feedback
    `).get();
    const summary = {
      total: Number(counts.total || 0),
      pending: Number(counts.pending || 0),
      inProgress: Number(counts.in_progress || 0),
      resolved: Number(counts.resolved || 0),
      closed: Number(counts.closed || 0)
    };
    return { summary, items: rows.map((row) => mapFeedback(row, true)) };
  }

  updateStatus(id, status, adminNote) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const record = this.database.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
      if (!record) {
        this.database.exec('ROLLBACK');
        return null;
      }
      if (ACTIVE_FEEDBACK_STATUSES.includes(status)
        && !ACTIVE_FEEDBACK_STATUSES.includes(record.status)) {
        const quota = this.quota(record.installation_id);
        if (quota.remaining === 0) {
          const error = new Error('该设备已经有 3 条待处理或进行中的反馈');
          error.code = 'FEEDBACK_LIMIT_REACHED';
          throw error;
        }
      }
      const updatedAt = nowIso();
      const resolvedAt = ACTIVE_FEEDBACK_STATUSES.includes(status) ? null : updatedAt;
      const note = adminNote === undefined ? record.admin_note : adminNote;
      this.database.prepare(`
        UPDATE feedback
        SET status = ?, admin_note = ?, updated_at = ?, resolved_at = ?
        WHERE id = ?
      `).run(status, note, updatedAt, resolvedAt, id);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    return mapFeedback(
      this.database.prepare('SELECT * FROM feedback WHERE id = ?').get(id),
      true
    );
  }

  close() {
    this.database?.close();
    this.database = null;
    this.migrationState = null;
  }
}

module.exports = {
  ACTIVE_FEEDBACK_STATUSES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  FeedbackStore,
  MAX_ACTIVE_FEEDBACK
};
