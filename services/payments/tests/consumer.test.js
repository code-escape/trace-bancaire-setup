'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createConsumer } = require('../src/consumer');

// Faux clients injectés — aucun pg/redis réel chargé.
function fakeDb() {
  const rows = [];
  return {
    rows,
    async query(text, params) {
      if (/^INSERT INTO ledger/i.test(text)) rows.push(params);
      return { rowCount: 1 };
    },
  };
}

const ORDERS = [
  { _id: '1-0', messageId: 'm1', from: 'FR7600000001', to: 'FR7600000002', amount: 100, ts: '2026-06-16T10:00:00Z' },
  { _id: '2-0', messageId: 'm2', from: 'FR7600000003', to: 'FR7600000004', amount: 250, ts: '2026-06-16T11:00:00Z' },
];

test('processBatch insère un ordre par message livré, puis ACK', async () => {
  const db = fakeDb();
  const acked = [];
  const consumer = createConsumer({ db, stream: { ack: async (id) => acked.push(id) }, logger: () => {} });
  const n = await consumer.processBatch(ORDERS);
  assert.equal(n, 2);
  assert.equal(db.rows.length, 2);
  assert.deepEqual(acked, ['1-0', '2-0']);
});

test('INSERT naïf : une re-livraison (replay) DUPLIQUE les écritures', async () => {
  const db = fakeDb();
  const consumer = createConsumer({ db, stream: {}, logger: () => {} });
  await consumer.processBatch(ORDERS);
  await consumer.processBatch(ORDERS); // re-livraison après XGROUP SETID 0 → mêmes messages
  assert.equal(db.rows.length, 4, 'aucune clé d’idempotence → doublons');
});

test('le messageId est logué (fil du diagnostic) mais pas utilisé pour l’INSERT', async () => {
  const db = fakeDb();
  const logs = [];
  const consumer = createConsumer({ db, stream: {}, logger: (m) => logs.push(m) });
  await consumer.processBatch(ORDERS);
  assert.ok(logs.some((l) => l.includes('messageId=m1')));
  // Les paramètres d'INSERT ne contiennent que from/to/amount/ts (pas de messageId).
  assert.deepEqual(db.rows[0], ['FR7600000001', 'FR7600000002', 100, '2026-06-16T10:00:00Z']);
});
