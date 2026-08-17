const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CONTENT_TYPES,
  LEGACY_CONTENT_TYPES,
  contentTypeSqlList
} = require('../lib/content-types');

test('content types stay in one place for services and SQL checks', () => {
  assert.deepEqual(LEGACY_CONTENT_TYPES, ['joke', 'math', 'trivia']);
  assert.deepEqual(CONTENT_TYPES, ['joke', 'math', 'trivia', 'riddle', 'tip', 'care']);
  assert.equal(contentTypeSqlList(LEGACY_CONTENT_TYPES), "'joke', 'math', 'trivia'");
  assert.match(contentTypeSqlList(), /'riddle', 'tip', 'care'/);
});
