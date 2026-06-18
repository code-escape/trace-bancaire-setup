'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Spécification déterministe du ledger de virements — épreuve 4 « Le virement en double ».
//
// SOURCE DE VÉRITÉ UNIQUE (story 13.3). Générée à partir de seed = teamId, de façon
// purement arithmétique (FNV+LCG, même RNG que dataset-spec.js), pour que :
//   - setup.sh seed le Stream Redis `virements` (ordres légitimes uniquement) ;
//   - setup.sh seed le ledger Postgres (légitimes + paire(s) jumelle(s) + doublons
//     historiques de rejeux passés), table SANS colonne message_id ;
//   - le harnais payments-probe recalcule les totaux ATTENDUS par compte (légitimes,
//     chaque jumelle comptée une fois) pour la réconciliation.
//
// Contrairement à dataset-spec (13.2), le juge plateforme NE re-dérive PAS cette spec :
// il lit des mesures brutes du probe. Le contrat cross-repo critique ici est INTERNE au
// bundle : stream(légitimes) + doublons_historiques = ledger pré-seedé, et les totaux
// attendus se recomposent depuis les seuls légitimes. C'est ce que les tests verrouillent.
//
// PIÈGE pédagogique : au moins une PAIRE JUMELLE (même from/to/amount, messageId distincts)
// est légitime — elle punit la déduplication sur le contenu plutôt que sur le messageId.
// ──────────────────────────────────────────────────────────────────────────────

const PARAMS = Object.freeze({
  legitCount: 200, // ordres de virement légitimes (présents dans le stream)
  twinPairs: 2, // nb de paires jumelles légitimes (même from/to/amount, messageId distincts)
  historicalDupCount: 30, // rejeux passés déjà matérialisés dans le ledger (pas dans le stream)
});

const ACCT_MIN = 10000000;
const ACCT_SPAN = 89999999;
const DAY_MS = 86400000;
const AMOUNT_MIN = 50; // €
const AMOUNT_SPAN = 9950; // 50..9999 €

function makeRng(seedStr) {
  let s = 2166136261 >>> 0;
  for (const ch of String(seedStr)) {
    s ^= ch.charCodeAt(0);
    s = Math.imul(s, 16777619) >>> 0;
  }
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const account = (n) => `FR76${String(n).padStart(8, '0')}`;

/**
 * Génère les ordres de virement LÉGITIMES, déterministes par teamId, dont `twinPairs`
 * paires jumelles (même from/to/amount, messageId distincts). C'est le contenu du Stream.
 * Triés chronologiquement ; messageId = `m${seq}` (séquence stable, non révélatrice de structure).
 * @returns {{ messageId, from, to, amount, tsMs }[]}
 */
function generateLegit(teamId) {
  const rng = makeRng(teamId);
  const nowMidnight = Math.floor(Date.UTC(2026, 5, 17) / DAY_MS) * DAY_MS;
  const windowMs = 7 * DAY_MS;
  const windowStart = nowMidnight - windowMs;

  const draw = () => account(ACCT_MIN + Math.floor(rng() * ACCT_SPAN));
  const amount = () => AMOUNT_MIN + Math.floor(rng() * AMOUNT_SPAN);
  const ts = () => windowStart + Math.floor(rng() * windowMs);

  const orders = [];
  // Ordres « ordinaires » : on en génère assez pour laisser de la place aux jumelles.
  const ordinary = PARAMS.legitCount - PARAMS.twinPairs * 2;
  for (let i = 0; i < ordinary; i++) {
    orders.push({ from: draw(), to: draw(), amount: amount(), tsMs: ts() });
  }
  // Paires jumelles : deux virements STRICTEMENT identiques en contenu, à des instants proches.
  for (let p = 0; p < PARAMS.twinPairs; p++) {
    const from = draw();
    const to = draw();
    const amt = amount();
    const t0 = ts();
    orders.push({ from, to, amount: amt, tsMs: t0, twin: p });
    orders.push({ from, to, amount: amt, tsMs: t0 + 1 + Math.floor(rng() * 3600000), twin: p });
  }

  // Tri chronologique puis attribution des messageId (séquence non révélatrice de la structure).
  orders.sort((a, b) => a.tsMs - b.tsMs);
  return orders.map((o, i) => ({
    messageId: `m${i + 1}`,
    from: o.from,
    to: o.to,
    amount: o.amount,
    tsMs: o.tsMs,
    ...(o.twin !== undefined ? { twin: o.twin } : {}),
  }));
}

/**
 * Doublons HISTORIQUES : ~30 réinsertions d'ordres légitimes existants (mêmes messageId),
 * issues de rejeux passés. Présents UNIQUEMENT dans le ledger pré-seedé (jamais dans le stream).
 * Ce sont eux qui font diverger la réconciliation dès l'ouverture et qu'il faut assainir.
 * @returns {{ messageId, from, to, amount, tsMs }[]}
 */
function generateHistoricalDuplicates(teamId, legit) {
  const rng = makeRng(`${teamId}#dups`);
  const dups = [];
  for (let i = 0; i < PARAMS.historicalDupCount; i++) {
    const src = legit[Math.floor(rng() * legit.length)];
    dups.push({ messageId: src.messageId, from: src.from, to: src.to, amount: src.amount, tsMs: src.tsMs });
  }
  return dups;
}

/**
 * Totaux NETS attendus par compte, dérivés des SEULS ordres légitimes (chaque jumelle comptée
 * une fois — ce sont des virements distincts légitimes). Surface de vérité de la réconciliation :
 * un ledger assaini doit retrouver exactement ces totaux. Convention : +montant pour `to`
 * (crédit), -montant pour `from` (débit).
 * @returns {Map<string, number>}
 */
function expectedTotalsByAccount(teamId) {
  const legit = generateLegit(teamId);
  const totals = new Map();
  const add = (acct, delta) => totals.set(acct, (totals.get(acct) || 0) + delta);
  for (const o of legit) {
    add(o.to, o.amount);
    add(o.from, -o.amount);
  }
  return totals;
}

/**
 * Ledger PRÉ-SEEDÉ complet (état initial divergent) : légitimes + doublons historiques,
 * triés chronologiquement, id séquentiels. Pas de champ message_id matérialisé en base
 * (la colonne est absente du schéma au départ) — il est porté ici pour permettre la
 * vérification interne et le seed, mais setup.sh n'insère QUE id/from/to/amount/ts.
 * @returns {{ id, messageId, from, to, amount, tsMs }[]}
 */
function generatePreseededLedger(teamId) {
  const legit = generateLegit(teamId);
  const dups = generateHistoricalDuplicates(teamId, legit);
  const all = [...legit.map((o) => ({ ...o })), ...dups.map((o) => ({ ...o }))];
  all.sort((a, b) => a.tsMs - b.tsMs);
  return all.map((o, i) => ({
    id: i + 1,
    messageId: o.messageId,
    from: o.from,
    to: o.to,
    amount: o.amount,
    tsMs: o.tsMs,
  }));
}

module.exports = {
  PARAMS,
  generateLegit,
  generateHistoricalDuplicates,
  expectedTotalsByAccount,
  generatePreseededLedger,
};
