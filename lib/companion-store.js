const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('./sqlite-migrations');

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const COMPANION_MIGRATION_SCOPE = 'companion';

const COMPANION_MIGRATIONS = [{
  version: 1,
  name: 'companion-baseline',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS companion_profiles (
        account_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        pairing_code TEXT NOT NULL UNIQUE,
        paired_account_id TEXT UNIQUE,
        paired_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (paired_account_id IS NULL OR paired_account_id <> account_id)
      );
      CREATE TABLE IF NOT EXISTS companion_deliveries (
        id TEXT PRIMARY KEY,
        sender_account_id TEXT NOT NULL,
        recipient_account_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_companion_deliveries_recipient
        ON companion_deliveries(recipient_account_id, acknowledged_at, expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_companion_deliveries_sender
        ON companion_deliveries(sender_account_id, created_at DESC);
    `);
  }
}, {
  version: 2,
  name: 'companion-daily-stats',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS companion_daily_stats (
        date TEXT PRIMARY KEY,
        sent INTEGER NOT NULL DEFAULT 0,
        received INTEGER NOT NULL DEFAULT 0,
        expired INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO companion_daily_stats (date, sent, received)
      SELECT
        date(created_at, '+8 hours'),
        COUNT(*),
        SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END)
      FROM companion_deliveries
      GROUP BY date(created_at, '+8 hours')
      ON CONFLICT(date) DO NOTHING;
    `);
  }
}];

function nowIso() {
  return new Date().toISOString();
}

function shanghaiDate(value = Date.now()) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function generatePairingCode() {
  let code = '';
  for (const value of crypto.randomBytes(8)) code += PAIRING_ALPHABET[value % PAIRING_ALPHABET.length];
  return code;
}

function cleanName(value) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  return [...clean].slice(0, 12).join('');
}

function mapProfile(row, partner) {
  return {
    displayName: row.display_name,
    pairingCode: row.pairing_code,
    partner: partner ? {
      displayName: partner.display_name,
      pairedAt: row.paired_at
    } : null
  };
}

function mapDelivery(row, senderName) {
  return {
    id: row.id,
    senderName,
    size: Number(row.size),
    width: Number(row.width),
    height: Number(row.height),
    sha256: row.sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    downloadPath: `/api/companion/deliveries/${row.id}/file`
  };
}

