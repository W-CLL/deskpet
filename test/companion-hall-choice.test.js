const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { CompanionStore } = require('../lib/companion-store');

async function directory() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-hall-choice-'));
}

async function fixture(context) {
  const dataDirectory = await directory();
  const store = new CompanionStore(dataDirectory);
  await store.initialize();
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  const row = (accountId) => store.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?')
    .get(accountId);
  return { store, row, dataDirectory };
}

test('version 7 marks old profiles unknown without changing hall or presence state', async (context) => {
  const dataDirectory = await directory();
  const old = new DatabaseSync(path.join(dataDirectory, 'companion.db'));
  old.exec(`
    CREATE TABLE schema_migrations (
      scope TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL,
      PRIMARY KEY (scope, version)
    );
    CREATE TABLE companion_profiles (
      account_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, pairing_code TEXT NOT NULL UNIQUE,
      paired_account_id TEXT UNIQUE, paired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      hall_enabled INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT,
      CHECK (paired_account_id IS NULL OR paired_account_id <> account_id)
    );
  `);
  const names = ['companion-baseline', 'companion-daily-stats', 'companion-secrets-and-stickers',
    'delivery-device-receipts', 'companion-hall-presence-and-messages', 'companion-delivery-source'];
  for (const [index, name] of names.entries()) {
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
      .run('companion', index + 1, name, '2026-09-01T00:00:00.000Z');
  }
  for (const [id, enabled, lastSeen] of [
    ['old-off', 0, null], ['old-on', 1, '2026-09-20T15:01:02.000Z']
  ]) {
    old.prepare(`INSERT INTO companion_profiles
      (account_id, display_name, pairing_code, created_at, updated_at, hall_enabled, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, id, id,
      '2026-09-02T02:02:02.000Z', '2026-09-21T01:01:01.000Z', enabled, lastSeen);
  }
  const before = old.prepare('SELECT * FROM companion_profiles ORDER BY account_id').all();
  old.close();
  const store = new CompanionStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();
  assert.equal(store.migrationState.currentVersion, 7);
  for (const previous of before) {
    const current = store.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?')
      .get(previous.account_id);
    assert.deepEqual({ ...current }, { ...previous,
      hall_choice: 'legacy_unknown', hall_choice_at: null, hall_opted_out_at: null });
  }
  store.close();
  await store.initialize();
  assert.deepEqual(store.migrationState.applied, [], 'reopening must not rewrite old choices');
});

test('new profiles record the default choice and keep internal fields out of the public profile', async (context) => {
  const { store, row } = await fixture(context);
  for (const enabled of [false, true]) {
    const id = `new-${enabled}`;
    const created = store.ensureProfile(id, { hallEnabled: enabled });
    assert.equal(created.hall_enabled, enabled ? 1 : 0);
    assert.equal(created.hall_choice, 'default');
    assert.equal(created.hall_choice_at, created.created_at);
    assert.equal(created.hall_opted_out_at, null);
    store.ensureProfile(id, { hallEnabled: !enabled });
    assert.equal(row(id).hall_enabled, enabled ? 1 : 0);
    assert.equal(row(id).hall_choice_at, created.hall_choice_at);
    assert.deepEqual(Object.keys(store.profile(id)).sort(),
      ['displayName', 'hallEnabled', 'online', 'pairingCode', 'partner']);
  }
});

test('an explicit close is recorded even in the creation millisecond and survives reopening and later choices', async (context) => {
  const { store, row } = await fixture(context);
  const first = new Date('2026-09-28T10:00:00.123Z');
  context.mock.timers.enable({ apis: ['Date'], now: first });
  store.ensureProfile('same-ms');
  store.setHallEnabled('same-ms', false);
  const closed = row('same-ms');
  assert.equal(closed.created_at, closed.updated_at);
  assert.equal(closed.hall_choice, 'manual_off');
  assert.equal(closed.hall_choice_at, first.toISOString());
  assert.equal(closed.hall_opted_out_at, first.toISOString());
  assert.equal(closed.last_seen_at, null);
  store.close();
  await store.initialize();
  assert.equal(row('same-ms').hall_opted_out_at, first.toISOString());
  context.mock.timers.tick(60_000);
  store.setHallEnabled('same-ms', true);
  const reopened = row('same-ms');
  assert.equal(reopened.hall_choice, 'manual_on');
  assert.equal(reopened.hall_choice_at, new Date(first.getTime() + 60_000).toISOString());
  assert.equal(reopened.hall_opted_out_at, first.toISOString());
  context.mock.timers.tick(60_000);
  store.updateProfile('same-ms', '改了昵称');
  store.touchPresence('same-ms');
  assert.equal(row('same-ms').hall_choice_at, reopened.hall_choice_at);
  store.setHallEnabled('same-ms', false);
  assert.equal(row('same-ms').hall_choice, 'manual_off');
  assert.equal(row('same-ms').hall_opted_out_at, first.toISOString(), 'retain the first permanent opt-out');
});

test('trial promotion carries default and explicit choices while an existing account keeps its own choice', async (context) => {
  const { store, row } = await fixture(context);
  for (const choice of ['default', 'manual_off', 'manual_on', 'legacy_unknown']) {
    const installationId = `trial-${choice}`;
    const trialId = `trial:${installationId}`;
    store.ensureProfile(trialId, { hallEnabled: true });
    if (choice.startsWith('manual_')) {
      store.setHallEnabled(trialId, false);
      if (choice === 'manual_on') store.setHallEnabled(trialId, true);
    } else if (choice === 'legacy_unknown') {
      store.database.prepare('UPDATE companion_profiles SET hall_choice = ?, hall_choice_at = NULL WHERE account_id = ?')
        .run(choice, trialId);
    }
    const trial = row(trialId);
    const accountId = `account-${choice}`;
    store.promoteTrialProfile(installationId, accountId, `license-${choice}`);
    const promoted = row(accountId);
    for (const field of ['hall_enabled', 'last_seen_at', 'hall_choice', 'hall_choice_at', 'hall_opted_out_at']) {
      assert.equal(promoted[field], trial[field], `${choice}: ${field}`);
    }
    assert.equal(row(trialId), undefined);
  }
  store.setHallEnabled('existing-account', false);
  const existing = row('existing-account');
  store.setHallEnabled('trial:joining-device', true);
  store.promoteTrialProfile('joining-device', 'existing-account', 'another-license');
  assert.deepEqual(row('existing-account'), existing, 'an extra device must not change the account preference');
});
