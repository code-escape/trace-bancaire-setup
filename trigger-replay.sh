#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# trigger-replay.sh — REJOUE le flux de virements depuis le début.
#
# Le bus (Redis Stream `virements`) garantit une livraison « at-least-once » : il PEUT
# rejouer des messages déjà livrés. Ce script matérialise ce rejeu à la demande, pour que
# tu puisses EXPÉRIMENTER : redémarrer le consumer le fait relire l'intégralité du stream.
#
# Observe l'effet sur le grand livre AVANT/APRÈS :
#   psql payments -c 'SELECT count(*) FROM ledger;'
#   ./trigger-replay.sh
#   psql payments -c 'SELECT count(*) FROM ledger;'   # a-t-il bougé ?
#
# Et suis le traitement message par message :
#   journalctl -u payments-consumer -f
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

STREAM="${STREAM_KEY:-virements}"
GROUP="${STREAM_GROUP:-payments}"

echo "[replay] repositionnement du groupe '${GROUP}' au début du stream '${STREAM}'…"
redis-cli XGROUP SETID "${STREAM}" "${GROUP}" 0 >/dev/null
echo "[replay] redémarrage de payments-consumer → re-livraison de tout le flux…"
sudo systemctl restart payments-consumer
echo "[replay] rejeu déclenché. Vérifie le grand livre (psql) et les logs (journalctl -u payments-consumer)."
