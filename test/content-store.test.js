const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
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
    item('trivia:one', 'trivia')
  ]);
  const selected = store.selectBatch(
    ['joke', 'math', 'trivia'],
    ['joke:one'],
    3
  );
  assert.equal(selected.length, 3);
  assert.deepEqual(new Set(selected.map((entry) => entry.type)), new Set(['joke', 'math', 'trivia']));
  assert.equal(selected.some((entry) => entry.id === 'joke:one'), false);
  assert.equal(selected.every((entry) => !Object.hasOwn(entry, 'active')), true);
});
