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
  assert.equal(firstProfile.payload.hallEnabled, true);
  assert.equal(secondProfile.payload.hallEnabled, true);

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
  assert.equal(adminStats.payload.pairs.length, 1);
  assert.deepEqual(
    new Set([
      adminStats.payload.pairs[0].firstAccountId,
      adminStats.payload.pairs[0].secondAccountId
    ]),
    new Set([first.accountId, second.accountId])
  );
  assert.equal(adminStats.payload.profiles.length, 2);
  assert.equal(adminStats.payload.recentDeliveries.length, 1);
  assert.equal(adminStats.payload.recentDeliveries[0].source, 'pair');
  assert.equal(adminStats.payload.recentDeliveries[0].status, 'received');
  assert.ok(Array.isArray(adminStats.payload.sendOptions.senders));
  assert.ok(Array.isArray(adminStats.payload.sendOptions.devices));
  assert.equal(adminStats.payload.sendOptions.onlineWindowMinutes, 5);
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

test('hall users can see online strangers and send a GIF with a message', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-companion-hall-'));
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
    companionOptions: { cooldownMs: 0 }
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const first = await activate(application, baseUrl);
  const second = await activate(application, baseUrl);
  const jsonHeaders = (headers) => ({ ...headers, 'Content-Type': 'application/json' });
  await fetch(`${baseUrl}/api/companion`, {
    method: 'PATCH',
    headers: jsonHeaders(first.headers),
    body: JSON.stringify({ displayName: '大厅访客甲' })
  });
  await fetch(`${baseUrl}/api/companion`, {
    method: 'PATCH',
    headers: jsonHeaders(second.headers),
    body: JSON.stringify({ displayName: '大厅访客乙' })
  });
  const firstHall = await jsonResponse(await fetch(`${baseUrl}/api/companion/hall`, {
    method: 'PATCH',
    headers: jsonHeaders(first.headers),
    body: JSON.stringify({ enabled: true })
  }));
  assert.equal(firstHall.response.status, 200);
  const secondHall = await jsonResponse(await fetch(`${baseUrl}/api/companion/hall`, {
    method: 'PATCH',
    headers: jsonHeaders(second.headers),
    body: JSON.stringify({ enabled: true })
  }));
  assert.equal(secondHall.response.status, 200);

  const hall = await jsonResponse(await fetch(`${baseUrl}/api/companion/hall`, {
    headers: first.headers
  }));
  assert.equal(hall.response.status, 200);
  assert.equal(hall.payload.enabled, true);
  assert.deepEqual(
    hall.payload.people.map(({ id, displayName, online }) => ({ id, displayName, online })),
    [{ id: second.accountId, displayName: '大厅访客乙', online: true }]
  );

  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const message = '来玩呀，给你一只小表情';
  const sent = await jsonResponse(await fetch(
    `${baseUrl}/api/companion/hall/deliveries/${encodeURIComponent(second.accountId)}?message=${encodeURIComponent(message)}`,
    {
      method: 'POST',
      headers: { ...first.headers, 'Content-Type': 'image/gif' },
      body: gif
    }
  ));
  assert.equal(sent.response.status, 201);
  assert.equal(sent.payload.recipientName, '大厅访客乙');

  const pending = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: second.headers
  }));
  assert.equal(pending.payload.deliveries.length, 1);
  assert.equal(pending.payload.deliveries[0].senderName, '大厅访客甲');
  assert.equal(pending.payload.deliveries[0].message, message);
  assert.equal(application.companionStore.adminStats().recentDeliveries[0].source, 'hall');

  await fetch(`${baseUrl}/api/companion/hall`, {
    method: 'PATCH',
    headers: jsonHeaders(second.headers),
    body: JSON.stringify({ enabled: false })
  });
  const hiddenHall = await jsonResponse(await fetch(`${baseUrl}/api/companion/hall`, {
    headers: first.headers
  }));
  assert.deepEqual(hiddenHall.payload.people, []);
  const offline = await jsonResponse(await fetch(
    `${baseUrl}/api/companion/hall/deliveries/${encodeURIComponent(second.accountId)}`,
    {
      method: 'POST',
      headers: { ...first.headers, 'Content-Type': 'image/gif' },
      body: gif
    }
  ));
  assert.equal(offline.response.status, 409);
  assert.equal(offline.payload.code, 'COMPANION_HALL_RECIPIENT_OFFLINE');
});

