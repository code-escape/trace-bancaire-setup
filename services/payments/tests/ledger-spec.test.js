'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  PARAMS,
  generateLegit,
  generateHistoricalDuplicates,
  expectedTotalsByAccount,
  generatePreseededLedger,
} = require('../src/ledger-spec');

const TEAM = 'team-fixture-13-3';

test('déterministe : même teamId → mêmes ordres légitimes', () => {
  assert.deepEqual(generateLegit(TEAM), generateLegit(TEAM));
});

test('équipes distinctes → légitimes distincts', () => {
  assert.notDeepEqual(generateLegit('team-aaa'), generateLegit('team-bbb'));
});

test('cardinalité : ~200 légitimes, ~30 doublons historiques', () => {
  const legit = generateLegit(TEAM);
  assert.equal(legit.length, PARAMS.legitCount);
  assert.equal(generateHistoricalDuplicates(TEAM, legit).length, PARAMS.historicalDupCount);
});

test('messageId uniques parmi les légitimes (le stream ne se contredit pas)', () => {
  const ids = generateLegit(TEAM).map((o) => o.messageId);
  assert.equal(new Set(ids).size, ids.length);
});

test('≥1 paire jumelle légitime : même from/to/amount, messageId distincts', () => {
  const legit = generateLegit(TEAM);
  const twins = legit.filter((o) => o.twin !== undefined);
  assert.ok(twins.length >= 2, 'au moins une paire (2 ordres) jumelle');
  // Regroupe par index de paire et vérifie l'identité de contenu / distinction de messageId.
  const byPair = new Map();
  for (const o of twins) {
    if (!byPair.has(o.twin)) byPair.set(o.twin, []);
    byPair.get(o.twin).push(o);
  }
  for (const [, pair] of byPair) {
    assert.equal(pair.length, 2, 'exactement 2 ordres par paire jumelle');
    const [a, b] = pair;
    assert.equal(a.from, b.from);
    assert.equal(a.to, b.to);
    assert.equal(a.amount, b.amount);
    assert.notEqual(a.messageId, b.messageId, 'messageId distincts → ce ne sont PAS des doublons techniques');
  }
});

test('doublons historiques : mêmes messageId que des légitimes existants (rejeu)', () => {
  const legit = generateLegit(TEAM);
  const legitIds = new Set(legit.map((o) => o.messageId));
  for (const d of generateHistoricalDuplicates(TEAM, legit)) {
    assert.ok(legitIds.has(d.messageId), 'un doublon historique réfère un messageId légitime');
  }
});

test('cohérence interne : ledger pré-seedé = légitimes ∪ doublons historiques', () => {
  const legit = generateLegit(TEAM);
  const dups = generateHistoricalDuplicates(TEAM, legit);
  const ledger = generatePreseededLedger(TEAM);
  assert.equal(ledger.length, legit.length + dups.length);
  // Comptage par messageId : chaque légitime apparaît 1× + sa multiplicité de rejeu.
  const expected = new Map();
  for (const o of legit) expected.set(o.messageId, (expected.get(o.messageId) || 0) + 1);
  for (const d of dups) expected.set(d.messageId, (expected.get(d.messageId) || 0) + 1);
  const got = new Map();
  for (const r of ledger) got.set(r.messageId, (got.get(r.messageId) || 0) + 1);
  assert.deepEqual([...got.entries()].sort(), [...expected.entries()].sort());
});

test('ledger pré-seedé trié chronologiquement, id séquentiels', () => {
  const ledger = generatePreseededLedger(TEAM);
  for (let i = 1; i < ledger.length; i++) {
    assert.ok(ledger[i].tsMs >= ledger[i - 1].tsMs, 'ordre chronologique');
    assert.equal(ledger[i].id, ledger[i - 1].id + 1, 'id séquentiels');
  }
});

test('totaux attendus dérivés des seuls légitimes (jumelle comptée une fois chacune)', () => {
  const legit = generateLegit(TEAM);
  const totals = expectedTotalsByAccount(TEAM);
  // Recompose indépendamment depuis les légitimes.
  const ref = new Map();
  for (const o of legit) {
    ref.set(o.to, (ref.get(o.to) || 0) + o.amount);
    ref.set(o.from, (ref.get(o.from) || 0) - o.amount);
  }
  assert.deepEqual([...totals.entries()].sort(), [...ref.entries()].sort());
  // Les doublons historiques NE doivent PAS influencer les totaux attendus.
  const dupAccts = new Set(generateHistoricalDuplicates(TEAM, legit).flatMap((d) => [d.from, d.to]));
  assert.ok(dupAccts.size > 0);
});

test('totaux nets : somme globale nulle (chaque virement débite et crédite)', () => {
  let sum = 0;
  for (const [, v] of expectedTotalsByAccount(TEAM)) sum += v;
  assert.equal(Math.round(sum), 0);
});
