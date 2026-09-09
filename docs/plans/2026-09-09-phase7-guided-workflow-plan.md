---
title: Fase 7 — Workflow guidato — piano di implementazione
date: 2026-09-09
design: 2026-09-09-phase7-guided-workflow-design.md
stubwise:
  project: stubwise
  backlog: 6b49f888-ecc6-413d-ac58-5b4da8cc2411
  ticket: https://stubwise.thecove.it/tickets/0804eba7-2b09-4faf-bbb7-ebe33eee2a28
---

# Fase 7 — Workflow guidato: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Prima del Task 1**: `/stubwise:start` sulla voce di backlog nel
> frontmatter del design doc. Worktree `feature/phase7-guided-workflow`.
> Alla fine: `git merge origin/main`, push, CI verde (incluso E2E), PR verso
> main; merge e deploy li fa il maintainer.
>
> **I due divieti sono invarianti di prodotto, non dettagli**: un operatore
> non può approvare un piano né rilasciare in produzione. Nessun task può
> allentarli, e i test devono provarlo in negativo.

**Goal:** rendere percorribile da un operatore non tecnico il percorso idea →
modifica pronta, dalla sola web app: sbloccare le azioni chiuse senza motivo,
guidare con bottoni invece che con prosa libera, permettere al maintainer di
approvare un piano in anticipo, e parlare italiano quando qualcosa si ferma o
fallisce.

**Architecture:** nessun flusso nuovo. Si aprono permessi esistenti, si porta
`QuestionPanel` (già progettato per essere ospitato altrove) dentro la chat
del backlog con un'ancora nuova gemella di `agent_questions`, si aggiunge una
pre-approvazione del piano basata sul digest del testo, e si adotta sul web il
vocabolario umano che esiste già nel pacchetto condiviso.

**Tech Stack:** Fastify + Zod + Drizzle, React SPA, worker (`runAgentText`,
turno di chat CLI con MCP), `packages/shared`, `packages/i18n`.

**Convenzioni (ereditate)**: TDD; commit piccoli in italiano; migrazioni SQL a
mano + journal; campi nuovi negli schemi di risposta sempre opzionali con un
test che parsa senza il campo; i18n en+it con parità; `pnpm -r build` dopo
`packages/*`; `pnpm lint` prima del merge; il modulo che scrive nel registro
decisioni non importa mai esecutori AI.

---

## Fase A — Permessi e pre-approvazione

### Task 1: sbloccare le cinque azioni

**Files:**
- Modify: `apps/server/src/routes/backlog.ts` — da `requireAdmin` a `requireAuth`: `PATCH /:id` (`:604`), `POST /:id/suggested/accept` (`:902`) e `/dismiss` (`:946`), `POST /:id/refresh-document` (`:1278`), `POST /:id/merge` (`:1418`), `POST /:id/deep-dive` (`:1523`)
- Modify: `apps/web/src/routes/backlog/$id.tsx:150,283,311` (`metaDisabled` non più legato al ruolo; `ActionsPanel` visibile a tutti; banner dei suggeriti visibile)
- Test: `backlog.test.ts` (un member esegue ciascuna delle sei rotte); **e in negativo**: `tickets.test.ts` — `approve-plan` e `reject-plan` restano 403 per un member

⚠️ `refresh-document` e `deep-dive` fanno girare l'AI: la scelta di aprirle è consapevole (design §3), va annotata in `CLAUDE.md` nel Task 12.

**Step 1: test rosso** → **Step 2–4**: rosso → implementa → PASS.
**Step 5: Commit** `feat(backlog): le azioni quotidiane non sono più riservate ai maintainer`.

### Task 2: migrazione 0072 e pre-approvazione del piano

**Files:**
- Create: `packages/db/drizzle/0072_guided_workflow.sql`; Modify: `meta/_journal.json` (idx 72)
- Modify: `packages/db/src/schema.ts` (`tickets`: `plan_approved_at timestamptz`, `plan_approved_by_user_id uuid` FK SET NULL, `plan_approved_digest text`; `ai_jobs.failure_summary text`; tabella `backlog_questions` come da design §4 con CHECK e unique parziale)
- Test: `packages/db` (unique parziale «una sola domanda aperta per voce»; CHECK della risposta; cascade dalla voce)

