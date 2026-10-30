const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../public/admin/js/pages/pet-market-orders.js'), 'utf8');

function element(tagName = '') {
  const handlers = new Map();
  return {
    tagName, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, childNodes: [], attributes: {},
    append(...nodes) { this.childNodes.push(...nodes); },
    replaceChildren(...nodes) { this.childNodes = nodes; },
    contains(candidate) { return this === candidate || this.childNodes.some(child => child.contains?.(candidate)); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
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
  const apiCalls = [];
  const copies = [];
  const toasts = [];
  const context = vm.createContext({
    registerAdminPage: callback => { factory = callback; }, URLSearchParams,
    document: { createElement: tagName => element(tagName) },
    navigator: { clipboard: { writeText: async value => { copies.push(value); } } },
    globalThis: { AdminFormKit: {
      openDrawer: value => { drawer = value; node('drawerBody').replaceChildren(value.body); node('editorDrawer').hidden = false; },
      closeDrawer() { node('editorDrawer').hidden = true; }
    } }
  });
  vm.runInContext(script, context);
  const ui = {
    byId: node,
    cell: (className, text) => ({ ...element(), className, textContent: text }),
    stackedCell: (className, ...parts) => ({ ...element(), className, parts }),
    actionButton: (label, className, action) => ({ ...element(), label, className, action }),
    actionsCell: (...buttons) => ({ buttons }),
    fillTable: (body, items, render, empty) => { rows = items.map(render); body.replaceChildren(...rows); empty.hidden = items.length > 0; },
    formatDate: value => `date:${value}`
  };
  const page = factory({ ui, api: async (route, options) => {
    calls.push(route); apiCalls.push({ route, options }); return responder(route, options);
  }, showToast: (...args) => toasts.push(args) });
  node('marketOrderPageSize').value = '25';
  return { page, node, calls, apiCalls, copies, toasts, rows: () => rows, drawer: () => drawer };
}
function descendants(node) { return [node, ...(node.childNodes || []).flatMap(descendants)]; }
function confirmationFields(app) {
  const nodes = descendants(app.drawer().body);
  return {
    note: nodes.find(item => item.name === 'confirmationNote'), received: nodes.find(item => item.name === 'received'),
    error: nodes.find(item => item.className === 'form-error'), form: nodes.find(item => item.tagName === 'form'),
    submit: app.drawer().footer.find(button => button.label === '确认收款并发放'),
    cancel: app.drawer().footer.find(button => button.label === '返回详情')
  };
}
function unpaidOrder(overrides = {}) {
  return { id: 'order-manual', status: 'pending_payment', accountId: 'account-manual', amountFen: 280,
    productId: 'pet-a', productTitle: '蓝色搭子', productVersion: '1.0.0', paymentReference: '123AB',
    buyerDisplayName: '小王', buyerNameSource: 'order_snapshot', buyerDeviceSource: 'order_snapshot',
    buyerInstallationId: '0123456789abcdef0123456789abcdef', buyerDeviceCode: '456789abcdef', buyerPlatform: 'windows',
    createdAt: '2026-10-30T08:00:00Z', expiresAt: '2026-10-30T08:15:00Z', ...overrides };
}
function payload(overrides = {}) {
  return { orders: [], total: 0, page: 1, pageSize: 25, serverTime: '2026-10-29T08:00:00Z',
    summary: { total: 40, pending: 8, paid: 20, canceled: 10, expired: 2, paidAmountFen: 7600 }, ...overrides };
}

test('admin orders render frozen amounts, paid details and literal untrusted text', async () => {
  const order = { id: 'order-a', paymentReference: '123AB', accountId: 'account-complete-1234567890',
    productId: 'pet-a', productTitle: '<img src=x onerror=alert(1)>', productVersion: '1.0.0',
    buyerDisplayName: '<svg onload=alert(1)>', buyerNameSource: 'order_snapshot',
    buyerInstallationId: '0123456789abcdef0123456789abcdef', buyerDeviceCode: '456789abcdef',
    buyerDeviceSource: 'order_snapshot', buyerPlatform: 'windows', accountDevices: [],
    amountFen: 280, status: 'paid', confirmationMethod: 'automatic', createdAt: '2026-10-29T07:30:00Z',
    expiresAt: '2026-10-29T07:45:00Z', paidAt: '2026-10-29T07:32:00Z', canceledAt: null };
  const app = harness(async () => payload({ orders: [order], total: 1 }));
  await app.page.load();
  assert.equal(app.node('marketOrderRevenue').textContent, '¥76.00');
  assert.equal(app.rows()[0][3].textContent, '¥2.80');
  assert.equal(app.rows()[0][1].parts[0], order.productTitle);
  assert.equal(app.rows()[0][2].parts[0], order.buyerDisplayName);
  assert.ok(app.rows()[0][2].parts.includes('下单设备：456789abcdef'));
  assert.ok(app.rows()[0][2].parts.includes('账号：…1234567890'));
  assert.equal(app.rows()[0][4].childNodes[0].textContent, '已付款');
  assert.equal(app.node('marketOrdersNext').disabled, true);
  app.rows()[0][6].buttons[0].action();
  const details = app.drawer().body.childNodes[2].childNodes;
  assert.equal(details.find(item => item.textContent === order.productTitle).innerHTML, '');
  assert.ok(details.some(item => item.textContent === order.accountId));
  assert.equal(details.find(item => item.textContent === order.buyerDisplayName).innerHTML, '');
  assert.ok(details.some(item => item.textContent === order.buyerInstallationId));
  assert.ok(details.some(item => item.textContent === 'Windows'));
  assert.ok(details.some(item => item.textContent === `date:${order.paidAt}`));
  assert.match(app.drawer().body.childNodes[1].textContent, /付款验证成功/);
  await app.drawer().footer.find(button => button.label === '复制设备码').action();
  assert.deepEqual(app.copies, [order.buyerInstallationId]);
});

test('legacy orders label current profile and linked devices as references without inventing an ordering device', async () => {
  const order = { id: 'legacy', accountId: 'account-legacy', buyerDisplayName: '小蓝',
    buyerNameSource: 'current_profile', buyerDeviceSource: 'unknown', buyerInstallationId: null,
    accountDevices: [
      { installationId: '00000000000000000000aaaaaaaaaaaa', deviceCode: 'aaaaaaaaaaaa', platform: 'windows' },
      { installationId: '00000000000000000000bbbbbbbbbbbb', deviceCode: 'bbbbbbbbbbbb', platform: 'android' }
    ], status: 'paid', amountFen: 280 };
  const app = harness(async () => payload({ orders: [order], total: 1 }));
  await app.page.load();
  const buyer = app.rows()[0][2];
  assert.equal(buyer.parts[0], '小蓝（当前昵称）');
  assert.ok(buyer.parts.includes('下单设备：未记录'));
  assert.ok(buyer.parts.includes('关联设备（参考）：aaaaaaaaaaaa、bbbbbbbbbbbb'));
  app.rows()[0][6].buttons[0].action();
  const body = app.drawer().body;
  assert.match(body.childNodes[3].textContent, /不能确认实际下单设备/);
  const references = body.childNodes[4].childNodes;
  assert.ok(references.some(item => item.textContent.includes(order.accountDevices[0].installationId)));
  assert.ok(references.some(item => item.textContent.includes(order.accountDevices[1].installationId)));
  assert.equal(app.drawer().footer.some(button => button.label === '复制设备码'), false);
});

test('missing buyer metadata remains explicit and snapshot nicknames are never replaced', async () => {
  const orders = [
    { id: 'legacy-unknown', buyerNameSource: 'unknown', buyerDeviceSource: 'unknown', accountDevices: [] },
    { id: 'snapshot-empty-name', buyerNameSource: 'order_snapshot', buyerDisplayName: null,
      buyerInstallationId: '00000000000000000000aaaaaaaaaaaa', buyerDeviceSource: 'order_snapshot' }
  ];
  const app = harness(async () => payload({ orders, total: 2 }));
  await app.page.load();
  assert.equal(app.rows()[0][2].parts[0], '昵称未记录');
  assert.equal(app.rows()[1][2].parts[0], '下单时未设置昵称');
  app.rows()[0][6].buttons[0].action();
  assert.equal(app.drawer().body.childNodes[4].textContent, '暂无关联设备记录。');
});

test('pagination, status and search filters query the server and reset to page one', async () => {
  const app = harness(async route => {
    const query = new URL(route, 'http://test').searchParams;
    return payload({ total: 60, page: Number(query.get('page')), pageSize: Number(query.get('pageSize')) });
  });
  await app.page.load();
  await app.node('marketOrdersNext').dispatch('click');
  assert.equal(new URL(app.calls.at(-1), 'http://test').searchParams.get('page'), '2');
  app.node('marketOrderSearch').value = '  123ab & 测试  ';
  app.node('marketOrderStatus').value = 'paid';
  await app.node('marketOrderStatus').dispatch('change');
  const query = new URL(app.calls.at(-1), 'http://test').searchParams;
  assert.equal(query.get('page'), '1');
  assert.equal(query.get('q'), '123ab & 测试');
  assert.equal(query.get('status'), 'paid');
  assert.equal(app.node('marketOrdersPrevious').disabled, true);
  await app.node('clearMarketOrderFilters').dispatch('click');
  assert.equal(new URL(app.calls.at(-1), 'http://test').searchParams.get('q'), '');
  assert.equal(new URL(app.calls.at(-1), 'http://test').searchParams.get('status'), '');
});

test('the newest filter request wins and failures do not look like an empty order list', async () => {
  const pending = [];
  const app = harness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const older = app.page.load();
  app.node('marketOrderStatus').value = 'expired';
  const newer = app.node('marketOrderStatus').dispatch('change');
  pending[1].resolve(payload({ total: 2 }));
  await newer;
  pending[0].resolve(payload({ total: 99 }));
  await older;
  assert.match(app.node('marketOrderPageInfo').textContent, /共 2 笔/);
  const failing = app.page.load();
  pending[2].reject(new Error('后台连接失败'));
  await failing;
  assert.equal(app.node('marketOrdersError').textContent, '后台连接失败');
  assert.equal(app.node('marketOrdersError').hidden, false);
  assert.equal(app.node('emptyMarketOrders').hidden, true);
  assert.equal(app.node('marketOrderTotal').textContent, '—');
  assert.equal(app.node('marketOrdersNext').disabled, true);
  assert.equal(app.node('refreshMarketOrders').disabled, false);
});

test('refresh falls back to the last page when pending orders leave the active filter', async () => {
  let total = 26;
  const app = harness(async route => payload({ total, page: Number(new URL(route, 'http://test').searchParams.get('page')) }));
  await app.page.load();
  await app.node('marketOrdersNext').dispatch('click');
  total = 1;
  await app.page.load();
  assert.equal(new URL(app.calls.at(-1), 'http://test').searchParams.get('page'), '1');
  assert.match(app.node('marketOrderPageInfo').textContent, /第 1 \/ 1 页/);
});

test('manual confirmation is available from rows and details only for unpaid recoverable states', async () => {
  const orders = ['pending_payment', 'expired', 'canceled', 'paid', 'unknown'].map(status => unpaidOrder({ id: status, status }));
  const app = harness(async () => payload({ orders, total: orders.length }));
  await app.page.load();
  for (const [index, order] of orders.entries()) {
    const eligible = index < 3;
    assert.equal(app.rows()[index][6].buttons.some(button => button.label === '手动确认收款'), eligible);
    app.rows()[index][6].buttons[0].action();
    const confirmation = app.drawer().footer.find(button => button.label === '手动确认收款');
    assert.equal(Boolean(confirmation), eligible);
    if (!eligible) continue;
    confirmation.action();
    assert.equal(app.drawer().title, '手动确认收款');
    const texts = descendants(app.drawer().body).map(item => item.textContent);
    for (const value of [order.id, order.accountId, order.buyerDisplayName, order.buyerInstallationId,
      order.productTitle, order.productVersion, '¥2.80']) assert.ok(texts.includes(value));
    assert.equal(texts.some(value => value.includes('此订单已取消或过期')), order.status !== 'pending_payment');
    assert.ok(texts.includes('已核对转账记录，确认付款人及金额与此订单一致'));
    assert.ok(texts.some(value => value.includes('此操作不执行微信收款或转账')));
  }
});

test('manual confirmation requires a trimmed note and explicit transfer acknowledgment before calling API', async () => {
  const app = harness(async () => payload({ orders: [unpaidOrder()], total: 1 }));
  await app.page.load();
  app.rows()[0][6].buttons.find(button => button.label === '手动确认收款').action();
  const fields = confirmationFields(app);
  assert.equal(fields.note.maxLength, 600);
  assert.equal(fields.note.required, true);
  assert.equal(fields.received.required, true);
  await fields.submit.action();
  assert.match(fields.error.textContent, /填写人工核对说明/);
  fields.note.value = '   ';
  fields.received.checked = true;
  await fields.form.dispatch('submit');
  assert.equal(fields.error.hidden, false);
  fields.note.value = 'a'.repeat(601);
  await fields.submit.action();
  assert.match(fields.error.textContent, /600/);
  fields.note.value = '已核对时间和金额';
  fields.received.checked = false;
  await fields.submit.action();
  assert.match(fields.error.textContent, /勾选/);
  assert.equal(fields.received.focused, true);
  assert.equal(app.apiCalls.filter(call => call.options?.method === 'POST').length, 0);
});

test('manual confirmation sends a locked amount once, refreshes paid totals and renders audit as literal text', async () => {
  const order = unpaidOrder({ id: 'order / with-symbols', status: 'expired' });
  const auditNote = '<img src=x onerror=alert(1)>已核对';
  const administrator = '<svg onload=alert(1)>admin';
  let settle;
  let paid;
  const app = harness(async (route, options) => {
    if (options?.method === 'POST') return new Promise(resolve => { settle = resolve; });
    return payload({ orders: [paid || order], total: 1,
      summary: { total: 1, pending: paid ? 0 : 1, paid: paid ? 1 : 0, paidAmountFen: paid ? 280 : 0 } });
  });
  await app.page.load();
  app.rows()[0][6].buttons.find(button => button.label === '手动确认收款').action();
  const fields = confirmationFields(app);
  fields.note.value = `  ${auditNote}  `; fields.received.checked = true;
  const pending = fields.submit.action();
  assert.equal(fields.submit.disabled, true);
  assert.equal(fields.cancel.disabled, true);
  assert.equal(fields.note.disabled, true);
  assert.equal(fields.received.disabled, true);
  await fields.submit.action();
  await fields.form.dispatch('submit');
  app.rows()[0][6].buttons.find(button => button.label === '手动确认收款').action();
  const posts = app.apiCalls.filter(call => call.options?.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].route, '/api/admin/pet-market/orders/order%20%2F%20with-symbols/confirm-payment');
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].options.body)), { note: auditNote, expectedAmountFen: 280, received: true });
  paid = { ...order, status: 'paid', paidAt: '2026-10-30T08:30:00Z', confirmationMethod: 'manual',
    manualConfirmation: { note: auditNote, confirmedAt: '2026-10-30T08:30:00Z', confirmedBy: administrator, previousStatus: 'expired' } };
  settle({ order: paid, duplicate: false });
  await pending;
  assert.equal(app.node('marketOrderPaid').textContent, '1');
  assert.equal(app.node('marketOrderRevenue').textContent, '¥2.80');
  assert.equal(app.drawer().title, '订单详情');
  assert.equal(app.rows()[0][4].childNodes[0].textContent, '已付款 · 手动确认');
  assert.equal(app.rows()[0][6].buttons.some(button => button.label === '手动确认收款'), false);
  assert.equal(app.drawer().footer.some(button => button.label === '手动确认收款'), false);
  const details = descendants(app.drawer().body);
  for (const value of [auditNote, administrator, 'date:2026-10-30T08:30:00Z', '已过期']) {
    const node = details.find(item => item.textContent === value);
    assert.ok(node, value); assert.equal(node.innerHTML, '');
  }
  assert.match(app.drawer().body.childNodes[1].textContent, /管理员手动确认收款/);
  assert.match(app.drawer().body.childNodes[1].textContent, /自动下载安装.*手动选择/);
});

