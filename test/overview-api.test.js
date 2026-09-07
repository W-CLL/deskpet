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

test('overview endpoint returns ops content and tech KPIs', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-overview-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('OverviewTest123!');
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

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'OverviewTest123!' })
  }));
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];

  const overview = await jsonResponse(await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(overview.response.status, 200);
  assert.equal(typeof overview.payload.ops.pageViews7d, 'number');
  assert.equal(typeof overview.payload.content.activeRate, 'number');
  assert.ok(Array.isArray(overview.payload.todos));
  assert.ok(overview.payload.tech.releaseCounts);

  const adminPage = await fetch(`${baseUrl}/admin`);
  assert.equal(adminPage.status, 200);
  const html = await adminPage.text();
  assert.match(html, /overviewKpiGrid/);
  assert.match(html, /data-page-panel="settings"/);
});
