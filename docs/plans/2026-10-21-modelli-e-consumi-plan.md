# Modelli per tipo di lavoro e consumi di token — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** l'admin sceglie da Impostazioni → Automazione il modello Anthropic di ogni tipo di lavoro AI, e ogni consumo di token (worker e server) finisce in `agent_runs`, raggruppabile in Utilizzo per operazione, progetto, modello e giorno.

**Architecture:** un catalogo condiviso delle operazioni e dei modelli in `@stubwise/shared`. Nel worker un **decoratore dell'`AgentRunner`** (`TrackingAgentRunner`) fa da solo le due cose per ogni run: sostituisce il modello con quello salvato in `ai_model_settings` (se c'è) e registra i consumi in `agent_runs`. Ogni chiamata a `runner.run` DEVE dichiarare un `usage` tag (campo obbligatorio): è il compilatore a garantire che nessun consumo sfugga. Sul server la `ChatLlm` fa lo stesso per le chat via SDK.

**Tech Stack:** TypeScript, Drizzle + Postgres, Fastify + Zod, React + TanStack Query, Vitest (testcontainers).

**Spec:** `docs/plans/2026-10-21-modelli-e-consumi-design.md`

## Global Constraints

- Solo modelli Anthropic. Nessuna scelta dell'account per operazione, nessun override per progetto.
- Precedenza del modello: `ai_model_settings` → env attuale del worker → default nel codice.
- Un cambio vale dalla prossima esecuzione, **senza riavvio del worker**; una generazione Docs tiene il modello con cui è partita (`doc_generations.model`).
- Registrazione dei consumi **best-effort**: un errore d'insert non fa mai fallire un lavoro.
- Nessun consumo registrato due volte.
- Il budget mensile (`monthlyCostUsd`) conta **tutte** le righe: nessun filtro per operazione.
- `phase = 'email_classify'` marca SOLO la classificazione della posta.
- Migrazioni: testo + CHECK, mai `ALTER TYPE ... ADD VALUE` (vedi `CLAUDE.md`, «il batch gira in UNA transazione»).
- Web: ogni campo nuovo letto dalla SPA va difeso nel punto di lettura (`?? 0`, `?? []`) e la fixture del test lo omette apposta (`CLAUDE.md`).
- Testi UI in it + en (`apps/web/src/i18n/locales/{it,en}.json`).
- Prima del merge: `pnpm typecheck && pnpm lint && pnpm test`.

## Review Focus

1. **Un run senza tag o con un tag sbagliato** (es. un riassunto marcato `fix_execute`): i numeri del confronto sarebbero falsi in silenzio. → Task 3 rende il tag obbligatorio; Task 4–6 hanno un test per call site che asserisce `operation` sulla riga scritta.
2. **Un consumo contato due volte**: i writer espliciti (triage, fix, correzione, review, posta) scrivono già in `agent_runs`; se passano anche dal decoratore con `record: true` la riga raddoppia. → Task 4: test «un fix produce UNA riga per modello per run».
3. **Un valore in `ai_model_settings` che il CLI o l'API non conoscono** (lista cambiata in un deploy successivo, riga vecchia). → Task 3: un valore fuori dal catalogo viene ignorato (si usa il default) con una riga di log; Task 8 idem per la chat.
4. **Un'impostazione cambiata a metà di una generazione Docs**: le fasi successive non devono cambiare modello. → Task 6, test dedicato.
5. **Righe vecchie** (prima della migrazione: `operation` backfillata, `run_id` nullo, `project_id` nullo) nelle aggregazioni: niente crash, conteggio esecuzioni = 1 per riga. → Task 2 (backfill) e Task 9 (test con righe legacy).

---

### Task 1: catalogo condiviso di operazioni e modelli

**Files:**
- Create: `packages/shared/src/ai-operations.ts`
- Modify: `packages/shared/src/index.ts` (export)
- Test: `packages/shared/src/ai-operations.test.ts`

