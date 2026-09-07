---
title: Fase 5 — fix di review prima del merge
date: 2026-09-07
design: 2026-09-06-phase5-roadmap-narrative-design.md
plan: 2026-09-06-phase5-roadmap-narrative-plan.md
stubwise:
  project: stubwise
  backlog: fd5129d8-347e-457a-9da8-86cfd7355b67
---

# Fase 5 — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> Lavora nel worktree esistente `.worktrees/phase5-roadmap-narrative` (branch
> `feature/phase5-roadmap-narrative`, PR #10, HEAD `e4f0569`). **Non**
> mergiare e **non** deployare. Il ticket #13 resta `in_review`. Alla fine:
> push sul branch, CI verde (incluso E2E), report con HEAD e link al run.

**Goal:** chiudere i findings della review indipendente della fase 5 (quattro
revisori: deploy, riassunti/brief, regressioni, decisioni/MCP/mobile). Tutti
piccoli; tre toccano invarianti dichiarate (compatibilità dell'app
installata, sicurezza dei blocchi Slack, immutabilità del registro).

**Convenzioni**: TDD (test rosso → fix → verde), commit piccoli in italiano
(`fix|test|docs(scope):`), `pnpm lint` dalla radice e `pnpm -r typecheck`
prima dell'ultimo commit. Le posizioni `file:riga` sono di HEAD `e4f0569`.

---

### Task 1: `weeklyBriefEnabled` non deve rompere l'app contro un server senza fase 5

**Finding**: `packages/shared/src/schemas/project.ts:111` dichiara
`weeklyBriefEnabled: z.boolean()` **obbligatorio** in `projectSchema`;
`projectListItemSchema` (`:173`) lo estende ed è lo schema con cui
`packages/api-client/src/endpoints/projects.ts:27,45` valida
`GET /api/projects` nell'app. `readerSchema` apre solo gli enum, non i campi
mancanti: l'app dell'ondata 2 contro un server senza fase 5 (rollback, o
un'istanza self-hosted non aggiornata: l'app è una per tutte) fallisce il
parse dell'intera lista progetti → tab Progetti e onboarding vuoti. È la
trappola `notificationPrefsViewSchema.push` della fase 4 in forma nuova.

