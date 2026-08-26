const crypto = require('node:crypto');
const path = require('node:path');
const { openMigratedDatabase } = require('./sqlite-migrations');

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const COMPANION_MIGRATION_SCOPE = 'companion';
const HALL_PRESENCE_TTL_MS = 90 * 1000;

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
}, {
  // Keep the retired migration marker so databases that already saw it can still start.
  version: 3,
  name: 'companion-secrets-and-stickers',
  up() { }
}, {
  version: 4,
  name: 'delivery-device-receipts',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS companion_delivery_receipts (
        delivery_id TEXT NOT NULL,
        license_id TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL,
        PRIMARY KEY (delivery_id, license_id),
        FOREIGN KEY (delivery_id) REFERENCES companion_deliveries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_companion_delivery_receipts_license
        ON companion_delivery_receipts(license_id, acknowledged_at);
    `);
  }
}, {
  version: 5,
  name: 'companion-hall-presence-and-messages',
  up(database) {
    const profileColumns = new Set(
      database.prepare('PRAGMA table_info(companion_profiles)').all().map((row) => row.name)
    );
    if (!profileColumns.has('hall_enabled')) {
      database.exec('ALTER TABLE companion_profiles ADD COLUMN hall_enabled INTEGER NOT NULL DEFAULT 0');
    }
    if (!profileColumns.has('last_seen_at')) {
      database.exec('ALTER TABLE companion_profiles ADD COLUMN last_seen_at TEXT');
    }
    const deliveryColumns = new Set(
      database.prepare('PRAGMA table_info(companion_deliveries)').all().map((row) => row.name)
    );
    if (!deliveryColumns.has('message')) {
      database.exec("ALTER TABLE companion_deliveries ADD COLUMN message TEXT NOT NULL DEFAULT ''");
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_companion_profiles_hall_presence
        ON companion_profiles(hall_enabled, last_seen_at);
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

function cleanMessage(value) {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return [...clean].slice(0, 120).join('');
}

function isOnline(row, now = Date.now()) {
  return Number(row.hall_enabled) === 1
    && Boolean(row.last_seen_at)
    && Number.isFinite(Date.parse(row.last_seen_at))
    && Date.parse(row.last_seen_at) > now - HALL_PRESENCE_TTL_MS;
}

function mapProfile(row, partner) {
  return {
    displayName: row.display_name,
    pairingCode: row.pairing_code,
    hallEnabled: Number(row.hall_enabled) === 1,
    online: isOnline(row),
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
    message: row.message || '',
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
    const opened = await openMigratedDatabase({
      dataDirectory: this.dataDirectory,
      fileName: 'companion.db',
      scope: COMPANION_MIGRATION_SCOPE,
      migrations: COMPANION_MIGRATIONS,
      foreignKeys: true,
      extraDirectories: [this.filesDirectory]
    });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.migrationState = opened.migrationState;
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
    const row = this.touchPresence(accountId);
    const partner = row.paired_account_id
      ? this.database.prepare('SELECT display_name FROM companion_profiles WHERE account_id = ?')
        .get(row.paired_account_id)
      : null;
    return mapProfile(row, partner);
  }

  touchPresence(accountId) {
    let row = this.ensureProfile(accountId);
    if (Number(row.hall_enabled) !== 1) return row;
    const now = Date.now();
    if (row.last_seen_at && Date.parse(row.last_seen_at) > now - 15_000) return row;
    const seenAt = new Date(now).toISOString();
    this.database.prepare(`
      UPDATE companion_profiles SET last_seen_at = ?, updated_at = ? WHERE account_id = ?
    `).run(seenAt, seenAt, accountId);
    row = this.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?').get(accountId);
    return row;
  }

  setHallEnabled(accountId, enabled) {
    const isEnabled = Boolean(enabled);
    const now = nowIso();
    this.ensureProfile(accountId);
    this.database.prepare(`
      UPDATE companion_profiles
      SET hall_enabled = ?, last_seen_at = ?, updated_at = ?
      WHERE account_id = ?
    `).run(isEnabled ? 1 : 0, isEnabled ? now : null, now, accountId);
    return this.profile(accountId);
  }

  hall(accountId, limit = 30) {
    const own = this.touchPresence(accountId);
    const cutoff = new Date(Date.now() - HALL_PRESENCE_TTL_MS).toISOString();
    const people = this.database.prepare(`
      SELECT account_id, display_name, last_seen_at
      FROM companion_profiles
      WHERE account_id <> ? AND hall_enabled = 1 AND last_seen_at > ?
      ORDER BY last_seen_at DESC LIMIT ?
    `).all(accountId, cutoff, Math.max(1, Math.min(100, Number(limit) || 30))).map((row) => ({
      id: row.account_id,
      displayName: row.display_name,
      online: true,
      lastSeenAt: row.last_seen_at
    }));
    return { enabled: Number(own.hall_enabled) === 1, people };
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

  createDelivery(senderAccountId, metadata) {
    const sender = this.ensureProfile(senderAccountId);
    if (!sender.paired_account_id) throw new Error('请先绑定搭子');
    return this.createDeliveryFor(senderAccountId, sender.paired_account_id, metadata);
  }

  createHallDelivery(senderAccountId, recipientAccountId, metadata) {
    const sender = this.touchPresence(senderAccountId);
    if (Number(sender.hall_enabled) !== 1) throw new Error('HALL_SENDER_DISABLED');
    const recipient = this.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?').get(recipientAccountId);
    if (!recipient || recipient.account_id === senderAccountId || !isOnline(recipient)) {
      throw new Error('HALL_RECIPIENT_OFFLINE');
    }
    return this.createDeliveryFor(senderAccountId, recipientAccountId, metadata);
  }

  createDeliveryFor(senderAccountId, recipientAccountId, {
    id, fileName, size, sha256, width, height, message = ''
  }) {
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
    `).get(recipientAccountId, createdAt);
    if (Number(pending.count) >= this.maxPending) throw new Error('对方还有未查看的来访');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO companion_deliveries
          (id, sender_account_id, recipient_account_id, file_name, size, sha256,
           width, height, message, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        senderAccountId,
        recipientAccountId,
        fileName,
        size,
        sha256,
        width,
        height,
        cleanMessage(message),
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
      recipientName: this.profile(recipientAccountId).displayName,
      createdAt,
      expiresAt
    };
  }

  pending(accountId, licenseId) {
    this.touchPresence(accountId);
    const now = nowIso();
    return this.database.prepare(`
      SELECT d.*, p.display_name AS sender_name
      FROM companion_deliveries d
      JOIN companion_profiles p ON p.account_id = d.sender_account_id
      WHERE d.recipient_account_id = ?
        AND d.expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM companion_delivery_receipts r
          WHERE r.delivery_id = d.id AND r.license_id = ?
        )
        AND (
          d.acknowledged_at IS NULL
          OR EXISTS (
            SELECT 1 FROM companion_delivery_receipts r
            WHERE r.delivery_id = d.id
          )
        )
      ORDER BY d.created_at ASC LIMIT ?
    `).all(accountId, now, licenseId, this.maxPending).map((row) => mapDelivery(row, row.sender_name));
  }

  delivery(accountId, licenseId, id) {
    return this.database.prepare(`
      SELECT d.* FROM companion_deliveries d
      WHERE d.id = ? AND d.recipient_account_id = ? AND d.expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM companion_delivery_receipts r
          WHERE r.delivery_id = d.id AND r.license_id = ?
        )
        AND (
          d.acknowledged_at IS NULL
          OR EXISTS (
            SELECT 1 FROM companion_delivery_receipts r
            WHERE r.delivery_id = d.id
          )
        )
    `).get(id, accountId, nowIso(), licenseId) || null;
  }

  acknowledge(accountId, licenseId, id) {
    const acknowledgedAt = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const delivery = this.database.prepare(`
        SELECT created_at, acknowledged_at FROM companion_deliveries
        WHERE id = ? AND recipient_account_id = ? AND expires_at > ?
      `).get(id, accountId, acknowledgedAt);
      if (!delivery) {
        this.database.exec('COMMIT');
        return null;
      }
      const existingReceipt = this.database.prepare(`
        SELECT acknowledged_at FROM companion_delivery_receipts
        WHERE delivery_id = ? AND license_id = ?
      `).get(id, licenseId);
      if (existingReceipt) {
        this.database.exec('COMMIT');
        return { id, acknowledgedAt: existingReceipt.acknowledged_at };
      }
      if (delivery.acknowledged_at && !this.database.prepare(`
        SELECT 1 FROM companion_delivery_receipts WHERE delivery_id = ?
      `).get(id)) {
        this.database.exec('COMMIT');
        return null;
      }
      this.database.prepare(`
        INSERT INTO companion_delivery_receipts (delivery_id, license_id, acknowledged_at)
        VALUES (?, ?, ?)
      `).run(id, licenseId, acknowledgedAt);
      if (!delivery.acknowledged_at) {
        this.database.prepare(`
          UPDATE companion_deliveries SET acknowledged_at = ?
          WHERE id = ? AND acknowledged_at IS NULL
        `).run(acknowledgedAt, id);
        this.database.prepare(`
          INSERT INTO companion_daily_stats (date, received)
          VALUES (?, 1)
          ON CONFLICT(date) DO UPDATE SET received = received + 1
        `).run(shanghaiDate(delivery.created_at));
      }
      this.database.exec('COMMIT');
      return { id, acknowledgedAt };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  expiredFiles() {
    return this.database.prepare(`
      SELECT id FROM companion_deliveries WHERE expires_at <= ?
    `).all(nowIso()).map((row) => `${row.id}.gif`);
  }

  removeExpired() {
    const currentTime = nowIso();
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
        DELETE FROM companion_deliveries WHERE expires_at <= ?
      `).run(currentTime);
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
