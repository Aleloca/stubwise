# Stubwise

Issue tracker self-hostabile e open source con una pipeline AI integrata: gli
errori catturati dagli SDK diventano ticket, e un worker basato sul CLI di
[Claude Code](https://claude.com/claude-code) prova a fare triage del bug e a
proporre una fix aprendo una pull request sul tuo repository.

In pratica: un tracker di ticket in stile Jira che, quando arriva un bug, tenta
di sistemarlo da solo — il tutto sulla **tua** infrastruttura, con i **tuoi**
dati.

> Stato: progetto giovane. Il cuore (ingestion, ticketing, pipeline AI,
> self-hosting) è completo e testato; ci aspettiamo issue e contributi.

## Caratteristiche

- **Cattura errori via SDK** per browser e Node.js, con breadcrumb automatici,
  release ed environment.
- **Deduplica per fingerprint**: errori simili confluiscono in un unico gruppo
  e in un unico ticket, senza rumore.
- **Ticketing completo**: lista, dettaglio, commenti, transizioni di stato e una
  board Kanban.
- **Pipeline AI opzionale**: triage automatico del ticket e, quando ha senso,
  una pull request con la fix proposta, aperta sul tuo provider git.
- **Provider git pluggabili**: GitHub e Bitbucket Cloud inclusi; webhook di PR
  merged che chiudono il ticket.
- **Completamente self-hostabile**: quattro container Docker, HTTPS automatico
  via Caddy, nessun dato che esce dalla tua infrastruttura.
- **Open source (MIT)**, monorepo TypeScript end-to-end.

## Screenshot

<!-- TODO: aggiungere screenshot della board e del dettaglio ticket in docs/assets/
     e linkarli qui, es.: ![Board Kanban](docs/assets/board.png) -->

_Screenshot in arrivo. Per ora la UI è esplorabile avviando lo stack (vedi sotto)._

## Architettura

```text
        app dei tuoi utenti
                │  errori / feedback (HTTP)
                ▼
        ┌───────────────┐
        │ @stubwise/sdk │  browser + Node
        └───────┬───────┘
                │  POST /ingest/<slug>
                ▼
  ┌─────────┐        ┌───────────────┐        ┌──────────────┐
  │  Caddy  │──────▶ │    server     │──────▶ │   Postgres   │
  │ (HTTPS, │  proxy │ (Fastify API, │  SQL   │ (ticket, code│
  │  web    │        │  migrazioni)  │◀────── │  dei job)    │
  │ statica)│        └───────────────┘        └──────┬───────┘
  └─────────┘                                        │ polling coda
                                                     ▼
                                            ┌──────────────────┐
                                            │      worker      │
                                            │ (pipeline AI:    │
                                            │  triage + fix    │
                                            │  via CLI claude) │
                                            └────────┬─────────┘
                                                     │ clone / push / PR
                                                     ▼
                                          GitHub / Bitbucket (repo)
```

Lo stack di produzione gira in quattro container: `postgres`, `server` (API
Fastify, applica le migrazioni all'avvio), `worker` (pipeline AI, richiede git +
il CLI `claude`) e `caddy` (serve la web app statica e fa da reverse proxy verso
il server, con HTTPS automatico).

Il monorepo (pnpm, Node 22):

- `apps/server` — API Fastify, autenticazione, ticketing, ingestion, OpenAPI.
- `apps/web` — web app React (TanStack Router/Query, Tailwind).
- `apps/worker` — pipeline AI (triage, fix, apertura PR) sopra il CLI `claude`.
- `apps/docs` — sito di documentazione (Astro Starlight).
- `packages/shared` — schemi Zod di dominio e tipi (pubblicato su npm).
- `packages/sdk` — SDK browser/Node (pubblicato su npm).
- `packages/db` — schema e migrazioni Drizzle.
- `packages/git` — astrazione `GitProvider` (GitHub, Bitbucket).

## Quick start (self-hosting con Docker Compose)

### Prerequisiti

- Docker con Docker Compose v2 (`docker compose`).
- Un dominio che punta all'host se vuoi l'HTTPS automatico.

### 1. Configura l'ambiente

```bash
git clone https://github.com/Aleloca/stubwise.git
cd stubwise
cp .env.example .env
```

Genera i segreti e compilali nel `.env` (sezione `DEPLOY`):

```bash
openssl rand -hex 32       # -> SESSION_SECRET
openssl rand -base64 32    # -> ENCRYPTION_KEY
openssl rand -hex 24       # -> POSTGRES_PASSWORD (una password robusta)
```

- `POSTGRES_PASSWORD`: la password del database.
- `DATABASE_URL`: deve puntare al servizio `postgres` del compose e combaciare
  con utente/password/db, ad esempio
  `postgres://stubwise:LA_PASSWORD@postgres:5432/stubwise`.
- `SESSION_SECRET` ed `ENCRYPTION_KEY`: i due segreti generati sopra.
- `DOMAIN`: il dominio pubblico (es. `stubwise.example.com`). Per provare in
  locale usa `localhost` (TLS self-signed) o `:80` (solo HTTP).
- `PUBLIC_URL`: l'URL pubblico coerente con `DOMAIN`, es.
  `https://stubwise.example.com`.

### 2. Avvia

```bash
docker compose up -d --build
```

Il server applica le migrazioni del database all'avvio; il worker parte solo
dopo che il server è sano. Apri quindi `https://DOMAIN` nel browser.

### 3. Setup iniziale dalla UI

1. Alla prima apertura crei l'utente **admin** (il primo registrato è admin).
2. Crei un **progetto**. Dalla pagina del progetto trovi:
   - il **DSN** per configurare l'SDK nella tua app (vedi sotto);
   - l'endpoint e il **secret del webhook** git da impostare sul provider
     (GitHub/Bitbucket) per chiudere i ticket al merge della PR;
   - le **credenziali git** del repo che il worker userà per clonare e aprire
     PR (vengono cifrate con `ENCRYPTION_KEY`).

### 4. Auth del worker (CLI claude)

Il worker invoca il CLI `claude` per triage e fix: serve un'autenticazione.
Scegli **una** delle due vie.

**a) Chiave API (consigliata in produzione).** Imposta `ANTHROPIC_API_KEY` nel
`.env` e riavvia il worker:

