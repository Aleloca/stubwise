# Fix multi-repository (Fase 3) — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Un ticket può richiedere modifiche a più repository dello stesso progetto.
Un solo agente `claude` gira alla radice di una working dir con TUTTI i repo del
progetto montati come sottocartelle, decide da sé quali toccare, e apre una PR per ogni
repo modificato. Il ticket si chiude quando tutte le PR sono mergiate.

**Design (leggere prima):** `docs/plans/2026-07-01-multi-repo-fix-fase3-design.md`
(decisioni D1–D9). Fasi precedenti: Fase 1 (modello a due livelli) e Fase 2 (docs
cross-repo) sono in prod.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, worker (claude CLI + MirrorManager),
React+TanStack, Vitest.

**ATTENZIONE — rischio regressioni:** questa fase fa il rework del **motore di fix**,
dell'**ingest** e del **webhook**. È la più invasiva. Ogni task chiude verde
(typecheck+test+lint del package) prima del successivo; il full-repo torna verde al 3-4.
La 3-1 (schema) rompe temporaneamente il typecheck di server/worker fino ai task dopo:
è atteso.

**Invarianti da non rompere** (verificate dai review delle fasi 1–2):
- Env-files cifrati materializzati nel worktree, esclusi da TUTTI i `git add`/`status`.
- Install/test del repo target NON con `NODE_ENV=production`.
- Mirror: niente `fetch --prune` con un worktree aperto (garantito dalla serializzazione).
- Worker fail-on-restart per le generazioni docs.
- `pnpm -r build` dopo aver toccato package condivisi (dist stantii → typecheck rotto).

---

## Sotto-fase 3-1 — Modello dati + numerazione + ingestion di progetto

### Task 1: schema + migrazione 0035 + shared

**Files:** `packages/db/src/schema.ts`, `packages/db/drizzle/0035_*.sql` (a mano),
`packages/shared/src/schemas/*`, helper testing in `packages/db/src/testing.ts`.

**Modifiche schema:**
1. `projects`: aggiungi `nextTicketNumber: integer("next_ticket_number").notNull().default(1)`;
   aggiungi `ingestionKey: text("ingestion_key").notNull().unique()` (sale da repositories).
2. `repositories`: RIMUOVI `nextTicketNumber` e `ingestionKey`. Mantieni `webhookSecret`.
3. `tickets`: RIMUOVI `repositoryId` (colonna + indici che la nominano). `projectId` resta
   NOT NULL. Verifica che l'unique resti `(projectId, number)`.
4. `errorGroups`: rinomina `repositoryId` → `projectId` (FK projects cascade); aggiorna
   l'unique del fingerprint da `(repositoryId, fingerprint)` a `(projectId, fingerprint)`
   e gli indici correlati.
5. Nuova tabella `ticketRepositories`: `id` uuid PK, `ticketId` (FK tickets cascade),
   `repositoryId` (FK repositories cascade), `branch` text, `prUrl` text nullable,
   `prState` enum (`pr_state`: `open|merged|closed_unmerged`), `createdAt` timestamptz.
   UNIQUE `(ticketId, repositoryId)`; indice su `(ticketId)`.
6. `ai_jobs`: invariato (resta uno per ticket; `prUrl` mantenuto).

