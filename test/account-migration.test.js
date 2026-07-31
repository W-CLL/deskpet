const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { ActivationStore } = require('../lib/activation-store');

test('legacy device licenses migrate to stable accounts without changing credentials', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-account-migration-'));
  const pepper = crypto.randomBytes(32);
  const encryptionKey = crypto.randomBytes(32);
  await Promise.all([
    fs.promises.writeFile(path.join(dataDirectory, 'activation-pepper.key'), pepper),
    fs.promises.writeFile(path.join(dataDirectory, 'activation-encryption.key'), encryptionKey)
  ]);

  const licenseId = crypto.randomUUID();
  const codeId = crypto.randomUUID();
  const credential = crypto.randomBytes(32).toString('base64url');
  const installationId = crypto.randomBytes(16).toString('hex');
  const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const legacy = new DatabaseSync(path.join(dataDirectory, 'activation.db'));
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE activation_codes (
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
    CREATE TABLE licenses (
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
  `);
  legacy.prepare(`
    INSERT INTO activation_codes
      (id, code_hash, code_suffix, status, note, created_at, expires_at, used_at, license_id)
    VALUES (?, ?, '7Q', 'used', 'legacy', ?, ?, ?, ?)
  `).run(codeId, crypto.randomBytes(32), createdAt, createdAt, createdAt, licenseId);
  legacy.prepare(`
    INSERT INTO licenses
      (id, activation_code_id, installation_id, credential_hash, app_version, created_at)
    VALUES (?, ?, ?, ?, '2.4.8', ?)
  `).run(
    licenseId,
    codeId,
    installationId,
    crypto.createHash('sha256').update(credential, 'ascii').digest(),
    createdAt
  );
  legacy.close();

  const store = new ActivationStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  const authenticated = store.authenticate(`Bearer ${licenseId}.${credential}`);
  assert.equal(authenticated.id, licenseId);
  assert.equal(authenticated.accountId, licenseId);
  assert.equal(authenticated.installationId, installationId);
  assert.equal(store.migrationState.currentVersion, 2);
  assert.deepEqual(store.migrationState.applied.map((item) => item.version), [1, 2]);
  assert.equal(store.list().summary.accounts, 1);

  store.close();
  await store.initialize();
  assert.equal(store.migrationState.currentVersion, 2);
  assert.deepEqual(store.migrationState.applied, []);
  assert.equal(store.list().summary.accounts, 1);
  const versions = store.database.prepare(`
    SELECT version FROM schema_migrations WHERE scope = 'activation' ORDER BY version
  `).all().map((row) => Number(row.version));
  assert.deepEqual(versions, [1, 2]);
});

test('rebind codes preserve the account and replace the active device license', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-account-rebind-'));
  const store = new ActivationStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  const firstCredential = crypto.randomBytes(32).toString('base64url');
  const firstCode = store.createCodes({ count: 1, expiresInDays: 30 }).codes[0];
  const first = store.activate({
    code: firstCode,
    installationId: crypto.randomBytes(16).toString('hex'),
    credential: firstCredential,
    appVersion: '2.4.9'
  });
  assert.notEqual(first.accountId, first.licenseId);

  const expiredRebindCode = store.createRebindCode(first.accountId).codes[0];
  const activeRebindCode = store.createRebindCode(first.accountId).codes[0];
  assert.equal(store.activate({
    code: expiredRebindCode,
    installationId: crypto.randomBytes(16).toString('hex'),
    credential: crypto.randomBytes(32).toString('base64url')
  }), null);

  const secondCredential = crypto.randomBytes(32).toString('base64url');
  const second = store.activate({
    code: activeRebindCode,
    installationId: crypto.randomBytes(16).toString('hex'),
    credential: secondCredential,
    appVersion: '2.4.9'
  });
  assert.equal(second.accountId, first.accountId);
  assert.notEqual(second.licenseId, first.licenseId);
  assert.equal(store.authenticate(`Bearer ${first.licenseId}.${firstCredential}`), null);
  assert.equal(
    store.authenticate(`Bearer ${second.licenseId}.${secondCredential}`).accountId,
    first.accountId
  );

  const retry = store.activate({
    code: activeRebindCode,
    installationId: store.authenticate(`Bearer ${second.licenseId}.${secondCredential}`).installationId,
    credential: secondCredential,
    appVersion: '2.4.9'
  });
  assert.equal(retry.accountId, first.accountId);
  assert.equal(retry.licenseId, second.licenseId);
  assert.equal(retry.alreadyActivated, true);

  const summary = store.list().summary;
  assert.equal(summary.accounts, 1);
  assert.equal(summary.active, 1);
  assert.equal(summary.revoked, 1);
});
