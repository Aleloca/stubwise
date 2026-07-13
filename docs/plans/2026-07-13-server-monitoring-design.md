# Monitoraggio server e servizi

Data: 2026-07-13 · Stato: design validato

## Obiettivo

Monitoraggio self-hosted dei server che tengono up i progetti, senza servizi
terzi: un agente Docker installato sui server proprietari raccoglie metriche
host (CPU, RAM, disco, rete), stato dei servizi (container Docker, app PM2,
check HTTP/TCP/process) e metriche interne dei database (Postgres/MySQL), e le
spinge a Stubwise. La SPA offre una sezione Monitor completa (lista server,
dettaglio con grafici, servizi, check) e una vista per-progetto. Alerting via
i canali di notifica esistenti (niente ticket automatici in v1).

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Direzione dati | **Push** dall'agente verso Stubwise (`POST /monitor/ingest`): i server monitorati non aprono porte, basta l'uscita HTTPS |
| Agente | **Container Docker** (`packages/agent`, TS bundlato con esbuild, immagine `node:22-alpine`, `Dockerfile.agent`); stateless, config-driven |
| Auth agente | **Chiave per-server** generata alla registrazione, mostrata una volta, salvata hashata (pattern chiave per-widget); rigenerabile |
| Modello dati | **Server → N progetti** (entità di primo livello + join `server_projects`); ogni progetto vede i suoi server |
| Scope servizi | Auto-discovery **container Docker** (docker.sock) e **app PM2** (PM2 home montata, fallback scan `/host/proc`) + check espliciti da UI: `http`, `tcp`, `process`, `postgres`, `mysql` |
| Retention | Campioni fini (~30s) per 48h, rollup a 5 minuti (avg+max) per 90 giorni, su Postgres |
| Alerting | **Solo notifiche** (`packages/notifications`): soglie per-server (jsonb, default sensati es. disco 90%), condizione sostenuta N minuti, notifica su ingresso allarme e recovery, flag anti-spam. Niente ticket automatici (fase 2) |
| Grafici SPA | **uPlot** (~45KB, time-series dense, zero dipendenze) |

## Architettura

```
server monitorato                          Stubwise
┌─────────────────────────┐    HTTPS   ┌──────────────────────────────┐
│ stubwise-agent (Docker) │──ingest──▶ │ caddy /monitor/* → server    │
│  /host/proc /host/sys   │◀─config──  │  Fastify: ingest + config    │
│  /host/root docker.sock │            │  Postgres: metrics + rollup  │
│  /host/pm2              │            │ worker: rollup, alert eval   │
└─────────────────────────┘            │ SPA: sezione Monitor         │
                                       └──────────────────────────────┘
```

Nessun servizio nuovo in compose: ingest sul server Fastify (superficie
pubblica `/monitor/*` proxata da caddy come `/widget`), job periodici nel
worker, dati in Postgres, UI nella SPA.

## Agente (`packages/agent`)

Install one-liner mostrato alla registrazione:

```
docker run -d --name stubwise-agent --restart unless-stopped \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /home/<utente>/.pm2:/host/pm2 \
  -e STUBWISE_URL=https://... -e STUBWISE_SERVER_KEY=sk_... \
  stubwise/agent
```

Raccolta (ogni `sample_interval_seconds`, default 30):

- **CPU**: delta `/host/proc/stat` → pct; `load_1m` da `/host/proc/loadavg`.
- **RAM/swap**: `/host/proc/meminfo`.
- **Disco**: statfs sui mount di `/host/root` (fs principale + mount dati).
- **Rete**: `/host/proc/net/dev`, contatori cumulativi → delta per intervallo
  calcolati dall'agente (mai contatori grezzi in DB).
- **Container**: Docker Engine API su docker.sock (lista + stats one-shot
  CPU/RAM per container). Niente CLI.
- **PM2**: client `pm2` bundlato con `PM2_HOME=/host/pm2` → lista app con
  stato, restart count, CPU/RAM. Path PM2 home configurabile via env.
  **Degrado senza errori**: socket assente o protocollo incompatibile → scan
  di `/host/proc` (figli del demone PM2, senza restart count).
- **Check espliciti** (da config): `http` (fetch con timeout, up se 2xx/3xx),
  `tcp` (connect con timeout), `process` (match su cmdline in `/host/proc`,
  riporta CPU/RAM del processo), `postgres`/`mysql` (connessione locale:
  connessioni attive/max, TPS via delta `xact_commit`, cache hit ratio,
  dimensioni DB — `pg_stat_database` / `SHOW GLOBAL STATUS`).

Comportamento: POST unico per campione; su errore di rete **buffer in memoria
(max ~2h)** rispedito in batch alla riconnessione; rilettura config ogni ~5
min; nessuno stato su disco.

## Modello dati (packages/db)

