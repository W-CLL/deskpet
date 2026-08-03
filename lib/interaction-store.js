const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('./sqlite-migrations');

const INTERACTION_MODES = Object.freeze(['quiet', 'standard', 'lively']);
const INTERACTION_EVENT_TYPES = Object.freeze([
  'mood_response',
  'joke_revealed',
  'quiz_answered',
  'content_shown'
]);
const MOOD_VALUES = Object.freeze(['happy', 'okay', 'low']);
const INTERACTION_MIGRATION_SCOPE = 'interaction';
const RAW_EVENT_RETENTION_DAYS = 90;

const INTERACTION_MIGRATIONS = [
  {
    version: 1,
    name: 'interaction-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS interaction_profiles (
          account_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'standard'
            CHECK (mode IN ('quiet', 'standard', 'lively')),
          prompts_enabled INTEGER NOT NULL DEFAULT 1
            CHECK (prompts_enabled IN (0, 1)),
          last_interaction_at TEXT,
          last_mood_response_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS interaction_summaries (
          account_id TEXT PRIMARY KEY,
          total_interactions INTEGER NOT NULL DEFAULT 0,
          mood_responses INTEGER NOT NULL DEFAULT 0,
          mood_happy INTEGER NOT NULL DEFAULT 0,
          mood_okay INTEGER NOT NULL DEFAULT 0,
          mood_low INTEGER NOT NULL DEFAULT 0,
          jokes_revealed INTEGER NOT NULL DEFAULT 0,
          quizzes_answered INTEGER NOT NULL DEFAULT 0,
          quizzes_correct INTEGER NOT NULL DEFAULT 0,
          content_shown INTEGER NOT NULL DEFAULT 0,
          first_interaction_at TEXT,
          last_interaction_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS interaction_event_receipts (
          event_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS interaction_events (
          event_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          event_type TEXT NOT NULL
            CHECK (event_type IN ('mood_response', 'joke_revealed', 'quiz_answered', 'content_shown')),
          mood TEXT CHECK (mood IS NULL OR mood IN ('happy', 'okay', 'low')),
          content_id TEXT,
          is_correct INTEGER CHECK (is_correct IS NULL OR is_correct IN (0, 1)),
          occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          app_version TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (event_id) REFERENCES interaction_event_receipts(event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_interaction_events_account_occurred
          ON interaction_events(account_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_interaction_events_content
          ON interaction_events(account_id, content_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_interaction_events_received
          ON interaction_events(received_at);
        CREATE INDEX IF NOT EXISTS idx_interaction_receipts_account
          ON interaction_event_receipts(account_id, received_at DESC);
      `);
    }
  }
];

function nowIso() {
  return new Date().toISOString();
}

function mapSummary(row = {}) {
  return {
    totalInteractions: Number(row.total_interactions || 0),
    moodResponses: Number(row.mood_responses || 0),
    moodHappy: Number(row.mood_happy || 0),
    moodOkay: Number(row.mood_okay || 0),
    moodLow: Number(row.mood_low || 0),
    jokesRevealed: Number(row.jokes_revealed || 0),
    quizzesAnswered: Number(row.quizzes_answered || 0),
    quizzesCorrect: Number(row.quizzes_correct || 0),
    contentShown: Number(row.content_shown || 0),
    firstInteractionAt: row.first_interaction_at || null,
    lastInteractionAt: row.last_interaction_at || null,
    updatedAt: row.updated_at || null
  };
}

function mapProfile(row) {
  return {
    mode: row.mode,
    promptsEnabled: row.prompts_enabled === 1,
    lastInteractionAt: row.last_interaction_at || null,
    lastMoodResponseAt: row.last_mood_response_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function earlier(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}

function later(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

class InteractionStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = path.join(this.dataDirectory, 'interaction.db');
    this.database = null;
    this.migrationState = null;
  }

  async initialize() {
    await fs.promises.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrationState = applyMigrations(
      this.database,
      INTERACTION_MIGRATION_SCOPE,
      INTERACTION_MIGRATIONS
    );
  }

  ensureAccount(accountId, createdAt = nowIso()) {
    this.database.prepare(`
      INSERT OR IGNORE INTO interaction_profiles
        (account_id, mode, prompts_enabled, created_at, updated_at)
      VALUES (?, 'standard', 1, ?, ?)
    `).run(accountId, createdAt, createdAt);
    this.database.prepare(`
      INSERT OR IGNORE INTO interaction_summaries (account_id, updated_at)
      VALUES (?, ?)
    `).run(accountId, createdAt);
  }

  getAccount(accountId) {
    this.ensureAccount(accountId);
    const profile = this.database.prepare(`
      SELECT * FROM interaction_profiles WHERE account_id = ?
    `).get(accountId);
    const summary = this.database.prepare(`
      SELECT * FROM interaction_summaries WHERE account_id = ?
    `).get(accountId);
    return { profile: mapProfile(profile), summary: mapSummary(summary) };
  }

  updateProfile(accountId, { mode, promptsEnabled }) {
    const current = this.getAccount(accountId).profile;
    const updatedAt = nowIso();
    this.database.prepare(`
      UPDATE interaction_profiles
      SET mode = ?, prompts_enabled = ?, updated_at = ?
      WHERE account_id = ?
    `).run(
      mode ?? current.mode,
      promptsEnabled === undefined ? Number(current.promptsEnabled) : Number(promptsEnabled),
      updatedAt,
      accountId
    );
    return this.getAccount(accountId);
  }

  recordEvents(accountId, events, { appVersion = '', platform = '' } = {}) {
    const receivedAt = nowIso();
    const insertReceipt = this.database.prepare(`
      INSERT OR IGNORE INTO interaction_event_receipts (event_id, account_id, received_at)
      VALUES (?, ?, ?)
    `);
    const insertEvent = this.database.prepare(`
      INSERT INTO interaction_events
        (event_id, account_id, event_type, mood, content_id, is_correct,
         occurred_at, received_at, app_version, platform)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const delta = {
      total: 0,
      mood: 0,
      happy: 0,
      okay: 0,
      low: 0,
      jokes: 0,
      quizzes: 0,
      correct: 0,
      shown: 0,
      firstInteractionAt: null,
      lastInteractionAt: null,
      lastMoodResponseAt: null
    };
    let accepted = 0;
    let duplicates = 0;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.ensureAccount(accountId, receivedAt);
      for (const event of events) {
        const receipt = insertReceipt.run(event.eventId, accountId, receivedAt);
        if (receipt.changes !== 1) {
          duplicates += 1;
          continue;
        }
        insertEvent.run(
          event.eventId,
          accountId,
          event.type,
          event.mood || null,
          event.contentId || null,
          event.correct === undefined ? null : Number(event.correct),
          event.occurredAt,
          receivedAt,
          appVersion,
          platform
        );
        accepted += 1;

        const completed = event.type !== 'content_shown';
        if (completed) {
          delta.total += 1;
          delta.firstInteractionAt = earlier(delta.firstInteractionAt, event.occurredAt);
          delta.lastInteractionAt = later(delta.lastInteractionAt, event.occurredAt);
        }
        if (event.type === 'mood_response') {
          delta.mood += 1;
          delta[event.mood] += 1;
          delta.lastMoodResponseAt = later(delta.lastMoodResponseAt, event.occurredAt);
        } else if (event.type === 'joke_revealed') {
          delta.jokes += 1;
        } else if (event.type === 'quiz_answered') {
          delta.quizzes += 1;
          if (event.correct) delta.correct += 1;
        } else if (event.type === 'content_shown') {
          delta.shown += 1;
        }
      }

      if (accepted > 0) {
        const current = this.database.prepare(`
          SELECT * FROM interaction_summaries WHERE account_id = ?
        `).get(accountId);
        const firstInteractionAt = earlier(current.first_interaction_at, delta.firstInteractionAt);
        const lastInteractionAt = later(current.last_interaction_at, delta.lastInteractionAt);
        this.database.prepare(`
          UPDATE interaction_summaries SET
            total_interactions = total_interactions + ?,
            mood_responses = mood_responses + ?,
            mood_happy = mood_happy + ?,
            mood_okay = mood_okay + ?,
            mood_low = mood_low + ?,
            jokes_revealed = jokes_revealed + ?,
            quizzes_answered = quizzes_answered + ?,
            quizzes_correct = quizzes_correct + ?,
            content_shown = content_shown + ?,
            first_interaction_at = ?,
            last_interaction_at = ?,
            updated_at = ?
          WHERE account_id = ?
        `).run(
          delta.total,
          delta.mood,
          delta.happy,
          delta.okay,
          delta.low,
          delta.jokes,
          delta.quizzes,
          delta.correct,
          delta.shown,
          firstInteractionAt,
          lastInteractionAt,
          receivedAt,
          accountId
        );

        const profile = this.database.prepare(`
          SELECT last_interaction_at, last_mood_response_at
          FROM interaction_profiles WHERE account_id = ?
        `).get(accountId);
        this.database.prepare(`
          UPDATE interaction_profiles
          SET last_interaction_at = ?, last_mood_response_at = ?, updated_at = ?
          WHERE account_id = ?
        `).run(
          later(profile.last_interaction_at, delta.lastInteractionAt),
          later(profile.last_mood_response_at, delta.lastMoodResponseAt),
          receivedAt,
          accountId
        );
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { }
      throw error;
    }

    return {
      accepted,
      duplicates,
      receivedAt,
      summary: this.getAccount(accountId).summary
    };
  }

  recentContentIds(accountId, since, limit = 500) {
    return this.database.prepare(`
      SELECT content_id, MAX(occurred_at) AS last_shown_at
      FROM interaction_events
      WHERE account_id = ? AND event_type = 'content_shown'
        AND content_id IS NOT NULL AND occurred_at >= ?
      GROUP BY content_id
      ORDER BY last_shown_at DESC
      LIMIT ?
    `).all(accountId, since, limit).map((row) => ({
      contentId: row.content_id,
      lastShownAt: row.last_shown_at
    }));
  }

  listAll(limit = 1000) {
    const rows = this.database.prepare(`
      SELECT p.account_id, p.mode, p.prompts_enabled,
        p.last_interaction_at AS profile_last_interaction_at,
        p.last_mood_response_at, p.created_at AS profile_created_at,
        p.updated_at AS profile_updated_at,
        s.total_interactions, s.mood_responses, s.mood_happy, s.mood_okay,
        s.mood_low, s.jokes_revealed, s.quizzes_answered, s.quizzes_correct,
        s.content_shown, s.first_interaction_at, s.last_interaction_at,
        s.updated_at
      FROM interaction_profiles p
      JOIN interaction_summaries s ON s.account_id = p.account_id
      ORDER BY COALESCE(s.last_interaction_at, p.updated_at) DESC, p.account_id
      LIMIT ?
    `).all(limit);
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS accounts,
        SUM(CASE WHEN total_interactions > 0 THEN 1 ELSE 0 END) AS interacting_accounts,
        SUM(total_interactions) AS total_interactions,
        SUM(mood_responses) AS mood_responses,
        SUM(mood_happy) AS mood_happy,
        SUM(mood_okay) AS mood_okay,
        SUM(mood_low) AS mood_low,
        SUM(jokes_revealed) AS jokes_revealed,
        SUM(quizzes_answered) AS quizzes_answered,
        SUM(quizzes_correct) AS quizzes_correct,
        SUM(content_shown) AS content_shown,
        MIN(first_interaction_at) AS first_interaction_at,
        MAX(last_interaction_at) AS last_interaction_at,
        MAX(updated_at) AS updated_at
      FROM interaction_summaries
    `).get();
    return {
      summary: {
        accounts: Number(totals.accounts || 0),
        interactingAccounts: Number(totals.interacting_accounts || 0),
        ...mapSummary(totals)
      },
      accounts: rows.map((row) => ({
        accountId: row.account_id,
        accountSuffix: String(row.account_id).slice(-8),
        profile: mapProfile({
          mode: row.mode,
          prompts_enabled: row.prompts_enabled,
          last_interaction_at: row.profile_last_interaction_at,
          last_mood_response_at: row.last_mood_response_at,
          created_at: row.profile_created_at,
          updated_at: row.profile_updated_at
        }),
        summary: mapSummary(row)
      }))
    };
  }

  pruneRawEvents(retentionDays = RAW_EVENT_RETENTION_DAYS) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.database.prepare(`
      DELETE FROM interaction_events WHERE received_at < ?
    `).run(cutoff);
    return { deleted: Number(result.changes), cutoff };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.migrationState = null;
  }
}

module.exports = {
  INTERACTION_EVENT_TYPES,
  INTERACTION_MODES,
  InteractionStore,
  MOOD_VALUES,
  RAW_EVENT_RETENTION_DAYS
};
