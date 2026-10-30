const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { JSDOM, VirtualConsole } = require('jsdom');
const { validateAdminPage } = require('../scripts/assemble-admin');

const publicRoot = path.join(__dirname, '..', 'public');
const canonicalHtml = fs.readFileSync(path.join(publicRoot, 'admin/index.html'), 'utf8');
const expectedPages = [
  'overview', 'settings', 'releases', 'resource-packs', 'pet-market', 'pet-market-orders',
  'visit-stickers', 'activations', 'interactions', 'companions', 'analytics',
  'content', 'feedback', 'uninstalls'
];

function createAdminDocument(context, html = canonicalHtml) {
  const errors = [];
  const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://admin.invalid/admin',
    runScripts: 'outside-only',
    virtualConsole
  });
  context.after(() => dom.window.close());
  const { window } = dom;
  window.Headers = Headers;
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.scrollTo = () => {};
  window.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body });
    if (url === '/api/admin/session') return Response.json({ authenticated: false });
    if (url === '/api/admin/login') return Response.json({ error: '登录回归测试：凭据未通过' }, { status: 401 });
    throw new Error(`Unexpected startup request: ${url}`);
  };

  function boot() {
    let initializedPages;
    for (const script of window.document.querySelectorAll('script[src]')) {
      const scriptUrl = new URL(script.src);
      assert.equal(scriptUrl.origin, window.location.origin);
      assert.ok(scriptUrl.pathname.startsWith('/assets/admin/js/'));
      const scriptPath = path.join(publicRoot, scriptUrl.pathname.slice('/assets/'.length));
      if (scriptUrl.pathname.endsWith('/main.js')) {
        const createPages = window.createAdminPages;
        window.createAdminPages = (pageContext) => {
          const pages = createPages(pageContext);
          initializedPages = pages.map((page) => page.id);
          return pages;
        };
      }
      window.eval(`${fs.readFileSync(scriptPath, 'utf8')}\n//# sourceURL=${scriptUrl.pathname}`);
    }
    return initializedPages;
  }

  return { window, requests, errors, boot };
}

test('the canonical admin page boots every real page factory and binds login submission', async (context) => {
  assert.doesNotThrow(() => validateAdminPage(canonicalHtml));
  const { window, requests, errors, boot } = createAdminDocument(context);
  assert.deepEqual(Array.from(boot()), expectedPages);
  await nextTurn();
  assert.deepEqual(requests.map((request) => request.url), ['/api/admin/session']);
  assert.equal(window.document.getElementById('loginView').hidden, false);
  assert.equal(window.document.getElementById('adminView').hidden, true);

  // Verify the added pages really rendered, including their interactive controls.
  for (const id of ['petMarketForm', 'petMarketPaymentForm', 'petMarketOrdersRoot', 'uninstallsRoot']) {
    assert.ok(window.document.getElementById(id), `missing initialized control: ${id}`);
  }
  for (const route of ['pet-market', 'pet-market-orders', 'uninstalls', 'settings', 'analytics/devices']) {
    window.document.querySelector(`[data-route="${route}"]`).click();
    assert.equal(window.location.hash, `#${route}`);
    assert.equal(window.document.querySelector(`[data-page-panel="${route.split('/')[0]}"]`).hidden, false);
  }

  const form = window.document.getElementById('loginForm');
  form.elements.username.value = 'regression-admin';
  form.elements.password.value = 'only-an-isolated-test';
  const event = new window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'login must be handled by the application');
  await nextTurn();
  const loginRequests = requests.filter((request) => request.url === '/api/admin/login');
  assert.equal(loginRequests.length, 1, 'one submit must send exactly one login request');
  assert.equal(loginRequests[0].method, 'POST');
  assert.deepEqual(JSON.parse(loginRequests[0].body), {
    username: 'regression-admin', password: 'only-an-isolated-test'
  });
  assert.equal(window.document.getElementById('loginError').textContent, '登录回归测试：凭据未通过');
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
  assert.deepEqual(errors, []);
});

test('startup regression detects missing settings DOM before a login listener can be installed', (context) => {
  const incompleteHtml = canonicalHtml.replace('id="activationQrFile"', 'id="missingActivationQrFile"');
  assert.throws(() => validateAdminPage(incompleteHtml), /missing element: activationQrFile/);
  const { window, requests, boot } = createAdminDocument(context, incompleteHtml);
  assert.throws(boot, /addEventListener/);
  const event = new window.Event('submit', { bubbles: true, cancelable: true });
  window.document.getElementById('loginForm').dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(requests, []);
});
