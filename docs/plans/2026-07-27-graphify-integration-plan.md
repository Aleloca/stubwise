# Integrazione graphify — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Grafo del codice per-repository generato dal worker (graphify, AST-only), servito nella tab "Grafo" della sezione Docs, con PR di setup sul repo target e container `graphify serve` HTTP nel compose.

**Architecture:** Il worker esegue `graphify extract --code-only` su un worktree read-only del mirror e scrive su un volume condiviso `graphs` (rw worker, ro server e container graphify). Postgres tiene solo metadati (`repo_graphs`) e la coda (`graph_jobs`, pattern `backlog_jobs`). Il server serve report/html/json dal volume dietro auth; la SPA li mostra in una tab per-repository nella sezione Docs. Design completo e decisioni: `docs/plans/2026-07-27-graphify-integration-design.md` (LEGGILO PRIMA).

**Tech Stack:** graphifyy==0.9.28 (pin, PyPI — CLI `graphify`) + Python 3.12 nelle immagini worker e nuovo container `graphify`; Drizzle/Postgres; Fastify+Zod; React/TanStack.

**Convenzioni trasversali (valgono per ogni task):**
- TDD: test prima, verifica che fallisca, implementa, verifica che passi, commit.
- Test singolo package: `pnpm --filter @stubwise/db test`, `pnpm --filter @stubwise/server test`, ecc. (server/worker/db usano testcontainers: serve Docker attivo).
- Commit frequenti, messaggi `feat(scope):` / `fix(scope):` in italiano come lo storico.
- Prima del merge finale: `pnpm lint` + `pnpm typecheck` + `pnpm test` dalla radice (la CI fallisce su lint anche con tutto il resto verde).
- Commenti in italiano, stile del file circostante.
- Lavora nel worktree dedicato (NON su main): verifica con `git rev-parse --abbrev-ref HEAD` di essere sul branch feature prima di ogni commit.

---

## Fase A — Fondamenta: schema DB e migrazione

### Task 1: Migrazione 0062 (`repo_graphs`, `graph_jobs`, toggle)

**Files:**
- Create: `packages/db/migrations/0062_graphify_integration.sql`
- Modify: `packages/db/src/schema.ts` (aggiungi in coda, vicino alle tabelle backlog)
- Test: `packages/db/src/graph-schema.test.ts` (nuovo, modellato su `packages/db/src/backlog.test.ts`)

**Step 1: scrivi il test** — crea `graph-schema.test.ts` che (a) inserisce un repository e verifica `graphEnabled` default `false`; (b) inserisce una riga `repo_graphs` per il repo e ne rilegge status/contatori; (c) inserisce un `graph_jobs` kind `build` queued e verifica che un secondo insert queued per lo stesso (repo, kind) violi l'indice parziale unico; (d) verifica che kind accetti solo `build`/`setup_pr`. Usa l'harness testcontainers di `backlog.test.ts` (stesso setup/teardown).

**Step 2:** `pnpm --filter @stubwise/db test -- graph-schema` → deve FALLIRE (tabelle inesistenti).

**Step 3: migrazione SQL** — contenuto:

```sql
ALTER TABLE repositories ADD COLUMN graph_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE repo_graphs (
  repository_id uuid PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'none', -- none|queued|running|done|failed
  commit_sha text,
  node_count integer,
  edge_count integer,
  community_count integer,
  labeled boolean NOT NULL DEFAULT false,
  setup_pr_url text,
  error text,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE graph_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind text NOT NULL, -- build|setup_pr
  status text NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz, -- debounce del webhook push
  force boolean NOT NULL DEFAULT false, -- passa --force a graphify (push con cancellazioni)
  error text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Un solo job attivo per (repo, kind): il debounce AGGIORNA il queued esistente.
CREATE UNIQUE INDEX graph_jobs_active_unique
  ON graph_jobs (repository_id, kind)
  WHERE status IN ('queued', 'running');
```

⚠️ Trappola migrazioni (CLAUDE.md): il batch gira in UNA transazione — qui non ci sono enum nuovi usati nella stessa migrazione, ok.

