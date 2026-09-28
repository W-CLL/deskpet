const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { hashPassword } = require('../lib/security');
const { ReleaseStore } = require('../lib/storage');
const { HttpError } = require('../src/errors/http-error');
const {
  DEFAULT_DAILY_SUMMARY_SETTINGS,
  SUMMARY_PLACEHOLDERS,
  normalizeDailySummarySettings
} = require('../lib/daily-summary-settings');

function validSettings() {
  return normalizeDailySummarySettings();
}

test('summary defaults include different weekly and monthly templates and independent copies', () => {
  const settings = validSettings();
  assert.deepEqual(settings.weekly, { enabled: true, weekday: 5, time: '18:00' });
  assert.deepEqual(settings.monthly, { enabled: true, time: '09:00' });
  for (const kind of ['weekly', 'monthly']) {
    const templates = settings.templates.filter((template) => template.kind === kind);
    assert.equal(templates.length, 3);
    assert.equal(new Set(templates.map((template) => template.body)).size, 3);
  }
  assert.deepEqual(normalizeDailySummarySettings(settings), settings);
  settings.weekly.time = '20:00';
  settings.templates[0].body = '改过的内容';
  assert.equal(DEFAULT_DAILY_SUMMARY_SETTINGS.weekly.time, '18:00');
  assert.notEqual(validSettings().templates[0].body, '改过的内容');
});

test('summary template validation accepts the supported placeholders and normalizes line endings', () => {
  const settings = validSettings();
  settings.templates[0].title = '  {periodStart} 的回忆  ';
  settings.templates[0].body = `  ${SUMMARY_PLACEHOLDERS.map((key) => `{${key}}`).join('\r\n')}  `;
  const normalized = normalizeDailySummarySettings(settings);
  assert.equal(normalized.templates[0].title, '{periodStart} 的回忆');
  assert.equal(normalized.templates[0].body.includes('\r'), false);
  assert.equal(normalized.templates[0].body.startsWith('{periodStart}'), true);
  assert.equal(normalized.templates[0].body.endsWith('{overtimeDays}'), true);
});

test('summary settings reject malformed configuration without silently coercing it', async (context) => {
  const invalidCases = [
    ['null configuration', () => null],
    ['array configuration', () => []],
    ['missing schedule', (settings) => { delete settings.weekly; }],
    ['missing schema version', (settings) => { delete settings.schemaVersion; }],
    ['unknown schema version', (settings) => { settings.schemaVersion = 2; }],
    ['unknown field', (settings) => { settings.monthly.day = 31; }],
    ['string enabled flag', (settings) => { settings.enabled = 'false'; }],
    ['number enabled flag', (settings) => { settings.weekly.enabled = 1; }],
    ['weekday below range', (settings) => { settings.weekly.weekday = -1; }],
    ['weekday above range', (settings) => { settings.weekly.weekday = 7; }],
    ['fraction weekday', (settings) => { settings.weekly.weekday = 2.5; }],
    ['string weekday', (settings) => { settings.weekly.weekday = '5'; }],
    ['24 hour time', (settings) => { settings.weekly.time = '24:00'; }],
    ['unpadded time', (settings) => { settings.monthly.time = '9:00'; }],
    ['seconds in time', (settings) => { settings.monthly.time = '09:00:00'; }],
    ['invalid minutes', (settings) => { settings.monthly.time = '09:60'; }],
    ['non-array templates', (settings) => { settings.templates = {}; }],
    ['missing kind template', (settings) => { settings.templates = settings.templates.filter((template) => template.kind === 'weekly'); }],
    ['all kind templates disabled', (settings) => { settings.templates.forEach((template) => { if (template.kind === 'weekly') template.enabled = false; }); }],
    ['duplicate template id', (settings) => { settings.templates[1].id = settings.templates[0].id; }],
    ['invalid template id', (settings) => { settings.templates[0].id = 'invalid id'; }],
    ['overlong template id', (settings) => { settings.templates[0].id = 'a'.repeat(65); }],
    ['invalid template kind', (settings) => { settings.templates[0].kind = 'daily'; }],
    ['string template enabled', (settings) => { settings.templates[0].enabled = 'true'; }],
    ['blank title', (settings) => { settings.templates[0].title = '  '; }],
    ['overlong title', (settings) => { settings.templates[0].title = '字'.repeat(81); }],
    ['overlong body', (settings) => { settings.templates[0].body = '字'.repeat(2001); }],
    ['non-text body', (settings) => { settings.templates[0].body = 42; }],
    ['unknown placeholder', (settings) => { settings.templates[0].body = 'Hello {unknown}'; }],
    ['unknown title placeholder', (settings) => { settings.templates[0].title = '{moodScore}'; }],
    ['unclosed placeholder', (settings) => { settings.templates[0].body = '{periodStart'; }],
    ['template expressions', (settings) => { settings.templates[0].body = '{process.exit()}'; }],
    ['html content', (settings) => { settings.templates[0].body = '<script>alert(1)</script>'; }],
    ['html title', (settings) => { settings.templates[0].title = '<img src=x>'; }],
    ['control characters', (settings) => { settings.templates[0].body = 'hello\u0000world'; }],
    ['unknown template field', (settings) => { settings.templates[0].script = 'alert(1)'; }],
    ['more than 40 templates', (settings) => { settings.templates = Array.from({ length: 41 }, (_, index) => ({ ...settings.templates[index % 6], id: `template-${index}` })); }]
  ];
  for (const [label, modify] of invalidCases) {
    await context.test(label, () => {
      const settings = validSettings();
      const input = modify(settings);
      assert.throws(() => normalizeDailySummarySettings(input === undefined ? settings : input), (error) => (
        error instanceof HttpError && error.status === 400 && error.code === 'INVALID_DAILY_SUMMARIES'
      ));
    });
  }
});