```bash
docker compose up -d worker
```

**b) Login OAuth/MAX.** Lascia `ANTHROPIC_API_KEY` vuota ed effettua il login
interattivo dentro il container; il token persiste nel volume `claude-config`
(montato su `CLAUDE_CONFIG_DIR=/home/worker/.claude`), quindi sopravvive a
riavvii e rebuild:

```bash
docker compose exec worker claude login
```

### Backup

I dati persistenti vivono in due volumi Docker:

- `pgdata`: il database (ticket, progetti, utenti, code dei job).
- `mirrors`: i mirror git dei repository dei progetti (ricostruibili, ma il
  backup evita un re-clone completo).

Esempio di dump del database:

```bash
docker compose exec postgres pg_dump -U stubwise stubwise > backup.sql
```

### Aggiornamenti

```bash
git pull
docker compose up -d --build
```

Le nuove migrazioni vengono applicate dal server all'avvio.

## Quick start (SDK)

Installa l'SDK nella tua applicazione e inizializzalo con il DSN che trovi nella
pagina del progetto. Da quel momento gli errori non gestiti diventano ticket
sulla tua istanza, deduplicati per fingerprint.

Browser:

```js
import { init, captureError } from "@stubwise/sdk/browser";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",          // opzionale: allegato a ogni evento
  environment: "production", // opzionale
});

// cattura automatica degli errori globali + breadcrumb; oppure manuale:
try {
  doSomethingRisky();
} catch (err) {
  captureError(err);
}
```

Node.js:

```js
import { init } from "@stubwise/sdk/node";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",
  environment: "production",
});
// registra di default i listener su uncaughtException / unhandledRejection
```

La chiave di ingestion del DSN è pensata per stare in codice client-side:
consente solo di *inviare* eventi, non di leggere i ticket. Dettagli, opzioni e
helper per Express/Fastify nella documentazione SDK.

## Documentazione

Il sito di documentazione (Astro Starlight) vive in `apps/docs` e copre
self-hosting, configurazione, SDK, pipeline AI e riferimento API. Per leggerlo
in locale:

```bash
pnpm --filter @stubwise/docs dev
```

Nello stack deployato è servito da Caddy sotto `/docs`.

Documenti di progetto: [design e piano di implementazione](docs/plans/).

## Contribuire

Setup di sviluppo, convenzioni, come aggiungere un nuovo `GitProvider` e il
processo di release sono in [CONTRIBUTING.md](CONTRIBUTING.md). Per segnalazioni
usa gli [issue template](.github/ISSUE_TEMPLATE/).

## Licenza

[MIT](LICENSE) © Stubwise contributors.