Nessun enum nuovo: un solo batch.

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(db): migrazione 0072 — pre-approvazione del piano, domande di backlog, riassunto dei fallimenti`.

### Task 3: il gate legge la pre-approvazione

**Files:**
- Create: `packages/db/src/plan-digest.ts` (`planDigest(text): string` — SHA-256, funzione pura condivisa fra server e worker)
- Modify: `apps/server/src/services/jobs.ts:131-148` (`planPreApproved` = `plan_approved_at != null && plan_approved_digest === planDigest(ticket.implementationPlan)`; `needsApproval = (actor.role === "member" && !planPreApproved) || input.requirePlanApproval === true`; il commento del docblock va aggiornato, è la fonte di verità del gate)
- Create: `apps/server/src/routes/tickets.ts` — `POST /:id/pre-approve-plan` e `DELETE /:id/pre-approve-plan` (`requireAdmin`; 409 `no_plan` senza piano; registra in `project_decisions` con `source: "plan_review"` e testo da template i18n `decision.plan.preApproved`)
- Modify: `packages/shared/src/schemas/ticket.ts` (`ticketDetailSchema`: `planApprovedAt`, `planApprovedBy`, `planApprovalStale` — **tutti opzionali/nullable**, con test che parsa senza)
- Modify: `packages/i18n/src/catalog.ts` (en+it)
- Test: `jobs.test.ts` (member + piano pre-approvato → job `queued` che esegue; member + piano modificato dopo l'approvazione → `awaiting_plan_approval`; `requirePlanApproval: true` vince sempre sulla pre-approvazione; maintainer invariato), `tickets.test.ts` (member che chiama pre-approve → 403; due pre-approvazioni concorrenti → una sola decisione registrata; revoca)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(plans): un piano approvato in anticipo fa partire il lavoro anche a un operatore`.

### Task 4: la pre-approvazione nell'interfaccia del ticket

