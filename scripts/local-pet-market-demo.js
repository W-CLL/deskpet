#!/usr/bin/env node
// Full market development server. It never binds outside literal IPv4 loopback.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createApplication } = require('../src/app');
const { hashPassword } = require('../lib/security');

function argumentsFrom(values) {
  const allowed = new Set(['state-directory', 'port', 'seed-pack', 'bridge-config', 'collection-config']);
  const result = {};
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i]?.replace(/^--/, '');
    if (!values[i]?.startsWith('--') || !allowed.has(name) || !values[i + 1] || Object.hasOwn(result, name)) {
      throw new Error('使用 --state-directory <独立绝对路径> [--port 18766] [--seed-pack <ZIP>]');
    }
    result[name] = values[i + 1];
  }
  if (!path.isAbsolute(result['state-directory'] || '')) throw new Error('必须提供独立的绝对状态目录');
  const stateDirectory = path.resolve(result['state-directory']);
  if (stateDirectory === path.parse(stateDirectory).root || /^\\\\/.test(stateDirectory)) throw new Error('状态目录不能是磁盘根目录或 UNC');
  const port = Number(result.port || 18766);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须在1024至65535之间');
  if (Boolean(result['bridge-config']) !== Boolean(result['collection-config'])) throw new Error('两份已有桥接配置必须同时指定');
  return { ...result, stateDirectory, port };
}

async function readJson(file) {
  return JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.promises.rename(temporary, file);
}

const SEED_PRODUCT_ID = 'starter-free';
const SEED_VERSION = '1.0.0';
const SEED_PREVIEW_PATHS = Object.freeze(['gifs/一二布布1.gif', 'gifs/一二布布2.gif']);
const SEED_DRAFT = Object.freeze({
  id: SEED_PRODUCT_ID,
  title: '默认桌宠 · 本地开发示例',
  description: '使用仓库已有的五个 GIF 验证领取、预览、安装和使用，不冒充正式25+素材商品。',
  chargingMode: 'free',
  priceFen: 0,
  status: 'draft',
  isDefault: false,
  sortOrder: 0,
  previewMode: 'none',
  previewPaths: []
});