**Migrazione 0035 (A MANO, data-preserving):**
```sql
-- numerazione per-progetto (oggi 1 repo/progetto → il numero coincide)
ALTER TABLE "projects" ADD COLUMN "next_ticket_number" integer NOT NULL DEFAULT 1;
UPDATE "projects" p SET "next_ticket_number" = sub.n FROM (
  SELECT r.project_id AS pid, MAX(r.next_ticket_number) AS n
  FROM "repositories" r GROUP BY r.project_id
) sub WHERE p.id = sub.pid;
ALTER TABLE "repositories" DROP COLUMN "next_ticket_number";
-- ingestionKey sale al progetto (migrata identica dal repo 1:1)
ALTER TABLE "projects" ADD COLUMN "ingestion_key" text;
UPDATE "projects" p SET "ingestion_key" = r.ingestion_key
  FROM "repositories" r WHERE r.project_id = p.id;
ALTER TABLE "projects" ALTER COLUMN "ingestion_key" SET NOT NULL;
ALTER TABLE "projects" ADD CONSTRAINT "projects_ingestion_key_unique" UNIQUE("ingestion_key");
ALTER TABLE "repositories" DROP COLUMN "ingestion_key";
-- errorGroups per-progetto
ALTER TABLE "error_groups" ADD COLUMN "project_id" uuid;
UPDATE "error_groups" eg SET "project_id" = r.project_id
  FROM "repositories" r WHERE r.id = eg.repository_id;
ALTER TABLE "error_groups" ALTER COLUMN "project_id" SET NOT NULL;
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
-- ricrea l'unique del fingerprint per progetto (VERIFICA il nome reale del vincolo)
ALTER TABLE "error_groups" DROP CONSTRAINT IF EXISTS "error_groups_repository_id_fingerprint_unique";
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_project_id_fingerprint_unique" UNIQUE("project_id","fingerprint");
ALTER TABLE "error_groups" DROP COLUMN "repository_id";
-- tickets senza repository (bersaglio ora è il progetto)
ALTER TABLE "tickets" DROP COLUMN "repository_id";
-- stato PR per-repo
CREATE TYPE "pr_state" AS ENUM('open','merged','closed_unmerged');
CREATE TABLE "ticket_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ticket_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "branch" text NOT NULL,
  "pr_url" text,
  "pr_state" "pr_state" NOT NULL DEFAULT 'open',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_repositories_ticket_id_repository_id_unique" UNIQUE("ticket_id","repository_id")
);
ALTER TABLE "ticket_repositories" ADD CONSTRAINT "ticket_repositories_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE cascade;
ALTER TABLE "ticket_repositories" ADD CONSTRAINT "ticket_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade;
CREATE INDEX "ticket_repositories_ticket_id_idx" ON "ticket_repositories" ("ticket_id");
```
VERIFICA i nomi reali di vincoli/indici (`tickets_repository_id_*`, l'unique del
fingerprint su error_groups) prima di scrivere il SQL; droppa esplicitamente gli indici
di `tickets` che nominano `repository_id`. Allinea snapshot/journal (drizzle-kit generate
→ "No schema changes").

**Shared:** aggiorna `repositorySchema` (rimuovi `ingestionKey`/`nextTicketNumber`),
`projectSchema` (aggiungi `ingestionKey`, `nextTicketNumber` se esposto), `ticketSchema`
(rimuovi `repositoryId`, aggiungi lo stato per-repo se serve nel tipo pubblico), nuovo
`ticketRepositorySchema`.

