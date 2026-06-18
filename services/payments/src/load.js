'use strict';

// Seed déterministe (seed = TEAM_ID) pour l'épreuve 4. Deux sous-commandes :
//   node load.js ledger <csv>   → écrit le ledger PRÉ-SEEDÉ (légitimes + doublons historiques)
//                                  en CSV pour `psql \copy`. Colonnes : id,from_acct,to_acct,amount,ts
//                                  (PAS de message_id — la migration est le travail du joueur).
//   node load.js stream         → XADD des ordres LÉGITIMES (sans doublons historiques) dans le
//                                  Stream Redis `virements` (champ `order` = JSON).
//
// Invariant (verrouillé par ledger-spec.test.js) : stream(légitimes) ∪ doublons_historiques
// = ledger pré-seedé. Les doublons historiques représentent des rejeux PASSÉS, déjà en base.

const fs = require('fs');
const { generateLegit, generatePreseededLedger } = require('./ledger-spec');

const iso = (ms) => new Date(ms).toISOString();
const teamId = process.env.TEAM_ID || 'local';
const mode = process.argv[2];

async function loadLedger(csvPath) {
  if (!csvPath) { process.stderr.write('usage: node load.js ledger <csv-path>\n'); process.exit(2); }
  const rows = generatePreseededLedger(teamId);
  const w = fs.createWriteStream(csvPath);
  for (const r of rows) w.write(`${r.id},${r.from},${r.to},${r.amount},${iso(r.tsMs)}\n`);
  await new Promise((res) => w.end(res));
  process.stdout.write(`load: ledger ${rows.length} lignes → ${csvPath} (team=${teamId})\n`);
}

async function loadStream() {
  // eslint-disable-next-line global-require
  const { createClient } = require('redis');
  const client = createClient(process.env.REDIS_URL ? { url: process.env.REDIS_URL } : {});
  await client.connect();
  const key = process.env.STREAM_KEY || 'virements';
  await client.del(key); // idempotent : repart d'un stream propre
  const legit = generateLegit(teamId);
  for (const o of legit) {
    const order = JSON.stringify({ messageId: o.messageId, from: o.from, to: o.to, amount: o.amount, ts: iso(o.tsMs) });
    await client.xAdd(key, '*', { order });
  }
  await client.quit();
  process.stdout.write(`load: stream ${legit.length} ordres légitimes → ${key} (team=${teamId})\n`);
}

(async () => {
  if (mode === 'ledger') await loadLedger(process.argv[3]);
  else if (mode === 'stream') await loadStream();
  else { process.stderr.write('usage: node load.js <ledger <csv>|stream>\n'); process.exit(2); }
})().catch((err) => { process.stderr.write(`load: ${err.message}\n`); process.exit(1); });
