'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Spécification déterministe du dataset AML — épreuve 3 « Le schtroumpfage ».
//
// SOURCE DE VÉRITÉ UNIQUE (story 13.2). Générée à partir de seed = teamId, de façon
// purement arithmétique (LCG), pour que :
//   - le bundle peuple le Postgres sandbox avec ce dataset ;
//   - le juge (challenges-service) re-dérive la MÊME liste de mules sans qu'elle
//     ne transite jamais sur le réseau ;
//   - la politique AML cite EXACTEMENT ces chiffres.
//
// Architecture cross-repo : la SÉLECTION des comptes (selectAccounts) est un préfixe
// déterministe AUTONOME, indépendant de la génération des transactions. Le juge ne porte
// QUE ce préfixe (petit, stable) ; un vecteur figé (tests) garde contre la dérive.
//
// Asymétrie d'information : les transactions ne portent AUCUNE étiquette « mule ». Mules,
// faux positifs et bruit partagent le même espace d'identifiants (non étiquetant). L'ordre
// et les id sont chronologiques (ne trahissent pas la structure).
// ──────────────────────────────────────────────────────────────────────────────

const PARAMS = Object.freeze({
  declarationThreshold: 10000, // seuil de déclaration unitaire (€)
  aggThreshold: 50000, // seuil agrégé sur la fenêtre (cumul/bénéficiaire > ça = suspect)
  windowDays: 7, // largeur de la fenêtre réglementaire glissante
  noiseCount: 100000, // volume de transactions de bruit
});

const ACCT_MIN = 10000000;
const ACCT_SPAN = 89999999;
const DAY_MS = 86400000;

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
 * Préfixe déterministe AUTONOME : tire le nombre de mules / faux positifs et leurs comptes,
 * AVANT toute génération de transaction. C'est le SEUL morceau que le juge doit reproduire.
 * @returns {{ rng, muleCount, fpCount, mules: string[], falsePositives: string[] }}
 */
function selectAccounts(teamId) {
  const rng = makeRng(teamId);
  const muleCount = 8 + Math.floor(rng() * 8); // 8..15
  const fpCount = 5 + Math.floor(rng() * 6); // 5..10
  const used = new Set();
  const draw = () => {
    let acct;
    do {
      acct = account(ACCT_MIN + Math.floor(rng() * ACCT_SPAN));
    } while (used.has(acct));
    used.add(acct);
    return acct;
  };
  const mules = [];
  for (let m = 0; m < muleCount; m++) mules.push(draw());
  const falsePositives = [];
  for (let f = 0; f < fpCount; f++) falsePositives.push(draw());
  return { rng, muleCount, fpCount, mules, falsePositives };
}

/** Liste triée des comptes mules attendue (réponse du juge). Surface portée cross-repo. */
function muleAccountsFor(teamId) {
  return selectAccounts(teamId).mules.slice().sort();
}

/**
 * Génère le dataset déterministe complet pour une équipe.
 * @param {string} teamId
 * @param {{ noiseCount?: number, now?: number }} [opts]
 */
