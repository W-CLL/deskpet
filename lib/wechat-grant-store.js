const crypto = require('node:crypto');
const path = require('node:path');
const { applyMigrations } = require('./sqlite-migrations');

const MIGRATION_SCOPE = 'wechat-grants';
const SOURCE = 'wechat_gift';
const NONCE_TTL_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength, field) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength || /[\r\n]/.test(text)) {
    const error = new Error(`${field} 格式无效`);
    error.code = 'INVALID_GRANT_REQUEST';
    throw error;
  }
  return text;
}

function normalizeRetentionDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    const error = new Error('retentionDays 必须为 1 至 365');
    error.code = 'INVALID_GRANT_REQUEST';
    throw error;
  }
  return days;
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'wechat-grants-baseline',
    up(database) {
      database.exec(`
        ALTER TABLE activation_codes ADD COLUMN source_grant_id TEXT;
        ALTER TABLE activation_codes ADD COLUMN revoked_at TEXT;
        ALTER TABLE licenses ADD COLUMN source_grant_id TEXT;
        CREATE INDEX idx_activation_codes_grant ON activation_codes(source_grant_id);
        CREATE INDEX idx_licenses_grant ON licenses(source_grant_id, status);
      `);
      database.exec(`
        CREATE TABLE IF NOT EXISTS wechat_grants (
          id TEXT PRIMARY KEY,
          claim_id TEXT NOT NULL UNIQUE,
          external_subject_id TEXT NOT NULL UNIQUE,
          campaign_id TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'wechat_gift'
            CHECK (source = 'wechat_gift'),
          activation_code_id TEXT NOT NULL UNIQUE,
          retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 365),
          status TEXT NOT NULL DEFAULT 'issued'
            CHECK (status IN ('issued', 'redeemed', 'revoked')),
          account_id TEXT,
          issued_at TEXT NOT NULL,
          revoked_at TEXT,
          revoke_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wechat_grants_status
          ON wechat_grants(status, issued_at DESC);
        CREATE INDEX IF NOT EXISTS idx_wechat_grants_campaign
          ON wechat_grants(campaign_id, issued_at ASC);
        CREATE TABLE IF NOT EXISTS wechat_request_nonces (
          client_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (client_id, nonce)
        );
        CREATE INDEX IF NOT EXISTS idx_wechat_request_nonces_created
          ON wechat_request_nonces(created_at);
      `);
    }
  }
];

class WechatGrantStore {
  constructor(dataDirectory, { activationStore } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.activationStore = activationStore;
    this.database = null;
    this.databasePath = path.join(this.dataDirectory, 'activation.db');
    this.migrationState = null;
  }

  async initialize() {
    this.database = this._requireActivationStore().database;
    if (!this.database) throw new Error('激活数据库尚未初始化');
    this.migrationState = applyMigrations(this.database, MIGRATION_SCOPE, MIGRATIONS);
    this.activationStore.activationColumns = new Set(
      this.database.prepare('PRAGMA table_info(activation_codes)').all().map((row) => row.name)
    );
    this.activationStore.licenseColumns = new Set(
      this.database.prepare('PRAGMA table_info(licenses)').all().map((row) => row.name)
    );
  }

