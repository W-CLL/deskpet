const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/admin/js/pages/uninstalls.js'), 'utf8');

function element() {
  const handlers = new Map();
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, className: '', childNodes: [],
    append(...nodes) { this.childNodes.push(...nodes); },
    replaceChildren(...nodes) { this.childNodes = nodes; },
    addEventListener(name, handler) { handlers.set(name, handler); },
    dispatch(name) { return handlers.get(name)?.({ preventDefault() {} }); }
  };
}

function harness(responder) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  let factory;
  let rows = [];
  let drawer;
  const calls = [];
  const copies = [];
  const context = vm.createContext({
    registerAdminPage: callback => { factory = callback; }, URLSearchParams,
    document: { createElement: () => element() },
    navigator: { clipboard: { writeText: async value => { copies.push(value); } } },
    globalThis: { AdminFormKit: { openDrawer: value => { drawer = value; }, closeDrawer() {} } }
  });
  vm.runInContext(script, context);
  const ui = {
    byId: node,
    cell: (className, text) => ({ ...element(), className, textContent: text || '' }),
    stackedCell: (className, ...parts) => ({ ...element(), className, parts }),
    actionButton: (label, className, action) => ({ ...element(), label, className, action }),
    actionsCell: (...buttons) => ({ buttons }),
    fillTable: (body, items, render, empty) => {
      rows = items.map(render);
      body.replaceChildren(...rows);
      empty.hidden = items.length > 0;
    },
    formatDate: value => `date:${value}`
  };
  const page = factory({
    ui,
    api: async route => { calls.push(route); return responder(route); },
    showToast() {}
  });
  node('uninstallPageSize').value = '25';
  return { page, node, calls, copies, rows: () => rows, drawer: () => drawer };
}

function listPayload(overrides = {}) {
  return {
    devices: [], total: 0, page: 1, pageSize: 25, serverTime: '2026-10-29T08:00:00Z',
    summary: { total: 3, installed: 1, uninstallReported: 1, restored: 1, intents: 2, completedEvents: 1 },
    ...overrides
  };
}

test('uninstall records render lifecycle state and literal device feedback', async () => {
  const device = {
    installationId: '0123456789abcdef0123456789abcdef', deviceCode: '456789abcdef',
    accountId: 'account-complete-1234567890', licenseId: 'license-a',
    displayName: '<img src=x onerror=alert(1)>', platform: 'windows', appVersion: '3.4.4',
    status: 'uninstall_reported', latestReason: 'other', latestComment: '<svg onload=alert(1)>',
    latestFeedbackAt: '2026-10-29T07:30:00Z', lastUninstallAt: '2026-10-29T07:31:00Z', lastRestoredAt: null,
    currentInstallBatchId: '11111111-1111-4111-8111-111111111111',
    currentInstallBatchCreatedAt: '2026-10-29T07:00:00Z'
  };
  const details = {
    device,
    events: [
      { eventType: 'uninstall_completed', occurredAt: device.lastUninstallAt, platform: 'windows',
        appVersion: '3.4.4', installBatchId: device.currentInstallBatchId, reason: 'other',
        comment: device.latestComment, ignoredAsStale: false, ignoredReason: null },
      { eventType: 'uninstall_intent', occurredAt: device.latestFeedbackAt, platform: 'windows',
        appVersion: '3.4.4', installBatchId: device.currentInstallBatchId, reason: 'other',
        comment: device.latestComment, ignoredAsStale: false, ignoredReason: null }
    ]
  };
  const app = harness(async route => route.includes(`/${device.installationId}`)
    ? details : listPayload({ devices: [device], total: 1 }));
  await app.page.load();
  assert.equal(app.node('uninstallDeviceTotal').textContent, '3');
  assert.equal(app.node('uninstallReportedTotal').textContent, '1');
  assert.match(app.node('uninstallsNotice').textContent, /可信卸载完成事件 1 条/);
  assert.equal(app.rows()[0][0].parts[0], device.displayName);
  assert.equal(app.rows()[0][3].parts[0], `其他：${device.latestComment}`);
  assert.equal(app.rows()[0][2].childNodes[0].textContent, '已报告卸载');
  assert.equal(app.rows()[0][0].innerHTML, '');

  await app.rows()[0][5].buttons[0].action();
  const body = app.drawer().body;
  const fields = body.childNodes[1].childNodes;
  assert.ok(fields.some(item => item.textContent === device.installationId));
  assert.ok(fields.some(item => item.textContent === device.accountId));
  assert.ok(fields.some(item => item.textContent === device.licenseId));
  assert.equal(fields.find(item => item.textContent === device.displayName).innerHTML, '');
  assert.equal(body.childNodes[3].childNodes.at(-1).textContent, device.latestComment);
  await app.drawer().footer.find(button => button.label === '复制设备码').action();
  assert.deepEqual(app.copies, [device.installationId]);
});

