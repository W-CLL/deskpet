const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication, signedManifestPayload } = require('../server');
const { expectedReleaseFileName } = require('../lib/storage');
const { hashPassword } = require('../lib/security');

const PASSWORD = 'release notes regression password';

async function fixture(context) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-release-notes-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'),
    JSON.stringify(await hashPassword(PASSWORD)), { mode: 0o600 });
  let app;
  let server;
  let baseUrl;
  async function start() {
    app = await createApplication({ dataDirectory, publicUrl: 'http://127.0.0.1',
      cookieSecure: false, signingPrivateKey: privateKey });
    server = http.createServer(app.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  }
  await start();
  context.after(async () => {
    await close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  async function request(url, { headers = {}, method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${url}`, { method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function login() {
    const result = await request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
    assert.equal(result.status, 200);
    return { Cookie: result.headers.get('set-cookie').split(';', 1)[0], 'X-CSRF-Token': result.body.csrfToken };
  }
  function route(release) {
    return `/api/admin/releases/${release.platform}/${release.architecture}/${release.version}/notes`;
  }
  function edit(release, notes, expectedNotes, headers) {
    return request(route(release), { method: 'PATCH', headers, body: { notes, expectedNotes } });
  }
  async function seed(platform = 'windows', architecture = 'x64', version = '3.4.1', notes = '原更新说明', publish = false) {
    const payload = Buffer.from(`MZ local regression fixture ${platform}/${architecture}/${version}`, 'utf8');
    const temporaryPath = app.store.uploadPath(crypto.randomUUID());
    await fs.promises.writeFile(temporaryPath, payload);
    const release = await app.store.commitUpload({ temporaryPath, platform, architecture, version, notes,
      originalName: expectedReleaseFileName(platform, architecture, version), size: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex') });
    if (publish) await app.store.publish(platform, architecture, version);
    return structuredClone(app.store.list().find((item) => item.platform === platform
      && item.architecture === architecture && item.version === version));
  }
  async function disk() {
    return JSON.parse(await fs.promises.readFile(path.join(dataDirectory, 'releases.json'), 'utf8'));
  }
  function withoutNotes(document) {
    const copy = structuredClone(document);
    for (const release of copy.releases) delete release.notes;
    return copy;
  }
  async function files() {
    const result = {};
    for (const name of await fs.promises.readdir(app.store.releasesDirectory)) {
      const bytes = await fs.promises.readFile(path.join(app.store.releasesDirectory, name));
      result[name] = { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
    return result;
  }
  return { get app() { return app; }, publicKey, request, login, route, edit, seed, disk, files, withoutNotes,
    restart: async () => { await close(); await start(); } };
}

test('draft, historical and current release notes update only the selected metadata and survive restart', async (context) => {
  const f = await fixture(context);
  const historical = await f.seed('windows', 'x64', '3.4.0', '历史原说明', true);
  const current = await f.seed('windows', 'x64', '3.4.1', '当前原说明', true);
  const draft = await f.seed('windows', 'x64', '3.4.2', '草稿原说明');
  await f.seed('macos', 'arm64', '3.4.1', 'mac arm 原说明', true);
  await f.seed('macos', 'x86_64', '3.4.1', 'mac intel 原说明', true);
  const headers = await f.login();
  const originalDocument = await f.disk();
  const originalFiles = await f.files();
  for (const [release, source, expected] of [
    [historical, '  历史修订第一行\r\n历史修订第二行\r\n  ', '历史修订第一行\n历史修订第二行'],
    [current, '  当前版本修订说明  ', '当前版本修订说明'],
    [draft, '  草稿更新说明\r\n新增第二行 ', '草稿更新说明\n新增第二行']
  ]) {
    const before = await f.disk();
    const result = await f.edit(release, source, release.notes, headers);
    assert.equal(result.status, 200);
    assert.ok(result.body.release);
    assert.equal(result.body.release.notes, expected);
    assert.equal(result.body.release.platform, release.platform);
    assert.equal(result.body.release.architecture, release.architecture);
    assert.equal(result.body.release.version, release.version);
    assert.equal(result.body.release.publishedAt, release.publishedAt);
    const expectedDocument = structuredClone(before);
    expectedDocument.releases.find((item) => item.platform === release.platform && item.architecture === release.architecture
      && item.version === release.version).notes = expected;
    assert.deepEqual(await f.disk(), expectedDocument, 'No version, file, hash, timestamp, active/public pointer, setting or other release may change.');
    assert.deepEqual(f.app.store.data, expectedDocument, 'Memory and persisted metadata must agree.');
  }
  assert.deepEqual(f.withoutNotes(await f.disk()), f.withoutNotes(originalDocument));
  assert.deepEqual(await f.files(), originalFiles);
  const saved = await f.disk();
  await f.restart();
  assert.deepEqual(f.app.store.data, saved);
  const listing = await f.request('/api/admin/releases', { headers: await f.login() });
  assert.equal(listing.status, 200);
  assert.equal(listing.body.releases.find((item) => item.platform === 'windows' && item.version === '3.4.2').notes,
    '草稿更新说明\n新增第二行');
  assert.deepEqual(await f.files(), originalFiles);
});

test('editing notes requires an admin write session and rejects malformed bodies without mutation', async (context) => {
  const f = await fixture(context);
  const release = await f.seed();
  const headers = await f.login();
  const before = await f.disk();
  const body = { notes: 'changed', expectedNotes: release.notes };
  const request = (headers, body) => f.request(f.route(release), { method: 'PATCH', headers, body });
  assert.equal((await request({}, body)).status, 401);
  assert.equal((await request({ Cookie: headers.Cookie }, body)).status, 403);
  assert.equal((await request({ ...headers, 'X-CSRF-Token': 'wrong-csrf' }, body)).status, 403);
  assert.equal((await request({ ...headers, Origin: 'https://untrusted.example' }, body)).status, 403);
  for (const invalid of [
    {}, { notes: 'changed' }, { expectedNotes: release.notes },
    { notes: null, expectedNotes: release.notes }, { notes: 42, expectedNotes: release.notes },
    { notes: [], expectedNotes: release.notes }, { notes: {}, expectedNotes: release.notes },
    { notes: 'changed', expectedNotes: null }, { notes: 'changed', expectedNotes: 42 },
    { notes: 'changed', expectedNotes: [] }, { notes: 'changed', expectedNotes: {} },
    { notes: '长'.repeat(1201), expectedNotes: release.notes },
    { notes: 'changed', expectedNotes: '长'.repeat(1201) },
    { ...body, sha256: '0'.repeat(64) }, { ...body, publishedAt: '2099-01-01' },
    { ...body, version: '9.9.9' }, [], null, 'invalid'
  ]) {
    assert.equal((await request(headers, invalid)).status, 400, `Invalid fields or types must be rejected: ${JSON.stringify(invalid).slice(0, 80)}`);
    assert.deepEqual(await f.disk(), before);
    assert.deepEqual(f.app.store.data, before);
  }
  const missing = await f.edit({ ...release, version: '99.9.9' }, 'changed', '', headers);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'VERSION_NOT_FOUND');
  assert.deepEqual(await f.disk(), before);
  const maximum = '长'.repeat(1200);
  assert.equal((await f.edit(release, maximum, release.notes, headers)).status, 200);
  assert.equal(f.app.store.find(release.platform, release.architecture, release.version).notes, maximum);
  const cleared = await f.edit(release, ' \r\n  ', maximum, headers);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.release.notes, '');
  const reentered = await f.edit(release, '重新填写', '', headers);
  assert.equal(reentered.status, 200);
  assert.equal(reentered.body.release.notes, '重新填写');
});

test('concurrent note edits detect stale original text without overwriting the winner', async (context) => {
  const f = await fixture(context);
  const release = await f.seed('windows', 'x64', '3.4.1', '第一行\n第二行');
  const headers = await f.login();
  const normalizedButNotOriginal = await f.edit(release, '不应写入', ` ${release.notes} `, headers);
  assert.equal(normalizedButNotOriginal.status, 409, 'expectedNotes is the exact original string, not trimmed input.');
  assert.equal(normalizedButNotOriginal.body.code, 'RELEASE_NOTES_CONFLICT');
  const results = await Promise.all([
    f.edit(release, '编辑者甲保存', release.notes, headers),
    f.edit(release, '编辑者乙保存', release.notes, headers)
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
  const winner = results.find((item) => item.status === 200).body.release.notes;
  assert.equal(results.find((item) => item.status === 409).body.code, 'RELEASE_NOTES_CONFLICT');
  const stored = await f.disk();
  assert.equal(stored.releases[0].notes, winner);
  assert.equal(f.app.store.data.releases[0].notes, winner);
  const stale = await f.edit(release, '过时页面强行覆盖', release.notes, headers);
  assert.equal(stale.status, 409);
  assert.deepEqual(await f.disk(), stored);
  const retry = await f.edit(release, '读取新原文后再次保存', winner, headers);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.release.notes, '读取新原文后再次保存');
});

test('simultaneous edits to different targets and settings remain serialized without losing changes', async (context) => {
  const f = await fixture(context);
  const targets = [
    await f.seed('windows', 'x64', '3.4.1', 'windows', true),
    await f.seed('macos', 'arm64', '3.4.1', 'mac arm', true),
    await f.seed('macos', 'x86_64', '3.4.1', 'mac intel', true),
    await f.seed('android', 'arm64-v8a', '3.4.1', 'android arm64', true),
    await f.seed('android', 'armeabi-v7a', '3.4.1', 'android armv7', true)
  ];
  const headers = await f.login();
  const original = await f.disk();
  const results = await Promise.all([
    ...targets.map((release) => f.edit(release, `${release.notes} 独立修改`, release.notes, headers)),
    f.request('/api/admin/site-settings', { headers, method: 'PUT', body: { announcement: '并行保存站点公告' } })
  ]);
  assert.ok(results.every((item) => item.status === 200));
  const saved = await f.disk();
  for (const release of targets) {
    const row = saved.releases.find((item) => item.platform === release.platform && item.architecture === release.architecture);
    assert.equal(row.notes, `${release.notes} 独立修改`);
  }
  assert.deepEqual(saved.activeVersions, original.activeVersions);
  assert.deepEqual(saved.publicVersions, original.publicVersions);
  assert.equal(saved.siteSettings.announcement, '并行保存站点公告');
  await f.restart();
  assert.deepEqual(f.app.store.data, saved);
});

test('public downloads and signed manifests immediately use edited notes without reupload or premium access', async (context) => {
  const f = await fixture(context);
  const release = await f.seed('windows', 'x64', '3.4.1', '签名前原说明', true);
  const draft = await f.seed('windows', 'x64', '3.4.2', '无安装包也可修正文案');
  const headers = await f.login();
  const manifestBefore = await f.request('/api/update/latest?platform=windows&architecture=x64');
  const downloadsBefore = await f.request('/api/public/downloads');
  assert.equal(manifestBefore.status, 200);
  assert.equal(downloadsBefore.status, 200);
  const verify = (manifest, signature = manifest.signature) => crypto.verify(null,
    signedManifestPayload(manifest), f.publicKey, Buffer.from(signature, 'base64'));
  assert.equal(verify(manifestBefore.body), true);
  assert.equal(manifestBefore.body.notes, release.notes);
  const originalFiles = await f.files();
  const edited = await f.edit(release, '线上即时显示的新说明\r\n第二行', release.notes, headers);
  assert.equal(edited.status, 200);
  const manifestAfter = await f.request('/api/update/latest?platform=windows&architecture=x64');
  const downloadsAfter = await f.request('/api/public/downloads');
  assert.equal(manifestAfter.status, 200);
  assert.equal(manifestAfter.headers.get('cache-control'), 'no-store');
  assert.equal(manifestAfter.body.notes, '线上即时显示的新说明\n第二行');
  assert.equal(verify(manifestAfter.body), true);
  assert.equal(verify(manifestAfter.body, manifestBefore.body.signature), false, 'A signature over the old notes must not authenticate changed notes.');
  assert.notEqual(manifestAfter.body.signature, manifestBefore.body.signature);
  const publicRelease = downloadsAfter.body.downloads.find((item) => item.platform === 'windows');
  assert.equal(publicRelease.notes, manifestAfter.body.notes);
  assert.deepEqual({ ...publicRelease, notes: release.notes }, downloadsBefore.body.downloads.find((item) => item.platform === 'windows'));
  assert.deepEqual({ ...manifestAfter.body, notes: manifestBefore.body.notes, signature: manifestBefore.body.signature }, manifestBefore.body);
  assert.deepEqual(await f.files(), originalFiles);
  assert.equal(f.app.services.releaseService.pendingUploads.size, 0);
  assert.equal(f.app.activationStore.database.prepare('SELECT COUNT(*) AS count FROM licenses').get().count, 0);

  // Editing copy is independent of archive access, validation, OSS configuration and uploading.
  const archivePath = f.app.store.filePath(draft);
  const heldPath = `${archivePath}.held-for-notes-test`;
  await fs.promises.rename(archivePath, heldPath);
  try {
    const result = await f.edit(draft, '只改说明，无需重新上传', draft.notes, headers);
    assert.equal(result.status, 200);
    assert.equal(result.body.release.notes, '只改说明，无需重新上传');
    assert.equal(result.body.release.publishedAt, null);
  } finally {
    await fs.promises.rename(heldPath, archivePath);
  }
  assert.deepEqual(await f.files(), originalFiles);
  await f.restart();
  const persistedManifest = await f.request('/api/update/latest?platform=windows&architecture=x64');
  assert.deepEqual(persistedManifest.body, manifestAfter.body);
  assert.equal(verify(persistedManifest.body), true);
});

test('a failed metadata write preserves published notes and allows a later successful retry', async (context) => {
  const f = await fixture(context);
  const release = await f.seed('windows', 'x64', '3.4.1', '保存失败时必须保留', true);
  const headers = await f.login();
  const before = await f.disk();
  const beforeManifest = await f.request('/api/update/latest?platform=windows&architecture=x64');
  const actualMetadataPath = f.app.store.metadataPath;
  // A file cannot be used as a parent directory on Windows or Linux. This exercises real disk failure
  // without modifying permissions or renaming the original release index while requests are running.
  f.app.store.metadataPath = path.join(actualMetadataPath, 'unwritable-release-index.json');
  try {
    const failed = await f.edit(release, '本次写盘失败的新文案', release.notes, headers);
    assert.equal(failed.status, 500);
    assert.deepEqual(f.app.store.data, before, 'Uncommitted notes must not become visible in memory.');
    assert.deepEqual(await f.disk(), before, 'The actual release index must remain unchanged.');
    const manifest = await f.request('/api/update/latest?platform=windows&architecture=x64');
    assert.deepEqual(manifest.body, beforeManifest.body, 'Public notes and signature must continue using committed data.');
    const downloads = await f.request('/api/public/downloads');
    assert.equal(downloads.body.downloads.find((item) => item.platform === 'windows').notes, release.notes);
  } finally {
    f.app.store.metadataPath = actualMetadataPath;
  }
  const retry = await f.edit(release, '恢复可写后保存成功', release.notes, headers);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.release.notes, '恢复可写后保存成功');
  await f.restart();
  assert.equal(f.app.store.find('windows', 'x64', '3.4.1').notes, '恢复可写后保存成功');
});