  consumeNonce(clientId, nonce, createdAt = Date.now()) {
    const normalizedClient = cleanText(clientId, 128, 'clientId');
    const normalizedNonce = cleanText(nonce, 256, 'nonce');
    const now = new Date(createdAt).toISOString();
    // A request five minutes in the future may be accepted again for another
    // ten minutes, so retain received nonces across the whole skew window.
    const cutoff = new Date(createdAt - 2 * NONCE_TTL_MS).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM wechat_request_nonces WHERE created_at < ?').run(cutoff);
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO wechat_request_nonces (client_id, nonce, created_at)
        VALUES (?, ?, ?)
      `).run(normalizedClient, normalizedNonce, now);
      this.database.exec('COMMIT');
      return result.changes === 1;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  _requireActivationStore() {
    if (!this.activationStore) throw new Error('公众号激活码存储未配置');
    return this.activationStore;
  }

  _row(grantId) {
    return this.database.prepare('SELECT * FROM wechat_grants WHERE id = ?').get(String(grantId || ''));
  }

  _refreshRedeemed(row) {
    if (!row) return null;
    if (row.status === 'issued') {
      const code = this._requireActivationStore().getActivationCode(row.activation_code_id);
      if (code?.status === 'used') {
        this.database.prepare(`
          UPDATE wechat_grants SET status = 'redeemed', account_id = ? WHERE id = ? AND status = 'issued'
        `).run(code.accountId || null, row.id);
        row.status = 'redeemed';
        row.account_id = code.accountId || null;
      }
    }
    return row;
  }

  _public(row, { includeCode = false } = {}) {
    if (!row) return null;
    const activation = this._requireActivationStore();
    const code = activation.getActivationCode(row.activation_code_id);
    const licenses = activation.listLicensesForGrant(row.id);
    const accountId = row.account_id || code?.accountId || licenses.find((item) => item.accountId)?.accountId || null;
    if (accountId && !row.account_id) {
      this.database.prepare('UPDATE wechat_grants SET account_id = ? WHERE id = ?').run(accountId, row.id);
      row.account_id = accountId;
    }
    const result = {
      grantId: row.id,
      claimId: row.claim_id,
      externalSubjectId: row.external_subject_id,
      campaignId: row.campaign_id,
      source: row.source,
      activationCodeId: row.activation_code_id,
      status: row.status,
      accountId,
      issuedAt: row.issued_at,
      revokedAt: row.revoked_at || null,
      licenses: licenses.map((license) => ({
        id: license.id,
        accountId: license.accountId,
        platform: license.platform,
        architecture: license.architecture,
        status: license.status,
        createdAt: license.createdAt,
        revokedAt: license.revokedAt || null
      }))
    };
    if (includeCode) {
      const revealed = activation.reveal(row.activation_code_id);
      result.code = revealed?.code || null;
    }
    return result;
  }

  get(grantId, { includeCode = false } = {}) {
    const row = this._refreshRedeemed(this._row(grantId));
    return this._public(row, { includeCode });
  }

  create({ claimId, externalSubjectId, campaignId, retentionDays = 30 }) {
    const cleanClaimId = cleanText(claimId, 160, 'claimId');
    const cleanSubjectId = cleanText(externalSubjectId, 200, 'externalSubjectId');
    const cleanCampaignId = cleanText(campaignId, 160, 'campaignId');
    const days = normalizeRetentionDays(retentionDays);

    this.database.exec('BEGIN IMMEDIATE');
    let grantId;
    let activationCodeId;
    try {
      const byClaim = this.database.prepare('SELECT * FROM wechat_grants WHERE claim_id = ?').get(cleanClaimId);
      if (byClaim) {
        if (byClaim.external_subject_id !== cleanSubjectId || byClaim.campaign_id !== cleanCampaignId
          || Number(byClaim.retention_days) !== days) {
          const error = new Error('claimId 已存在但请求内容不一致');
          error.code = 'GRANT_IDEMPOTENCY_MISMATCH';
          throw error;
        }
        this.database.exec('COMMIT');
        return this._public(this._refreshRedeemed(byClaim), { includeCode: true });
      }
      const bySubject = this.database.prepare(
        'SELECT * FROM wechat_grants WHERE external_subject_id = ?'
      ).get(cleanSubjectId);
      if (bySubject) {
        const error = new Error('该用户已经领取过公众号赠送权益');
        error.code = 'SUBJECT_ALREADY_CLAIMED';
        throw error;
      }

      grantId = crypto.randomUUID();
      const generated = this._requireActivationStore().createCodes({
        count: 1,
        expiresInDays: days,
        note: `wechat_gift:${grantId}`,
        sourceGrantId: grantId,
        withinTransaction: true
      });
      const code = generated.codes[0];
      const record = this._requireActivationStore().findActivationCodeByPlaintext(code);
      if (!record) throw new Error('公众号激活码创建失败');
      activationCodeId = record.id;
      const issuedAt = generated.createdAt || nowIso();
      this.database.prepare(`
        INSERT INTO wechat_grants
          (id, claim_id, external_subject_id, campaign_id, source, activation_code_id,
           retention_days, status, issued_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)
      `).run(
        grantId,
        cleanClaimId,
        cleanSubjectId,
        cleanCampaignId,
        SOURCE,
        activationCodeId,
        days,
        issuedAt,
        issuedAt
      );
      this.database.exec('COMMIT');
      return this._public(this._row(grantId), { includeCode: true });
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  revoke(grantId, reason = 'unfollow_before_30_days') {
    const id = cleanText(grantId, 80, 'grantId');
    const cleanReason = cleanText(reason, 160, 'reason');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this._row(id);
      if (!row) {
        this.database.exec('ROLLBACK');
        return null;
      }
      if (row.status !== 'revoked') {
        const revokedAt = nowIso();
        const revoked = this._requireActivationStore()
          .revokeGiftCode(row.id, cleanReason, revokedAt, true);
        if (!revoked) {
          const error = new Error('公众号赠送权益关联的激活码不存在');
          error.code = 'GRANT_STORAGE_INCONSISTENT';
          throw error;
        }
        this.database.prepare(`
          UPDATE wechat_grants
          SET status = 'revoked', revoked_at = ?, revoke_reason = ?
          WHERE id = ?
        `).run(revokedAt, cleanReason, id);
      }
      this.database.exec('COMMIT');
      return this._public(this._row(id));
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  close() {
    // The connection is owned by ActivationStore so grant and activation
    // writes share one SQLite transaction.
    this.database = null;
    this.migrationState = null;
  }
}

module.exports = {
  MIGRATION_SCOPE,
  NONCE_TTL_MS,
  SOURCE,
  WechatGrantStore,
  MIGRATIONS
};