test('skip feedback stays explicit and stale completion is visible in history', async () => {
  const device = {
    installationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', deviceCode: 'aaaaaaaaaaaa', accountId: 'account-a',
    displayName: '桌搭子', platform: 'macos', appVersion: '3.4.4', status: 'restored',
    latestReason: null, latestComment: '', latestFeedbackAt: '2026-10-29T07:00:00Z',
    lastUninstallAt: '2026-10-29T06:00:00Z', lastRestoredAt: '2026-10-29T08:00:00Z'
  };
  const app = harness(async route => route.includes(`/${device.installationId}`)
    ? { device, events: [{ eventType: 'uninstall_completed', occurredAt: '2026-10-29T09:00:00Z',
      platform: 'macos', appVersion: '3.4.4', installBatchId: 'old-batch', reason: null, comment: '',
      ignoredAsStale: true, ignoredReason: 'stale_batch' }] }
    : listPayload({ devices: [device], total: 1 }));
  await app.page.load();
  assert.equal(app.rows()[0][3].parts[0], '跳过反馈');
  assert.equal(app.rows()[0][2].childNodes[0].textContent, '重装后恢复');
  await app.rows()[0][5].buttons[0].action();
  assert.match(app.drawer().body.childNodes[3].childNodes[1].textContent, /未改状态（stale_batch）/);
});

test('pagination and filters query the server while failures remain distinct from empty data', async () => {
  const pending = [];
  const app = harness(route => new Promise((resolve, reject) => pending.push({ route, resolve, reject })));
  const older = app.page.load();
  app.node('uninstallSearch').value = '  设备 & 昵称  ';
  app.node('uninstallStatus').value = 'restored';
  const newer = app.node('uninstallStatus').dispatch('change');
  pending[1].resolve(listPayload({ total: 26, page: 1 }));
  await newer;
  pending[0].resolve(listPayload({ total: 99, page: 1 }));
  await older;
  const query = new URL(pending[1].route, 'http://test').searchParams;
  assert.equal(query.get('q'), '设备 & 昵称');
  assert.equal(query.get('status'), 'restored');
  assert.match(app.node('uninstallPageInfo').textContent, /共 26 台/);
  assert.equal(app.node('uninstallsNext').disabled, false);

  const next = app.node('uninstallsNext').dispatch('click');
  assert.equal(new URL(pending[2].route, 'http://test').searchParams.get('page'), '2');
  pending[2].resolve(listPayload({ total: 26, page: 2 }));
  await next;
  assert.equal(app.node('uninstallsNext').disabled, true);

  const failing = app.page.load();
  pending[3].reject(new Error('后台连接失败'));
  await failing;
  assert.equal(app.node('uninstallsError').textContent, '后台连接失败');
  assert.equal(app.node('uninstallsError').hidden, false);
  assert.equal(app.node('emptyUninstalls').hidden, true);
  assert.equal(app.node('uninstallDeviceTotal').textContent, '—');
  assert.equal(app.node('refreshUninstalls').disabled, false);
});

test('admin shell and route registration expose the uninstall lifecycle page', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const shell = read('public/admin/index.html');
  assert.match(shell, /data-route="uninstalls"/);
  assert.match(shell, /data-page-panel="uninstalls"/);
  assert.match(shell, /id="uninstallsRoot"/);
  assert.match(shell, /pages\/uninstalls\.js/);
  assert.match(read('public/admin/js/main.js'), /uninstalls: 'uninstalls'/);
  assert.match(read('public/admin/js/pages/uninstalls.js'), /离线、退出、关机、休眠和普通心跳不会推断卸载/);
});
