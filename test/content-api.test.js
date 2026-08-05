const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { canonicalContentPayload } = require('../src/services/content-service');

async function jsonResponse(response) {
  const payload = await response.json();
  return { response, payload };
}

function content(id, type, overrides = {}) {
  return {
    id,
    type,
    prompt: `${id} 的题面`,
    answer: `${id} 的答案`,
    explanation: '答案说明',
    choices: [],
    tags: ['测试'],
    difficulty: 2,
    locale: 'zh-CN',
    active: true,
    ...overrides
  };
}

function verifyPayload(payload, publicKey) {
  const bytes = canonicalContentPayload(payload);
  assert.deepEqual(Buffer.from(payload.signedPayload, 'base64'), bytes);
  assert.equal(
    payload.sha256,
    crypto.createHash('sha256').update(bytes).digest('hex')
  );
  assert.equal(crypto.verify(
    null,
    bytes,
    publicKey,
    Buffer.from(payload.signature, 'base64')
  ), true);
}

test('content administration, signed delivery and account history work end to end', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-content-api-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const authRecord = await hashPassword('test admin password 123');
  await fs.promises.writeFile(
    path.join(dataDirectory, 'auth.json'),
    JSON.stringify(authRecord),
    { mode: 0o600 }
  );
  const application = await createApplication({
    publicUrl: 'http://127.0.0.1',
    dataDirectory,
    cookieSecure: false,
    signingPrivateKey: privateKey
  });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const denied = await jsonResponse(await fetch(`${baseUrl}/api/content/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }));
  assert.equal(denied.response.status, 401);
  assert.equal(denied.payload.code, 'LICENSE_REQUIRED');

  const login = await jsonResponse(await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test admin password 123' })
  }));
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const adminHeaders = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': login.payload.csrfToken
  };

  const imported = await jsonResponse(await fetch(`${baseUrl}/api/admin/content/import`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      items: [
        content('joke:first', 'joke'),
        content('math:first', 'math', {
          choices: ['3', '4', '5'],
          answer: '4'
        }),
        content('trivia:first', 'trivia'),
        content('riddle:first', 'riddle'),
        content('tip:first', 'tip'),
        content('care:first', 'care')
      ]
    })
  }));
  assert.equal(imported.response.status, 200);
  assert.equal(imported.payload.created, 6);
  assert.equal(imported.payload.catalog.version, 1);

  const created = await jsonResponse(await fetch(`${baseUrl}/api/admin/content`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(content('joke:second', 'joke'))
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.item.revision, 1);
  assert.equal(created.payload.catalog.version, 2);

  const updated = await jsonResponse(await fetch(`${baseUrl}/api/admin/content/math%3Afirst`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ explanation: '四是正确答案' })
  }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.item.revision, 2);
  assert.equal(updated.payload.item.explanation, '四是正确答案');

  const disabled = await jsonResponse(await fetch(`${baseUrl}/api/admin/content/trivia%3Afirst`, {
    method: 'DELETE',
    headers: adminHeaders
  }));
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.payload.item.active, false);

  const listing = await jsonResponse(await fetch(`${baseUrl}/api/admin/content`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(listing.response.status, 200);
  assert.deepEqual(listing.payload.summary, {
    total: 7,
    active: 6,
    disabled: 1,
    jokes: 2,
    math: 1,
    trivia: 0,
    riddles: 1,
    tips: 1,
    care: 1
  });
  assert.equal(listing.payload.catalog.version, 4);

  const code = application.activationStore.createCodes({ count: 1 }).codes[0];
  const credential = crypto.randomBytes(32).toString('base64url');
  const activated = await jsonResponse(await fetch(`${baseUrl}/api/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      installationId: crypto.randomBytes(16).toString('hex'),
      credential,
      appVersion: '2.5.0'
    })
  }));
  const licenseHeaders = {
    Authorization: `Bearer ${activated.payload.licenseId}.${credential}`,
    'Content-Type': 'application/json',
    'X-DeskPet-Version': '2.5.0',
    'X-DeskPet-Platform': 'windows'
  };

  const firstBatch = await jsonResponse(await fetch(`${baseUrl}/api/content/batch`, {
    method: 'POST',
    headers: licenseHeaders,
    body: JSON.stringify({ types: ['joke', 'math', 'trivia'], limit: 10 })
  }));
  assert.equal(firstBatch.response.status, 200);
  assert.equal(firstBatch.payload.kind, 'batch');
  assert.deepEqual(
    new Set(firstBatch.payload.items.map((entry) => entry.id)),
    new Set(['joke:first', 'joke:second', 'math:first'])
  );
  assert.deepEqual(firstBatch.payload.disabledIds, ['trivia:first']);
  verifyPayload(firstBatch.payload, publicKey);

  const sixTypeBatch = await jsonResponse(await fetch(`${baseUrl}/api/content/batch`, {
    method: 'POST',
    headers: { ...licenseHeaders, 'X-DeskPet-Version': '2.5.2' },
    body: JSON.stringify({
      types: ['joke', 'math', 'trivia', 'riddle', 'tip', 'care'],
      limit: 10
    })
  }));
  assert.equal(sixTypeBatch.response.status, 200);
  assert.deepEqual(
    new Set(sixTypeBatch.payload.items.map((entry) => entry.id)),
    new Set(['joke:first', 'joke:second', 'math:first', 'riddle:first', 'tip:first', 'care:first'])
  );
  verifyPayload(sixTypeBatch.payload, publicKey);

  const shownId = firstBatch.payload.items[0].id;
  const recorded = await jsonResponse(await fetch(`${baseUrl}/api/interactions/events`, {
    method: 'POST',
    headers: licenseHeaders,
    body: JSON.stringify({ events: [{
      eventId: crypto.randomUUID(),
      type: 'content_shown',
      contentId: shownId,
      occurredAt: new Date().toISOString()
    }] })
  }));
  assert.equal(recorded.response.status, 200);

  const nextBatch = await jsonResponse(await fetch(`${baseUrl}/api/content/batch`, {
    method: 'POST',
    headers: licenseHeaders,
    body: JSON.stringify({ limit: 10, excludeIds: ['joke:first'] })
  }));
  assert.equal(nextBatch.response.status, 200);
  assert.equal(nextBatch.payload.items.some((entry) => entry.id === shownId), false);
  assert.equal(nextBatch.payload.items.some((entry) => entry.id === 'joke:first'), false);
  verifyPayload(nextBatch.payload, publicKey);

  const packResponse = await fetch(`${baseUrl}/api/content/offline-pack`, {
    headers: licenseHeaders
  });
  const pack = await packResponse.json();
  assert.equal(packResponse.status, 200);
  assert.equal(pack.kind, 'offline-pack');
  assert.equal(pack.items.length, 3);
  verifyPayload(pack, publicKey);
  const etag = packResponse.headers.get('etag');
  assert.equal(etag, `"${pack.sha256}"`);

  const cached = await fetch(`${baseUrl}/api/content/offline-pack`, {
    headers: { ...licenseHeaders, 'If-None-Match': etag }
  });
  assert.equal(cached.status, 304);

  const sixTypePackResponse = await fetch(`${baseUrl}/api/content/offline-pack`, {
    headers: { ...licenseHeaders, 'X-DeskPet-Version': '2.5.2' }
  });
  const sixTypePack = await sixTypePackResponse.json();
  assert.equal(sixTypePackResponse.status, 200);
  assert.equal(sixTypePack.items.length, 6);
  assert.deepEqual(
    new Set(sixTypePack.items.map((entry) => entry.type)),
    new Set(['joke', 'math', 'riddle', 'tip', 'care'])
  );
  verifyPayload(sixTypePack, publicKey);

  const generatedImportPath = path.join(
    __dirname,
    '..',
    'examples',
    'content-import.zh-CN-trivia-100.json'
  );
  const generatedImportBody = await fs.promises.readFile(generatedImportPath, 'utf8');
  assert.ok(Buffer.byteLength(generatedImportBody) > 32 * 1024);
  const generatedImport = await jsonResponse(await fetch(`${baseUrl}/api/admin/content/import`, {
    method: 'POST',
    headers: adminHeaders,
    body: generatedImportBody
  }));
  assert.equal(generatedImport.response.status, 200);
  assert.equal(generatedImport.payload.created, 100);

  const invalidBulkDisable = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/content/bulk-disable`,
    {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ ids: ['joke:first'], type: 'joke' })
    }
  ));
  assert.equal(invalidBulkDisable.response.status, 400);
  assert.equal(invalidBulkDisable.payload.code, 'INVALID_CONTENT_BULK_DISABLE');

  const selectedDisable = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/content/bulk-disable`,
    {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        ids: ['joke:first', 'math:first', 'trivia:first', 'missing:item']
      })
    }
  ));
  assert.equal(selectedDisable.response.status, 200);
  assert.deepEqual(
    {
      mode: selectedDisable.payload.mode,
      requested: selectedDisable.payload.requested,
      disabled: selectedDisable.payload.disabled,
      unchanged: selectedDisable.payload.unchanged
    },
    { mode: 'ids', requested: 4, disabled: 2, unchanged: 2 }
  );

  const typeDisable = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/content/bulk-disable`,
    {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ type: 'care' })
    }
  ));
  assert.equal(typeDisable.response.status, 200);
  assert.deepEqual(
    {
      mode: typeDisable.payload.mode,
      type: typeDisable.payload.type,
      requested: typeDisable.payload.requested,
      disabled: typeDisable.payload.disabled,
      unchanged: typeDisable.payload.unchanged
    },
    { mode: 'type', type: 'care', requested: 1, disabled: 1, unchanged: 0 }
  );

  const repeatedTypeDisable = await jsonResponse(await fetch(
    `${baseUrl}/api/admin/content/bulk-disable`,
    {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ type: 'care' })
    }
  ));
  assert.equal(repeatedTypeDisable.response.status, 200);
  assert.equal(repeatedTypeDisable.payload.disabled, 0);
  assert.equal(repeatedTypeDisable.payload.changed, false);
  assert.equal(repeatedTypeDisable.payload.catalog.version, typeDisable.payload.catalog.version);
});
