const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function nowIso() {
  return new Date().toISOString();
}

async function openMigratedDatabase({
  dataDirectory,
  fileName,
  scope,
  migrations,
  foreignKeys = false,
  extraDirectories = []
}) {
  await fs.promises.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  for (const directory of extraDirectories) {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const databasePath = path.join(path.resolve(dataDirectory), fileName);
  const database = new DatabaseSync(databasePath);
  const pragmas = [
    'PRAGMA journal_mode = WAL;',
    foreignKeys ? 'PRAGMA foreign_keys = ON;' : '',
    'PRAGMA busy_timeout = 5000;'
  ].filter(Boolean).join('\n');
  database.exec(pragmas);

  return {
    database,
    databasePath,
    migrationState: applyMigrations(database, scope, migrations)
  };
}

function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (scope, version)
    )
  `);
}

function appliedMigrations(database, scope) {
  return new Map(database.prepare(`
    SELECT version, name FROM schema_migrations WHERE scope = ? ORDER BY version
  `).all(scope).map((row) => [Number(row.version), row.name]));
}

function applyMigrations(database, scope, migrations) {
  ensureMigrationTable(database);
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  let previousVersion = 0;

  for (const migration of ordered) {
    if (!Number.isSafeInteger(migration.version) || migration.version !== previousVersion + 1) {
      throw new Error(`数据库迁移版本无效：${scope}/${migration.version}`);
    }
    if (!migration.name || typeof migration.up !== 'function') {
      throw new Error(`数据库迁移定义无效：${scope}/${migration.version}`);
    }
    previousVersion = migration.version;
  }

  const applied = appliedMigrations(database, scope);
  const definitions = new Map(ordered.map((migration) => [migration.version, migration.name]));
  for (const [version, name] of applied) {
    if (!definitions.has(version)) {
      throw new Error(`数据库版本高于当前代码：${scope}/${version}`);
    }
    if (definitions.get(version) !== name) {
      throw new Error(`数据库迁移记录与当前代码不一致：${scope}/${version}`);
    }
  }

  const newlyApplied = [];
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;

    database.exec('BEGIN IMMEDIATE');
    try {
      migration.up(database);
      database.prepare(`
        INSERT INTO schema_migrations (scope, version, name, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(scope, migration.version, migration.name, nowIso());
      database.exec('COMMIT');
      newlyApplied.push({ version: migration.version, name: migration.name });
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { }
      throw new Error(
        `数据库迁移失败：${scope}/${migration.version} ${migration.name}: ${error.message}`,
        { cause: error }
      );
    }
  }

  return {
    applied: newlyApplied,
    currentVersion: ordered.at(-1)?.version || 0
  };
}

module.exports = { applyMigrations, openMigratedDatabase };
