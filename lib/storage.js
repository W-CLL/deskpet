const fs = require('node:fs');
const path = require('node:path');

const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_PLATFORMS = Object.freeze({
  windows: ['x64'],
  macos: ['arm64', 'x86_64']
});

function normalizeVersion(value) {
  const version = String(value || '').trim();
  if (!VERSION_PATTERN.test(version) || version.length > 40) throw new Error('版本号格式无效');
  return version;
}

function compareVersions(leftValue, rightValue) {
  const parse = (value) => {
    const [core, prerelease = ''] = normalizeVersion(value).split('-', 2);
    return { parts: core.split('.').map(Number), prerelease };
  };
  const left = parse(leftValue);
  const right = parse(rightValue);
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease, 'en', { numeric: true });
}

function cleanNotes(value) {
  return String(value || '').replace(/\r/g, '').trim().slice(0, 1200);
}

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  if (!Object.hasOwn(RELEASE_PLATFORMS, platform)) throw new Error('发布平台无效');
  return platform;
}

function normalizeArchitecture(platformValue, architectureValue) {
  const platform = normalizePlatform(platformValue);
  const architecture = String(architectureValue || '').trim().toLowerCase();
  if (!RELEASE_PLATFORMS[platform].includes(architecture)) {
    throw new Error(`${platform} 不支持该架构`);
  }
  return architecture;
}

function releaseKey(platform, architecture) {
  return `${normalizePlatform(platform)}/${normalizeArchitecture(platform, architecture)}`;
}

function expectedReleaseFileName(platformValue, architectureValue, versionValue) {
  const platform = normalizePlatform(platformValue);
  const architecture = normalizeArchitecture(platform, architectureValue);
  const version = normalizeVersion(versionValue);
  if (platform === 'windows') return `ZhuoDazi-Desktop-Pet-${version}.exe`;
  return `ZhuoDazi-macOS-${version}-${architecture}.zip`;
}

async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporaryPath, filePath);
}

class ReleaseStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.releasesDirectory = path.join(this.dataDirectory, 'releases');
    this.uploadsDirectory = path.join(this.dataDirectory, 'uploads');
    this.metadataPath = path.join(this.dataDirectory, 'releases.json');
    this.auditPath = path.join(this.dataDirectory, 'audit.jsonl');
    this.data = { schemaVersion: 2, activeVersions: {}, releases: [] };
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await fs.promises.mkdir(this.releasesDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.uploadsDirectory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.metadataPath, 'utf8'));
      if (!Array.isArray(parsed?.releases)) throw new Error('版本数据格式无效');
      const legacy = parsed.schemaVersion === 1;
      if (!legacy && parsed.schemaVersion !== 2) throw new Error('版本数据格式无效');
      const releases = parsed.releases.map((release) => {
        const platform = legacy ? 'windows' : normalizePlatform(release.platform);
        const architecture = legacy ? 'x64' : normalizeArchitecture(platform, release.architecture);
        return {
          platform,
          architecture,
          version: normalizeVersion(release.version),
          fileName: path.basename(String(release.fileName || '')),
          originalName: path.basename(String(release.originalName || '')),
          size: Number(release.size),
          sha256: String(release.sha256 || '').toLowerCase(),
          notes: cleanNotes(release.notes),
          createdAt: String(release.createdAt || ''),
          publishedAt: release.publishedAt ? String(release.publishedAt) : null
        };
      });
      const activeVersions = legacy
        ? (typeof parsed.activeVersion === 'string' ? { 'windows/x64': parsed.activeVersion } : {})
        : Object.fromEntries(Object.entries(parsed.activeVersions || {})
          .filter(([key, version]) => typeof version === 'string' && /^\w+\/[-_\w]+$/.test(key))
          .map(([key, version]) => [key, normalizeVersion(version)]));
      this.data = { schemaVersion: 2, activeVersions, releases };
      if (legacy) await atomicWriteJson(this.metadataPath, this.data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicWriteJson(this.metadataPath, this.data);
    }
  }

  list() {
    return this.data.releases
      .map((release) => ({
        ...release,
        active: release.version === this.data.activeVersions[releaseKey(release.platform, release.architecture)]
      }))
      .sort((left, right) => left.platform.localeCompare(right.platform)
        || left.architecture.localeCompare(right.architecture)
        || compareVersions(right.version, left.version));
  }

  find(platform, architecture, version) {
    const key = releaseKey(platform, architecture);
    const [normalizedPlatform, normalizedArchitecture] = key.split('/');
    const normalizedVersion = normalizeVersion(version);
    return this.data.releases.find((release) => release.platform === normalizedPlatform
      && release.architecture === normalizedArchitecture
      && release.version === normalizedVersion) || null;
  }

  has(platform, architecture, version) {
    return Boolean(this.find(platform, architecture, version));
  }

  active(platform, architecture) {
    return this.find(platform, architecture, this.data.activeVersions[releaseKey(platform, architecture)] || '0.0.0');
  }

  findPublishedFile(fileName) {
    return this.data.releases.find((release) => release.fileName === fileName && release.publishedAt) || null;
  }

  uploadPath(uploadId) {
    return path.join(this.uploadsDirectory, `${uploadId}.part`);
  }

  async serializeMutation(action) {
    const pending = this.mutation.then(action, action);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  async commitUpload({ temporaryPath, platform, architecture, version, originalName, size, sha256, notes }) {
    return this.serializeMutation(async () => {
      const normalizedPlatform = normalizePlatform(platform);
      const normalizedArchitecture = normalizeArchitecture(normalizedPlatform, architecture);
      const normalizedVersion = normalizeVersion(version);
      if (this.has(normalizedPlatform, normalizedArchitecture, normalizedVersion)) throw new Error('该平台和架构的版本已经存在');
      const fileName = expectedReleaseFileName(normalizedPlatform, normalizedArchitecture, normalizedVersion);
      const finalPath = path.join(this.releasesDirectory, fileName);
      const release = {
        platform: normalizedPlatform,
        architecture: normalizedArchitecture,
        version: normalizedVersion,
        fileName,
        originalName: path.basename(String(originalName || fileName)).slice(0, 160),
        size: Number(size),
        sha256: String(sha256).toLowerCase(),
        notes: cleanNotes(notes),
        createdAt: new Date().toISOString(),
        publishedAt: null
      };
      await fs.promises.rename(temporaryPath, finalPath);
      this.data.releases.push(release);
      try {
        await atomicWriteJson(this.metadataPath, this.data);
      } catch (error) {
        this.data.releases = this.data.releases.filter((item) => item !== release);
        await fs.promises.rename(finalPath, temporaryPath).catch(() => {});
        throw error;
      }
      return {
        ...release,
        active: release.version === this.data.activeVersions[releaseKey(release.platform, release.architecture)]
      };
    });
  }

  async publish(platform, architecture, version) {
    return this.serializeMutation(async () => {
      const key = releaseKey(platform, architecture);
      const release = this.find(platform, architecture, version);
      if (!release) throw new Error('版本不存在');
      const previous = { activeVersion: this.data.activeVersions[key], publishedAt: release.publishedAt };
      release.publishedAt = release.publishedAt || new Date().toISOString();
      this.data.activeVersions[key] = release.version;
      try {
        await atomicWriteJson(this.metadataPath, this.data);
      } catch (error) {
        release.publishedAt = previous.publishedAt;
        if (previous.activeVersion) this.data.activeVersions[key] = previous.activeVersion;
        else delete this.data.activeVersions[key];
        throw error;
      }
      return { ...release, active: true };
    });
  }

  async delete(platform, architecture, version) {
    return this.serializeMutation(async () => {
      const key = releaseKey(platform, architecture);
      const normalizedVersion = normalizeVersion(version);
      if (this.data.activeVersions[key] === normalizedVersion) throw new Error('当前发布版本不能删除');
      const index = this.data.releases.findIndex((release) => release.platform === normalizePlatform(platform)
        && release.architecture === normalizeArchitecture(platform, architecture)
        && release.version === normalizedVersion);
      if (index < 0) throw new Error('版本不存在');
      const release = this.data.releases[index];
      const finalPath = path.join(this.releasesDirectory, release.fileName);
      const quarantinePath = `${finalPath}.deleting`;
      await fs.promises.rename(finalPath, quarantinePath);
      this.data.releases.splice(index, 1);
      try {
        await atomicWriteJson(this.metadataPath, this.data);
        await fs.promises.rm(quarantinePath, { force: true });
      } catch (error) {
        this.data.releases.splice(index, 0, release);
        await fs.promises.rename(quarantinePath, finalPath).catch(() => {});
        throw error;
      }
      return release;
    });
  }

  manifest(publicUrl, platform, architecture, version = null) {
    const release = version
      ? this.find(platform, architecture, version)
      : this.active(platform, architecture);
    if (!release?.publishedAt) return null;
    return {
      platform: release.platform,
      architecture: release.architecture,
      version: release.version,
      url: new URL(`/downloads/${encodeURIComponent(release.fileName)}`, publicUrl).href,
      sha256: release.sha256,
      notes: release.notes
    };
  }

  filePath(release) {
    return path.join(this.releasesDirectory, release.fileName);
  }

  async audit(entry) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    await fs.promises.appendFile(this.auditPath, line, { encoding: 'utf8', mode: 0o600 });
  }
}

module.exports = {
  RELEASE_PLATFORMS,
  ReleaseStore,
  compareVersions,
  expectedReleaseFileName,
  normalizeArchitecture,
  normalizePlatform,
  normalizeVersion,
  releaseKey
};
