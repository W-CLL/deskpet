const CONTENT_TYPES = Object.freeze(['joke', 'math', 'trivia', 'riddle', 'tip', 'care']);
const LEGACY_CONTENT_TYPES = Object.freeze(['joke', 'math', 'trivia']);
const SIX_TYPE_MINIMUM_VERSION = Object.freeze({ windows: '2.5.2' });

function sqlQuotedList(values) {
  return values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ');
}

function contentTypeSqlList(types = CONTENT_TYPES) {
  return sqlQuotedList(types);
}

module.exports = {
  CONTENT_TYPES,
  LEGACY_CONTENT_TYPES,
  SIX_TYPE_MINIMUM_VERSION,
  contentTypeSqlList
};