function sameStrings(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function seedPetMarketDemo(admin, seedPackPath) {
  const catalog = await admin('/api/admin/pet-market/products');
  let product = catalog.products.find(item => item.id === SEED_PRODUCT_ID);
  if (!product) {
    const created = await admin('/api/admin/pet-market/products', 'POST', SEED_DRAFT);
    product = created.product;
  }
  if (!product.activeVersion) {
    const archive = await fs.promises.readFile(path.resolve(seedPackPath));
    const task = await admin(`/api/admin/pet-market/products/${SEED_PRODUCT_ID}/versions`, 'POST', {
      version: SEED_VERSION,
      fileName: `${SEED_PRODUCT_ID}-${SEED_VERSION}.zip`,
      fileSize: archive.length
    });
    if (typeof task.uploadUrl !== 'string' || !task.uploadUrl.startsWith('/api/admin/pet-market/')) {
      throw new Error('上传地址不属于本地市场');
    }
    const uploaded = await admin(task.uploadUrl, 'PUT', archive);
    product = uploaded.product;
  }
  if (!product?.activeVersion) throw new Error('本地种子资源上传后没有活动版本');

  const desired = {
    title: SEED_DRAFT.title,
    description: SEED_DRAFT.description,
    chargingMode: 'free',
    priceFen: 0,
    status: 'published',
    isDefault: true,
    sortOrder: 0,
    previewMode: 'selected',
    previewPaths: [...SEED_PREVIEW_PATHS]
  };
  const needsReconcile = Object.entries(desired).some(([key, value]) => (
    Array.isArray(value) ? !sameStrings(product[key], value) : product[key] !== value
  ));
  if (needsReconcile) {
    const updated = await admin(`/api/admin/pet-market/products/${SEED_PRODUCT_ID}`, 'PATCH', desired);
    product = updated.product;
  }
  return product;
}

async function start(options) {
  process.umask(0o077);
  const stateDirectory = options.stateDirectory;
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const dataDirectory = path.join(stateDirectory, 'server');
  const markerPath = path.join(stateDirectory, 'local-pet-market-demo.json');
  const secretsPath = path.join(stateDirectory, 'demo-secrets.json');
  const stopFile = path.join(stateDirectory, 'market-stop.signal');
  await fs.promises.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  let saved;
  if (fs.existsSync(markerPath)) {
    const marker = await readJson(markerPath);
    if (marker.kind !== 'deskpet-local-market-demo-v1' || marker.dataDirectory !== dataDirectory || marker.baseUrl !== baseUrl) {
      throw new Error('状态目录已有不同的本地服务，不能覆盖');
    }
    saved = await readJson(secretsPath);
  } else {
    if (fs.existsSync(dataDirectory) || fs.existsSync(secretsPath)) throw new Error('拒绝复用没有本地标记的数据库或凭据');
    saved = { adminPassword: crypto.randomBytes(24).toString('base64url'), bridgeToken: crypto.randomBytes(32).toString('base64url') };
    await fs.promises.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await writeJson(secretsPath, saved);
    const keys = crypto.generateKeyPairSync('ed25519');
    await fs.promises.writeFile(path.join(dataDirectory, 'signing-private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    await writeJson(path.join(dataDirectory, 'auth.json'), await hashPassword(saved.adminPassword));
    await writeJson(markerPath, { kind: 'deskpet-local-market-demo-v1', dataDirectory, baseUrl });
  }
  if (fs.existsSync(stopFile)) await fs.promises.unlink(stopFile);
  let sourceBridge = null;
  let collectionAccountId = '';
  if (options['bridge-config']) {
    sourceBridge = await readJson(path.resolve(options['bridge-config']));
    const sourceServer = await readJson(path.resolve(options['collection-config']));
    if (!sourceBridge.accountDir || !sourceBridge.keysFile || !sourceBridge.wxlocalRoot || !sourceServer.collectionAccountId) throw new Error('原本地支付配置缺少必要字段');
    collectionAccountId = sourceServer.collectionAccountId;
  }
  const application = await createApplication({
    dataDirectory, publicUrl: baseUrl, httpHost: '127.0.0.1', httpPort: options.port,
    cookieSecure: false, petMarketBridgeToken: sourceBridge ? saved.bridgeToken : '',
    petMarketCollectionAccountId: collectionAccountId
  });
  const server = http.createServer(application.handler);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  } catch (error) { application.close(); throw error; }
  let stopped = false;
  let interval;
  async function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    await new Promise(resolve => server.close(resolve));
    application.close();
  }
  try {
    if (!saved.identity) {
      const code = application.activationStore.createCodes({ count: 1, note: '仅本机市场开发账号，不是正式用户激活' }).codes[0];
      const installationId = crypto.randomBytes(16).toString('hex');
      const credential = crypto.randomBytes(32).toString('base64url');
      const identity = application.activationStore.activate({ code, installationId, credential, appVersion: '3.4.4', platform: 'windows', architecture: 'x64' });
      if (!identity?.licenseId || !identity.accountId) throw new Error('本地测试身份创建失败');
      saved.identity = { installationId, credential, accountId: identity.accountId, licenseId: identity.licenseId };
      await writeJson(secretsPath, saved);
    }
    const signingPublicKeySpki = crypto.createPublicKey(await fs.promises.readFile(path.join(dataDirectory, 'signing-private.pem')))
      .export({ type: 'spki', format: 'der' }).toString('base64');
    await writeJson(path.join(stateDirectory, 'client.json'), {
      baseUrl, dataDirectory: path.join(stateDirectory, 'client'), ...saved.identity, signingPublicKeySpki
    });
    if (sourceBridge) await writeJson(path.join(stateDirectory, 'bridge.json'), {
      wxlocalRoot: sourceBridge.wxlocalRoot, accountDir: sourceBridge.accountDir, keysFile: sourceBridge.keysFile,
      baseUrl, bridgeToken: saved.bridgeToken, eventPath: '/api/pet-market/payment-events'
    });
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: saved.adminPassword })
    });
    if (!login.ok) throw new Error(`本地后台登录失败：${login.status}`);
    const session = await login.json();
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie || !session.csrfToken) throw new Error('本地后台会话缺失');
    async function admin(route, method = 'GET', body) {
      const headers = { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': session.csrfToken };
      if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'application/zip' : 'application/json';
      const response = await fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect: 'error' });
      if (!response.ok) throw new Error(`本地后台请求失败：${method} ${route} HTTP ${response.status}`);
      return response.json();
    }
    if (options['seed-pack']) {
      await seedPetMarketDemo(admin, options['seed-pack']);
    }
    await writeJson(path.join(stateDirectory, 'runtime.json'), { pid: process.pid, baseUrl, startedAt: new Date().toISOString(), stopFile });
    interval = setInterval(() => { if (fs.existsSync(stopFile)) close().catch(() => { process.exitCode = 1; }); }, 500);
    process.once('SIGINT', () => close());
    process.once('SIGTERM', () => close());
    console.log(JSON.stringify({ ready: true, baseUrl, adminUrl: `${baseUrl}/admin#pet-market`, clientConfigPath: path.join(stateDirectory, 'client.json'), realPaymentBridgeConfigured: Boolean(sourceBridge), localOnly: true }));
    return { close, server, application };
  } catch (error) { await close(); throw error; }
}

if (require.main === module) start(argumentsFrom(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { start, argumentsFrom, seedPetMarketDemo };
