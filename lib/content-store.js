const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('./sqlite-migrations');

const CONTENT_TYPES = Object.freeze(['joke', 'math', 'trivia']);
const CONTENT_MIGRATION_SCOPE = 'content';

const CONTENT_MIGRATIONS = [
  {
    version: 1,
    name: 'content-catalog-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS content_catalog (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('joke', 'math', 'trivia')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          prompt TEXT NOT NULL,
          answer TEXT NOT NULL,
          explanation TEXT NOT NULL DEFAULT '',
          choices_json TEXT NOT NULL DEFAULT '[]',
          tags_json TEXT NOT NULL DEFAULT '[]',
          difficulty INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
          locale TEXT NOT NULL DEFAULT 'zh-CN',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_content_items_status_type
          ON content_items(status, type, updated_at DESC);
        INSERT OR IGNORE INTO content_catalog (id, version, updated_at)
          VALUES (1, 0, '1970-01-01T00:00:00.000Z');
      `);
    }
  }
];

function nowIso() {
  return new Date().toISOString();
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapContent(row, includeAdminFields = false) {
  const item = {
    id: row.id,
    type: row.type,
    revision: Number(row.revision),
    prompt: row.prompt,
    answer: row.answer,
    explanation: row.explanation,
    choices: parseArray(row.choices_json),
    tags: parseArray(row.tags_json),
    difficulty: Number(row.difficulty),
    locale: row.locale
  };
  if (includeAdminFields) {
    item.active = row.status === 'active';
    item.createdAt = row.created_at;
    item.updatedAt = row.updated_at;
  }
  return item;
}

function sameContent(existing, item) {
  return existing.type === item.type
    && existing.prompt === item.prompt
    && existing.answer === item.answer
    && existing.explanation === item.explanation
    && existing.choices_json === JSON.stringify(item.choices)
    && existing.tags_json === JSON.stringify(item.tags)
    && Number(existing.difficulty) === item.difficulty
    && existing.locale === item.locale
    && existing.status === (item.active ? 'active' : 'disabled');
}

class ContentStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'content.db');
    this.database = null;
    this.migrationState = null;
  }

  async initialize() {
    await fs.promises.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrationState = applyMigrations(
      this.database,
      CONTENT_MIGRATION_SCOPE,
      CONTENT_MIGRATIONS
    );
  }

  catalog() {
    const row = this.database.prepare(`
      SELECT version, updated_at FROM content_catalog WHERE id = 1
    `).get();
    return { version: Number(row.version), updatedAt: row.updated_at };
  }

  bumpCatalog(updatedAt = nowIso()) {
    this.database.prepare(`
      UPDATE content_catalog SET version = version + 1, updated_at = ? WHERE id = 1
    `).run(updatedAt);
    return this.catalog();
  }

  get(id) {
    const row = this.database.prepare('SELECT * FROM content_items WHERE id = ?').get(id);
    return row ? mapContent(row, true) : null;
  }

  create(item) {
    const id = item.id || crypto.randomUUID();
    const createdAt = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO content_items
          (id, type, revision, prompt, answer, explanation, choices_json,
           tags_json, difficulty, locale, status, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        item.type,
        item.prompt,
        item.answer,
        item.explanation,
        JSON.stringify(item.choices),
        JSON.stringify(item.tags),
        item.difficulty,
        item.locale,
        item.active ? 'active' : 'disabled',
        createdAt,
        createdAt
      );
      const catalog = this.bumpCatalog(createdAt);
      this.database.exec('COMMIT');
      return { item: this.get(id), catalog };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  update(id, item) {
    const updatedAt = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database.prepare('SELECT * FROM content_items WHERE id = ?').get(id);
      if (!existing) {
        this.database.exec('ROLLBACK');
        return null;
      }
      if (sameContent(existing, item)) {
        this.database.exec('COMMIT');
        return { item: mapContent(existing, true), catalog: this.catalog(), changed: false };
      }
      this.database.prepare(`
        UPDATE content_items SET
          type = ?, revision = revision + 1, prompt = ?, answer = ?, explanation = ?,
          choices_json = ?, tags_json = ?, difficulty = ?, locale = ?, status = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        item.type,
        item.prompt,
        item.answer,
        item.explanation,
        JSON.stringify(item.choices),
        JSON.stringify(item.tags),
        item.difficulty,
        item.locale,
        item.active ? 'active' : 'disabled',
        updatedAt,
        id
      );
      const catalog = this.bumpCatalog(updatedAt);
      this.database.exec('COMMIT');
      return { item: this.get(id), catalog, changed: true };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  importItems(items, { disableMissing = false } = {}) {
    const importedAt = nowIso();
    const importedIds = new Set();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let disabled = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        importedIds.add(item.id);
        const existing = this.database.prepare('SELECT * FROM content_items WHERE id = ?').get(item.id);
        if (!existing) {
          this.database.prepare(`
            INSERT INTO content_items
              (id, type, revision, prompt, answer, explanation, choices_json,
               tags_json, difficulty, locale, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            item.id,
            item.type,
            item.revision || 1,
            item.prompt,
            item.answer,
            item.explanation,
            JSON.stringify(item.choices),
            JSON.stringify(item.tags),
            item.difficulty,
            item.locale,
            item.active ? 'active' : 'disabled',
            importedAt,
            importedAt
          );
          created += 1;
          continue;
        }
        if (item.revision && item.revision < Number(existing.revision)) {
          skipped += 1;
          continue;
        }
        if (sameContent(existing, item)) {
          skipped += 1;
          continue;
        }
        const nextRevision = item.revision && item.revision > Number(existing.revision)
          ? item.revision
          : Number(existing.revision) + 1;
        this.database.prepare(`
          UPDATE content_items SET
            type = ?, revision = ?, prompt = ?, answer = ?, explanation = ?,
            choices_json = ?, tags_json = ?, difficulty = ?, locale = ?, status = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          item.type,
          nextRevision,
          item.prompt,
          item.answer,
          item.explanation,
          JSON.stringify(item.choices),
          JSON.stringify(item.tags),
          item.difficulty,
          item.locale,
          item.active ? 'active' : 'disabled',
          importedAt,
          item.id
        );
        updated += 1;
      }

      if (disableMissing) {
        const activeRows = this.database.prepare(`
          SELECT id FROM content_items WHERE status = 'active'
        `).all();
        const disable = this.database.prepare(`
          UPDATE content_items
          SET status = 'disabled', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'active'
        `);
        for (const row of activeRows) {
          if (importedIds.has(row.id)) continue;
          disabled += Number(disable.run(importedAt, row.id).changes);
        }
      }

      const changed = created + updated + disabled > 0;
      const catalog = changed ? this.bumpCatalog(importedAt) : this.catalog();
      this.database.exec('COMMIT');
      return { created, updated, skipped, disabled, changed, catalog };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  selectBatch(types, excludedIds, limit) {
    const excluded = [...new Set(excludedIds)];
    const placeholders = excluded.map(() => '?').join(', ');
    const exclusions = placeholders ? `AND id NOT IN (${placeholders})` : '';
    const perType = new Map();
    for (const type of types) {
      const rows = this.database.prepare(`
        SELECT * FROM content_items
        WHERE status = 'active' AND type = ? ${exclusions}
        ORDER BY RANDOM()
        LIMIT ?
      `).all(type, ...excluded, limit);
      perType.set(type, rows);
    }

    const selected = [];
    let index = 0;
    while (selected.length < limit) {
      let added = false;
      for (const type of types) {
        const row = perType.get(type)[index];
        if (!row) continue;
        selected.push(row);
        added = true;
        if (selected.length === limit) break;
      }
      if (!added) break;
      index += 1;
    }
    return selected.map((row) => mapContent(row));
  }

  activeItems() {
    return this.database.prepare(`
      SELECT * FROM content_items WHERE status = 'active' ORDER BY type, id
    `).all().map((row) => mapContent(row));
  }

  disabledIds() {
    return this.database.prepare(`
      SELECT id FROM content_items WHERE status = 'disabled' ORDER BY id
    `).all().map((row) => row.id);
  }

  listAll() {
    const rows = this.database.prepare(`
      SELECT * FROM content_items ORDER BY updated_at DESC, id
    `).all();
    const counts = this.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
        SUM(CASE WHEN type = 'joke' AND status = 'active' THEN 1 ELSE 0 END) AS jokes,
        SUM(CASE WHEN type = 'math' AND status = 'active' THEN 1 ELSE 0 END) AS math,
        SUM(CASE WHEN type = 'trivia' AND status = 'active' THEN 1 ELSE 0 END) AS trivia
      FROM content_items
    `).get();
    return {
      catalog: this.catalog(),
      summary: {
        total: Number(counts.total || 0),
        active: Number(counts.active || 0),
        disabled: Number(counts.disabled || 0),
        jokes: Number(counts.jokes || 0),
        math: Number(counts.math || 0),
        trivia: Number(counts.trivia || 0)
      },
      items: rows.map((row) => mapContent(row, true))
    };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.migrationState = null;
  }
}

module.exports = { CONTENT_TYPES, ContentStore };
