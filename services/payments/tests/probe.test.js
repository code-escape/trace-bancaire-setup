'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createProbe, reconcile } = require('../src/probe');
const { detectIdempotencyKey, BUSINESS_COLS } = require('../src/db');

// ── Introspection de la contrainte (PURE, indépendante du nom de colonne) ──
test('detectIdempotencyKey : UNIQUE mono-colonne hors métier → true', () => {
  assert.equal(detectIdempotencyKey([['message_id']]), true);
  assert.equal(detectIdempotencyKey([['msg_uuid']]), true, 'nom de colonne libre');
});

test('detectIdempotencyKey : seulement des colonnes métier → false', () => {
  assert.equal(detectIdempotencyKey([['id']]), false);
  assert.equal(detectIdempotencyKey([['from_acct', 'to_acct', 'amount']]), false, 'multi-colonnes ≠ clé d’idempotence');
  assert.equal(detectIdempotencyKey([]), false);
  // garde-fou : aucune des colonnes métier connues ne compte comme clé
  for (const col of BUSINESS_COLS) assert.equal(detectIdempotencyKey([[col]]), false);
});

// ── Réconciliation (PURE) ──
test('reconcile : totaux égaux → match', () => {
  const e = new Map([['A', 100], ['B', -100]]);
  const o = new Map([['A', 100], ['B', -100]]);
  const r = reconcile(e, o);
  assert.equal(r.totalsMatch, true);
  assert.ok(r.perAccount.every((p) => p.ok));
});

test('reconcile : doublon historique gonfle un compte → mismatch', () => {
  const e = new Map([['A', 100], ['B', -100]]);
  const o = new Map([['A', 150], ['B', -100]]); // A sur-crédité (doublon non purgé)
  const r = reconcile(e, o);
  assert.equal(r.totalsMatch, false);
  assert.equal(r.perAccount.find((p) => p.acct === 'A').ok, false);
});

// ── Faux clients pour le probe ──
function fakeDb({ counts, totals, unique }) {
  let i = 0;
  return {
    async count() { return counts[Math.min(i++, counts.length - 1)]; },
    async totalsByAccount() { return totals; },
    async uniqueColumns() { return unique; },
  };
}

async function callReplay(probe) {
  return probe.replayProbe();
}

test('replay-probe renvoie des mesures BRUTES (pas de verdict) après restart', async () => {
  let restarted = false;
  const probe = createProbe({
    db: fakeDb({ counts: [230, 230, 230], totals: new Map([['A', 100]]), unique: [['message_id']] }),
    restartConsumer: async () => { restarted = true; },
    expectedTotals: new Map([['A', 100]]),
    cfg: { pollMs: 1, stableChecks: 2, drainTimeoutMs: 1000 },
    logger: () => {},
  });
  const m = await callReplay(probe);
  assert.equal(restarted, true, 'le consumer est redémarré');
  assert.deepEqual(Object.keys(m).sort(), ['countAfter', 'countBefore', 'hasUniqueOnMessageId', 'perAccount', 'totalsMatch']);
  assert.equal('status' in m, false, 'aucun verdict réussi/raté');
});

test('replay-probe : correctif robuste → count stable + unique + totaux conformes', async () => {
  const probe = createProbe({
    db: fakeDb({ counts: [230, 230, 230], totals: new Map([['A', 100], ['B', -100]]), unique: [['id'], ['message_id']] }),
    restartConsumer: async () => {},
    expectedTotals: new Map([['A', 100], ['B', -100]]),
    cfg: { pollMs: 1, stableChecks: 2, drainTimeoutMs: 1000 },
    logger: () => {},
  });
  const m = await probe.replayProbe();
  assert.equal(m.countBefore, m.countAfter);
  assert.equal(m.hasUniqueOnMessageId, true);
  assert.equal(m.totalsMatch, true);
});

test('replay-probe : dédup mémoire → countAfter > countBefore (restart relit tout)', async () => {
  // count: before=230, puis le drain remonte à 260 et se stabilise.
  const probe = createProbe({
    db: fakeDb({ counts: [230, 260, 260, 260], totals: new Map([['A', 130]]), unique: [['id']] }),
    restartConsumer: async () => {},
    expectedTotals: new Map([['A', 100]]),
    cfg: { pollMs: 1, stableChecks: 2, drainTimeoutMs: 1000 },
    logger: () => {},
  });
  const m = await probe.replayProbe();
  assert.ok(m.countAfter > m.countBefore);
  assert.equal(m.hasUniqueOnMessageId, false);
});

test('reconciliation (lecture seule) ne redémarre pas le consumer', async () => {
  let restarted = false;
  const probe = createProbe({
    db: fakeDb({ counts: [230], totals: new Map([['A', 100]]), unique: [] }),
    restartConsumer: async () => { restarted = true; },
    expectedTotals: new Map([['A', 100]]),
    logger: () => {},
  });
  const r = await probe.reconciliation();
  assert.equal(restarted, false);
  assert.equal(r.totalsMatch, true);
  assert.ok(Array.isArray(r.perAccount));
});
