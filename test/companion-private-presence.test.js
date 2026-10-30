const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CompanionStore } = require('../lib/companion-store');
const { CompanionService } = require('../src/services/companion-service');

async function fixture(context) {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-private-presence-'));
  const store = new CompanionStore(dataDirectory, { cooldownMs: 0 });
  await store.initialize();
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });
  const row = (accountId) => store.database.prepare('SELECT * FROM companion_profiles WHERE account_id = ?')
    .get(accountId);
  const pair = () => {
    store.ensureProfile('sender');
    const recipient = store.ensureProfile('recipient');
    store.pair('sender', recipient.pairing_code);
  };
  return { store, row, pair };
}

function delivery() {
  const id = crypto.randomUUID();
  return { id, fileName: `${id}.gif`, size: 43, sha256: 'a'.repeat(64), width: 1, height: 1 };
}

test('private presence follows owner profile and inbox requests even with the hall disabled', async (context) => {
  const { store, row, pair } = await fixture(context);
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-30T04:00:00.000Z') });
  pair();
  assert.equal(store.profile('sender').partner.online, false, 'pairing must not mark the recipient online');
  const recipientProfile = store.profile('recipient');
  assert.equal(recipientProfile.hallEnabled, false);
  assert.equal(recipientProfile.online, false);
  assert.equal(store.profile('sender').partner.online, true);
  const firstSeen = row('recipient').private_last_seen_at;
  assert.equal(row('recipient').last_seen_at, null);

  context.mock.timers.tick(14_999);
  store.pending('recipient', 'desktop-license');
  assert.equal(row('recipient').private_last_seen_at, firstSeen, 'heartbeat writes remain throttled');
  context.mock.timers.tick(1);
  store.pending('recipient', 'other-device-license');
  assert.notEqual(row('recipient').private_last_seen_at, firstSeen, 'another device on the account is sufficient');
  assert.equal(store.profile('sender').partner.online, true);
  assert.equal(row('recipient').last_seen_at, null, 'private polling must not create public hall presence');
});

test('private presence expires at 90 seconds and reading the partner does not keep it online', async (context) => {
  const { store, row, pair } = await fixture(context);
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-30T05:00:00.000Z') });
  pair();
  store.pending('recipient', 'desktop-license');
  const firstSeen = row('recipient').private_last_seen_at;
  context.mock.timers.tick(89_999);
  assert.equal(store.profile('sender').partner.online, true);
  assert.equal(row('recipient').private_last_seen_at, firstSeen);
  context.mock.timers.tick(1);
  assert.equal(store.profile('sender').partner.online, false);
  store.pending('recipient', 'desktop-license');
  assert.equal(store.profile('sender').partner.online, true);
});

test('passive creation, admin reads and incoming deliveries never mark a recipient online', async (context) => {
  const { store, row, pair } = await fixture(context);
  pair();
  store.ensureProfile('recipient', { hallEnabled: true });
  store.findDisplayName('recipient');
  store.displayNameByAccountId();
  store.adminStats();
  assert.equal(row('recipient').private_last_seen_at, null);
  store.createAdminDelivery('operator', 'recipient', delivery());
  store.createDelivery('sender', delivery());
  assert.equal(store.profile('sender').partner.online, false);
  assert.equal(row('recipient').private_last_seen_at, null);
  assert.equal(row('operator').private_last_seen_at, null);
  assert.equal(store.pending('recipient', 'returning-license').length, 2, 'offline deliveries remain queued');
  assert.equal(store.profile('sender').partner.online, true);
});

test('hall opt-out hides a connected private partner from the hall and blocks hall deliveries', async (context) => {
  const { store, row, pair } = await fixture(context);
  pair();
  store.setHallEnabled('sender', true);
  store.setHallEnabled('recipient', true);
  assert.equal(store.hall('sender').people.length, 1);
  store.setHallEnabled('recipient', false);
  const optedOutAt = row('recipient').hall_opted_out_at;
  assert.equal(store.profile('sender').partner.online, true);
  assert.deepEqual(store.hall('sender').people, []);
  assert.throws(() => store.createHallDelivery('sender', 'recipient', delivery()), /HALL_RECIPIENT_OFFLINE/);
  store.pending('recipient', 'desktop-license');
  assert.equal(row('recipient').hall_enabled, 0);
  assert.equal(row('recipient').last_seen_at, null);
  assert.equal(row('recipient').hall_choice, 'manual_off');
  assert.equal(row('recipient').hall_opted_out_at, optedOutAt);
});

test('private presence cannot revive stale hall presence until the owner requests again', async (context) => {
  const { store, row, pair } = await fixture(context);
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-30T06:00:00.000Z') });
  pair();
  store.setHallEnabled('sender', true);
  store.setHallEnabled('recipient', true);
  context.mock.timers.tick(90_000);
  assert.equal(store.profile('sender').partner.online, false);
  assert.deepEqual(store.hall('sender').people, []);
  assert.throws(() => store.createHallDelivery('sender', 'recipient', delivery()), /HALL_RECIPIENT_OFFLINE/);
  store.pending('recipient', 'desktop-license');
  assert.equal(store.profile('sender').partner.online, true);
  assert.equal(store.hall('sender').people.length, 1);
  assert.equal(row('recipient').hall_choice, 'manual_on');
});

test('unpaired and trial responses expose no private partner or heartbeat timestamp', async (context) => {
  const { store, pair } = await fixture(context);
  const unpaired = store.profile('unpaired');
  assert.equal(unpaired.partner, null);
  assert.deepEqual(Object.keys(unpaired).sort(), ['displayName', 'hallEnabled', 'online', 'pairingCode', 'partner']);
  pair();
  store.profile('recipient');
  const paired = store.profile('sender');
  assert.deepEqual(Object.keys(paired.partner).sort(), ['displayName', 'online', 'pairedAt']);
  const service = new CompanionService({ companionStore: store });
  const trial = service.clientProfile({ trial: true }, paired);
  assert.equal(trial.partner, null);
  assert.equal(trial.pairingCode, '');
  assert.throws(() => store.pair('trial:installation', store.ensureProfile('unpaired').pairing_code), /搭子码无效/);
});