**Files:**
- Modify: `packages/shared/src/schemas/project.ts:111` (`weeklyBriefEnabled: z.boolean().default(false)` — il server continua a emetterlo sempre; il client vecchio/nuovo lo legge con default)
- Modify: `CLAUDE.md` (la nota sul rollback della fase 5 dice che i campi nuovi sono tutti opzionali: ora è vero; aggiungi la regola generale «ogni campo nuovo in uno schema letto dall'app: `.optional()`/`.nullable()`/`.default()`, e un test che parsa una risposta SENZA il campo»)
- Test: `packages/api-client/src/endpoints/projects.test.ts` (o `packages/shared/src/schemas/project.test.ts`)

**Step 1: test rosso** — `projectListItemSchema.parse(<progetto senza weeklyBriefEnabled>)` deve riuscire con `weeklyBriefEnabled === false`; e via `readerSchema` come fa il client.
**Step 2–4**: rosso → fix → verde (`pnpm -r build && pnpm --filter @stubwise/shared test && pnpm --filter @stubwise/api-client test && pnpm --filter @stubwise/mobile test`).
**Step 5: Commit** `fix(shared): weeklyBriefEnabled con default, l'app regge un server senza fase 5`.

### Task 2: Slack — escape PRIMA del troncamento nelle `section` del riassunto

**Finding**: `packages/notifications/src/slack-blocks.ts:176`:
`escapeSlackMrkdwn(truncate(summary, SECTION_TEXT_MAX))` tronca a 3000 e POI
escapa (`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`), quindi il testo finale può
superare i 3000 caratteri della `section` mrkdwn. Il brief pubblicato è già
tagliato a esattamente 3000 (`BRIEF_EVENT_SUMMARY_MAX_CHARS`,
`apps/worker/src/briefs/poller.ts:67,418`): basta un `&` o un `->` in un
brief lungo e Slack risponde `invalid_blocks`, la delivery fallisce. Stesso
schema a `slack-blocks.ts:373` per le conseguenze delle opzioni (limite più
piccolo, rischio minore). Il test esistente usa un testo corto.

**Files:**
- Modify: `packages/notifications/src/slack-blocks.ts:176,373` (un helper `escapedSection(text, max)` = `truncate(escapeSlackMrkdwn(text), max)` — troncare DOPO l'escape, per code point, con margine per l'ellissi; usarlo in entrambi i punti)
- Modify: `apps/worker/src/briefs/poller.ts:418` (`slice(0, 3000)` → la `truncate` per code point di slack-blocks, o un helper condiviso: uno `slice` può spezzare una coppia surrogata e jsonb rifiuta il surrogato orfano → `publishNotification` lancia → brief senza notifica)
- Test: `packages/notifications/src/slack-blocks.test.ts`, `apps/worker/src/briefs/poller.test.ts`

**Step 1: test rosso** — summary di 3000 caratteri pieno di `&<>`: la `section.text.text` risultante è `<= 3000`; summary che finisce con un'emoji a cavallo del limite: nessun surrogato orfano (`Buffer.from(s, "utf8").toString() === s`).
**Step 2–4**: rosso → fix → verde.
**Step 5: Commit** `fix(notifications): escape prima del troncamento nelle section Slack`.

### Task 3: registro decisioni — le voci automatiche sono immutabili nel testo

**Finding**: `decisionPatchSchema` (`packages/shared/src/schemas/project.ts:548-554`)
ammette `title`/`decision`/`context`/`consequences` su qualunque voce, e
`canEditDecision` (`apps/server/src/services/project-decisions.ts:177-179`)
autorizza admin **o autore**: un member che ha risposto a una `ask_user` può
poi riscrivere il testo della decisione registrata (`patchDecision`
`:224-233` non distingue per `source`). Il design §6 prevede modifica del
testo solo per le voci `manual`; per le automatiche solo `supersededById`.
L'invariante «registro = fatto citabile senza riverificare» in CLAUDE.md
regge solo così.

**Files:**
- Modify: `apps/server/src/services/project-decisions.ts:224-233` (se `current.source !== "manual"` e il body contiene un campo di testo → 403 `decision_immutable` (o 422), con messaggio; `supersededById` resta ammesso per autore o admin)
- Modify: `packages/shared/src/schemas/project.ts:548-554` (commento: i campi di testo valgono solo per `manual`, il server lo impone)
- Modify: `apps/web/src/routes/docs/project.$projectId.decisions.tsx` (UI: bottone «Modifica» solo sulle manuali; sulle automatiche solo «Segna come superata»)
- Test: `apps/server/src/routes/projects.test.ts:1089` (sdoppia: manuale modificabile dall'autore; automatica `ask_user` → PATCH del testo 403 anche dall'autore, `supersededById` ok), `apps/web` test della pagina

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `fix(decisions): il testo delle decisioni automatiche è immutabile, solo supersede`.

### Task 4: toggle `notifyBrief` esposto in Impostazioni → Notifiche (o CLAUDE.md corretto)

**Finding**: la colonna `notification_settings.notify_brief` esiste
(migrazione, `schema.ts:1029`) ed è letta dal dispatch del webhook
(`dispatch.ts:56,92,125`), ma `apps/server/src/routes/settings.ts` non ha
`notifyBrief` né nello schema di risposta né nel body (gli altri toggle sì:
`notifyPlanReview` a `:89,119,232,445`), e la web non lo mostra. CLAUDE.md
dice «è il toggle d'istanza del kind, in Impostazioni → Notifiche»: falso.

**Files:**
- Modify: `apps/server/src/routes/settings.ts` (pattern di `notifyPlanReview`: campo nello schema di risposta **`.default(true)`**/opzionale, nel body opzionale, nell'UPDATE), `packages/shared` se lo schema vive lì, `apps/web/src/routes/settings/notifications.tsx` (o dove stanno i toggle: checkbox «Brief settimanale» con i18n it/en)
- Test: `apps/server/src/routes/settings.test.ts`, test web dei toggle

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `feat(settings): toggle webhook per il brief settimanale`.

### Task 5: finestra degli orfani del brief coerente col timeout del run

**Finding**: `staleMinutes` è fisso a 30 (`DEFAULT_BRIEF_STALE_MINUTES`,
`apps/worker/src/briefs/poller.ts:59`) mentre il run usa
`config.prReviewTimeoutMs` (default 15'): se `PR_REVIEW_TIMEOUT_MINUTES`
supera 30, un brief legittimamente in corso viene riportato `queued`,
ri-claimato da un altro tick, e il primo run completa comunque → due `done`
e due `publishBrief` (due notifiche per lo stesso brief).

**Files:**
- Modify: `apps/worker/src/briefs/poller.ts:59` (`staleMinutes = max(30, ceil(agentTimeoutMs / 60_000) * 2)`, calcolato da `startBriefPoller` a partire dal timeout reale; e nel tick, prima di `publishBrief`, un UPDATE guardato `status = 'running' AND id = … AND attempts = <claim>` così un run "fantasma" non pubblica)
- Modify: `apps/worker/src/briefs/input.ts:90` (nit 5 della review: `job_in_flight` NON è un blocco che richiede il lettore — escludilo dai `blocks` del prompt o glossalo «in corso, nessuna azione richiesta», così `<<NEED>>` non inventa interventi)
- Test: `apps/worker/src/briefs/poller.test.ts` (timeout 40' → stale a 80'; run fantasma dopo recovery → nessuna seconda notifica), `input.test.ts`

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `fix(briefs): orfani coerenti col timeout, nessuna doppia notifica, job in corso non è un blocco`.

### Task 6: push, CI verde, report

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` nel worktree → verde. Se i test web sono di nuovo flaky sotto carico (la review ha visto 3 fallimenti al primo run, verdi al secondo), **cattura i nomi** dei test e mettili nel report: è il secondo flaky in due fasi.
2. `graphify update .` e commit del grafo se l'hook non l'ha fatto.
3. `git push` sul branch; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report al maintainer: HEAD finale, link al run, conferma esplicita dei sei task, nomi degli eventuali test flaky. Poi fermati: merge e deploy non sono tuoi.

---

## Fuori da questo piano (backlog, non ora)

- **Costi dei run di riassunto non contabilizzati**: `runAgentText`
  (`apps/worker/src/agent/text.ts:65-74`) scarta `result.usage`; nel fix
  `recordAllUsages()` gira prima di `generatePlanSummary` (`fix.ts:1808` vs
  `:1880`), nella review `recordReviewRun` precede il riassunto, il poller
  del brief non registra nulla → tre run AI fuori da `agent_runs`, dal costo
  per ticket e dal budget mensile. Far restituire `usage` e registrarlo.
- **Chiave del riassunto PR** `${ticketId}|${prUrl}`
  (`apps/server/src/services/inbox.ts:927-965`): `pr_reviews.pr_url` viene
  dal webhook, `event.prUrl` dall'API del provider; forme diverse (slash
  finale, host) → riassunto assente in silenzio. Normalizzare, o cadere
  sull'ultima review del ticket.
- `GET /:projectId/decisions` senza `cursor` (solo `limit` max 200):
  accettabile in v1.
- `planReviewRound` con `LIKE 'plan_review:<jobId>:%'` senza `project_id`:
  seq scan innocuo oggi.
- `POST /briefs/generate` non controlla `weeklyBriefEnabled`: accettabile,
  documentare.
- UI del toggle brief: avvisare che senza report giornalieri
  (`dailyReportEnabled`) il brief ha poco da dire.
- Test web flaky sotto carico (3/982 al primo run): da identificare.
- Rumore `ECONNREFUSED :3000` nei test web delle chat (chiamate reali non
  mockate).
