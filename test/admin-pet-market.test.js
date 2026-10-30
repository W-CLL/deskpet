const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { seedPetMarketDemo } = require('../scripts/local-pet-market-demo');

const pageScript = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'admin', 'js', 'pages', 'pet-market.js'),
  'utf8'
);

function element(value = '') {
  const listeners = new Map();
  return {
    value,
    checked: false,
    disabled: false,
    hidden: false,
    readOnly: false,
    textContent: '',
    innerHTML: '',
    validationMessage: '',
    files: [],
    childNodes: [],
    append(...nodes) { this.childNodes.push(...nodes); },
    removeAttribute(name) { delete this[name]; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    setCustomValidity(message) { this.validationMessage = message; },
    reset() {},
    reportValidity() { return true; },
    async dispatch(name) {
      return listeners.get(name)?.({ preventDefault() {} });
    }
  };
}

function loadAdminPage(products, initialPayment = {}) {
  let payment = { enabled: false, method: 'personal_transfer', recipientName: '', recipientAccount: '',
    qrCodeDataUrl: '', instructions: '', available: false, listenerOnline: false,
    unavailableReason: '商家暂未开启收款，请稍后再试', ...initialPayment };
  const ids = [
    'petMarketRoot', 'petMarketDefaultSummary', 'refreshPetMarketButton', 'createPetMarketButton',
    'petMarketRows', 'emptyPetMarket', 'petMarketForm', 'petMarketId', 'petMarketTitle',
    'petMarketDescription', 'petMarketChargingMode', 'petMarketPrice', 'petMarketStatus',
    'petMarketIsDefault', 'petMarketSortOrder', 'petMarketPreviewMode', 'petMarketPreviewPaths',
    'petMarketPreviewPathsLabel', 'petMarketAssetsHint', 'petMarketFormError',
    'petMarketVersionForm', 'petMarketUploadTitle', 'petMarketVersion', 'petMarketArchive',
    'petMarketProgress', 'petMarketProgressBar', 'petMarketProgressText',
    'petMarketSearch', 'petMarketStatusFilter', 'petMarketChargingFilter', 'petMarketTags',
    'petMarketIsFeatured', 'petMarketUploadSource', 'petMarketFiles', 'petMarketFolder',
    'petMarketFilesLabel', 'petMarketFolderLabel', 'petMarketArchiveLabel',
    'petMarketSelectionSummary', 'petMarketPublishAfterUpload', 'petMarketPaymentSummary',
    'petMarketPaymentSettingsButton', 'petMarketPaymentForm', 'petMarketPaymentEnabled',
    'petMarketPaymentMethod', 'petMarketRecipientName', 'petMarketRecipientAccount',
    'petMarketPaymentQrFile', 'petMarketPaymentQrPreview', 'petMarketPaymentQrClear',
    'petMarketPaymentInstructions', 'petMarketPaymentListenerStatus', 'petMarketRefreshPaymentStatus',
    'petMarketPaymentError'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  Object.assign(elements.petMarketChargingMode, { value: 'free' });
  Object.assign(elements.petMarketPrice, { value: '280' });
  Object.assign(elements.petMarketStatus, { value: 'draft' });
  Object.assign(elements.petMarketSortOrder, { value: '0' });
  Object.assign(elements.petMarketPreviewMode, { value: 'first5' });
  const primaryButton = element();
  let factory;
  let renderedRows = [];
  let uploadOptions;
  let drawerOptions;
  const apiCalls = [];
  const ui = {
    byId: id => elements[id],
    cell: (_className, ...parts) => ({ ...element(), parts }),
    stackedCell: (_className, ...parts) => ({ ...element(), parts, childNodes: [...parts] }),
    actionButton: (label, _className, action) => ({ label, action }),
    actionsCell: (...buttons) => ({ buttons }),
    fillTable: (_tbody, items, buildRow, empty) => {
      renderedRows = items.map(buildRow);
      empty.hidden = items.length > 0;
    },
    formatBytes: value => `${value} B`,
    submitUpload: async options => { uploadOptions = options; }
  };
  const context = vm.createContext({
    registerAdminPage: value => { factory = value; },
    document: { querySelector: () => primaryButton, createElement: () => element() },
    globalThis: {
      AdminFormKit: { openFormDrawer(options) { drawerOptions = options; }, closeDrawer() {} }
    },
    Set,
    File
  });
  vm.runInContext(pageScript, context);
  const page = factory({
    ui,
    api: async (route, options) => {
      apiCalls.push({ route, options });
      if (route === '/api/admin/pet-market/payment-settings') {
        if (options) payment = { ...payment, ...options.body };
        return { payment };
      }
      if (!options) return { products };
      return {};
    },
    showToast() {}
  });
  return {
    page,
    elements,
    apiCalls,
    renderedRows: () => renderedRows,
    uploadOptions: () => uploadOptions,
    drawerOptions: () => drawerOptions
  };
}

test('pet market admin uses activeVersion and enforces upload-dependent settings', async () => {
  const product = {
    id: 'starter-free', title: '默认桌宠', description: '', chargingMode: 'free', priceFen: 0,
    status: 'published', isDefault: true, sortOrder: 0, previewMode: 'selected',
    previewPaths: ['gifs/one.gif'], activeVersion: '1.0.0',
    versions: [
      { version: '2.0.0', assetCount: 9, sizeBytes: 900, files: [{ path: 'gifs/new.gif' }] },
      { version: '1.0.0', assetCount: 5, sizeBytes: 500, files: [{ path: 'gifs/one.gif' }] }
    ]
  };
  const admin = loadAdminPage([product]);
  await admin.page.load();
  assert.match(admin.elements.petMarketRoot.innerHTML, /aria-label="桌宠小铺规则"/);
  assert.match(admin.elements.petMarketRoot.innerHTML, /class="eyebrow">桌宠小铺<\/p>/);
  assert.equal(admin.elements.petMarketDefaultSummary.textContent, '默认免费款：默认桌宠');
  assert.deepEqual(admin.renderedRows()[0][3].parts, ['1.0.0', '5 个素材', '500 B']);

  admin.renderedRows()[0][5].buttons[0].action();
  assert.equal(admin.elements.petMarketStatus.validationMessage, '');
  assert.equal(admin.elements.petMarketPreviewMode.validationMessage, '');
  assert.equal(admin.elements.petMarketIsDefault.validationMessage, '');
  admin.elements.petMarketPreviewPaths.value = 'gifs/missing.gif';
  await admin.elements.petMarketPreviewPaths.dispatch('input');
  assert.match(admin.elements.petMarketPreviewMode.validationMessage, /当前活动资源版本/);

  await admin.elements.createPetMarketButton.dispatch('click');
  assert.equal(admin.drawerOptions().eyebrow, '桌宠小铺');
  admin.elements.petMarketStatus.value = 'published';
  await admin.elements.petMarketStatus.dispatch('change');
  assert.match(admin.elements.petMarketStatus.validationMessage, /先上传有效资源版本/);
  admin.elements.petMarketIsDefault.checked = true;
  await admin.elements.petMarketIsDefault.dispatch('change');
  assert.match(admin.elements.petMarketIsDefault.validationMessage, /活动资源版本/);

  admin.renderedRows()[0][5].buttons[1].action();
  admin.elements.petMarketUploadSource.value = 'zip';
  admin.elements.petMarketVersion.value = '2.1.0';
  await admin.elements.petMarketVersionForm.dispatch('submit');
  assert.equal(admin.uploadOptions().createPath, '/api/admin/pet-market/products/starter-free/versions');
  assert.equal(admin.uploadOptions().body({}).version, '2.1.0');
});

test('pet shop payment drawer reads persisted targets and saves explicit settings without replacing unsaved edits on refresh', async () => {
  const admin = loadAdminPage([], { enabled: true, recipientName: '测试昵称', recipientAccount: 'test_pay01',
    instructions: '请核对昵称', available: true, listenerOnline: true, unavailableReason: '' });
  await admin.page.load();
  assert.match(admin.elements.petMarketPaymentSummary.textContent, /在线.*可下单/);
  await admin.elements.petMarketPaymentSettingsButton.dispatch('click');
  assert.equal(admin.drawerOptions().submitLabel, '保存收款设置');
  assert.equal(admin.elements.petMarketRecipientName.value, '测试昵称');
  assert.equal(admin.elements.petMarketRecipientAccount.value, 'test_pay01');
  assert.equal(admin.elements.petMarketPaymentQrPreview.hidden, true);
  admin.elements.petMarketRecipientName.value = ' 新昵称 ';
  admin.elements.petMarketRecipientAccount.value = 'new_pay01';
  admin.elements.petMarketPaymentInstructions.value = ' 新说明 ';
  await admin.elements.petMarketRefreshPaymentStatus.dispatch('click');
  assert.equal(admin.elements.petMarketRecipientName.value, ' 新昵称 ');
  await admin.elements.petMarketPaymentForm.dispatch('submit');
  const saved = admin.apiCalls.find(call => call.options?.method === 'PUT');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.options.body)), {
    enabled: true, method: 'personal_transfer', recipientName: '新昵称', recipientAccount: 'new_pay01',
    instructions: '新说明', qrCodeDataUrl: ''
  });
});