test('manual confirmation errors remain inline with editable inputs and a retry succeeds as already paid', async () => {
  const order = unpaidOrder({ status: 'canceled' });
  let attempts = 0;
  let paid;
  const app = harness(async (route, options) => {
    if (options?.method === 'POST') {
      if (++attempts === 1) throw new Error('订单状态已变化，请核对后重试。');
      paid = { ...order, status: 'paid', confirmationMethod: 'automatic', manualConfirmation: null };
      return { order: paid, duplicate: true };
    }
    return payload({ orders: [paid || order], total: 1 });
  });
  await app.page.load();
  app.rows()[0][6].buttons.find(button => button.label === '手动确认收款').action();
  const fields = confirmationFields(app);
  fields.note.value = '已确认付款记录'; fields.received.checked = true;
  await fields.submit.action();
  assert.equal(app.drawer().title, '手动确认收款');
  assert.equal(fields.error.textContent, '订单状态已变化，请核对后重试。');
  assert.equal(fields.error.hidden, false);
  assert.equal(fields.note.value, '已确认付款记录');
  assert.equal(fields.received.checked, true);
  for (const field of [fields.note, fields.received, fields.submit, fields.cancel]) assert.equal(field.disabled, false);
  await fields.submit.action();
  assert.equal(attempts, 2);
  assert.equal(app.drawer().title, '订单详情');
  assert.ok(app.toasts.some(args => args[0].includes('无需重复发放')));
  const texts = descendants(app.drawer().body).map(item => item.textContent);
  assert.ok(texts.includes('自动匹配'));
  assert.equal(texts.includes('人工核对说明'), false);
});