**Files:**
- Modify: `apps/web/src/routes/tickets/$id.tsx` (bottone «Approva il piano in anticipo» per i maintainer accanto al piano; riga di stato: «Piano approvato da {nome} il {data}, pronto per partire» / «Piano modificato dopo l'approvazione: serve un nuovo via libera»; per l'operatore, l'avviso `memberRunHint` diventa condizionale — se il piano è pre-approvato, «il lavoro partirà davvero»)
- Modify: i18n web en+it
- Test: web

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(web): stato della pre-approvazione sul ticket`.

## Fase B — Conversazione guidata

### Task 5: domande ancorate alla voce di backlog

**Files:**
- Create: `apps/server/src/services/backlog-questions.ts` (`askBacklogQuestion(tx, …)`, `answerBacklogQuestion(db, {questionId, actor, answer})` — gemello di `answerQuestion` (`services/questions.ts:239-293`): UPDATE guardato su `answered_at IS NULL`, validazione dell'indice **per range contro le opzioni persistite**, errori tipizzati `not_found | already_answered | invalid_answer | question_not_pending`; `dismissBacklogQuestion` per «non ora»)
- Create: rotte `POST /api/backlog/:id/questions/:questionId/answer` e `/dismiss` (`requireAuth`)
- Modify: `apps/server/src/routes/backlog.ts` — `POST /:id/convert` e l'archiviazione chiudono le domande aperte **nella stessa transazione** (`dismissed_at`)
- Modify: `packages/shared/src/schemas/backlog.ts` (`backlogQuestionSchema`, riusando la forma di `inboxQuestionSchema` così `QuestionPanel` la consuma senza adattatori)
- Test: `backlog-questions.test.ts` (due risposte concorrenti → una sola vince; indice fuori range → `invalid_answer`; «non ora» chiude senza rispondere; conversione e archiviazione chiudono le domande aperte; una seconda domanda aperta sulla stessa voce → violazione dell'unique)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(backlog): domande a opzioni ancorate alla voce, con uscita sempre disponibile`.

### Task 6: l'agente della modalità CODE può porre una domanda

**Files:**
- Modify: `apps/worker/src/backlog/chat-turn.ts` (cabla `mcpConfig` con il server `ask_user` esistente — `buildAskUserRunConfig` è indipendente da `runFix`; file-bridge in una dir della sessione; l'allowlist dei tool va **ripassata a ogni run anche in `--resume`**, non persiste nella sessione)
- Modify: `apps/worker/src/backlog/chat-turn.ts` (se il turno produce una domanda: la scrive in `backlog_questions` e come messaggio di chat che la referenzia, invece della risposta in prosa; la sessione CLI resta viva per la ripresa)
- Modify: `apps/worker/src/backlog/chat-turn.ts` (alla risposta: il turno successivo riprende con `--resume` includendo la scelta, come fa `runPlanResume` in `fix.ts:1240-1281`)
- Test: `chat-turn.test.ts` (turno che pone una domanda → riga in `backlog_questions` + messaggio, nessuna risposta in prosa; risposta → turno successivo con la scelta nel prompt; domanda malformata → si prosegue in prosa; tetto di round)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(worker): l'agente della chat può chiedere invece di indovinare`.

### Task 7: bottoni nella conversazione e passo successivo

**Files:**
- Modify: `apps/web/src/components/backlog-chat.tsx` (rende `QuestionPanel` dentro la bolla quando il messaggio referenzia una domanda aperta; «non ora» come azione secondaria; la scelta fatta **resta scritta** nella conversazione come messaggio)
- Create: `apps/web/src/components/work-next-step.tsx` (la riga del passo successivo sopra la conversazione: stato derivato **dal sistema** da voce + ticket + job, con il bottone che lo fa; nessun testo generato da modello)
- Modify: `apps/web/src/routes/backlog/$id.tsx` (monta la riga; il bottone «Converti» vive anche lì)
- Modify: i18n web en+it (`backlog.nextStep.*`)
- Test: web (ogni stato del percorso mostra la frase e il bottone giusti; la domanda si rende dentro la conversazione; rispondere aggiorna il passo; «non ora» chiude la domanda e lascia la conversazione)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(web): la conversazione guida al passo successivo`.

## Fase C — Linguaggio

### Task 8: `workStateFor` sul web

**Files:**
- Modify: `apps/web/src/components/ai-job-timeline.tsx` e `components/badges.tsx` (adottano `workStateFor` da `@stubwise/shared`)
- Modify: `apps/web/src/i18n/locales/{en,it}.json` (chiavi degli 11 stati, portate da `apps/mobile/src/i18n/*.json`)
- Test: web + parità i18n

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(web): gli stati del lavoro in parole, non in gergo di coda`.

### Task 9: riassunto del fallimento

**Files:**
- Create: `apps/worker/src/summaries/failure-summary.ts` (`buildFailureSummaryPrompt(lang, {ticketTitle, phase, errorExcerpt, logTail})`, `generateFailureSummary` con `runAgentText`, `permissionMode "plan"`, tetto sull'input, best-effort)
- Modify: `apps/worker/src/pipeline/fix.ts` (quando il job entra in `failed`, genera e scrive `failure_summary` **fuori transazione**, best-effort: se fallisce, `null` e nulla degrada)
- Modify: `packages/i18n/src/catalog.ts` (`summary.failure.instructions` en+it: cosa si stava facendo, cosa non ha funzionato, cosa si può fare adesso, e **dire esplicitamente quando serve un maintainer**)
- Modify: `packages/shared/src/schemas/ai-job.ts` (`failureSummary` opzionale), `apps/web/src/components/ai-job-timeline.tsx` (mostra il riassunto sopra il log, che resta accessibile)
- Test: worker (generato su fallimento; runner fallito → `null` e job comunque `failed`; input troncato), shared (parsa senza il campo), web

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(jobs): spiegare in italiano perché un lavoro è fallito`.

### Task 10: navigazione filtrata e vista «cosa aspetta me»

**Files:**
- Modify: `apps/web/src/components/app-layout.tsx:27-44` (voci filtrate per ruolo), `apps/web/src/router.tsx` (guardie `beforeLoad` coerenti)
- Modify: `apps/web/src/routes/projects/index.tsx` (consuma `GET /api/projects/pulse`; le frasi sono quelle di `apps/mobile/src/lib/pulse-line.ts`, da portare in una funzione pura condivisa se conviene)
- Modify: i18n web
- Test: web (un member non vede le voci riservate; la riga di polso per i quattro stati)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(web): niente porte chiuse nel menu, e il polso dei progetti`.

## Fase D — Consegna

### Task 11: documentazione e consegna

- `CLAUDE.md`: la fase 7 (cinque aperture con la nota sul costo di
  `refresh-document` e `deep-dive`; pre-approvazione col digest e la regola
  che decade da sola; domande ancorate alla voce con l'uscita obbligatoria;
  `workStateFor` ora usato anche dal web; riassunto dei fallimenti). Invariante
  nuova: **i due divieti dell'operatore** (piano non approvato, produzione),
  con il puntatore alla riga di `jobs.ts` che li implementa.
- `apps/docs`: guida «Lavorare in Stubwise senza scrivere codice» — il
  percorso completo dal punto di vista dell'operatore, e cosa succede quando
  qualcosa si ferma.
- Suite completa, `graphify update .`, `git merge origin/main`, push, CI
  verde, PR, report (HEAD, run, eventuali flaky con i nomi).

---

## Rischi e decisioni prese nel piano

- **Il gate non si tocca**: la pre-approvazione è una scelta esplicita del
  maintainer su un piano specifico, non un allentamento del ruolo. Il digest
  garantisce che si esegua ciò che è stato letto.
- **Domande solo nella modalità CODE** in v1: la modalità DOCS richiederebbe
  di cambiare il trasporto SSE.
- **Uscita obbligatoria dalle domande**: «non ora» sempre presente e chiusura
  automatica su conversione e archiviazione. Il sistema ha già pagato una
  volta il prezzo di domande senza via d'uscita.
- **Il passo successivo è deterministico**, non generato: una frase sbagliata
  su «cosa fare adesso» è peggio di nessuna frase.
- **Aprire le azioni che spendono** è consapevole: la protezione è il budget
  mensile dell'istanza, non il ruolo.
