const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { ReleaseStore, normalizeVersion } = require('../lib/storage');

const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;

async function main() {
  const [versionValue, executableValue] = process.argv.slice(2);
  if (!versionValue || !executableValue) {
    throw new Error('用法: node scripts/import-release.js <version> <executable>');
  }

  const version = normalizeVersion(versionValue);
  const executablePath = path.resolve(executableValue);
  if (path.extname(executablePath).toLowerCase() !== '.exe') throw new Error('只允许导入 EXE 文件');
  const stat = await fs.promises.stat(executablePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_UPLOAD_SIZE) throw new Error('EXE 文件大小无效');

  const dataDirectory = path.resolve(process.env.DESKPET_DATA_DIR || path.join(__dirname, '..', 'data'));
  const store = new ReleaseStore(dataDirectory);
  await store.initialize();
  if (store.has(version)) throw new Error(`版本 ${version} 已经存在`);

  const uploadId = `cli-${process.pid}-${Date.now()}`;
  const temporaryPath = store.uploadPath(uploadId);
  const hash = crypto.createHash('sha256');
  await pipeline(
    fs.createReadStream(executablePath),
    async function* digest(source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
  );

  try {
    const release = await store.commitUpload({
      temporaryPath,
      version,
      originalName: path.basename(executablePath),
      size: stat.size,
      sha256: hash.digest('hex'),
      notes: process.env.DESKPET_RELEASE_NOTES || ''
    });
    const published = await store.publish(version);
    await store.audit({ action: 'cli-import', outcome: 'success', version, sha256: release.sha256 });
    process.stdout.write(`${JSON.stringify(published)}\n`);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
