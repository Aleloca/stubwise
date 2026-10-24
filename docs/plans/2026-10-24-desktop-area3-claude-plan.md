# App desktop, area 3: Claude come collega — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` l'area 3: la conversazione
con Claude (un componente unico, in diretta), la conversazione libera, le
sessioni di lavoro (task, refine, automatiche), proposte da confermare,
domande e piani nel flusso, la destinazione «Claude», le conversazioni
pubbliche e la rassegna del giorno per persona.

**Architecture:** Il modello delle conversazioni è un **elenco di eventi**
(`data/model.ts`) prodotti da un **motore di stream finto**
(`data/stream.ts`) che li emette nel tempo; la conversazione libera passa da
un **motore di intenti** puro (`domain/claude/intents.ts`) che legge i dati
**come la persona** e produce testo, righe d'azione, citazioni e proposte;
le proposte confermate eseguono le **mutazioni esistenti** con la sessione
della persona, quindi i permessi restano quelli del livello dati. La UI è un
componente `pages/claude/conversation/*` riusato da destinazione Claude,
dettaglio task e Requests.

**Tech Stack:** quello delle aree 1–2. Nessuna dipendenza nuova salvo, se
serve, un renderer markdown già presente (`tasks-ui/Markdown.tsx`, da
estendere per blocchi di codice e tabelle).

**Spec:** `docs/plans/2026-10-24-desktop-area3-claude-design.md` (approvato
24 ott 2026). Contesto: design area 2, `apps/desktop/DESIGN.md`,
`docs/invariants/agent-sessions.md`, `docs/invariants/backlog-refine.md`,
`apps/desktop/docs/web-inventory.md` (Agents, ticket detail AI, Inbox
domande/piani, refinement, Activity).

## Global Constraints

- Tutte le Global Constraints dell'area 2 restano (nessuna rete; en/it con parità; temi chiaro/scuro; niente monospace salvo logo **e blocchi di codice/percorsi nel flusso**, che usano il monospace di sistema solo dentro il codice; codice sempre con nome; colore mai unico segnale; movimento 150–250 ms con `prefers-reduced-motion`; pagine solo via `data/queries.ts`; stati completi; lint/typecheck/test verdi a ogni commit; Impeccable obbligatorio per ogni task con UI, shape approvati vincolanti).
- **Claude agisce come la persona:** ogni lettura o azione del motore passa dalle funzioni del livello dati con la sessione di chi conversa; nessun permesso deciso nel motore o nel componente.
- **Modifiche ai dati di Stubwise = proposta da confermare** (Conferma / Modifica / Annulla); i prodotti della pipeline (codice, design/piano del refine) seguono le regole di oggi e compaiono come righe già eseguite.
- **Proposta confermabile solo da chi l'ha chiesta**; scade dopo 20 messaggi successivi o 24 ore («Non eseguita»).
- Regole server di oggi invariate: `canWrite`/`canInterrupt`/`canAnswer` calcolati nel livello dati; piano approvabile solo con `plans.approve`; rispondere a una domanda: richiedente o `plans.approve`; scrivere nel refine: `backlog.edit`; vedere una sessione di lavoro: `repos.view` nel progetto (refine: `backlog.edit`); sessioni di posta: solo il titolare.
- Permessi nuovi (prototipo, `data/viewer.ts`): `claude.public.view` (d'istanza, di base a preset User e Admin) e `people.activity.view` (d'istanza, di base a full admin e a chi è Project Lead in almeno un progetto); assegnabili a qualunque ruolo.
- Copy: niente marchio o stile grafico di Anthropic; nessuna parola da prototipo («area N», «finto») nell'interfaccia.

## Review Focus

1. **Cambio di persona durante uno stream**: lo stream della persona precedente smette di disegnare, nessun suo testo resta; la conversazione privata di un altro non è più visibile. → test in Task 2 e Task 5.
2. **Continuare una conversazione pubblica altrui**: nasce una continuazione privata di chi scrive; le letture e le proposte di Claude usano i permessi del nuovo utente; il proprietario originale non vede la continuazione. → test in Task 4 e Task 6.
3. **Proposta confermata dopo aver perso il permesso** (o su un oggetto cambiato/cancellato): la conferma fallisce con un messaggio chiaro nel flusso, nessuna scrittura parziale. → test in Task 4.
4. **Stessa domanda in due posti** (conversazione e «Da decidere»): rispondere in uno la chiude nell'altro; risposte concorrenti → la seconda riceve «già risposta da …». → test in Task 9.
5. **Contenuti estremi nel flusso**: markdown lungo, blocchi di codice larghi, percorsi lunghi, 200+ righe d'azione, riconnessione a metà messaggio: nessun overflow orizzontale della pagina, nessun testo duplicato o perso. → test in Task 2 e Task 5.

