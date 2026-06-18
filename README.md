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
  tx-collector/           # épreuve 2 (sse-flux-interrompu) — SSE + /checkin, port 3100
    package.json
    src/index.js
  tx-dataset/             # épreuve 3 (detection-structuring-aml) — dataset AML, port 3200
  payments/               # épreuve 4 (idempotence-virements-rejoues) — consumer + probe
    src/{consumer,probe,db,ledger-spec,load}.js
    tests/{ledger-spec,consumer,probe}.test.js
trigger-replay.sh         # outil joueur (épreuve 4) — rejoue le flux depuis le début
.github/workflows/ci.yml  # lint + tests services + install/validation soc-agent sur linux/arm64
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
| `tx-collector` | 3100 | `GET /health` → 200 | épreuve 2 (13.1) — flux SSE `/stream`, `/checkin`, `/expected-volume`, ingest `/ingest` |
| `tx-dataset` | 3200 | `GET /health` → 200 | épreuve 3 (13.2) — dataset AML : `/transactions` (paginé, brut), `/recent`, `/policy` + `/kyc/:account` (GUI-only) |
| `payments-consumer` | — | (worker, pas d'HTTP) | épreuve 4 (13.3) — consume le Stream `virements`, INSERT **naïf** dans `ledger` (gated) |
| `payments-probe` | 3400 | `GET /health` → 200 | épreuve 4 (13.3) — `POST /replay-probe` (mesures brutes), `GET /reconciliation` (gated) |

### Épreuve 4 — « Le virement en double » (idempotence)

`setup.sh` installe **Redis** (bus `virements`, Stream + groupe `payments`) et seede une base
Postgres `payments` **possédée par `cadet`** : table `ledger` **sans colonne `message_id`** (la
migration est le travail du joueur), pré-remplie de ~200 écritures légitimes — dont une **paire
jumelle** volontaire (même `from`/`to`/`amount`, `messageId` distincts) — et ~30 **doublons
historiques** (rejeux passés). Déterministe par `TEAM_ID` via `services/payments/src/ledger-spec.js`.

- `payments-consumer` lit le groupe (`XREADGROUP '>'`) et fait un INSERT **sans clé d'idempotence** :
  un rejeu re-livre tout le flux → doublons. Le `messageId` est logué (`journalctl`) mais pas dédupliqué.
- `trigger-replay.sh` (dans `/home/cadet`) repositionne le groupe au début (`XGROUP SETID … 0`) puis
  redémarre le consumer — rejeu **rejouable à volonté** par le joueur.
- `payments-probe` (user `cadet`, `sudo` ciblé sur `systemctl restart payments-consumer`) exécute le
  replay contrôlé et renvoie des **mesures brutes** (`countBefore/After`, présence d'une contrainte
  UNIQUE d'idempotence par introspection, totaux attendus vs observés). **Aucun verdict** : la décision
  appartient au juge plateforme (`challenges-service`, `POST /api/v1/challenges/payments/verify`).
- `GET /reconciliation` expose attendu vs observé par compte (feedback GUI, 13.5).

`setup.sh` installe aussi **Postgres** (dépendance d'infra de l'épreuve 3) : base `aml`, table
`transactions` (~100k lignes calibrées, déterministes par `TEAM_ID`), accessible en lecture au user
`cadet` via `psql aml`. Le dataset Postgres et l'API `tx-dataset` dérivent de la même spec
déterministe (`services/tx-dataset/src/dataset-spec.js`) — la politique AML et les dossiers KYC sont
servis **uniquement** par `tx-dataset` (jamais en base ni dans `/transactions`), préservant
l'asymétrie d'information dev/analyste.

> `soc-agent` (3000) et `tx-collector` (3100) coexistent dans la même sandbox trace-bancaire — ports distincts.
> Le port 3000 est identique à `control-center` (Prométhée) : sans collision, un profil par sandbox.

### `tx-collector` — sémantique du flux (épreuve 2)

- `GET /stream` : SSE `text/event-stream`, événements `transaction` (id croissant), heartbeats `: keepalive`.
  Coupe volontaire toutes les 30–90 s.
- Reprise : `Last-Event-ID: N` → rejoue strictement les id > N puis live. **Sans** l'en-tête → pas de rejeu
  du backlog (la fenêtre écoulée n'est pas redonnée), live uniquement → un client naïf perd des données.
- `> 5` reconnexions/min (par IP) → `429` pendant 30 s.
- `POST /checkin { ids: [...] }` : `200` si corpus complet, sinon `422 { "error": "corpus_incomplet" }`
  (aucun id manquant divulgué — renforcement § E2). Le volume attendu n'est lisible que sur `GET /expected-volume`.
- `GET /checkin/status` : consommé par le poller du juge (challenges-service).
- `POST /ingest` : interne, alimenté par l'émetteur du challenges-service (corpus authoritative).

## Frontière base / bundle (NE PAS ré-implémenter)

L'accès SSH (`cadet`, sshd:2222, `AuthorizedKeysCommand`, hook PAM `ssh-notify`, `/etc/sandbox.env`,
MOTD/banner) est fourni par la composition. Ce bundle **consomme** `/etc/sandbox.env` mais ne
configure jamais sshd/PAM/AKC.

## Validation locale

```bash
# Dans le harnais systemd (image local-sandbox:systemd) :
#   re-clone → ./setup.sh (2×, idempotence) → systemctl start soc-agent → curl :3000/health
```
