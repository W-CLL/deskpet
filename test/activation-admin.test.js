const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { ReleaseStore } = require('../lib/storage');
const { normalizeActivationSettings } = require('../lib/activation-settings');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

async function fixture(context) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-activation-admin-'));
  const password = 'activation admin test password';
  await fs.promises.writeFile(path.join(directory, 'auth.json'), JSON.stringify(await hashPassword(password)));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const application = await createApplication({ dataDirectory: directory, publicUrl: 'http://127.0.0.1',
    cookieSecure: false, signingPrivateKey: privateKey });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    application.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  async function request(url, method = 'GET', body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const login = await request('/api/admin/login', 'POST', { username: 'admin', password });
  assert.equal(login.status, 200);
  const admin = { Cookie: login.headers.get('set-cookie').split(';', 1)[0], 'X-CSRF-Token': login.body.csrfToken };
  async function device(platform = 'windows') {
    const identity = { installationId: crypto.randomBytes(16).toString('hex'),
      credential: crypto.randomBytes(32).toString('base64url'), appVersion: '3.4.2' };
    assert.equal((await request('/api/trial', 'POST', identity, { 'X-DeskPet-Platform': platform })).status, 200);
    return identity;
  }
  return { application, directory, request, admin, device };
}

test('activation configuration validates PNG and text without accepting executable or oversized images', () => {
  assert.equal(normalizeActivationSettings({ qrCodeDataUrl: PNG }).qrCodeDataUrl, PNG);
  assert.throws(() => normalizeActivationSettings({ title: '' }), /激活页标题/);
  assert.throws(() => normalizeActivationSettings({ description: '长'.repeat(501) }), /激活页文案/);
  for (const image of ['https://example.com/qr.png', 'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,YmFk', `data:image/png;base64,${'A'.repeat(350_000)}`]) {
    assert.throws(() => normalizeActivationSettings({ qrCodeDataUrl: image }), /激活页二维码/);
  }
  const image = Buffer.from(PNG.split(',')[1], 'base64');
  image.writeUInt32BE(2049, 16);
  assert.throws(() => normalizeActivationSettings({ qrCodeDataUrl: `data:image/png;base64,${image.toString('base64')}` }), /2048/);
});

test('admin activation settings persist, are public without login, and retain previous values on invalid updates', async (context) => {
  const { application, directory, request, admin } = await fixture(context);
  const activation = { title: '扫码联系作者', description: '新的说明\n支持两台设备', qrCodeDataUrl: PNG };
  assert.equal((await request('/api/admin/site-settings', 'PUT', { activation })).status, 401);
  assert.equal((await request('/api/admin/site-settings', 'PUT', { activation }, { Cookie: admin.Cookie })).status, 403);
  assert.equal((await request('/api/admin/site-settings', 'PUT', { activation, wechatId: 'new_wechat123' }, admin)).status, 200);
  const publicSettings = await request('/api/public/site-settings');
  assert.equal(publicSettings.headers.get('cache-control'), 'no-store');
  assert.deepEqual(publicSettings.body.activation, activation);
  assert.equal(publicSettings.body.wechatId, 'new_wechat123');
  const reopened = new ReleaseStore(directory);
  await reopened.initialize();
  assert.deepEqual(reopened.siteSettings().activation, activation);
  const copy = application.store.siteSettings();
  copy.activation.title = '不得修改存储';
  assert.equal(application.store.siteSettings().activation.title, activation.title);
  assert.equal((await request('/api/admin/site-settings', 'PUT', { activation: { qrCodeDataUrl: 'bad' } }, admin)).status, 400);
  assert.deepEqual((await request('/api/public/site-settings')).body.activation, activation);
  await request('/api/admin/site-settings', 'PUT', { announcement: '其他设置' }, admin);
  assert.deepEqual((await request('/api/public/site-settings')).body.activation, activation);
  await request('/api/admin/site-settings', 'PUT', { activation: { qrCodeDataUrl: '' } }, admin);
  assert.equal((await request('/api/public/site-settings')).body.activation.qrCodeDataUrl, '');
});

