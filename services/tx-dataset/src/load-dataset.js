'use strict';

// Écrit le dataset déterministe (même seed = TEAM_ID que l'API) en CSV pour `psql \copy`.
// Usage : node load-dataset.js <chemin-csv>
// Colonnes : id,amount,counterparty,ts  — champs BRUTS uniquement (aucune étiquette mule).

const fs = require('fs');
const { generateCalibratedDataset } = require('./dataset-spec');

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node load-dataset.js <csv-path>\n');
  process.exit(2);
}

const teamId = process.env.TEAM_ID || 'local';
const dataset = generateCalibratedDataset(teamId);
const w = fs.createWriteStream(out);
for (const tx of dataset.transactions) {
  w.write(`${tx.id},${tx.amount},${tx.counterparty},${tx.ts}\n`);
}
w.end(() => {
  process.stdout.write(`load-dataset: ${dataset.transactions.length} lignes → ${out} (team=${teamId})\n`);
  process.exit(0);
});
