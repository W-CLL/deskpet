const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { trimSlice } = require('./text');
const { validateResourcePackPackage } = require('./resource-pack-package');

const RESOURCE_PACK_CATEGORIES = Object.freeze(['interaction-words', 'theater-scripts']);
const RESOURCE_PACK_STATUSES = Object.freeze(['draft', 'published', 'unlisted']);

function normalizeCategory(value) {
  const input = String(value || '').trim().toLowerCase();
  const category = ({ wordpack: 'interaction-words', theater: 'theater-scripts' })[input] || input;
  if (!RESOURCE_PACK_CATEGORIES.includes(category)) throw new Error('资源包分类无效');
  return category;
}

function cleanText(value, maximum) {
  return trimSlice(value, maximum);
}

async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.promises.rename(temporaryPath, filePath);
}

class ResourcePackStore {
  constructor(dataDirectory) {
    this.directory = path.join(path.resolve(dataDirectory), 'resource-packs');
    this.uploadsDirectory = path.join(path.resolve(dataDirectory), 'resource-pack-uploads');
    this.metadataPath = path.join(path.resolve(dataDirectory), 'resource-packs.json');
    this.data = { schemaVersion: 1, packs: [] };
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.uploadsDirectory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.metadataPath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.packs)) {
        throw new Error('资源包数据格式无效');
      }
      this.data = {
        schemaVersion: 1,
        packs: parsed.packs.map((item) => ({
          id: String(item.id || ''),
          category: normalizeCategory(item.category),
          title: cleanText(item.title, 80),
          description: cleanText(item.description, 600),
          fileName: path.basename(String(item.fileName || '')),
          originalName: path.basename(String(item.originalName || '')).slice(0, 160),
          size: Number(item.size),
          sha256: String(item.sha256 || '').toLowerCase(),
          createdAt: String(item.createdAt || ''),
          updatedAt: String(item.updatedAt || item.createdAt || ''),
          status: item.status === undefined ? 'published'
            : RESOURCE_PACK_STATUSES.includes(item.status) ? item.status : 'draft',
          version: String(item.version || '1.0.0'),
          installable: false, fileCount: 0, validationError: ''
        }))
      };
      // Legacy uploads only checked a ZIP signature. Validate every stored archive
      // before advertising it as installable; leave invalid metadata visible to admins.
      for (const pack of this.data.packs) {
        try {
          const filePath = this.filePath(pack);
          const stat = await fs.promises.stat(filePath);
          if (stat.size > 50 * 1024 * 1024 || stat.size !== pack.size) throw new Error('资源包大小与登记信息不符');
          const bytes = await fs.promises.readFile(filePath);
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== pack.sha256) throw new Error('资源包完整性校验失败');
          Object.assign(pack, validateResourcePackPackage(bytes, pack.category));
        } catch (error) {
          pack.validationError = error.code === 'ENOENT' ? '资源包文件不存在' : error.message;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicWriteJson(this.metadataPath, this.data);
    }
  }

  list() {
    return [...this.data.packs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  find(id) {
    return this.data.packs.find((item) => item.id === String(id || '')) || null;
  }

  uploadPath(uploadId) {
    return path.join(this.uploadsDirectory, `${uploadId}.part`);
  }

  filePath(pack) {
    return path.join(this.directory, pack.fileName);
  }

  async serializeMutation(action) {
    const pending = this.mutation.then(action, action);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  async commitUpload({ temporaryPath, category, title, description, originalName, size, sha256,
    status = 'published', version = '1.0.0', fileCount }) {
    return this.serializeMutation(async () => {
      const id = crypto.randomUUID();
      const pack = {
        id,
        category: normalizeCategory(category),
        title: cleanText(title, 80),
        description: cleanText(description, 600),
        fileName: `${id}.zip`,
        originalName: path.basename(String(originalName || 'resource-pack.zip')).slice(0, 160),
        size: Number(size),
        sha256: String(sha256).toLowerCase(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status, version, fileCount, installable: true, validationVersion: 1, validationError: ''
      };
      const finalPath = this.filePath(pack);
      await fs.promises.rename(temporaryPath, finalPath);
      this.data.packs.push(pack);
      try {
        await atomicWriteJson(this.metadataPath, this.data);
      } catch (error) {
        this.data.packs = this.data.packs.filter((item) => item !== pack);
        await fs.promises.rename(finalPath, temporaryPath).catch(() => {});
        throw error;
      }
      return pack;
    });
  }

  async update(id, patch) {
    return this.serializeMutation(async () => {
      const index = this.data.packs.findIndex(item => item.id === id);
      if (index < 0) throw new Error('资源包不存在');
      const previous = this.data.packs[index];
      const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
      if (next.category !== previous.category || next.status === 'published') {
        const bytes = await fs.promises.readFile(this.filePath(previous));
        if (bytes.length !== previous.size || crypto.createHash('sha256').update(bytes).digest('hex') !== previous.sha256) {
          throw new Error('资源包完整性校验失败，请重新上传');
        }
        Object.assign(next, validateResourcePackPackage(bytes, next.category), { validationError: '' });
      }
      this.data.packs[index] = next;
      try { await atomicWriteJson(this.metadataPath, this.data); }
      catch (error) { this.data.packs[index] = previous; throw error; }
      return next;
    });
  }

  async delete(id) {
    return this.serializeMutation(async () => {
      const index = this.data.packs.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('资源包不存在');
      const pack = this.data.packs[index];
      const finalPath = this.filePath(pack);
      const quarantinePath = `${finalPath}.deleting`;
      await fs.promises.rename(finalPath, quarantinePath);
      this.data.packs.splice(index, 1);
      try {
        await atomicWriteJson(this.metadataPath, this.data);
        await fs.promises.rm(quarantinePath, { force: true });
      } catch (error) {
        this.data.packs.splice(index, 0, pack);
        await fs.promises.rename(quarantinePath, finalPath).catch(() => {});
        throw error;
      }
      return pack;
    });
  }
}

module.exports = { RESOURCE_PACK_CATEGORIES, RESOURCE_PACK_STATUSES, ResourcePackStore, normalizeCategory };
