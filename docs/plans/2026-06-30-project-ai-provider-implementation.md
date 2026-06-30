# Provider AI a livello di progetto — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Un solo campo `projects.aiProviderId` che vale per generazione Docs
(manuale + auto-update) e fix dei ticket; strict (niente failover) quando
impostato; default `null` = comportamento attuale (catena/failover). Vedi design:
`docs/plans/2026-06-30-project-ai-provider-design.md`.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, worker, React+TanStack, Vitest.

---

## Task 1: Migrazione + schema + shared

**Files:** `packages/db/src/schema.ts`, `packages/shared/src/schemas/project.ts`, migrazione 0032.

**Step 1 — schema.ts.**
- In `projects`: rinomina la colonna `docAutoUpdateProviderId` (`doc_auto_update_provider_id`) → `aiProviderId` (`ai_provider_id`). Mantieni FK `aiProviders` `onDelete: "set null"`. Aggiorna il commento.
- In `docGenerationJobs`: RIMUOVI `pinnedProviderId` (`pinned_provider_id`).
- NON toccare `docGenerations.pinnedProviderId` (resta lo snapshot).

**Step 2 — shared.** In `packages/shared/src/schemas/project.ts` rinomina `docAutoUpdateProviderId` → `aiProviderId` (nello schema risposta e nello schema di update, se presenti).

**Step 3 — migrazione.** `pnpm --filter @stubwise/db exec drizzle-kit generate`. ATTENZIONE: drizzle-kit in non-interattivo può generare un DROP+ADD invece di un RENAME (perdendo i dati esistenti di `doc_auto_update_provider_id`). VERIFICA il SQL: deve essere
`ALTER TABLE "projects" RENAME COLUMN "doc_auto_update_provider_id" TO "ai_provider_id";`
(+ eventuale rename del constraint FK, cosmetico) e
`ALTER TABLE "doc_generation_jobs" DROP COLUMN "pinned_provider_id";`.
Se genera drop+add della colonna projects, RISCRIVI a mano il file di migrazione col `RENAME COLUMN` per preservare i dati. La drop della colonna job va bene così.

**Step 4.** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/db typecheck && pnpm --filter @stubwise/db build`.
**Commit:** `feat(db): projects.aiProviderId (rinomina) + drop doc_generation_jobs.pinnedProviderId`.

---

## Task 2: Worker — fix dei ticket usano project.aiProviderId (strict)

**Files:** `apps/worker/src/handler.ts` + test.

**Contesto:** `processJob(deps, job, projectName, ticketId)` (~riga 165-213) carica la catena (`loadProviderChain`) e itera con FAILOVER: `runJobWithProvider` ritorna `true` se "limit" → prova il prossimo; esauriti tutti → `holdAllProvidersLimited`. Il claim (~riga 277) fa `select projectId, projectName from tickets join projects`. C'è già `loadProviderById` in `apps/worker/src/providers/chain.ts`.

**Step 1.** Estendi la select del claim (riga 277) per leggere anche `aiProviderId: projects.aiProviderId`; passa `aiProviderId` a `processJob` (nuovo parametro).

**Step 2.** In `processJob`: se `aiProviderId` è impostato:
- risolvi UN provider: `loadProviderById(deps.db, deps.encryptionKey, aiProviderId)` (dep iniettabile `loadProviderByIdFn?` come fanno gli altri handler).
- se `null` (disabilitato/cancellato) → metti il job in `held` con messaggio chiaro ("provider AI del progetto non disponibile, job in pausa") e termina, NIENTE failover/catena. (Riusa `holdJob`/il pattern di `holdAllProvidersLimited` adattando il messaggio; oppure una nuova piccola funzione `holdPinnedProviderUnavailable`.)
- altrimenti esegui UN solo tentativo `runJobWithProvider(deps, job, notifyOpts, provider)`; se ritorna `true` (limit) → `held` con messaggio "provider AI del progetto al limite, job in pausa, ritenta dopo il reset" (niente failover). Se `false` → terminato (success/failed gestito come oggi).
Se `aiProviderId` è `null` → comportamento ATTUALE invariato (catena + failover, held se esauriti).

**Step 3 — test:** `aiProviderId` impostato → `loadProviderByIdFn` chiamato col giusto id, il run usa quel provider, `loadProviderChainFn` MAI invocata; esito "limit" → job `held` (no failover); provider non risolvibile → job `held` con messaggio, runner non invocato; `aiProviderId` null → catena con failover (regressione: i test esistenti del failover restano verdi). Riusa i fake/iniezioni dei test handler esistenti.

**Verifiche:** `pnpm --filter @stubwise/worker typecheck && test handler && pnpm lint`.
**Commit:** `feat(worker): i fix usano il provider del progetto (strict, niente failover)`.

---

## Task 3: Worker — docs trigger + auto-update da project.aiProviderId

**Files:** `apps/worker/src/docs/handler.ts`, `apps/worker/src/docs/auto-update.ts` + i loro test.

**Step 1 — docs trigger (`docs/handler.ts` `createDocHandler`).** Oggi legge `job.pinnedProviderId` (colonna eliminata in Task 1). Sostituisci: carica `project.aiProviderId` (una select su `projects` per `job.projectId`). Risolvi strict (riusa la logica esistente: `loadProviderById`; impostato ma non risolvibile → fallisci la generazione con `failDocJob`, niente fallback) e passa `pinnedProviderId: aiProviderId ?? undefined` a `runOrientation` (che semina `doc_generations.pinned_provider_id`, INVARIATO). `node-dispatch`/`orient-handler` restano invariati.

**Step 2 — auto-update (`docs/auto-update.ts`).** Rinomina ovunque `docAutoUpdateProviderId` → `aiProviderId` (in `loadProjectContext` e `resolveProvider`). Logica strict invariata.

**Step 3 — test.** `handler.test`/`dispatch.test`/`auto-update.test`: il trigger semina `doc_generations.pinned_provider_id` da `project.aiProviderId`; provider non risolvibile → generazione `failed` (no fallback); `aiProviderId` null → chain[0]. auto-update: rename + comportamento invariato. Aggiorna i test che impostavano `job.pinnedProviderId` (colonna rimossa) a impostare invece `projects.aiProviderId`.

**Verifiche:** `pnpm --filter @stubwise/worker typecheck && test docs && pnpm lint`.
**Commit:** `feat(worker): generazione Docs eredita il provider del progetto`.

---

## Task 4: Server — generate senza providerId, update progetto con aiProviderId

**Files:** `apps/server/src/routes/docs.ts`, `apps/server/src/routes/projects.ts` + test.

**Step 1 — generate (`docs.ts`).** Rimuovi dal `POST /projects/:projectId/docs/generate` il body `providerId` (e la sua validazione) e la scrittura di `pinnedProviderId` nell'insert del job (colonna eliminata). Il job si crea senza pin; il worker userà `project.aiProviderId`. Lascia invariato `GET /docs/status` (espone ancora `pinnedProvider` della generazione corrente da `doc_generations.pinned_provider_id`).

**Step 2 — update progetto (`projects.ts`).** Rinomina `docAutoUpdateProviderId` → `aiProviderId` nello schema body di update e nella risposta (`toPublicProject`). Validazione: se presente e non null, il provider deve esistere (come ora), altrimenti 400; null = azzera.

**Step 3 — test.** `projects.test`: update con `aiProviderId` valido persiste/torna; inesistente → 400; null azzera. `docs.test`: `generate` senza `providerId` crea il job (niente pin); generate NON accetta più `providerId` (se passato, ignorato o rifiutato — coerente con lo schema). `status` ritorna `pinnedProvider` quando la generazione corrente è pinnata.

**Verifiche:** `pnpm --filter @stubwise/server typecheck && test docs && test projects && pnpm lint`.
**Commit:** `feat(server): generate senza providerId; update progetto con aiProviderId`.

---

## Task 5: Web — selettore provider nelle impostazioni progetto, rimosso dal pannello

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/lib/docs-api.ts`, `apps/web/src/components/project-form.tsx`, `apps/web/src/components/docs-generation-panel.tsx`, `apps/web/src/routes/projects/$slug.tsx`, i18n; + i test e le fixture che usano `docAutoUpdateProviderId`.

