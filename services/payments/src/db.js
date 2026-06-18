'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Accès Postgres / Redis Stream pour le pipeline de virements (épreuve 4).
//
// Clients réels (`pg`, `redis`) construits UNIQUEMENT par l'entrypoint et chargés en
// lazy-require — les fabriques consumer/probe les reçoivent par injection, si bien que
// les tests passent des faux clients (aucun pg/redis réel n'est chargé à l'import).
// setup.sh installe les dépendances via `npm install --production`.
// ──────────────────────────────────────────────────────────────────────────────

// Colonnes métier du ledger : une contrainte UNIQUE qui ne porte QUE sur une autre colonne
// est la clé d'idempotence ajoutée par le joueur (détection indépendante du nom — § D5).
const BUSINESS_COLS = Object.freeze(['id', 'from_acct', 'to_acct', 'amount', 'ts']);

/**
 * Décide, à partir de la liste des contraintes/index UNIQUE (chacun = tableau de colonnes),
 * si une clé d'idempotence persistante existe : au moins un UNIQUE mono-colonne hors métier.
 * Fonction PURE (testable sans base).
 * @param {string[][]} uniqueColsList
 */
function detectIdempotencyKey(uniqueColsList) {
  const business = new Set(BUSINESS_COLS);
  return uniqueColsList.some((cols) => cols.length === 1 && !business.has(cols[0]));
}

const TOTALS_SQL =
  'SELECT acct, sum(delta)::float8 AS total FROM (' +
  'SELECT to_acct AS acct, amount AS delta FROM ledger ' +
  'UNION ALL SELECT from_acct AS acct, -amount AS delta FROM ledger' +
  ') s GROUP BY acct';

// Contraintes/index UNIQUE de `ledger`, chacun renvoyé comme liste de colonnes.
// attname est de type `name` → on caste en text pour que node-pg parse un vrai tableau JS
// (name[] (oid 1003) n'est pas parsé par défaut et reviendrait en chaîne "{message_id}").
const UNIQUE_COLS_SQL =
  'SELECT array_agg(a.attname::text ORDER BY a.attnum) AS cols ' +
  'FROM pg_index ix ' +
  'JOIN pg_class t ON t.oid = ix.indrelid ' +
  'JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) ' +
  "WHERE t.relname = 'ledger' AND ix.indisunique " +
  'GROUP BY ix.indexrelid';

/**
 * Client Postgres réel via le paquet `pg` (peer/env auth). Lazy-require de `pg`.
 * Renvoie un objet aux méthodes attendues par consumer/probe.
 * @param {{ connectionString?: string }} [cfg]
 */
function createPgDb(cfg = {}) {
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const pool = new Pool(cfg.connectionString ? { connectionString: cfg.connectionString } : {});

  return {
    pool,
    async query(text, params) {
      return pool.query(text, params);
    },
    async count() {
      const r = await pool.query('SELECT count(*)::int AS n FROM ledger');
      return r.rows[0].n;
    },
    async totalsByAccount() {
      const r = await pool.query(TOTALS_SQL);
      const totals = new Map();
      for (const row of r.rows) totals.set(row.acct, Number(row.total));
      return totals;
    },
    async uniqueColumns() {
      const r = await pool.query(UNIQUE_COLS_SQL);
      return r.rows.map((row) => row.cols);
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Stream Redis réel via le paquet `redis`, exploité en GROUPE de consumers.
 * Lazy-require de `redis`. Le rejeu (replay) se fait en repositionnant le groupe
 * (XGROUP SETID … 0), géré par trigger-replay.sh / le probe — pas par le consumer.
 * @param {{ url?: string, key?: string, group?: string, consumer?: string }} [cfg]
 */
async function createRedisStream(cfg = {}) {
  // eslint-disable-next-line global-require
  const { createClient } = require('redis');
  const client = createClient(cfg.url ? { url: cfg.url } : {});
  await client.connect();
  const key = cfg.key || 'virements';
  const group = cfg.group || 'payments';
  const consumer = cfg.consumer || 'c1';

  return {
    client,
    // Crée le groupe au bout du stream ($) si absent — idempotent (ignore BUSYGROUP).
    async ensureGroup() {
      try {
        await client.xGroupCreate(key, group, '$', { MKSTREAM: true });
      } catch (err) {
        if (!String(err.message).includes('BUSYGROUP')) throw err;
      }
    },
    // Lit les messages NON encore livrés au groupe ('>'). Décode le champ `order` JSON.
    async readGroup({ count = 200, blockMs = 5000 } = {}) {
      const resp = await client.xReadGroup(
        group, consumer,
        [{ key, id: '>' }],
        { COUNT: count, BLOCK: blockMs },
      );
      if (!resp || !resp.length) return [];
      return resp[0].messages.map((m) => ({ _id: m.id, ...JSON.parse(m.message.order) }));
    },
    async ack(id) {
      await client.xAck(key, group, id);
    },
    async close() {
      await client.quit();
    },
  };
}

module.exports = { BUSINESS_COLS, detectIdempotencyKey, createPgDb, createRedisStream };
