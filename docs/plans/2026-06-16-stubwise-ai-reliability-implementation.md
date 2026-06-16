# Affidabilità AI (Self-repair + Budget) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (o subagent-driven-development) per implementare questo piano task per task.

**Goal:** Il worker esegue da sé i test del repo dopo il fix e cicla con feedback fino a N tentativi (self-repair); tetti di spesa per-ticket-per-tipo e mensili d'istanza fermano i job in `held` con notifica (budget).

**Architecture:** Estensione di `runFix` nel worker: dopo la fase di esecuzione, gate di test verificato dal worker con loop di riparazione; controlli di budget (da `agent_runs.costUsd`) prima delle fasi costose e nel loop. Config di spesa per-tipo in `automation_rules`, mensile in `instance_settings`, comando di test in `projects`. Nuovo evento notifica `job.budget_held`.

**Tech Stack:** pnpm monorepo, TS NodeNext, Drizzle+Postgres, Fastify 5, Vitest+testcontainers, React 18, execa (comandi git/test nel worktree).

**Design:** `docs/plans/2026-06-16-stubwise-ai-reliability-design.md`.

**Convenzioni repo:** TDD (rosso→verde→commit, un commit/task); `pnpm --filter <pkg> {test,typecheck}`, `pnpm -r build`; migrazioni `pnpm --filter @stubwise/db exec drizzle-kit generate` (applicate al boot via runMigrations, seed manuale dei singleton in coda al SQL come 0011/0013); transizioni job status-guarded in `apps/worker/src/queue.ts`; testi generati backend via `@stubwise/i18n` (lingua d'istanza); **gli E2E Playwright (`pnpm --filter @stubwise/web e2e`) NON sono in `pnpm -r test`** — eseguirli per modifiche UI.

---

## Fase 0 — Schema

### Task 1: Colonne DB

**Files:** `packages/db/src/schema.ts`; migrazione generata; `packages/db/src/schema.test.ts`.

**Step 1 — schema:**
- `projects`: `testCommand: text("test_command")` (nullable).
- `automationRules`: `maxCostUsd: numeric("max_cost_usd", { precision: 12, scale: 6 })` (nullable).
- `instanceSettings`: `monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 6 })` (nullable).
- `notificationSettings`: `notifyBudgetHeld: boolean("notify_budget_held").notNull().default(true)`.

**Step 2 — Migrazione:** `pnpm --filter @stubwise/db exec drizzle-kit generate`. Tutte additive (nullable o default) → sicura. Nessun seed extra (le righe singleton esistono già).

**Step 3 — Test:** estendi `schema.test.ts`: insert/read di `projects.test_command`, `automation_rules.max_cost_usd` (numeric→stringa lato drizzle), `instance_settings.monthly_budget_usd`, default `notify_budget_held=true` sulla riga seedata.

**Step 4 — Commit:** `feat(db): colonne per self-repair e budget di costo`

---

## Fase 1 — Helper costo + evento notifica

### Task 2: Helper di lettura costo

**Files:** nuovo `packages/db/src/cost.ts` (o `apps/worker/src/cost.ts`); export dal barrel; test.

**Cosa:**
```ts
export async function ticketCostUsd(db: Db, ticketId: string): Promise<number>;
export async function monthlyCostUsd(db: Db): Promise<number>;
```
- `ticketCostUsd`: `sum(agent_runs.cost_usd)` joinando `ai_jobs` su `agent_runs.job_id` dove `ai_jobs.ticket_id = ticketId`; `coalesce` a 0 (numeric→string, converti in number con parseFloat; i run con cost null contano 0).
- `monthlyCostUsd`: `sum(agent_runs.cost_usd)` dove `agent_runs.created_at >= date_trunc('month', now())`.
- Metti gli helper dove sono testabili con testcontainers e usabili dal worker (server li userà solo per UI di sola lettura, opzionale). Consiglio: in `@stubwise/db` (vicino allo schema) così sia worker sia server li importano.

**Step — Test (testcontainers):** seed di `ai_jobs`+`agent_runs` con costi noti su 2 ticket → `ticketCostUsd` somma solo quelli del ticket; run con cost null → contano 0; `monthlyCostUsd` include solo la finestra del mese (inserisci un run con `created_at` del mese scorso e verifica che sia escluso).

**Commit:** `feat(db): helper ticketCostUsd e monthlyCostUsd`

---

### Task 3: Evento notifica `job.budget_held`

**Files:** `packages/i18n/src/catalog.ts` (testo en/it), `packages/notifications/src/format.ts` (+ dispatch toggle), test dei due pacchetti.

**Step 1 — i18n catalog:** aggiungi `notify.budgetHeld` (en/it) con interpolazione `{ticketNumber}`, `{ticketTitle}`, `{scope}` (o due chiavi per scope ticket/monthly), `{limit}`, `{spent}`. Mantieni parità chiavi+placeholder.

**Step 2 — notifications:** nuova interfaccia `JobBudgetHeldEvent` (kind `"job.budget_held"`, campi `ticketNumber, ticketTitle, projectName, scope: "ticket"|"monthly", limitUsd, spentUsd, ticketUrl`); aggiungila a `NotificationEvent`; case nei 4 formatter (testo via `@stubwise/i18n`); campione in `sampleEvents`; in `dispatch.ts` `TOGGLE_FOR_KIND["job.budget_held"] = "notifyBudgetHeld"` + campo in `NotificationSettingsRow`/`loadSettings`. (Il `Record<NotificationKind,...>` esaustivo impone questi update.)

**Step 3 — Test:** format en/it dell'evento (slack/discord/generic) + parità chiavi; gating `notifyBudgetHeld` on/off in dispatch.test.

**Commit:** `feat(notifications): evento job.budget_held`

---

## Fase 2 — Self-repair

### Task 4: `resolveTestCommand`

**Files:** nuovo `apps/worker/src/pipeline/test-command.ts`; test.

**Cosa:** `resolveTestCommand(project: { testCommand: string | null }, worktreeDir: string): Promise<{ cmd: string; args: string[] } | null>`:
1. se `project.testCommand` valorizzato → parsalo (split semplice su spazi in cmd+args; documenta il limite, es. niente shell-quoting complesso) e ritornalo.
2. altrimenti leggi `<worktreeDir>/package.json`; se `scripts.test` esiste → scegli il PM dai lockfile presenti nel worktree (`pnpm-lock.yaml`→`["pnpm","test"]`, `yarn.lock`→`["yarn","test"]`, altrimenti `["npm","test"]`).
3. niente → `null`.

**Step — Test:** override per-progetto (anche con args); auto-detect pnpm/yarn/npm via lockfile fittizi in una tmpdir con package.json+script test; package.json senza script test → null; nessun package.json → null. Usa una tmpdir reale (fs), non mock.

**Commit:** `feat(worker): resolveTestCommand (override + auto-detect)`

---

### Task 5: Loop self-repair in `runFix`

**Files:** `apps/worker/src/pipeline/fix.ts`, `apps/worker/src/pipeline/prompts.ts` (prompt di riparazione), `apps/worker/src/config.ts`, `apps/worker/src/index.ts` (invariante staleness), test.

**Step 1 — config:** in `config.ts` aggiungi `SELF_REPAIR_MAX_ATTEMPTS` (default 2; 0=off) e `SELF_REPAIR_TEST_TIMEOUT_MS` (default 300000). Passali a `runFix` via `FixDeps` (`selfRepairMaxAttempts?`, `testTimeoutMs?`, `runTestCommand?` iniettabile, `resolveTestCommandFn?` iniettabile per i test). Aggiorna l'invariante di staleness all'avvio (`index.ts`): considera N tentativi × (timeoutMs esecuzione + test timeout) nel calcolo del margine vs `WORKER_STALE_MINUTES` (come già fa per plan+execute).

**Step 2 — prompt di riparazione:** in `prompts.ts` `buildFixRepairPrompt({ ticket, teamComments, plan?, testOutput }, lang)`: riusa la cornice di esecuzione (acceptEdits) ma aggiunge un blocco `<test_failure>` (NON fidato, defangato, troncato) con l'output dei test e l'istruzione "i test del repo falliscono; correggi il minimo necessario perché passino; non rifattorizzare". Mantieni la disciplina anti-injection esistente.

**Step 3 — loop in `runFix`** (dentro `withWorktree`, ramo `full`/`execute-only`, dopo il run di esecuzione e prima del commit): risolvi `testCommand = resolveTestCommandFn(project, dir)`. Se `testCommand && SELF_REPAIR_MAX_ATTEMPTS>0`:
```
for (let attempt = 0; ; attempt++) {
  await gitIn(dir, ["add","-A"]); status = ...porcelain
  if (status empty) → NoChangesError (come oggi)
  const test = await runTestCommand(testCommand, dir, testTimeoutMs) // {exitCode, output}
  if (test.exitCode === 0) break  // verdi → procedi a report/commit/push
  if (attempt >= SELF_REPAIR_MAX_ATTEMPTS) → SelfRepairFailedError(test.output) // → failJob
  // budget-ticket check (Task 6) prima di ri-tentare; se superato → break+held
  const repair = await runner.run({ cwd: dir, prompt: buildFixRepairPrompt({...,testOutput:test.output}, lang), model: executeModel, permissionMode:"acceptEdits", maxTurns, timeoutMs, allowedTools })
  fixUsages.push(repair.usage); if (repair.exitCode!==0) throw new AgentExitError(...)
}
```
Nota: la lettura/rimozione di `STUBWISE_REPORT.md` va fatta DOPO che i test sono verdi (l'agente può riscriverlo nei tentativi). Riordina: report-read → git add → commit dopo il break. `runTestCommand(cmd, dir, timeout)` usa execa (`reject:false`, `timeout`, cattura stdout+stderr troncati); iniettabile nei test. Se `testCommand` è null → salta del tutto il loop e procede come oggi (un solo git add/status già presente).

Nuova classe `SelfRepairFailedError` → nel catch esistente: `failJob` + log con output test troncato + `notifyFailed`.

**Step 4 — Test:** runner+test iniettabili. Casi: test rossi→reinvoca con `<test_failure>`→verdi al 2° giro→PR (`pr_opened`); test sempre rossi→esauriti i tentativi→`failed` con output nel log, niente PR; nessun `testCommand`→comportamento attuale invariato (i test esistenti di runFix restano verdi); diff vuoto→`NoChangesError`.

**Commit:** `feat(worker): self-repair — il worker ri-esegue i test e cicla con feedback`

---

## Fase 3 — Budget enforcement

### Task 6: Controlli di budget in `runFix`

**Files:** `apps/worker/src/pipeline/fix.ts`, `apps/worker/src/queue.ts` (eventuale helper held-con-motivo o riuso `holdJob`), test.

**Step 1 — pre-fix** (all'inizio di `runFix`, dopo aver caricato ticket/progetto/regola e risolto `lang`, PRIMA di entrare in `withWorktree`; SALTA se `job.manualTrigger`):
- carica `rule.maxCostUsd` (per `ticket.type`) e `instance_settings.monthlyBudgetUsd`;
- se `monthlyBudgetUsd != null` e `await monthlyCostUsd(db) >= monthlyBudgetUsd` → held budget (scope `monthly`);
- se `maxCostUsd != null` e `await ticketCostUsd(db, ticket.id) >= maxCostUsd` → held budget (scope `ticket`);
- held budget = `holdJob(db, job.id, { log })` + commento (`t(lang,"comment.budgetHeld",{...})` — aggiungi la chiave in `@stubwise/i18n`) + `notify(job.budget_held, {scope, limitUsd, spentUsd, ...})` + return `"held"`. (Riusa il pattern del hold del gate auto-fix in triage.ts per commento+notifica.)

**Step 2 — nel loop self-repair** (Task 5, prima di ri-tentare): se `maxCostUsd != null` e `(ticketCostUsd storico + somma costUsd di fixUsages accumulati finora) >= maxCostUsd` → esci dal loop e tratta come held budget (scope ticket) invece di ri-tentare. (Se `manualTrigger`, il loop ignora il budget.)

**Step 3 — Test:** pre-fix oltre tetto mensile→held+evento monthly; oltre tetto-ticket→held+evento ticket; `manualTrigger=true`→ENTRAMBI i controlli saltati (procede); loop self-repair che supererebbe il tetto-ticket al 2° giro→si ferma in held invece di ri-tentare. Helper costo e notify iniettabili/seedati.

**Commit:** `feat(worker): budget di costo — held + notifica al superamento, manualTrigger scavalca`

---

## Fase 4 — Config: server + web

### Task 7: Server — settings & project

**Files:** `apps/server/src/routes/settings.ts`, `apps/server/src/routes/projects.ts` (create/update), test.

- `automationRuleSchema`: aggiungi `maxCostUsd: z.number().nonnegative().nullable().default(null)`; includilo in GET e nell'upsert `automation_rules`. (numeric in DB ↔ number in API: serializza/deserializza coerentemente, vedi come è gestito `costUsd` altrove → numeric è stringa lato drizzle, converti.)
- instance settings: aggiungi `monthlyBudgetUsd` (number nullable) all'endpoint GET/PUT `/api/settings/instance` (admin).
- `projects` create/update: aggiungi `testCommand: z.string().min(1).nullable().optional()` allo schema body; persistilo.
- `notification_settings`: esponi `notifyBudgetHeld` (come gli altri toggle: response/PUT default true).
- Test server: round-trip di tutti e quattro.

**Commit:** `feat(server): config budget (max_cost_usd, monthly_budget_usd), test_command, toggle notify_budget_held`

---

### Task 8: Web — UI config

**Files:** `apps/web/src/lib/api.ts` (+ queries), `apps/web/src/routes/settings/automation.tsx`, la sezione instance settings (notifications-section o admin), `apps/web/src/components/project-form.tsx`/`project-wizard.tsx`, `notifications-section.tsx` (toggle), i18n `en.json`/`it.json`, test (+ E2E se tocchi project/settings).

- Automazione AI: campo "Max cost per ticket ($)" per tipo (input numerico, vuoto = nessun tetto) → `maxCostUsd`.
- Instance settings (admin): campo "Monthly budget ($)" → `monthlyBudgetUsd`.
- Project form: campo "Test command (optional)" → `testCommand` (con hint: vuoto = auto-detect).
- Notifiche: toggle "Budget exceeded (job held)" → `notifyBudgetHeld`.
- Stringhe estratte in en/it (parità verde). Aggiorna i test web; se tocchi project/settings UI esegui `pnpm --filter @stubwise/web e2e` e adegua i selettori.

**Commit:** `feat(web): UI per budget di costo e comando di test`

---

## Fase 5 — Docs & verifica

### Task 9: Docs

**Files:** `apps/docs/src/content/docs/ai-pipeline/how-it-works.md` (self-repair nel fix), `ai-pipeline/automation.md` (budget per-tipo + comando di test + budget mensile). In **inglese** (docs solo-inglese). `pnpm --filter @stubwise/docs build` 0 errori.

**Commit:** `docs: self-repair e budget di costo`

### Verifica finale
1. `pnpm -r typecheck` 0 errori; `pnpm -r test` verde; `pnpm --filter @stubwise/web e2e` verde; `pnpm -r build`.
2. Code review finale dell'intera feature vs design (subagent).
3. Deploy: backup DB, migrazione additiva, rebuild server+worker+caddy; verifica /health + colonne. Nota: `SELF_REPAIR_MAX_ATTEMPTS`/`SELF_REPAIR_TEST_TIMEOUT_MS` opzionali in `.env` (default sensati).
