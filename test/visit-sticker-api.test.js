const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeGif() {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = zlib.deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    chunks.push(local, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const directoryOffset = offset;
  const directorySize = central.reduce((sum, item) => sum + item.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directorySize, 12);
  eocd.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

async function jsonResponse(response) {
  return { response, payload: await response.json() };
}

test('admin can upload categorized visit stickers and trial devices play them', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-visit-stickers-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('visit sticker admin password');
  await fs.promises.writeFile(path.join(dataDirectory, 'auth.json'), JSON.stringify(authRecord), { mode: 0o600 });
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

  const installationId = crypto.randomBytes(16).toString('hex');
  const credential = crypto.randomBytes(32).toString('base64url');
  const trial = await jsonResponse(await fetch(`${baseUrl}/api/trial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, credential, appVersion: '3.1.9' })
  }));
  assert.equal(trial.response.status, 200);
  const trialHeaders = {
    Authorization: `Trial ${installationId}.${credential}`,
    'Content-Type': 'application/json'
  };

  const emptyPlay = await jsonResponse(await fetch(`${baseUrl}/api/trial/visit-stickers/play`, {
    method: 'POST',
    headers: trialHeaders,
    body: JSON.stringify({ category: 'girlfriend' })
  }));
  assert.equal(emptyPlay.response.status, 404);
  assert.equal(emptyPlay.payload.code, 'VISIT_STICKER_EMPTY');

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'visit sticker admin password' })
  }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const adminHeaders = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': login.payload.csrfToken
  };

  const zip = makeZip([
    { name: 'girlfriend/wave.gif', data: makeGif() },
    { name: 'girlfriend/sit.gif', data: makeGif() }
  ]);
  const preflight = await jsonResponse(await fetch(`${baseUrl}/api/admin/visit-stickers`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      category: 'girlfriend',
      title: '下班来串门',
      note: '两张挥手和坐下',
      fileName: 'girlfriend.zip',
      fileSize: zip.length
    })
  }));
  assert.equal(preflight.response.status, 201);
  const uploaded = await jsonResponse(await fetch(`${baseUrl}${preflight.payload.uploadUrl}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': login.payload.csrfToken },
    body: zip
  }));
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.payload.pack.category, 'girlfriend');
  assert.equal(uploaded.payload.pack.stickerCount, 2);

  const adminList = await jsonResponse(await fetch(`${baseUrl}/api/admin/visit-stickers`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(adminList.response.status, 200);
  assert.equal(adminList.payload.counts.girlfriend, 2);

  const catalog = await jsonResponse(await fetch(`${baseUrl}/api/trial/visit-stickers`, {
    headers: trialHeaders
  }));
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.payload.categories.find((item) => item.id === 'girlfriend').count, 2);

  const played = await jsonResponse(await fetch(`${baseUrl}/api/trial/visit-stickers/play`, {
    method: 'POST',
    headers: trialHeaders,
    body: JSON.stringify({ category: 'girlfriend' })
  }));
  assert.equal(played.response.status, 200);
  assert.equal(played.payload.senderName, '女友');
  assert.match(played.payload.downloadPath, /^\/api\/trial\/visit-stickers\//);

  const file = await fetch(`${baseUrl}${played.payload.downloadPath}`, {
    headers: { Authorization: `Trial ${installationId}.${credential}` }
  });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/gif');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), makeGif());

  const tooSoon = await jsonResponse(await fetch(`${baseUrl}/api/trial/visit-stickers/play`, {
    method: 'POST',
    headers: trialHeaders,
    body: JSON.stringify({ category: 'girlfriend', excludeId: played.payload.id })
  }));
  assert.equal(tooSoon.response.status, 429);
  assert.equal(tooSoon.payload.code, 'VISIT_STICKER_COOLDOWN');

  const code = application.activationStore.createCodes({ count: 1 }).codes[0];
  const paidCredential = crypto.randomBytes(32).toString('base64url');
  const activated = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential: paidCredential,
      appVersion: '3.1.9'
    })
  }));
  const paidPlay = await jsonResponse(await fetch(`${baseUrl}/api/trial/visit-stickers/play`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${activated.payload.licenseId}.${paidCredential}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ category: 'girlfriend' })
  }));
  assert.equal(paidPlay.response.status, 403);
  assert.equal(paidPlay.payload.code, 'VISIT_STICKER_TRIAL_ONLY');
});
