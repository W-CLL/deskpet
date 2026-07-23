const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication, signedManifestPayload } = require('../server');
const { hashPassword, verifyPassword } = require('../lib/security');

async function jsonResponse(response) {
  const payload = await response.json();
  return { response, payload };
}

test('password hashes verify without storing the plaintext password', async () => {
  const record = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', record), true);
  assert.equal(await verifyPassword('wrong password value', record), false);
  assert.equal(JSON.stringify(record).includes('correct horse battery staple'), false);
});

test('HTTPS proxy headers are trusted only from the configured loopback proxy', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-proxy-test-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const application = await createApplication({
    publicUrl: 'https://8.134.130.155',
    dataDirectory,
    requireHttps: true,
    trustProxy: true,
    enforceHost: false,
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

  const direct = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(direct.status, 200);

  const proxied = await fetch(`${baseUrl}/admin`, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(proxied.status, 200);

  const health = await jsonResponse(await fetch(`${baseUrl}/healthz`, {
    headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' }
  }));
  assert.equal(health.payload.tls, true);
});

test('admin upload, publish, manifest and download workflow', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-update-test-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('test admin password 123');
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'), JSON.stringify(authRecord), { mode: 0o600 });
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    bootstrapVersion: '1.6.0',
    dataDirectory,
    requireHttps: false,
    cookieSecure: false,
    enforceHost: false,
    maxUploadSize: 1024 * 1024,
    signingPrivateKey: privateKey
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  let csrfToken = '';

  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const health = await jsonResponse(await fetch(`${baseUrl}/healthz`));
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.configured, true);
  assert.equal(health.payload.activeVersion, null);

  const adminPage = await fetch(`${baseUrl}/admin`);
  assert.equal(adminPage.status, 200);
  assert.equal(adminPage.headers.get('x-frame-options'), 'DENY');
  assert.match(adminPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const unauthenticated = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases`));
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.code, 'AUTH_REQUIRED');

  const failedLogin = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'incorrect password' })
  }));
  assert.equal(failedLogin.response.status, 401);

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.authenticated, true);
  cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  csrfToken = login.payload.csrfToken;
  assert.match(cookie, /^deskpet_session=/);

  const executable = Buffer.from('MZ deskpet release test payload', 'utf8');
  const releaseInfo = {
    version: '1.6.0',
    fileName: 'DeskPet-1.6.0.exe',
    fileSize: executable.length,
    notes: '安全更新\n测试发布'
  };

  const rejectedPreflight = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(releaseInfo)
  }));
  assert.equal(rejectedPreflight.response.status, 403);
  assert.equal(rejectedPreflight.payload.code, 'CSRF_REJECTED');

  const preflight = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(releaseInfo)
  }));
  assert.equal(preflight.response.status, 201);
  assert.match(preflight.payload.uploadUrl, /^\/api\/admin\/uploads\//);

  const upload = await jsonResponse(await fetch(`${baseUrl}${preflight.payload.uploadUrl}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrfToken },
    body: executable
  }));
  assert.equal(upload.response.status, 201);
  assert.equal(upload.payload.release.version, '1.6.0');
  assert.equal(upload.payload.release.active, false);
  assert.equal(upload.payload.release.sha256, crypto.createHash('sha256').update(executable).digest('hex'));

  const noRelease = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`));
  assert.equal(noRelease.response.status, 404);
  assert.equal(noRelease.payload.code, 'NO_RELEASE');

  const publish = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases/1.6.0/publish`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }
  }));
  assert.equal(publish.response.status, 200);
  assert.equal(publish.payload.release.active, true);

  const manifest = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`));
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.response.headers.get('cache-control'), 'no-store');
  assert.equal(manifest.payload.version, '1.6.0');
  assert.equal(manifest.payload.sha256, upload.payload.release.sha256);
  assert.equal(manifest.payload.url, 'http://127.0.0.1/downloads/ZhuoDazi-Desktop-Pet-1.6.0.exe');
  assert.equal(manifest.payload.signatureAlgorithm, 'ed25519');
  assert.equal(crypto.verify(
    null,
    signedManifestPayload(manifest.payload),
    publicKey,
    Buffer.from(manifest.payload.signature, 'base64')
  ), true);

  const downloadPath = new URL(manifest.payload.url).pathname;
  const download = await fetch(`${baseUrl}${downloadPath}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), executable);

  const partial = await fetch(`${baseUrl}${downloadPath}`, { headers: { Range: 'bytes=0-1' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-1/${executable.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), executable.subarray(0, 2));

  const activeDelete = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases/1.6.0`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }
  }));
  assert.equal(activeDelete.response.status, 409);
  assert.equal(activeDelete.payload.code, 'ACTIVE_VERSION_DELETE_REJECTED');
});

test('one-time activation gates current manifests and downloads', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-activation-test-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('test admin password 123');
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'), JSON.stringify(authRecord), { mode: 0o600 });
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    bootstrapVersion: '2.1.0',
    dataDirectory,
    requireHttps: false,
    cookieSecure: false,
    enforceHost: false,
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

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const csrfToken = login.payload.csrfToken;
  const adminHeaders = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };

  const generated = await jsonResponse(await fetch(`${baseUrl}/api/admin/activation-codes`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ count: 1, expiresInDays: 30, note: '并发测试' })
  }));
  assert.equal(generated.response.status, 201);
  assert.match(generated.payload.codes[0], /^(?=.*[A-Z])(?=.*[2-9])[A-HJ-NP-Z2-9]{6}$/);

  const generatedList = await jsonResponse(await fetch(`${baseUrl}/api/admin/activation-codes`, {
    headers: { Cookie: cookie }
  }));
  const generatedItem = generatedList.payload.codes[0];
  assert.equal(generatedItem.canReveal, true);
  assert.equal(JSON.stringify(generatedList.payload).includes(generated.payload.codes[0]), false);

  const rejectedReveal = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/activation-codes/${generatedItem.id}/reveal`,
    { method: 'POST', headers: { Cookie: cookie } }
  ));
  assert.equal(rejectedReveal.response.status, 403);
  assert.equal(rejectedReveal.payload.code, 'CSRF_REJECTED');

  const revealed = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/activation-codes/${generatedItem.id}/reveal`,
    { method: 'POST', headers: adminHeaders }
  ));
  assert.equal(revealed.response.status, 200);
  assert.equal(revealed.payload.code, generated.payload.codes[0]);

  const attempts = [0, 1].map((index) => ({
    code: generated.payload.codes[0],
    installationId: `installation-${index}-${crypto.randomBytes(12).toString('base64url')}`,
    credential: crypto.randomBytes(32).toString('base64url'),
    appVersion: '2.1.0'
  }));
  const results = await Promise.all(attempts.map(async (body) => jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }))));
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 401]);
  const winningIndex = results.findIndex((item) => item.response.status === 200);
  const winner = attempts[winningIndex];
  const licenseId = results[winningIndex].payload.licenseId;

  const retry = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(winner)
  }));
  assert.equal(retry.response.status, 200);
  assert.equal(retry.payload.licenseId, licenseId);
  assert.equal(retry.payload.alreadyActivated, true);

  const activationList = await jsonResponse(await fetch(`${baseUrl}/api/admin/activation-codes`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(activationList.payload.summary.used, 1);
  assert.equal(activationList.payload.summary.active, 1);
  assert.equal(activationList.payload.codes[0].maskedCode.startsWith('****'), true);
  assert.equal(JSON.stringify(activationList.payload).includes(generated.payload.codes[0]), false);

  for (const version of ['2.1.0', '2.2.0']) {
    const executable = Buffer.from(`MZ deskpet ${version}`, 'utf8');
    const temporaryPath = application.store.uploadPath(`test-${version}`);
    await fs.promises.writeFile(temporaryPath, executable);
    await application.store.commitUpload({
      temporaryPath,
      version,
      originalName: `DeskPet-${version}.exe`,
      size: executable.length,
      sha256: crypto.createHash('sha256').update(executable).digest('hex'),
      notes: `测试 ${version}`
    });
    await application.store.publish(version);
  }

  const bootstrapManifest = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`));
  assert.equal(bootstrapManifest.response.status, 200);
  assert.equal(bootstrapManifest.payload.version, '2.1.0');

  const authorization = `Bearer ${licenseId}.${winner.credential}`;
  const currentManifest = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`, {
    headers: { Authorization: authorization, 'X-DeskPet-Version': '2.1.0' }
  }));
  assert.equal(currentManifest.response.status, 200);
  assert.equal(currentManifest.payload.version, '2.2.0');

  const currentDownloadPath = new URL(currentManifest.payload.url).pathname;
  const deniedDownload = await jsonResponse(await fetch(`${baseUrl}${currentDownloadPath}`));
  assert.equal(deniedDownload.response.status, 401);
  const allowedDownload = await fetch(`${baseUrl}${currentDownloadPath}`, { headers: { Authorization: authorization } });
  assert.equal(allowedDownload.status, 200);
  assert.deepEqual(Buffer.from(await allowedDownload.arrayBuffer()), Buffer.from('MZ deskpet 2.2.0', 'utf8'));

  const revoke = await jsonResponse(await fetch(`${baseUrl}/api/admin/licenses/${licenseId}/revoke`, {
    method: 'POST',
    headers: adminHeaders
  }));
  assert.equal(revoke.response.status, 200);
  const revokedUpdate = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`, {
    headers: { Authorization: authorization }
  }));
  assert.equal(revokedUpdate.response.status, 401);
});
