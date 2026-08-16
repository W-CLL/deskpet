const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication, signedManifestPayload } = require('../server');
const { hashPassword, verifyPassword } = require('../lib/security');
const { ReleaseStore } = require('../lib/storage');

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

test('legacy Windows release metadata migrates to the platform-aware schema', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-release-migration-test-'));
  context.after(() => fs.promises.rm(dataDirectory, { recursive: true, force: true }));
  const legacy = {
    schemaVersion: 1,
    activeVersion: '2.4.3',
    releases: [{
      version: '2.4.3',
      fileName: 'ZhuoDazi-Desktop-Pet-2.4.3.exe',
      originalName: 'ZhuoDazi-Desktop-Pet-2.4.3.exe',
      size: 123,
      sha256: 'a'.repeat(64),
      notes: 'legacy',
      createdAt: '2026-07-27T00:00:00.000Z',
      publishedAt: '2026-07-27T00:00:00.000Z'
    }]
  };
  await fs.promises.writeFile(path.join(dataDirectory, 'releases.json'), JSON.stringify(legacy));
  const store = new ReleaseStore(dataDirectory);
  await store.initialize();

  assert.equal(store.data.schemaVersion, 3);
  assert.equal(store.data.activeVersions['windows/x64'], '2.4.3');
  assert.equal(store.active('windows', 'x64')?.version, '2.4.3');
  assert.deepEqual(store.list()[0].platform, 'windows');
  assert.deepEqual(store.list()[0].architecture, 'x64');
  const persisted = JSON.parse(await fs.promises.readFile(path.join(dataDirectory, 'releases.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 3);
});

test('public and admin requests use the canonical HTTPS domain', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-domain-test-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('canonical domain password');
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'), JSON.stringify(authRecord));
  const application = await createApplication({
    publicUrl: 'https://legacy.invalid',
    dataDirectory,
    trustProxy: true,
    signingPrivateKey: privateKey
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  assert.equal(application.config.publicUrl.href, 'https://in.desktoppet.online/');
  assert.deepEqual(application.services.releaseService.list(), {
    publicUrl: 'https://in.desktoppet.online',
    adminUrl: 'https://in.desktoppet.online/admin',
    manifestUrl: 'https://in.desktoppet.online/api/update/latest',
    bootstrapVersions: { 'windows/x64': '2.5.7' },
    releaseTargets: {
      windows: ['x64'],
      macos: ['arm64', 'x86_64'],
      android: ['arm64-v8a', 'armeabi-v7a']
    },
    activeVersions: {},
    publicVersions: {},
    releases: []
  });
  const requestWithHost = (requestPath, headers, options = {}) => new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      headers,
      method: options.method || 'GET'
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response));
    });
    request.once('error', reject);
    request.end(options.body);
  });
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const redirectedAdmin = await requestWithHost('/admin?from=legacy', {
    Host: 'legacy.invalid',
    'X-Forwarded-Proto': 'http'
  });
  assert.equal(redirectedAdmin.statusCode, 308);
  assert.equal(
    redirectedAdmin.headers.location,
    'https://in.desktoppet.online/admin?from=legacy'
  );

  const proxiedLoopbackHost = await requestWithHost('/admin', {
    Host: 'localhost',
    'X-Forwarded-Proto': 'https'
  });
  assert.equal(proxiedLoopbackHost.statusCode, 308);
  assert.equal(proxiedLoopbackHost.headers.location, 'https://in.desktoppet.online/admin');

  const insecureDomain = await requestWithHost('/admin', {
    Host: 'in.desktoppet.online',
    'X-Forwarded-Proto': 'http'
  });
  assert.equal(insecureDomain.statusCode, 308);
  assert.equal(insecureDomain.headers.location, 'https://in.desktoppet.online/admin');

  const canonicalLogin = await requestWithHost('/api/admin/login', {
    Host: 'in.desktoppet.online',
    Origin: 'https://in.desktoppet.online',
    'Content-Type': 'application/json',
    'X-Forwarded-Proto': 'https'
  }, {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'canonical domain password' })
  });
  assert.equal(canonicalLogin.statusCode, 200);

  const staleOriginLogin = await requestWithHost('/api/admin/login', {
    Host: 'in.desktoppet.online',
    Origin: 'https://legacy.invalid',
    'Content-Type': 'application/json',
    'X-Forwarded-Proto': 'https'
  }, {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'canonical domain password' })
  });
  assert.equal(staleOriginLogin.statusCode, 403);

  const canonicalHealth = await requestWithHost('/healthz', {
    Host: 'in.desktoppet.online',
    'X-Forwarded-Proto': 'https'
  });
  assert.equal(canonicalHealth.statusCode, 200);

  const loopbackHealth = await fetch(`${baseUrl}/healthz`);
  assert.equal(loopbackHealth.status, 200);
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
    cookieSecure: false,
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
  assert.equal(health.payload.service, 'deskpet-update');
  assert.match(health.payload.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(Number.isInteger(health.payload.uptimeSeconds), true);
  assert.equal(health.payload.uptimeSeconds >= 0, true);
  assert.equal(health.payload.configured, true);
  assert.equal(health.payload.activeVersion, null);

  const adminPage = await fetch(`${baseUrl}/admin`);
  assert.equal(adminPage.status, 200);
  assert.equal(adminPage.headers.get('x-frame-options'), 'DENY');
  assert.match(adminPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const adminMarkup = await adminPage.text();
  assert.match(adminMarkup, /class="admin-shell"/);
  assert.match(adminMarkup, /data-page-panel="interactions"/);
  assert.match(adminMarkup, /data-page-panel="content"/);

  const adminCss = await fetch(`${baseUrl}/assets/admin.css?v=sidebar-1`);
  assert.equal(adminCss.status, 200);
  assert.equal(adminCss.headers.get('cache-control'), 'no-cache');
  assert.match(await adminCss.text(), /\.admin-shell\s*\{/);

  const adminScript = await fetch(`${baseUrl}/assets/admin.js?v=sidebar-1`);
  assert.equal(adminScript.status, 200);
  assert.equal(adminScript.headers.get('cache-control'), 'no-cache');

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

  const initialSiteSettings = await jsonResponse(await fetch(`${baseUrl}/api/admin/site-settings`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(initialSiteSettings.payload.xianyuUrl, '');

  const invalidSiteSettings = await jsonResponse(await fetch(`${baseUrl}/api/admin/site-settings`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ xianyuUrl: 'https://example.com/not-xianyu' })
  }));
  assert.equal(invalidSiteSettings.response.status, 400);
  assert.equal(invalidSiteSettings.payload.code, 'INVALID_XIANYU_URL');

  const xianyuUrl = 'https://www.goofish.com/item?id=deskpet-3';
  const updatedSiteSettings = await jsonResponse(await fetch(`${baseUrl}/api/admin/site-settings`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ xianyuUrl })
  }));
  assert.equal(updatedSiteSettings.response.status, 200);
  assert.equal(updatedSiteSettings.payload.xianyuUrl, xianyuUrl);

  const publicSiteSettings = await jsonResponse(await fetch(`${baseUrl}/api/public/site-settings`, {
    headers: { Origin: 'https://desktoppet.online' }
  }));
  assert.equal(publicSiteSettings.response.status, 200);
  assert.equal(publicSiteSettings.response.headers.get('access-control-allow-origin'), 'https://desktoppet.online');
  assert.equal(publicSiteSettings.payload.xianyuUrl, xianyuUrl);
  const releaseMetadata = JSON.parse(
    await fs.promises.readFile(path.join(dataDirectory, 'releases.json'), 'utf8')
  );
  assert.equal(releaseMetadata.siteSettings.xianyuUrl, xianyuUrl);

  const executable = Buffer.from('MZ deskpet release test payload', 'utf8');
  const releaseInfo = {
    version: '1.6.0',
    fileName: 'ZhuoDazi-Desktop-Pet-1.6.0.exe',
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

  const mismatchedFileName = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ ...releaseInfo, fileName: 'ZhuoDazi-Desktop-Pet-1.6.1.exe' })
  }));
  assert.equal(mismatchedFileName.response.status, 400);
  assert.equal(mismatchedFileName.payload.code, 'FILE_VERSION_MISMATCH');

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

  const macPreflight = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({
      platform: 'macos',
      architecture: 'arm64',
      version: '1.6.0',
      fileName: 'ZhuoDazi-macOS-1.6.0-arm64.zip',
      fileSize: executable.length,
      notes: 'macOS package can share the version number'
    })
  }));
  assert.equal(macPreflight.response.status, 201);
  assert.match(macPreflight.payload.uploadUrl, /^\/api\/admin\/uploads\//);

  const noRelease = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`));
  assert.equal(noRelease.response.status, 404);
  assert.equal(noRelease.payload.code, 'NO_RELEASE');

  const releasePath = application.store.filePath(upload.payload.release);
  const tamperedExecutable = Buffer.from(executable);
  tamperedExecutable[tamperedExecutable.length - 1] ^= 0xff;
  await fs.promises.writeFile(releasePath, tamperedExecutable);
  const tamperedPublish = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases/windows/x64/1.6.0/publish`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }
  }));
  assert.equal(tamperedPublish.response.status, 409);
  assert.equal(tamperedPublish.payload.code, 'RELEASE_HASH_MISMATCH');
  await fs.promises.writeFile(releasePath, executable);

  const publish = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases/windows/x64/1.6.0/publish`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }
  }));
  assert.equal(publish.response.status, 200);
  assert.equal(publish.payload.release.active, true);
  assert.equal(publish.payload.validation.sha256, upload.payload.release.sha256);
  assert.equal(publish.payload.validation.signatureVerified, true);

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
  assert.equal(download.headers.get('x-accel-buffering'), 'no');
  assert.equal(download.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), executable);

  const partial = await fetch(`${baseUrl}${downloadPath}`, { headers: { Range: 'bytes=0-1' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-1/${executable.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), executable.subarray(0, 2));

  const activeDelete = await jsonResponse(await fetch(`${baseUrl}/api/admin/releases/windows/x64/1.6.0`, {
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
  const accountId = results[winningIndex].payload.accountId;
  assert.match(accountId, /^[0-9a-f-]{36}$/i);

  const retry = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(winner)
  }));
  assert.equal(retry.response.status, 200);
  assert.equal(retry.payload.licenseId, licenseId);
  assert.equal(retry.payload.alreadyActivated, true);

  const analytics = await jsonResponse(await fetch(`${baseUrl}/api/admin/analytics`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(analytics.response.status, 200);
  assert.equal(analytics.payload.funnel.activatedInstallations, 1);

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
      platform: 'windows',
      architecture: 'x64',
      version,
      originalName: `DeskPet-${version}.exe`,
      size: executable.length,
      sha256: crypto.createHash('sha256').update(executable).digest('hex'),
      notes: `测试 ${version}`
    });
    await application.store.publish('windows', 'x64', version);
  }

  const publicManifest = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`));
  assert.equal(publicManifest.response.status, 200);
  assert.equal(publicManifest.payload.version, '2.2.0');

  const authorization = `Bearer ${licenseId}.${winner.credential}`;
  const currentManifest = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`, {
    headers: { Authorization: authorization, 'X-DeskPet-Version': '2.1.0' }
  }));
  assert.equal(currentManifest.response.status, 200);
  assert.equal(currentManifest.payload.version, '2.2.0');

  const currentDownloadPath = new URL(currentManifest.payload.url).pathname;
  const stableDownload = await fetch(`${baseUrl}/downloads/latest/windows/x64`, { redirect: 'manual' });
  assert.equal(stableDownload.status, 302);
  assert.equal(stableDownload.headers.get('location'), currentDownloadPath);
  const allowedDownload = await fetch(`${baseUrl}${currentDownloadPath}`);
  assert.equal(allowedDownload.status, 200);
  assert.deepEqual(Buffer.from(await allowedDownload.arrayBuffer()), Buffer.from('MZ deskpet 2.2.0', 'utf8'));

  const publicDownloads = await jsonResponse(await fetch(`${baseUrl}/api/public/downloads`));
  assert.equal(publicDownloads.response.status, 200);
  assert.equal(publicDownloads.payload.downloads.length, 1);
  assert.equal(publicDownloads.payload.downloads[0].version, '2.2.0');

  const rebindCode = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/accounts/${accountId}/rebind-code`,
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ expiresInHours: 24, note: 'HTTP 换机测试' })
    }
  ));
  assert.equal(rebindCode.response.status, 201);
  assert.equal(rebindCode.payload.accountId, accountId);
  assert.match(rebindCode.payload.code, /^(?=.*[A-Z])(?=.*[2-9])[A-HJ-NP-Z2-9]{6}$/);

  const replacementCredential = crypto.randomBytes(32).toString('base64url');
  const replacementActivation = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: rebindCode.payload.code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential: replacementCredential,
      appVersion: '2.2.0'
    })
  }));
  assert.equal(replacementActivation.response.status, 200);
  assert.equal(replacementActivation.payload.accountId, accountId);
  assert.notEqual(replacementActivation.payload.licenseId, licenseId);

  const replacedLicenseUpdate = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`, {
    headers: { Authorization: authorization }
  }));
  assert.equal(replacedLicenseUpdate.response.status, 401);

  const replacementAuthorization = `Bearer ${replacementActivation.payload.licenseId}.${replacementCredential}`;
  const replacementUpdate = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`, {
    headers: { Authorization: replacementAuthorization }
  }));
  assert.equal(replacementUpdate.response.status, 200);
  assert.equal(replacementUpdate.payload.version, '2.2.0');

  const revoke = await jsonResponse(await fetch(`${baseUrl}/api/admin/licenses/${replacementActivation.payload.licenseId}/revoke`, {
    method: 'POST',
    headers: adminHeaders
  }));
  assert.equal(revoke.response.status, 200);
  const revokedUpdate = await jsonResponse(await fetch(`${baseUrl}/api/update/latest`, {
    headers: { Authorization: replacementAuthorization }
  }));
  assert.equal(revokedUpdate.response.status, 401);
});

