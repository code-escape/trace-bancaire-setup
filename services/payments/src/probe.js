'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// payments-probe — harnais de vérification (épreuve 4). Unit systemd User=root (seul
// habilité à `systemctl restart payments-consumer`), GATED (démarré quand l'épreuve
// est active).
//
// POST /replay-probe exécute la séquence canonique de la fiche et renvoie des MESURES
// BRUTES — JAMAIS de verdict « réussi/raté » : la décision appartient au juge plateforme
// (challenges-service), conformément à « le détecteur ne marque rien lui-même ».
//   1. countBefore
//   2. restart du consumer (tue les dédup en mémoire)
//   3. replay complet (le consumer relit le stream depuis le début)
//   4. countAfter (après stabilisation du drain)
//   5. présence d'une contrainte UNIQUE d'idempotence (introspection, nom de colonne libre)
//   6. totaux observés vs attendus par compte
//
// GET /reconciliation : totaux attendus vs observés par compte (lecture seule, sans
// restart) — endpoint consommé par la GUI de réconciliation (13.5). C'est le feedback
// « artefact-ui » : il expose volontairement attendu vs observé.
// ──────────────────────────────────────────────────────────────────────────────

const http = require('http');
const { detectIdempotencyKey } = require('./db');

const CORS = { 'Access-Control-Allow-Origin': '*' };
const CENT = (n) => Math.round(n * 100) / 100;

/**
 * Réconcilie totaux attendus vs observés. PURE (testable sans base).
 * @param {Map<string, number>} expected
 * @param {Map<string, number>} observed
 * @returns {{ perAccount: {acct,expected,observed,ok}[], totalsMatch: boolean }}
 */
function reconcile(expected, observed) {
  const accts = new Set([...expected.keys(), ...observed.keys()]);
  const perAccount = [];
  let totalsMatch = true;
  for (const acct of [...accts].sort()) {
    const e = CENT(expected.get(acct) || 0);
    const o = CENT(observed.get(acct) || 0);
    const ok = e === o;
    if (!ok) totalsMatch = false;
    perAccount.push({ acct, expected: e, observed: o, ok });
  }
  return { perAccount, totalsMatch };
}

/**
 * @param {object} deps
 * @param {object} deps.db            client Postgres (count, totalsByAccount, uniqueColumns)
 * @param {() => Promise<void>} deps.restartConsumer  redémarre payments-consumer
 * @param {Map<string, number>} deps.expectedTotals   totaux attendus (ledger-spec)
 * @param {object} [deps.cfg]         pollMs, stableChecks, drainTimeoutMs
 * @param {(m:string)=>void} [deps.logger]
 */
function createProbe({ db, restartConsumer, expectedTotals, cfg = {}, logger = (m) => process.stdout.write(m + '\n') }) {
  const c = { pollMs: 500, stableChecks: 2, drainTimeoutMs: 30000, ...cfg };

  // Attend que le count se stabilise (drain terminé) ou abandonne au timeout.
  async function waitForDrain() {
    const deadline = Date.now() + c.drainTimeoutMs;
    let last = -1;
    let stable = 0;
    while (Date.now() < deadline) {
      const n = await db.count();
      if (n === last) {
        if (++stable >= c.stableChecks) return n;
      } else {
        stable = 0;
        last = n;
      }
      await new Promise((r) => setTimeout(r, c.pollMs));
    }
    return db.count();
  }

  async function replayProbe() {
    const countBefore = await db.count();
    logger(`[probe] countBefore=${countBefore} — restart consumer + replay`);
    await restartConsumer(); // tue toute dédup en mémoire
    const countAfter = await waitForDrain();
    const hasUniqueOnMessageId = detectIdempotencyKey(await db.uniqueColumns());
    const { perAccount, totalsMatch } = reconcile(expectedTotals, await db.totalsByAccount());
    logger(`[probe] countAfter=${countAfter} unique=${hasUniqueOnMessageId} totalsMatch=${totalsMatch}`);
    return { countBefore, countAfter, hasUniqueOnMessageId, perAccount, totalsMatch };
  }

  async function reconciliation() {
    const { perAccount, totalsMatch } = reconcile(expectedTotals, await db.totalsByAccount());
    return { perAccount, totalsMatch };
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
        return res.end();
      }
      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { status: 'ok', service: 'payments-probe' });
      }
      if (req.method === 'GET' && path === '/reconciliation') {
        return json(res, 200, await reconciliation());
      }
      if (req.method === 'POST' && path === '/replay-probe') {
        return json(res, 200, await replayProbe());
      }
      res.writeHead(404, CORS);
      res.end();
    } catch (err) {
      json(res, 500, { error: 'probe_failure', detail: err.message });
    }
  });

  return { server, replayProbe, reconciliation };
}

// Démarrage réel uniquement si exécuté directement (pas à l'import — testable).
if (require.main === module) {
  // eslint-disable-next-line global-require
  const { execFile } = require('child_process');
  // eslint-disable-next-line global-require
  const { createPgDb } = require('./db');
  // eslint-disable-next-line global-require
  const { expectedTotalsByAccount } = require('./ledger-spec');

  const teamId = process.env.TEAM_ID || 'local';
  const db = createPgDb({ connectionString: process.env.DATABASE_URL });
  const streamKey = process.env.STREAM_KEY || 'virements';
  const streamGroup = process.env.STREAM_GROUP || 'payments';
  const sh = (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
    });
  // Replay contrôlé : repositionne le groupe au début PUIS redémarre le consumer (le restart
  // tue toute déduplication en mémoire). Le probe tourne en root → systemctl direct, sans sudo.
  const restartConsumer = async () => {
    await sh('redis-cli', ['XGROUP', 'SETID', streamKey, streamGroup, '0']);
    await sh('systemctl', ['restart', 'payments-consumer']);
  };

  const { server } = createProbe({ db, restartConsumer, expectedTotals: expectedTotalsByAccount(teamId) });
  const PORT = parseInt(process.env.PORT || '3400', 10);
  server.listen(PORT, () => process.stdout.write(`payments-probe listening on port ${PORT}\n`));
}

module.exports = { createProbe, reconcile };