**Step 1 — tipi client (`api.ts`).** Rinomina in `Project`/`ProjectPatch` `docAutoUpdateProviderId` → `aiProviderId`.

**Step 2 — form progetto (`project-form.tsx`).** Il selettore provider (oggi legato all'auto-update) diventa **generale**: label "Provider AI del progetto" (i18n), mostrato SEMPRE nel form (admin), opzione vuota = "Automatico (catena con failover)", legato ad `aiProviderId`, inviato nel PATCH. NON dipende più dal toggle auto-update (che resta un campo separato e indipendente). Riusa `aiProvidersQueryOptions`/`listAiProviders`.

**Step 3 — pannello generazione (`docs-generation-panel.tsx`).** RIMUOVI il selettore di provider e il relativo stato; `generateDocs(projectId)` (senza providerId). Lascia la riga di stato `Provider: <label>` (da `status.pinnedProvider`).

**Step 4 — docs-api.** `generateDocs(projectId)` senza il parametro `providerId`. `DocStatus.pinnedProvider` invariato.

**Step 5 — fixture/test.** Aggiorna le fixture `Project` che usano `docAutoUpdateProviderId` → `aiProviderId` (in `project-form.test`, `projects.test`, `new-ticket-dialog.test`, `project-wizard.test`, `ticket-filters.test`). Aggiorna i test del pannello (niente selettore) e del form (selettore generale sempre visibile, invia `aiProviderId`). i18n: chiavi rinominate/aggiunte, parità it/en.

**Verifiche:** `pnpm --filter @stubwise/web typecheck && test && pnpm lint`.
**Commit:** `feat(web): provider AI nelle impostazioni progetto; rimosso dal pannello Docs`.

---

## Task 6: Verifica finale + deploy

**Step 1.** `pnpm typecheck && pnpm lint`, poi i test per-package (db/server/worker/web; testcontainers per-package).
**Step 2.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (merge su main).
**Step 3.** Deploy: `server` (migrazione 0032 + endpoint) + `worker` (logica provider) + `caddy` (UI). Worker a generazioni ferme (fail-on-restart). Verifica colonne (rename applicato, drop applicato), health, bundle.

---

## Note trasversali

- **Default invariato**: `aiProviderId` null → Docs `chain[0]`, fix catena+failover. Zero regressioni.
- **Strict**: provider impostato → SOLO quello, mai fallback (Docs falliscono / fix held se non disponibile o al limite).
- **Snapshot**: la generazione fotografa il provider al lancio (`doc_generations.pinned_provider_id`), il resto del worker invariato.
- **Migrazione**: RENAME (preserva i dati), non drop+add. Verifica il SQL generato.
