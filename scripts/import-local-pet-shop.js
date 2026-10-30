#!/usr/bin/env node
'use strict';

// Exercise the same authenticated draft/upload/publish API used by the admin UI.
// This helper accepts only a marked development server on literal IPv4 loopback.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseStrictZip } = require('../lib/pet-market-package');

async function jsonFile(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function argumentsFrom(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, '');
    if (!['state-directory', 'catalog'].includes(key) || !values[index + 1] || result[key])
      throw new Error('使用 --state-directory <本地状态目录> --catalog <商品清单.json>');
    result[key] = values[index + 1];
  }
  for (const key of ['state-directory', 'catalog']) {
    if (!path.isAbsolute(result[key] || '') || result[key].startsWith('\\\\'))
      throw new Error(`${key} 必须为本机绝对路径`);
  }
  return result;
}

async function run(options) {
  const directory = path.resolve(options['state-directory']);
  const marker = await jsonFile(path.join(directory, 'local-pet-market-demo.json'));
  const runtime = await jsonFile(path.join(directory, 'runtime.json'));
  const origin = new URL(marker.baseUrl);
  if (marker.kind !== 'deskpet-local-market-demo-v1'
      || marker.dataDirectory !== path.join(directory, 'server')
      || runtime.baseUrl !== marker.baseUrl || origin.protocol !== 'http:'
      || origin.hostname !== '127.0.0.1' || origin.pathname !== '/'
      || !origin.port || origin.username || origin.password || origin.search || origin.hash)
    throw new Error('目标不是受支持的独立本地小铺');
  const baseUrl = origin.origin;
  const secrets = await jsonFile(path.join(directory, 'demo-secrets.json'));
  const catalog = await jsonFile(path.resolve(options.catalog));
  const products = Array.isArray(catalog) ? catalog : catalog.products;
  if (!Array.isArray(products) || products.length < 1 || products.length > 16)
    throw new Error('本地展示清单需要 1–16 个商品');
  const ids = new Set();
  for (const product of products) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(product.id || '') || ids.has(product.id))
      throw new Error('商品标识无效或重复');
    if (![0, 280, 580].includes(product.priceFen)) throw new Error('清单价格必须是免费、2.8 或 5.8 元');
    ids.add(product.id);
  }
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', redirect: 'error',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: secrets.adminPassword })
  });
  if (!login.ok) throw new Error(`本地后台登录失败 HTTP ${login.status}`);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || !session.csrfToken) throw new Error('后台会话缺失');
  async function admin(route, method = 'GET', body, binaryType = 'application/zip') {
    if (!route.startsWith('/api/admin/pet-market/') || route.includes('://') || route.startsWith('//'))
      throw new Error('拒绝小铺管理之外的接口');
    const headers = { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': session.csrfToken };
    if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? binaryType : 'application/json';
    const response = await fetch(baseUrl + route, {
      method, headers, redirect: 'error',
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`本地后台 ${method} ${route} HTTP ${response.status}: ${payload.error?.message || payload.message || '请求失败'}`);
    return payload;
  }

  const existing = await admin('/api/admin/pet-market/products');
  const results = [];
  for (const [index, item] of products.entries()) {
    const archive = await fs.readFile(path.resolve(item.output));
    const entries = parseStrictZip(archive);
    const manifestEntry = entries.find(entry => entry.name === 'pet-market.json');
    if (!manifestEntry) throw new Error(`${item.id} 缺少资源清单`);
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    if (manifest.productId !== item.id || manifest.files.length !== item.assetCount)
      throw new Error(`${item.id} 商品标识或素材数量与清单不一致`);
    const desired = {
      title: item.title, description: item.description, tags: item.tags || [],
      isFeatured: Boolean(item.isFeatured), chargingMode: item.priceFen ? 'paid' : 'free',
      priceFen: item.priceFen, sortOrder: index * 10,
      previewMode: item.previewMode === 'selected' ? 'selected' : 'first5',
      previewPaths: item.previewMode === 'selected' ? item.previewFiles : [],
      isDefault: Boolean(item.isDefault), status: 'published'
    };
    let product = existing.products.find(value => value.id === item.id);
    if (!product) {
      product = (await admin('/api/admin/pet-market/products', 'POST', {
        ...desired, id: item.id, isDefault: false, status: 'draft', previewMode: 'none', previewPaths: []
      })).product;
    }
    let sourceType = 'existing-version';
    const alreadyUploaded = product.versions?.find(value => value.version === manifest.version);
    if (alreadyUploaded) {
      const files = alreadyUploaded.files || [];
      if (files.length !== manifest.files.length || manifest.files.some(file =>
        !files.some(previous => previous.path === file.path && previous.sha256 === file.sha256 && previous.sizeBytes === file.sizeBytes)))
        throw new Error(`${item.id} 的已有版本内容不一致，请使用新版本`);
    } else {
      // All initial imports exercise direct-GIF upload, just like the browser picker.
      const files = manifest.files.map(file => {
        const entry = entries.find(value => value.name === file.path);
        if (!entry || entry.data.length !== file.sizeBytes
            || crypto.createHash('sha256').update(entry.data).digest('hex') !== file.sha256)
          throw new Error(`${item.id} 的 GIF 完整性校验失败`);
        return { path: file.path, sizeBytes: file.sizeBytes, data: entry.data };
      });
      const bytes = Buffer.concat(files.map(file => file.data));
      const task = await admin(`/api/admin/pet-market/products/${item.id}/versions`, 'POST', {
        version: manifest.version, fileName: `${item.id}-${manifest.version}.zip`,
        fileSize: bytes.length, sourceType: 'gif-files',
        files: files.map(({ path: filePath, sizeBytes }) => ({ path: filePath, sizeBytes }))
      });
      product = (await admin(task.uploadUrl, 'PUT', bytes, 'application/octet-stream')).product;
      sourceType = 'gif-files';
    }
    if (product.activeVersion !== manifest.version) throw new Error(`${item.id} 活动版本与上传版本不一致`);
    product = (await admin(`/api/admin/pet-market/products/${item.id}`, 'PATCH', desired)).product;
    const result = {
      id: product.id, title: product.title, status: product.status,
      priceFen: product.priceFen, tags: product.tags, isFeatured: product.isFeatured,
      isDefault: product.isDefault, version: product.activeVersion,
      assetCount: manifest.files.length, sourceType
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const receipt = { importedAt: new Date().toISOString(), localOnly: true, baseUrl, products: results };
  await fs.writeFile(path.join(directory, 'import-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (require.main === module) run(argumentsFrom(process.argv.slice(2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { argumentsFrom, run };
