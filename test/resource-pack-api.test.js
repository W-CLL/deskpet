const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { createStoredZip } = require('../lib/local-market-store');
const { ResourcePackStore } = require('../lib/resource-pack-store');
const { ResourcePackService } = require('../src/services/resource-pack-service');

async function jsonResponse(response) {
  return { response, payload: await response.json() };
}

test('resource packs can be uploaded by category and downloaded publicly', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-resource-packs-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('resource pack admin password');
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'), JSON.stringify(authRecord), { mode: 0o600 });
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    dataDirectory,
    cookieSecure: false,
    maxUploadSize: 1024 * 1024,
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

  const emptyPublic = await jsonResponse(await fetch(`${baseUrl}/api/public/resource-packs`, {
    headers: { Origin: 'https://desktoppet.online' }
  }));
  assert.equal(emptyPublic.response.status, 200);
  assert.equal(emptyPublic.response.headers.get('access-control-allow-origin'), 'https://desktoppet.online');
  assert.deepEqual(emptyPublic.payload.packs, []);

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'resource pack admin password' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const adminHeaders = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': login.payload.csrfToken
  };

  const invalidCategory = await jsonResponse(await fetch(`${baseUrl}/api/admin/resource-packs`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      category: 'unknown',
      title: '无效资源',
      description: '不应创建',
      fileName: 'invalid.zip',
      fileSize: 22
    })
  }));
  assert.equal(invalidCategory.response.status, 400);
  assert.equal(invalidCategory.payload.code, 'INVALID_RESOURCE_PACK_CATEGORY');

  const invalidPayload = Buffer.from('this is not a zip', 'utf8');
  const invalidPreflight = await jsonResponse(await fetch(`${baseUrl}/api/admin/resource-packs`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      category: 'interaction-words',
      title: '无效 ZIP',
      description: '用于验证文件头',
      fileName: 'invalid.zip',
      fileSize: invalidPayload.length
    })
  }));
  const invalidUpload = await jsonResponse(await fetch(`${baseUrl}${invalidPreflight.payload.uploadUrl}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': login.payload.csrfToken },
    body: invalidPayload
  }));
  assert.equal(invalidUpload.response.status, 400);
  assert.equal(invalidUpload.payload.code, 'INVALID_ZIP');

  const zip = createStoredZip('office.json', JSON.stringify({ reactions: { idle: ['一起认真工作。'], happy: ['今天真不错。'] } }));
  const preflight = await jsonResponse(await fetch(`${baseUrl}/api/admin/resource-packs`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      category: 'interaction-words',
      title: '打工人日常词包',
      description: '包含办公室日常互动台词。',
      fileName: 'office-words.zip',
      fileSize: zip.length
    })
  }));
  assert.equal(preflight.response.status, 201);
  assert.match(preflight.payload.uploadUrl, /^\/api\/admin\/resource-pack-uploads\//);

  const upload = await jsonResponse(await fetch(`${baseUrl}${preflight.payload.uploadUrl}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': login.payload.csrfToken },
    body: zip
  }));
  assert.equal(upload.response.status, 201);
  assert.equal(upload.payload.pack.category, 'interaction-words');
  assert.equal(upload.payload.pack.title, '打工人日常词包');
  assert.equal(upload.payload.pack.sha256, crypto.createHash('sha256').update(zip).digest('hex'));
  assert.equal(upload.payload.pack.fileCount, 1);
  assert.equal(upload.payload.pack.kind, 'wordpack');
  assert.equal(upload.payload.pack.status, 'published');
  assert.equal(upload.payload.pack.free, true);
  assert.equal(upload.payload.pack.priceFen, 0);
  assert.equal(upload.payload.pack.sizeBytes, zip.length);

  const adminList = await jsonResponse(await fetch(`${baseUrl}/api/admin/resource-packs`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(adminList.response.status, 200);
  assert.equal(adminList.payload.packs.length, 1);

  const publicList = await jsonResponse(await fetch(`${baseUrl}/api/public/resource-packs`));
  assert.equal(publicList.response.status, 200);
  assert.equal(publicList.payload.packs.length, 1);
  const downloadPath = new URL(publicList.payload.packs[0].url).pathname;
  const download = await fetch(`${baseUrl}${downloadPath}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), zip);

  const id = upload.payload.pack.id;
  async function update(body, headers = adminHeaders) {
    return jsonResponse(await fetch(`${baseUrl}/api/admin/resource-packs/${id}`, {
      method: 'PATCH', headers, body: JSON.stringify(body)
    }));
  }
  assert.equal((await update({ title: '新名字' }, { 'Content-Type': 'application/json' })).response.status, 401);
  assert.equal((await update({ title: '新名字' }, { Cookie: cookie, 'Content-Type': 'application/json' })).response.status, 403);
  assert.equal((await update({ priceFen: 280 })).response.status, 400);
  assert.equal((await update({ category: 'theater-scripts' })).response.status, 400, 'category must match actual archive schema');
  const renamed = await update({ title: '工作日互动词库', description: '更新的简介', category: 'wordpack' });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.payload.pack.title, '工作日互动词库');
  assert.equal(renamed.payload.pack.sha256, upload.payload.pack.sha256);
  assert.equal((await jsonResponse(await fetch(`${baseUrl}/api/public/resource-packs?kind=theater`))).payload.packs.length, 0);
  assert.equal((await jsonResponse(await fetch(`${baseUrl}/api/public/resource-packs?kind=wordpack`))).payload.packs.length, 1);
  const unlisted = await update({ status: 'unlisted' });
  assert.equal(unlisted.response.status, 200);
  assert.equal((await jsonResponse(await fetch(`${baseUrl}/api/public/resource-packs`))).payload.packs.length, 0);
  assert.equal((await fetch(`${baseUrl}${downloadPath}`)).status, 404);
  assert.equal((await jsonResponse(await fetch(`${baseUrl}/api/admin/resource-packs`, { headers: { Cookie: cookie } }))).payload.packs.length, 1);
  assert.equal((await update({ status: 'published' })).response.status, 200);
  assert.equal((await fetch(`${baseUrl}${downloadPath}`)).status, 200);
  const reopened = new ResourcePackStore(dataDirectory);
  await reopened.initialize();
  assert.equal(reopened.find(id).title, '工作日互动词库');
  assert.equal(reopened.find(id).installable, true);

  const deleted = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/resource-packs/${upload.payload.pack.id}`,
    { method: 'DELETE', headers: adminHeaders }
  ));
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.payload.ok, true);
  const missingDownload = await fetch(`${baseUrl}${downloadPath}`);
  assert.equal(missingDownload.status, 404);
});

