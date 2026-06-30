# Progetti multi-repository — Fase 1 — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Introdurre il modello a due livelli (Repository = repo; Progetto =
gruppo 1:N), rinominando l'attuale `projects` → `repositories` e creando una nuova
entità `projects`. Migrazione 1:1 (ogni repo → un progetto-wrapper). Fix e Docs
restano per-repository: **zero regressioni di comportamento**. Design:
`docs/plans/2026-06-30-multi-repo-projects-design.md`.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, worker, React+TanStack, Vitest.

**ATTENZIONE:** è una migrazione strutturale che rinomina ~12 tabelle e tocca ~84
file. La rinomina dello schema (Task 1) ROMPE il typecheck dell'intero repo finché
i task successivi non aggiornano i riferimenti — è atteso. Eseguire i task in
ordine; il verde full-repo arriva al Task 6.

---

## Task 1: DB — schema + migrazione (rename + nuova entità + classificazione)

**Files:** `packages/db/src/schema.ts`, `packages/shared/src/schemas/*`, migrazione 0033 (scritta a MANO).

**Step 1 — schema.ts.**
- Rinomina la tabella `projects` → `repositories` (export const `projects` →
  `repositories`, `pgTable("projects")` → `pgTable("repositories")`). Aggiungi
  `projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" })`.
  RIMUOVI da `repositories` i campi `aiProviderId` e `docAutoUpdate` (salgono al progetto).
- Crea la NUOVA tabella `projects`: `id` uuid PK, `name` text, `slug` text unique,
  `description` text nullable, `aiProviderId` uuid FK aiProviders set null,
  `docAutoUpdate` boolean default false, `createdAt`.
- Tabelle product-level — `tickets`, `milestones`: rinomina la colonna FK da
  `project_id`/`projectId` (→ `repositories`) in `repository_id`/`repositoryId`,
  e AGGIUNGI `projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" })`.
  Per `tickets`, `repositoryId` deve essere **nullable** (Fase 3 lo rende
  opzionale/multiplo) — in Fase 1 è sempre valorizzato ma la colonna è nullable.
- Tabelle repository-level — `errorGroups`, `projectEnvFiles` (rinominabile in
  `repositoryEnvFiles`), `docGenerations`, `docGenerationJobs`, `docAutoUpdateJobs`,
  `docPages`, `docChunks`, `docNodes`, `docChatSessions`, `docSearchHistory`:
  rinomina la colonna `project_id`/`projectId` → `repository_id`/`repositoryId`
  (FK ora → `repositories`). Aggiorna indici/unique che la nominano.
- Aggiorna TUTTI i riferimenti incrociati nello schema (es. `currentDocGenerationId`
  resta su repositories; indici che nominano project_id).

**Step 2 — shared.** In `packages/shared/src/schemas/` aggiorna/aggiungi gli schemi
Zod: rinomina `projectSchema` (l'attuale, = repository) in `repositorySchema` (+
`projectId`), crea `projectSchema` per il gruppo, e gli schemi di create/update
correlati. Mantieni esportazioni coerenti.

**Step 3 — migrazione 0033 (a MANO, NON solo drizzle-kit).** drizzle-kit genererà
DROP/ADD; per una migrazione di questa portata scrivi il SQL a mano (preservando i
dati), poi allinea snapshot/journal (o usa `drizzle-kit generate` per lo scaffold e
RISCRIVI il body). Il SQL deve, nell'ordine:
1. `ALTER TABLE "projects" RENAME TO "repositories";` (+ rename di indici/constraint
   che nominano "projects", best-effort/cosmetico).
2. `CREATE TABLE "projects" (...)` (la nuova entità gruppo).
3. `ALTER TABLE "repositories" ADD COLUMN "project_id" uuid;` (nullable temporaneo).
4. Per ogni repository, crea un progetto wrapper e collega:
   `INSERT INTO projects (id, name, slug, ai_provider_id, doc_auto_update, created_at)
    SELECT gen_random_uuid(), r.name, r.slug, r.ai_provider_id, r.doc_auto_update, now() FROM repositories r;`
   — ma serve mappare repo→progetto. Approccio sicuro: usa lo STESSO id per il
   progetto e il repo NON è possibile (collisione FK). Soluzione deterministica:
   ```sql
   WITH new_projects AS (
     INSERT INTO projects (id, name, slug, ai_provider_id, doc_auto_update, created_at)
     SELECT gen_random_uuid(), r.name, r.slug, r.ai_provider_id, r.doc_auto_update, now()
     FROM repositories r
     RETURNING id, slug
   )
   UPDATE repositories r SET project_id = np.id FROM new_projects np WHERE np.slug = r.slug;
   ```
   (Assumendo `repositories.slug` unico — lo è. Se due repo avessero lo stesso nome
   lo slug resta unico, quindi il join su slug è 1:1.)
