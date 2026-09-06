---
title: Fase 5 — Roadmap e narrativa — piano di implementazione
date: 2026-09-06
design: 2026-09-06-phase5-roadmap-narrative-design.md
stubwise:
  project: stubwise
  backlog: fd5129d8-347e-457a-9da8-86cfd7355b67
  ticket: https://stubwise.thecove.it/tickets/93857e43-8bf5-4fb5-82d4-0920d15adfd1
---

# Fase 5 — Roadmap e narrativa: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Prima del Task 1**: esegui `/stubwise:start` sulla voce di backlog
> indicata nel frontmatter del design doc (converte in ticket e lo porta in
> `in_progress`). Lavora in un worktree `feature/phase5-roadmap-narrative`.
> Alla fine: push del branch, CI verde (incluso E2E), PR verso main; merge e
> deploy li fa il maintainer.

**Goal:** riassunti "in breve" di piani e PR nelle card; timeline di progetto
con pagina web Roadmap; brief settimanale per non-tecnici (poller, notifica
`project.brief`, API, MCP); registro decisioni `project_decisions` nei Docs
di progetto, nella chat e via MCP. Più due riparazioni a monte: creazione
milestone e audit delle transizioni di sistema.

**Architecture:** tutto additivo sul modello delle fasi precedenti: colonne
nullable, tre tabelle nuove, un solo valore enum nuovo (`project.brief`),
rotte nuove per progetto, un helper condiviso per i run AI di solo testo nel
worker, un poller settimanale sul modello del daily report. L'app mobile
installata non si rompe (campi opzionali, enum aperti via `readerSchema`);
l'ondata 2 mobile è un task separato in fondo.

**Tech Stack:** Fastify + Zod + Drizzle, worker con claude CLI (`runner.run`),
React SPA, i18n backend `packages/i18n`, `packages/shared`, `packages/mcp`
(Changesets), RN per l'ondata 2.

**Convenzioni (ereditate)**: TDD; commit piccoli in italiano
(`feat|fix|refactor|test|docs|chore(scope):`); `pnpm --filter
@stubwise/<pkg> exec vitest run <pattern>`; migrazioni SQL a mano +
`meta/_journal.json`; **`ALTER TYPE … ADD VALUE` in statement proprio, valore
mai usato nella stessa migrazione** (batch in una transazione); i18n backend
in `packages/i18n/src/catalog.ts` (en+it, test di parità); `pnpm -r build`
dopo aver toccato `packages/*`; `pnpm lint` dalla radice prima del merge;
ogni rotta letterale nuova sotto `/api/projects` va **prima** di
`/:projectId`; campi nuovi negli schemi di risposta **sempre**
`.optional()`/nullable, mai `.strict()`; changeset per `packages/shared` e
`packages/mcp`.

---

## Fase A — Fondamenta

### Task 1: helper `runAgentText` + `parseAgentJson` nel worker

