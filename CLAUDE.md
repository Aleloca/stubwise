# Stubwise

Sistema di ticketing self-hostable con pipeline AI: un worker prende i ticket,
pianifica ed esegue il fix sul repo collegato (claude CLI), apre PR e notifica.
Include una sezione "Docs" Confluence-like con documentazione autogenerata dai
repo, ricerca vettoriale e chat RAG.

## Monorepo (pnpm workspace, Node >= 22, pnpm 10.9)

- `apps/server` — API Fastify + Zod; applica le migrazioni Drizzle all'avvio.
- `apps/worker` — coda di job durabile (`FOR UPDATE SKIP LOCKED`); esegue fix e
  generazione Docs via l'agente claude CLI. Serializza i job per-progetto.
- `apps/web` — SPA React + Vite + TanStack Router/Query, Tailwind v4 (estetica
  "terminal", test in happy-dom). **Servita da caddy** (vedi sotto), non dal server.
- `apps/docs` — sito Starlight (guida utente), buildato e servito su `/guide`.
- `packages/*` — `db` (Drizzle + Postgres/pgvector), `docs-engine`, `embeddings`,
  `git`, `i18n`, `notifications`, `sdk`, `shared`, `widget` (bundle embeddabile
  del customer service, servito come `/widget.js` da caddy).

## Comandi (dalla radice)

- `pnpm test` — tutti i test (Vitest; server/worker/db usano testcontainers).
- `pnpm typecheck` — `tsc --noEmit` su tutti i package.
- `pnpm lint` — ESLint. **La CI fallisce su lint anche con typecheck+test verdi:
  lancialo SEMPRE prima del merge.**
- `pnpm build` — build di tutti i package.
- Per un singolo package: `pnpm --filter @stubwise/<nome> <script>`.
- I test E2E Playwright (`apps/web/e2e`) NON girano in `pnpm -r test` (solo in CI):
  eseguili a mano per modifiche UI rilevanti.

## Architettura runtime (docker-compose)

Servizi: `postgres` (pgvector/pgvector:pg17), `ollama` (embedding bge-m3,
1024-dim, via API OpenAI-compatibile), `server`, `worker`, `caddy`.
**Non esiste un servizio `web`.** Caddy fa da reverse proxy verso il server e
serve gli statici: SPA da `/srv/web` (root) e Starlight da `/srv/docs` (`/guide`).
Entrambi i bundle sono buildati dentro l'immagine caddy (`Dockerfile.caddy`).
`/docs` (non `/guide`) è la sezione Docs della SPA, sul fallback web.
Caddy serve anche `/widget.js` (bundle IIFE embeddabile da `/srv/widget`,
buildato in `Dockerfile.caddy`); `/widget/*` è la superficie API pubblica del
widget customer service, proxata al server.
`/monitor/ingest` e `/monitor/config` sono la superficie pubblica degli agenti
di monitoraggio (auth con chiave per-server `sk_…`), proxate al server; il resto
di `/monitor` è la sezione SPA. L'agente (`packages/agent`) gira SUGLI host
monitorati come container a sé (`Dockerfile.agent` → immagine `stubwise/agent`,
un singolo bundle esbuild), non nel compose di Stubwise.

## Deploy (prod)

Host: SSH `stubwise-vps`, checkout in `/opt/stubwise`. Deploy = `git pull` +
`docker compose up -d --build <servizio>`. Variabili in `/opt/stubwise/.env`.

- Modifica al **frontend** (`apps/web`, `apps/docs` o `packages/widget`) →
  ribuilda **`caddy`**.
- Modifica al **backend** → ribuilda `server` e/o `worker`.
- Modifica all'**agente di monitoraggio** (`packages/agent`) → l'immagine
  `alelocadev/stubwise-agent` su Docker Hub (multi-arch, così gli host la pullano
  senza clonare il repo) viene **ripubblicata dalla CI** (`agent-image.yml`) a
  ogni push su main che tocca `packages/agent`, `packages/shared`,
  `Dockerfile.agent` o il lockfile; tag `latest` + `sha-<commit>`. Pubblicazione
  manuale (fallback / `workflow_dispatch`): `docker buildx build --platform
  linux/amd64,linux/arm64 -f Dockerfile.agent -t alelocadev/stubwise-agent:latest
  --push .` (serve `docker login`). Gli host NON si auto-aggiornano: `docker pull`
  + ricrea il container. Se cambi anche il comando mostrato dalla UI
  (`apps/web/.../settings/servers.tsx`), ribuilda pure `caddy`.
- Verifica il bundle servito cercando una stringa nuova:
  `docker exec stubwise-caddy-1 sh -c 'grep -rl "<stringa>" /srv/web'`.
- Backup del DB prima di operazioni rischiose.

## Invarianti e trappole

- **Worker fail-on-restart:** un riavvio del worker fallisce le generazioni Docs
  in corso (lavoro perso). Riavvia il worker solo quando NON ci sono generazioni
  attive: `select id from doc_generations where status in ('running','paused');`
  deve essere vuoto. Le `paused` contano: una pausa per limite del provider è
  comunque una generazione viva (worktree registrato in-memoria) e può restarci
  per ore. La fase **product** allunga la finestra di finalize (decine di run): un
  crash del worker DENTRO product/finalize lascia la generazione `running` per
  sempre (nessun nodo claimabile) → recovery manuale: `update doc_generations set
  status='failed', error='worker crash during finalize' where id=...`.
- **Concorrenza:** `WORKER_CONCURRENCY` (default 2) e `DATABASE_POOL_MAX` (default
  10, alzalo in proporzione) sono env. In prod attuale: 5 e 20.
- **`WORKER_STALE_MINUTES`** va tenuto coerente in 3 punti (config.ts, compose,
  invariante verificata in index.ts) quando si allunga il tempo max di un fix.
- **Testcontainers:** `pnpm -r test` è flaky con troppi Postgres concorrenti →
  `maxForks` limitato nelle vitest.config di server/worker/db. Image pgvector
  (Debian) inizializzata con `--locale=C` per collation deterministica.
- **Install nel worktree del fix:** install/test del repo target NON con
  `NODE_ENV=production` (ometterebbe le devDeps → exit 127).
- **File `.env` per progetto:** cifrati, materializzati nel worktree prima di
  install/test; il safeguard anti-leak è l'esclusione da TUTTI i `git add`/`status`.
