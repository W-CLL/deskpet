const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openMigratedDatabase } = require('./sqlite-migrations');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{20,80}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{40,80}$/;
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_IV_LENGTH = 12;
const ENCRYPTION_TAG_LENGTH = 16;
const ACTIVATION_MIGRATION_SCOPE = 'activation';
const MAX_ACTIVE_LICENSES_PER_ACCOUNT = 2;
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const TRIAL_CLIENT_WINDOW_SECONDS = 24 * 60 * 60;

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

function normalizeClientPlatform(value) {
  const platform = safeText(value, 20).toLowerCase();
  return ['windows', 'macos', 'android'].includes(platform) ? platform : 'unknown';
}

function normalizeClientArchitecture(value) {
  return safeText(value, 32).toLowerCase() || 'unknown';
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

function columnNames(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumn(database, table, columns, name, definition) {
  if (columns.has(name)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

const ACTIVATION_MIGRATIONS = [
  {
    version: 1,
    name: 'activation-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS activation_codes (
          id TEXT PRIMARY KEY,
          code_hash BLOB NOT NULL UNIQUE,
          code_suffix TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used')),
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          license_id TEXT UNIQUE,
          code_ciphertext BLOB
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
        CREATE INDEX IF NOT EXISTS idx_activation_codes_status
          ON activation_codes(status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
      `);
      const activationColumns = columnNames(database, 'activation_codes');
      addColumn(database, 'activation_codes', activationColumns, 'code_ciphertext', 'BLOB');
    }
  },
  {
    version: 2,
    name: 'account-foundation',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
          created_at TEXT NOT NULL,
          suspended_at TEXT,
          last_active_at TEXT
        )
      `);

      const licenseColumns = columnNames(database, 'licenses');
      addColumn(database, 'licenses', licenseColumns, 'account_id', 'TEXT REFERENCES accounts(id)');
      addColumn(database, 'licenses', licenseColumns, 'revocation_reason', "TEXT NOT NULL DEFAULT ''");

      const activationColumns = columnNames(database, 'activation_codes');
      addColumn(
        database,
        'activation_codes',
        activationColumns,
        'purpose',
        "TEXT NOT NULL DEFAULT 'new_account' CHECK (purpose IN ('new_account', 'rebind'))"
      );
      addColumn(
        database,
        'activation_codes',
        activationColumns,
        'target_account_id',
        'TEXT REFERENCES accounts(id)'
      );

      // A migrated license becomes the stable account boundary without changing its credential.
      database.exec(`
        INSERT OR IGNORE INTO accounts (id, status, created_at, last_active_at)
        SELECT id, 'active', created_at, COALESCE(last_update_at, created_at)
        FROM licenses;
        UPDATE licenses SET account_id = id WHERE account_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
        CREATE INDEX IF NOT EXISTS idx_licenses_account_status
          ON licenses(account_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activation_codes_target_account
          ON activation_codes(target_account_id, status, expires_at);
      `);

      const missingAccounts = database.prepare(`
        SELECT COUNT(*) AS count FROM licenses WHERE account_id IS NULL
      `).get();
      if (Number(missingAccounts.count) !== 0) {
        throw new Error('旧设备授权未能完整迁移到账号');
      }
    }
  },
  {
    version: 3,
    name: 'online-trial',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS trials (
          installation_id TEXT PRIMARY KEY,
          credential_hash BLOB NOT NULL,
          started_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          app_version TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_trials_expires_at ON trials(expires_at);
      `);
    }
  },
  {
    version: 4,
    name: 'device-platform-metadata',
    up(database) {
      const licenseColumns = columnNames(database, 'licenses');
      addColumn(database, 'licenses', licenseColumns, 'platform', "TEXT NOT NULL DEFAULT 'unknown'");
      addColumn(database, 'licenses', licenseColumns, 'architecture', "TEXT NOT NULL DEFAULT 'unknown'");
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_licenses_platform_status
          ON licenses(platform, status, created_at DESC);
      `);
    }
  },
  {
    version: 5,
    name: 'shared-purchase-code-devices',
    up(database) {
      database.exec(`
        CREATE TABLE licenses_v5 (
          id TEXT PRIMARY KEY,
          activation_code_id TEXT NOT NULL,
          installation_id TEXT NOT NULL UNIQUE,
          credential_hash BLOB NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
          app_version TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          last_update_at TEXT,
          account_id TEXT REFERENCES accounts(id),
          revocation_reason TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT 'unknown',
          architecture TEXT NOT NULL DEFAULT 'unknown',
          FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id)
        );
        INSERT INTO licenses_v5 (
          id, activation_code_id, installation_id, credential_hash, status, app_version,
          created_at, revoked_at, last_update_at, account_id, revocation_reason,
          platform, architecture
        )
        SELECT
          id, activation_code_id, installation_id, credential_hash, status, app_version,
          created_at, revoked_at, last_update_at, account_id, revocation_reason,
          platform, architecture
        FROM licenses;
        DROP TABLE licenses;
        ALTER TABLE licenses_v5 RENAME TO licenses;
        CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
        CREATE INDEX IF NOT EXISTS idx_licenses_account_status
          ON licenses(account_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_licenses_platform_status
          ON licenses(platform, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_licenses_activation_code
          ON licenses(activation_code_id, created_at DESC);
      `);
    }
  },
  {
    version: 6,
    name: 'seven-day-trial-and-platform',
    up(database) {
      const trialColumns = columnNames(database, 'trials');
      addColumn(database, 'trials', trialColumns, 'platform', "TEXT NOT NULL DEFAULT 'unknown'");
      addColumn(database, 'trials', trialColumns, 'architecture', "TEXT NOT NULL DEFAULT 'unknown'");
      const update = database.prepare('UPDATE trials SET expires_at = ? WHERE installation_id = ?');
      for (const trial of database.prepare('SELECT installation_id, started_at, expires_at FROM trials').all()) {
        const sevenDayExpiry = new Date(Date.parse(trial.started_at) + TRIAL_DURATION_MS).toISOString();
        if (Date.parse(trial.expires_at) < Date.parse(sevenDayExpiry)) {
          update.run(sevenDayExpiry, trial.installation_id);
        }
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_trials_last_seen_at ON trials(last_seen_at)');
    }
  }
];

class ActivationStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'activation.db');
    this.pepperPath = path.join(this.dataDirectory, 'activation-pepper.key');
    this.encryptionKeyPath = path.join(this.dataDirectory, 'activation-encryption.key');
    this.database = null;
    this.pepper = null;
    this.encryptionKey = null;
    this.migrationState = null;
  }

  async initialize() {
    [this.pepper, this.encryptionKey] = await Promise.all([
      loadOrCreateKey(this.pepperPath),
      loadOrCreateKey(this.encryptionKeyPath)
    ]);
    if (this.pepper.length !== 32) throw new Error('激活密钥文件格式无效');
    if (this.encryptionKey.length !== 32) throw new Error('激活码加密密钥文件格式无效');

    const opened = await openMigratedDatabase({
      dataDirectory: this.dataDirectory,
      fileName: 'activation.db',
      scope: ACTIVATION_MIGRATION_SCOPE,
      migrations: ACTIVATION_MIGRATIONS,
      foreignKeys: true
    });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.migrationState = opened.migrationState;
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
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    return this.createCodeRecords({ count, expiresAt, note });
  }

  createRebindCode(accountId, { expiresInHours = 24, note = '' } = {}) {
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
      throw new Error('换机码有效期必须为 1 至 168 小时');
    }
    const account = this.database.prepare(`
      SELECT id, status, created_at FROM accounts WHERE id = ?
    `).get(String(accountId || ''));
    if (!account || account.status !== 'active') return null;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    return this.createCodeRecords({
      count: 1,
      expiresAt,
      note: note || `账号 …${account.id.slice(-8)} 换机`,
      purpose: 'rebind',
      targetAccountId: account.id
    });
  }

  createCodeRecords({
    count,
    expiresAt,
    note,
    purpose = 'new_account',
    targetAccountId = null
  }) {
    const cleanNote = safeText(note, 120);
    const createdAt = nowIso();
    const insert = this.database.prepare(`
      INSERT INTO activation_codes
        (id, code_hash, code_suffix, code_ciphertext, note, created_at, expires_at,
         purpose, target_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const codes = [];
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (purpose === 'rebind') {
        this.database.prepare(`
          UPDATE activation_codes SET expires_at = ?
          WHERE purpose = 'rebind' AND target_account_id = ? AND status = 'unused'
        `).run(createdAt, targetAccountId);
      }
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
            expiresAt,
            purpose,
            targetAccountId
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
    return { codes, createdAt, expiresAt, note: cleanNote, purpose, targetAccountId };
  }

  activate({
    code: inputCode,
    installationId,
    credential,
    appVersion = '',
    platform = 'unknown',
    architecture = 'unknown'
  }) {
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
        return this.activateUsedCode({
          codeRecord,
          installationId,
          credentialHash,
          appVersion,
          platform,
          architecture,
          activatedAt
        });
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
      let accountId;
      if (codeRecord.purpose === 'rebind') {
        const account = this.database.prepare(`
          SELECT id, status FROM accounts WHERE id = ?
        `).get(codeRecord.target_account_id);
        if (!account || account.status !== 'active') {
          this.database.exec('ROLLBACK');
          return null;
        }
        accountId = account.id;
      } else if (codeRecord.purpose === 'new_account') {
        accountId = crypto.randomUUID();
      } else {
        this.database.exec('ROLLBACK');
        return null;
      }

      const claimed = this.database.prepare(`
        UPDATE activation_codes SET status = 'used', used_at = ?, license_id = ?
        WHERE id = ? AND status = 'unused'
      `).run(activatedAt, licenseId, codeRecord.id);
      if (claimed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return null;
      }
      if (codeRecord.purpose === 'new_account') {
        this.database.prepare(`
          INSERT INTO accounts (id, status, created_at, last_active_at)
          VALUES (?, 'active', ?, ?)
        `).run(accountId, activatedAt, activatedAt);
      } else {
        this.database.prepare(`
          UPDATE licenses
          SET status = 'revoked', revoked_at = ?, revocation_reason = 'rebind'
          WHERE account_id = ? AND status = 'active'
        `).run(activatedAt, accountId);
        this.database.prepare(`
          UPDATE accounts SET last_active_at = ? WHERE id = ?
        `).run(activatedAt, accountId);
      }
      this.database.prepare(`
        INSERT INTO licenses
          (id, account_id, activation_code_id, installation_id, credential_hash, app_version,
           platform, architecture, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        licenseId,
        accountId,
        codeRecord.id,
        installationId,
        credentialHash,
        safeText(appVersion, 40),
        normalizeClientPlatform(platform),
        normalizeClientArchitecture(architecture),
        activatedAt
      );
      this.clearTrial(installationId);
      this.database.exec('COMMIT');
      return { accountId, licenseId, activatedAt, alreadyActivated: false, deviceCount: 1 };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  activateUsedCode({
    codeRecord,
    installationId,
    credentialHash,
    appVersion,
    platform,
    architecture,
    activatedAt
  }) {
    if (codeRecord.purpose !== 'new_account') {
      const existing = this.database.prepare(`
        SELECT * FROM licenses
        WHERE activation_code_id = ? AND installation_id = ? AND status = 'active'
      `).get(codeRecord.id, installationId);
      const sameCredential = existing
        && crypto.timingSafeEqual(Buffer.from(existing.credential_hash), credentialHash);
      if (!sameCredential) {
        this.database.exec('ROLLBACK');
        return null;
      }
      const account = this.database.prepare(`
        SELECT id, status FROM accounts WHERE id = ?
      `).get(existing.account_id);
      if (!account || account.status !== 'active') {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`
        UPDATE licenses SET app_version = ?, platform = ?, architecture = ? WHERE id = ?
      `).run(
        safeText(appVersion, 40),
        normalizeClientPlatform(platform),
        normalizeClientArchitecture(architecture),
        existing.id
      );
      this.clearTrial(installationId);
      this.database.exec('COMMIT');
      return {
        accountId: account.id,
        licenseId: existing.id,
        activatedAt: existing.created_at,
        alreadyActivated: true,
        deviceCount: this.activeLicenseCount(account.id)
      };
    }

    const ownerLicense = this.database.prepare(`
      SELECT * FROM licenses
      WHERE activation_code_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(codeRecord.id);
    if (!ownerLicense?.account_id) {
      this.database.exec('ROLLBACK');
      return null;
    }
    const account = this.database.prepare(`
      SELECT id, status FROM accounts WHERE id = ?
    `).get(ownerLicense.account_id);
    if (!account || account.status !== 'active') {
      this.database.exec('ROLLBACK');
      return null;
    }

    const sameDevice = this.database.prepare(`
      SELECT * FROM licenses
      WHERE account_id = ? AND installation_id = ? AND status = 'active'
    `).get(account.id, installationId);
    if (sameDevice) {
      const sameCredential = crypto.timingSafeEqual(
        Buffer.from(sameDevice.credential_hash),
        credentialHash
      );
      if (!sameCredential) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`
        UPDATE licenses SET app_version = ?, platform = ?, architecture = ? WHERE id = ?
      `).run(
        safeText(appVersion, 40),
        normalizeClientPlatform(platform),
        normalizeClientArchitecture(architecture),
        sameDevice.id
      );
      this.clearTrial(installationId);
      this.database.exec('COMMIT');
      return {
        accountId: account.id,
        licenseId: sameDevice.id,
        activatedAt: sameDevice.created_at,
        alreadyActivated: true,
        deviceCount: this.activeLicenseCount(account.id)
      };
    }

    const existingInstallation = this.database.prepare(`
      SELECT id FROM licenses WHERE installation_id = ?
    `).get(installationId);
    if (existingInstallation) {
      this.database.exec('ROLLBACK');
      return null;
    }

    const activeCount = this.activeLicenseCount(account.id);
    if (activeCount >= MAX_ACTIVE_LICENSES_PER_ACCOUNT) {
      this.database.exec('ROLLBACK');
      const error = new Error('这组激活码已经连了两台设备，卸下一台或用换机码替换后再试');
      error.code = 'ACCOUNT_DEVICE_LIMIT';
      throw error;
    }

    const licenseId = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO licenses
        (id, account_id, activation_code_id, installation_id, credential_hash, app_version,
         platform, architecture, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      licenseId,
      account.id,
      codeRecord.id,
      installationId,
      credentialHash,
      safeText(appVersion, 40),
      normalizeClientPlatform(platform),
      normalizeClientArchitecture(architecture),
      activatedAt
    );
    this.database.prepare(`
      UPDATE accounts SET last_active_at = ? WHERE id = ?
    `).run(activatedAt, account.id);
    this.clearTrial(installationId);
    this.database.exec('COMMIT');
    return {
      accountId: account.id,
      licenseId,
      activatedAt,
      alreadyActivated: false,
      deviceCount: activeCount + 1
    };
  }

  activeLicenseCount(accountId) {
    return Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM licenses WHERE account_id = ? AND status = 'active'
    `).get(accountId)?.count || 0);
  }

  clearTrial(installationId) {
    this.database.prepare('DELETE FROM trials WHERE installation_id = ?').run(String(installationId || ''));
  }

  hasLicense(installationId) {
    return Boolean(this.database.prepare(
      'SELECT id FROM licenses WHERE installation_id = ?'
    ).get(String(installationId || '')));
  }

  trialStatus({
    installationId,
    credential,
    appVersion = '',
    platform = 'unknown',
    architecture = 'unknown'
  } = {}) {
    if (!INSTALLATION_ID_PATTERN.test(String(installationId || ''))
      || !CREDENTIAL_PATTERN.test(String(credential || ''))) return null;

    const normalizedInstallationId = String(installationId);
    const credentialHash = this.hashCredential(String(credential));
    const now = Date.now();
    const nowAt = new Date(now).toISOString();
    if (this.hasLicense(normalizedInstallationId)) {
      return {
        allowed: false,
        remainingSeconds: 0,
        startedAt: nowAt,
        expiresAt: nowAt,
        serverTime: nowAt
      };
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      let record = this.database.prepare(
        'SELECT * FROM trials WHERE installation_id = ?'
      ).get(normalizedInstallationId);
      if (!record) {
        const expiresAt = new Date(now + TRIAL_DURATION_MS).toISOString();
        this.database.prepare(`
          INSERT INTO trials
            (installation_id, credential_hash, started_at, expires_at, last_seen_at, app_version,
             platform, architecture)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedInstallationId,
          credentialHash,
          nowAt,
          expiresAt,
          nowAt,
          safeText(appVersion, 40),
          normalizeClientPlatform(platform),
          normalizeClientArchitecture(architecture)
        );
        record = {
          installation_id: normalizedInstallationId,
          credential_hash: credentialHash,
          started_at: nowAt,
          expires_at: expiresAt
        };
      } else {
        const expected = Buffer.from(record.credential_hash);
        if (expected.length !== credentialHash.length || !crypto.timingSafeEqual(expected, credentialHash)) {
          this.database.exec('ROLLBACK');
          return null;
        }
        this.database.prepare(`
          UPDATE trials SET last_seen_at = ?, app_version = ?, platform = ?, architecture = ?
          WHERE installation_id = ?
        `).run(
          nowAt,
          safeText(appVersion, 40),
          normalizeClientPlatform(platform),
          normalizeClientArchitecture(architecture),
          normalizedInstallationId
        );
      }
      this.database.exec('COMMIT');
      const remainingSeconds = Math.max(0, Math.ceil((Date.parse(record.expires_at) - now) / 1000));
      return {
        allowed: Date.parse(record.expires_at) > now,
        remainingSeconds: Math.min(TRIAL_CLIENT_WINDOW_SECONDS, remainingSeconds),
        startedAt: record.started_at,
        expiresAt: record.expires_at,
        serverTime: nowAt
      };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  authenticate(authorization, {
    appVersion = '',
    platform = '',
    architecture = '',
    markUpdate = false
  } = {}) {
    const match = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,80})$/i.exec(String(authorization || '').trim());
    if (!match) return null;
    const record = this.database.prepare(`
      SELECT l.*, a.status AS account_status, a.created_at AS account_created_at
      FROM licenses l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.id = ?
    `).get(match[1]);
    if (!record || record.status !== 'active' || record.account_status !== 'active') return null;
    const expected = Buffer.from(record.credential_hash);
    const actual = this.hashCredential(match[2]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const clientPlatform = platform ? normalizeClientPlatform(platform) : record.platform;
    const clientArchitecture = architecture
      ? normalizeClientArchitecture(architecture)
      : record.architecture;
    const metadataChanged = clientPlatform !== record.platform
      || clientArchitecture !== record.architecture;
    if (markUpdate || metadataChanged) {
      this.database.prepare(`
        UPDATE licenses
        SET app_version = ?, platform = ?, architecture = ?, last_update_at = ?
        WHERE id = ?
      `).run(
        markUpdate ? safeText(appVersion, 40) : record.app_version,
        clientPlatform,
        clientArchitecture,
        markUpdate ? nowIso() : record.last_update_at,
        record.id
      );
      this.database.prepare('UPDATE accounts SET last_active_at = ? WHERE id = ?')
        .run(nowIso(), record.account_id);
    }
    return {
      id: record.id,
      accountId: record.account_id,
      accountCreatedAt: record.account_created_at,
      installationId: record.installation_id,
      createdAt: record.created_at,
      appVersion: markUpdate ? safeText(appVersion, 40) : record.app_version,
      platform: clientPlatform,
      architecture: clientArchitecture
    };
  }

  authenticateTrial(authorization) {
    const match = /^Trial ([A-Za-z0-9_-]{20,80})\.([A-Za-z0-9_-]{40,80})$/
      .exec(String(authorization || '').trim());
    if (!match) return null;
    const record = this.database.prepare(`
      SELECT * FROM trials WHERE installation_id = ?
    `).get(match[1]);
    if (!record || Date.parse(record.expires_at) <= Date.now() || this.hasLicense(match[1])) return null;
    const expected = Buffer.from(record.credential_hash);
    const actual = this.hashCredential(match[2]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    return {
      id: `trial:${record.installation_id}`,
      accountId: `trial:${record.installation_id}`,
      installationId: record.installation_id,
      createdAt: record.started_at,
      appVersion: record.app_version,
      platform: record.platform,
      architecture: record.architecture,
      trial: true
    };
  }

  deviceInventory() {
    const licenses = this.database.prepare(`
      SELECT id, account_id, installation_id, status, app_version, platform, architecture,
        created_at, COALESCE(last_update_at, created_at) AS last_seen_at
      FROM licenses
      ORDER BY created_at DESC
    `).all().map((row) => ({
      deviceKey: row.id,
      licenseId: row.id,
      accountId: row.account_id,
      installationSuffix: String(row.installation_id).slice(-8),
      authorizationType: 'license',
      authorizationState: row.status,
      appVersion: row.app_version,
      platform: row.platform,
      architecture: row.architecture,
      firstSeenAt: row.created_at,
      lastSeenAt: row.last_seen_at
    }));
    const licensedInstallations = new Set(this.database.prepare(
      'SELECT installation_id FROM licenses'
    ).all().map((row) => row.installation_id));
    const trials = this.database.prepare(`
      SELECT installation_id, started_at, expires_at, last_seen_at, app_version,
        platform, architecture
      FROM trials
      ORDER BY started_at DESC
    `).all().filter((row) => !licensedInstallations.has(row.installation_id)).map((row) => {
      const deviceKey = `trial:${crypto.createHash('sha256').update(row.installation_id).digest('hex')}`;
      return {
        deviceKey,
        licenseId: deviceKey,
        accountId: `trial:${row.installation_id}`,
        installationSuffix: String(row.installation_id).slice(-8),
        authorizationType: 'trial',
        authorizationState: Date.parse(row.expires_at) > Date.now() ? 'active' : 'expired',
        appVersion: row.app_version,
        platform: row.platform,
        architecture: row.architecture,
        firstSeenAt: row.started_at,
        lastSeenAt: row.last_seen_at
      };
    });
    return [...licenses, ...trials];
  }

  list() {
    const currentTime = nowIso();
    const rows = this.database.prepare(`
      SELECT c.id, c.code_suffix, c.code_ciphertext IS NOT NULL AS can_reveal,
        c.status, c.note, c.created_at, c.expires_at, c.used_at, c.purpose,
        COALESCE(owner.account_id, c.target_account_id) AS account_id,
        a.status AS account_status, a.created_at AS account_created_at
      FROM activation_codes c
      LEFT JOIN licenses owner ON owner.id = (
        SELECT id FROM licenses
        WHERE activation_code_id = c.id
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      LEFT JOIN accounts a ON a.id = COALESCE(owner.account_id, c.target_account_id)
      ORDER BY c.created_at DESC, c.id DESC
    `).all();
    const licensesByCode = new Map();
    for (const license of this.database.prepare(`
      SELECT id, activation_code_id, installation_id, status, app_version, platform,
        architecture, created_at, revoked_at, last_update_at, revocation_reason
      FROM licenses
      ORDER BY created_at ASC, id ASC
    `).all()) {
      const mapped = {
        id: license.id,
        installationSuffix: String(license.installation_id).slice(-8),
        status: license.status,
        appVersion: license.app_version,
        platform: license.platform,
        architecture: license.architecture,
        createdAt: license.created_at,
        revokedAt: license.revoked_at,
        lastUpdateAt: license.last_update_at,
        revocationReason: license.revocation_reason
      };
      const current = licensesByCode.get(license.activation_code_id) || [];
      current.push(mapped);
      licensesByCode.set(license.activation_code_id, current);
    }
    const codes = rows.map((row) => {
      const licenses = licensesByCode.get(row.id) || [];
      const license = licenses.find((item) => item.status === 'active') || licenses[0] || null;
      return {
        id: row.id,
        maskedCode: `****${row.code_suffix}`,
        canReveal: row.can_reveal === 1,
        purpose: row.purpose,
        status: row.status === 'unused' && row.expires_at <= currentTime ? 'expired' : row.status,
        note: row.note,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        license,
        licenses,
        account: row.account_id ? {
          id: row.account_id,
          suffix: String(row.account_id).slice(-8),
          status: row.account_status,
          createdAt: row.account_created_at
        } : null
      };
    });
    const summary = {
      total: codes.length,
      unused: 0,
      used: 0,
      expired: 0,
      active: 0,
      revoked: 0,
      platforms: {
        windows: { total: 0, active: 0, revoked: 0 },
        macos: { total: 0, active: 0, revoked: 0 },
        android: { total: 0, active: 0, revoked: 0 },
        unknown: { total: 0, active: 0, revoked: 0 }
      }
    };
    for (const item of codes) {
      if (item.status === 'unused') summary.unused += 1;
      if (item.status === 'expired') summary.expired += 1;
      if (item.status === 'used') summary.used += 1;
      for (const license of item.licenses || []) {
        if (license.status === 'active') summary.active += 1;
        if (license.status === 'revoked') summary.revoked += 1;
        const platform = Object.hasOwn(summary.platforms, license.platform)
          ? license.platform
          : 'unknown';
        summary.platforms[platform].total += 1;
        if (license.status === 'active') summary.platforms[platform].active += 1;
        if (license.status === 'revoked') summary.platforms[platform].revoked += 1;
      }
    }
    const accountCounts = this.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
      FROM accounts
    `).get();
    summary.accounts = Number(accountCounts.total || 0);
    summary.activeAccounts = Number(accountCounts.active || 0);
    summary.suspendedAccounts = Number(accountCounts.suspended || 0);
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
    const record = this.database.prepare(`
      SELECT id, account_id FROM licenses WHERE id = ? AND status = 'active'
    `).get(licenseId);
    if (!record) return null;
    const result = this.database.prepare(`
      UPDATE licenses SET status = 'revoked', revoked_at = ?, revocation_reason = 'admin'
      WHERE id = ? AND status = 'active'
    `).run(revokedAt, licenseId);
    if (result.changes !== 1) return null;
    return { id: licenseId, accountId: record.account_id, revokedAt };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.pepper = null;
    this.encryptionKey = null;
    this.migrationState = null;
  }
}

module.exports = {
  ActivationStore,
  CODE_PATTERN,
  CREDENTIAL_PATTERN,
  INSTALLATION_ID_PATTERN,
  TRIAL_CLIENT_WINDOW_SECONDS,
  TRIAL_DURATION_MS,
  generateCode,
  normalizeCode
};