**Files:**
- Create: `apps/worker/src/agent/text.ts` (`runAgentText(runner, { prompt, cwd?, model?, provider?, timeoutMs, maxTurns = 3 }) → Promise<string | null>`: `permissionMode: "plan"`, cwd = `mkdtemp` se assente (rimossa alla fine), `null` se `exitCode !== 0` o output vuoto; `parseAgentJson<T>(schema, text)` con fence/slice difensivi; `capText(text, maxChars, marker)`)
- Modify: `apps/worker/src/reports/daily-report-poller.ts:86-90` (`textFromRun` → `runAgentText`), `apps/worker/src/backlog/intake.ts:78-98,157-162`, `apps/worker/src/backlog/estimate.ts:47-70,74-79` (adottano l'helper, comportamento invariato)
- Test: `apps/worker/src/agent/text.test.ts`

**Step 1: test rosso** — runner finto: exit 0 con output → testo; exit 1 →
`null`; output vuoto → `null`; `parseAgentJson` su ```json fence```, su testo
con prefisso, su JSON invalido (→ `null`); `capText` che tronca con marcatore
e non spezza a metà riga. Poi: i test esistenti di report/intake/estimate
restano verdi dopo l'adozione.

**Step 2–4**: rosso → implementa → `pnpm --filter @stubwise/worker exec vitest run agent/text reports backlog` PASS.
**Step 5: Commit** `refactor(worker): runAgentText e parseAgentJson condivisi`.

### Task 2: migrazione 0068

**Files:**
- Create: `packages/db/drizzle/0068_roadmap_narrative.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (idx 68)
- Modify: `packages/db/src/schema.ts` (colonne e tabelle sotto; `notificationKind` += `"project.brief"`)
- Modify: `packages/shared/src/schemas/notification.ts` (`notificationKindSchema` += `project.brief`; nota delle tre liste allineate), `packages/notifications/src/format.ts` (unione kind, `EMOJI`, `KEY_FOR_KIND`), `packages/notifications/src/push/payload.ts` (`PUSH_TITLE_KEY`), `packages/notifications/src/dispatch.ts` (`TOGGLE_FOR_KIND` → `notifyBrief`), `packages/notifications/src/routing.ts` (audience `broadcast`), `packages/notifications/src/actions.ts` (solo `open/snooze/handled`, `archivable`)
- Test: `packages/db/src/enum-parity.test.ts` (già esiste: deve restare verde), `packages/notifications/src/format.test.ts`

SQL (ordine obbligato):
```sql
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'project.brief';
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "plan_summary" text;
--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "pr_summary" text;
--> statement-breakpoint
ALTER TABLE "milestones" ALTER COLUMN "repository_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "description" text, ADD COLUMN "closed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "weekly_brief_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE "project_briefs" ( … vedi design §5 …, CONSTRAINT project_briefs_status_chk CHECK (status IN ('queued','running','done','failed')), UNIQUE (project_id, period_start) );
--> statement-breakpoint
CREATE TABLE "project_decisions" ( … vedi design §6 …, CONSTRAINT project_decisions_source_chk CHECK (source IN ('ask_user','plan_review','pulse','manual')), UNIQUE (project_id, source_key) );
--> statement-breakpoint
CREATE INDEX project_decisions_project_decided_idx ON project_decisions (project_id, decided_at DESC);
--> statement-breakpoint
CREATE INDEX project_briefs_project_period_idx ON project_briefs (project_id, period_start DESC);
```
`notification_settings` prende `notify_brief boolean NOT NULL DEFAULT true`
(se il toggle webhook è per-colonna: verifica `TOGGLE_FOR_KIND` e la tabella).

**Step 1: test rosso** — enum-parity con `project.brief`; insert in
`project_decisions` con lo stesso `(project_id, source_key)` → unique
violation; `project_briefs` con status fuori lista → CHECK.
**Step 2–4**: rosso → schema → PASS (`pnpm --filter @stubwise/db test`, poi `pnpm -r build && pnpm --filter @stubwise/notifications test`).
**Step 5: Commit** `feat(db): migrazione 0068 — riassunti, milestone, brief, decisioni, kind project.brief`.

### Task 3: riparazione milestone

**Files:**
- Modify: `packages/shared/src/schemas/milestone.ts` (nuovo: `milestoneSchema`, `milestoneDraftSchema { projectId, repositoryId?, name, dueDate?, description? }`, `milestonePatchSchema` + `closedAt`)
- Modify: `apps/server/src/routes/milestones.ts:45-54,268-316` (`repositoryId` opzionale; se presente deve appartenere al progetto; PATCH `status: closed` → `closedAt = now()`, riapertura → `null`)
- Modify: `apps/web/src/lib/api.ts:409-441`, `apps/web/src/components/milestone-manager.tsx` (importa i tipi da shared; form con `description`)
- Test: `apps/server/src/routes/milestones.test.ts` (**rimuovi** il wrapper che inietta `repositoryId` alle righe 54-55: il test deve chiamare la rotta come fa la UI), `apps/web/src/components/milestone-manager.test.tsx` (il mock della POST verifica il body reale)

**Step 1: test rosso** — POST senza `repositoryId` → 201; con `repositoryId` di un altro progetto → 400; PATCH `closed` → `closedAt` valorizzato; riapertura → null.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `fix(milestones): creazione senza repository, description e closed_at`.

### Task 4: audit delle transizioni di sistema + backfill

**Files:**
- Create: `packages/db/src/ticket-events.ts` (`recordTicketStatusChange(tx, { ticketId, from, to, actorId })` → insert `ticket_events` kind `status_changed`, payload `{from, to}`; no-op se `from === to`)
- Modify: `apps/server/src/routes/webhooks.ts:416,551,600` (chiama l'helper con `actorId: null` accanto a ogni UPDATE di `tickets.status`), `apps/server/src/routes/tickets.ts` (riusa l'helper al posto dell'inline se identico), `apps/worker/src/pipeline/fix.ts` e `apps/worker/src/backlog/intake.ts` (dove cambiano `tickets.status`: cerca `set({ status:` su `tickets`)
- Create: `apps/server/scripts/backfill-ticket-done-events.ts` (idempotente: per ogni ticket `done` senza evento `status_changed` con `to: "done"`, inserisce l'evento datato `max(ai_jobs.finished_at where status='pr_merged')` altrimenti `tickets.updated_at`; `--dry-run`; script `pnpm --filter @stubwise/server backfill:ticket-events`)
- Test: `apps/server/src/routes/webhooks.test.ts`, `apps/worker/src/pipeline/fix.test.ts` (o il test dove si verifica la transizione), `apps/server/scripts/backfill-ticket-done-events.test.ts`

**Step 1: test rosso** — webhook merge → evento `status_changed {from: in_review, to: done}` con `actor_id NULL`; replay dello stesso webhook → nessun secondo evento (il gate `alreadyMerged` esistente); backfill: ticket done senza evento → 1 evento datato dal job; rilancio → 0 inserimenti.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(audit): eventi di stato anche per webhook e worker, backfill dei ticket chiusi`.

## Fase B — Riassunti "in breve"

### Task 5: riassunto del piano

**Files:**
- Create: `apps/worker/src/summaries/plan-summary.ts` (`buildPlanSummaryPrompt(lang, { ticketTitle, planText })`, `generatePlanSummary(deps, { db, projectId, planText }) → string | null` via `runAgentText`; tetto input 40k char; `SUMMARIES_ENABLED`/`SUMMARY_MODEL` da config)
- Modify: `apps/worker/src/config.ts` (`summariesEnabled` default true, `summaryModel` default `prReviewModel`), `apps/worker/src/queue.ts:276-292` (`parkForPlanApproval(db, jobId, { planText, planSummary, log })` nello stesso UPDATE guardato), `apps/worker/src/pipeline/fix.ts:1825-1856` (genera PRIMA del park, dopo la chiusura dei worktree; poi park; poi notify)
- Modify: `apps/server/src/services/jobs.ts:291` (`{ planText: null, planSummary: null }`)
- Modify: `packages/i18n/src/catalog.ts` (`summary.plan.instructions` en/it: le regole del prompt)
- Test: `apps/worker/src/summaries/plan-summary.test.ts`, `apps/worker/src/queue.test.ts`, `apps/server/src/services/jobs.test.ts`

**Step 1: test rosso** — prompt contiene la lingua di contenuto letta dal DB e non "ITALIANO"; input > tetto troncato con marcatore; runner exit 1 → `null` e il park avviene comunque con `plan_summary NULL`; `parkForPlanApproval` scrive `plan_text` e `plan_summary` in un UPDATE (spia sulle query o verifica riga); job non più attivo → nessuna scrittura; `resolvePlan(fix)` azzera entrambi; `SUMMARIES_ENABLED=false` → nessun run.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(worker): riassunto in breve del piano, scritto col parcheggio`.

### Task 6: riassunto della PR nella review

**Files:**
- Create: `apps/worker/src/summaries/pr-summary.ts` (`buildPrSummaryPrompt(lang, { prTitle, prBody, verdict, analysis })`, `generatePrSummary`)
- Modify: `apps/worker/src/review/run-review.ts:659-731` (dopo `parseReviewOutput` e dopo il cap di costo; scrittura di `pr_summary` nella stessa transazione di `verdict`/`summary`)
- Modify: `packages/i18n/src/catalog.ts` (`summary.pr.instructions`)
- Test: `apps/worker/src/review/run-review.test.ts`, `apps/worker/src/summaries/pr-summary.test.ts`

**Step 1: test rosso** — review completata → `pr_summary` presente nella stessa riga; runner fallito → `pr_summary NULL` e review comunque `completed`; review scartata dal cap di costo → nessun run di riassunto.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(worker): riassunto in breve della PR nella review`.

### Task 7: `summary` nelle card, negli schemi e nelle consegne

**Files:**
- Modify: `packages/shared/src/schemas/notification.ts` (`inboxItemSchema.summary: z.string().optional()`), `packages/shared/src/schemas/ticket.ts` (`ticketDetailSchema.planSummary: z.string().nullable().optional()`), `packages/shared/src/schemas/ai-job.ts` (`planSummary` idem)
- Modify: `apps/server/src/services/inbox.ts:797-825` (`renderItem`: per `job.plan_review` legge `ai_jobs.plan_summary` del job della notifica; per `job.pr_opened`/`review.completed` legge `pr_reviews.pr_summary` per `ticket_id` + `pr_url`; una query batch per pagina, non per item), `apps/server/src/routes/tickets.ts` (dettaglio con `planSummary` dall'ultimo job), `apps/server/src/routes/ai-jobs.ts`
- Modify: `packages/notifications/src/format.ts:673-682` (`formatGeneric`: campo `summary` nel payload webhook per i tre kind), `packages/notifications/src/slack-blocks.ts` (`section` separata con `escapeSlackMrkdwn(summary)` prima delle azioni)
- Modify: `apps/web/src/components/inbox-item.tsx:380,451` (riassunto in un blocco evidenziato sopra Approva/Rifiuta; sotto il testo per la PR), `apps/web/src/routes/tickets/$id.tsx` (riga "In breve" sopra il piano)
- Modify: `.changeset/*.md` (`@stubwise/shared` minor)
- Test: `apps/server/src/services/inbox.test.ts`, `packages/notifications/src/slack-blocks.test.ts`, `apps/web/src/components/inbox-item.test.tsx`

**Step 1: test rosso** — pagina inbox con un `job.plan_review` il cui job ha `plan_summary` → item con `summary`; senza → campo assente (non `null`); PR con review → `summary`; Slack: blocco presente ed escape di `*_~` ; web: riassunto renderizzato, fallback al solo testo.
**Step 2–4**: rosso → implementa → PASS; `pnpm -r build`.
**Step 5: Commit** `feat(inbox): riassunti in breve nelle card web, Slack e webhook`.

## Fase C — Timeline e roadmap

### Task 8: rotte `reviews` e `timeline`

**Files:**
- Modify: `packages/shared/src/schemas/project.ts` (`prReviewSummarySchema`, `projectTimelineEntrySchema` = `z.discriminatedUnion("kind", [...])` coi kind del design §4, `projectTimelineSchema { from, to, entries }`)
- Modify: `apps/server/src/routes/projects.ts` (`GET /:projectId/reviews`, `GET /:projectId/timeline` — verifica l'ordine di registrazione: rotte con parametro `:projectId` + suffisso letterale non collidono con `/pulse`, ma tienile dopo `/pulse` per coerenza)
- Create: `apps/server/src/services/project-timeline.ts` (una query per sorgente: ticket aperti nel periodo, `ticket_events` `to: done`, milestone con `due_date`/`closed_at` nel periodo, `ticket_repositories` + `ai_jobs` per PR con join su `pr_reviews`, `activity_reports done`, `project_decisions`, `project_briefs done`; fusione e ordinamento in memoria; limite 180 giorni; ACL member = seguiti o membro)
- Modify: `packages/api-client/src/endpoints/projects.ts` (`reviews`, `timeline`)
- Test: `apps/server/src/services/project-timeline.test.ts`, `apps/server/src/routes/projects.test.ts`, `packages/api-client/src/endpoints/projects.test.ts`

**Step 1: test rosso** — un progetto con 1 ticket aperto e chiuso (evento), 1 milestone scaduta, 1 PR mergiata con review `approve` e `pr_summary`, 1 report, 1 decisione, 1 brief → 8 voci ordinate per `at`; `from`/`to` filtrano; `kinds=pr_merged` filtra; finestra > 180 giorni → 400; member non follower → 404/403 come le altre rotte di progetto; `reviews` restituisce verdetto e riassunto, mai `error` interni.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(server): timeline di progetto e lettura delle review`.

### Task 9: pagina web Roadmap

**Files:**
- Create: `apps/web/src/routes/projects/$projectId.roadmap.tsx` (milestone aperte con scadenza e barra da `counts`; timeline raggruppata per settimana; brief come separatori con link; filtri kind; stato vuoto)
- Create: `apps/web/src/components/project-timeline.tsx`, `apps/web/src/components/milestone-progress.tsx`
- Modify: `apps/web/src/router.tsx` (rotta figlia), `apps/web/src/routes/projects/$projectId.tsx:273` (link "Roadmap" accanto alle milestone), `apps/web/src/routes/docs/project.$projectId.tsx` (link nella home Docs)
- Modify: `apps/web/src/i18n/locales/{en,it}/projects.json` (`roadmap.*`)
- Test: `apps/web/src/components/project-timeline.test.tsx`, `apps/web/src/routes/projects/$projectId.roadmap.test.tsx`

**Step 1: test rosso** — rende i gruppi settimanali; voce PR mostra verdetto e riassunto; milestone con avanzamento `completed/total`; filtro kind; vuoto "Nessun evento nel periodo".
**Step 2–4**: rosso → implementa → PASS (`pnpm --filter @stubwise/web test` + typecheck).
**Step 5: Commit** `feat(web): pagina Roadmap del progetto`.

## Fase D — Brief settimanale

### Task 10: poller del brief e generazione

**Files:**
- Create: `apps/worker/src/briefs/poller.ts` (`startBriefPoller`, `pollBriefsOnce`, `isInBriefWindow(now, { weekday, hour, timeZone })`, claim guardato, recovery, `MAX_ATTEMPTS 3`), `apps/worker/src/briefs/input.ts` (`collectBriefInput(db, projectId, period)`: report della settimana, timeline del periodo via `project-timeline` service — spostalo in `packages/notifications` o duplica la parte pura se il service è nel server: **decidi e documenta**; blocchi da `project-signals`; decisioni; brief precedente; tetto 60k con marcatori), `apps/worker/src/briefs/prompt.ts` (`buildBriefPrompt(lang, input)` con 4 marcatori di sezione `<<WHERE>>`… e `parseBriefOutput`)
- Modify: `apps/worker/src/config.ts` (`BRIEF_POLL_MINUTES` 15, `BRIEF_WEEKDAY` 1, `BRIEF_SEND_HOUR` 9, riuso `PULSE_TIMEZONE`), `apps/worker/src/index.ts` (avvio + riga di riepilogo), `docker-compose.yml` (env)
- Modify: `packages/i18n/src/catalog.ts` (`brief.instructions`, `brief.section.*`)
- Test: `apps/worker/src/briefs/{poller,input,prompt}.test.ts`

**Step 1: test rosso** — finestra: lunedì 9:30 Europe/Rome → true, martedì → false, fuso invalido → lancia; progetto abilitato senza brief della settimana scorsa → riga `queued→running→done` con `summary` e `sections`; provider assente → `done` con `summary NULL`; run fallito → `attempts+1`, `failed` al terzo; `running` stantio → recuperato; input troncato con marcatore e report presi dai `summary`, mai dai commit; `parseBriefOutput` con sezione mancante → sezione vuota, non errore; `BRIEF_POLL_MINUTES=0` → poller non avviato.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(worker): brief settimanale per progetto`.

### Task 11: notifica `project.brief` e consegne

**Files:**
- Modify: `packages/notifications/src/format.ts` (`ProjectBriefEvent { kind, projectName, projectUrl, briefId, periodStart, periodEnd, headline }`, testo `notify.brief`), `packages/notifications/src/slack-blocks.ts` (section markdown con escape + Apri), `packages/notifications/src/push/payload.ts`, `packages/i18n/src/catalog.ts` (`notify.brief`, `push.title.project.brief`)
- Modify: `apps/worker/src/briefs/poller.ts` (publish **dopo** il commit del brief, poi `notification_id` sul brief; zero destinatari non è un errore)
- Modify: `apps/web/src/components/inbox-item.tsx` (label kind + link alla roadmap), `apps/web/src/i18n/locales/*/inbox.json`
- Test: `packages/notifications/src/format.test.ts`, `slack-blocks.test.ts`, `apps/worker/src/briefs/poller.test.ts`, **`apps/mobile/src/components/inbox/InboxCard.test.tsx`** (item con kind `UNKNOWN` → card informativa con testo e Apri, non nascosta) e `apps/mobile/src/lib/inbox-sections.test.ts` (UNKNOWN → "Dai progetti")

**Step 1: test rosso** — publish con audience admin+follower; payload webhook con `summary` markdown; Slack escape; app: UNKNOWN degrada.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(notifications): kind project.brief con consegna inbox, Slack, webhook, push`.

### Task 12: API dei brief, pagina web, MCP

**Files:**
- Modify: `packages/shared/src/schemas/project.ts` (`projectBriefWeeklySchema`), `apps/server/src/routes/projects.ts` (`GET /:projectId/briefs?limit=`, `POST /:projectId/briefs/generate` admin con `force`), nuova `apps/server/src/routes/briefs.ts` (`GET /api/briefs/:id`), `apps/server/src/routes/projects.ts` PATCH con `weeklyBriefEnabled`
- Modify: `apps/web/src/routes/projects/$projectId.tsx` (toggle "Brief settimanale"), `apps/web/src/routes/projects/$projectId.roadmap.tsx` (brief come separatori), nuova `apps/web/src/routes/briefs/$id.tsx` (vista brief con "Copia come testo" e "Rigenera" admin)
- Modify: `packages/api-client/src/endpoints/projects.ts` (`briefs`, `brief(id)`)
- Modify: `packages/mcp/src/client.ts`, `packages/mcp/src/tools/read.ts` (`get_project_brief`), `.changeset/*.md` (`@stubwise/mcp` minor), `.claude/skills/stubwise/SKILL.md` (menzione)
- Test: `apps/server/src/routes/projects.test.ts`, `apps/server/src/routes/briefs.test.ts`, `apps/web/src/routes/briefs/$id.test.tsx`, `packages/mcp/src/tools/read.test.ts`

**Step 1: test rosso** — lista brief ordinata per periodo desc; `generate` con brief `done` senza `force` → 409; con `force` → `queued`; member non follower → 404; MCP tool restituisce il markdown dell'ultimo brief o "nessun brief".
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(briefs): API, pagina web e tool MCP get_project_brief`.

## Fase E — Registro decisioni

### Task 13: writer automatici

**Files:**
- Create: `packages/db/src/decisions.ts` (`recordDecision(tx, { projectId, source, sourceKey, sourceRef, ticketId?, title, context?, decision, consequences?, decidedByUserId?, decidedAt })` con `onConflictDoNothing` sull'unique)
- Modify: `apps/server/src/services/questions.ts:224-255` (dopo l'UPDATE della domanda), `apps/server/src/services/jobs.ts:296-324` (approve: titolo ticket + `plan_summary` se c'è; reject: solo con istruzioni), `apps/server/src/services/pulse.ts:256-276` (voce scelta + alternative)
- Modify: `packages/i18n/src/catalog.ts` (`decision.askUser.title`, `decision.plan.approved`, `decision.plan.rejected`, `decision.pulse.proceed`, `decision.pulse.alternatives`)
- Test: `apps/server/src/services/{questions,jobs,pulse}.test.ts`, `packages/db/src/decisions.test.ts`

**Step 1: test rosso** — risposta a domanda → 1 decisione con attore, `consequences` dall'opzione, `source_key question:<id>`; seconda risposta impossibile (già coperta) ma replay di `recordDecision` con stessa chiave → 0 righe nuove; approve → decisione; reject con istruzioni → decisione = istruzioni; reject senza → nessuna; pulse proceed → decisione con alternative nel contesto; cancellazione del ticket → `ticket_id NULL`, riga viva.
**Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(decisions): registro alimentato da domande, piani e pulse`.

### Task 14: API, Docs, chat, MCP

**Files:**
- Modify: `packages/shared/src/schemas/project.ts` (`projectDecisionSchema`, `decisionDraftSchema`, `decisionPatchSchema`)
- Modify: `apps/server/src/routes/projects.ts` (`GET/POST /:projectId/decisions`, `PATCH /:projectId/decisions/:id` con regola autore-o-admin, `supersededById`), `apps/server/src/routes/project-docs.ts:178-257` (`highlights.latestDecisions`)
- Create: `apps/server/src/graph-chat/decisions.ts` (`retrieveDecisionContext(db, projectId, question) → string | null`, fail-open, top 5 per `to_tsvector('simple')` + recency), innestato in `project-docs.ts:430`, `docs-chat.ts`, `docs-rag.ts` accanto ad `appendGraphContext`
- Create: `apps/web/src/routes/docs/project.$projectId.decisions.tsx` (lista + form manuale + "segna come superata"), sezione "Decisioni" in `project.$projectId.tsx`; i18n `docs.decisions.*`
- Modify: `packages/api-client/src/endpoints/projects.ts`, `packages/mcp/src/tools/read.ts` (`list_decisions`), `packages/mcp/src/client.ts`, changeset
- Test: rotte, `decisions.test.ts` del graph-chat (DB senza decisioni → `null`; errore DB → `null` e log), web, MCP

**Step 1–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(decisions): API, sezione Docs, contesto nella chat, tool MCP list_decisions`.

## Fase F — Ondata 2 mobile, documentazione, consegna

### Task 15: app mobile legge i campi nuovi

**Files:**
- Modify: `apps/mobile/src/components/work/PlanSection.tsx:49-61` (`planSummary` con fallback al piano troncato; "Leggi il piano completo" invariato), `apps/mobile/src/screens/work/WorkScreen.tsx:155`, `apps/mobile/src/components/inbox/{PrReadyCard,PlanReviewCard}.tsx` (`item.summary` sotto il testo), `apps/mobile/src/screens/projects/ProjectDetailScreen.tsx` (sezione "Brief settimanale" da `client.projects.briefs(id, { limit: 1 })`, markdown, vuoto "Nessun brief ancora"), `apps/mobile/src/lib/timeline.ts:153-172` (date da `/tickets/:id/activity` per `planApproved`/`prReview`; verdetto da `reviews`), `apps/mobile/src/lib/inbox-sections.ts` (kind `project.brief` → "Dai progetti", card informativa con Apri → roadmap web via `url`)
- Modify: i18n it/en (`mobile.projects.detail.brief.*`, `mobile.work.plan.summaryFallback`)
- Test: i rispettivi `.test.tsx`; parity

**Step 1–4**: rosso → implementa → PASS (`pnpm --filter @stubwise/mobile test`).
**Step 5: Commit** `feat(mobile): riassunti in breve, brief settimanale, date reali nella timeline`.

### Task 16: documentazione e consegna

- `CLAUDE.md`: sezione Deploy **Fase 5** (migrazione 0068; rebuild server+worker+caddy insieme; env `BRIEF_*`, `SUMMARY_MODEL`, `SUMMARIES_ENABLED`; backfill `pnpm --filter @stubwise/server backfill:ticket-events` una volta, sul VPS dentro il container server; toggle brief per progetto; **rollback**: `BRIEF_POLL_MINUTES=0`/`SUMMARIES_ENABLED=false` innocui; immagine server precedente SOLO dopo `delete from notifications where kind='project.brief'` — stessa lezione della fase 2; worker precedente innocuo); invarianti nuove: "il registro decisioni non è mai scritto dall'AI", "plan_summary vive e muore con plan_text", "rotte letterali prima di `/:projectId`".
- `apps/docs` (guida): pagina "Roadmap, brief e decisioni".
- Changesets: `@stubwise/shared` minor, `@stubwise/mcp` minor.
- `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test`; `graphify update .`; push del branch; CI verde (incluso E2E); PR verso main.
- Report al maintainer: HEAD, link CI, decisione presa su dove vive la logica della timeline condivisa tra server e worker, e i passi manuali (backfill, toggle, changeset PR).

---

## Rischi e decisioni prese nel piano

- **Kind `project.brief`**: scelto consapevolmente (il ping è lo scopo della
  fase); costo di rollback documentato in CLAUDE.md, mitigazione
  `BRIEF_POLL_MINUTES=0`.
- **Timeline condivisa server/worker**: il brief ha bisogno degli stessi
  eventi della rotta. Preferisci un modulo puro in `packages/notifications`
  (già dipendenza di entrambi, come `project-signals`) e fai usare quello
  alla rotta; evita di duplicare le query.
- **Riassunto e ownership**: il riassunto del piano si genera prima del
  parcheggio e si scrive nello stesso UPDATE guardato; mai in un poller
  separato che rilegge `awaiting_plan_approval` (competerebbe sul serializer
  per-progetto).
- **Nessuna decisione scritta dall'AI**: i writer usano solo template; il
  brief e i riassunti sono narrativa, il registro è fatto.