test('macOS releases are isolated by platform and architecture', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-macos-release-test-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
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

  for (const architecture of ['arm64', 'x86_64']) {
    const artifact = Buffer.from(`macOS ${architecture} 2.0.0`, 'utf8');
    const temporaryPath = application.store.uploadPath(`macos-${architecture}`);
    await fs.promises.writeFile(temporaryPath, artifact);
    await application.store.commitUpload({
      temporaryPath,
      platform: 'macos',
      architecture,
      version: '2.0.0',
      originalName: `ZhuoDazi-macOS-2.0.0-${architecture}.zip`,
      size: artifact.length,
      sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
      notes: `macOS ${architecture}`
    });
    await application.store.publish('macos', architecture, '2.0.0');
  }

  const unauthenticated = await jsonResponse(await fetch(
    `${baseUrl}/api/update/latest?platform=macos&architecture=arm64`
  ));
  assert.equal(unauthenticated.response.status, 200);
  assert.equal(unauthenticated.payload.version, '2.0.0');
  assert.equal(unauthenticated.payload.platform, 'macos');
  assert.equal(unauthenticated.payload.architecture, 'arm64');

  const code = application.activationStore.createCodes({ count: 1, expiresInDays: 30, note: 'macOS' }).codes[0];
  const credential = crypto.randomBytes(32).toString('base64url');
  const activation = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential,
      appVersion: '2.0.0'
    })
  }));
  assert.equal(activation.response.status, 200);
  const authorization = `Bearer ${activation.payload.licenseId}.${credential}`;

  for (const architecture of ['arm64', 'x86_64']) {
    const manifest = await jsonResponse(await fetch(
      `${baseUrl}/api/update/latest?platform=macos&architecture=${architecture}`,
      { headers: { Authorization: authorization } }
    ));
    assert.equal(manifest.response.status, 200);
    assert.equal(manifest.payload.platform, 'macos');
    assert.equal(manifest.payload.architecture, architecture);
    assert.equal(manifest.payload.version, '2.0.0');
    assert.match(manifest.payload.url, new RegExp(`ZhuoDazi-macOS-2\\.0\\.0-${architecture}\\.zip$`));
  }

  const invalidTarget = await jsonResponse(await fetch(
    `${baseUrl}/api/update/latest?platform=windows&architecture=arm64`
  ));
  assert.equal(invalidTarget.response.status, 400);
  assert.equal(invalidTarget.payload.code, 'INVALID_RELEASE_TARGET');
});

