# Stubwise — Affidabilità AI: Self-repair + Budget di costo (design)

> Design validato il 2026-06-16. Due funzionalità complementari di affidabilità
> della pipeline AI (la seconda fa da guardrail alla prima). Dal backlog
> `docs/plans/feature-backlog.md`, sezione "Rendere l'AI più affidabile".

## Obiettivo

- **A — Self-repair.** Oggi se l'agente esce con errore il job fallisce in modo
  conservativo (niente PR anche con diff), e il worker si fida dell'agente per i
  test. Vogliamo che il **worker esegua da sé i test** del repo dopo la fase di
  esecuzione e, se falliscono, reinvochi l'agente con l'output del fallimento,
  fino a N tentativi; solo con test verdi committa e apre la PR.
- **B — Budget di costo.** Tetti di spesa basati su `agent_runs.costUsd`: per
  singolo **ticket, differenziato per tipologia**, e **aggregato per periodo**
  (mese di calendario) d'istanza. Al superamento il job va in `held` con
  notifica; l'avvio manuale scavalca.

## Decisioni chiave

- Self-repair: il **worker** ri-esegue i test (gate verificato, non fiducia
  nell'agente) e cicla con feedback fino a `SELF_REPAIR_MAX_ATTEMPTS`.
- Comando di test: **auto-detect** (script `test` in package.json + package
  manager dai lockfile) con **override per-progetto** (`projects.test_command`);
  se non risolvibile → self-repair disattivato (comportamento attuale).
- Budget per-ticket **per tipo** (`automation_rules.max_cost_usd`) + per-periodo
  **mensile** d'istanza (`instance_settings.monthly_budget_usd`); `null` = nessun
  tetto.
- Superamento budget → stato `held` (riuso) + notifica dedicata
  `job.budget_held`; `manualTrigger` scavalca (come il gate auto-fix).

## Modello dati (migrazione additiva)

- `projects.test_command text` (nullable) — override comando di test.
- `automation_rules.max_cost_usd numeric(12,6)` (nullable, per tipo) — tetto per
  singolo ticket di quel tipo.
- `instance_settings.monthly_budget_usd numeric(12,6)` (nullable) — tetto
  aggregato per mese di calendario.
- `notification_settings.notify_budget_held boolean not null default true`.

Self-repair: tentativi via env in `apps/worker/src/config.ts`
(`SELF_REPAIR_MAX_ATTEMPTS`, default **2**; 0 = disattivato) +
`SELF_REPAIR_TEST_TIMEOUT_MS` (default ~5'). Niente colonna DB.

I run di self-repair restano fase `fix` in `agent_runs` (nessun nuovo valore
enum), quindi rientrano nei conteggi di costo.

## A — Self-repair (worker, in `runFix`)

**`resolveTestCommand(project, worktreeDir): string | null`:**
1. `project.testCommand` se valorizzato;
2. altrimenti auto-detect: `package.json` nella radice del worktree con
   `scripts.test` → package manager dai lockfile (`pnpm-lock.yaml`→`pnpm test`,
   `yarn.lock`→`yarn test`, altrimenti `npm test`);
3. niente → `null` (self-repair disattivato per quel job).

**Flusso** (dentro lo stesso `withWorktree`, tra esecuzione e commit):
1. l'agente esegue il fix (come ora);
2. se diff presente **e** `testCommand` risolto **e** `SELF_REPAIR_MAX_ATTEMPTS>0`:
   - il worker esegue `testCommand` (execa, `SELF_REPAIR_TEST_TIMEOUT_MS`, output
     catturato+troncato);
   - **verdi** → commit/push/PR;
   - **rossi** → se restano tentativi **e** budget-ticket non superato: reinvoca
     l'agente di esecuzione con un prompt di riparazione che include l'output del
     fallimento (blocco delimitato, non fidato; "correggi il minimo necessario"),
     poi ri-testa. Loop ≤ `SELF_REPAIR_MAX_ATTEMPTS`;
   - tentativi esauriti, test ancora rossi → fallimento conservativo (`failJob`,
     niente PR) con output dei test nel log + notifica `job.failed`;
3. niente `testCommand` → comportamento attuale (apre la PR fidandosi
   dell'agente).

Ogni reinvocazione registra `usage` in `agent_runs` (fase `fix`). Heartbeat già
attivo nel `withWorktree`. **Invariante staleness:** N × (timeout esecuzione +
timeout test) < `WORKER_STALE_MINUTES` — verificato all'avvio del worker.

## B — Budget (enforcement)

**Helper costo:**
- `ticketCostUsd(db, ticketId)` — somma `agent_runs.costUsd` sui job del ticket
  (join `ai_jobs.ticket_id`), null→0.
- `monthlyCostUsd(db)` — somma con `created_at >= date_trunc('month', now())`.

**Punti di controllo** (solo prima delle fasi costose; il triage haiku è
trascurabile):
1. **Pre-fix** (inizio `runFix`, prima di pianificazione/esecuzione):
   - `monthly_budget_usd != null` e `monthlyCostUsd() >= monthly_budget_usd` →
     `held` (scope mensile);
   - per il tipo: `max_cost_usd != null` e `ticketCostUsd() >= max_cost_usd` →
     `held` (scope ticket);
   - **scavalco**: `job.manualTrigger` salta i due controlli.
2. **Nel loop self-repair** (prima di ogni riparazione): ricontrolla il tetto
   per-ticket includendo il costo accumulato in questo run (storico + `fixUsages`
   in memoria). Superato → ferma il loop.

**Held per budget:** riuso `holdJob`; commento `ai`/`system` (tradotto via
`@stubwise/i18n`, lingua d'istanza) + notifica `job.budget_held`.

## Notifiche

Nuovo evento `job.budget_held` in `@stubwise/notifications` (+ catalogo
`@stubwise/i18n` en/it): campi `ticketNumber, ticketTitle, projectName, scope`
(`ticket`|`monthly`), `limitUsd`, `spentUsd`, `ticketUrl`. Toggle
`notify_budget_held` (default true) + UI. Il self-repair fallito usa l'evento
`job.failed` esistente.

## Config UI

- `max_cost_usd` per tipo → **Settings → Automazione AI** (accanto a
  auto-fix/effort/approvazione piano), estende l'upsert `automation_rules`.
- `monthly_budget_usd` → **Settings → admin** (accanto a lingua contenuti/
  notifiche), estende l'upsert `instance_settings`.
- `projects.test_command` → form progetto.

## Test (TDD)

- `resolveTestCommand`: override per-progetto; auto-detect pnpm/yarn/npm; null.
- self-repair: rossi→reinvoca+ri-testa; verdi→PR; esauriti→`failed` con log;
  nessun comando→invariato. Runner/test iniettabili.
- budget: pre-fix oltre tetto mensile/ticket→`held`+evento; `manualTrigger`
  scavalca; loop che sfora tetto-ticket→ferma.
- helper costo: somma corretta, null→0, finestra mese.
- server/web: round-trip `max_cost_usd`/`monthly_budget_usd`/`test_command`/
  `notify_budget_held`; format en/it dell'evento.
- **E2E Playwright** se tocco UI progetti/settings (`pnpm --filter @stubwise/web
  e2e`): gli E2E non sono in `pnpm -r test`.

## Migrazione & config

Migrazione Drizzle additiva (4 colonne). `config.ts`:
`SELF_REPAIR_MAX_ATTEMPTS` (2), `SELF_REPAIR_TEST_TIMEOUT_MS` (~5') +
aggiornamento invariante staleness.

## Docs

`ai-pipeline/how-it-works.md` (self-repair), `ai-pipeline/automation.md` (budget
per-tipo + comando di test), nota budget mensile. In inglese (le docs sono ora
solo-inglese).

## Dimensione

Media. Il grosso è il refactor del loop in `runFix` + i controlli di budget; il
resto (colonne, settings, notifica, docs) è incrementale. Esecuzione
subagent-driven, fase per fase, con review spec+qualità.
