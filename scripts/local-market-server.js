#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const {
  LOCAL_TEST_ACCOUNT_ID,
  LocalMarketError,
  LocalMarketStore
} = require('../lib/local-market-store');
const { equalText } = require('../lib/security');

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 48731;
const TOKEN_MIN_LENGTH = 24;
const TOKEN_MAX_LENGTH = 256;
const PAYMENT_EVENT_FIELDS = Object.freeze([
  'eventKey', 'accountId', 'category', 'direction', 'status', 'amountFen',
  'currency', 'reference', 'transactionId', 'occurredAt', 'observedAt', 'verified'
]);

function configError(message) {
  const error = new Error(message);
  error.code = 'LOCAL_MARKET_CONFIG_INVALID';
  return error;
}

function requiredString(value, name, { min = 1, max = 512 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw configError(`${name} 配置无效`);
  }
  return value;
}

function absolutePath(value, name) {
  requiredString(value, name, { max: 4096 });
  if (!path.isAbsolute(value)) throw configError(`${name} 必须是绝对路径`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw configError(`${name} 不能是磁盘根目录`);
  return resolved;
}

function validateLoopbackBaseUrl(value, port) {
  if (value === undefined || value === null || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configError('baseUrl 必须是有效的本地 HTTP URL');
  }
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST
      || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) {
    throw configError('baseUrl 只允许 http://127.0.0.1[:port]');
  }
  const urlPort = url.port ? Number(url.port) : 80;
  if (port !== 0 && urlPort !== port) throw configError('baseUrl 端口必须与 port 一致');
  return url.toString().replace(/\/$/, '');
}

function normalizeLocalMarketConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw configError('本地市场配置必须是 JSON 对象');
  }
  const allowed = new Set([
    'dataDir', 'dataDirectory', 'clientToken', 'bridgeToken', 'adminToken',
    'collectionAccountId', 'baseUrl', 'host', 'port', 'stopFile'
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw configError(`配置包含未知字段：${unknown.join(', ')}`);
  if (input.dataDir && input.dataDirectory && input.dataDir !== input.dataDirectory) {
    throw configError('dataDir 与 dataDirectory 不能指向不同位置');
  }

  const dataDirectory = absolutePath(input.dataDirectory || input.dataDir, 'dataDirectory');
  const clientToken = requiredString(input.clientToken, 'clientToken', {
    min: TOKEN_MIN_LENGTH,
    max: TOKEN_MAX_LENGTH
  });
  const bridgeToken = requiredString(input.bridgeToken, 'bridgeToken', {
    min: TOKEN_MIN_LENGTH,
    max: TOKEN_MAX_LENGTH
  });
  const adminToken = requiredString(input.adminToken, 'adminToken', {
    min: TOKEN_MIN_LENGTH,
    max: TOKEN_MAX_LENGTH
  });
  if (new Set([clientToken, bridgeToken, adminToken]).size !== 3) {
    throw configError('clientToken、bridgeToken 与 adminToken 必须互不相同');
  }
  const collectionAccountId = requiredString(input.collectionAccountId, 'collectionAccountId', {
    max: 256
  });
  const host = input.host === undefined ? LOOPBACK_HOST : input.host;
  if (host !== LOOPBACK_HOST) throw configError('本地市场只能绑定 127.0.0.1');
  const port = input.port === undefined ? DEFAULT_PORT : input.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw configError('port 配置无效');
  const baseUrl = validateLoopbackBaseUrl(input.baseUrl, port);
  const stopFile = input.stopFile === undefined || input.stopFile === null || input.stopFile === ''
    ? null
    : absolutePath(input.stopFile, 'stopFile');

  return {
    dataDirectory,
    clientToken,
    bridgeToken,
    adminToken,
    collectionAccountId,
    baseUrl,
    host: LOOPBACK_HOST,
    port,
    stopFile
  };
}

async function loadLocalMarketConfig(configPath) {
  const resolved = absolutePath(configPath, 'configPath');
  let text;
  try {
    text = await fs.promises.readFile(resolved, 'utf8');
  } catch (error) {
    throw configError(`无法读取本地市场配置：${error.code || 'READ_FAILED'}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw configError('本地市场配置不是有效 JSON');
  }
  return normalizeLocalMarketConfig(parsed);
}

function responseData(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function responseError(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

function requestObject(req, allowedKeys, requiredKeys = allowedKeys) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LocalMarketError('INVALID_REQUEST', '请求正文必须是 JSON 对象');
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new LocalMarketError('INVALID_REQUEST', `请求包含不允许的字段：${unknown.join(', ')}`);
  }
  const missing = requiredKeys.filter((key) => !Object.hasOwn(body, key));
  if (missing.length > 0) {
    throw new LocalMarketError('INVALID_REQUEST', `请求缺少字段：${missing.join(', ')}`);
  }
  return body;
}

function requestString(value, name, { min = 1, max = 512, trim = true } = {}) {
  if (typeof value !== 'string') {
    throw new LocalMarketError('INVALID_REQUEST', `${name} 必须是字符串`);
  }
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) {
    throw new LocalMarketError('INVALID_REQUEST', `${name} 长度无效`);
  }
  return result;
}

function requestTimestamp(value, name) {
  const text = requestString(value, name, { max: 64 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new LocalMarketError('INVALID_REQUEST', `${name} 时间格式无效`);
  }
  return new Date(timestamp).toISOString();
}

function nullableRequestTimestamp(value, name) {
  return value === null ? null : requestTimestamp(value, name);
}

function paymentEventRequest(req) {
  const body = requestObject(req, PAYMENT_EVENT_FIELDS);
  if (body.amountFen !== null
      && (!Number.isSafeInteger(body.amountFen)
        || body.amountFen < 0
        || body.amountFen > 1_000_000_000)) {
    throw new LocalMarketError('INVALID_REQUEST', 'amountFen 必须是有效整数或 null');
  }
  if (typeof body.verified !== 'boolean') {
    throw new LocalMarketError('INVALID_REQUEST', 'verified 必须是布尔值');
  }
  return {
    eventKey: requestString(body.eventKey, 'eventKey', { max: 512 }),
    accountId: requestString(body.accountId, 'accountId', { max: 256 }),
    category: requestString(body.category, 'category', { max: 64 }).toLowerCase(),
    direction: requestString(body.direction, 'direction', { max: 64 }).toLowerCase(),
    status: requestString(body.status, 'status', { max: 64 }).toLowerCase(),
    amountFen: body.amountFen,
    currency: requestString(body.currency, 'currency', { min: 0, max: 16 }).toUpperCase(),
    reference: requestString(body.reference, 'reference', { min: 0, max: 32 }),
    transactionId: requestString(body.transactionId, 'transactionId', { min: 0, max: 256 }),
    occurredAt: nullableRequestTimestamp(body.occurredAt, 'occurredAt'),
    observedAt: requestTimestamp(body.observedAt, 'observedAt'),
    verified: body.verified
  };
}

function bearerToken(header) {
  const match = /^Bearer ([^\s]+)$/.exec(String(header || '').trim());
  return match ? match[1] : '';
}

function authorize(expectedToken, role) {
  return (req, res, next) => {
    const presented = bearerToken(req.headers.authorization);
    if (!presented) return responseError(res, 401, 'AUTH_REQUIRED', '需要本地访问令牌');
    if (!equalText(presented, expectedToken)) {
      return responseError(res, 403, 'AUTH_FORBIDDEN', '本地访问令牌不匹配');
    }
    req.localMarketRole = role;
    if (role === 'client') req.localMarketAccountId = LOCAL_TEST_ACCOUNT_ID;
    return next();
  };
}

function localRequestOnly(req, res, next) {
  const remote = String(req.socket.remoteAddress || '');
  const host = String(req.headers.host || '');
  const loopbackRemote = remote === LOOPBACK_HOST || remote === `::ffff:${LOOPBACK_HOST}`;
  if (!loopbackRemote || !/^127\.0\.0\.1(?::\d{1,5})?$/.test(host)) {
    return responseError(res, 403, 'LOCAL_ONLY_REQUIRED', '本地市场只接受 127.0.0.1 请求');
  }
  return next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function createLocalMarketApp({ config: configInput, now, randomInt } = {}) {
  const config = normalizeLocalMarketConfig(configInput);
  const store = new LocalMarketStore(config.dataDirectory, {
    collectionAccountId: config.collectionAccountId,
    now,
    randomInt
  });
  await store.initialize();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(localRequestOnly);
  app.use(express.json({ limit: '32kb', strict: true, type: 'application/json' }));

  const client = authorize(config.clientToken, 'client');
  const bridge = authorize(config.bridgeToken, 'bridge');
  const admin = authorize(config.adminToken, 'admin');

  app.get('/health', (req, res) => responseData(res, {
    status: 'ok',
    mode: 'local-test',
    host: LOOPBACK_HOST,
    serverTime: store.serverTime()
  }));

  app.get('/api/local-market/catalog', client, (req, res) => responseData(
    res,
    store.catalogFor(req.localMarketAccountId)
  ));

  app.post('/api/local-market/orders', client, (req, res, next) => {
    try {
      const body = requestObject(req, ['productId']);
      const productId = requestString(body.productId, 'productId', { max: 128 });
      const result = store.createOrder(req.localMarketAccountId, productId);
      return responseData(res, result, result.reused ? 200 : 201);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/local-market/orders/:id', client, (req, res, next) => {
    try {
      const orderId = requestString(req.params.id, 'orderId', { max: 128 });
      return responseData(res, store.getOrder(req.localMarketAccountId, orderId));
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/local-market/orders/:id/cancel', client, (req, res, next) => {
    try {
      if (req.body !== undefined && Object.keys(requestObject(req, [], [])).length > 0) {
        throw new LocalMarketError('INVALID_REQUEST', '取消订单不接受额外字段');
      }
      const orderId = requestString(req.params.id, 'orderId', { max: 128 });
      return responseData(res, store.cancelOrder(req.localMarketAccountId, orderId));
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/local-market/products/:id/download', client, (req, res, next) => {
    let download;
    try {
      const productId = requestString(req.params.id, 'productId', { max: 128 });
      download = store.downloadFor(req.localMarketAccountId, productId);
    } catch (error) {
      return next(error);
    }
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    // Keep dotfile checks scoped to the trusted fixture directory; local state
    // itself may live below a dot-prefixed folder such as .local-review.
    return res.download(path.basename(download.path), download.fileName, {
      root: path.dirname(download.path),
      acceptRanges: false,
      cacheControl: false,
      dotfiles: 'deny'
    }, (error) => {
      if (error && !res.headersSent) next(error);
      else if (error) res.destroy(error);
    });
  });

  app.post('/api/local-market/payment-events', bridge, (req, res, next) => {
    try {
      const result = store.recordPaymentEvent(paymentEventRequest(req));
      return responseData(res, result, result.duplicate ? 200 : 202);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/local-market/payment-events', admin, (req, res, next) => {
    try {
      const requested = req.query.limit === undefined ? 100 : Number(req.query.limit);
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 200) {
        throw new LocalMarketError('INVALID_REQUEST', 'limit 必须是 1 至 200 的整数');
      }
      return responseData(res, store.listPaymentEvents(requested));
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/local-market/payment-events/:id/reparse', admin, (req, res, next) => {
    try {
      const eventId = requestString(req.params.id, 'eventId', { max: 128 });
      return responseData(res, store.reparsePaymentEvent(eventId, paymentEventRequest(req)));
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/local-market/payment-events/:id/confirm', admin, (req, res, next) => {
    try {
      const body = requestObject(req, ['note', 'orderId', 'transferReceived'], ['note', 'orderId']);
      if (Object.hasOwn(body, 'transferReceived') && typeof body.transferReceived !== 'boolean') {
        throw new LocalMarketError('INVALID_REQUEST', 'transferReceived 必须是布尔值');
      }
      const eventId = requestString(req.params.id, 'eventId', { max: 128 });
      const note = requestString(body.note, 'note', { max: 200 });
      const orderId = requestString(body.orderId, 'orderId', { max: 128 });
      return responseData(res, store.confirmPaymentEvent(eventId, orderId, note, {
        transferReceived: body.transferReceived === true
      }));
    } catch (error) {
      return next(error);
    }
  });

  app.use((req, res) => responseError(res, 404, 'NOT_FOUND', '本地市场接口不存在'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof LocalMarketError) {
      return responseError(res, error.status, error.code, error.message);
    }
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return responseError(res, 400, 'INVALID_REQUEST', '请求 JSON 无效');
    }
    return responseError(res, 500, 'INTERNAL_ERROR', '本地市场内部错误');
  });

  return {
    handler: app,
    store,
    publicConfig: {
      host: config.host,
      port: config.port,
      baseUrl: config.baseUrl,
      stopFile: config.stopFile
    },
    close() {
      store.close();
    }
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function startLocalMarketServer(configPath, {
  installSignalHandlers = true,
  log = true,
  stopPollMs = 1000
} = {}) {
  const config = await loadLocalMarketConfig(configPath);
  const application = await createLocalMarketApp({ config });
  const server = http.createServer(application.handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 48;
  await listen(server, config.port);
  const address = server.address();
  const actualBaseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
  if (config.baseUrl && config.baseUrl !== actualBaseUrl) {
    await new Promise((resolve) => server.close(resolve));
    application.close();
    throw configError('baseUrl 与实际监听地址不一致');
  }
  if (log) console.log(`deskpet local-market listening on ${actualBaseUrl}`);

  let stopping = false;
  let stopTimer = null;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const shutdown = async () => {
    if (stopping) return closed;
    stopping = true;
    if (stopTimer) clearInterval(stopTimer);
    await new Promise((resolve) => server.close(resolve));
    application.close();
    resolveClosed();
    return closed;
  };

  if (config.stopFile) {
    let checking = false;
    stopTimer = setInterval(async () => {
      if (checking || stopping) return;
      checking = true;
      try {
        await fs.promises.access(config.stopFile, fs.constants.F_OK);
        await shutdown();
      } catch (error) {
        if (error.code !== 'ENOENT' && !stopping) await shutdown();
      } finally {
        checking = false;
      }
    }, stopPollMs);
    stopTimer.unref();
  }

  if (installSignalHandlers) {
    process.once('SIGTERM', () => shutdown().catch(() => { process.exitCode = 1; }));
    process.once('SIGINT', () => shutdown().catch(() => { process.exitCode = 1; }));
  }

  return { application, server, address, baseUrl: actualBaseUrl, closed, shutdown };
}

function parseConfigArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--config') {
    throw configError('用法：node scripts/local-market-server.js --config <absolute-json-path>');
  }
  return argv[1];
}

async function main() {
  const configPath = parseConfigArgument(process.argv.slice(2));
  const running = await startLocalMarketServer(configPath);
  await running.closed;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`local-market start failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  LOOPBACK_HOST,
  createLocalMarketApp,
  loadLocalMarketConfig,
  normalizeLocalMarketConfig,
  parseConfigArgument,
  startLocalMarketServer
};
