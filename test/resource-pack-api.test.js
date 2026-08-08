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

  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
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
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), zip);

  const deleted = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/resource-packs/${upload.payload.pack.id}`,
    { method: 'DELETE', headers: adminHeaders }
  ));
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.payload.ok, true);
  const missingDownload = await fetch(`${baseUrl}${downloadPath}`);
  assert.equal(missingDownload.status, 404);
});