**Interfaces:**
- Produces:
  - `AI_OPERATIONS` — tuple readonly delle chiavi, in quest'ordine: `triage`, `fix_plan`, `fix_execute`, `pr_review`, `summary`, `backlog_intake`, `backlog_refine`, `commit_summary`, `release_notes`, `docs_nightly`, `docs_generation`, `daily_report`, `weekly_brief`, `mail_classify`, `chat`, `backlog_merge`, `plugin_smoke`, `credential_test`, `usage_probe`.
  - `type AiOperation = (typeof AI_OPERATIONS)[number]`; `aiOperationSchema = z.enum(AI_OPERATIONS)`.
  - `AI_OPERATION_GROUPS: { group: "tickets"|"backlog"|"nightly"|"docs"|"reports"|"mail"|"chat"|"technical"; operations: AiOperation[] }[]` — raggruppamento della UI come nel design §1; `technical` = `plugin_smoke`, `credential_test`, `usage_probe`.
  - `CONFIGURABLE_AI_OPERATIONS: AiOperation[]` = tutte tranne le tre `technical`; `isConfigurableAiOperation(op): boolean`.
  - `AI_MODEL_ALIASES = ["opus","sonnet","haiku"] as const`; `AI_MODEL_IDS = ["claude-fable-5-1","claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5","claude-opus-4-8"] as const`; `AI_MODEL_CHOICES = [...AI_MODEL_ALIASES, ...AI_MODEL_IDS]`; `aiModelChoiceSchema = z.enum(AI_MODEL_CHOICES)`.
  - `resolveApiModelId(choice: AiModelChoice): string` — alias → id più recente (`opus`→`claude-opus-5-5`, `sonnet`→`claude-sonnet-5-5`, `haiku`→`claude-haiku-5-5`), id → sé stesso. Serve all'SDK, che non accetta alias.

- [ ] **Step 1: test** — `ai-operations.test.ts`: (a) ogni operazione compare in esattamente un gruppo; (b) `CONFIGURABLE_AI_OPERATIONS` non contiene `plugin_smoke`/`credential_test`/`usage_probe` e contiene tutte le altre 16; (c) `resolveApiModelId("opus") === "claude-opus-5-5"`, `resolveApiModelId("haiku") === "claude-haiku-5-5"`, `resolveApiModelId("claude-opus-4-8") === "claude-opus-4-8"`; (d) `aiModelChoiceSchema.safeParse("opsu").success === false`.
- [ ] **Step 2:** `pnpm --filter @stubwise/shared test ai-operations` → FAIL (modulo assente).
- [ ] **Step 3:** implementa il modulo; docblock che rimanda al design e dice che aggiungere un'operazione richiede anche la migrazione del CHECK (Task 2).
- [ ] **Step 4:** test → PASS; `pnpm --filter @stubwise/shared build` (lo leggono db/server/worker dal `dist/`), poi `pnpm --filter @stubwise/shared test load-isolated` → PASS.
- [ ] **Step 5:** commit `feat(shared): catalogo delle operazioni AI e dei modelli`.

### Task 2: schema e migrazione

**Files:**
- Modify: `packages/db/src/schema.ts` (`agentRuns` ~1023, `instanceSettings` ~1312, tabella nuova accanto ad `automationRules` ~1170)
- Create: `packages/db/drizzle/0096_ai_models_and_usage.sql` (+ meta generata)
- Test: `packages/db/src/ai-usage-schema.test.ts`; aggiorna i test esistenti di `packages/db/src/cost.ts` se ne esistono

**Interfaces:**
- Consumes: `AI_OPERATIONS`, `AI_MODEL_CHOICES` (Task 1).
- Produces:
  - tabella `ai_model_settings` (`aiModelSettings`): `operation text PK`, `model text not null`, `updated_at`, `updated_by_user_id uuid null → users ON DELETE SET NULL`. CHECK su `operation in (...)` e `model in (...)` generati dal catalogo.
  - `agent_runs` (`agentRuns`) colonne nuove: `operation text not null` (CHECK sul catalogo), `project_id uuid null → projects ON DELETE SET NULL`, `provider_id uuid null → ai_providers ON DELETE SET NULL`, `run_id uuid null`, `cache_creation_tokens integer not null default 0`.
  - `agent_runs.phase` → nullable. CHECK `agent_runs_owner_check` → `num_nonnulls(job_id, pr_review_id, email_message_id) <= 1`. CHECK nuovo `agent_runs_job_phase_check`: `job_id is null or phase is not null` (i lettori per ticket, `routes/ai-jobs.ts`, si aspettano una fase sulle righe di un job).
  - indici: `(created_at)`, `(operation, created_at)`, `(project_id)`.
  - `instance_settings.worker_model_defaults jsonb null` — i default effettivi del worker (`Record<AiOperation, string>`), scritti dal worker all'avvio (Task 3).

