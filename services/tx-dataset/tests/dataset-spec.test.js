'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  generateDataset,
  generateCalibratedDataset,
  muleAccountsFor,
  assertCalibration,
  PARAMS,
} = require('../src/dataset-spec');

// ── Vecteur de cohérence FIGÉ (contrat cross-repo bundle ↔ juge challenges-service) ──
// Toute modification de la spec déterministe qui change ces valeurs DOIT être répercutée
// dans le juge (challenges-service) et la politique AML — sinon dérive silencieuse.
const FIXTURE_TEAM = 'team-fixture-13-2';
const FIXTURE_MULES = [
  'FR7614976809', 'FR7620650223', 'FR7622385181', 'FR7624743169',
  'FR7644497590', 'FR7651838470', 'FR7652637755', 'FR7658122692',
  'FR7659453236', 'FR7663201680', 'FR7671379680', 'FR7676483249',
  'FR7695307402', 'FR7697258800',
];
const FIXTURE_PARAMS = { declarationThreshold: 10000, aggThreshold: 50000, windowDays: 7 };

test('vecteur figé : seed connu → mules + seuils exacts', () => {
  // Point d'entrée réel (bundle + juge) — attempt 0 satisfait le calibrage pour cette graine.
  const d = generateCalibratedDataset(FIXTURE_TEAM, { noiseCount: 2000 });
  assert.equal(d.seed, FIXTURE_TEAM, 'aucun ré-essai nécessaire pour la graine figée');
  assert.deepEqual(d.mules, FIXTURE_MULES);
  assert.equal(PARAMS.declarationThreshold, FIXTURE_PARAMS.declarationThreshold);
  assert.equal(PARAMS.aggThreshold, FIXTURE_PARAMS.aggThreshold);
  assert.equal(PARAMS.windowDays, FIXTURE_PARAMS.windowDays);
});

test('muleAccountsFor (surface portée par le juge) == mules du dataset complet', () => {
  assert.deepEqual(muleAccountsFor(FIXTURE_TEAM), FIXTURE_MULES);
  assert.deepEqual(muleAccountsFor('team-xyz'), generateDataset('team-xyz', { noiseCount: 500 }).mules);
});

test('déterministe : même teamId → mêmes mules', () => {
  const a = generateDataset('team-xyz', { noiseCount: 1000 });
  const b = generateDataset('team-xyz', { noiseCount: 1000 });
  assert.deepEqual(a.mules, b.mules);
  assert.deepEqual(a.falsePositives, b.falsePositives);
});

test('équipes distinctes → mules distinctes', () => {
  const a = generateDataset('team-aaa', { noiseCount: 1000 }).mules;
  const b = generateDataset('team-bbb', { noiseCount: 1000 }).mules;
  assert.notDeepEqual(a, b);
});

test('calibrage satisfait sur plusieurs graines', () => {
  for (const t of ['team-a', 'team-b', 'team-c', 'equipe-42', 'xKJ-9']) {
    const r = assertCalibration(generateDataset(t, { noiseCount: 1500 }));
    assert.ok(r.ok, `${t}: ${r.failures.join('; ')}`);
  }
});

test('mules non devinables par identifiant (dispersées, pas de suite contiguë)', () => {
  const nums = generateDataset(FIXTURE_TEAM, { noiseCount: 1000 }).mules.map((a) => parseInt(a.slice(4), 10));
  let contiguous = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] === 1) contiguous++;
  assert.equal(contiguous, 0, 'aucun identifiant de mule consécutif');
});

test('exactitude : aucun compte non-mule ne matche le pattern de structuring', () => {
  const d = generateDataset(FIXTURE_TEAM, { noiseCount: 100000 });
  const muleSet = new Set(d.mules);
  const by = new Map();
  for (const t of d.transactions) {
    if (!by.has(t.counterparty)) by.set(t.counterparty, []);
    by.get(t.counterparty).push(t);
  }
  let falseStructuring = 0;
  for (const [acct, list] of by) {
    if (muleSet.has(acct)) continue;
    const banded = list.length >= 6 && list.every((t) => t.amount >= 9000 && t.amount <= 9900);
    const sum = list.reduce((a, t) => a + t.amount, 0);
    if (banded && sum > PARAMS.aggThreshold) falseStructuring++;
  }
  assert.equal(falseStructuring, 0);
});

test('asymétrie : les transactions ne portent aucune étiquette mule', () => {
  const d = generateDataset('team-a', { noiseCount: 200 });
  for (const tx of d.transactions.slice(0, 50)) {
    assert.deepEqual(Object.keys(tx).sort(), ['amount', 'counterparty', 'id', 'ts']);
  }
});