test('public analytics events are deduplicated and summarized by device', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-analytics-test-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
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

  const occurredAt = new Date().toISOString();
  const common = {
    visitorId: 'visitor-analytics-001',
    sessionId: 'session-analytics-001',
    occurredAt,
    pagePath: '/download/',
    utmSource: 'test',
    utmMedium: 'qa'
  };
  const eventBody = {
    events: [
      { ...common, eventId: 'page-view-001', type: 'page_view' },
      { ...common, eventId: 'download-click-001', type: 'download_click' },
      {
        ...common,
        eventId: 'resource-download-001',
        type: 'resource_download_click',
        pagePath: '/resources/'
      },
      {
        eventId: 'first-launch-001',
        type: 'app_first_launch',
        installationId: 'a'.repeat(32),
        platform: 'windows',
        architecture: 'x64',
        version: '2.5.3',
        occurredAt
      },
      {
        eventId: 'session-start-001',
        type: 'app_session_start',
        installationId: 'a'.repeat(32),
        platform: 'windows',
        architecture: 'x64',
        version: '2.5.3',
        occurredAt
      },
      {
        eventId: 'daily-active-001',
        type: 'app_daily_active',
        installationId: 'a'.repeat(32),
        platform: 'windows',
        architecture: 'x64',
        version: '2.5.3',
        occurredAt
      }
    ]
  };
  const recorded = await jsonResponse(await fetch(`${baseUrl}/api/analytics/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://desktoppet.online'
    },
    body: JSON.stringify(eventBody)
  }));
  assert.equal(recorded.response.status, 202);
  assert.equal(recorded.response.headers.get('access-control-allow-origin'), 'https://desktoppet.online');
  assert.equal(recorded.payload.accepted, 6);

  const duplicate = await jsonResponse(await fetch(`${baseUrl}/api/analytics/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...common, eventId: 'page-view-001', type: 'page_view' })
  }));
  assert.equal(duplicate.response.status, 202);
  assert.equal(duplicate.payload.accepted, 0);
  assert.equal(duplicate.payload.duplicates, 1);

  const summary = application.services.analyticsService.summary({});
  assert.equal(summary.funnel.pageViews, 1);
  assert.equal(summary.funnel.uniqueVisitors, 1);
  assert.equal(summary.funnel.downloadClicks, 1);
  assert.equal(summary.funnel.downloadVisitors, 1);
  assert.equal(summary.resourceDownloads.downloadClicks, 1);
  assert.equal(summary.resourceDownloads.downloadVisitors, 1);
  assert.equal(summary.funnel.firstLaunches, 1);
  assert.equal(summary.funnel.clickRate, 1);
  assert.equal(summary.activity.dailyActiveDevices, 1);
  assert.equal(summary.activity.weeklyActiveDevices, 1);
  assert.equal(summary.platforms[0].platform, 'windows');
});

