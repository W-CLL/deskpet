const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openMigratedDatabase } = require('./sqlite-migrations');
const { trimSlice } = require('./text');

const VISIT_STICKER_SCOPE = 'visit-stickers';
const VISIT_STICKER_CATEGORIES = Object.freeze(['girlfriend', 'friend', 'companion']);
const CATEGORY_LABELS = Object.freeze({
  girlfriend: '女友',
  friend: '好友',
  companion: '搭子'
});

const VISIT_STICKER_MIGRATIONS = [{
  version: 1,
  name: 'visit-sticker-catalog',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS visit_sticker_packs (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        original_name TEXT NOT NULL,
        sticker_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (category IN ('girlfriend', 'friend', 'companion'))
      );
      CREATE TABLE IF NOT EXISTS visit_stickers (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        category TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_name TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        disabled_at TEXT,
        FOREIGN KEY (pack_id) REFERENCES visit_sticker_packs(id) ON DELETE CASCADE,
        CHECK (category IN ('girlfriend', 'friend', 'companion'))
      );
      CREATE INDEX IF NOT EXISTS idx_visit_stickers_category
        ON visit_stickers(category, disabled_at, id);
    `);
  }
}];

function nowIso() {
  return new Date().toISOString();
}

function normalizeCategory(value) {
  const category = String(value || '').trim().toLowerCase();
  if (!VISIT_STICKER_CATEGORIES.includes(category)) throw new Error('来访表情分类无效');
  return category;
}

function categoryLabel(category) {
  return CATEGORY_LABELS[normalizeCategory(category)];
}

class VisitStickerStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.filesDirectory = path.join(this.dataDirectory, 'visit-stickers');
    this.uploadsDirectory = path.join(this.dataDirectory, 'visit-sticker-uploads');
  }

  async initialize() {
    const opened = await openMigratedDatabase({
      dataDirectory: this.dataDirectory,
      fileName: 'visit-stickers.db',
      scope: VISIT_STICKER_SCOPE,
      migrations: VISIT_STICKER_MIGRATIONS,
      foreignKeys: true,
      extraDirectories: [this.filesDirectory, this.uploadsDirectory]
    });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.migrationState = opened.migrationState;
  }

  close() {
    this.database?.close();
  }

  uploadPath(uploadId) {
    return path.join(this.uploadsDirectory, `${uploadId}.part`);
  }

  filePath(fileName) {
    return path.join(this.filesDirectory, path.basename(String(fileName || '')));
  }

  listPacks() {
    return this.database.prepare(`
      SELECT id, category, title, note, original_name AS originalName,
        sticker_count AS stickerCount, created_at AS createdAt
      FROM visit_sticker_packs
      ORDER BY created_at DESC, id DESC
    `).all();
  }

  listStickers({ category = '', packId = '' } = {}) {
    const filters = [];
    const values = [];
    if (category) {
      filters.push('s.category = ?');
      values.push(normalizeCategory(category));
    }
    if (packId) {
      filters.push('s.pack_id = ?');
      values.push(String(packId));
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT s.id, s.pack_id AS packId, s.category, s.original_name AS originalName,
        s.file_name AS fileName, s.size, s.sha256, s.width, s.height,
        s.created_at AS createdAt, s.disabled_at AS disabledAt,
        p.title AS packTitle
      FROM visit_stickers s
      JOIN visit_sticker_packs p ON p.id = s.pack_id
      ${where}
      ORDER BY s.created_at DESC, s.id DESC
    `).all(...values);
  }

  counts() {
    const rows = this.database.prepare(`
      SELECT category, COUNT(*) AS count
      FROM visit_stickers
      WHERE disabled_at IS NULL
      GROUP BY category
    `).all();
    const counts = Object.fromEntries(VISIT_STICKER_CATEGORIES.map((category) => [category, 0]));
    for (const row of rows) counts[row.category] = Number(row.count) || 0;
    return counts;
  }

  activeCount(category) {
    return Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM visit_stickers
      WHERE category = ? AND disabled_at IS NULL
    `).get(normalizeCategory(category))?.count || 0);
  }

  findActive(id) {
    return this.database.prepare(`
      SELECT id, pack_id AS packId, category, original_name AS originalName,
        file_name AS fileName, size, sha256, width, height, created_at AS createdAt
      FROM visit_stickers
      WHERE id = ? AND disabled_at IS NULL
    `).get(String(id || '')) || null;
  }

  pickRandom(category, { excludeId = '' } = {}) {
    const normalized = normalizeCategory(category);
    const excluded = excludeId ? this.findActive(excludeId) : null;
    if (excluded?.category === normalized) {
      const other = this.database.prepare(`
        SELECT id, pack_id AS packId, category, original_name AS originalName,
          file_name AS fileName, size, sha256, width, height, created_at AS createdAt
        FROM visit_stickers
        WHERE category = ? AND disabled_at IS NULL AND id <> ?
        ORDER BY RANDOM()
        LIMIT 1
      `).get(normalized, excluded.id);
      if (other) return other;
    }
    return this.database.prepare(`
      SELECT id, pack_id AS packId, category, original_name AS originalName,
        file_name AS fileName, size, sha256, width, height, created_at AS createdAt
      FROM visit_stickers
      WHERE category = ? AND disabled_at IS NULL
      ORDER BY RANDOM()
      LIMIT 1
    `).get(normalized) || null;
  }

  async commitPack({ category, title, note, originalName, stickers }) {
    const normalized = normalizeCategory(category);
    const packId = crypto.randomUUID();
    const createdAt = nowIso();
    const pack = {
      id: packId,
      category: normalized,
      title: trimSlice(title, 80),
      note: trimSlice(note, 600),
      originalName: path.basename(String(originalName || 'visit-stickers.zip')).slice(0, 160),
      stickerCount: stickers.length,
      createdAt
    };
    const written = [];
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO visit_sticker_packs
          (id, category, title, note, original_name, sticker_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        pack.id,
        pack.category,
        pack.title,
        pack.note,
        pack.originalName,
        pack.stickerCount,
        pack.createdAt
      );
      const insertSticker = this.database.prepare(`
        INSERT INTO visit_stickers
          (id, pack_id, category, original_name, file_name, size, sha256, width, height, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const sticker of stickers) {
        const id = crypto.randomUUID();
        const fileName = `${id}.gif`;
        const filePath = this.filePath(fileName);
        await fs.promises.writeFile(filePath, sticker.buffer, { flag: 'wx', mode: 0o600 });
        written.push(filePath);
        insertSticker.run(
          id,
          pack.id,
          pack.category,
          path.basename(String(sticker.originalName || 'sticker.gif')).slice(0, 160),
          fileName,
          sticker.size,
          sticker.sha256,
          sticker.width,
          sticker.height,
          createdAt
        );
      }
      this.database.exec('COMMIT');
      return pack;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      await Promise.all(written.map((filePath) => fs.promises.rm(filePath, { force: true })));
      throw error;
    }
  }

  async deletePack(id) {
    const pack = this.database.prepare(`
      SELECT id, category, title FROM visit_sticker_packs WHERE id = ?
    `).get(String(id || ''));
    if (!pack) throw new Error('来访表情包不存在');
    const files = this.database.prepare(`
      SELECT file_name AS fileName FROM visit_stickers WHERE pack_id = ?
    `).all(pack.id);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM visit_stickers WHERE pack_id = ?').run(pack.id);
      this.database.prepare('DELETE FROM visit_sticker_packs WHERE id = ?').run(pack.id);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    await Promise.all(files.map((item) => fs.promises.rm(this.filePath(item.fileName), { force: true })));
    return pack;
  }

  async deleteSticker(id) {
    const sticker = this.database.prepare(`
      SELECT id, pack_id AS packId, file_name AS fileName FROM visit_stickers WHERE id = ?
    `).get(String(id || ''));
    if (!sticker) throw new Error('来访表情不存在');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM visit_stickers WHERE id = ?').run(sticker.id);
      this.database.prepare(`
        UPDATE visit_sticker_packs
        SET sticker_count = (
          SELECT COUNT(*) FROM visit_stickers WHERE pack_id = ?
        )
        WHERE id = ?
      `).run(sticker.packId, sticker.packId);
      const remaining = this.database.prepare(`
        SELECT sticker_count AS stickerCount FROM visit_sticker_packs WHERE id = ?
      `).get(sticker.packId);
      if (!remaining || remaining.stickerCount <= 0) {
        this.database.prepare('DELETE FROM visit_sticker_packs WHERE id = ?').run(sticker.packId);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
    await fs.promises.rm(this.filePath(sticker.fileName), { force: true });
    return sticker;
  }
}

module.exports = {
  CATEGORY_LABELS,
  VISIT_STICKER_CATEGORIES,
  VisitStickerStore,
  categoryLabel,
  normalizeCategory
};