function generateDataset(teamId, opts = {}) {
  const noiseCount = opts.noiseCount ?? PARAMS.noiseCount;
  const nowMidnight = Math.floor((opts.now ?? Date.UTC(2026, 5, 17)) / DAY_MS) * DAY_MS;
  const windowMs = PARAMS.windowDays * DAY_MS;
  const windowStart = nowMidnight - windowMs;

  // Préfixe de sélection (mules + faux positifs) ; on continue avec le MÊME rng ensuite.
  const sel = selectAccounts(teamId);
  const { rng, mules, falsePositives } = sel;

  const raw = [];
  const push = (amount, acct, ts) =>
    raw.push({ amount: Math.round(amount * 100) / 100, counterparty: acct, tsMs: ts });

  // ── Mules : structuring sous le seuil, cumul > seuil agrégé ─────────────────
  mules.forEach((acct, m) => {
    const nTransfers = 6 + Math.floor(rng() * 5); // 6..10
    const straddle = m < 2; // ≥ 2 mules à cheval sur un minuit (déjoue un GROUP BY par jour)
    for (let t = 0; t < nTransfers; t++) {
      const amount = 9000 + Math.floor(rng() * 900); // 9000..9899 (90–99 % du seuil)
      let ts;
      if (straddle) {
        const boundary = windowStart + Math.floor(PARAMS.windowDays / 2) * DAY_MS;
        ts = t % 2 === 0 ? boundary - 1 - Math.floor(rng() * 3600000) : boundary + Math.floor(rng() * 3600000);
      } else {
        ts = windowStart + Math.floor(rng() * windowMs);
      }
      push(amount, acct, ts);
    }
  });

  // ── Faux positifs : gros volume mais légitime (montants francs, souvent > seuil) ──
  falsePositives.forEach((acct) => {
    const nTransfers = 3 + Math.floor(rng() * 4);
    for (let t = 0; t < nTransfers; t++) {
      const amount = 12000 + Math.floor(rng() * 40000);
      push(amount, acct, windowStart + Math.floor(rng() * windowMs));
    }
  });

  // ── Bruit (~100k) : comptes variés, montants variés dont des isolées sous le seuil ──
  for (let n = 0; n < noiseCount; n++) {
    const acct = account(ACCT_MIN + Math.floor(rng() * ACCT_SPAN));
    const amount = 5 + Math.floor(rng() * 9000);
    push(amount, acct, windowStart + Math.floor(rng() * windowMs));
  }

  // Tri chronologique puis attribution des id (ordre/id non révélateurs).
  raw.sort((a, b) => a.tsMs - b.tsMs);
  const transactions = raw.map((t, i) => ({
    id: i + 1,
    amount: t.amount,
    counterparty: t.counterparty,
    ts: new Date(t.tsMs).toISOString(),
  }));

  return { params: PARAMS, mules: mules.slice().sort(), falsePositives, transactions };
}

/** Vérifie les invariants de calibrage. Retourne { ok, failures: string[] }. */
function assertCalibration(dataset) {
  const failures = [];
  const { mules, falsePositives, transactions, params } = dataset;

  if (mules.length < 8 || mules.length > 15) failures.push(`muleCount=${mules.length} hors [8,15]`);
  if (falsePositives.length < 5 || falsePositives.length > 10) failures.push(`falsePositives=${falsePositives.length} hors [5,10]`);

  const byAcct = new Map();
  for (const tx of transactions) {
    if (!byAcct.has(tx.counterparty)) byAcct.set(tx.counterparty, []);
    byAcct.get(tx.counterparty).push(tx);
  }

  const lo = params.declarationThreshold * 0.9;
  const hi = params.declarationThreshold * 0.99;
  let straddlers = 0;
  for (const acct of mules) {
    const list = byAcct.get(acct) || [];
    for (const tx of list) {
      if (tx.amount < lo || tx.amount > hi) { failures.push(`mule ${acct} montant ${tx.amount} hors [${lo},${hi}]`); break; }
    }
    const sum = list.reduce((a, t) => a + t.amount, 0);
    if (sum <= params.aggThreshold) failures.push(`mule ${acct} cumul ${sum} <= seuil agrégé ${params.aggThreshold}`);
    const days = new Set(list.map((t) => Math.floor(Date.parse(t.ts) / DAY_MS)));
    if (days.size > 1) straddlers++;
  }
  if (straddlers < 2) failures.push(`mules à cheval sur une frontière calendaire: ${straddlers} (< 2)`);

  if (!transactions.some((t) => t.amount < params.declarationThreshold)) failures.push('aucune transaction isolée sous le seuil dans le bruit');

  return { ok: failures.length === 0, failures };
}

/** Point d'entrée calibré (utilisé identiquement par le bundle ET le juge). */
function generateCalibratedDataset(teamId, opts = {}) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const seed = attempt === 0 ? teamId : `${teamId}#${attempt}`;
    const dataset = generateDataset(seed, opts);
    if (assertCalibration(dataset).ok) return { ...dataset, seed };
  }
  throw new Error(`calibrage impossible pour teamId=${teamId}`);
}

module.exports = {
  PARAMS,
  selectAccounts,
  muleAccountsFor,
  generateDataset,
  generateCalibratedDataset,
  assertCalibration,
};