**Verifiche:** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/db typecheck && pnpm --filter @stubwise/db test && pnpm --filter @stubwise/db exec drizzle-kit generate` (No schema changes).
**Test:** migrazione applica pulita; ogni progetto ha ingestion_key + next_ticket_number
migrati; error_groups hanno project_id; ticket senza repository_id; unique fingerprint
per progetto funziona; ticket_repositories con vincoli.
**Commit:** `feat(db): modello fix multi-repo (0035) — ticket_repositories, numerazione e ingestion di progetto`.

---

## Sotto-fase 3-2 — Worker: agente unico su cartella progetto + PR multiple

### Task 2: MirrorManager — worktree multipli sotto una root

**Files:** `apps/worker/src/git/mirrors.ts`, test relativi.

- Aggiungi `withProjectWorktrees(repos: {project: MirrorProject}[], branchName, fn)`:
  crea una parent dir (`mkdtemp` `stubwise-proj-`), per ogni repo apre un worktree in
  `<parent>/<repoSlug>/` (riusa `openWorktree`/i primitivi esistenti) su `switch -C
  <branchName>`; passa `{ parentDir, worktrees: [{repo, dir}] }` a `fn`; in `finally`
  rimuove TUTTI i worktree + la parent dir (idempotente). Documenta l'invariante: la
  serializzazione per-progetto (Task 3) garantisce nessun `fetch --prune` concorrente.
- `pushBranch` invariato (per-repo, dentro `fn`).

**Test:** materializza N worktree sotto una root (repo diversi), ognuno sul branch;
cleanup rimuove tutto; un fallimento a metà setup smonta il parziale.
**Verifiche:** `pnpm --filter @stubwise/worker typecheck && test` (parziale: il resto del
worker non compila ancora). Se serve `pnpm -r build` prima.
**Commit:** `feat(worker): withProjectWorktrees — worktree multipli per progetto`.

### Task 3: claim/serializzazione per-progetto + runFix sul progetto + PR multiple

**Files:** `apps/worker/src/queue.ts`, `handler.ts`, `pipeline/fix.ts`,
`pipeline/prompts.ts`, `apps/worker/src/docs/**` (esclusione allargata), test.

- **Claim** (`queue.ts`): il claim del fix escludeva `tickets.repository_id NOT IN (repo
  attivi)`. Ora la mutua esclusione è **per-progetto**: un progetto con un fix o una
  generazione docs attivi su un suo repo esclude nuovi fix del progetto. Rielabora
  `excludeRepositoryIds` → logica per-progetto (deriva i progetti "occupati" dai repo
  con worktree attivo). Rinomina l'opzione `runWorker` coerentemente.
- **Serializer** (`handler.ts`): la catena di serializzazione passa da `repositoryId` a
  `projectId` (`createRepositorySerializer` → `createProjectSerializer`). Il claim
  risolve `tickets.projectId` (+ nome progetto per le notifiche) invece del repo.
- **`runFix`** (`fix.ts`): risolve il **progetto** dal ticket; carica TUTTI i repo del
  progetto (`repositories where projectId` + gitAccounts); `withProjectWorktrees` per
  montarli sotto una root; materializza env-files **per ogni repo** nel proprio worktree;
  esegue **un** agente `claude` con `cwd = parentDir` (piano Opus → esecuzione Sonnet,
  come oggi, ma sulla root del progetto). Dopo l'agente: per ogni repo con `git status`
  sporco → commit + `pushBranch` + `openPullRequest` via il provider di quel repo →
  inserisci riga `ticketRepositories` (branch/prUrl/prState=open). Nessun repo modificato
  → esito "nessuna modifica" (riusa NoChangesError). Stato ticket → `in_review` quando
  almeno una PR è aperta.
- **Prompt** (`prompts.ts`): elenca i repo del progetto come sottocartelle
  (`./<repoSlug>/`) e istruisci l'agente a modificare solo quelle necessarie; niente RAG
  (D4). Cornice del ticket invariata.
- **Esclusione docs** (`apps/worker/src/docs/**`): il registry dei worktree di
  generazione e il claim dei nodi vanno resi coerenti con l'esclusione per-progetto (un
  fix di progetto blocca le generazioni dei suoi repo e viceversa).
- **Budget/usage**: invariato (per ticket via job).

**Test:** il fix risolve il progetto e monta tutti i repo; l'agente gira sulla root; PR
aperte solo per i repo con diff (mock provider); `ticketRepositories` popolata; progetto
a 1 repo → comportamento identico a oggi (una PR); serializzazione per-progetto (due
ticket dello stesso progetto non concorrenti; progetti diversi in parallelo); esclusione
fix↔generazione per-progetto.
**Verifiche:** `pnpm -r build && pnpm --filter @stubwise/worker typecheck && test && eslint src`.
**Commit:** `feat(worker): fix su cartella progetto con agente unico e PR multiple`.

---

## Sotto-fase 3-3 — Server: ingest di progetto, create, webhook aggregato

### Task 4: ingest SDK/feedback per progetto + create ticket

**Files:** `apps/server/src/routes/ingest.ts`, `inbound.ts`, `ingest/processor.ts`,
`apps/server/src/db/tickets.ts`, mapper ticket, test.

- **Ingest** (`ingest.ts`/`inbound.ts`/`processor.ts`): risolvi un **progetto**
  dall'`ingestionKey` (ora su `projects`); `errorGroups` per progetto; il ticket generato
  ha solo `projectId` (niente `repositoryId`).
- **createTicket** (`db/tickets.ts`): numero da `projects.next_ticket_number` (row-lock
  sul progetto); niente `repositoryId`. Rimuovi `ProjectNotFoundError` residuo o
  aggiornalo.
- **Mapper ticket**: rimuovi `repositoryId`; aggiungi lo stato per-repo (le righe
  `ticketRepositories` con prState + prUrl), lette in join.
- Route env-files (`/api/repositories/:id/env-files`) invariate (env-files restano per-repo).

**Test:** ingest con ingestionKey → errorGroup + ticket sul progetto (no repositoryId);
create ticket numera dal progetto; mapper espone lo stato per-repo.
**Verifiche:** `pnpm --filter @stubwise/server typecheck && test && eslint src`.
**Commit:** `feat(server): ingest e create ticket a livello di progetto`.

### Task 5: webhook git con chiusura aggregata

**Files:** `apps/server/src/routes/webhooks.ts`, test.

- Webhook resta per-repo (slug + `webhookSecret`). Da `stubwise/ticket-N` estrai N e
  risolvi il ticket per `(progetto del repo del webhook, N)`.
- **merged**: marca la riga `ticketRepositories` di quel repo `merged` (idempotente); il
  job → `pr_merged`; porta il ticket a `done` **solo se TUTTE** le righe del ticket sono
  `merged`, altrimenti resta `in_review`.
- **closed_unmerged**: quella riga → `closed_unmerged`; il ticket rientra in lavorazione
  per quel repo (non tocca gli altri).

**Test:** due repo, ticket con 2 PR: merge del primo → ticket resta `in_review`; merge del
secondo → `done`. closed_unmerged di uno non chiude gli altri. Numero univoco per
progetto → `(progetto, N)` risolve senza ambiguità.
**Verifiche:** `pnpm --filter @stubwise/server typecheck && test && eslint src`.
**Commit:** `feat(server): webhook con chiusura aggregata del ticket multi-repo`.

---

## Sotto-fase 3-4 — Web: stato PR per-repo nel ticket

### Task 6: UI ticket con sezione Repository/PR + client

**Files:** `apps/web/src/lib/api.ts`, `queries.ts`, componenti ticket detail/board/lista,
new-ticket-dialog, i18n, test (+E2E).

- Tipi client: `Ticket` senza `repositoryId`, con lo stato per-repo (`ticketRepositories`:
  repositoryName/slug, prState, prUrl). New-ticket dialog: **rimuovi** la selezione repo
  bersaglio (l'AI decide) — resta solo il progetto.
- **Dettaglio ticket**: nuova sezione **"Repository / PR"** che elenca i repo toccati con
  stato (`open/merged/closed_unmerged`) e link alla PR; vuota prima dell'esecuzione.
- **Board/lista**: badge col numero di repo toccati / PR aperte.
- i18n it/en per le nuove label; rimuovi le label del repo-bersaglio nel nuovo-ticket.
- Aggiorna fixture/mock (Ticket senza repositoryId, con ticketRepositories). E2E:
  aggiorna il flusso nuovo-ticket (niente repo bersaglio) e verifica la sezione PR.

**Verifiche:** `pnpm -r build && pnpm --filter @stubwise/web typecheck && test && eslint src`,
poi FULL-REPO `pnpm typecheck && pnpm lint` (deve tornare TUTTO verde).
**Commit:** `feat(web): stato PR per-repo nel dettaglio ticket; niente selezione repo`.

---

## Sotto-fase 3-5 — Verifica finale + review + consegna

### Task 7: verifica full-repo + review olistico

- `pnpm -r build && pnpm typecheck && pnpm lint`, poi `pnpm test` (tutti i package).
- Dispatch review olistico cross-layer (come Fasi 1–2): coerenza end-to-end (ingest→ticket
  di progetto; fix multi-worktree→PR multiple→ticketRepositories; webhook aggregato→done);
  serializzazione per-progetto; nessun leftover `tickets.repositoryId`/`ingestionKey` sul
  repo; migrazione 0035 senza drift; invarianti env-files/mirror preservate.
- REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (NON deployare: il deploy
  lo lancia l'utente — migrazione strutturale, backup DB prima; riverificare il webhook
  git lato provider). Lasciare il branch pronto e riepilogare.

---

## Note per l'esecuzione

- Ordine rigido: 3-1 → 3-2 → 3-3 → 3-4 → 3-5. Il full-repo torna verde solo a fine 3-4.
- Migrazione 0035 **a mano**, data-preserving; verifica i nomi reali di vincoli/indici.
- La serializzazione per-progetto è il punto delicato: testare che un progetto multi-repo
  non abbia fix concorrenti e che l'esclusione con le generazioni docs sia coerente.
- Deploy demandato all'utente (server + worker + caddy; backup DB prima).
