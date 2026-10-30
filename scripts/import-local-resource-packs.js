#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateResourcePackPackage } = require('../lib/resource-pack-package');

async function run(stateDirectory, catalogPath) {
  if (!path.isAbsolute(stateDirectory || '') || !path.isAbsolute(catalogPath || '')) throw new Error('Supply absolute local state and catalog paths');
  const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const marker = await read(path.join(stateDirectory, 'local-pet-market-demo.json'));
  const runtime = await read(path.join(stateDirectory, 'runtime.json'));
  if (marker.kind !== 'deskpet-local-market-demo-v1' || marker.baseUrl !== 'http://127.0.0.1:18767'
      || runtime.baseUrl !== marker.baseUrl || path.resolve(marker.dataDirectory) !== path.join(path.resolve(stateDirectory), 'server'))
    throw new Error('Only the marked local showcase on port 18767 is supported');
  const base = marker.baseUrl;
  const secrets = await read(path.join(stateDirectory, 'demo-secrets.json'));
  const login = await fetch(base + '/api/admin/login', { method: 'POST', redirect: 'error',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: secrets.adminPassword }) });
  if (!login.ok) throw new Error(`Local login failed: HTTP ${login.status}`);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || !session.csrfToken) throw new Error('Missing local admin session');
  const request = async (route, method = 'GET', body) => {
    if (!/^\/api\/admin\/resource-packs(?:\/[A-Za-z0-9_-]+)?$/.test(route)
        && !/^\/api\/admin\/resource-pack-uploads\/[A-Za-z0-9_-]+$/.test(route)) throw new Error('Unexpected admin route');
    const response = await fetch(base + route, { method, redirect: 'error', headers: {
      Origin: base, Cookie: cookie, 'X-CSRF-Token': session.csrfToken,
      ...(body === undefined ? {} : { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' })
    }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Resource operation failed: HTTP ${response.status} ${payload.error?.message || payload.message || ''}`);
    return payload;
  };
  const existing = (await request('/api/admin/resource-packs')).packs;
  const catalog = await read(catalogPath);
  if (!Array.isArray(catalog) || catalog.length > 30) throw new Error('Invalid resource catalog');
  const imported = [];
  for (const item of catalog) {
    const bytes = await fs.readFile(item.archive);
    validateResourcePackPackage(bytes, item.category);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    let pack = existing.find(previous => previous.category === item.category && previous.sha256 === sha256);
    if (!pack) {
      const upload = await request('/api/admin/resource-packs', 'POST', { category: item.category,
        title: item.title, description: item.description, version: item.version, status: 'published',
        fileName: path.basename(item.archive), fileSize: bytes.length });
      pack = (await request(upload.uploadUrl, 'PUT', bytes)).pack;
      existing.push(pack);
    }
    imported.push({ id: pack.id, title: pack.title, category: pack.category, fileCount: pack.fileCount, status: pack.status });
  }
  await fs.writeFile(path.join(stateDirectory, 'free-content-import.json'), JSON.stringify({ localOnly: true, packs: imported }, null, 2) + '\n');
  console.log(JSON.stringify({ localOnly: true, imported: imported.length, titles: imported.map(item => item.title) }));
}
if (require.main === module) run(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
