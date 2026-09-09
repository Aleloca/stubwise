---
title: Fase 7 — fix di review prima del merge
date: 2026-09-09
design: 2026-09-09-phase7-guided-workflow-design.md
plan: 2026-09-09-phase7-guided-workflow-plan.md
stubwise:
  project: stubwise
  backlog: 6b49f888-ecc6-413d-ac58-5b4da8cc2411
  ticket: https://stubwise.thecove.it/tickets/0804eba7-2b09-4faf-bbb7-ebe33eee2a28
---

# Fase 7 — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> Lavora nel worktree esistente `.worktrees/phase7-guided-workflow` (branch
> `feature/phase7-guided-workflow`, PR #16, HEAD `d986946`). **Non** mergiare e
> **non** deployare. Alla fine: push, CI verde (incluso E2E), report con HEAD e
> link al run. Le posizioni `file:riga` sono di HEAD `d986946`.

**Goal:** chiudere i findings della review indipendente (tre revisori:
permessi e divieti, Fase B, regressioni e deploy). **Nessuno è bloccante**: due
sono difetti di comportamento piccoli ma reali sull'utente della fase 7
(l'operatore non tecnico), tre sono buchi di copertura proprio sui due divieti
— cioè sull'invariante di prodotto di questa fase.

**Convenzioni**: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
typecheck` prima dell'ultimo commit.

---

### Task 1: fermare la sessione chiude la domanda aperta

**Finding (severità bassa, verificato di persona)**: `closeOpenBacklogQuestion`
è chiamata su archiviazione, merge e conversione (`routes/backlog.ts:743`,
`:1586`, `services/backlog.ts:120`) ma **mai** sullo stop della sessione di
analisi (`DELETE /:id/code-session`, `routes/backlog.ts:1311`). Scenario:
l'agente pone una domanda, l'operatore ferma la sessione, la chat torna in
modalità DOCS — e il testo libero resta bloccato, perché `sendDisabled`
include `openQuestion !== null` (`backlog-chat.tsx:443`) indipendentemente
dalla modalità. Non è un vicolo cieco (il `QuestionPanel` e «non ora» restano
resi, quindi l'uscita è a un click), ma è l'unico punto della fase in cui
fermare una sessione lascia la chat in uno stato che l'utente non ha chiesto —
ed è proprio l'utente che la fase 7 esiste per servire.

**Perché lato server e non lato web**: nascondere il pannello quando la
modalità è DOCS mascherebbe il sintomo lasciando una riga aperta in
`backlog_questions`, che poi collide con l'unique parziale alla sessione
successiva. La domanda va **chiusa**, come per le altre tre uscite.

**Files:**
- Modify: `apps/server/src/routes/backlog.ts` (nella transazione di
  `DELETE /:id/code-session`, dopo la chiusura della sessione, chiamare
  `closeOpenBacklogQuestion(tx, id)`; motivo a commento: fermare la sessione
  è un'uscita come le altre tre)
- Test: `apps/server/src/routes/backlog.test.ts` (domanda aperta + stop della
  sessione → la domanda risulta `dismissed`; stop senza domanda aperta →
  invariato, nessun errore)

**Step 1: test rosso** → **Step 2–4**: rosso → fix → verde.
**Step 5: Commit** `fix(backlog): fermare la sessione chiude la domanda aperta`.

### Task 2: nessuna domanda nasce su una voce già chiusa

**Finding (severità minore)**: lo stato della voce è verificato **all'inizio**
del turno (`chat-turn.ts:298-303`) ma non riverificato prima dell'insert della
domanda (`:572`). Un turno dura minuti: una conversione o un'archiviazione che
arriva nel frattempo trova `closeOpenBacklogQuestion` già passata, e la
domanda viene scritta **dopo**, su una voce chiusa. Il design §4 promette
l'opposto («una voce che sparisce non lascia domande dietro»). Recuperabile a
mano con «non ora», quindi non bloccante, ma la promessa è scritta.

**Files:**
- Modify: `apps/server/src/services/backlog-questions.ts` (l'insert della
  domanda diventa condizionato allo stato della voce — `WHERE EXISTS` sullo
  stato non terminale, oppure una rilettura dentro la stessa transazione: la
  forma la scegli tu, purché sia **una sola** istruzione atomica e non un
  controllo-poi-scrivi. Se la voce non è più aperta, l'insert non avviene e la
  funzione lo comunica al chiamante)
- Modify: `apps/worker/src/backlog/chat-turn.ts:572-593` (il caso «domanda non
  scritta perché la voce è chiusa» si degrada come il caso della violazione di
  unique già gestito lì: prosa, riga di log, turno che **non** esplode)
- Test: `backlog-questions.test.ts` (voce convertita/archiviata fra l'inizio
  del turno e l'insert → nessuna riga in `backlog_questions`),
  `chat-turn.test.ts` (il turno finisce verde con il degrado in prosa)

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `fix(backlog): nessuna domanda nasce su una voce già chiusa`.

### Task 3: i due divieti hanno la prova end-to-end che meritano

Tre buchi di copertura sull'invariante di prodotto della fase. Il codice è
corretto — l'ho verificato di persona — ma è garantito dalla lettura, non da
un test, e questa è l'unica parte della fase che non deve poter regredire.

1. **Revoca → il gate torna a chiudersi.** `tickets.test.ts:2408-2434` prova
   che il DELETE azzera i tre campi, ma nessun test fa partire un run di un
   member **dopo** la revoca e verifica che il job nasca in
   `awaiting_plan_approval`. È la seconda delle due strade di uscita dalla
   pre-approvazione (l'altra — piano modificato, digest che non torna — è già
   coperta): va coperta anche questa. → `apps/server/src/services/jobs.test.ts`
2. **`proceedWithProposal` su un ticket pre-approvato.** `pulse.ts:325` passa
   `requirePlanApproval: true` esplicito e per costruzione vince sull'OR, ma
   nessun test esercita l'incrocio fra le due feature. Un test che parta da un
   ticket **con** piano pre-approvato e asserisca `awaiting_plan_approval`. →
   `apps/server/src/services/pulse.test.ts`
3. **`decisions-never-ai.test.ts`, giro runtime.** Il controllo sul sorgente
   copre già `preApprovePlan` (sta in `jobs.ts`, già nell'elenco `MODULES`), ma
   il giro **runtime** — le spie sull'SDK Anthropic a zero mentre i writer
   girano davvero contro un Postgres vero — esercita `answerQuestion`,
   `resolvePlan`, `proceedWithProposal`, `answerGoogleProposal` e **non**
   `preApprovePlan`. L'invariante promette due piani, il writer nuovo ne ha
   uno. Cinque righe. → `apps/server/src/services/decisions-never-ai.test.ts`

**Step 1: i tre test, rossi o verdi che siano** (i primi due dovrebbero
nascere verdi: stanno fissando un comportamento già corretto — verifica che
falliscano se **inverti** la condizione nel sorgente, altrimenti non
discriminano; vedi la trappola del mutation testing in CLAUDE.md).
**Step 2: Commit** `test(fase7): i due divieti dell'operatore hanno una prova end-to-end`.

### Task 4: tre rifiniture

- **Bolla assistant vuota** (`chat-turn.ts:594-602`): quando la domanda è
  scartata (unique o malformata) e l'agente aveva già chiuso il turno,
  `questionMessageContent` resta `""` e si scrive comunque un messaggio
  `assistant` vuoto; `chat-turn.test.ts:821` lo fissa come voluto. Per un
  operatore non tecnico è una bolla vuota senza spiegazione: o non si scrive il
  messaggio, o si scrive una riga di prosa da i18n. Aggiorna il test di
  conseguenza (la riga da cambiare è la scelta, non il test — ma qui la scelta
  è sbagliata).
- **Copy del tetto delle domande** (`ask-user-mcp/server.ts:68-70`):
  `cappedMessage` rimanda alla sezione «Decisioni e assunzioni» **del piano**,
  che nella chat di analisi del backlog non esiste. Il server MCP è condiviso
  fra i due usi: rendi la frase neutra rispetto al deliverable, o
  parametrizzala come già si fa per il resto del contesto.
- **Commento impreciso** (`apps/web/src/lib/queries.ts:389`): dice che
  `["projects","pulse"]` è «una chiave a sé, non sotto `["projects"]`»; in
  TanStack Query è invece un figlio per prefisso, quindi invalidare
  `["projects"]` rifetcha anche il polso. Comportamento innocuo, commento da
  correggere.

**Commit** `chore(fase7): rifiniture di review — bolla vuota, copy del tetto, commento sulle query key`.

### Task 5: changeset per `@stubwise/shared`

La fase modifica `packages/shared` (7 file, tutto additivo: `failureSummary`,
i tre campi di pre-approvazione, il payload `chat_turn` a unione,
`handledBySchema` estratto in `actor.ts`) e **non c'è nessun changeset**:
`@stubwise/shared` resterebbe a 0.4.0 su npm. Non blocca il deploy
dell'istanza — server, worker e web leggono il workspace, non npm — e la fase
non aggiunge tool MCP, ma il pacchetto pubblicato divergerebbe in silenzio.

Aggiungi un changeset `minor` per `@stubwise/shared` (solo quello:
`@stubwise/mcp` non cambia superficie in questa fase) con una riga che dica
cosa è entrato.

**Commit** `chore(changeset): @stubwise/shared minor per i campi della fase 7`.

### Task 6: push, CI verde, report

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` nel worktree → verde.
2. `graphify update .` e commit del grafo se serve; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report al maintainer: HEAD finale, link al run, conferma dei cinque task,
   eventuali flaky con i nomi.

---

## Fuori da questo piano (backlog, non ora)

- **Test di concorrenza incompleto** su `answerBacklogQuestion`
  (`backlog-questions.test.ts:335`): asserisce 1 vincitore, 1
  `already_answered` e 1 solo messaggio system, ma non conta i `backlog_jobs`,
  perché la voce del test non ha una sessione `active` e il ramo del job non è
  esercitato. Corretto per costruzione (l'insert del messaggio e del job stanno
  nella stessa transazione, dopo l'UPDATE guardato), non provato.
- **`permissionMode` in `failure-summary.ts:24`**: il docblock rivendica
  `"plan"` come scelta corretta, mentre la dottrina in CLAUDE.md per il testo
  non fidato dice `"default"`. È **preesistente**, ereditato da
  `plan-summary.ts`/`pr-summary.ts` via il default di `agent/text.ts:70`, non
  una regressione della fase 7; il rischio è basso (cwd temporanea vuota,
  nessun tool, 3 turni). Da uniformare quando si tocca `runAgentText`, in una
  voce sua.
- **Nessun E2E per i percorsi nuovi** (pre-approvazione, domande nella chat):
  `apps/web/e2e` è a zero righe di diff. La suite esistente è passata, quindi
  nessuna regressione; la copertura E2E dei flussi nuovi è un lavoro a sé.
