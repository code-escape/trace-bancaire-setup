'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createTxCollector } = require('../src/index');

let server;
let port;

before(async () => {
  // Timings courts/neutralisés pour les tests ; rate-limit large (testé séparément).
  server = createTxCollector({
    dropMinMs: 3_600_000,
    dropMaxMs: 3_600_001,
    heartbeatMs: 3_600_000,
    rateMax: 1000,
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

after(() => server.close());

function req(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.end(typeof body === 'string' ? body : JSON.stringify(body));
    else r.end();
  });
}

// Ouvre /stream, collecte les id reçus pendant `ms`, puis ferme.
function collectStream(ms, headers = {}) {
  return new Promise((resolve, reject) => {
    const ids = [];
    let status;
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/stream', headers }, (res) => {
      status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const line of chunk.split('\n')) {
          if (line.startsWith('id: ')) ids.push(parseInt(line.slice(4), 10));
        }
      });
    });
    r.on('error', reject);
    r.end();
    setTimeout(() => { r.destroy(); resolve({ status, ids }); }, ms);
  });
}

async function ingest(n) {
  for (let i = 0; i < n; i++) {
    await req('POST', '/ingest', { body: { amount: 9000 + i } });
  }
}

test('GET /health → 200', async () => {
  const res = await req('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).service, 'tx-collector');
});

test('Last-Event-ID rejoue strictement le backlog (id > N)', async () => {
  await ingest(3); // corpus = ids 1,2,3
  const all = await collectStream(250, { 'Last-Event-ID': '0' });
  assert.deepEqual(all.ids, [1, 2, 3]);
  const resume = await collectStream(250, { 'Last-Event-ID': '2' });
  assert.deepEqual(resume.ids, [3], 'reprise stricte après id=2');
});

test('Sans Last-Event-ID : pas de rejeu du backlog (live uniquement)', async () => {
  // Corpus déjà alimenté (3) ; un client sans en-tête ne reçoit pas le backlog.
  const naive = await collectStream(200, {});
  assert.deepEqual(naive.ids, [], 'aucun événement historique rejoué');
});

test('POST /checkin incomplet → 422 corpus_incomplet SANS liste d\'ids', async () => {
  const res = await req('POST', '/checkin', { body: { ids: [1] } }); // 2 et 3 manquants
  assert.equal(res.status, 422);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'corpus_incomplet');
  assert.deepEqual(Object.keys(body), ['error'], 'aucun champ divulguant les ids manquants');
});

test('POST /checkin complet → 200 et /checkin/status validé', async () => {
  const before = await req('GET', '/checkin/status');
  assert.equal(JSON.parse(before.body).validated, false);
  const res = await req('POST', '/checkin', { body: { ids: [1, 2, 3] } });
  assert.equal(res.status, 200);
  const after = await req('GET', '/checkin/status');
  assert.equal(JSON.parse(after.body).validated, true);
});

test('rate-limit : > rateMax reconnexions → 429', async () => {
  const s = createTxCollector({ rateMax: 2, rateWindowMs: 60000, rateBlockMs: 1000, dropMinMs: 3.6e6, dropMaxMs: 3.6e6 + 1 });
  await new Promise((r) => s.listen(0, r));
  const p = s.address().port;
  const open = () => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: p, method: 'GET', path: '/stream' }, (res) => {
      resolve(res.statusCode);
      r.destroy();
    });
    r.on('error', () => resolve('err'));
    r.end();
  });
  assert.equal(await open(), 200);
  assert.equal(await open(), 200);
  assert.equal(await open(), 429, 'la 3e reconnexion est limitée');
  s.close();
});
