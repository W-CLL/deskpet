const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createApplication } = require('../server');

const root = path.join(__dirname, '..');
const themeScript = fs.readFileSync(path.join(root, 'public/admin/js/core/theme.js'), 'utf8');
const storageKey = 'deskpet-admin-theme';

function loadPage(storage = new Map(), storageBlocked = false) {
  const attributes = new Map();
  const listeners = new Map();
  const button = { addEventListener: (name, callback) => listeners.set(`button:${name}`, callback) };
  const context = vm.createContext({
    document: {
      documentElement: {
        getAttribute: (name) => attributes.get(name),
        setAttribute: (name, value) => attributes.set(name, value)
      },
      addEventListener: (name, callback) => listeners.set(name, callback),
      querySelector: (selector) => selector === '#themeToggleButton' ? button : null
    },
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    localStorage: {
      getItem: (name) => {
        if (storageBlocked) throw new Error('Storage unavailable');
        return storage.get(name) ?? null;
      },
      setItem: (name, value) => {
        if (storageBlocked) throw new Error('Storage unavailable');
        storage.set(name, value);
      }
    }
  });
  vm.runInContext(themeScript, context);
  return {
    theme: () => attributes.get('data-theme'),
    ready: () => listeners.get('DOMContentLoaded')(),
    click: () => listeners.get('button:click')(),
    storageEvent: (event) => listeners.get('storage')(event),
    button
  };
}

test('admin theme restores both saved choices before the page becomes interactive', () => {
  const storage = new Map([[storageKey, 'light']]);
  let page = loadPage(storage);
  assert.equal(page.theme(), 'light');
  page.ready();
  assert.equal(page.button.textContent, '暗色');
  page.click();
  assert.equal(page.theme(), 'dark');
  assert.equal(storage.get(storageKey), 'dark');
  assert.equal(page.button.title, '切换到浅色主题');

  page = loadPage(storage);
  assert.equal(page.theme(), 'dark', 'refresh must preserve the selected dark theme');
  page.ready();
  page.click();
  assert.equal(storage.get(storageKey), 'light');
  page = loadPage(storage);
  assert.equal(page.theme(), 'light', 'refresh must also preserve the selected light theme');
});

test('admin theme has a usable default when storage is empty, invalid or unavailable', () => {
  for (const value of [undefined, '', 'unknown']) {
    assert.equal(loadPage(new Map([[storageKey, value]])).theme(), 'dark');
  }
  const page = loadPage(new Map(), true);
  assert.equal(page.theme(), 'dark');
  page.ready();
  assert.doesNotThrow(() => page.click());
  assert.equal(page.theme(), 'light');
});

test('admin theme and toggle label follow theme changes from another tab', () => {
  const page = loadPage();
  page.ready();
  page.storageEvent({ key: storageKey, newValue: 'light' });
  assert.equal(page.theme(), 'light');
  assert.equal(page.button.textContent, '暗色');
  page.storageEvent({ key: 'unrelated-setting', newValue: 'dark' });
  assert.equal(page.theme(), 'light');
  page.storageEvent({ key: null, newValue: null });
  assert.equal(page.theme(), 'dark');
});

test('admin serves the theme bootstrap as an allowed same-origin script before CSS', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-admin-theme-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1', dataDirectory, cookieSecure: false, signingPrivateKey: privateKey
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/admin`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /(?:^|;\s*)script-src 'self'(?:;|$)/);
  const html = await response.text();
  assert.match(html, /\/js\/main\.js\?v=admin-theme-1/, 'old cached main script must not bind a second theme handler');
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/i, 'inline scripts would be blocked by CSP');
  const bootstrap = html.match(/<script\b[^>]*src="([^"]*\/core\/theme\.js[^"]*)"[^>]*>/);
  assert.ok(bootstrap, 'theme bootstrap must load from the served admin page');
  assert.doesNotMatch(bootstrap[0], /\b(?:async|defer|type="module")\b/);
  assert.ok(html.indexOf(bootstrap[0]) < html.indexOf('<link rel="stylesheet"'), 'saved theme must apply before CSS paints');
  const scriptUrl = new URL(bootstrap[1], baseUrl);
  assert.equal(scriptUrl.origin, baseUrl);
  const scriptResponse = await fetch(scriptUrl);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get('content-type'), /javascript/);
  assert.equal(await scriptResponse.text(), themeScript);
});

test('admin page generation and head repair preserve the CSP-compatible theme bootstrap', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-admin-theme-generation-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(directory, 'public/admin'), { recursive: true });
  await fs.promises.mkdir(path.join(directory, 'scripts'));
  await fs.promises.copyFile(path.join(root, 'public/admin.html'), path.join(directory, 'public/admin.html'));
  for (const script of ['assemble-admin.js', 'fix-theme-head.js']) {
    const scriptPath = path.join(directory, 'scripts', script);
    await fs.promises.copyFile(path.join(root, 'scripts', script), scriptPath);
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const html = await fs.promises.readFile(path.join(directory, 'public/admin/index.html'), 'utf8');
    assert.match(html, /<html lang="zh-CN" data-theme="dark">/);
    assert.match(html, /id="themeToggleButton"/);
    assert.match(html, /\/js\/main\.js\?v=admin-theme-1/);
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
    assert.ok(html.indexOf('/core/theme.js') < html.indexOf('<link rel="stylesheet"'));
  }
});
