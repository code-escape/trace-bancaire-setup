'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// tx-dataset — API du dataset AML (épreuve 3 « Le schtroumpfage »).
//
// Sert le MÊME dataset déterministe que celui chargé en Postgres (dataset-spec, seed=TEAM_ID) :
//   - GET /transactions  : transactions BRUTES paginées (id, amount, counterparty, ts) — aucune
//     étiquette mule. C'est aussi ce que le joueur requête en SQL via psql.
//   - GET /policy        : politique AML interne (chiffres = PARAMS) — destiné à la GUI métier.
//   - GET /kyc/:account  : dossier KYC d'un compte — destiné à la GUI métier.
// Asymétrie d'information : /policy et /kyc sont SÉPARÉS de /transactions et absents de la base.
// ──────────────────────────────────────────────────────────────────────────────

const http = require('http');
const { generateCalibratedDataset, PARAMS } = require('./dataset-spec');
const { kycFor } = require('./kyc');

const PORT = parseInt(process.env.PORT || '3200', 10);
const TEAM_ID = process.env.TEAM_ID || 'local';
const MAX_PAGE_SIZE = 500;

// Dataset généré une fois au démarrage (même graine que le chargement Postgres).
const dataset = generateCalibratedDataset(TEAM_ID);
process.stdout.write(`tx-dataset: ${dataset.transactions.length} transactions (team=${TEAM_ID}, seed=${dataset.seed})\n`);

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
    return res.end();
  }
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  if (path === '/health') {
    return json(res, 200, { status: 'ok', service: 'tx-dataset', transactions: dataset.transactions.length });
  }

  // Transactions BRUTES paginées — aucune étiquette mule.
  if (path === '/transactions') {
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get('pageSize') || '100', 10) || 100));
    const total = dataset.transactions.length;
    const start = (page - 1) * pageSize;
    const items = dataset.transactions.slice(start, start + pageSize);
    return json(res, 200, { page, pageSize, total, totalPages: Math.ceil(total / pageSize), items });
  }

  // Fenêtre récente (queue chronologique) — relayée en live par l'émetteur vers tx-collector
  // (épreuve 2). Garantit que le flux live et l'historique en base sont cohérents.
  if (path === '/recent') {
    const n = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get('n') || '30', 10) || 30));
    return json(res, 200, { items: dataset.transactions.slice(-n) });
  }

  // Politique AML interne (GUI-only) — chiffres EXACTEMENT alignés sur le générateur.
  if (path === '/policy') {
    return json(res, 200, {
      declarationThreshold: PARAMS.declarationThreshold,
      aggregateThreshold: PARAMS.aggThreshold,
      windowDays: PARAMS.windowDays,
      summary:
        `Toute transaction unitaire >= ${PARAMS.declarationThreshold} € fait l'objet d'une déclaration. ` +
        `Le fractionnement (structuring) consiste à répartir des montants juste sous ce seuil. ` +
        `Un bénéficiaire dont le cumul entrant dépasse ${PARAMS.aggThreshold} € sur une fenêtre glissante ` +
        `de ${PARAMS.windowDays} jours doit être investigué — la fenêtre est GLISSANTE (ne pas agréger par jour calendaire).`,
    });
  }

  // Dossier KYC d'un compte (GUI-only).
  const kycMatch = path.match(/^\/kyc\/([^/]+)$/);
  if (kycMatch) {
    const account = decodeURIComponent(kycMatch[1]);
    return json(res, 200, kycFor(account, dataset));
  }

  return json(res, 404, { error: 'not_found' });
});

if (require.main === module) {
  server.listen(PORT, () => process.stdout.write(`tx-dataset listening on port ${PORT}\n`));
}

module.exports = { server, dataset };
