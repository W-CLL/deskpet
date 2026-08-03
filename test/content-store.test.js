const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { ContentStore } = require('../lib/content-store');

function item(id, type, overrides = {}) {
  return {
    id,
    type,
    prompt: `${id} 的题面`,
    answer: `${id} 的答案`,
    explanation: '',
    choices: [],
    tags: ['测试'],
    difficulty: 1,
    locale: 'zh-CN',
    active: true,
    ...overrides
  };
}

test('content catalog versions changes and imports idempotently', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-content-store-'));
  const store = new ContentStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  assert.equal(store.catalog().version, 0);
  const created = store.create(item('joke:first', 'joke'));
  assert.equal(created.item.revision, 1);
  assert.equal(created.catalog.version, 1);

  const unchanged = store.update('joke:first', item('joke:first', 'joke'));
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.catalog.version, 1);

  const updated = store.update('joke:first', item('joke:first', 'joke', {
    answer: '更新后的答案'
  }));
  assert.equal(updated.changed, true);
  assert.equal(updated.item.revision, 2);
  assert.equal(updated.catalog.version, 2);

  const imported = store.importItems([
    item('joke:first', 'joke', { revision: 2, answer: '更新后的答案' }),
    item('math:first', 'math', { revision: 4 })
  ]);
  assert.deepEqual(
    { created: imported.created, updated: imported.updated, skipped: imported.skipped },
    { created: 1, updated: 0, skipped: 1 }
  );
  assert.equal(imported.catalog.version, 3);
  assert.equal(store.get('math:first').revision, 4);

  const stale = store.importItems([
    item('math:first', 'math', { revision: 3, answer: '不应覆盖' })
  ]);
  assert.equal(stale.skipped, 1);
  assert.equal(stale.changed, false);
  assert.equal(store.get('math:first').answer, 'math:first 的答案');
  assert.equal(store.catalog().version, 3);

  const replaced = store.importItems([
    item('trivia:first', 'trivia', { revision: 1 })
  ], { disableMissing: true });
  assert.equal(replaced.created, 1);
  assert.equal(replaced.disabled, 2);
  assert.equal(replaced.catalog.version, 4);
  assert.deepEqual(store.disabledIds(), ['joke:first', 'math:first']);
  assert.deepEqual(store.activeItems().map((entry) => entry.id), ['trivia:first']);
});

test('content batches balance requested types and honor exclusions', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-content-batch-'));
  const store = new ContentStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  store.importItems([
    item('joke:one', 'joke'),
    item('joke:two', 'joke'),
    item('math:one', 'math'),
    item('trivia:one', 'trivia'),
    item('riddle:one', 'riddle'),
    item('tip:one', 'tip'),
    item('care:one', 'care')
  ]);
  const selected = store.selectBatch(
    ['joke', 'math', 'trivia', 'riddle', 'tip', 'care'],
    ['joke:one'],
    6
  );
  assert.equal(selected.length, 6);
  assert.deepEqual(
    new Set(selected.map((entry) => entry.type)),
    new Set(['joke', 'math', 'trivia', 'riddle', 'tip', 'care'])
  );
  assert.equal(selected.some((entry) => entry.id === 'joke:one'), false);
  assert.equal(selected.every((entry) => !Object.hasOwn(entry, 'active')), true);
});

test('content migration preserves legacy rows and enables the expanded types', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-content-migration-'));
  const databasePath = path.join(dataDirectory, 'content.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (scope, version)
    );
    CREATE TABLE content_catalog (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE content_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('joke', 'math', 'trivia')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      prompt TEXT NOT NULL,
      answer TEXT NOT NULL,
      explanation TEXT NOT NULL DEFAULT '',
      choices_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      difficulty INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_content_items_status_type
      ON content_items(status, type, updated_at DESC);
    INSERT INTO schema_migrations (scope, version, name, applied_at)
      VALUES ('content', 1, 'content-catalog-baseline', '2026-01-01T00:00:00.000Z');
    INSERT INTO content_catalog (id, version, updated_at)
      VALUES (1, 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO content_items
      (id, type, revision, prompt, answer, explanation, choices_json, tags_json,
       difficulty, locale, status, created_at, updated_at)
      VALUES ('joke:legacy', 'joke', 3, '旧笑话题面', '旧笑话答案', '', '[]', '[]',
        1, 'zh-CN', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  database.close();

  const store = new ContentStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  assert.deepEqual(store.migrationState.applied.map((entry) => entry.version), [2]);
  assert.equal(store.get('joke:legacy').revision, 3);
  assert.equal(store.create(item('care:new', 'care')).item.type, 'care');
  assert.equal(store.create(item('tip:new', 'tip')).item.type, 'tip');
  assert.equal(store.create(item('riddle:new', 'riddle')).item.type, 'riddle');
});