test('pet shop admin supports tags, filtering, direct GIF upload and publish after verification', async () => {
  const admin = loadAdminPage([{
    id: 'warm-cat', title: '暖心猫咪', description: '陪你认真生活', chargingMode: 'paid', priceFen: 280,
    status: 'draft', isDefault: false, tags: ['治愈', '萌宠'], isFeatured: true,
    sortOrder: 0, previewMode: 'first5', previewPaths: [], activeVersion: '', versions: []
  }]);
  await admin.page.load();
  admin.renderedRows()[0][5].buttons[0].action();
  assert.equal(admin.elements.petMarketTags.value, '治愈、萌宠');
  assert.equal(admin.elements.petMarketIsFeatured.checked, true);
  admin.elements.petMarketTags.value = ' 治愈，萌宠、治愈 ';
  await admin.elements.petMarketForm.dispatch('submit');
  const saved = admin.apiCalls.find(call => call.options?.method === 'PATCH');
  assert.deepEqual(Array.from(saved.options.body.tags), ['治愈', '萌宠']);
  assert.equal(saved.options.body.isFeatured, true);
  admin.elements.petMarketSearch.value = '没有匹配';
  await admin.elements.petMarketSearch.dispatch('input');
  assert.equal(admin.renderedRows().length, 0);
  admin.elements.petMarketSearch.value = '治愈';
  await admin.elements.petMarketSearch.dispatch('input');
  assert.equal(admin.renderedRows().length, 1);
  admin.renderedRows()[0][5].buttons[1].action();
  assert.equal(admin.elements.petMarketVersion.value, '1.0.0');
  const gif = new File([Buffer.from('GIF89a')], '陪伴.gif', { type: 'image/gif' });
  admin.elements.petMarketFiles.files = [gif];
  await admin.elements.petMarketVersionForm.dispatch('submit');
  const upload = admin.uploadOptions();
  assert.equal(upload.fileInput.files[0].size, gif.size);
  assert.equal(upload.body().sourceType, 'gif-files');
  assert.equal(upload.body().files[0].path, '陪伴.gif');
  assert.equal(upload.body().files[0].sizeBytes, gif.size);
  assert.equal(admin.apiCalls.some(call => call.options?.body?.status === 'published'), false);
  await upload.afterUpload();
  assert.equal(admin.apiCalls.at(-1).options.body.status, 'published');
});

