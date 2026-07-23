const fs = require('node:fs');
const path = require('node:path');

const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/;

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
    this.data = { schemaVersion: 1, activeVersion: null, releases: [] };
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await fs.promises.mkdir(this.releasesDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.uploadsDirectory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.metadataPath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.releases)) throw new Error('版本数据格式无效');
      this.data = {
        schemaVersion: 1,
        activeVersion: typeof parsed.activeVersion === 'string' ? parsed.activeVersion : null,
        releases: parsed.releases.map((release) => ({
          version: normalizeVersion(release.version),
          fileName: path.basename(String(release.fileName || '')),
          originalName: path.basename(String(release.originalName || '')),
          size: Number(release.size),
          sha256: String(release.sha256 || '').toLowerCase(),
          notes: cleanNotes(release.notes),
          createdAt: String(release.createdAt || ''),
          publishedAt: release.publishedAt ? String(release.publishedAt) : null
        }))
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicWriteJson(this.metadataPath, this.data);
    }
  }

  list() {
    return this.data.releases
      .map((release) => ({ ...release, active: release.version === this.data.activeVersion }))
      .sort((left, right) => compareVersions(right.version, left.version));
  }

  find(version) {
    return this.data.releases.find((release) => release.version === version) || null;
  }

  has(version) {
    return Boolean(this.find(version));
  }

  active() {
    return this.find(this.data.activeVersion);
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

  async commitUpload({ temporaryPath, version, originalName, size, sha256, notes }) {
    return this.serializeMutation(async () => {
      const normalizedVersion = normalizeVersion(version);
      if (this.has(normalizedVersion)) throw new Error('该版本已经存在');
      const fileName = `ZhuoDazi-Desktop-Pet-${normalizedVersion}.exe`;
      const finalPath = path.join(this.releasesDirectory, fileName);
      const release = {
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
      return { ...release, active: false };
    });
  }

  async publish(version) {
    return this.serializeMutation(async () => {
      const release = this.find(normalizeVersion(version));
      if (!release) throw new Error('版本不存在');
      const previous = { activeVersion: this.data.activeVersion, publishedAt: release.publishedAt };
      release.publishedAt = release.publishedAt || new Date().toISOString();
      this.data.activeVersion = release.version;
      try {
        await atomicWriteJson(this.metadataPath, this.data);
      } catch (error) {
        release.publishedAt = previous.publishedAt;
        this.data.activeVersion = previous.activeVersion;
        throw error;
      }
      return { ...release, active: true };
    });
  }

  async delete(version) {
    return this.serializeMutation(async () => {
      const normalizedVersion = normalizeVersion(version);
      if (this.data.activeVersion === normalizedVersion) throw new Error('当前发布版本不能删除');
      const index = this.data.releases.findIndex((release) => release.version === normalizedVersion);
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

  manifest(publicUrl, version = null) {
    const release = version ? this.find(version) : this.active();
    if (!release?.publishedAt) return null;
    return {
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

module.exports = { ReleaseStore, compareVersions, normalizeVersion };
