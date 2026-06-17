'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// soc-agent — agent du dashboard SOC (scénario Trace bancaire).
//
// PLACEHOLDER (story 13.0c) : ce service ne fait qu'exposer GET /health → 200,
// pour prouver la conformité du bundle au contrat (healthcheck, unit systemd
// démarrable). Les épreuves 13.1–13.4 grefferont ici leurs endpoints
// (collecteur SSE de transactions, juges, exploration AML, ledger, graphe).
// ──────────────────────────────────────────────────────────────────────────────

const http = require('http');

const PORT = parseInt(process.env.PORT || '3000', 10);

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // GET /health — contrat de bundle (section 5)
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ status: 'ok', service: 'soc-agent' }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  process.stdout.write(`soc-agent listening on port ${PORT}\n`);
});