- [ ] **Step 1: test** (`ai-usage-schema.test.ts`, Postgres di test come gli altri test del package): (a) un insert in `agent_runs` senza owner, con `operation='chat'`, `phase=null`, riesce; (b) con due owner fallisce; (c) con `job_id` e `phase=null` fallisce; (d) `operation='xxx'` fallisce; (e) `ai_model_settings` rifiuta `model='opsu'`; (f) dopo le migrazioni, una riga inserita con il vecchio schema-tipo (`phase='review'`) ha `operation='pr_review'` — fallo inserendo PRIMA dell'ultima migrazione se l'helper lo permette, altrimenti testa la sola funzione SQL di backfill con un `UPDATE` sulla stessa espressione; (g) `monthlyCostUsd` somma anche una riga senza owner con `cost_usd`.
- [ ] **Step 2:** `pnpm --filter @stubwise/db test ai-usage-schema` → FAIL.
- [ ] **Step 3:** modifica `schema.ts`, poi `pnpm --filter @stubwise/db exec drizzle-kit generate --name ai_models_and_usage`. Nel SQL generato, a mano: aggiungi `operation` prima come nullable, backfill, poi `SET NOT NULL`. Backfill: `triage`→`triage`, `review`→`pr_review`, `email_classify`→`mail_classify`, `fix`→`fix_plan` quando `model` contiene `opus`, altrimenti `fix_execute` (default di oggi: piano opus, esecuzione sonnet); `project_id` da `ai_jobs → tickets.project_id` per le righe con `job_id`, da `pr_reviews.project_id` per quelle con `pr_review_id` (verifica il nome della colonna), nullo per la posta. Commenti SQL in italiano come in `0095_pat_kind.sql`.
- [ ] **Step 4:** test → PASS; `pnpm --filter @stubwise/db build && pnpm --filter @stubwise/db test` → PASS.
- [ ] **Step 5:** commit `feat(db): agent_runs per ogni operazione AI e ai_model_settings`.

### Task 3: worker — `TrackingAgentRunner`, risoluzione del modello, `recordUsage`