test('disabling both summary kinds allows removing all templates', () => {
  const settings = validSettings();
  settings.enabled = false;
  settings.weekly.enabled = false;
  settings.monthly.enabled = false;
  settings.templates = [];
  assert.deepEqual(normalizeDailySummarySettings(settings), settings);
});

test('stored summary settings support edits and deletion, survive old settings writes, and migrate old data', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-summary-store-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new ReleaseStore(directory);
  await store.initialize();
  const settings = validSettings();
  settings.weekly.weekday = 0;
  settings.weekly.time = '17:30';
  settings.templates.push({ id: 'custom-weekly', kind: 'weekly', enabled: true, title: '新的一周', body: '互动了 {totalInteractions} 次。' });
  await store.updateSiteSettings({ dailySummaries: settings });
  const reread = new ReleaseStore(directory);
  await reread.initialize();
  assert.deepEqual(reread.siteSettings().dailySummaries, settings);
  settings.templates.find((template) => template.id === 'custom-weekly').body = '一起答了 {quizzesAnswered} 道题。';
  settings.templates = settings.templates.filter((template) => template.id !== 'weekly-companion');
  await store.updateSiteSettings({ dailySummaries: settings });
  await store.updateSiteSettings({ announcement: '更新了公告' });
  assert.deepEqual(store.siteSettings().dailySummaries, settings);
  const exposed = store.siteSettings();
  exposed.dailySummaries.weekly.time = '01:00';
  exposed.dailySummaries.templates[0].body = 'cannot mutate';
  assert.deepEqual(store.siteSettings().dailySummaries, settings);
  const invalid = structuredClone(settings);
  invalid.monthly.time = '25:00';
  await assert.rejects(store.updateSiteSettings({ dailySummaries: invalid }), { status: 400, code: 'INVALID_DAILY_SUMMARIES' });
  assert.deepEqual(store.siteSettings().dailySummaries, settings);
  const diskData = JSON.parse(await fs.promises.readFile(store.metadataPath, 'utf8'));
  assert.deepEqual(diskData.siteSettings.dailySummaries, settings);
  delete diskData.siteSettings.dailySummaries;
  await fs.promises.writeFile(store.metadataPath, JSON.stringify(diskData));
  const migrated = new ReleaseStore(directory);
  await migrated.initialize();
  assert.deepEqual(migrated.siteSettings().dailySummaries, validSettings());
  const migratedDisk = JSON.parse(await fs.promises.readFile(store.metadataPath, 'utf8'));
  assert.deepEqual(migratedDisk.siteSettings.dailySummaries, validSettings());
});

test('admin API saves templates for the public configuration and reports validation errors as 400', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-summary-api-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  await fs.promises.writeFile(path.join(directory, 'auth.json'), JSON.stringify(await hashPassword('summary test password 123')));
  const application = await createApplication({ publicUrl: 'http://127.0.0.1', dataDirectory: directory, cookieSecure: false, signingPrivateKey: privateKey });
  const server = http.createServer(application.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    application.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'summary test password 123' }) });
  assert.equal(response.status, 200);
  const { csrfToken } = await response.json();
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
  const settings = validSettings();
  settings.weekly.weekday = 4;
  settings.templates[0].title = '管理后台的新模板';
  const saved = await fetch(`${baseUrl}/api/admin/site-settings`, { method: 'PUT', headers, body: JSON.stringify({ dailySummaries: settings }) });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).dailySummaries, settings);
  const invalid = structuredClone(settings);
  invalid.templates[0].body = '{notAllowed}';
  const rejected = await fetch(`${baseUrl}/api/admin/site-settings`, { method: 'PUT', headers, body: JSON.stringify({ dailySummaries: invalid }) });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'INVALID_DAILY_SUMMARIES');
  const oldClientSave = await fetch(`${baseUrl}/api/admin/site-settings`, { method: 'PUT', headers, body: JSON.stringify({ announcement: '只改公告' }) });
  assert.equal(oldClientSave.status, 200);
  assert.deepEqual((await oldClientSave.json()).dailySummaries, settings);
  const publicResponse = await fetch(`${baseUrl}/api/public/site-settings`);
  assert.equal(publicResponse.status, 200);
  const publicSettings = await publicResponse.json();
  assert.deepEqual(publicSettings.dailySummaries, settings);
  assert.deepEqual(Object.keys(publicSettings.dailySummaries).sort(), ['enabled', 'monthly', 'schemaVersion', 'templates', 'weekly']);
  assert.equal(JSON.stringify(publicSettings).includes('summary test password'), false);
  const manyTemplates = validSettings();
  manyTemplates.templates = Array.from({ length: 40 }, (_, index) => ({
    id: `custom-template-${index}`, kind: index % 2 ? 'weekly' : 'monthly', enabled: true,
    title: `模板 ${index}`, body: '中文纯文本。'.repeat(300)
  }));
  const largeBody = JSON.stringify({ dailySummaries: manyTemplates });
  assert.equal(Buffer.byteLength(largeBody) > 32 * 1024, true);
  const largeSave = await fetch(`${baseUrl}/api/admin/site-settings`, { method: 'PUT', headers, body: largeBody });
  assert.equal(largeSave.status, 200);
  assert.deepEqual((await largeSave.json()).dailySummaries, manyTemplates);
});
