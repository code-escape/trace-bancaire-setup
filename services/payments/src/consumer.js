'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// payments-consumer — consumer du Stream Redis `virements` via un GROUPE de consumers
// (épreuve 4 « Le virement en double », fiche idempotence-virements-rejoues).
//
// LIVRÉ FONCTIONNEL, défaut STRUCTUREL (pas un crash) : pour chaque message LIVRÉ, il fait
// un INSERT NAÏF — sans clé d'idempotence. En régime normal, le groupe ne livre chaque
// message qu'une fois ; MAIS le bus est « at-least-once » : un rejeu (./trigger-replay.sh,
// qui repositionne le groupe au début) re-livre tout le flux → le consumer ré-insère →
// doublons dans le ledger → la réconciliation diverge.
//
// Le messageId est LOGUÉ (journalctl -u payments-consumer) mais n'est PAS utilisé pour
// dédupliquer : c'est le fil du diagnostic et l'objet du correctif (colonne d'idempotence
// + contrainte UNIQUE, puis INSERT ... ON CONFLICT DO NOTHING).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {{ query: Function }} deps.db
 * @param {{ ack?: (id: string) => Promise<void> }} [deps.stream]
 * @param {(m: string) => void} [deps.logger]
 */
function createConsumer({ db, stream = {}, logger = (m) => process.stdout.write(m + '\n') }) {
  // Traite un lot de messages déjà livrés par le groupe : INSERT naïf + ACK.
  async function processBatch(orders) {
    for (const o of orders) {
      logger(`[consumer] traite messageId=${o.messageId} ${o.from}->${o.to} ${o.amount}`);
      // ⚠️ INSERT NAÏF — aucune clé d'idempotence. Une re-livraison ré-insère la même ligne.
      await db.query(
        'INSERT INTO ledger (from_acct, to_acct, amount, ts) VALUES ($1, $2, $3, $4)',
        [o.from, o.to, o.amount, o.ts],
      );
      if (stream.ack && o._id) await stream.ack(o._id);
    }
    return orders.length;
  }

  return { processBatch };
}

// Démarrage réel uniquement si exécuté directement (pas à l'import — testable).
if (require.main === module) {
  // eslint-disable-next-line global-require
  const { createPgDb, createRedisStream } = require('./db');
  (async () => {
    const db = createPgDb({ connectionString: process.env.DATABASE_URL });
    const stream = await createRedisStream({ url: process.env.REDIS_URL, key: process.env.STREAM_KEY || 'virements' });
    await stream.ensureGroup(); // idempotent (au cas où setup.sh ne l'aurait pas créé)
    const consumer = createConsumer({ db, stream });
    process.stdout.write('[consumer] démarré — lecture du groupe (BLOCK). Le rejeu repositionne le groupe.\n');
    // Boucle live : XREADGROUP '>' — ne livre que les messages non encore livrés au groupe.
    // Un restart ne reprocesse donc PAS le backlog… sauf après un SETID 0 (= replay).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await stream.readGroup({ count: 200, blockMs: 5000 });
      if (batch.length) await consumer.processBatch(batch);
    }
  })().catch((err) => {
    process.stderr.write(`[consumer] erreur fatale: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { createConsumer };
