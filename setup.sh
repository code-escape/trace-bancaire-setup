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
  local name="$1" port="$2" user="${3:-cadet}"
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
User=${user}
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

# Service du pipeline de virements (épreuve 4) : ExecStart explicite (consumer.js/probe.js,
# pas index.js) + env Postgres (peer auth socket) / Redis. GATED comme les autres services.
install_payments_service() {
  local name="$1" port="$2" user="$3" entry="$4"
  echo "[setup][trace-bancaire] installation ${name} (${entry}, user=${user})"
  cat > "/etc/systemd/system/${name}.service" << EOF
[Unit]
Description=Trace bancaire — ${name} (épreuve 4)
After=network.target postgresql.service redis.service
Wants=postgresql.service redis.service

[Service]
Type=simple
User=${user}
WorkingDirectory=/opt/payments
ExecStart=/usr/bin/node ${entry}
Restart=on-failure
RestartSec=5
EnvironmentFile=-/etc/sandbox.env
Environment=PORT=${port}
Environment=PGHOST=/var/run/postgresql
Environment=PGDATABASE=payments
Environment=STREAM_KEY=virements
Environment=STREAM_GROUP=payments

[Install]
WantedBy=multi-user.target
EOF
}

# Postgres = dépendance d'infra de l'épreuve 3 (le dev requête le dataset en SQL via psql).
# Contrairement aux services de scénario, PG est DÉMARRÉ ici (dépendance, pas service gated).
# Idempotent : install conditionnelle, initdb gardé, rechargement propre du dataset.
setup_postgres() {
  echo "[setup][trace-bancaire] Postgres : installation + chargement du dataset AML"
  # Environnement sans gestionnaire RPM ni psql (ex. CI Debian) : on saute proprement
  # (la validation infra complète se fait dans le harnais systemd local).
  if ! command -v psql >/dev/null 2>&1 && ! command -v dnf >/dev/null 2>&1; then
    echo "[setup][trace-bancaire] psql/dnf absents — Postgres ignoré (non-RHEL)."; return 0
  fi
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

# Redis = bus de l'épreuve 4 (Stream `virements`). DÉMARRÉ ici (dépendance d'infra).
# Idempotent : install conditionnelle, enable+start, démarrage seul du seed dans setup_payments.
setup_redis() {
  echo "[setup][trace-bancaire] Redis : installation (bus de virements)"
  if ! command -v redis-cli >/dev/null 2>&1 && ! command -v dnf >/dev/null 2>&1; then
    echo "[setup][trace-bancaire] redis/dnf absents — Redis ignoré (non-RHEL)."; return 0
  fi
  command -v redis-cli >/dev/null 2>&1 || \
    dnf install -y --allowerasing --setopt=install_weak_deps=False redis >/dev/null 2>&1
  systemctl enable redis >/dev/null 2>&1 || true
  systemctl start redis
  until redis-cli ping >/dev/null 2>&1; do sleep 0.2; done
}

# Épreuve 4 : copie /opt/payments + deps, seed du ledger (sans message_id) + du Stream,
# units gated (consumer User=cadet, probe User=cadet + sudo ciblé), trigger-replay.sh.
# Idempotent : DROP/recreate du ledger, XGROUP reset, sudoers réécrit.
setup_payments() {
  echo "[setup][trace-bancaire] épreuve 4 : pipeline de virements + harnais de vérif"
  # Requiert Postgres + Redis (sautés en non-RHEL) : si absents, on saute aussi proprement.
  if ! command -v psql >/dev/null 2>&1 || ! command -v redis-cli >/dev/null 2>&1; then
    echo "[setup][trace-bancaire] psql/redis-cli absents — épreuve 4 ignorée (non-RHEL)."; return 0
  fi
  set -a; . /etc/sandbox.env 2>/dev/null || true; set +a

  # Déploiement du code (mêmes conventions qu'install_service : répertoire propre + deps prod).
  rm -rf /opt/payments && mkdir -p /opt/payments
  cp -rT "${BUNDLE_DIR}/services/payments" /opt/payments
  npm install --prefix /opt/payments --production --silent

  # Base 'payments' possédée par cadet (le joueur doit pouvoir ALTER le schéma).
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='payments'" | grep -q 1 \
    || runuser -u postgres -- psql -q -c "CREATE DATABASE payments OWNER cadet"

  # Ledger SANS colonne message_id (la migration est le travail du joueur). id auto (BIGSERIAL).
  runuser -u postgres -- psql -q payments -c "DROP TABLE IF EXISTS ledger"
  runuser -u postgres -- psql -q payments -c "CREATE TABLE ledger (id bigserial PRIMARY KEY, from_acct text, to_acct text, amount numeric, ts timestamptz)"

  # Seed déterministe (seed = TEAM_ID) : légitimes + paire(s) jumelle(s) + ~30 doublons historiques.
  TEAM_ID="${TEAM_ID:-local}" node /opt/payments/src/load.js ledger /tmp/payments-ledger.csv
  chmod 644 /tmp/payments-ledger.csv
  runuser -u postgres -- psql -q payments -c "\copy ledger (id, from_acct, to_acct, amount, ts) FROM '/tmp/payments-ledger.csv' WITH (FORMAT csv)"
  # Réaligne la séquence sur le max(id) chargé pour que les INSERT du consumer s'enchaînent.
  runuser -u postgres -- psql -q payments -c "SELECT setval(pg_get_serial_sequence('ledger','id'), COALESCE((SELECT max(id) FROM ledger), 1))"
  runuser -u postgres -- psql -q payments -c "ALTER TABLE ledger OWNER TO cadet"
  rm -f /tmp/payments-ledger.csv

  # Seed du Stream `virements` (ordres LÉGITIMES uniquement) puis groupe positionné au bout
  # ($ = aucune re-livraison au démarrage ; seul un replay/SETID 0 re-livre le flux).
  TEAM_ID="${TEAM_ID:-local}" node /opt/payments/src/load.js stream
  redis-cli XGROUP CREATE virements payments '$' MKSTREAM >/dev/null 2>&1 \
    || redis-cli XGROUP SETID virements payments '$' >/dev/null 2>&1 || true

  # Rôle PG superuser `root` (peer auth) pour le harnais payments-probe qui tourne en root :
  # il doit introspecter le schéma et lire le ledger même après une migration (DROP/CREATE)
  # du joueur. La base reste possédée par cadet (le joueur garde la main sur son schéma).
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='root'" | grep -q 1 \
    || runuser -u postgres -- psql -q -c "CREATE ROLE root SUPERUSER LOGIN"

  # Units gated (créées non démarrées). Le consumer tourne en cadet (le joueur édite son code).
  # Le probe tourne en root : redémarrer un service système exige un privilège, et le compte
  # cadet est verrouillé (usermod -L) — un probe root évite toute dépendance à sudo/PAM pour
  # le chemin NOTÉ (le replay du juge). Le probe ne fait qu'un restart ciblé + des lectures.
  install_payments_service "payments-consumer" "3300" "cadet" "src/consumer.js"
  install_payments_service "payments-probe" "3400" "root" "src/probe.js"

  # Sudoers : le JOUEUR (cadet) peut redémarrer le seul consumer pour recharger son code édité —
  # rien d'autre. (En prod RHEL9 le PAM/authselect rend ce NOPASSWD effectif.)
  command -v sudo >/dev/null 2>&1 || dnf install -y sudo >/dev/null 2>&1
  mkdir -p /etc/sudoers.d
  cat > /etc/sudoers.d/payments-replay << 'EOF'
cadet ALL=(root) NOPASSWD: /usr/bin/systemctl restart payments-consumer
EOF
  chmod 440 /etc/sudoers.d/payments-replay

  # trigger-replay.sh visible dans le répertoire de connexion du cadet.
  install -o cadet -g cadet -m 0755 "${BUNDLE_DIR}/trigger-replay.sh" /home/cadet/trigger-replay.sh
  echo "[setup][trace-bancaire] épreuve 4 prête (db 'payments', stream 'virements', services gated)."
}

install_service "soc-agent" "3000"
install_service "tx-collector" "3100"
install_service "tx-dataset" "3200"

systemctl daemon-reload

# Convention healthcheck du contrat : chaque service expose GET /health → 200 (src/index.js).
# Logs : journalctl -u <service>.

setup_postgres
setup_redis
setup_payments

# Les units de l'épreuve 4 viennent d'être (ré)écrites — recharger systemd.
systemctl daemon-reload

# Nettoyage : aucune trace du provisionnement (idempotent grâce à -f).
rm -rf /opt/challenges

echo "[setup][trace-bancaire] services installés (non démarrés), Postgres + Redis chargés. OK."