test('a late confirmation response does not replace another open order drawer', async () => {
  const first = unpaidOrder();
  const second = unpaidOrder({ id: 'second-order' });
  let settle;
  const app = harness(async (route, options) => options?.method === 'POST'
    ? new Promise(resolve => { settle = resolve; }) : payload({ orders: [first, second], total: 2 }));
  await app.page.load();
  app.rows()[0][6].buttons.find(button => button.label === '手动确认收款').action();
  const fields = confirmationFields(app);
  fields.note.value = '已核对'; fields.received.checked = true;
  const pending = fields.submit.action();
  app.rows()[1][6].buttons[0].action();
  settle({ order: { ...first, status: 'paid', confirmationMethod: 'manual' }, duplicate: false });
  await pending;
  assert.ok(descendants(app.drawer().body).some(item => item.textContent === second.id));
});

test('legacy paid orders do not invent a confirmation source or historical manual audit', async () => {
  const orders = [unpaidOrder({ status: 'paid', confirmationMethod: null, manualConfirmation: null }),
    unpaidOrder({ id: 'legacy-manual', status: 'paid', confirmationMethod: 'manual', manualConfirmation: null })];
  const app = harness(async () => payload({ orders, total: 2 }));
  await app.page.load();
  app.rows()[0][6].buttons[0].action();
  const unknownText = descendants(app.drawer().body).map(item => item.textContent);
  assert.ok(unknownText.includes('已确认 / 来源未记录'));
  assert.match(app.drawer().body.childNodes[1].textContent, /历史确认来源未记录/);
  assert.equal(unknownText.includes('自动匹配'), false);
  app.rows()[1][6].buttons[0].action();
  const manualText = descendants(app.drawer().body).map(item => item.textContent);
  assert.ok(manualText.includes('手动确认'));
  assert.ok(manualText.includes('历史人工确认未记录操作人及核对说明'));
  assert.equal(manualText.includes('确认管理员'), false);
});

test('admin shell and route registration expose the orders page from both entry points', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const shell = read('public/admin/index.html');
  assert.match(shell, /data-route="pet-market-orders"/);
  assert.match(shell, /data-page-panel="pet-market-orders"/);
  assert.match(shell, /id="petMarketOrdersRoot"/);
  assert.match(shell, /pages\/pet-market-orders\.js/);
  assert.match(read('public/admin/js/main.js'), /'pet-market-orders': 'pet-market-orders'/);
  assert.match(read('public/admin/js/pages/pet-market.js'), /href="#pet-market-orders"/);
});
