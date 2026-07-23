const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{20,80}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{40,80}$/;
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_IV_LENGTH = 12;
const ENCRYPTION_TAG_LENGTH = 16;

function nowIso() {
  return new Date().toISOString();
}

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

function generateCode() {
  while (true) {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (/[A-Z]/.test(code) && /[2-9]/.test(code)) return code;
  }
}

function safeText(value, maxLength) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

async function loadOrCreateKey(filePath) {
  try {
    return await fs.promises.readFile(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = crypto.randomBytes(32);
    try {
      await fs.promises.writeFile(filePath, generated, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      return fs.promises.readFile(filePath);
    }
  }
}

class ActivationStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'activation.db');
    this.pepperPath = path.join(this.dataDirectory, 'activation-pepper.key');
    this.encryptionKeyPath = path.join(this.dataDirectory, 'activation-encryption.key');
    this.database = null;
    this.pepper = null;
    this.encryptionKey = null;
  }

  async initialize() {
    await fs.promises.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    [this.pepper, this.encryptionKey] = await Promise.all([
      loadOrCreateKey(this.pepperPath),
      loadOrCreateKey(this.encryptionKeyPath)
    ]);
    if (this.pepper.length !== 32) throw new Error('激活密钥文件格式无效');
    if (this.encryptionKey.length !== 32) throw new Error('激活码加密密钥文件格式无效');

    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS activation_codes (
        id TEXT PRIMARY KEY,
        code_hash BLOB NOT NULL UNIQUE,
        code_suffix TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used')),
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        license_id TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        activation_code_id TEXT NOT NULL UNIQUE,
        installation_id TEXT NOT NULL UNIQUE,
        credential_hash BLOB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        app_version TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_update_at TEXT,
        FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_activation_codes_status ON activation_codes(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
    `);
    const activationColumns = this.database.prepare('PRAGMA table_info(activation_codes)').all();
    if (!activationColumns.some((column) => column.name === 'code_ciphertext')) {
      this.database.exec('ALTER TABLE activation_codes ADD COLUMN code_ciphertext BLOB');
    }
  }

  hashCode(code) {
    return crypto.createHmac('sha256', this.pepper).update(code, 'ascii').digest();
  }

  hashCredential(credential) {
    return crypto.createHash('sha256').update(credential, 'ascii').digest();
  }

  encryptCode(code) {
    const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(code, 'ascii'), cipher.final()]);
    return Buffer.concat([
      Buffer.from([ENCRYPTION_VERSION]),
      iv,
      cipher.getAuthTag(),
      ciphertext
    ]);
  }

  decryptCode(value) {
    const encrypted = Buffer.from(value);
    const headerLength = 1 + ENCRYPTION_IV_LENGTH + ENCRYPTION_TAG_LENGTH;
    if (encrypted.length <= headerLength || encrypted[0] !== ENCRYPTION_VERSION) {
      throw new Error('激活码密文格式无效');
    }
    const iv = encrypted.subarray(1, 1 + ENCRYPTION_IV_LENGTH);
    const tag = encrypted.subarray(1 + ENCRYPTION_IV_LENGTH, headerLength);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    const code = Buffer.concat([decipher.update(encrypted.subarray(headerLength)), decipher.final()]).toString('ascii');
    if (!CODE_PATTERN.test(code)) throw new Error('激活码密文内容无效');
    return code;
  }

  createCodes({ count = 1, expiresInDays = 30, note = '' } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('每次只能生成 1 至 100 个激活码');
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      throw new Error('有效期必须为 1 至 365 天');
    }
    const cleanNote = safeText(note, 120);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    const insert = this.database.prepare(`
      INSERT INTO activation_codes (id, code_hash, code_suffix, code_ciphertext, note, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const codes = [];
    this.database.exec('BEGIN IMMEDIATE');
    try {
      while (codes.length < count) {
        const code = generateCode();
        try {
          insert.run(
            crypto.randomUUID(),
            this.hashCode(code),
            code.slice(-2),
            this.encryptCode(code),
            cleanNote,
            createdAt,
            expiresAt
          );
          codes.push(code);
        } catch (error) {
          if (!String(error.message).includes('UNIQUE constraint failed')) throw error;
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return { codes, createdAt, expiresAt, note: cleanNote };
  }

  activate({ code: inputCode, installationId, credential, appVersion = '' }) {
    const code = normalizeCode(inputCode);
    if (!code || !INSTALLATION_ID_PATTERN.test(String(installationId || ''))
      || !CREDENTIAL_PATTERN.test(String(credential || ''))) return null;

    const codeHash = this.hashCode(code);
    const credentialHash = this.hashCredential(credential);
    const activatedAt = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const codeRecord = this.database.prepare('SELECT * FROM activation_codes WHERE code_hash = ?').get(codeHash);
      if (!codeRecord) {
        this.database.exec('ROLLBACK');
        return null;
      }

      if (codeRecord.status === 'used') {
        const existing = this.database.prepare('SELECT * FROM licenses WHERE activation_code_id = ?').get(codeRecord.id);
        const sameCredential = existing
          && existing.installation_id === installationId
          && crypto.timingSafeEqual(Buffer.from(existing.credential_hash), credentialHash);
        if (!sameCredential || existing.status !== 'active') {
          this.database.exec('ROLLBACK');
          return null;
        }
        this.database.prepare('UPDATE licenses SET app_version = ? WHERE id = ?')
          .run(safeText(appVersion, 40), existing.id);
        this.database.exec('COMMIT');
        return { licenseId: existing.id, activatedAt: existing.created_at, alreadyActivated: true };
      }

      if (Date.parse(codeRecord.expires_at) <= Date.now()) {
        this.database.exec('ROLLBACK');
        return null;
      }

      const existingInstallation = this.database.prepare('SELECT id FROM licenses WHERE installation_id = ?').get(installationId);
      if (existingInstallation) {
        this.database.exec('ROLLBACK');
        return null;
      }

      const licenseId = crypto.randomUUID();
      const claimed = this.database.prepare(`
        UPDATE activation_codes SET status = 'used', used_at = ?, license_id = ?
        WHERE id = ? AND status = 'unused'
      `).run(activatedAt, licenseId, codeRecord.id);
      if (claimed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`
        INSERT INTO licenses
          (id, activation_code_id, installation_id, credential_hash, app_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(licenseId, codeRecord.id, installationId, credentialHash, safeText(appVersion, 40), activatedAt);
      this.database.exec('COMMIT');
      return { licenseId, activatedAt, alreadyActivated: false };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  authenticate(authorization, { appVersion = '', markUpdate = false } = {}) {
    const match = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,80})$/i.exec(String(authorization || '').trim());
    if (!match) return null;
    const record = this.database.prepare('SELECT * FROM licenses WHERE id = ?').get(match[1]);
    if (!record || record.status !== 'active') return null;
    const expected = Buffer.from(record.credential_hash);
    const actual = this.hashCredential(match[2]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    if (markUpdate) {
      this.database.prepare('UPDATE licenses SET app_version = ?, last_update_at = ? WHERE id = ?')
        .run(safeText(appVersion, 40), nowIso(), record.id);
    }
    return {
      id: record.id,
      installationId: record.installation_id,
      createdAt: record.created_at,
      appVersion: record.app_version
    };
  }

  list() {
    const currentTime = nowIso();
    const rows = this.database.prepare(`
      SELECT c.id, c.code_suffix, c.code_ciphertext IS NOT NULL AS can_reveal,
        c.status, c.note, c.created_at, c.expires_at, c.used_at,
        l.id AS license_id, l.installation_id, l.status AS license_status,
        l.app_version, l.created_at AS license_created_at, l.revoked_at, l.last_update_at
      FROM activation_codes c
      LEFT JOIN licenses l ON l.activation_code_id = c.id
      ORDER BY c.created_at DESC, c.id DESC
    `).all();
    const codes = rows.map((row) => ({
      id: row.id,
      maskedCode: `****${row.code_suffix}`,
      canReveal: row.can_reveal === 1,
      status: row.status === 'unused' && row.expires_at <= currentTime ? 'expired' : row.status,
      note: row.note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      license: row.license_id ? {
        id: row.license_id,
        installationSuffix: String(row.installation_id).slice(-8),
        status: row.license_status,
        appVersion: row.app_version,
        createdAt: row.license_created_at,
        revokedAt: row.revoked_at,
        lastUpdateAt: row.last_update_at
      } : null
    }));
    const summary = { total: codes.length, unused: 0, used: 0, expired: 0, active: 0, revoked: 0 };
    for (const item of codes) {
      if (item.status === 'unused') summary.unused += 1;
      if (item.status === 'expired') summary.expired += 1;
      if (item.status === 'used') summary.used += 1;
      if (item.license?.status === 'active') summary.active += 1;
      if (item.license?.status === 'revoked') summary.revoked += 1;
    }
    return { summary, codes };
  }

  reveal(codeId) {
    const record = this.database.prepare(`
      SELECT id, code_ciphertext FROM activation_codes WHERE id = ?
    `).get(String(codeId || ''));
    if (!record?.code_ciphertext) return null;
    return { id: record.id, code: this.decryptCode(record.code_ciphertext) };
  }

  revoke(licenseId) {
    const revokedAt = nowIso();
    const result = this.database.prepare(`
      UPDATE licenses SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND status = 'active'
    `).run(revokedAt, licenseId);
    if (result.changes !== 1) return null;
    return { id: licenseId, revokedAt };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.pepper = null;
    this.encryptionKey = null;
  }
}

module.exports = {
  ActivationStore,
  CODE_PATTERN,
  CREDENTIAL_PATTERN,
  INSTALLATION_ID_PATTERN,
  generateCode,
  normalizeCode
};