**Step 4: schema drizzle** — replica le tabelle in `schema.ts` (guarda `backlogJobs` per lo stile: commenti sui campi, `index()`/`uniqueIndex()` con `.where()` per l'indice parziale). Esporta i tipi `RepoGraph`, `GraphJob`.

**Step 5:** test verdi → commit `feat(db): tabelle repo_graphs e graph_jobs + toggle graph_enabled (migrazione 0062)`.

---

## Fase B — Worker: coda e job di build

### Task 2: Coda `graph_jobs` nel worker (claim/recovery)

**Files:**
- Create: `apps/worker/src/graph/queue.ts` + `queue.test.ts`
- Modello: `apps/worker/src/backlog/` (poller/claim SKIP LOCKED, recovery orfani 15min/3 attempts)

**Step 1: test** — claim FIFO con `FOR UPDATE SKIP LOCKED` che onora `not_before > now()` (non claimabile prima del debounce), passaggio queued→running con `claimed_at`, recovery: running con `claimed_at` più vecchio di 15min torna queued (attempts+1), fallimento definitivo a 3 attempts → status failed + `repo_graphs.status='failed'`.

**Step 2:** rosso. **Step 3:** implementa copiando la struttura della coda backlog (stesse costanti; funzioni `claimNextGraphJob`, `recoverStaleGraphJobs`, `completeGraphJob`, `failGraphJob`). **Step 4:** verde. **Step 5:** commit `feat(worker): coda graph_jobs con claim e recovery`.

### Task 3: Runner del build (`graphify extract` sul worktree)

**Files:**
- Create: `apps/worker/src/graph/build.ts` + `build.test.ts`
- Create: `apps/worker/src/graph/graphify-cli.ts` (wrapper spawn, mockabile) + test
- Modify: `apps/worker/src/config.ts` (nuove env, vedi sotto) + `config.test.ts`
- Modello per lo spawn catturato: `apps/worker/src/pipeline/run-command-captured*`; per il worktree: `MirrorManager.openWorktree` in `apps/worker/src/git/mirrors.ts`

**Env nuove in `config.ts`:** `GRAPHS_DIR` (default `/graphs`), `GRAPH_LABEL_ENABLED` (default `true`), `GRAPHIFY_BIN` (default `graphify`), `GRAPH_BUILD_TIMEOUT_MINUTES` (default `20`).

**Step 1: test di `build.ts`** con `graphify-cli` mockato — verifica la SEQUENZA:
1. `repo_graphs` upsert status `running`.
2. `openWorktree` read-only a HEAD del default branch (e chiusura SEMPRE, anche su errore — try/finally).
3. Chiamata extract: argomenti attesi `extract <worktreeDir> --code-only` (+ `--force` se `job.force`), env `GRAPHIFY_OUT=<GRAPHS_DIR>/<repositoryId>/graphify-out`.
4. Con `GRAPH_LABEL_ENABLED`: chiamata `cluster-only <worktreeDir> --backend=claude-cli` (genera GRAPH_REPORT.md + nomi comunità); fallimento del labeling NON fallisce il job (log warning, `labeled=false`, riprova `cluster-only --no-label` per avere comunque il report).
5. Chiamata `export html`.
6. Parse dell'output extract (riga `wrote ...graph.json: N nodes, M edges, K communities` — regex robusta) → update `repo_graphs`: status `done`, sha del worktree, contatori, `generated_at`.
7. Su errore: status `failed` + error troncato.

**Step 2:** rosso. **Step 3:** implementa. `graphify-cli.ts` fa spawn con timeout `GRAPH_BUILD_TIMEOUT_MINUTES`, cattura stdout/stderr (tetto dimensione), inietta `GRAPHIFY_OUT` e — per il backend claude-cli — la stessa env/HOME dei run agente esistenti (guarda come `apps/worker/src/agent/claude-cli.ts` risolve il binario e la config). **Step 4:** verde. **Step 5:** commit `feat(worker): job graph_build con extract/label/html via graphify CLI`.

### Task 4: Poller + integrazione in `index.ts`

**Files:**
- Create: `apps/worker/src/graph/poller.ts` + test
- Modify: `apps/worker/src/index.ts` (avvio poller, shutdown, log "graph ogni N''" come gli altri poller)

Poller `setInterval` (env `GRAPH_POLL_SECONDS` default 20, `0`=off), pattern del poller backlog: recovery orfani a ogni tick, poi claim in loop; **serializza per-progetto col serializer condiviso esistente** (i build sono corti ma il labeling usa claude-cli: deve rispettare pausa-limite come gli altri run). Dispatch per kind: `build` → Task 3, `setup_pr` → Task 7 (per ora ramo TODO che fallisce il job con errore "not implemented"). Test: tick che claima e dispaccia, kind sconosciuto → failed. Commit `feat(worker): poller graph_jobs`.

### Task 5: Enqueue dal webhook push (debounce 60s)

**Files:**
- Modify: `apps/server/src/routes/webhooks.ts` + `webhooks.test.ts`
- Modello: il debounce di `activity_recount_jobs` nello stesso file

**Step 1: test** — su push per un repo con `graphEnabled`: (a) nessun job → INSERT queued con `not_before=now()+60s`; (b) job queued esistente → UPDATE del `not_before` (niente doppio insert, l'indice parziale lo garantisce — usa `ON CONFLICT` sull'indice o update-then-insert); (c) repo con toggle off → nessun job; (d) il payload del push contiene file cancellati (i webhook Bitbucket/GitHub già parsati per il recount espongono i changes) → `force=true` sul job.

**Step 2-4:** rosso → implementa accanto al debounce recount → verde. **Step 5:** commit `feat(server): enqueue graph_build sul push con debounce`.

### Task 6: Immagine worker con Python + graphifyy

**Files:**
- Modify: `apps/worker/Dockerfile`
- Modify: `docker-compose.yml` (worker: mount `graphs:/graphs` rw + env `GRAPHS_DIR=/graphs`; sezione `volumes:` in fondo: aggiungi `graphs:`)

Nel Dockerfile worker (guarda lo stage runtime esistente): installa `python3` + `python3-venv` dai repo della base image, poi venv dedicato:

```dockerfile
RUN python3 -m venv /opt/graphify && \
    /opt/graphify/bin/pip install --no-cache-dir "graphifyy[sql]==0.9.28" && \
    ln -s /opt/graphify/bin/graphify /usr/local/bin/graphify
```

⚠️ Se la base image del worker è alpine, `graphifyy` ha wheel tree-sitter per musl? Verifica: se il build fallisce sulle wheel, passa la base dello stage runtime a `node:22-bookworm-slim` (coerente con la base usata altrove — controlla prima). Verifica build locale: `docker build -f apps/worker/Dockerfile .` completa e `docker run --rm <img> graphify --version` stampa 0.9.28. Commit `feat(worker): graphify CLI nell'immagine + volume graphs`.

---

## Fase C — PR di setup

### Task 7: Job `graph_setup_pr`

**Files:**
- Create: `apps/worker/src/graph/setup-pr.ts` + `setup-pr.test.ts`
- Modify: `apps/worker/src/graph/poller.ts` (aggancia il ramo `setup_pr`)
- Modello: la parte finale di `apps/worker/src/pipeline/fix.ts` (branch → commit → push → `openPullRequest` via `getProviderFn`), MA senza install/test/env-files.

**Step 1: test** (provider e git mockati) — il job:
1. Precondizione: `repo_graphs.status='done'` e i file esistono sul volume, altrimenti failed con errore chiaro.
2. Apre un worktree SCRIVIBILE su branch `stubwise/graphify-setup` (nuovo o reset se esiste — idempotenza).
3. Copia dal volume: `graphify-out/{graph.json,GRAPH_REPORT.md,graph.html,manifest.json}` (MAI `cache/` né `cost.json`).
4. Scrive/aggiorna in modo idempotente (marker di sezione, pattern dei markers docs-engine):
   - `.graphifyignore` starter (solo se assente),
   - `.gitattributes`: riga `graphify-out/graph.json merge=graphify-union` (append se assente),
   - `.gitignore`: righe `graphify-out/cost.json` e `graphify-out/cache/` (append se assenti),
   - `.mcp.json`: MERGE JSON (non sovrascrivere server esistenti) con la voce `graphify` → command `uvx`, args `["--from","graphifyy[mcp]==0.9.28","python","-m","graphify.serve","graphify-out/graph.json"]`,
   - sezione `CLAUDE.md` delimitata da marker `<!-- graphify:start -->/<!-- graphify:end -->` con la guida query-first (2-3 righe: preferisci `graphify query` al grep quando il grafo esiste).
5. Esegue `graphify install --project --platform claude` nel worktree (skill in `.claude/skills/graphify/`) via `graphify-cli.ts`.
6. `git add` dei SOLI path sopra elencati (safeguard anti-leak: mai `git add -A`), commit, push `--force-with-lease` del branch, `openPullRequest` col provider del repo; se il provider risponde che la PR esiste già, recupera/riusa l'URL.
7. Salva `setup_pr_url` su `repo_graphs`, job done.

Corpo della PR: descrizione breve + istruzioni dev (`uv tool install graphifyy` e `graphify hook install` per il post-commit rebuild e la registrazione del merge driver).

**Step 2-4:** TDD come sopra. **Step 5:** commit `feat(worker): job graph_setup_pr (branch idempotente + PR sul provider)`.

---

## Fase D — Server: API e serving dal volume

### Task 8: Route `repo-graph`

**Files:**
- Create: `apps/server/src/routes/repo-graph.ts` + `repo-graph.test.ts`
- Modify: registrazione route in `apps/server/src/index.ts` (o dove sono registrate le altre route) 
- Modify: `docker-compose.yml` (server: mount `graphs:/graphs:ro` + env `GRAPHS_DIR`)
- Modello: una route esistente con auth + Zod (es. `apps/server/src/routes/backlog.ts` per struttura e ownership check)

Endpoint (tutti dietro auth di sessione; scrivono solo gli admin):
- `GET /api/repositories/:id/graph` → `{ enabled, status, commitSha, nodeCount, edgeCount, communityCount, labeled, generatedAt, setupPrUrl, error, jobPending }`. Se status `done` ma `graph.json` assente sul volume → risponde status `none` E resetta la riga (volume ricreato).
- `POST /api/repositories/:id/graph/generate` (admin) → enqueue `build` (409 se già attivo), `force` opzionale nel body.
- `POST /api/repositories/:id/graph/setup-pr` (admin) → enqueue `setup_pr` (409 se attivo, 412 se grafo non `done`).
- `GET /api/repositories/:id/graph/report` → testo markdown di `GRAPH_REPORT.md`.
- `GET /api/repositories/:id/graph/html` → `graph.html` con header: `Content-Type: text/html`, `Content-Security-Policy: sandbox allow-scripts; default-src 'unsafe-inline' 'self'` e `X-Frame-Options` NON impostato (deve stare in iframe della SPA). Path SEMPRE costruito come `join(GRAPHS_DIR, repositoryId, "graphify-out", <nome fisso>)` — `repositoryId` è un uuid validato da Zod, nessun path traversal possibile; nessun parametro filename libero.
- `GET /api/repositories/:id/graph/json` → download `graph.json` (`Content-Disposition: attachment`).
- `PATCH /api/repositories/:id/graph` (admin) → toggle `graphEnabled` (o aggiungilo alla route esistente di update repository se c'è — verifica dove vive l'update di `backlogEnabled` e segui quel pattern).

Test testcontainers: auth 401, non-admin 403 sui POST, 404 file mancante, 409/412, reset su file assente (usa una dir temporanea come `GRAPHS_DIR`). Commit `feat(server): API repo graph (metadati, generate, setup-pr, contenuti dal volume)`.

### Task 9: Container `graphify serve` nel compose

**Files:**
- Create: `Dockerfile.graphify`
- Modify: `docker-compose.yml`

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir "graphifyy[mcp,sql]==0.9.28"
# Multi-progetto puro: nessun grafo di default, i client passano project_path=/graphs/<repoId>.
CMD ["python", "-m", "graphify.serve", "--transport", "http", "--host", "0.0.0.0", "--port", "8080", "--stateless"]
```

Compose: servizio `graphify` con `build: {context: ., dockerfile: Dockerfile.graphify}`, mount `graphs:/graphs:ro`, `restart: unless-stopped`, stesso logging degli altri; NESSUNA porta pubblicata (solo rete interna) e nessuna route caddy. Verifica: `docker compose build graphify` ok. ⚠️ Controlla nel sorgente di `graphify/serve.py` se `--stateless` senza grafo di default richiede comunque un argomento posizionale: in tal caso avvia con un path placeholder inesistente (il server parte in modalità multi-progetto pura, è il comportamento documentato nel codice). Commit `feat(compose): servizio graphify serve HTTP su volume graphs`.

---

## Fase E — Web UI

### Task 10: API client, query e i18n

**Files:**
- Modify: `apps/web/src/lib/api.ts` (tipi `RepoGraph` + fetcher dei 4 endpoint di lettura/azione)
- Modify: `apps/web/src/lib/queries.ts` (query con `refetchInterval` 10s quando status è queued/running — pattern delle generazioni Docs)
- Modify: `packages/i18n` (chiavi it+en: `docs.graph.*` — titoli, stati, bottoni, errori)

Test happy-dom minimi sui fetcher se il file ha già test; altrimenti copertura nel Task 11. Commit `feat(web): client API e query per il grafo repo`.

### Task 11: Tab "Grafo" nella sezione Docs

**Files:**
- Create: `apps/web/src/routes/docs/graph.$repositoryId.tsx` + `graph.$repositoryId.test.tsx`
- Modify: `apps/web/src/components/docs-sidebar.tsx` e/o `docs-repo-overview.tsx` (link/tab "Grafo" per repository, accanto alle viste esistenti — segui la struttura della sidebar a tab del redesign, vedi `docs-tree.tsx` per lo stile delle tab)

Contenuto della vista (4 stati, dall'alto): header metadati (data, sha corto, contatori, badge "aggiornato al push" se il toggle è on) + azioni admin (Rigenera, Apri PR di setup / link alla PR); `<iframe sandbox="allow-scripts" src=".../graph/html">` a piena larghezza (altezza ~70vh); `GRAPH_REPORT.md` renderizzato col componente `<Markdown>` esistente (sanitize-html); footer con link download `graph.json` e hint `graphify query "..."` copiabile. Stati non-done: CTA verso /team (admin) se disabilitato, bottone Genera se mai generato, badge+polling se in corso, errore+Riprova se failed.

Test happy-dom: i 4 stati renderizzano, i bottoni admin chiamano i POST, il polling si attiva su running. Estetica terminal coerente. Commit `feat(web): tab Grafo nella sezione Docs`.

### Task 12: Toggle in /team

**Files:**
- Modify: la vista di dettaglio progetto in /team dove vive il toggle `backlogEnabled` per progetto e i repository (cerca `backlogEnabled` sotto `apps/web/src/routes/` e replica il pattern PER-REPOSITORY con `graphEnabled`) + test

Commit `feat(web): toggle graph_enabled per repository da /team`.

---

## Fase F — Rifiniture e verifica finale

### Task 13: CLAUDE.md e note di deploy

**Files:**
- Modify: `CLAUDE.md` — sezione "Architettura runtime": aggiungi il servizio `graphify` e il volume `graphs`; sezione "Deploy": modifica al grafo/worker → ribuilda `worker` (+ `graphify` se cambia il Dockerfile.graphify; tab UI → `caddy`); pin `graphifyy==0.9.28` da aggiornare deliberatamente in 3 punti (Dockerfile worker, Dockerfile.graphify, args uvx nel setup-pr — tienili allineati).

Commit `docs: CLAUDE.md aggiornato con servizio graphify e volume graphs`.

### Task 14: Verifica finale

1. `pnpm typecheck` → verde.
2. `pnpm lint` → verde (OBBLIGATORIO prima del merge).
3. `pnpm test` dalla radice → verde (testcontainers: flaky con troppi Postgres → i maxForks sono già limitati, non toccarli).
4. `docker compose build worker graphify server` → completano.
5. E2E Playwright NON girano in `pnpm -r test`: la tab Grafo è UI nuova rilevante → esegui a mano gli E2E core-flows (`apps/web/e2e`) per regressioni di navigazione Docs.
6. NON committare su main: al termine segui superpowers:finishing-a-development-branch (merge --no-ff su main come da prassi del repo).

**Deploy (post-merge, da fare CON l'utente — non in autonomia):** backup DB → `git pull` su stubwise-vps → `docker compose up -d --build server worker caddy graphify` (migrazione 0062 all'avvio server; il worker è gated dal healthcheck del server) → verificare `select id from doc_generations where status in ('running','paused')` PRIMA di riavviare il worker (invariante CLAUDE.md) → toggle per-repository da /team → prima generazione dal bottone in tab Grafo.
