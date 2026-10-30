const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { expectedReleaseFileName } = require('../lib/storage');
const { ossOptions, mockClient } = require('./oss-fixture');

async function fixture(t, domain = 'download.example.com') {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-oss-api-'));
  const password = 'oss local test password';
  await fs.promises.writeFile(path.join(directory, 'auth.json'), JSON.stringify(await hashPassword(password)));
  const client = mockClient();
  const app = await createApplication({
    publicUrl: 'http://127.0.0.1', dataDirectory: directory, cookieSecure: false,
    signingPrivateKey: crypto.generateKeyPairSync('ed25519').privateKey,
    ...ossOptions(domain), ossClient: client
  });
  const server = http.createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    app.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const login = await request('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password })
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await login.json()).csrfToken };
  const admin = (url, method = 'GET', body) => request(url, {
    method, headers: { ...headers, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const releasePath = r => `/api/admin/releases/${r.platform}/${r.architecture}/${r.version}`;
  async function upload(platform, architecture, version) {
    const bytes = Buffer.from(`test package ${platform}/${architecture}/${version}`);
    const preflight = await admin('/api/admin/releases', 'POST', {
      platform, architecture, version, fileName: expectedReleaseFileName(platform, architecture, version), fileSize: bytes.length
    });
    assert.equal(preflight.status, 201);
    const result = await request((await preflight.json()).uploadUrl, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes
    });
    assert.equal(result.status, 201);
    return { ...(await result.json()).release, bytes };
  }
  async function publish(release) {
    const result = await admin(releasePath(release) + '/publish', 'POST');
    assert.equal(result.status, 200, await result.text());
  }
  return { app, client, request, admin, headers, upload, publish, releasePath };
}

test('OSS release API persists sync history, keeps the active release on failure, and enforces admin/CSRF', async t => {
  const { app, client, request, admin, headers, upload, publish, releasePath } = await fixture(t);
  const first = await upload('windows', 'x64', '3.3.0');
  await publish(first);
  const second = await upload('windows', 'x64', '3.3.1');
  const syncPath = releasePath(second) + '/oss-sync';
  assert.equal((await request(syncPath, { method: 'POST' })).status, 401);
  assert.equal((await request(syncPath, { method: 'POST', headers: { Cookie: headers.Cookie } })).status, 403);
  client.failure = Object.assign(new Error('test-secret must not escape'), { status: 403, code: 'AccessDenied' });
  const failed = await admin(releasePath(second) + '/publish', 'POST');
  assert.equal(failed.status, 409);
  assert.doesNotMatch(await failed.text(), /test-secret/);
  assert.equal(app.store.active('windows', 'x64').version, first.version);
  assert.equal(app.store.public('windows', 'x64').version, first.version);
  assert.equal(app.store.find('windows', 'x64', second.version).publishedAt, null);
  assert.equal((await request('/downloads/' + second.fileName)).status, 404);
  const listing = await (await admin('/api/admin/releases')).json();
  assert.equal(listing.releases.find(r => r.version === second.version).oss.status, 'failed');
  assert.doesNotMatch(JSON.stringify(listing), /test-secret|Signature=|OSSAccessKeyId/);
  client.failure = null;
  assert.equal((await admin(syncPath, 'POST')).status, 200);
  assert.equal(app.store.active('windows', 'x64').version, first.version);
  await publish(second);
  assert.equal(app.store.active('windows', 'x64').version, second.version);
  const status = app.services.ossService.status(second);
  assert.deepEqual(status.attempts.map(a => a.status), ['uploaded', 'uploaded', 'failed']);
  assert.equal(client.putCount, 2);
  // Old versions still require the existing license authorization before signing.
  assert.equal((await request('/downloads/' + first.fileName)).status, 401);
});

test('OSS download redirects retain stable manifest URLs, GET/HEAD signing and download-start accounting', async t => {
  const { app, request, upload, publish } = await fixture(t);
  const release = await upload('windows', 'x64', '3.3.0');
  await publish(release);
  const manifest = await (await request('/api/update/latest')).json();
  assert.equal(new URL(manifest.url).pathname, '/downloads/' + release.fileName);
  assert.equal(new URL(manifest.url).hostname, '127.0.0.1');
  // A synced object can be served without the server's local copy.
  await fs.promises.unlink(app.store.filePath(release));
  let starts = 0;
  t.mock.method(app.services.analyticsService, 'recordReleaseDownload', () => { starts++; });
  const target = '/downloads/' + release.fileName;
  const get = await request(target);
  assert.equal(get.status, 302);
  assert.equal(get.headers.get('cache-control'), 'private, no-store');
  const signed = new URL(get.headers.get('location'));
  assert.equal(signed.hostname, 'download.example.com');
  assert.equal(signed.pathname, '/releases/windows/x64/3.3.0/' + release.fileName);
  assert.equal(starts, 1);
  const head = await request(target, { method: 'HEAD' });
  assert.equal(head.status, 302);
  assert.notEqual(head.headers.get('location'), get.headers.get('location'));
  assert.equal(await head.text(), '');
  assert.equal((await request(target, { headers: { Range: 'bytes=10-' } })).status, 302);
  assert.equal(starts, 1);
  assert.equal((await request(target, { headers: { Range: 'bytes=0-9' } })).status, 302);
  assert.equal(starts, 2);
});

test('Android clients keep internal streaming, while browser APK downloads require a custom domain', async t => {
  for (const domain of ['', 'download.example.com']) {
    const { request, upload, publish } = await fixture(t, domain);
    const release = await upload('android', 'arm64-v8a', '1.4.0');
    await publish(release);
    const target = '/downloads/' + release.fileName;
    const android = await request(target, { headers: { 'X-DeskPet-Platform': 'android' } });
    assert.equal(android.status, 200);
    assert.equal(android.headers.get('location'), null);
    assert.deepEqual(Buffer.from(await android.arrayBuffer()), release.bytes);
    const range = await request(target, { headers: { 'User-Agent': 'ZhuoDazi-Android/1.4.0', Range: 'bytes=2-8' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), release.bytes.subarray(2, 9));
    const browser = await request(target);
    assert.equal(browser.status, domain ? 302 : 200);
    if (!domain) assert.deepEqual(Buffer.from(await browser.arrayBuffer()), release.bytes);
  }
});

test('Android 1.4.1 and later redirect only to their trusted OSS domain', async t => {
  for (const domain of ['oss-download.desktoppet.online', 'other.example.com', '']) {
    const { request, upload, publish } = await fixture(t, domain);
    const release = await upload('android', 'arm64-v8a', '1.4.1');
    await publish(release);
    for (const version of ['1.4.0', '1.4.1', '1.4.2', '1.5.0', '2.0.0', 'invalid', '']) {
      const result = await request('/downloads/' + release.fileName, { headers: {
        'X-DeskPet-Platform': 'android', 'X-DeskPet-Version': version,
        'User-Agent': 'ZhuoDazi-Android/' + version, Range: 'bytes=0-9'
      } });
      const modern = ['1.4.1', '1.4.2', '1.5.0', '2.0.0'].includes(version);
      assert.equal(result.status, modern && domain === 'oss-download.desktoppet.online' ? 302 : 206);
      await result.arrayBuffer();
    }
  }
});

test('application maintenance timer refreshes signed links without a download request', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date('2026-09-22T12:00:00Z') });
  const { app, upload, publish } = await fixture(t);
  const release = await upload('windows', 'x64', '3.3.0');
  await publish(release);
  const id = app.services.ossService.identity(release).id;
  const initial = app.ossUploadStore.link(id, 'GET');
  t.mock.timers.tick(13 * 60 * 1000);
  const refreshed = app.ossUploadStore.link(id, 'GET');
  assert.notEqual(refreshed.url, initial.url);
  assert.ok(refreshed.expiresAt > initial.expiresAt);
  assert.equal(app.ossUploadStore.attempts(id).length, 1);
});
