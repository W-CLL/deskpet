const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { InteractionStore } = require('../lib/interaction-store');

function event(type, fields = {}) {
  return {
    eventId: crypto.randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    ...fields
  };
}

test('interaction events are idempotent and isolated by account', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-interactions-'));
  const store = new InteractionStore(dataDirectory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  await store.initialize();

  const firstAccount = crypto.randomUUID();
  const secondAccount = crypto.randomUUID();
  const events = [
    event('mood_response', { mood: 'happy' }),
    event('joke_revealed', { contentId: 'joke:first' }),
    event('quiz_answered', { contentId: 'math:first', correct: true }),
    event('content_shown', { contentId: 'joke:first' })
  ];

  const first = store.recordEvents(firstAccount, events, {
    appVersion: '2.5.0',
    platform: 'windows'
  });
  assert.equal(first.accepted, 4);
  assert.equal(first.duplicates, 0);
  assert.deepEqual(first.summary, {
    totalInteractions: 3,
    moodResponses: 1,
    moodHappy: 1,
    moodOkay: 0,
    moodLow: 0,
    jokesRevealed: 1,
    quizzesAnswered: 1,
    quizzesCorrect: 1,
    contentShown: 1,
    firstInteractionAt: first.summary.firstInteractionAt,
    lastInteractionAt: first.summary.lastInteractionAt,
    updatedAt: first.summary.updatedAt
  });

  const retried = store.recordEvents(firstAccount, events);
  assert.equal(retried.accepted, 0);
  assert.equal(retried.duplicates, 4);
  assert.deepEqual(retried.summary, first.summary);

  const second = store.recordEvents(secondAccount, [
    event('mood_response', { mood: 'low' })
  ]);
  assert.equal(second.summary.totalInteractions, 1);
  assert.equal(second.summary.moodLow, 1);
  assert.equal(store.getAccount(firstAccount).summary.moodLow, 0);

  const contentHistory = store.recentContentIds(
    firstAccount,
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  );
  assert.deepEqual(contentHistory.map((item) => item.contentId), ['joke:first']);

  const updated = store.updateProfile(firstAccount, {
    mode: 'quiet',
    promptsEnabled: false
  });
  assert.equal(updated.profile.mode, 'quiet');
  assert.equal(updated.profile.promptsEnabled, false);

  const admin = store.listAll();
  assert.equal(admin.summary.accounts, 2);
  assert.equal(admin.summary.interactingAccounts, 2);
  assert.equal(admin.summary.totalInteractions, 4);
  assert.equal(admin.summary.moodHappy, 1);
  assert.equal(admin.summary.moodLow, 1);
  assert.equal(admin.accounts.length, 2);
  const firstAdminAccount = admin.accounts.find((item) => item.accountId === firstAccount);
  assert.equal(firstAdminAccount.profile.mode, 'quiet');
  assert.equal(firstAdminAccount.profile.promptsEnabled, false);

  store.database.prepare(`
    UPDATE interaction_events SET received_at = '2020-01-01T00:00:00.000Z'
    WHERE account_id = ?
  `).run(firstAccount);
  const pruned = store.pruneRawEvents();
  assert.equal(pruned.deleted, 4);
  const afterPruneRetry = store.recordEvents(firstAccount, events);
  assert.equal(afterPruneRetry.accepted, 0);
  assert.equal(afterPruneRetry.duplicates, 4);
  assert.equal(afterPruneRetry.summary.totalInteractions, 3);

  assert.equal(store.migrationState.currentVersion, 1);
  store.close();
  await store.initialize();
  assert.deepEqual(store.migrationState.applied, []);
  assert.equal(store.getAccount(firstAccount).summary.totalInteractions, 3);
});