test('manual activation targets a registered identity and only its saved credential can claim authorization', async (context) => {
  const { application, directory, request, admin, device } = await fixture(context);
  const target = await device('android');
  const other = await device('macos');
  const code = application.activationStore.createCodes({ count: 1 }).codes[0];
  const body = { installationId: target.installationId, code };
  assert.equal((await request('/api/admin/devices/activate', 'POST', body)).status, 401);
  assert.equal((await request('/api/admin/devices/activate', 'POST', body, { Cookie: admin.Cookie })).status, 403);
  assert.equal((await request('/api/admin/devices/activate', 'POST', { ...body, installationId: target.installationId.slice(-8) }, admin)).status, 409);
  assert.equal((await request('/api/admin/devices/activate', 'POST', { ...body, installationId: 'unregistered-device-000000' }, admin)).status, 409);
  const profile = application.companionStore.ensureProfile(`trial:${target.installationId}`);
  const activated = await request('/api/admin/devices/activate', 'POST', body, admin);
  assert.equal(activated.status, 201);
  assert.equal(application.companionStore.ensureProfile(activated.body.accountId).display_name, profile.display_name);
  assert.equal(application.activationStore.database.prepare('SELECT platform FROM licenses WHERE id = ?')
    .get(activated.body.licenseId).platform, 'android');
  const synced = await request('/api/trial', 'POST', target);
  assert.equal(synced.body.license.licenseId, activated.body.licenseId);
  assert.equal(synced.body.allowed, false);
  assert.ok(!JSON.stringify(synced.body).includes(target.credential));
  assert.equal((await request('/api/trial', 'POST', { ...target, credential: other.credential })).body.license, undefined);
  assert.equal((await request('/api/trial', 'POST', other)).body.license, undefined);
  assert.equal((await request('/api/admin/devices/activate', 'POST', { installationId: other.installationId, code }, admin)).status, 201);
  const third = await device();
  const limited = await request('/api/admin/devices/activate', 'POST', { installationId: third.installationId, code }, admin);
  assert.equal(limited.status, 409);
  assert.equal(limited.body.code, 'ACCOUNT_DEVICE_LIMIT');
  const rebind = application.activationStore.createRebindCode(activated.body.accountId).codes[0];
  assert.equal((await request('/api/admin/devices/activate', 'POST', { installationId: third.installationId, code: rebind }, admin)).status, 409);
  await request(`/api/admin/licenses/${activated.body.licenseId}/revoke`, 'POST', undefined, admin);
  assert.equal((await request('/api/trial', 'POST', target)).body.license, undefined);
  assert.equal(application.activationStore.authenticate(`Bearer ${activated.body.licenseId}.${target.credential}`), null);
  const audit = await fs.promises.readFile(path.join(directory, 'audit.jsonl'), 'utf8');
  assert.ok(audit.includes('admin-device-activate'));
  assert.ok(!audit.includes(target.credential));
  assert.ok(!audit.includes(code));
});

test('an administrator can activate only by device code without preparing a purchase code', async (context) => {
  const { application, request, admin, device } = await fixture(context);
  const target = await device();
  const before = application.activationStore.list().codes.length;
  assert.equal((await request('/api/admin/devices/activate', 'POST', { installationId: 'unknown-device-1234567890' }, admin)).status, 409);
  assert.equal(application.activationStore.list().codes.length, before);
  const result = await request('/api/admin/devices/activate', 'POST', { installationId: target.installationId }, admin);
  assert.equal(result.status, 201);
  assert.match(result.body.activationCode, /^[A-HJ-NP-Z2-9]{6}$/);
  const synced = await request('/api/trial', 'POST', target);
  assert.equal(synced.body.license.licenseId, result.body.licenseId);
  assert.equal(synced.body.license.activationCode, undefined);
  const second = await device();
  const license = application.activationStore.activate({ ...second, code: result.body.activationCode });
  assert.equal(license.accountId, result.body.accountId);
  assert.equal(license.deviceCount, 2);
  assert.equal((await request('/api/admin/devices/activate', 'POST', { installationId: target.installationId }, admin)).status, 409);
  assert.equal(application.activationStore.list().codes.length, before + 1);
});