test('local demo seed resumes after upload and is idempotent after reconciliation', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-market-seed-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'seed.zip');
  await fs.promises.writeFile(archivePath, 'seed-package');
  const calls = [];
  const interrupted = {
    id: 'starter-free', title: '默认桌宠 · 本地开发示例', description: '', chargingMode: 'free',
    priceFen: 0, status: 'draft', isDefault: false, sortOrder: 0, previewMode: 'none',
    previewPaths: [], activeVersion: '1.0.0'
  };
  const reconciled = {
    ...interrupted,
    description: '使用仓库已有的五个 GIF 验证领取、预览、安装和使用，不冒充正式25+素材商品。',
    status: 'published', isDefault: true, previewMode: 'selected',
    previewPaths: ['gifs/一二布布1.gif', 'gifs/一二布布2.gif']
  };
  let current = interrupted;
  async function admin(route, method = 'GET', body) {
    calls.push({ route, method, body });
    if (method === 'GET') return { products: [current] };
    if (method === 'PATCH') {
      current = { ...current, ...body };
      return { product: current };
    }
    throw new Error(`unexpected ${method} ${route}`);
  }
  assert.deepEqual(await seedPetMarketDemo(admin, archivePath), reconciled);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1,
    'restart must finish publish/default configuration after an interrupted first run');
  calls.length = 0;
  assert.deepEqual(await seedPetMarketDemo(admin, archivePath), reconciled);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0,
    'an already reconciled seed must not upload or rewrite the product again');
});
