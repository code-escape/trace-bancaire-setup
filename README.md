# code-escape-challenges-trace-bancaire

Bundle d'outillage in-sandbox du scénario **Trace bancaire** (profil `scenarioProfile: trace-bancaire`).

Conforme au **contrat de bundle** : `code-escape-infra/docs/sandbox-bundle-contract.md`.
Implémentation de référence (profil `promethee`) : `code-escape-challenges-promethee`.

## Rôle

La composition Crossplane `sandbox-vm` clone ce repo sous `/opt/challenges` (URL templatée
`code-escape-challenges-%s`, `%s = trace-bancaire`) puis exécute `./setup.sh` une fois, via cloud-init.

C'est le **socle** des épreuves du scénario : les stories 13.1–13.4 déposeront leurs services
(collecteur SSE de transactions, juges, dataset AML, ledger, graphe interbancaire) sous `services/`.

## Layout

```
setup.sh                  # point d'entrée racine idempotent (installe les services)
services/
  soc-agent/              # placeholder (socle) — GET /health → 200, port 3000
    package.json
    src/index.js
.github/workflows/ci.yml  # lint + install/validation soc-agent sur linux/arm64
```

## `setup.sh`

- Point d'entrée **unique** et **idempotent** (`set -euo pipefail`, copies non-imbriquantes `cp -rT`,
  rejouable depuis un re-clone).
- Pour chaque service : installe sous `/opt/<service>`, crée l'unit systemd **sans la démarrer**
  (démarrage piloté par l'orchestrateur de challenges), `systemctl daemon-reload`.
- Nettoie `/opt/challenges` en fin d'exécution.

## Services

| Service | Port | Healthcheck | Statut |
|---------|------|-------------|--------|
| `soc-agent` | 3000 | `GET /health` → 200 | placeholder (13.0c) — endpoints ajoutés en 13.1+ |

> Le port 3000 est identique à `control-center` (Prométhée) : sans collision, un profil par sandbox.

## Frontière base / bundle (NE PAS ré-implémenter)

L'accès SSH (`cadet`, sshd:2222, `AuthorizedKeysCommand`, hook PAM `ssh-notify`, `/etc/sandbox.env`,
MOTD/banner) est fourni par la composition. Ce bundle **consomme** `/etc/sandbox.env` mais ne
configure jamais sshd/PAM/AKC.

## Validation locale

```bash
# Dans le harnais systemd (image local-sandbox:systemd) :
#   re-clone → ./setup.sh (2×, idempotence) → systemctl start soc-agent → curl :3000/health
```
