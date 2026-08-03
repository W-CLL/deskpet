const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');

async function jsonResponse(response) {
  const payload = await response.json();
  return { response, payload };
}

test('authorized interaction APIs update profiles and deduplicate event batches', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-interactions-api-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('test admin password 123');
  await fs.promises.writeFile(
    path.join(dataDirectory, 'auth.json'),
    JSON.stringify(authRecord),
    { mode: 0o600 }
  );
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    dataDirectory,
    cookieSecure: false,
    signingPrivateKey: privateKey
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const denied = await jsonResponse(await fetch(`${baseUrl}/api/interactions/profile`));
  assert.equal(denied.response.status, 401);
  assert.equal(denied.payload.code, 'LICENSE_REQUIRED');

  const code = application.activationStore.createCodes({ count: 1 }).codes[0];
  const credential = crypto.randomBytes(32).toString('base64url');
  const activated = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential,
      appVersion: '2.5.0'
    })
  }));
  assert.equal(activated.response.status, 200);
  const authorization = `Bearer ${activated.payload.licenseId}.${credential}`;
  const licenseHeaders = {
    Authorization: authorization,
    'Content-Type': 'application/json',
    'X-DeskPet-Version': '2.5.0',
    'X-DeskPet-Platform': 'windows'
  };

  const profile = await jsonResponse(await fetch(`${baseUrl}/api/interactions/profile`, {
    headers: licenseHeaders
  }));
  assert.equal(profile.response.status, 200);
  assert.equal(profile.payload.profile.mode, 'standard');
  assert.equal(profile.payload.profile.promptsEnabled, true);
  assert.equal(profile.payload.summary.totalInteractions, 0);

  const invalidProfile = await jsonResponse(await fetch(`${baseUrl}/api/interactions/profile`, {
    method: 'PATCH',
    headers: licenseHeaders,
    body: JSON.stringify({ mode: 'constant' })
  }));
  assert.equal(invalidProfile.response.status, 400);
  assert.equal(invalidProfile.payload.code, 'INVALID_INTERACTION_MODE');

  const updatedProfile = await jsonResponse(await fetch(`${baseUrl}/api/interactions/profile`, {
    method: 'PATCH',
    headers: licenseHeaders,
    body: JSON.stringify({ mode: 'lively', promptsEnabled: false })
  }));
  assert.equal(updatedProfile.response.status, 200);
  assert.equal(updatedProfile.payload.profile.mode, 'lively');
  assert.equal(updatedProfile.payload.profile.promptsEnabled, false);

  const occurredAt = new Date().toISOString();
  const events = [
    { eventId: crypto.randomUUID(), type: 'mood_response', mood: 'happy', occurredAt },
    {
      eventId: crypto.randomUUID(),
      type: 'quiz_answered',
      contentId: 'math:answer-1',
      correct: false,
      occurredAt
    },
    {
      eventId: crypto.randomUUID(),
      type: 'content_shown',
      contentId: 'math:answer-1',
      occurredAt
    }
  ];
  const recorded = await jsonResponse(await fetch(`${baseUrl}/api/interactions/events`, {
    method: 'POST',
    headers: licenseHeaders,
    body: JSON.stringify({ events })
  }));
  assert.equal(recorded.response.status, 200);
  assert.equal(recorded.payload.accepted, 3);
  assert.equal(recorded.payload.duplicates, 0);
  assert.equal(recorded.payload.summary.totalInteractions, 2);
  assert.equal(recorded.payload.summary.moodHappy, 1);
  assert.equal(recorded.payload.summary.quizzesAnswered, 1);
  assert.equal(recorded.payload.summary.quizzesCorrect, 0);
  assert.equal(recorded.payload.summary.contentShown, 1);

  const retried = await jsonResponse(await fetch(`${baseUrl}/api/interactions/events`, {
    method: 'POST',
    headers: licenseHeaders,
    body: JSON.stringify({ events })
  }));
  assert.equal(retried.response.status, 200);
  assert.equal(retried.payload.accepted, 0);
  assert.equal(retried.payload.duplicates, 3);
  assert.equal(retried.payload.summary.totalInteractions, 2);

  const invalidEvent = await jsonResponse(await fetch(`${baseUrl}/api/interactions/events`, {
    method: 'POST',
    headers: licenseHeaders,
    body: JSON.stringify({ events: [{
      eventId: crypto.randomUUID(),
      type: 'daily_checkin',
      occurredAt
    }] })
  }));
  assert.equal(invalidEvent.response.status, 400);
  assert.equal(invalidEvent.payload.code, 'INVALID_INTERACTION_EVENT');

  const stats = await jsonResponse(await fetch(`${baseUrl}/api/interactions/stats`, {
    headers: licenseHeaders
  }));
  assert.equal(stats.response.status, 200);
  assert.equal(stats.payload.summary.totalInteractions, 2);

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const adminStats = await jsonResponse(await fetch(`${baseUrl}/api/admin/interactions`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(adminStats.response.status, 200);
  assert.equal(adminStats.payload.summary.accounts, 1);
  assert.equal(adminStats.payload.summary.interactingAccounts, 1);
  assert.equal(adminStats.payload.summary.totalInteractions, 2);
  assert.equal(adminStats.payload.accounts[0].accountId, activated.payload.accountId);
});