test('admin can send a GIF from a chosen account to an online device', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-companion-admin-send-'));
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
    companionOptions: { cooldownMs: 30_000, maxPending: 3 }
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const sender = await activate(application, baseUrl);
  const recipient = await activate(application, baseUrl);
  await fetch(`${baseUrl}/api/companion`, {
    method: 'PATCH',
    headers: { ...sender.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: '运营桌宠' })
  });
  await fetch(`${baseUrl}/api/companion`, {
    method: 'PATCH',
    headers: { ...recipient.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: '在线用户' })
  });
  await fetch(`${baseUrl}/api/companion/deliveries`, { headers: sender.headers });
  await fetch(`${baseUrl}/api/companion/deliveries`, { headers: recipient.headers });

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const csrfToken = login.payload.csrfToken;
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const message = '后台来串门啦';
  const adminHeaders = {
    Cookie: cookie,
    'Content-Type': 'image/gif',
    'X-CSRF-Token': csrfToken
  };

  const options = await jsonResponse(await fetch(`${baseUrl}/api/admin/companions`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(options.response.status, 200);
  assert.equal(options.payload.sendOptions.senders.length, 2);
  assert.equal(options.payload.sendOptions.devices.length, 2);
  const recipientDevice = options.payload.sendOptions.devices.find(
    (item) => item.accountId === recipient.accountId
  );
  assert.ok(recipientDevice?.licenseId);

  const missingCsrf = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/companions/deliveries?senderAccountId=${sender.accountId}&recipientLicenseId=${recipientDevice.licenseId}`,
    { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/gif' }, body: gif }
  ));
  assert.equal(missingCsrf.response.status, 403);

  const sent = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/companions/deliveries?senderAccountId=${sender.accountId}&recipientLicenseId=${recipientDevice.licenseId}&message=${encodeURIComponent(message)}`,
    { method: 'POST', headers: adminHeaders, body: gif }
  ));
  assert.equal(sent.response.status, 201);
  assert.equal(sent.payload.recipientName, '在线用户');

  const pending = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: recipient.headers
  }));
  assert.equal(pending.payload.deliveries.length, 1);
  assert.equal(pending.payload.deliveries[0].senderName, '运营桌宠');
  assert.equal(pending.payload.deliveries[0].message, message);

  const downloaded = await fetch(`${baseUrl}${pending.payload.deliveries[0].downloadPath}`, {
    headers: recipient.headers
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), gif);

  const secondSend = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/companions/deliveries?senderAccountId=${sender.accountId}&recipientLicenseId=${recipientDevice.licenseId}`,
    { method: 'POST', headers: adminHeaders, body: gif }
  ));
  assert.equal(secondSend.response.status, 201);

  const selfSend = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/companions/deliveries?senderAccountId=${sender.accountId}&recipientLicenseId=${options.payload.sendOptions.devices.find((item) => item.accountId === sender.accountId).licenseId}`,
    { method: 'POST', headers: adminHeaders, body: gif }
  ));
  assert.equal(selfSend.response.status, 400);
  assert.equal(selfSend.payload.code, 'COMPANION_ADMIN_SELF');

  const stats = await jsonResponse(await fetch(`${baseUrl}/api/admin/companions`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(stats.payload.recentDeliveries[0].source, 'admin');
  assert.equal(stats.payload.recentDeliveries[1].source, 'admin');
});

test('admin can send a visit to an online trial device', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-companion-admin-trial-'));
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
    companionOptions: { cooldownMs: 0, maxPending: 3 }
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const sender = await activate(application, baseUrl);
  await fetch(`${baseUrl}/api/companion`, {
    method: 'PATCH',
    headers: { ...sender.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: '运营桌宠' })
  });
  await fetch(`${baseUrl}/api/companion/deliveries`, { headers: sender.headers });

  const trialInstallationId = crypto.randomBytes(16).toString('hex');
  const trialCredential = crypto.randomBytes(32).toString('base64url');
  const trialHeaders = {
    Authorization: `Trial ${trialInstallationId}.${trialCredential}`,
    'X-DeskPet-Version': '3.1.0',
    'X-DeskPet-Platform': 'windows'
  };
  const started = await jsonResponse(await fetch(`${baseUrl}/api/trial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DeskPet-Platform': 'windows' },
    body: JSON.stringify({
      installationId: trialInstallationId,
      credential: trialCredential,
      appVersion: '3.1.0'
    })
  }));
  assert.equal(started.response.status, 200);
  const trialInbox = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: trialHeaders
  }));
  assert.equal(trialInbox.response.status, 200);
  assert.deepEqual(trialInbox.payload.deliveries, []);

  const trialDeniedSend = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    method: 'POST',
    headers: { ...trialHeaders, 'Content-Type': 'image/gif' },
    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
  }));
  assert.equal(trialDeniedSend.response.status, 403);
  assert.equal(trialDeniedSend.payload.code, 'COMPANION_ACTIVATION_REQUIRED');

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const csrfToken = login.payload.csrfToken;
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const message = '体验期也来串门';

  const options = await jsonResponse(await fetch(`${baseUrl}/api/admin/companions`, {
    headers: { Cookie: cookie }
  }));
  const trialDevice = options.payload.sendOptions.devices.find(
    (item) => item.authorizationType === 'trial'
  );
  assert.ok(trialDevice?.licenseId);
  assert.match(trialDevice.licenseId, /^trial:[0-9a-f]{64}$/i);

  const sent = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/companions/deliveries?senderAccountId=${sender.accountId}&recipientLicenseId=${encodeURIComponent(trialDevice.licenseId)}&message=${encodeURIComponent(message)}`,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'image/gif', 'X-CSRF-Token': csrfToken },
      body: gif
    }
  ));
  assert.equal(sent.response.status, 201);

  const pending = await jsonResponse(await fetch(`${baseUrl}/api/companion/deliveries`, {
    headers: trialHeaders
  }));
  assert.equal(pending.response.status, 200);
  assert.equal(pending.payload.deliveries.length, 1);
  assert.equal(pending.payload.deliveries[0].senderName, '运营桌宠');
  assert.equal(pending.payload.deliveries[0].message, message);

  const downloaded = await fetch(`${baseUrl}${pending.payload.deliveries[0].downloadPath}`, {
    headers: trialHeaders
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), gif);

  const acknowledged = await jsonResponse(await fetch(
    `${baseUrl}/api/companion/deliveries/${pending.payload.deliveries[0].id}/acknowledge`,
    { method: 'POST', headers: trialHeaders }
  ));
  assert.equal(acknowledged.response.status, 200);
});
