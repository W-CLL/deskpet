const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalMarketStore, LOCAL_TEST_PRODUCT } = require('../lib/local-market-store');

for (const migrationScope of ['local-market', 'pet-market-payments']) {
test(`manual-payment schema migration preserves v2 event-backed entitlements for ${migrationScope}`, async context => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-manual-migration-'));
  let store = new LocalMarketStore(directory, {
    migrationScope, collectionAccountId: 'migration-collection', now: () => Date.parse('2026-10-30T01:00:00.000Z')
  });
  context.after(async () => {
    store.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  await store.initialize();
  const order = store.createOrder('migration-buyer', LOCAL_TEST_PRODUCT.id).order;
  const result = store.recordPaymentEvent({
    eventKey: 'migration-event', accountId: 'migration-collection', category: 'personal_transfer',
    direction: 'incoming', status: 'observed', amountFen: order.amountFen, currency: 'CNY',
    reference: order.paymentReference, transactionId: 'migration-transaction', occurredAt: order.createdAt,
    observedAt: order.createdAt, verified: false
  });
  assert.equal(result.autoApproved, true);
  const before = { order: store.getOrder('migration-buyer', order.id),
    entitlement: store.entitlementFor('migration-buyer', LOCAL_TEST_PRODUCT.id), audit: store.listAudit() };

  // Reconstruct the actual v2 constraint shape with an existing approved payment and grant.
  store.database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE local_market_entitlements_v2 (
      account_id TEXT NOT NULL, product_id TEXT NOT NULL, order_id TEXT NOT NULL UNIQUE,
      payment_event_id TEXT NOT NULL UNIQUE, granted_at TEXT NOT NULL,
      PRIMARY KEY (account_id, product_id),
      FOREIGN KEY (order_id) REFERENCES local_market_orders(id),
      FOREIGN KEY (payment_event_id) REFERENCES local_market_payment_events(id)
    );
    INSERT INTO local_market_entitlements_v2
      SELECT account_id, product_id, order_id, payment_event_id, granted_at FROM local_market_entitlements;
    DROP TABLE local_market_entitlements;
    ALTER TABLE local_market_entitlements_v2 RENAME TO local_market_entitlements;
    DROP TABLE local_market_manual_confirmations;
    DROP INDEX idx_local_market_manual_order_audit;
    DELETE FROM schema_migrations WHERE version = 3;
    COMMIT;
  `);
  store.close();
  await store.initialize();
  assert.deepEqual(store.getOrder('migration-buyer', order.id), before.order);
  assert.deepEqual(store.entitlementFor('migration-buyer', LOCAL_TEST_PRODUCT.id), before.entitlement);
  assert.deepEqual(store.listAudit(), before.audit);
  assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
  const migrated = store.database.prepare('SELECT * FROM local_market_entitlements WHERE order_id = ?').get(order.id);
  assert.equal(migrated.payment_event_id, result.paymentEvent.id);
  assert.equal(migrated.manual_confirmation_order_id, null);
  assert.throws(() => store.database.prepare('UPDATE local_market_entitlements SET payment_event_id = NULL WHERE order_id = ?').run(order.id));
  assert.throws(() => store.database.prepare('UPDATE local_market_entitlements SET manual_confirmation_order_id = ? WHERE order_id = ?').run(order.id, order.id));
  const duplicate = store.recordPaymentEvent({
    eventKey: 'migration-event', accountId: 'migration-collection', category: 'personal_transfer',
    direction: 'incoming', status: 'observed', amountFen: order.amountFen, currency: 'CNY',
    reference: order.paymentReference, transactionId: 'migration-transaction', occurredAt: order.createdAt,
    observedAt: order.createdAt, verified: false
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM local_market_entitlements').get().count, 1);
  assert.equal(store.database.prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE scope = ?').get(migrationScope).version, 3);
  store.close();
  await store.initialize();
  assert.deepEqual(store.entitlementFor('migration-buyer', LOCAL_TEST_PRODUCT.id), before.entitlement);
});
}
