const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { main, validateDataDirectory } = require('../scripts/migrate');

test('production migration guard refuses a missing or empty data directory', async (context) => {
  const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-migrate-guard-'));
  const missingDirectory = path.join(parentDirectory, 'missing');
  const emptyDirectory = path.join(parentDirectory, 'empty');
  await fs.promises.mkdir(emptyDirectory);
  context.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));

  assert.throws(
    () => validateDataDirectory(missingDirectory, true),
    /生产数据目录不存在/
  );
  assert.throws(
    () => validateDataDirectory(emptyDirectory, true),
    /拒绝创建空库/
  );

  await fs.promises.writeFile(path.join(emptyDirectory, 'activation.db'), 'existing');
  assert.doesNotThrow(() => validateDataDirectory(emptyDirectory, true));
  assert.doesNotThrow(() => validateDataDirectory(missingDirectory, false));
});

test('migrate initializes every SQLite store without seeding products or enabling collection', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-migrate-analytics-'));
  const previousDataDirectory = process.env.DESKPET_DATA_DIR;
  process.env.DESKPET_DATA_DIR = dataDirectory;
  context.after(async () => {
    if (previousDataDirectory === undefined) delete process.env.DESKPET_DATA_DIR;
    else process.env.DESKPET_DATA_DIR = previousDataDirectory;
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const printed = [];
  const originalLog = console.log;
  console.log = (value) => {
    printed.push(String(value));
  };
  try {
    await main([]);
    await main(['--require-existing']);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(printed[0]);
  const repeated = JSON.parse(printed[1]);
  assert.equal(result.dataDirectory, dataDirectory);
  assert.ok(result.analytics.currentVersion >= 1);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'analytics.db')), true);
  for (const [scope, file] of Object.entries({
    activation: 'activation.db', feedback: 'feedback.db', interaction: 'interaction.db',
    analytics: 'analytics.db', content: 'content.db', companion: 'companion.db',
    visitStickers: 'visit-stickers.db', petMarket: 'pet-market.db', uninstall: 'uninstall.db',
    wechatGrants: 'activation.db', ossUploads: 'oss-uploads.db'
  })) {
    assert.ok(result[scope].currentVersion >= 1, scope);
    assert.equal(fs.existsSync(path.join(dataDirectory, file)), true, file);
    assert.deepEqual(repeated[scope].applied, [], `${scope} migration remains idempotent`);
  }
  assert.equal(fs.existsSync(path.join(dataDirectory, 'fixtures')), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'local-market.db')), false);
  const database = new DatabaseSync(path.join(dataDirectory, 'pet-market.db'), { readOnly: true });
  try {
    for (const table of ['pet_market_products', 'local_market_orders', 'local_market_entitlements',
      'local_market_manual_confirmations', 'pet_market_payment_settings']) {
      assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 0, table);
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});
