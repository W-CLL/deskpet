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

async function activateDevice(application, baseUrl, note) {
  const code = application.activationStore.createCodes({
    count: 1,
    expiresInDays: 30,
    note
  }).codes[0];
  const credential = crypto.randomBytes(36).toString('base64url');
  const installationId = `device-${crypto.randomBytes(18).toString('base64url')}`;
  const activation = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, credential, installationId, appVersion: '2.4.7' })
  }));
  assert.equal(activation.response.status, 200);
  return {
    authorization: `Bearer ${activation.payload.licenseId}.${credential}`,
    installationId
  };
}

function feedbackRequest(baseUrl, authorization, index) {
  return fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'X-DeskPet-Platform': 'windows',
      'X-DeskPet-Version': '2.4.7'
    },
    body: JSON.stringify({
      type: index % 2 === 0 ? 'problem' : 'suggestion',
      title: `反馈 ${index}`,
      content: `这是第 ${index} 条反馈的详细内容。`
    })
  });
}

test('feedback quota is limited to three active items per device', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-feedback-test-'));
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

  const unauthenticated = await jsonResponse(await fetch(`${baseUrl}/api/feedback`));
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.code, 'LICENSE_REQUIRED');

  const device = await activateDevice(application, baseUrl, '反馈设备');
  for (let index = 1; index <= 3; index += 1) {
    const submitted = await jsonResponse(await feedbackRequest(baseUrl, device.authorization, index));
    assert.equal(submitted.response.status, 201);
    assert.equal(submitted.payload.quota.active, index);
    assert.equal(submitted.payload.quota.remaining, 3 - index);
  }

  const limited = await jsonResponse(await feedbackRequest(baseUrl, device.authorization, 4));
  assert.equal(limited.response.status, 409);
  assert.equal(limited.payload.code, 'FEEDBACK_LIMIT_REACHED');

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const adminHeaders = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': login.payload.csrfToken
  };
  const adminList = await jsonResponse(await fetch(`${baseUrl}/api/admin/feedback`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(adminList.response.status, 200);
  assert.equal(adminList.payload.summary.pending, 3);
  assert.equal(adminList.payload.items[0].installationSuffix, device.installationId.slice(-8));

  const resolvedId = adminList.payload.items[0].id;
  const resolved = await jsonResponse(await fetch(`${baseUrl}/api/admin/feedback/${resolvedId}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'resolved', adminNote: '已在下一版本修复' })
  }));
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.payload.item.status, 'resolved');

  const replacement = await jsonResponse(await feedbackRequest(baseUrl, device.authorization, 4));
  assert.equal(replacement.response.status, 201);
  assert.equal(replacement.payload.quota.active, 3);

  const cannotReactivate = await jsonResponse(await fetch(`${baseUrl}/api/admin/feedback/${resolvedId}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'in_progress' })
  }));
  assert.equal(cannotReactivate.response.status, 409);
  assert.equal(cannotReactivate.payload.code, 'FEEDBACK_LIMIT_REACHED');

  const publicList = await jsonResponse(await fetch(`${baseUrl}/api/feedback`, {
    headers: { Authorization: device.authorization }
  }));
  assert.equal(publicList.response.status, 200);
  assert.equal(publicList.payload.items.length, 4);
  assert.equal(publicList.payload.quota.active, 3);
  assert.equal(publicList.payload.items.find((item) => item.id === resolvedId).adminNote, '已在下一版本修复');

  const concurrentDevice = await activateDevice(application, baseUrl, '并发反馈设备');
  const concurrent = await Promise.all([1, 2, 3, 4].map(async (index) => (
    jsonResponse(await feedbackRequest(baseUrl, concurrentDevice.authorization, index + 10))
  )));
  assert.deepEqual(
    concurrent.map((item) => item.response.status).sort((left, right) => left - right),
    [201, 201, 201, 409]
  );
});
