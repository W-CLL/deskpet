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
  return { response, payload: await response.json() };
}

async function activate(application, baseUrl) {
  const code = application.activationStore.createCodes({ count: 1 }).codes[0];
  const credential = crypto.randomBytes(32).toString('base64url');
  const activated = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential,
      appVersion: '3.1.0'
    })
  }));
  assert.equal(activated.response.status, 200);
  return {
    accountId: activated.payload.accountId,
    headers: {
      Authorization: `Bearer ${activated.payload.licenseId}.${credential}`,
      'X-DeskPet-Version': '3.1.0',
      'X-DeskPet-Platform': 'windows'
    }
  };
}

test('two accounts pair and deliver an uploaded GIF once', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-companion-api-'));
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
    signingPrivateKey: privateKey,
    companionOptions: { cooldownMs: 30_000 }
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const trialInstallationId = crypto.randomBytes(16).toString('hex');
  const trialCredential = crypto.randomBytes(32).toString('base64url');
  await fetch(`${baseUrl}/api/trial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      installationId: trialInstallationId,
      credential: trialCredential,
      appVersion: '3.1.0'
    })
  });
  const trialDenied = await jsonResponse(await fetch(`${baseUrl}/api/companion`, {
    headers: { Authorization: `Trial ${trialInstallationId}.${trialCredential}` }
  }));
  assert.equal(trialDenied.response.status, 403);
  assert.equal(trialDenied.payload.code, 'COMPANION_ACTIVATION_REQUIRED');

  const first = await activate(application, baseUrl);
  const second = await activate(application, baseUrl);
  const firstJsonHeaders = { ...first.headers, 'Content-Type': 'application/json' };
  const secondJsonHeaders = { ...second.headers, 'Content-Type': 'application/json' };

  const firstProfile = await jsonResponse(await fetch(`${baseUrl}/api/companion`, {
    headers: first.headers
  }));
  const secondProfile = await jsonResponse(await fetch(`${baseUrl}/api/companion`, {
    headers: second.headers
  }));
  assert.match(firstProfile.payload.pairingCode, /^[23456789A-HJ-NP-Z]{8}$/);
  assert.equal(firstProfile.payload.partner, null);

  await fetch(`${baseUrl}/api/companion`, {
    method: 'PATCH',
    headers: firstJsonHeaders,
    body: JSON.stringify({ displayName: '小明' })
  });
  await fetch(`${baseUrl}/api/companion`, {
    method: 'PATCH',
    headers: secondJsonHeaders,
    body: JSON.stringify({ displayName: '小夏' })
  });
  const paired = await jsonResponse(await fetch(`${baseUrl}/api/companion/pair`, {
    method: 'POST',
    headers: firstJsonHeaders,
    body: JSON.stringify({ code: secondProfile.payload.pairingCode })
  }));
  assert.equal(paired.response.status, 200);
  assert.equal(paired.payload.partner.displayName, '小夏');

  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const sent = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    method: 'POST',
    headers: { ...first.headers, 'Content-Type': 'image/gif' },
    body: gif
  }));
  assert.equal(sent.response.status, 201);
  assert.equal(sent.payload.recipientName, '小夏');

  const pending = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: second.headers
  }));
  assert.equal(pending.payload.deliveries.length, 1);
  assert.equal(pending.payload.deliveries[0].senderName, '小明');
  assert.equal(pending.payload.deliveries[0].width, 1);

  const downloaded = await fetch(`${baseUrl}${pending.payload.deliveries[0].downloadPath}`, {
    headers: second.headers
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), gif);

  const acknowledged = await jsonResponse(await fetch(
    `${baseUrl}/api/companion/deliveries/${sent.payload.id}/acknowledge`,
    { method: 'POST', headers: second.headers }
  ));
  assert.equal(acknowledged.response.status, 200);
  const empty = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: second.headers
  }));
  assert.deepEqual(empty.payload.deliveries, []);

  const expiring = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    method: 'POST',
    headers: { ...second.headers, 'Content-Type': 'image/gif' },
    body: gif
  }));
  assert.equal(expiring.response.status, 201);
  application.companionStore.database.prepare(`
    UPDATE companion_deliveries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
  `).run(expiring.payload.id);
  await application.services.companionService.cleanup();

  const unauthenticatedStats = await jsonResponse(await fetch(`${baseUrl}/api/admin/companions`));
  assert.equal(unauthenticatedStats.response.status, 401);
  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const adminStats = await jsonResponse(await fetch(`${baseUrl}/api/admin/companions`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(adminStats.response.status, 200);
  assert.deepEqual(adminStats.payload.summary, {
    profiles: 2,
    activePairs: 1,
    sent: 2,
    received: 1,
    pending: 0,
    expired: 1,
    receiptRate: 0.5,
    storageBytes: gif.length
  });
  assert.equal(adminStats.payload.daily.length, 1);
  assert.deepEqual(
    Object.fromEntries(['sent', 'received', 'expired'].map((key) => [key, adminStats.payload.daily[0][key]])),
    { sent: 2, received: 1, expired: 1 }
  );
  assert.equal('deliveries' in adminStats.payload, false);

  const tooFast = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    method: 'POST',
    headers: { ...first.headers, 'Content-Type': 'image/gif' },
    body: gif
  }));
  assert.equal(tooFast.response.status, 429);
  assert.equal(tooFast.payload.code, 'COMPANION_RATE_LIMITED');

  const unpaired = await jsonResponse(await fetch(`${baseUrl}/api/companion/pair`, {
    method: 'DELETE',
    headers: first.headers
  }));
  assert.equal(unpaired.payload.partner, null);
});

async function activateWithCode(baseUrl, code, platform = 'windows') {
  const credential = crypto.randomBytes(32).toString('base64url');
  const activated = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DeskPet-Platform': platform },
    body: JSON.stringify({
      code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential,
      appVersion: '3.1.9'
    })
  }));
  assert.equal(activated.response.status, 200);
  return {
    accountId: activated.payload.accountId,
    licenseId: activated.payload.licenseId,
    deviceCount: activated.payload.deviceCount,
    headers: {
      Authorization: `Bearer ${activated.payload.licenseId}.${credential}`,
      'X-DeskPet-Version': '3.1.9',
      'X-DeskPet-Platform': platform
    }
  };
}

test('two devices on one account each receive the same companion visit', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-companion-two-devices-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    dataDirectory,
    cookieSecure: false,
    signingPrivateKey: privateKey,
    companionOptions: { cooldownMs: 0, maxPending: 1 }
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const senderCode = application.activationStore.createCodes({ count: 1 }).codes[0];
  const recipientCode = application.activationStore.createCodes({ count: 1 }).codes[0];
  const sender = await activateWithCode(baseUrl, senderCode, 'windows');
  const recipientDesktop = await activateWithCode(baseUrl, recipientCode, 'windows');
  const recipientPhone = await activateWithCode(baseUrl, recipientCode, 'android');
  assert.equal(recipientPhone.accountId, recipientDesktop.accountId);
  assert.equal(recipientPhone.deviceCount, 2);

  const recipientProfile = await jsonResponse(await fetch(`${baseUrl}/api/companion`, {
    headers: recipientDesktop.headers
  }));
  const phoneProfile = await jsonResponse(await fetch(`${baseUrl}/api/companion`, {
    headers: recipientPhone.headers
  }));
  assert.equal(phoneProfile.payload.pairingCode, recipientProfile.payload.pairingCode);

  await fetch(`${baseUrl}/api/companion/pair`, {
    method: 'POST',
    headers: { ...sender.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: recipientProfile.payload.pairingCode })
  });

  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const sent = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    method: 'POST',
    headers: { ...sender.headers, 'Content-Type': 'image/gif' },
    body: gif
  }));
  assert.equal(sent.response.status, 201);

  const desktopPending = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: recipientDesktop.headers
  }));
  const phonePending = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: recipientPhone.headers
  }));
  assert.equal(desktopPending.payload.deliveries.length, 1);
  assert.equal(phonePending.payload.deliveries.length, 1);
  assert.equal(phonePending.payload.deliveries[0].id, desktopPending.payload.deliveries[0].id);

  const acknowledged = await jsonResponse(await fetch(
    `${baseUrl}/api/companion/deliveries/${sent.payload.id}/acknowledge`,
    { method: 'POST', headers: recipientDesktop.headers }
  ));
  assert.equal(acknowledged.response.status, 200);

  const desktopEmpty = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: recipientDesktop.headers
  }));
  const phoneStillPending = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: recipientPhone.headers
  }));
  assert.deepEqual(desktopEmpty.payload.deliveries, []);
  assert.equal(phoneStillPending.payload.deliveries.length, 1);

  const downloaded = await fetch(`${baseUrl}${phoneStillPending.payload.deliveries[0].downloadPath}`, {
    headers: recipientPhone.headers
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), gif);

  const secondSend = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    method: 'POST',
    headers: { ...sender.headers, 'Content-Type': 'image/gif' },
    body: gif
  }));
  assert.equal(secondSend.response.status, 201);
});