5. `ALTER TABLE "repositories" ALTER COLUMN "project_id" SET NOT NULL;`
   `ALTER TABLE "repositories" ADD CONSTRAINT ... FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE cascade;`
6. `ALTER TABLE "repositories" DROP COLUMN "ai_provider_id"; DROP COLUMN "doc_auto_update";`
7. Tabelle repository-level: `ALTER TABLE <t> RENAME COLUMN "project_id" TO "repository_id";`
   (la FK punta già a repositories dopo il rename della tabella). Per `project_env_files`,
   eventuale `RENAME TO repository_env_files`.
8. `tickets`/`milestones`: `RENAME COLUMN project_id TO repository_id`; poi
   `ADD COLUMN project_id uuid;` e popola dal wrapper:
   `UPDATE tickets t SET project_id = r.project_id FROM repositories r WHERE r.id = t.repository_id;`
   (idem milestones); poi `SET NOT NULL` + FK a projects (cascade). Per `tickets`,
   `repository_id` resta NULLABLE (ma valorizzato).
Verifica integrità: ogni repository ha `project_id`; ogni ticket/milestone ha
`project_id`; nessun orfano.

**Step 4.** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/db typecheck && build`.
**Commit:** `feat(db): modello a due livelli repository/progetto + migrazione 0033`.

---

## Task 2: Server — route repositories (rinominate) + nuove route projects

**Files:** `apps/server/src/routes/*` (projects.ts → repositories.ts + nuova projects.ts), `app.ts`, mapper, test.

- Rinomina l'attuale `routes/projects.ts` (gestione repo) → `routes/repositories.ts`,
  esposto su `/api/repositories`: comportamento INVARIATO (git account, branch,
  webhook config, env-files, generazione/auto-update docs, ecc.), ma il mapper ora
  espone `projectId` e NON più `aiProviderId`/`docAutoUpdate` (saliti al progetto).
- Nuova `routes/projects.ts` su `/api/projects` (CRUD gruppi): lista, dettaglio
  (con elenco repository), crea (nome → crea il progetto; opz. crea/assegna repo),
  update (`name`, `description`, `aiProviderId` validato, `docAutoUpdate`), delete.
- Sposta su `/api/projects/:projectId/...` le risorse product-level: aggiorna le
  route `tickets`/`milestones`/`saved-views`/`board` perché `:projectId` sia il
  GRUPPO; la creazione ticket accetta e valida `repositoryId` (deve appartenere al
  progetto). Aggiorna i mapper/risposte.
- Le route docs restano funzionali ma sotto `/api/repositories/:repositoryId/docs/...`.
- Registra le nuove route in `app.ts`.
- Test: nuove route projects (CRUD); repositories invariate; ticket con
  `projectId`+`repositoryId` (repo non del progetto → 400); milestones project-level.

**Verifiche:** `pnpm --filter @stubwise/server typecheck && test && pnpm lint`.
**Commit:** `feat(server): route /api/projects (gruppi) e /api/repositories`.

---

## Task 3: Server — webhook, ingest, docs-chat per-repository

**Files:** `apps/server/src/routes/webhooks.ts`, `inbound.ts`/ingest, `docs.ts`, slack.

- Webhook git: `/webhooks/git/:repositorySlug` (risolve un repository; push →
  auto-update docs del repo; merge PR → chiude il ticket del progetto la cui branch
  è del repo — il ticket è risolto via `repository_id` + numero).
- Ingest errori (`ingestionKey` per-repo): risolve un repository; gli errorGroups
  sono del repo (e i ticket generati appartengono al progetto del repo, con
  `repositoryId` = quel repo).
- Slack `/docs`: il selettore elenca i repository (con documentazione); la query RAG
  è sul repository.
- Test relativi.

**Verifiche:** `pnpm --filter @stubwise/server typecheck && test && pnpm lint`.
**Commit:** `feat(server): webhook/ingest/slack su repository`.

---

## Task 4: Worker — fix sul tickets.repositoryId; docs/auto-update per repository

**Files:** `apps/worker/src/handler.ts`, `apps/worker/src/docs/*`, `mirrors`/queue.

- Fix dei ticket: il claim e `processJob` ora risolvono il **repository bersaglio**
  dal ticket (`tickets.repositoryId` → repository: repoUrl/defaultBranch/webhookSecret/
  gitAccount/ingestion) invece dal "progetto". Il provider AI è del PROGETTO del
  repository (`projects.aiProviderId` via il repo). Comportamento del fix invariato
  (un repo, un worktree, una PR).
- Docs (generazione, auto-update, dispatch nodi, finalize, embed): scoping per
  `repositoryId` (rename dei riferimenti `projectId` → `repositoryId`). Il provider
  AI risolto dal progetto del repository.
- I serializer per-progetto del worker diventano per-**repository** (la mutua
  esclusione sul mirror è per repo).
- Test: fix sul repository del ticket; docs/auto-update sul repository; provider dal
  progetto; comportamento invariato.

**Verifiche:** `pnpm --filter @stubwise/worker typecheck && test && pnpm lint`.
**Commit:** `feat(worker): fix e docs scoped al repository; provider dal progetto`.

---

## Task 5: Web — sezione Progetti, repository sotto progetto, ticket project-level

**Files:** `apps/web/src/lib/api.ts`, `queries.ts`, route/`components` progetti/repo/ticket/board/docs, i18n, test.

- Tipi client: `Repository` (ex `Project`, + `projectId`), nuovo `Project` (gruppo,
  con `aiProviderId`/`docAutoUpdate`/repos). `generateDocs`/docs ora per repository.
- **Sezione Progetti**: lista gruppi → dettaglio progetto (lista repository +
  impostazioni progetto: provider AI, auto-update). CRUD progetto.
- **Repository**: la UI attuale del "progetto" (setup git, branch, webhook, env-files,
  pannello Docs) spostata sotto il repository, raggiunta dal progetto.
- **Ticket/board/milestone/viste**: a livello progetto. Il dialog "Nuovo ticket"
  sceglie progetto + **repository bersaglio** (dropdown dei repo del progetto). La
  board/lista mostra il repo bersaglio (badge). I link e i filtri usano il progetto.
- **Docs hub** `/docs`: elenca gli spazi per repository (sotto il progetto).
- i18n (it/en) per le nuove label (Progetto/Repository, repository bersaglio, ecc.).
- Aggiorna TUTTE le fixture/test che usano il vecchio `Project`=repo.

**Verifiche:** `pnpm --filter @stubwise/web typecheck && test && pnpm lint`.
**Commit:** `feat(web): sezione Progetti, repository sotto progetto, ticket con repo bersaglio`.

---

## Task 6: Verifica finale + deploy

**Step 1.** `pnpm typecheck && pnpm lint`, poi i test per-package (db/server/worker/web).
**Step 2.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (merge su main).
**Step 3.** **BACKUP DB del prod PRIMA del deploy** (migrazione strutturale). Poi
deploy `server` (migrazione 0033 + route) + `worker` + `caddy` (UI), a generazioni
ferme. Verifica: tabelle (`repositories` con `project_id`, nuova `projects`,
`tickets` con `project_id`+`repository_id`), ogni repo ha un progetto, health, UI.
**Step 4 — verifica reale**: i progetti esistenti compaiono come progetti-wrapper
coi loro repo; ticket/docs/fix funzionano come prima.

---

## Note trasversali

- **Zero regressioni**: il comportamento di fix e docs è identico (solo nomi/scoping
  cambiano). La migrazione 1:1 garantisce che tutto resti dov'è.
- **Migrazione a mano**: il SQL deve preservare i dati (rename + UPDATE
  deterministici), non drop+add. Verifica integrità a fine migrazione.
- **Backup DB**: obbligatorio prima del deploy (migrazione strutturale).
- **Compatibilità Fase 2/3**: `tickets.repositoryId` nullable; docs per-repo sotto
  il progetto.
