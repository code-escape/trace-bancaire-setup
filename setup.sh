#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Bundle de profil "trace-bancaire" — POINT D'ENTRÉE UNIQUE (contrat de bundle)
# Réf. contrat : code-escape-infra/docs/sandbox-bundle-contract.md
#
# Cloné sous /opt/challenges par cloud-init (composition Crossplane sandbox-vm) puis
# exécuté une fois. IDEMPOTENT (rejouable à la main depuis un re-clone sans casse).
#
# Installe chaque service du bundle (services/<nom>/) en tant qu'unit systemd, créée
# SANS la démarrer (démarrage piloté par le scénario / l'orchestrateur), puis nettoie
# /opt/challenges.
#
# Frontière base/bundle : l'accès SSH (user cadet, sshd:2222, AuthorizedKeysCommand,
# hook PAM ssh-notify, /etc/sandbox.env, MOTD/banner) est fourni par la composition.
# Ce bundle ne configure JAMAIS sshd/PAM/AKC.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Service placeholder du socle (épreuves 13.1+ ajouteront leurs services ici).
install_service() {
  local name="$1" port="$2"
  local src="${BUNDLE_DIR}/services/${name}"
  local dst="/opt/${name}"

  echo "[setup][trace-bancaire] installation ${name} depuis ${src}"

  # Copie idempotente : repartir d'un répertoire propre évite l'imbrication
  # qu'un `cp -r src/ dst` produirait au second passage.
  rm -rf "${dst}"
  mkdir -p "${dst}"
  cp -rT "${src}" "${dst}"

  # Dépendances Node de production (no-op si aucune dépendance ; idempotent).
  npm install --prefix "${dst}" --production --silent

  # Unit systemd — réécriture idempotente. Démarrage NON effectué ici.
  cat > "/etc/systemd/system/${name}.service" << EOF
[Unit]
Description=Trace bancaire — ${name}
After=network.target

[Service]
Type=simple
User=cadet
WorkingDirectory=${dst}
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=-/etc/sandbox.env
Environment=PORT=${port}

[Install]
WantedBy=multi-user.target
EOF
}

# Postgres = dépendance d'infra de l'épreuve 3 (le dev requête le dataset en SQL via psql).
# Contrairement aux services de scénario, PG est DÉMARRÉ ici (dépendance, pas service gated).
# Idempotent : install conditionnelle, initdb gardé, rechargement propre du dataset.
setup_postgres() {
  echo "[setup][trace-bancaire] Postgres : installation + chargement du dataset AML"
  # TEAM_ID (graine déterministe) vient de /etc/sandbox.env — même graine que le service tx-dataset.
  set -a; . /etc/sandbox.env 2>/dev/null || true; set +a
  command -v psql >/dev/null 2>&1 || \
    dnf install -y --allowerasing --setopt=install_weak_deps=False postgresql-server postgresql >/dev/null 2>&1
  [ -f /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb >/dev/null 2>&1
  systemctl enable postgresql >/dev/null 2>&1 || true
  systemctl start postgresql
  until pg_isready -q 2>/dev/null; do sleep 0.2; done

  # DB + rôle cadet (peer auth : l'utilisateur OS cadet → rôle PG cadet) en lecture seule.
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='aml'" | grep -q 1 \
    || runuser -u postgres -- psql -q -c "CREATE DATABASE aml"
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='cadet'" | grep -q 1 \
    || runuser -u postgres -- psql -q -c "CREATE ROLE cadet LOGIN"
  runuser -u postgres -- psql -q -c "GRANT CONNECT ON DATABASE aml TO cadet"

  # Génère le CSV déterministe (même seed = TEAM_ID que l'API) puis chargement propre (COPY).
  node /opt/tx-dataset/src/load-dataset.js /tmp/aml-tx.csv
  chmod 644 /tmp/aml-tx.csv
  runuser -u postgres -- psql -q aml -c "DROP TABLE IF EXISTS transactions"
  runuser -u postgres -- psql -q aml -c "CREATE TABLE transactions (id bigint PRIMARY KEY, amount numeric, counterparty text, ts timestamptz)"
  runuser -u postgres -- psql -q aml -c "\copy transactions FROM '/tmp/aml-tx.csv' WITH (FORMAT csv)"
  runuser -u postgres -- psql -q aml -c "CREATE INDEX ON transactions(counterparty)"
  runuser -u postgres -- psql -q aml -c "CREATE INDEX ON transactions(ts)"
  runuser -u postgres -- psql -q aml -c "GRANT SELECT ON transactions TO cadet"
  rm -f /tmp/aml-tx.csv
  echo "[setup][trace-bancaire] Postgres prêt (db 'aml', table 'transactions', lecture pour 'cadet')."
}

install_service "soc-agent" "3000"
install_service "tx-collector" "3100"
install_service "tx-dataset" "3200"

systemctl daemon-reload

# Convention healthcheck du contrat : chaque service expose GET /health → 200 (src/index.js).
# Logs : journalctl -u <service>.

setup_postgres

# Nettoyage : aucune trace du provisionnement (idempotent grâce à -f).
rm -rf /opt/challenges

echo "[setup][trace-bancaire] services installés (non démarrés), Postgres chargé. OK."