**Files:**
- Modify: `apps/worker/src/agent/runner.ts` (`AgentRunOptions`, `AgentModelUsage`)
- Modify: `apps/worker/src/agent/claude-cli.ts` (`extractUsage`: `cacheCreationInputTokens`/`cache_creation_input_tokens`)
- Modify: `apps/worker/src/agent/text.ts` (`RunAgentTextOptions.usage`, inoltrato)
- Create: `apps/worker/src/agent/tracking-runner.ts`
- Create: `apps/worker/src/agent/model-settings.ts`
- Modify: `apps/worker/src/queue.ts` (`recordAgentRun` → `recordUsage`)
- Modify: `apps/worker/src/index.ts` (~212: avvolgi il runner; all'avvio scrivi `worker_model_defaults`)
- Test: `apps/worker/src/agent/tracking-runner.test.ts`, `apps/worker/src/agent/model-settings.test.ts`, `apps/worker/src/agent/claude-cli.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces:
  - `AgentModelUsage.cacheCreationTokens: number` (default 0).
  - in `runner.ts`:
    ```ts
    export interface UsageTag {
      operation: AiOperation;
      projectId: string | null;
      /** Owner facoltativo: al più uno. */
      jobId?: string; prReviewId?: string; emailMessageId?: string;
      /** Solo con jobId: fase per i lettori per-ticket. */
      phase?: "triage" | "fix" | "review" | "email_classify";
      /** false = il chiamante scrive da sé le righe (writer storici, Task 4). Default true. */
      record?: boolean;
      /** true = non sostituire opts.model (generazione Docs, Task 6). Default false. */
      modelLocked?: boolean;
    }
    ```
    e `AgentRunOptions.usage: UsageTag` **obbligatorio**. `AgentRunResult.runId?: string` (uuid generato dal decoratore, per i writer storici).
  - `model-settings.ts`: `createModelResolver(db: Db, log: Logger): ModelResolver` con `resolve(operation: AiOperation, fallback: string | undefined): Promise<string | undefined>` — legge `ai_model_settings` (una query per chiamata, nessuna cache: il cambio vale subito); valore assente → `fallback`; valore fuori da `AI_MODEL_CHOICES` → `fallback` + `log.warn`; errore DB → `fallback`.
  - `writeWorkerModelDefaults(db: Db, defaults: Record<AiOperation, string>): Promise<void>` — best-effort, UPDATE di `instance_settings.worker_model_defaults`.
  - `tracking-runner.ts`: `class TrackingAgentRunner implements AgentRunner` costruito con `{ inner: AgentRunner; db: Db; models: ModelResolver }`; `recordsSessions` delegato a `inner`. `run(opts)`: se `!opts.usage.modelLocked && isConfigurableAiOperation(op)` → `model = await models.resolve(op, opts.model)`; genera `runId`; chiama `inner.run`; se `usage.record !== false` → `recordUsage` con `providerId = opts.provider?.id ?? null`; restituisce il risultato con `runId`. Registra anche quando `inner.run` lancia **dopo** aver prodotto usage? No: senza risultato non c'è usage — documentalo nel docblock.
  - `queue.ts`: `recordUsage(db, input: { usage?: AgentRunUsage; tag: UsageTag; runId: string | null; providerId: string | null }): Promise<void>` — una riga per modello, best-effort, sostituisce `recordAgentRun` (aggiorna i suoi chiamanti in Task 4).
  - default effettivi per `worker_model_defaults`: una funzione `effectiveModelDefaults(config): Record<AiOperation, string>` in `config.ts` (mappa del design, tabella «Cosa esiste oggi»; `triage`→`"haiku"`, `chat`/`backlog_merge`→`"claude-opus-4-8"`, `weekly_brief`→`summaryModel`, tecniche→`"haiku"`).

- [ ] **Step 1: test** `tracking-runner.test.ts` (inner = `FakeAgentRunner` di `agent/fake.ts`, db di test): (a) con `ai_model_settings(fix_execute='claude-opus-5-5')` l'inner riceve `model: "claude-opus-5-5"` anche se opts dice `sonnet`; (b) senza riga riceve `sonnet`; (c) `modelLocked: true` → riceve il modello di opts anche con la riga; (d) `credential_test` non viene mai sostituito; (e) una riga `agent_runs` per modello con `operation`, `project_id`, `provider_id`, `run_id` (uguale a `result.runId`), `cache_creation_tokens`; (f) `record: false` → nessuna riga; (g) un insert che fallisce (owner doppio) non fa lanciare `run`.
- [ ] **Step 2: test** `model-settings.test.ts`: valore `'opsu'` scritto aggirando il CHECK non è possibile → testa il ramo con un resolver su un valore non in catalogo simulando la lettura (iniettando la funzione di lettura) → `fallback` + warn.
- [ ] **Step 3: test** `claude-cli.test.ts`: `extractUsage` legge `cacheCreationInputTokens` e lo snake_case; assente → 0.
- [ ] **Step 4:** run → FAIL.
- [ ] **Step 5:** implementa. Il campo obbligatorio fa fallire `pnpm --filter @stubwise/worker typecheck` su tutti i call site: è voluto, li chiudono i Task 4–5. I Task 3, 4 e 5 vanno eseguiti in sequenza sullo stesso branch e il typecheck del worker torna verde alla fine del Task 5; fino ad allora i test di ogni task girano filtrati sui propri file.
- [ ] **Step 6:** `pnpm --filter @stubwise/worker test tracking-runner model-settings claude-cli` → PASS.
- [ ] **Step 7:** commit `feat(worker): TrackingAgentRunner — modello da impostazioni e consumi per ogni run`.

### Task 4: worker — tag del percorso ticket (writer storici e riassunti)

**Files (call site dalla ricognizione):** `pipeline/triage.ts:251`, `pipeline/fix.ts` (piano ~1261 e ripresa ~1197, esecuzione ~1402, self-repair ~1451, `recordAgentRun` ~1084), `pipeline/correction.ts` (~1067, ~1097, ~890), `review/run-review.ts` (~810, insert ~367), `summaries/plan-summary.ts`, `summaries/failure-summary.ts`, `summaries/pr-summary.ts`. Test accanto a ciascuno.

**Interfaces:**
- Consumes: `UsageTag`, `recordUsage`, `AgentRunResult.runId` (Task 3).
- Mappa operazioni: triage → `triage` (phase `triage`, jobId); piano e ripresa del piano → `fix_plan` (phase `fix`); esecuzione, self-repair, correzione e suo self-repair → `fix_execute` (phase `fix`); review → `pr_review` (prReviewId, phase `review`); plan/failure summary → `summary` con il `jobId` del job e la sua phase; pr_summary → `summary` con `prReviewId`, phase `review`. `projectId` sempre valorizzato (dal ticket/repo del job).
- Writer storici (triage, fix, correzione, review): passano `record: false` e scrivono con `recordUsage` / l'insert della review, includendo `operation`, `projectId`, `providerId`, `runId: result.runId`. Il loro insert resta dove sta (la review scrive DENTRO la sua transazione: non spostarlo).
- Riassunti: `record` default (li registra il decoratore).

- [ ] **Step 1: test** — per triage, fix (piano + esecuzione), correzione, review, plan summary, pr summary: dopo il run fake con usage di 2 modelli, `agent_runs` ha esattamente 2 righe per run con l'`operation` della mappa e il `project_id` del ticket. Un test in `fix.test.ts` (o accanto) «un fix a due fasi produce righe `fix_plan` + `fix_execute`, nessun duplicato».
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** PASS (`pnpm --filter @stubwise/worker test pipeline review summaries`).
- [ ] **Step 5:** commit `feat(worker): consumi del percorso ticket con operazione e progetto`.

### Task 5: worker — tag di tutti gli altri run

**Files:** `backlog/intake.ts` (173, 230), `backlog/estimate.ts` (92), `backlog/refine/turn.ts` (455), `nightly/commit-summary.ts` (228), `nightly/release.ts` (212), `nightly/page-update.ts` (190, 297), `nightly/page-create.ts` (195), `reports/daily-report-poller.ts` (244, 470), `briefs/poller.ts` (381), `google/classify.ts` (1817, 2112, 1640; insert esistente ~434), `plugins/poller.ts` (600), `agent/credential-tester.ts` (114), `agent/usage-poller.ts` (182), `docs/*` (vedi Task 6 per il modello; qui solo il tag). Test accanto.

**Interfaces:**
- Mappa: intake+stima → `backlog_intake`; refine → `backlog_refine`; commit summary (notturno e daily report) → `commit_summary`; release → `release_notes`; page update/create → `docs_nightly`; daily report → `daily_report`; brief → `weekly_brief`; posta → `mail_classify` (writer storico: `record: false`, il suo insert aggiunge `operation`, `projectId: null` salvo progetto già attribuito, `phase: 'email_classify'` invariata); smoke → `plugin_smoke`; test credenziali → `credential_test`; poller d'uso → `usage_probe`; Docs (orient, explore, synthesize, product) → `docs_generation`. `projectId` dove il run ce l'ha, altrimenti `null`.
- Credential tester e usage poller costruiscono il proprio `ClaudeCliRunner`: avvolgilo nel `TrackingAgentRunner` (stesso db) invece di aggiungere un secondo percorso di registrazione.
- Il brief oggi usa `summaryModel`: passa `weekly_brief` con fallback `summaryModel` (nessun cambio di default).

- [ ] **Step 1: test** — uno per famiglia (backlog, notturno, daily report, brief, posta, smoke, credential test): la riga scritta ha l'`operation` della mappa. Per la posta in più: le righe NON di classificazione non hanno `phase = 'email_classify'` (il tetto giornaliero in `classify.ts` ~1934 conta solo quelle) — test sul conteggio del tetto invariato.
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** `pnpm --filter @stubwise/worker typecheck` verde (tutti i call site taggati) e `pnpm --filter @stubwise/worker test` → PASS.
- [ ] **Step 5:** commit `feat(worker): consumi di ogni run AI del worker`.

### Task 6: worker — la generazione Docs tiene il suo modello

**Files:** `apps/worker/src/docs/handler.ts` (creazione/avvio della generazione), `docs/recursive/orient-handler.ts`, `docs/recursive/node-dispatch.ts`, `docs/recursive/product-handler.ts`, `apps/worker/src/index.ts` (~303, ~326). Test: `docs/recursive/node-dispatch.test.ts` (o il test della generazione esistente).

**Interfaces:**
- All'avvio di una generazione: `model = await models.resolve("docs_generation", config.docGenerationModel)` → scritto in `doc_generations.model` (colonna esistente).
- Ogni run successivo della generazione legge `doc_generations.model` e passa `usage: { operation: "docs_generation", projectId, modelLocked: true }`. `deps.model` del dispatcher non serve più come fonte (resta solo come fallback per righe con `model` nullo, se possibile).

- [ ] **Step 1: test** — avvia una generazione con `ai_model_settings(docs_generation='claude-sonnet-5-5')`, poi cambia la riga a `haiku` e fai girare un nodo: il fake runner riceve `claude-sonnet-5-5`.
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(worker): la generazione Docs fissa il modello all'avvio`.

### Task 7: server — rotte delle impostazioni dei modelli

**Files:**
- Create: `apps/server/src/routes/model-settings.ts` (registrata accanto a `settings.ts`, prefisso `/api/settings/models`)
- Modify: `apps/server/src/app.ts` (registrazione)
- Test: `apps/server/src/routes/model-settings.test.ts`

**Interfaces:**
- `GET /api/settings/models` (`requireAdmin`) → `{ operations: { operation: AiOperation; configurable: boolean; model: AiModelChoice | null; workerDefault: string | null }[]; choices: AiModelChoice[] }` — una voce per ogni operazione del catalogo, in ordine; `workerDefault` da `instance_settings.worker_model_defaults` (null se il worker non l'ha ancora scritto).
- `PATCH /api/settings/models` (`requireAdmin`) body `{ models: Partial<Record<AiOperation, AiModelChoice | null>> }`: valore → upsert; `null` → delete (torna al predefinito); operazione non configurabile → 400; risposta = stessa forma del GET.

- [ ] **Step 1: test** — member → 403 e nessuna riga scritta; admin PATCH `{fix_execute: "claude-opus-5-5"}` → riga; PATCH `{fix_execute: null}` → riga cancellata; `{credential_test: "opus"}` → 400; `{fix_execute: "opsu"}` → 400; GET senza `worker_model_defaults` → `workerDefault: null`.
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** `pnpm --filter @stubwise/server test model-settings` PASS.
- [ ] **Step 5:** commit `feat(server): impostazioni dei modelli per operazione`.

### Task 8: server — modello e consumi delle chat

**Files:** `apps/server/src/routes/chat-llm.ts`, chiamanti di `chatLlm.stream` (`docs-chat-core.ts`, `project-docs.ts`, `widget-chat.ts`, `slack/routes.ts` via `docs-rag.ts`, `routes/backlog.ts` `collectStream`). Test: `apps/server/src/routes/chat-llm.test.ts` (nuovo) + i test delle rotte esistenti che usano il fake.

**Interfaces:**
- `ChatLlmInput.usage: { operation: "chat" | "backlog_merge"; projectId: string | null }` obbligatorio.
- `createAnthropicChatLlm`: a ogni `stream` legge `ai_model_settings` per l'operazione; valore valido → `resolveApiModelId(valore)`; assente o non valido → `options.model ?? DEFAULT_CHAT_MODEL` (default invariato). A fine stream (anche su abort) registra una riga in `agent_runs` con i token dell'evento `message_start` (input, cache read, cache creation) e dell'ultimo `message_delta` (output), `model` = id effettivo, `cost_usd` null, `provider_id` = il provider `api_key` usato (estendi `resolveApiKey` a restituire anche l'id), `run_id` nuovo. Best-effort.
- Per testarla senza rete (la network guard del server fa fallire i test con fetch reali): inietta il client Anthropic (`options.createClient?: (apiKey) => Pick<Anthropic, "messages">`).

- [ ] **Step 1: test** — client finto che emette `message_start` (usage input 100, cache_read 10) + delta testo + `message_delta` (output 50): una riga `operation='chat'`, `input_tokens=100`, `output_tokens=50`; con `ai_model_settings(chat='sonnet')` il client riceve `model: "claude-sonnet-5-5"`; senza riga riceve `claude-opus-4-8`; stream abortito dopo `message_start` → riga con `output_tokens=0`; insert che fallisce → lo stream completa comunque.
- [ ] **Step 2:** FAIL → **Step 3:** implementa e aggiorna i chiamanti (il compilatore li elenca) → **Step 4:** `pnpm --filter @stubwise/server test` PASS.
- [ ] **Step 5:** commit `feat(server): modello configurabile e consumi delle chat`.

### Task 9: server — aggregazioni dei consumi

**Files:** `apps/server/src/routes/usage-costs.ts`, test `usage-costs.test.ts`.

**Interfaces:**
- Le aggregazioni esistenti (`totals`, `byDay`, `byModel`, `byProject`, `byProvider`) leggono **tutte** le righe di `agent_runs` (via le colonne nuove `project_id`/`provider_id` con LEFT JOIN), non più solo quelle con `job_id`. `byProject.projectId` diventa `.nullable()` (riga «nessun progetto»).
- Rotta nuova `GET /api/usage/breakdown` (admin) query `{ from?: date; to?: date; groupBy: "operation"|"project"|"model"|"day"; thenBy?: stessa enum, ≠ groupBy }` → `{ rows: { key: string|null; label: string|null; subKey: string|null; subLabel: string|null; runs: number; inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens; costUsd: number|null; avgTokensPerRun: number }[] }`. `runs = count(distinct coalesce(run_id, id))`; `avgTokensPerRun = (input+output+cacheRead+cacheCreation)/runs`; `label` = nome progetto per `project`, altrimenti null (la traduzione dell'operazione la fa il web). Stesse regole di periodo della rotta esistente.

- [ ] **Step 1: test** — fixture con righe: job (fix), review, chat senza owner con progetto, posta senza progetto, una riga legacy (`run_id` null), due righe dello stesso `run_id` con modelli diversi. Asserisci: `totals` include review e chat; `byProject` ha la riga `projectId: null`; `breakdown?groupBy=operation&thenBy=model` dà le coppie attese; `runs` conta 1 per le due righe con lo stesso `run_id` raggruppate per operazione; `thenBy === groupBy` → 400.
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(server): consumi di ogni operazione e raggruppamenti`.

### Task 10: web — sezione «Modelli» in Automazione

**Files:** `apps/web/src/routes/settings/automation.tsx` (o un componente `apps/web/src/components/model-settings-section.tsx` incluso lì), `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, locales it/en. Test `model-settings-section.test.tsx`.

**Interfaces:**
- Consumes: rotte del Task 7.
- UI: una tabella per gruppo (`AI_OPERATION_GROUPS` senza `technical`), una riga per operazione: etichetta tradotta, `<select>` con «Predefinito» + `choices`; sotto la select, quando il valore è nullo, «predefinito: <workerDefault>» (o «predefinito del worker» se `workerDefault` è null). Salvataggio con un bottone, come la sezione esistente, inviando solo le righe cambiate. Stessa estetica delle tabelle della pagina; nessun grafico.
- Copy (it): titolo «Modelli»; sottotitolo «Il modello usato da ogni tipo di lavoro AI, per tutta l'istanza. Vale dalla prossima esecuzione: quelle in corso finiscono col modello con cui sono partite.»

- [ ] **Step 1: test** — render con una risposta in cui `workerDefault` manca (fixture senza il campo: la difesa `?? null` deve reggere); cambiare `fix_execute` e salvare invia `PATCH {models:{fix_execute:"claude-opus-5-5"}}`; scegliere «Predefinito» invia `null`; le operazioni `technical` non compaiono.
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** `pnpm --filter @stubwise/web test` PASS.
- [ ] **Step 5:** commit `feat(web): scelta del modello per operazione in Automazione`.

### Task 11: web — Utilizzo raggruppabile e avviso sul budget

**Files:** `apps/web/src/routes/settings/usage.tsx`, `apps/web/src/components/notifications-section.tsx` (~299, campo budget mensile), `api.ts`, `queries.ts`, locales. Test `usage.test.tsx` (o accanto), test della sezione notifiche.

**Interfaces:**
- Periodo: 7g, 30g, mese corrente, intervallo libero (`from`/`to`). Select «Raggruppa per» e «poi per» (facoltativo). Tabella: chiave (operazione tradotta / nome progetto / modello / giorno; null → «nessun progetto»), sotto-chiave, esecuzioni, input, output, cache read, cache creation, media per esecuzione, costo (o «—»).
- Le sezioni esistenti della pagina restano; `byProject` con `projectId` null mostra «nessun progetto».
- Avviso accanto al budget mensile (it): «Conta ogni consumo AI con un costo: fix, review, Docs, giro notturno, report, backlog. Le chat registrano solo i token.»

- [ ] **Step 1: test** — breakdown `operation`×`model` rende le righe con le etichette tradotte; una riga con `key: null` per `project` mostra «nessun progetto»; un campo numerico mancante nella fixture (`cacheCreationTokens`) mostra 0; l'avviso del budget è presente.
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(web): consumi raggruppabili in Utilizzo`.

### Task 12: documentazione e verifica finale

**Files:** `docs/operations/deploy-log.md` (voce nuova «Modelli per operazione e consumi», 21 ott 2026), `CLAUDE.md` (riga nell'indice delle voci di deploy; sotto «Invarianti e trappole» una voce breve: «Ogni run del worker dichiara un `UsageTag`; modello e consumi passano dal `TrackingAgentRunner`, e un consumo si registra in UN posto»), `docs/invariants/providers.md` (il modello non dipende dall'account, si risolve nel decoratore), `apps/docs` se la guida utente descrive Automazione/Utilizzo.

- [ ] **Step 1:** voce di deploy-log: ordine server → worker → caddy; migrazione 0096; **prima del deploy** stima del consumo del mese delle operazioni nuove (query su `doc_generations.cost` e `commit_summaries.cost_usd` del mese corrente) e revisione di `monthly_budget_usd`; rollback: un worker vecchio inserisce in `agent_runs` senza `operation` (NOT NULL) e con `phase` sempre valorizzata; l'insert fallisce e viene ingoiato (best-effort), quindi niente crash ma consumi persi finché si resta giù. Nella voce indica il passo che li salva: `ALTER TABLE agent_runs ALTER COLUMN operation SET DEFAULT 'fix_execute'` prima di scendere, da togliere al ritorno. Il server vecchio legge solo: sicuro, ma `byProject` con `project_id` null non gli interessa (fa ancora inner join sui job). Worker: niente riavvio con generazioni Docs/notturno in corso (query di `CLAUDE.md`).
- [ ] **Step 2:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` → tutto verde.
- [ ] **Step 3:** il runner è cambiato → gli scenari golden vanno rilanciati col CLI pinnato (`CLAUDE.md`, «Scenari golden»): almeno `plan-only`, `execute`, `refine` e `nightly`; segnala nel PR se non sono stati lanciati.
- [ ] **Step 4:** `graphify update .` e commit `docs: modelli per operazione e consumi — deploy-log, invarianti`.
