'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// tx-collector — collecteur SSE de transactions (épreuve 2 « Le flux qui décroche »,
// fiche sse-flux-interrompu, instanciation renforcée trace-bancaire).
//
// Le service détient le corpus AUTHORITATIVE des transactions, alimenté par l'émetteur
// du challenges-service via POST /ingest. Le joueur consomme GET /stream (flux instable)
// et prouve la complétude via POST /checkin.
//
// Sémantique de reprise (cœur de l'épreuve) :
//   - GET /stream avec en-tête `Last-Event-ID: N` → rejoue tout le backlog d'id > N puis
//     passe en live (reprise stricte, sans perte).
//   - GET /stream SANS l'en-tête → ne rejoue PAS le backlog (la « fenêtre écoulée » n'est
//     pas redonnée) : seuls les événements ingérés APRÈS l'ouverture de la connexion sont
//     émis. Un client naïf qui se reconnecte sans Last-Event-ID perd donc tout ce qui a
//     transité pendant sa déconnexion → corpus incomplet → /checkin 422.
//
// Renforcement déclaré (§ E2) : un /checkin incomplet renvoie 422 { error: corpus_incomplet }
// SANS liste d'ids manquants. Le volume attendu par fenêtre n'est lisible que sur
// GET /expected-volume (consommé par la GUI métier 13.5), jamais via le 422.
// ──────────────────────────────────────────────────────────────────────────────

const http = require('http');

const CORS = { 'Access-Control-Allow-Origin': '*' };

function createTxCollector(config = {}) {
  const cfg = {
    dropMinMs: 30000,
    dropMaxMs: 90000,
    heartbeatMs: 15000,
    rateMax: 5,
    rateWindowMs: 60000,
    rateBlockMs: 30000,
    windowMs: 60000,
    ...config,
  };

  // ── État (par instance) ──────────────────────────────────────────────────
  const corpus = []; // [{ id, ts, data }]
  let seq = 0;
  let checkinValidated = false;
  const liveClients = new Set();
  const reconnects = new Map(); // ip -> { hits: number[], blockedUntil }

  function rateLimited(ip) {
    const now = Date.now();
    let st = reconnects.get(ip);
    if (!st) {
      st = { hits: [], blockedUntil: 0 };
      reconnects.set(ip, st);
    }
    if (now < st.blockedUntil) return true;
    st.hits = st.hits.filter((t) => now - t < cfg.rateWindowMs);
    st.hits.push(now);
    if (st.hits.length > cfg.rateMax) {
      st.blockedUntil = now + cfg.rateBlockMs;
      return true;
    }
    return false;
  }

  function sseTransaction(res, tx) {
    res.write(`id: ${tx.id}\n`);
    res.write('event: transaction\n');
    res.write(`data: ${JSON.stringify(tx.data)}\n\n`);
  }

  function broadcastLive(tx) {
    for (const res of liveClients) {
      try {
        sseTransaction(res, tx);
      } catch {
        liveClients.delete(res);
      }
    }
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, { status: 'ok', service: 'tx-collector' });
    }

    // Volume attendu par fenêtre temporelle (GUI métier 13.5) — JAMAIS via le 422.
    if (req.method === 'GET' && path === '/expected-volume') {
      const windows = {};
      for (const tx of corpus) {
        const w = Math.floor(tx.ts / cfg.windowMs) * cfg.windowMs;
        windows[w] = (windows[w] || 0) + 1;
      }
      return json(res, 200, { total: corpus.length, windowMs: cfg.windowMs, windows });
    }

    // Ingest interne (émetteur challenges-service) — ajoute une transaction "live".
    if (req.method === 'POST' && path === '/ingest') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }
        const tx = { id: ++seq, ts: Date.now(), data };
        corpus.push(tx);
        process.stdout.write(`[ingest] id=${tx.id}\n`);
        broadcastLive(tx); // live uniquement — pas de backlog pour les clients naïfs
        return json(res, 202, { id: tx.id });
      });
      return;
    }

    // Preuve de complétude. 422 sans ids (renforcement § E2).
    if (req.method === 'POST' && path === '/checkin') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }
        const submitted = new Set(Array.isArray(payload.ids) ? payload.ids.map(Number) : []);
        const complete = corpus.length > 0 && corpus.every((tx) => submitted.has(tx.id));
        if (!complete) {
          return json(res, 422, { error: 'corpus_incomplet' }); // aucun id manquant divulgué
        }
        checkinValidated = true;
        return json(res, 200, { status: 'complet', count: corpus.length });
      });
      return;
    }

    // Consommé par le poller du juge (challenges-service).
    if (req.method === 'GET' && path === '/checkin/status') {
      return json(res, 200, { validated: checkinValidated });
    }

    // Flux SSE instable.
    if (req.method === 'GET' && path === '/stream') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(cfg.rateBlockMs / 1000)),
          ...CORS,
        });
        res.end(JSON.stringify({ error: 'too_many_reconnects' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS,
      });
      res.write('retry: 2000\n\n');

      // Reprise stricte via Last-Event-ID ; sans en-tête → pas de rejeu du backlog.
      const lastIdRaw = req.headers['last-event-id'];
      const lastId = lastIdRaw !== undefined ? parseInt(lastIdRaw, 10) : null;
      if (lastId !== null && !Number.isNaN(lastId)) {
        for (const tx of corpus) {
          if (tx.id > lastId) sseTransaction(res, tx);
        }
      }

      liveClients.add(res);
      const hb = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
      }, cfg.heartbeatMs);

      // Coupe volontaire (30–90 s par défaut).
      const dropAfter = cfg.dropMinMs + Math.floor(Math.random() * Math.max(1, cfg.dropMaxMs - cfg.dropMinMs));
      const dropTimer = setTimeout(() => {
        try { res.end(); } catch { /* ignore */ }
      }, dropAfter);

      const cleanup = () => {
        clearInterval(hb);
        clearTimeout(dropTimer);
        liveClients.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    res.writeHead(404, CORS);
    res.end();
  });

  return server;
}

// Démarrage seulement si exécuté directement (pas à l'import — testable).
if (require.main === module) {
  const server = createTxCollector({
    dropMinMs: parseInt(process.env.DROP_MIN_MS || '30000', 10),
    dropMaxMs: parseInt(process.env.DROP_MAX_MS || '90000', 10),
    heartbeatMs: parseInt(process.env.HEARTBEAT_MS || '15000', 10),
    rateMax: parseInt(process.env.RATE_MAX || '5', 10),
    rateWindowMs: parseInt(process.env.RATE_WINDOW_MS || '60000', 10),
    rateBlockMs: parseInt(process.env.RATE_BLOCK_MS || '30000', 10),
    windowMs: parseInt(process.env.WINDOW_MS || '60000', 10),
  });
  const PORT = parseInt(process.env.PORT || '3100', 10);
  server.listen(PORT, () => {
    process.stdout.write(`tx-collector listening on port ${PORT}\n`);
  });
}

module.exports = { createTxCollector };
