const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateDataDirectory } = require('../scripts/migrate');

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
