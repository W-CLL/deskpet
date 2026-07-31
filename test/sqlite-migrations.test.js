const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../lib/sqlite-migrations');

test('SQLite migrations are ordered, idempotent and transactional', () => {
  const database = new DatabaseSync(':memory:');
  const migrations = [
    {
      version: 1,
      name: 'create-items',
      up(target) {
        target.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      }
    },
    {
      version: 2,
      name: 'seed-items',
      up(target) {
        target.prepare('INSERT INTO items (name) VALUES (?)').run('first');
      }
    }
  ];

  const first = applyMigrations(database, 'test', migrations);
  assert.deepEqual(first.applied.map((item) => item.version), [1, 2]);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items').get().count, 1);

  const second = applyMigrations(database, 'test', migrations);
  assert.deepEqual(second.applied, []);
  assert.equal(second.currentVersion, 2);

  assert.throws(() => applyMigrations(database, 'test', [
    ...migrations,
    {
      version: 3,
      name: 'failing-change',
      up(target) {
        target.exec('CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)');
        throw new Error('expected failure');
      }
    }
  ]), /数据库迁移失败/);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'should_rollback'
    `).get().count,
    0
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations
      WHERE scope = 'test' AND version = 3
    `).get().count,
    0
  );
  database.close();
});

test('SQLite migrations reject a database newer than the running code', () => {
  const database = new DatabaseSync(':memory:');
  applyMigrations(database, 'test', [{
    version: 1,
    name: 'baseline',
    up(target) {
      target.exec('CREATE TABLE baseline (id INTEGER PRIMARY KEY)');
    }
  }]);
  database.prepare(`
    INSERT INTO schema_migrations (scope, version, name, applied_at)
    VALUES ('test', 2, 'future-change', ?)
  `).run(new Date().toISOString());

  assert.throws(
    () => applyMigrations(database, 'test', [{
      version: 1,
      name: 'baseline',
      up() { }
    }]),
    /数据库版本高于当前代码/
  );
  database.close();
});