---

### Task 0 (controller): shape di Impeccable

Prima dei task con UI il controller fa produrre con Impeccable `shape` i brief di: conversazione (flusso, righe d'azione, schede proposta/domanda/piano, casella con allegati, «#», «@», «/»), destinazione Claude (colonna, elenco, pagina, pubblica/continua), sezione Claude della task, refine, rassegna per persona; li sottopone al maintainer e li salva in `apps/desktop/.impeccable/shape/{conversation,claude-destination,task-claude,refine,people-activity}.md`. Nessun codice.

### Task 1: Modello, permessi e seed delle conversazioni

**Files:** Modify `data/model.ts`, `data/viewer.ts` (+test), `data/seed/*`; Create `data/seed/conversations.ts`, `data/seed/commands.ts`, `data/seed/commits.ts`; Test `data/seed.test.ts`.

**Interfaces — Produces (in `model.ts`):**
```ts
export type ConversationKind = "free" | "task_run" | "refine" | "pr_review" | "docs" | "brief" | "daily_report" | "mail_classify" | "intake";
export type ConversationState = "working" | "awaiting_answer" | "awaiting_approval" | "paused" | "idle" | "finished";
export type Outcome = "ok" | "failed" | "timed_out" | "stopped";
export interface Conversation {
  id: string; kind: ConversationKind; title: string; ownerId: string;   // free: author; work: requester
  projectId: string | null; contextProjectId: string | null;           // free: optional context
  taskId: string | null; requestId: string | null;
  state: ConversationState; outcome: Outcome | null;
  visibility: "private" | "project" | "public"; publishedAt: string | null; publishedById: string | null;
  touchedProjectIds: string[]; continuesFromId: string | null;
  createdAt: string; updatedAt: string; archived: boolean;
}
export type ConversationEvent =
  | { id: string; at: string; type: "user"; authorId: string; text: string; attachments: Attachment[]; delivery: "pending" | "delivered" | "undelivered"; undeliveredReason?: string }
  | { id: string; at: string; type: "assistant"; text: string; done: boolean }            // text grows while streaming
  | { id: string; at: string; type: "action"; tool: string; label: string; input?: string; result?: string; state: "running" | "done" | "failed"; truncated?: boolean }
  | { id: string; at: string; type: "phase"; phase: string; outcome: Outcome | null; stoppedById?: string }
  | { id: string; at: string; type: "citation"; refs: { kind: "task" | "request" | "doc" | "file" | "project" | "person"; id: string }[] }
  | { id: string; at: string; type: "question"; questionId: string; text: string; options: { label: string; consequence?: string; recommended?: boolean }[]; answer: { optionIndex: number | null; text: string | null; byId: string; at: string } | null }
  | { id: string; at: string; type: "plan"; planText: string; summary: string; status: "pending" | "approved" | "rejected" | "pre_approved"; decidedById?: string; instructions?: string }
  | { id: string; at: string; type: "proposal"; proposalId: string; requesterId: string; actions: ProposedAction[]; status: "open" | "confirmed" | "cancelled" | "expired" | "failed"; error?: string; resultCodes?: string[] }
  | { id: string; at: string; type: "work_result"; kind: "pr_opened" | "review" | "correction" | "design_updated" | "plan_updated"; text: string; link?: string };
export type ProposedAction = { fn: "createTask" | "updateTask" | "planTask" | "addComment" | "createRequest" | "convertRequest" | "startRun" | "archiveRequest"; args: Record<string, unknown>; summary: string };
export interface Attachment { id: string; name: string; sizeBytes: number; kind: "image" | "file" }
export interface SlashCommand { id: string; label: string; description: string; source: "stubwise" | { plugin: string; skill: string } }
export interface CommitOfDay { sha: string; repo: string; authorId: string | null; authorName: string; message: string; aiSummary: string; at: string; projectId: string }
```
`viewer.ts`: local instance permissions `claude.public.view`, `people.activity.view` with the defaults in Global Constraints; `can()` handles them.

- [ ] **Step 1: Tests** in `seed.test.ts`: every conversation references existing people/projects/tasks/requests; at least one per `ConversationKind` and per `ConversationState`; a public free conversation of Giulia whose `touchedProjectIds` includes a project Sara can't see; a mail_classify session owned by one person; every `question`/`plan`/`proposal` event is well-formed; `SlashCommand`s per project include plugin skills only for projects whose plugins are enabled; commits of today and yesterday for at least 3 developers, one with `authorId: null`. In `viewer.test.ts`: Sara has `claude.public.view`, not `people.activity.view`; Giulia (lead) has both; Roberta both.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck + lint.
- [ ] **Step 5: Commit** — `feat(desktop): modello e seed delle conversazioni con Claude`.

### Task 2: Motore di stream finto

**Files:** Create `data/stream.ts` (+`stream.test.ts`); Modify `data/api.ts`, `data/queries.ts`.

**Interfaces — Produces:**
- `subscribe(conversationId: string, onEvent: (e: ConversationEvent, mode: "append" | "update") => void): () => void` — replays the stored events then emits the scripted future ones with latency (`setLatency` honoured: 0 in tests → synchronous-ish microtasks); assistant text arrives in chunks of 3–12 words updating the same event (`mode: "update"`); actions go `running` → `done`.
- Scripts for live seeded sessions in `data/seed/conversations.ts` (`SCRIPTS: Record<conversationId, ScriptStep[]>`), deterministic.
- `simulateDisconnect(conversationId)` (test/dev) → the hook shows «Reconnecting…», then resumes from the last event id without duplicates.
- Hook `useConversationStream(id)` in `queries.ts`: person-scoped; returns `{ events, connection: "live" | "reconnecting" | "closed" }`; unsubscribes on unmount and **on persona change**.
- [ ] **Step 1: Tests:** chunks concatenate to the full text exactly once; reconnect resumes without duplicating or losing chunks (Review Focus 5); persona switch mid-stream stops emission to the old subscriber (Review Focus 1); an invisible conversation can't be subscribed (`not_found`).
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(desktop): stream finto delle conversazioni`.

### Task 3: Motore di intenti della conversazione libera

**Files:** Create `domain/claude/intents.ts` (+test), `domain/claude/answers.ts` (testi en/it via chiavi i18n passate dal chiamante).

**Interfaces — Produces:** `respond(text: string, ctx: IntentContext): ScriptStep[]` dove `IntentContext = { personId; contextProjectId: string | null; read: ReadApi; t: TFunction }` e `ReadApi` è il sottoinsieme di letture del livello dati (già filtrate per persona). Intenti: `status` (a che punto sono i progetti: pulse dei progetti fissati/visibili), `today` (cosa devo fare oggi: decisioni aperte, task in ritardo/oggi, mia settimana), `explain <codice>` (task o richiesta: riassunto + citazione; invisibile → «non la trovo o non puoi vederla»), `howto <tema> [in <progetto>]` (cerca nei Docs del progetto, cita le pagine; se il progetto non ha Docs lo dice), `run <codice richiesta>` (proposta `convertRequest`+`startRun` o `startRun`), `create/assign/plan` (proposte `createTask`/`updateTask`/`planTask`), `general` (risposta generica senza azioni). Riconoscimento: parole chiave en/it + codici `[A-Z]{2,4}-R?\d+`.
- [ ] **Step 1: Tests:** each intent on seed data as Giulia; `explain` of a task in a project Sara can't see → «can't find or can't see» for Sara (Review Focus 2 base); `run` produces a proposal, never executes; unknown text → `general`, no proposal; Italian and English phrasings.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(desktop): motore di intenti della conversazione libera`.

### Task 4: API delle conversazioni, proposte, pubbliche

**Files:** Modify `data/api.ts`, `data/api-mutations.ts`, `data/store.ts`, `data/queries.ts`; Test `data/conversations.test.ts`.

**Interfaces — Produces:**
- Reads: `listConversations(filter: { scope: "live" | "mine" | "public" | "finished"; projectId?; kind?; outcome? })`, `getConversation(id)`, `listCommands(contextProjectId: string | null): SlashCommand[]`, `listPeopleActivity(date: string, departmentId?: string)` (needs `people.activity.view`; returns per person: tasks closed, tasks moved, comments, decisions, requests created, commits; only visible projects).
- Visibility (in `store.ts`, one function `canSeeConversation(me, c)`): free private → owner; public → owner or `claude.public.view`; work sessions → `repos.view` in project (refine: `backlog.edit`); `mail_classify` → owner only.
- Writes: `createConversation({ contextProjectId? })`, `sendMessage(id, { text, attachments })` (free: runs `respond` and appends a script; work session: needs `canWrite`), `stop(id)`, `stopAndSend(id, text)` (`canInterrupt`), `answerQuestion(id, questionId, answer)` (`canAnswer`; second answer → `already_answered`), `decidePlan(id, "approve" | "reject", instructions?)` / `preApprovePlan` / `revokePlanApproval` (`plans.approve`), `confirmProposal(id, proposalId)` (only `requesterId`; runs each action via the existing mutation with the session person; all-or-nothing; failure → status `failed` with error), `cancelProposal`, `editProposal` (returns the args for the matching dialog), `setVisibility(id, "public" | "private")` (owner; public returns/needs confirm of `touchedProjectIds`), `continueConversation(publicId)` → new private conversation owned by the caller with `continuesFromId`, `renameConversation`, `archiveConversation`, `deleteConversation` (owner), `startRun(taskId)` / `relaunchWithInstructions` / `resumeCorrection` / `requestChanges` (permissions as today: `runs.start`, `corrections.request`, `plans.approve`), `startRefineConversation(requestId)` / `closeRefine` (`backlog.edit`). Detail fields `canWrite`, `canInterrupt`, `canAnswer`, `canDecidePlan` computed here.
- Proposal expiry: open proposals expire after 20 later events or 24h (computed at read time).
- [ ] **Step 1: Tests** (each allowed + refused, state unchanged on refusal): visibility matrix incl. mail owner-only and public with/without permission; `confirmProposal` by a non-requester → `forbidden`; confirm after losing permission (grant removed) → `failed` with message, no writes (Review Focus 3); expiry; `continueConversation` creates a private copy for the caller, original unchanged, Claude reads as the caller (Review Focus 2); `answerQuestion` twice → `already_answered`; `setVisibility` public lists touched projects; `listPeopleActivity` without permission → `forbidden`, with permission excludes invisible projects.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(desktop): conversazioni, proposte e pubbliche nel livello dati`.

### Task 5: Componente conversazione

**Files:** Create `pages/claude/conversation/{Conversation,EventList,AssistantMessage,ActionRows,PhaseDivider,ProposalCard,QuestionCard,PlanCard,WorkResultRow,Composer,MentionMenu,CommandMenu,AttachmentChip}.tsx` (+tests); Modify `tasks-ui/Markdown.tsx` (code blocks with horizontal scroll inside the block, tables).

**Interfaces — Produces:** `Conversation({ id: string; side?: ReactNode })` — usa `useConversation`, `useConversationStream`, le mutazioni del Task 4. Comportamenti dallo spec §1 e dal brief `shape/conversation.md`: azioni consecutive raggruppate («N azioni») apribili; citazioni con codice + nome e anteprima; scheda proposta (Conferma/Modifica/Annulla, solo per il richiedente; altri vedono «Proposta per X»); scheda domanda (opzione consigliata, «Altro…»); scheda piano (Approva / Rifiuta con indicazioni con `canDecidePlan`, altrimenti «Aspetta l'approvazione…»); casella con allegati (trascina/incolla, chip rimovibili), «#» oggetti e «@» persone (menu che cerca via `search`), «/» comandi (`listCommands`, autocompletamento con descrizione, tastiera); Ferma, Ferma e scrivi, stato di consegna con «Rimanda»; pillola «Nuovi messaggi», «Carica precedenti», «Riconnessione…»; sola lettura con motivo; scroll che segue il fondo solo se l'utente è in fondo.
- [ ] **Step 1: Tests:** streaming text appears progressively and once; grouped actions expand; proposal buttons only for requester; confirm shows result codes; question answered disappears into an answered state; plan buttons gated; «/» lists plugin skills for the context project only; «#» inserts a citation; attachments by paste; long code block doesn't widen the page (Review Focus 5: assert the scroll container is the block); persona switch clears the view (Review Focus 1); i18n parity.
- [ ] **Step 2–5:** FAIL → implement (Impeccable: context, craft-floor, shape brief, visual check) → PASS → commit `feat(desktop): componente conversazione con Claude`.

### Task 6: Destinazione «Claude»

**Files:** Create `pages/claude/{ClaudePage,ClaudeColumn,ConversationList,PublishDialog,ContinueBanner}.tsx` (+tests); Modify `router.tsx` (`/claude`, `/claude/$id`), `layout/PersonalColumn.tsx`, `palette/commands.ts` («New conversation with Claude», «Ask Claude…»).

Comportamenti dallo spec §4–§5 e `shape/claude-destination.md`: colonna con Nuova conversazione, Al lavoro ora, Le mie conversazioni, Pubbliche, Concluse; filtri progetto/tipo/esito; riga con tipo, titolo, progetto e codice, stato o esito, tempo, attività corrente; pagina = `Conversation` + lato oggetto per le sessioni di lavoro; «Rendi pubblica» con elenco dei progetti toccati e conferma; «Rendi privata»; in una pubblica altrui la casella scrive in una continuazione (`ContinueBanner`: «Continuerai in una tua conversazione privata»); rinomina, archivia, elimina (con conferma).
- [ ] **Step 1: Tests:** list scopes per persona (Sara sees Giulia's public one, not her private ones); publish shows touched projects and confirm; Sara writing in Giulia's public conversation lands in a new private conversation with «Continues from …» and Giulia doesn't see it (Review Focus 2); codes of projects Sara can't see aren't openable; mail session visible only to its owner.
- [ ] **Step 2–5:** FAIL → implement (Impeccable) → PASS → commit `feat(desktop): destinazione Claude`.

### Task 7: Sezione Claude della task

**Files:** Modify `pages/task/ClaudeSection.tsx` (+test), `pages/task/TaskDetail.tsx`; Create `pages/task/WorkStory.tsx`.

Sostituisce il segnaposto: stato, ultimo messaggio, domanda o piano aperti con le stesse schede del Task 5 (inline), PR e correzioni, storia del lavoro (eventi della storia del ticket di oggi), «Apri la sessione», «Assegna a Claude», «Avvia», «Rilancia con indicazioni», «Riprendi la correzione», «Chiedi modifiche», con i permessi di oggi. Testo «Opens when live sessions are available» rimosso. Spec §3, `shape/task-claude.md`.
- [ ] **Step 1: Tests:** each action gated by its permission; answering the question here closes it in the conversation; plan approve only with `plans.approve`; work story order.
- [ ] **Step 2–5:** FAIL → implement (Impeccable) → PASS → commit `feat(desktop): sezione Claude della task`.

### Task 8: Refine nelle Requests

**Files:** Modify `pages/requests/RequestDetail.tsx`; Create `pages/requests/RefineView.tsx` (+test).

«Rifinisci con Claude» apre la conversazione di refine (Task 5) con a lato la richiesta (urgenza, taglia, rischio, design, piano) aggiornata dal vivo dalle righe `design_updated`/`plan_updated`; «Chiudi la sessione» con conferma; scrive chi ha `backlog.edit`, gli altri leggono. Spec §3, `shape/refine.md`.
- [ ] **Step 1: Tests:** start/close gated by `backlog.edit`; side panel updates when a design_updated event arrives; Sara read-only.
- [ ] **Step 2–5:** → commit `feat(desktop): refine delle richieste come conversazione`.

### Task 9: Claude in «Da decidere»

**Files:** Modify `pages/home/blocks/DecideBlock.tsx` (+test), `data/api.ts` (decisioni aperte includono domande e piani di Claude per la persona), `layout/*` (punto «ti aspetta» derivato anche da queste).

Domande (rispondibili sul posto) e piani da approvare (solo con `plans.approve`) compaiono con la stessa forma delle richieste di decisione; rispondere qui chiude nella conversazione e viceversa; risposta concorrente → «Already answered by …» (Review Focus 4).
- [ ] **Step 1: Tests** per quanto sopra, con due persone.
- [ ] **Step 2–5:** → commit `feat(desktop): domande e piani di Claude in Da decidere`.

### Task 10: Rassegna del giorno per persona

**Files:** Modify `pages/projects/AllProjectsPage.tsx`; Create `pages/projects/PeopleActivity.tsx` (+test).

Nella scheda Attività di Tutti i progetti, vista «Per persona» (solo con `people.activity.view`): selettore data, filtro reparto; per persona: task chiuse, spostate, commenti, decisioni, richieste create, commit con descrizione «Generated text»; «Generate report» e «Link a person» per autori non collegati (come oggi, gated). Spec §6, `shape/people-activity.md`.
- [ ] **Step 1: Tests:** hidden without permission; date switch; invisible projects excluded; generated label present.
- [ ] **Step 2–5:** → commit `feat(desktop): rassegna del giorno per persona`.

### Task 11: Parità, screenshot, follow-up

Come il Task 15 dell'area 2: `apps/desktop/docs/area3-parity.md` (voci Agents, sessione dal vivo, sessione per job, sezioni AI del ticket, domande e piani in Inbox, refinement, Activity per sviluppatore) con posto + test reale, o buco; `capture.mjs` con le pagine nuove (in diretta catturate a stream concluso); follow-up aggiornati; suite, typecheck, lint, build verdi. Commit `docs(desktop): parità dell'area 3`.

Dopo il Task 11: revisione finale del branch e revisione visiva di Impeccable.