class CompanionStore {
  constructor(dataDirectory, { deliveryTtlMs = 24 * 60 * 60 * 1000, cooldownMs = 30_000, maxPending = 3 } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'companion.db');
    this.filesDirectory = path.join(this.dataDirectory, 'companion-deliveries');
    this.deliveryTtlMs = deliveryTtlMs;
    this.cooldownMs = cooldownMs;
    this.maxPending = maxPending;
    this.database = null;
    this.migrationState = null;
  }

  async initialize() {
    await fs.promises.mkdir(this.filesDirectory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrationState = applyMigrations(
      this.database,
      COMPANION_MIGRATION_SCOPE,
      COMPANION_MIGRATIONS
    );
  }

  createUniqueCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generatePairingCode();
      if (!this.database.prepare('SELECT 1 FROM companion_profiles WHERE pairing_code = ?').get(code)) return code;
    }
    throw new Error('无法生成唯一搭子码');
  }

  ensureProfile(accountId) {
    let row = this.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?').get(accountId);
    if (row) return row;
    const createdAt = nowIso();
    this.database.prepare(`
      INSERT INTO companion_profiles
        (account_id, display_name, pairing_code, created_at, updated_at)
      VALUES (?, '桌搭子', ?, ?, ?)
    `).run(accountId, this.createUniqueCode(), createdAt, createdAt);
    row = this.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?').get(accountId);
    return row;
  }

  profile(accountId) {
    const row = this.ensureProfile(accountId);
    const partner = row.paired_account_id
      ? this.database.prepare('SELECT display_name FROM companion_profiles WHERE account_id = ?')
        .get(row.paired_account_id)
      : null;
    return mapProfile(row, partner);
  }

  updateProfile(accountId, displayName) {
    const clean = cleanName(displayName);
    if (!clean) throw new Error('昵称不能为空');
    this.ensureProfile(accountId);
    this.database.prepare(`
      UPDATE companion_profiles SET display_name = ?, updated_at = ? WHERE account_id = ?
    `).run(clean, nowIso(), accountId);
    return this.profile(accountId);
  }

  pair(accountId, inputCode) {
    const code = String(inputCode || '').trim().toUpperCase();
    const pairedAt = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const own = this.ensureProfile(accountId);
      const partner = this.database.prepare(
        'SELECT * FROM companion_profiles WHERE pairing_code = ?'
      ).get(code);
      if (!partner || partner.account_id === accountId) throw new Error('搭子码无效');
      if (own.paired_account_id || partner.paired_account_id) throw new Error('其中一方已经绑定搭子');
      this.database.prepare(`
        UPDATE companion_profiles
        SET paired_account_id = ?, paired_at = ?, updated_at = ?
        WHERE account_id = ? AND paired_account_id IS NULL
      `).run(partner.account_id, pairedAt, pairedAt, accountId);
      this.database.prepare(`
        UPDATE companion_profiles
        SET paired_account_id = ?, paired_at = ?, updated_at = ?
        WHERE account_id = ? AND paired_account_id IS NULL
      `).run(accountId, pairedAt, pairedAt, partner.account_id);
      this.database.exec('COMMIT');
      return this.profile(accountId);
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  unpair(accountId) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const own = this.ensureProfile(accountId);
      const partnerId = own.paired_account_id;
      const updatedAt = nowIso();
      this.database.prepare(`
        UPDATE companion_profiles
        SET paired_account_id = NULL, paired_at = NULL, pairing_code = ?, updated_at = ?
        WHERE account_id = ?
      `).run(this.createUniqueCode(), updatedAt, accountId);
      if (partnerId) {
        this.database.prepare(`
          UPDATE companion_profiles
          SET paired_account_id = NULL, paired_at = NULL, pairing_code = ?, updated_at = ?
          WHERE account_id = ? AND paired_account_id = ?
        `).run(this.createUniqueCode(), updatedAt, partnerId, accountId);
      }
      if (partnerId) {
        this.database.prepare(`
          UPDATE companion_deliveries SET expires_at = ?
          WHERE acknowledged_at IS NULL
            AND (sender_account_id IN (?, ?) OR recipient_account_id IN (?, ?))
        `).run(updatedAt, accountId, partnerId, accountId, partnerId);
      }
      this.database.exec('COMMIT');
      return this.profile(accountId);
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  createDelivery(senderAccountId, { id, fileName, size, sha256, width, height }) {
    const sender = this.ensureProfile(senderAccountId);
    if (!sender.paired_account_id) throw new Error('请先绑定搭子');
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.deliveryTtlMs).toISOString();
    const recent = this.database.prepare(`
      SELECT created_at FROM companion_deliveries
      WHERE sender_account_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(senderAccountId);
    if (recent && Date.parse(recent.created_at) > now - this.cooldownMs) throw new Error('发送太快，请稍后再试');
    const pending = this.database.prepare(`
      SELECT COUNT(*) AS count FROM companion_deliveries
      WHERE recipient_account_id = ? AND acknowledged_at IS NULL AND expires_at > ?
    `).get(sender.paired_account_id, createdAt);
    if (Number(pending.count) >= this.maxPending) throw new Error('对方还有未查看的来访');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO companion_deliveries
          (id, sender_account_id, recipient_account_id, file_name, size, sha256,
           width, height, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        senderAccountId,
        sender.paired_account_id,
        fileName,
        size,
        sha256,
        width,
        height,
        createdAt,
        expiresAt
      );
      this.database.prepare(`
        INSERT INTO companion_daily_stats (date, sent)
        VALUES (?, 1)
        ON CONFLICT(date) DO UPDATE SET sent = sent + 1
      `).run(shanghaiDate(createdAt));
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    return {
      id,
      recipientName: this.profile(sender.paired_account_id).displayName,
      createdAt,
      expiresAt
    };
  }

  pending(accountId) {
    this.ensureProfile(accountId);
    const now = nowIso();
    return this.database.prepare(`
      SELECT d.*, p.display_name AS sender_name
      FROM companion_deliveries d
      JOIN companion_profiles p ON p.account_id = d.sender_account_id
      WHERE d.recipient_account_id = ? AND d.acknowledged_at IS NULL AND d.expires_at > ?
      ORDER BY d.created_at ASC LIMIT ?
    `).all(accountId, now, this.maxPending).map((row) => mapDelivery(row, row.sender_name));
  }

  delivery(accountId, id) {
    return this.database.prepare(`
      SELECT * FROM companion_deliveries
      WHERE id = ? AND recipient_account_id = ? AND acknowledged_at IS NULL AND expires_at > ?
    `).get(id, accountId, nowIso()) || null;
  }

  acknowledge(accountId, id) {
    const acknowledgedAt = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const delivery = this.database.prepare(`
        SELECT created_at FROM companion_deliveries
        WHERE id = ? AND recipient_account_id = ? AND acknowledged_at IS NULL
      `).get(id, accountId);
      if (!delivery) {
        this.database.exec('COMMIT');
        return null;
      }
      const result = this.database.prepare(`
        UPDATE companion_deliveries SET acknowledged_at = ?
        WHERE id = ? AND recipient_account_id = ? AND acknowledged_at IS NULL
      `).run(acknowledgedAt, id, accountId);
      if (result.changes === 1) {
        this.database.prepare(`
          INSERT INTO companion_daily_stats (date, received)
          VALUES (?, 1)
          ON CONFLICT(date) DO UPDATE SET received = received + 1
        `).run(shanghaiDate(delivery.created_at));
      }
      this.database.exec('COMMIT');
      return result.changes === 1 ? { id, acknowledgedAt } : null;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  expiredFiles() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.database.prepare(`
      SELECT id FROM companion_deliveries
      WHERE expires_at <= ? OR (acknowledged_at IS NOT NULL AND acknowledged_at <= ?)
    `).all(nowIso(), cutoff).map((row) => `${row.id}.gif`);
  }

  removeExpired() {
    const currentTime = nowIso();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const statsCutoff = shanghaiDate(Date.now() - 90 * 24 * 60 * 60 * 1000);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const expired = this.database.prepare(`
        SELECT date(created_at, '+8 hours') AS date, COUNT(*) AS count
        FROM companion_deliveries
        WHERE acknowledged_at IS NULL AND expires_at <= ?
        GROUP BY date(created_at, '+8 hours')
      `).all(currentTime);
      for (const item of expired) {
        this.database.prepare(`
          INSERT INTO companion_daily_stats (date, expired)
          VALUES (?, ?)
          ON CONFLICT(date) DO UPDATE SET expired = expired + excluded.expired
        `).run(item.date, Number(item.count));
      }
      this.database.prepare(`
        DELETE FROM companion_deliveries
        WHERE expires_at <= ? OR (acknowledged_at IS NOT NULL AND acknowledged_at <= ?)
      `).run(currentTime, cutoff);
      this.database.prepare('DELETE FROM companion_daily_stats WHERE date < ?').run(statsCutoff);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  adminStats() {
    const now = nowIso();
    const statsCutoff = shanghaiDate(Date.now() - 89 * 24 * 60 * 60 * 1000);
    const dailyCutoff = shanghaiDate(Date.now() - 13 * 24 * 60 * 60 * 1000);
    const profiles = this.database.prepare(`
      SELECT
        COUNT(*) AS profile_count,
        SUM(CASE WHEN paired_account_id IS NOT NULL THEN 1 ELSE 0 END) AS paired_accounts
      FROM companion_profiles
    `).get();
    const pending = this.database.prepare(`
      SELECT COUNT(*) AS count FROM companion_deliveries
      WHERE acknowledged_at IS NULL AND expires_at > ?
    `).get(now);
    const totals = this.database.prepare(`
      SELECT
        COALESCE(SUM(sent), 0) AS sent,
        COALESCE(SUM(received), 0) AS received,
        COALESCE(SUM(expired), 0) AS expired
      FROM companion_daily_stats
      WHERE date >= ?
    `).get(statsCutoff);
    const daily = this.database.prepare(`
      SELECT date, sent, received, expired
      FROM companion_daily_stats
      WHERE date >= ?
      ORDER BY date DESC
    `).all(dailyCutoff).map((row) => ({
      date: row.date,
      sent: Number(row.sent),
      received: Number(row.received),
      expired: Number(row.expired)
    }));
    const sent = Number(totals.sent);
    const received = Number(totals.received);
    return {
      generatedAt: now,
      windowDays: 90,
      summary: {
        profiles: Number(profiles.profile_count),
        activePairs: Math.floor(Number(profiles.paired_accounts || 0) / 2),
        sent,
        received,
        pending: Number(pending.count),
        expired: Number(totals.expired),
        receiptRate: sent > 0 ? received / sent : null
      },
      daily
    };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

module.exports = { CompanionStore, cleanName };