test('legacy empty ZIPs remain visible to administrators but are excluded from free installable resources', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-resource-migration-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(directory, 'resource-packs'));
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  await fs.promises.writeFile(path.join(directory, 'resource-packs', 'legacy.zip'), bytes);
  await fs.promises.writeFile(path.join(directory, 'resource-packs.json'), JSON.stringify({ schemaVersion: 1, packs: [{
    id: 'legacy', category: 'interaction-words', title: '旧空包', description: '旧包', fileName: 'legacy.zip', originalName: 'legacy.zip',
    size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), createdAt: '2026-10-01T00:00:00.000Z'
  }] }));
  const store = new ResourcePackStore(directory);
  await store.initialize();
  const service = new ResourcePackService({ config: { publicUrl: 'http://127.0.0.1' }, resourcePackStore: store, auditService: {} });
  assert.equal(service.list().packs.length, 1);
  assert.equal(service.list().packs[0].installable, false);
  assert.match(service.list().packs[0].validationError, /ZIP/);
  assert.deepEqual(service.publicList(), []);
  await assert.rejects(() => service.download('legacy'), { status: 404 });
});

test('free resource downloads return the verified bytes and reject runtime tampering or missing files', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-resource-integrity-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new ResourcePackStore(directory);
  await store.initialize();
  const service = new ResourcePackService({ config: { publicUrl: 'http://127.0.0.1' }, resourcePackStore: store, auditService: {} });
  const bytes = createStoredZip('words.json', JSON.stringify({ idle: ['你好'] }));
  for (const damage of ['same-size', 'truncate', 'missing']) {
    const temporaryPath = store.uploadPath(crypto.randomUUID());
    await fs.promises.writeFile(temporaryPath, bytes);
    const pack = await store.commitUpload({ temporaryPath, category: 'interaction-words', title: damage, description: '测试',
      originalName: 'words.zip', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), fileCount: 1 });
    const valid = await service.download(pack.id);
    assert.deepEqual(valid.bytes, bytes);
    if (damage === 'missing') await fs.promises.rm(store.filePath(pack));
    else {
      const tampered = Buffer.from(bytes);
      tampered[0] ^= 1;
      await fs.promises.writeFile(store.filePath(pack), damage === 'truncate' ? tampered.subarray(0, 10) : tampered);
    }
    await assert.rejects(() => service.download(pack.id), { status: 404, code: 'RESOURCE_PACK_NOT_FOUND' });
    assert.equal(service.publicList().some(item => item.id === pack.id), false);
    assert.deepEqual(valid.bytes, bytes, 'previously verified byte buffer is stable after path mutation');
  }
});