test('Android APK releases are isolated by ABI and served with the APK content type', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-android-release-test-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
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

  const targets = [
    ['arm64-v8a', 'arm64'],
    ['armeabi-v7a', 'armv7']
  ];
  for (const [architecture, fileArchitecture] of targets) {
    const artifact = Buffer.from(`APK ${architecture} 1.1.0`, 'utf8');
    const temporaryPath = application.store.uploadPath(`android-${architecture}`);
    await fs.promises.writeFile(temporaryPath, artifact);
    const release = await application.store.commitUpload({
      temporaryPath,
      platform: 'android',
      architecture,
      version: '1.1.0',
      originalName: `ZhuoDazi-Android-1.1.0-${fileArchitecture}.apk`,
      size: artifact.length,
      sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
      notes: `Android ${architecture}`
    });
    assert.equal(release.fileName, `ZhuoDazi-Android-1.1.0-${fileArchitecture}.apk`);
    await application.store.publish('android', architecture, '1.1.0');
  }

  const code = application.activationStore.createCodes({ count: 1, expiresInDays: 30 }).codes[0];
  const credential = crypto.randomBytes(32).toString('base64url');
  const activation = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DeskPet-Platform': 'android',
      'X-DeskPet-Architecture': 'arm64-v8a'
    },
    body: JSON.stringify({
      code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential,
      appVersion: '1.1.0'
    })
  }));
  assert.equal(activation.response.status, 200);
  const authorization = `Bearer ${activation.payload.licenseId}.${credential}`;

  for (const [architecture, fileArchitecture] of targets) {
    const manifest = await jsonResponse(await fetch(
      `${baseUrl}/api/update/latest?platform=android&architecture=${architecture}`,
      { headers: { Authorization: authorization } }
    ));
    assert.equal(manifest.response.status, 200);
    assert.equal(manifest.payload.platform, 'android');
    assert.equal(manifest.payload.architecture, architecture);
    assert.match(
      manifest.payload.url,
      new RegExp(`ZhuoDazi-Android-1\\.1\\.0-${fileArchitecture}\\.apk$`)
    );
    const download = await fetch(
      `${baseUrl}${new URL(manifest.payload.url).pathname}`,
      { headers: { Authorization: authorization } }
    );
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get('content-type'),
      'application/vnd.android.package-archive'
    );
  }

  const defaultManifest = await jsonResponse(await fetch(
    `${baseUrl}/api/update/latest?platform=android`,
    { headers: { Authorization: authorization } }
  ));
  assert.equal(defaultManifest.payload.architecture, 'arm64-v8a');

  const invalidTarget = await jsonResponse(await fetch(
    `${baseUrl}/api/update/latest?platform=android&architecture=x86_64`
  ));
  assert.equal(invalidTarget.response.status, 400);
  assert.equal(invalidTarget.payload.code, 'INVALID_RELEASE_TARGET');
});

test('Express request parsing returns stable API errors', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-http-test-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
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

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.headers.has('x-powered-by'), false);

  const wrongType = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}'
  }));
  assert.equal(wrongType.response.status, 415);
  assert.equal(wrongType.payload.code, 'CONTENT_TYPE_REQUIRED');

  const malformed = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken'
  }));
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.payload.code, 'INVALID_JSON');

  const oversized = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(5000) })
  }));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.payload.code, 'BODY_TOO_LARGE');
});
