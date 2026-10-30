const { openMigratedDatabase } = require('./sqlite-migrations');

const MIGRATIONS = [{ version: 1, name: 'oss-upload-history-and-download-links', up(db) {
  db.exec(`
    CREATE TABLE oss_uploads (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, architecture TEXT NOT NULL, version TEXT NOT NULL,
      bucket TEXT NOT NULL, endpoint TEXT NOT NULL, object_key TEXT NOT NULL, file_name TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL,
      etag TEXT, uploaded_at TEXT, updated_at TEXT NOT NULL, error_code TEXT,
      CHECK(status IN ('uploading','uploaded','failed'))
    );
    CREATE TABLE oss_upload_attempts (
      id INTEGER PRIMARY KEY, upload_id TEXT NOT NULL REFERENCES oss_uploads(id),
      started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error_code TEXT
    );
    CREATE INDEX idx_oss_attempts_upload ON oss_upload_attempts(upload_id, id);
    CREATE TABLE oss_download_links (
      upload_id TEXT NOT NULL REFERENCES oss_uploads(id), method TEXT NOT NULL,
      signing_context TEXT NOT NULL, url TEXT NOT NULL, expires_at INTEGER NOT NULL,
      refreshed_at TEXT NOT NULL, PRIMARY KEY(upload_id, method)
    );
  `);
}}];

class OssUploadStore {
  constructor(dataDirectory) { this.dataDirectory = dataDirectory; }
  async initialize() {
    const opened = await openMigratedDatabase({dataDirectory:this.dataDirectory,
      fileName:'oss-uploads.db', scope:'oss-uploads', migrations:MIGRATIONS, foreignKeys:true});
    Object.assign(this, opened);
  }
  close() { this.database?.close(); }
  get(id) {
    return this.database.prepare(`SELECT id, platform, architecture, version, bucket, endpoint,
      object_key AS objectKey, file_name AS fileName, size, sha256, status, etag,
      uploaded_at AS uploadedAt, updated_at AS updatedAt, error_code AS errorCode
      FROM oss_uploads WHERE id=?`).get(id) || null;
  }
  begin(record) {
    const db = this.database;
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO oss_uploads
        (id,platform,architecture,version,bucket,endpoint,object_key,file_name,size,sha256,status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'uploading',?) ON CONFLICT(id) DO UPDATE SET
        status='uploading',updated_at=excluded.updated_at,error_code=NULL`).run(
        record.id,record.platform,record.architecture,record.version,record.bucket,record.endpoint,
        record.objectKey,record.fileName,record.size,record.sha256,at);
      db.prepare('DELETE FROM oss_download_links WHERE upload_id=?').run(record.id);
      const attempt = db.prepare(`INSERT INTO oss_upload_attempts(upload_id,started_at,status)
        VALUES (?,?,'uploading')`).run(record.id,at);
      db.exec('COMMIT');
      return Number(attempt.lastInsertRowid);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  finish(id, attemptId, {etag = null, errorCode = null} = {}) {
    const at = new Date().toISOString();
    const status = errorCode ? 'failed' : 'uploaded';
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`UPDATE oss_uploads SET status=?,etag=?,uploaded_at=?,updated_at=?,error_code=? WHERE id=?`)
        .run(status,etag,errorCode ? null : at,at,errorCode,id);
      this.database.prepare(`UPDATE oss_upload_attempts SET status=?,finished_at=?,error_code=? WHERE id=?`)
        .run(status,at,errorCode,attemptId);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  attempts(id) {
    return this.database.prepare(`SELECT id, started_at AS startedAt, finished_at AS finishedAt,
      status,error_code AS errorCode FROM oss_upload_attempts WHERE upload_id=? ORDER BY id DESC LIMIT 20`).all(id);
  }
  link(id, method) {
    return this.database.prepare(`SELECT url,signing_context AS signingContext,expires_at AS expiresAt,
      refreshed_at AS refreshedAt FROM oss_download_links WHERE upload_id=? AND method=?`).get(id,method);
  }
  saveLink(id, method, signingContext, url, expiresAt) {
    this.database.prepare(`INSERT INTO oss_download_links VALUES(?,?,?,?,?,?) ON CONFLICT(upload_id,method)
      DO UPDATE SET signing_context=excluded.signing_context,url=excluded.url,
      expires_at=excluded.expires_at,refreshed_at=excluded.refreshed_at`)
      .run(id,method,signingContext,url,expiresAt,new Date().toISOString());
  }
}
module.exports = { OssUploadStore };
