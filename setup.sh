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
Environment=PORT=${port}

[Install]
WantedBy=multi-user.target
EOF
}

install_service "soc-agent" "3000"
install_service "tx-collector" "3100"

systemctl daemon-reload

# Convention healthcheck du contrat : soc-agent expose GET /health → 200 (src/index.js).
# Logs : journalctl -u soc-agent.

# Nettoyage : aucune trace du provisionnement (idempotent grâce à -f).
rm -rf /opt/challenges

echo "[setup][trace-bancaire] services installés (non démarrés). OK."
