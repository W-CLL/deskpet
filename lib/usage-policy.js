// Update polling is maintenance traffic, not product usage. Keep this policy
// shared by the HTTP collector and the store so other callers cannot count it.
const UPDATE_CHECK_PATH = '/api/update/latest';

function isUpdateCheckPath(value) {
  return String(value || '').split('?', 1)[0].replace(/\/+$/, '').toLowerCase() === UPDATE_CHECK_PATH;
}

module.exports = { UPDATE_CHECK_PATH, isUpdateCheckPath };
