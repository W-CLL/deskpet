const assert = require('node:assert/strict');
const test = require('node:test');
const { querySearchParams, queryValue } = require('../src/http/request-context');

test('query helpers parse originalUrl when Express query parsing is disabled', () => {
  const req = { originalUrl: '/api/admin/analytics?from=2026-08-01&to=2026-08-10' };
  assert.equal(queryValue(req, 'from'), '2026-08-01');
  assert.equal(queryValue(req, 'to'), '2026-08-10');
  assert.equal(querySearchParams(req).get('from'), '2026-08-01');
  assert.equal(queryValue({ originalUrl: '/api/admin/analytics' }, 'from'), '');
  assert.equal(queryValue({ url: '/api/update/latest?platform=android' }, 'platform'), 'android');
});