- **`servers`**: `id`, `name`, `hostname` (dall'agente), `key_hash`,
  `sample_interval_seconds` (default 30), `last_seen_at`, `agent_version`,
  `status` (`online`/`offline`/`never_connected` — offline = nessun campione
  da ~3 intervalli, heartbeat implicito), `alert_thresholds` jsonb, timestamps.
- **`server_projects`**: join N:M verso `projects`.
- **`server_metrics`** (fini, 48h): `server_id`, `ts`, `cpu_pct`, `load_1m`,
  `mem_used_bytes`, `mem_total_bytes`, `swap_used_bytes`, `disk_used_bytes`,
  `disk_total_bytes` (fs principale; mount extra in jsonb `disks`),
  `net_rx_bytes`, `net_tx_bytes` (delta), jsonb `containers`
  (`{name, state, cpu_pct, mem_bytes}`, include app PM2 con un discriminante
  di sorgente). Indice `(server_id, ts)`, upsert idempotente su quella coppia
  (batch arretrati dal buffer).
- **`server_metrics_rollup`** (5 min, 90 giorni): stessa forma aggregata
  avg+max, senza jsonb container.
- **`service_checks`**: `server_id`, `type` (`http`/`tcp`/`process`/
  `container`/`postgres`/`mysql`), `target`, `name`, `interval_seconds`,
  `enabled`, credenziali DB **cifrate** (infrastruttura segreti esistente);
  stato corrente denormalizzato: `last_status` (`up`/`down`/`unknown`),
  `last_checked_at`, `last_latency_ms`, `last_error`, `down_since`.
- **`check_samples`** (48h fini + rollup 5 min 90 giorni): `check_id`, `ts`,
  `status`, `latency_ms`, `metrics` jsonb (metriche DB, CPU/RAM process).

Storico dei cambi di stato in v1: ricavato dagli alert inviati (nessuna
tabella eventi dedicata).

## API

**Pubblica `/monitor/*`** (chiave server in header, proxy caddy):
- `POST /monitor/ingest` — batch campioni (host + container/PM2 + check);
  Zod, scrive metrics/samples, aggiorna `last_seen_at`/`hostname`/
  `agent_version` e stato corrente dei check; idempotente sui batch arretrati.
- `GET /monitor/config` — intervallo + lista check, connection string DB
  decifrate al volo (mai persistite in chiaro, viaggiano solo su HTTPS
  autenticato).

**Interna autenticata**:
- CRUD `/servers` (create → chiave mostrata una volta; rigenerazione chiave),
  associazione progetti, CRUD `/servers/:id/checks`, PATCH soglie.
- `GET /servers/:id/metrics?from&to&resolution` — ≤48h legge i fini, oltre il
  rollup; la risoluzione la decide il server, il client chiede solo il range.

## Worker (job periodici)

- **Rollup** (5 min): aggrega fini >48h in rollup (metrics e check), cancella
  i grezzi; purge rollup >90 giorni.
- **Valutazione alert** (1 min): server offline (3 intervalli senza campioni),
  CPU/RAM/disco oltre soglia **per N minuti consecutivi** (no alert su spike
  singoli), check `down`. Flag "alert inviato" per condizione: notifica su
  ingresso e su recovery, mai ripetuta.

## UI (SPA)

- **Sezione Monitor** (nav principale): card per server in stile terminal —
  pallino stato, hostname, uptime agente, gauge CPU/RAM/disco con sparkline,
  conteggio servizi up/down; server in allarme evidenziato.
- **Dettaglio server**: stato + info agente; grafici uPlot (CPU+load,
  RAM+swap, disco, rete rx/tx) con range `1h/24h/7g/30g/90g`; tabella Servizi
  (container + PM2 auto-scoperti con CPU/RAM, poi check espliciti con stato,
  latenza a grafico, metriche DB); pannello soglie alert.
- **Registrazione** (Impostazioni → Server): comando `docker run` completo di
  chiave (visibile solo lì), varianti mount PM2; editor check; associazione
  progetti.
- **Vista progetto**: tab **Server** con le card dei soli server associati
  (componente card riusato).

## Testing

- `packages/agent`: parser `/proc` e calcoli delta su fixture testuali;
  check executor con server HTTP/TCP fittizi; buffering/retry con ingest mock.
- Server: route ingest/config/admin con testcontainers (pattern esistente);
  idempotenza batch arretrati; auth chiave (401 indistinguibile).
- Worker: rollup (correttezza avg/max e purge) e valutazione alert
  (isteresi N minuti, anti-spam, recovery) su DB testcontainers.
- E2E Playwright per registrazione server + dashboard (manuale, non in
  `pnpm -r test`).

## Fase 2 (fuori scope v1)

- Ticket automatici sugli allarmi.
- Tabella eventi di stato dedicata (timeline uptime).
- Auto-discovery servizi systemd; metriche DB aggiuntive (slow query, lag
  replica).

## Note deploy

- Nuove env: nessuna obbligatoria (soglie default in codice).
- Al deploy: ribuildare `server`, `worker`, `caddy` (SPA) e pubblicare
  l'immagine `stubwise/agent` (build dal monorepo, `Dockerfile.agent`).
- Migrazione DB: sole tabelle nuove, nessun enum riusato nel batch (niente
  trappola migratore). Backup DB prima del deploy come da prassi.
