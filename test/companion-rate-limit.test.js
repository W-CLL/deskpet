const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CompanionStore } = require('../lib/companion-store');

function delivery(id) {
  return {
    id,
    fileName: `${id}.gif`,
    size: 43,
    sha256: 'a'.repeat(64),
    width: 1,
    height: 1
  };
}

test('private and hall deliveries use independent 1s and 15s cooldowns', async (context) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-companion-rate-'));
  const store = new CompanionStore(dataDirectory, { maxPending: 20 });
  await store.initialize();
  context.after(async () => {
    store.close();
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  assert.equal(store.pairCooldownMs, 1000);
  assert.equal(store.hallCooldownMs, 15_000);

  const senderId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const recipient = store.ensureProfile(recipientId);
  store.ensureProfile(senderId);
  store.pair(senderId, recipient.pairing_code);
  store.setHallEnabled(senderId, true);
  store.setHallEnabled(recipientId, true);

  const firstPairId = crypto.randomUUID();
  const firstHallId = crypto.randomUUID();
  store.createDelivery(senderId, delivery(firstPairId));
  assert.doesNotThrow(() => store.createHallDelivery(
    senderId,
    recipientId,
    delivery(firstHallId)
  ), 'a private send must not consume the independent hall allowance');

  assert.throws(
    () => store.createDelivery(senderId, delivery(crypto.randomUUID())),
    /发送太快/
  );
  assert.throws(
    () => store.createHallDelivery(senderId, recipientId, delivery(crypto.randomUUID())),
    /发送太快/
  );

  store.database.prepare('UPDATE companion_deliveries SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1100).toISOString(), firstPairId);
  assert.doesNotThrow(() => store.createDelivery(senderId, delivery(crypto.randomUUID())));

  store.database.prepare('UPDATE companion_deliveries SET created_at = ? WHERE source = ?')
    .run(new Date(Date.now() - 15_100).toISOString(), 'hall');
  assert.doesNotThrow(() => store.createHallDelivery(
    senderId,
    recipientId,
    delivery(crypto.randomUUID())
  ));
});

test('legacy cooldownMs still overrides both channels for existing fixtures', () => {
  const store = new CompanionStore(os.tmpdir(), { cooldownMs: 37 });
  assert.equal(store.pairCooldownMs, 37);
  assert.equal(store.hallCooldownMs, 37);
});
