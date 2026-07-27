const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const {
  ReleaseStore,
  expectedReleaseFileName,
  normalizeArchitecture,
  normalizePlatform,
  normalizeVersion
} = require('../lib/storage');
const { loadConfig } = require('../src/config/app-config');
const {
  validateReleaseArtifact
} = require('../src/services/release-service');

const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;

async function main() {
  const args = process.argv.slice(2);
  const legacyWindowsImport = args.length === 2;
  const [platformValue, architectureValue, versionValue, artifactValue] = legacyWindowsImport
    ? ['windows', 'x64', args[0], args[1]]
    : args;
  if (!versionValue || !artifactValue) {
    throw new Error('用法: node scripts/import-release.js [<platform> <architecture>] <version> <artifact>');
  }

  const platform = normalizePlatform(platformValue);
  const architecture = normalizeArchitecture(platform, architectureValue);
  const version = normalizeVersion(versionValue);
  const artifactPath = path.resolve(artifactValue);
  const expectedFileName = expectedReleaseFileName(platform, architecture, version);
  if (path.extname(artifactPath).toLowerCase() !== path.extname(expectedFileName).toLowerCase()) {
    throw new Error(`只允许导入 ${path.extname(expectedFileName).toUpperCase()} 文件`);
  }
  if (path.basename(artifactPath).toLowerCase() !== expectedFileName.toLowerCase()) {
    throw new Error(`安装包文件名必须为 ${expectedFileName}`);
  }
  const stat = await fs.promises.stat(artifactPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_UPLOAD_SIZE) throw new Error('安装包文件大小无效');

  const config = loadConfig();
  const store = new ReleaseStore(config.dataDirectory);
  await store.initialize();
  if (store.has(platform, architecture, version)) {
    throw new Error(`${platform}/${architecture} 的版本 ${version} 已经存在`);
  }
  const signingPrivateKey = crypto.createPrivateKey(
    await fs.promises.readFile(config.signingPrivateKeyPath)
  );
  if (signingPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('更新签名私钥必须使用 Ed25519');
  }

  const uploadId = `cli-${process.pid}-${Date.now()}`;
  const temporaryPath = store.uploadPath(uploadId);
  const hash = crypto.createHash('sha256');
  await pipeline(
    fs.createReadStream(artifactPath),
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
      platform,
      architecture,
      version,
      originalName: path.basename(artifactPath),
      size: stat.size,
      sha256: hash.digest('hex'),
      notes: process.env.DESKPET_RELEASE_NOTES || ''
    });
    const validation = await validateReleaseArtifact({
      releaseStore: store,
      publicUrl: config.publicUrl,
      signingPrivateKey,
      platform,
      architecture,
      version
    });
    const published = await store.publish(platform, architecture, version);
    await store.audit({
      action: 'cli-import',
      outcome: 'success',
      platform,
      architecture,
      version,
      sha256: release.sha256,
      signatureVerified: validation.signatureVerified
    });
    process.stdout.write(`${JSON.stringify({ release: published, validation })}\n`);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
