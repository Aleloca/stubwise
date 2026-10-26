# App desktop, area 7: Automations — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` il motore delle
automazioni: sorgenti collegate, costruttore di flussi (inizio → passi con
condizioni, ripetizioni, attese, passi di Claude, approvazioni), simulazione
senza effetti, esecuzioni tracciate e visibili in Automations, progetto,
traguardo/task, Home e ⌘K.

**Architecture:** Un flusso è un **documento dichiarativo ad albero**
(`AutomationFlow`, JSON tipato) validato da una funzione pura e interpretato
da un **motore puro** (`domain/automations/engine.ts`) che, dato lo stato di
un'esecuzione e un evento, produce il passo successivo e gli **effetti
richiesti**. Gli effetti li esegue un solo **esecutore** nel livello dati
(`data/automations/effects.ts`) con le mutazioni esistenti, a nome del
proprietario; la **simulazione** usa lo stesso motore con un esecutore che
non scrive nulla. Dati in `data/automations/*` (visibilità in un file),
pagine in `pages/automations/*`, sempre via `data/queries.ts`.

**Tech Stack:** quello delle aree 1–6; nessuna dipendenza nuova.

**Spec:** `docs/plans/2026-10-26-desktop-area7-automations-design.md`
(approvato 26 ott 2026, commit 3cdbfc2a). Contesto: ossatura
(`docs/plans/2026-10-23-desktop-ossatura-design.md`, «Automations»),
area 6 (Posta per le email, «Da decidere», proposte), `apps/desktop/DESIGN.md`.

## Global Constraints

- Tutte le Global Constraints delle aree 2–6 restano (nessuna rete; en/it con parità; temi; niente monospace salvo logo e codice; colore mai unico segnale; movimento 150–250 ms con reduced-motion; pagine solo via `data/queries.ts`; stati completi; lint/typecheck/test verdi a ogni commit; orologio fisso `now()` di `data/store.ts`, mai `Date.now()`; Impeccable obbligatorio con shape approvati vincolanti; R-G5: nascosto e inesistente identici).
- **Le tre regole dell'anti-obiettivo sono invarianti del motore**: (1) un passo con approvazione non produce effetti finché non è approvato da chi ha il diritto, in nessun percorso (riavvio, altra automazione, simulazione, «Fai passare il tempo»); (2) un passo di Claude restituisce solo una delle **uscite dichiarate** e/o i **campi dichiarati** col loro tipo — altro = errore del passo; Claude non esegue azioni; (3) ogni esecuzione registra per ogni passo: dati in ingresso, esito, motivazione di Claude, approvatore e data.
- **Flusso ad albero**: niente salti all'indietro; cicli solo con `forEach` (su un elenco) e `repeatUntil` (con `max` obbligatorio, uscita «limite raggiunto»).
- **Proprietario = chi l'ha accesa** (un campo `ownerId`); accendere/riaccendere/pubblicare cambia il proprietario e il dialogo lo dice. Gli effetti girano **con i permessi del proprietario**; permesso perso → passo fallito «permesso perso». Le email partono da una casella del proprietario; l'inizio «email in arrivo» legge solo le sue caselle.
- **Progetto**: automazione di progetto → il suo progetto; generale → dai dati dell'evento con la **tabella cliente → progetto** o un progetto fisso nel passo; non trovato → attesa «scegli il progetto» per il proprietario (in «Da decidere»).
- **Stati**: automazione `draft | active | paused`; esecuzione `running | waiting_approval | waiting_event | waiting_project | suspended | done | failed | cancelled`. In pausa: nessun nuovo inizio, le esecuzioni in corso diventano `suspended` prima del passo successivo e riprendono riaccendendo; eventi arrivati in pausa non si recuperano.
- **Versioni**: accendere pubblica; modificare un'attiva crea una bozza della versione successiva; un'esecuzione finisce con la versione con cui è partita.
- **Codici**: automazione di progetto `<PRJ>-A<n>` (es. `AUD-A3`), generale `AUT-<n>`; esecuzione «`<codice>` #`<n>`» numerata per automazione; mai riusati.
- **Incaricato di «Crea task»**: persona; reparto = task senza incaricato con quel `departmentId`; «ruolo X nel progetto» = prima persona con quel ruolo in ordine alfabetico, nessuno → senza incaricato + avviso nel registro.
- **Permessi** (prototipo, `data/viewer.ts`): progetto `automations.manage` (preset Project Lead); istanza `automations.manage` (preset admin) per le generali; `integrations.manage` (esistente) per sorgenti e tabella cliente → progetto. Vedere: membri del progetto / chi ha il permesso d'istanza per le generali. Approvare: chi indicato nel passo e vede il progetto.
- **Simulazione**: stesso motore, nessun effetto (nessuna task, email, notifica, avvio, scrittura nel registro delle esecuzioni vere); attese saltate con «Avanti», risposta del cliente scrivibile, approvazioni approvabili nella prova.
- **Prototipo**: sorgenti finte con «Simula un evento»; ritardi via `gate()`; «Fai passare il tempo» nel dettaglio esecuzione (solo prototipo); Claude con testi deterministici e streaming esistente; email nella Posta finta dell'area 6. Limiti di sicurezza: max 20 email per esecuzione, max 50 giri di `forEach`, `repeatUntil.max` ≤ 10, max 100 esecuzioni attive per automazione.

## Review Focus

1. **Approvazione scavalcata**: approvatore che perde l'accesso al progetto, automazione messa in pausa e riaccesa durante l'attesa, «Fai passare il tempo», avvio annidato da un'altra automazione — nessun effetto prima dell'approvazione. → test in Task 2 e Task 3.
2. **Claude fuori dai binari**: uscita non dichiarata, campo del tipo sbagliato, elenco di task vuoto o enorme (oltre il limite), testo che «chiede» di fare altro → errore del passo o limite, mai un'azione. → test in Task 2.
3. **Proprietario e permessi**: proprietario che perde `tickets.create` a metà esecuzione; un altro riaccende e diventa proprietario; email da una casella scaduta; tabella cliente → progetto che punta a un progetto invisibile al proprietario. → test in Task 3.
4. **Modifiche durante le esecuzioni**: versione nuova pubblicata con esecuzioni in corso; passo eliminato nella bozza; sorgente scollegata; pausa con un'esecuzione in `waiting_event`. → test in Task 3.
5. **Contenuti estremi nel costruttore e nel registro**: 40 passi, rami annidati su 5 livelli, nomi lunghissimi, esecuzione con 50 giri di `forEach`, registro da 300 righe. → test in Task 6 e Task 7.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`: `automations.md` (destinazione: elenco con filtri e stati, dettaglio di un'automazione con versioni ed esecuzioni, dettaglio di un'esecuzione con registro, annulla/riprova/salta, «Fai passare il tempo», vuoti e modelli), `automation-builder.md` (costruttore per non tecnici: inizio e dati disponibili, passi, condizioni, ripetizioni, attese, passo di Claude con uscite e campi, approvazione per passo, errori di configurazione, accendi/metti in pausa/pubblica col cambio di proprietario), `automation-test.md` (simulazione passo per passo su evento di esempio, attese con «Avanti», risposta simulata, approvazioni nella prova), `automation-sources.md` (sorgenti collegate, «Simula un evento», webhook in arrivo con esempio, tabella cliente → progetto) più i punti d'ingresso (sezione del progetto, «Creata dall'automazione» su task e traguardo, blocco Home, «Da decidere», ⌘K). Nessun codice.

### Task 1: Modello, permessi e seme

**Files:** Modify `data/model.ts`, `data/types.ts`, `data/store.ts`, `data/viewer.ts` (+test); Create `data/seed/automations/*.ts`; Test `data/seed.test.ts`.

**Interfaces — Produces (`model.ts`):**
```ts
export type FieldType = "text" | "number" | "date" | "email" | "person" | "list" | "file";
export interface DataField { key: string /* es. "trattativa.cliente" */; label: string; type: FieldType; of?: DataField[] /* per list */ }
export type AutomationTrigger =
  | { kind: "source"; sourceId: string; event: "deal_won" | "webhook" }
  | { kind: "stubwise"; event: "task_created" | "task_closed" | "request_created" | "milestone_reached" | "mail_received"; filter?: Condition }
  | { kind: "schedule"; rule: string /* RRULE semplice */ }
  | { kind: "manual" };
export type Operand = { ref: string } | { value: string | number | null };
export interface Condition { all?: Condition[]; any?: Condition[]; left?: Operand; op?: "is" | "is_not" | "contains" | "empty" | "not_empty" | "gt" | "lt"; right?: Operand }
export type Approval = { mode: "auto" } | { mode: "ask"; who: { personId: string } | { projectRole: string } | { owner: true } };
export type ProjectTarget = { mode: "own" } | { mode: "fixed"; projectId: string } | { mode: "from_client"; clientRef: string };
export type Step =
  | { id: string; kind: "createTask"; title: string; description: string; assignee: { personId: string } | { departmentId: string } | { projectRole: string } | null; dueInDays: number | null; project: ProjectTarget; milestoneRef: string | null; approval: Approval }
  | { id: string; kind: "createMilestone"; name: string; dueInDays: number | null; project: ProjectTarget; approval: Approval }
  | { id: string; kind: "createRequest"; title: string; description: string; project: ProjectTarget; approval: Approval }
  | { id: string; kind: "sendEmail"; to: string /* template */; subject: string; body: string; attachRefs: string[]; approval: Approval }
  | { id: string; kind: "notify"; personRef: string; text: string; approval: Approval }
  | { id: string; kind: "startAutomation"; automationId: string; approval: Approval }
  | { id: string; kind: "wait"; for: { days: number } | { replyTo: string /* id di un sendEmail */; maxDays: number } | { taskClosed: string; maxDays: number } }
  | { id: string; kind: "claude"; instruction: string; inputs: string[]; outcomes: string[]; fields: DataField[] ; branches: Record<string, Step[]> }
  | { id: string; kind: "condition"; when: Condition; then: Step[]; else: Step[] }
  | { id: string; kind: "forEach"; list: string; as: string; steps: Step[] }
  | { id: string; kind: "repeatUntil"; until: Condition; max: number; steps: Step[]; onLimit: Step[] };
export interface AutomationFlow { trigger: AutomationTrigger; steps: Step[]; titleTemplate: string }
export interface AutomationVersion { n: number; flow: AutomationFlow; publishedAt: string | null; publishedById: string | null }
export interface Automation { id: string; code: string; name: string; description: string; projectId: string | null; ownerId: string | null; status: "draft" | "active" | "paused"; versions: AutomationVersion[] /* l'ultima può essere bozza */; createdAt: string }
export type RunStatus = "running" | "waiting_approval" | "waiting_event" | "waiting_project" | "suspended" | "done" | "failed" | "cancelled";
export interface RunLogEntry { at: string; stepId: string; path: string /* es. "3/forEach[2]/1" */; kind: Step["kind"] | "trigger"; outcome: "ok" | "skipped" | "failed" | "waiting" | "approved" | "rejected" | "limit"; input: Record<string, unknown>; output: Record<string, unknown>; reason: string | null; byId: string | null; effects: { kind: string; code: string }[] }
export interface AutomationRun { id: string; automationId: string; n: number; version: number; title: string; status: RunStatus; event: Record<string, unknown>; vars: Record<string, unknown>; cursor: string | null; waitingUntil: string | null; pending: { approverIds: string[]; preview: Record<string, unknown> } | null; log: RunLogEntry[]; startedAt: string; endedAt: string | null; error: string | null; projectIds: string[] }
export interface AutomationSource { id: string; kind: "audin" | "hubspot" | "webhook"; name: string; status: "connected" | "expired" | "disconnected"; connectedById: string; sampleEvents: Record<string, unknown>[]; fields: DataField[] }
export interface ClientProjectLink { clientKey: string /* es. dominio o id cliente */; clientName: string; projectId: string }
```
`viewer.ts`: progetto `automations.manage` (Project Lead), istanza `automations.manage` (admin); `integrations.manage` esiste già.
- Seme (spec «Dati finti»): Audin collegato con 3 trattative chiuse (prodotti diversi, contratto PDF con testo), HubSpot `expired`, un webhook; tabella cliente → progetto con 3 righe (una verso un progetto che qualcuno non vede); automazione generale «Nuovo contratto» (`AUT-1`, attiva, proprietario Matteo) e di progetto «Richiesta dati al cliente» (`AUD-A1`, attiva, proprietaria Laura) con i flussi descritti nello spec; una bozza mai accesa e una in pausa; esecuzioni: una `waiting_event` da 3 giorni, una `waiting_approval` (email da approvare per Laura), una `done`, una `failed` («permesso perso»), una `waiting_project`.
- [ ] Tests (seme): ogni caso sopra; codici unici e nel formato; ogni flusso del seme passa `validateFlow` (Task 2) — scritto qui come `it.todo` e attivato nel Task 2; permessi dei preset.
- [ ] Commit `feat(desktop): modello e seme delle Automations`.

### Task 2: Validazione e motore puri

**Files:** Create `domain/automations/{fields.ts,validate.ts,conditions.ts,engine.ts,claudeStep.ts}` (+test).

**Interfaces — Produces:**
- `availableFields(flow, stepPath): DataField[]` — i dati dell'inizio più gli output dei passi precedenti nel ramo (campi di Claude, variabile di `forEach`).
- `validateFlow(flow, ctx: { sources: AutomationSource[]; canApprove(who, projectId): boolean }): { path: string; code: "incomplete" | "unknown_ref" | "type_mismatch" | "approver_cant_see" | "source_disconnected" | "limit"; message: string }[]`.
- `evaluate(cond: Condition, vars): boolean`.
- `advance(state: EngineState, input: EngineInput): { state: EngineState; effects: EffectRequest[]; log: Omit<RunLogEntry, "at">[] }` — puro. `EngineInput` = `{ kind: "start"; event } | { kind: "approved"; byId; edited? } | { kind: "rejected"; byId } | { kind: "event"; payload } | { kind: "time"; now } | { kind: "project_chosen"; projectId } | { kind: "effect_result"; ok: boolean; codes?: string[]; error?: string } | { kind: "claude_result"; outcome?: string; fields?: Record<string, unknown>; reason: string }`. `EffectRequest` = `{ kind: "createTask" | "createMilestone" | "createRequest" | "sendEmail" | "notify" | "startAutomation"; args; projectTarget? } | { kind: "claude"; step; vars } | { kind: "resolve_project"; clientRef }`. Un passo con `approval.mode = "ask"` produce **prima** lo stato `waiting_approval` e nessun effetto; solo l'input `approved` lo sblocca.
- `checkClaudeResult(step, result): { ok: true } | { ok: false; error: "unknown_outcome" | "bad_field" | "too_many" }` in `claudeStep.ts`.
- [ ] Tests: Review Focus 1 (nessun `EffectRequest` di un passo `ask` prima di `approved`, qualunque sequenza di input `time`/`event`), Review Focus 2 (uscita non dichiarata, campo di tipo sbagliato, elenco oltre 50 → errore/limite, mai effetti); `repeatUntil` si ferma a `max` ed esce da `onLimit`; `forEach` su elenco vuoto; `wait.replyTo` con `maxDays` scaduto; condizioni `all/any` annidate; `validateFlow` trova ogni codice d'errore; i flussi del seme sono validi (attiva l'`it.todo` del Task 1).
- [ ] Commit `feat(desktop): motore puro delle automazioni`.

### Task 3: Livello dati — automazioni, esecuzioni, sorgenti

**Files:** Create `data/automations/{visibility.ts,reads.ts,writes.ts,effects.ts,runner.ts,sources.ts,index.ts}` (+`data/automations/automations.test.ts`); Modify `data/api.ts`, `data/queries.ts`, `data/store.ts`.

**Interfaces — Produces:**
- `canSeeAutomation(me, a)`, `canManageAutomation(me, a)`; esecuzioni seguono l'automazione.
- Reads: `listAutomations({ projectId?, status?, ownerId? })`, `getAutomation(id)` (versioni, errori di configurazione da `validateFlow`, ultime esecuzioni), `listRuns({ automationId?, projectId?, status? })`, `getRun(id)`, `listSources()`, `listClientLinks()`, `listMyApprovals()` (per «Da decidere»: approvazioni e `waiting_project` di cui sono destinatario), `searchAutomations(q)`.
- Writes: `createAutomation`, `saveDraft(id, flow, meta)`, `publish(id)` (valida; diventa proprietario chi pubblica), `activate(id)`/`pause(id)` (pausa → esecuzioni in corso `suspended` al passo successivo), `deleteDraft`; `startManual(id, event)`, `simulateSourceEvent(sourceId, sampleIndex)` (avvia le automazioni attive con quell'inizio), gli inizi `stubwise` (task creata/chiusa, richiesta, traguardo, email in arrivo **solo dalle caselle del proprietario**) agganciati alle mutazioni esistenti, `schedule` valutato su `now()`, `approve(runId, edited?)`, `reject(runId)`, `chooseProject(runId, projectId)`, `cancelRun`, `retryStep`, `skipStep`, `advanceTime(runId, days)` (solo prototipo; non scavalca le approvazioni); `connectSource`/`disconnectSource`/`setClientLink`/`removeClientLink` (`integrations.manage`).
- `runner.ts`: avanza un'esecuzione col motore, passa gli `EffectRequest` a `effects.ts` e reinserisce l'esito; ritardi via `gate()`; generazione del negozio controllata.
- `effects.ts`: **unico esecutore** — `createTaskAs`/milestone/request esistenti a nome del proprietario (permesso perso → `failed` «permesso perso»), `sendEmail` con la composizione dell'area 6 dalla casella del proprietario (scaduta → `failed`), notifiche, avvio annidato (eredita le regole, nessuna approvazione saltata), risoluzione progetto da `ClientProjectLink` (progetto invisibile al proprietario = non trovato → `waiting_project`); ogni task/traguardo creato porta `automationRef: { automationId, runId }` (campo nuovo facoltativo su `Task` e `Milestone`).
- Claude: risposta finta deterministica per istruzione + input del seme, verificata con `checkClaudeResult`.
- [ ] Tests: Review Focus 1 (sul livello dati), 3 e 4; ogni stato dell'esecuzione raggiungibile; la risposta del cliente simulata nella Posta (area 6) sblocca `wait.replyTo`; versione nuova con esecuzioni in corso; R-G5 su `getRun`/`getAutomation`; `resetApi` ripulisce.
- [ ] Commit `feat(desktop): dati delle Automations`.

### Task 4: Simulazione — dati

**Files:** Create `data/automations/simulate.ts` (+test); Modify `data/queries.ts`.

**Interfaces — Produces:** `startSimulation(automationId, version | "draft", event): SimulationId`; `simulationStep(simId, input: EngineInput)`; `getSimulation(simId)` → `{ status, log, preview: { tasks, milestones, requests, emails, notifications, claude: { outcome, fields, reason }[] }, waiting }`; `endSimulation(simId)`. Usa `advance` e un esecutore **finto** che produce anteprime (incaricati risolti, progetto risolto, testi compilati) e non scrive nello store; esempi da `sampleEvents` della sorgente o scritti a mano.
- [ ] Tests: nessuna scrittura nello store (confronto di `state` prima/dopo, compresi task, mailMessages, notifiche, runs); approvazioni nella prova; «Avanti» sulle attese; risposta simulata; un flusso con errori di configurazione non parte e dice dove.
- [ ] Commit `feat(desktop): simulazione delle automazioni`.

### Task 5: Automations — pagine (elenco, automazione, esecuzione, sorgenti)

**Files:** Create `pages/automations/{AutomationsPage.tsx,AutomationList.tsx,AutomationDetail.tsx,RunList.tsx,RunDetail.tsx,RunLog.tsx,SourcesPage.tsx,ClientLinks.tsx}` (+test); Modify `router.tsx` (`/automations`, `/automations/$code`, `/automations/$code/runs/$n`, `/automations/sources`), `data/routes.ts`, i18n.

Da shape `automations.md` e `automation-sources.md`: elenco con filtri e stati, dettaglio con versioni, proprietario, errori di configurazione, accendi/pausa/pubblica (dialogo del cambio di proprietario), esecuzioni (in corso in alto); dettaglio esecuzione col registro leggibile (rami, giri, motivazioni di Claude, approvatori), annulla/riprova/salta, «Fai passare il tempo» (marcato prototipo); sorgenti con stato, «Simula un evento», webhook con esempio, tabella cliente → progetto.
- [ ] Tests: Review Focus 5 (registro da 300 righe, 50 giri); permessi (Viewer vede senza azioni; senza `integrations.manage` niente sorgenti); cambio di persona con un dettaglio aperto; stati vuoto/errore/caricamento.
- [ ] Commit `feat(desktop): pagine delle Automations`.

### Task 6: Costruttore

**Files:** Create `pages/automations/builder/*` (+test); Modify i18n.

Da shape `automation-builder.md`: scelta dell'inizio con i dati disponibili, passi con aggiunta/riordino/eliminazione, rami di condizione, `forEach`, `repeatUntil` (con `max`), attese, passo di Claude (istruzione, input, uscite, campi), approvazione per passo, campi con riferimenti ai dati disponibili (`availableFields`), errori di `validateFlow` sul passo, salva bozza / pubblica / accendi, modelli dai due esempi.
- [ ] Tests: Review Focus 5 (40 passi, 5 livelli, nomi lunghi); un riferimento a un dato non più disponibile dopo aver spostato un passo diventa errore visibile; bozza su automazione attiva non cambia le esecuzioni in corso; tastiera per aggiungere e riordinare.
- [ ] Commit `feat(desktop): costruttore delle automazioni`.

### Task 7: Simulazione — UI

**Files:** Create `pages/automations/test/*` (+test); Modify il costruttore («Prova»).

Da shape `automation-test.md`: scelta dell'evento di esempio, avanzamento passo per passo, anteprime (task con incaricati, email complete, scelte di Claude con motivazione), «Avanti» sulle attese, risposta del cliente da scrivere, approvazioni nella prova, «Accendi» solo dopo, esplicito.
- [ ] Tests: nessun effetto reale visibile altrove (Posta, task, Home) dopo una prova completa; Review Focus 5 (50 giri leggibili); la prova di una bozza con errori dice dove.
- [ ] Commit `feat(desktop): prova delle automazioni`.

### Task 8: Punti d'ingresso — progetto, task, traguardo, Home, ⌘K

**Files:** Modify `pages/overview/*` o la sezione progetto scelta dallo shape, task e traguardo («Creata dall'automazione X · esecuzione Y» da `automationRef`), `pages/home/blocks/{registry.ts,DecideBlock.tsx}` + `AutomationsBlock.tsx` (nuovo `HomeBlockKind` `automations`), `palette/CommandPalette.tsx` (gruppo Automazioni, azione «Nuova automazione»), i18n (+test).

Approvazioni e «scegli il progetto» in «Da decidere» con conferma sul posto e «Undo» come le altre risposte; un'email da approvare si può correggere prima.
- [ ] Tests: approvatore senza accesso al progetto non vede la richiesta; R-G5 in ⌘K; il blocco elenca solo esecuzioni che mi riguardano; link «Creata dall'automazione» solo se vedo l'automazione (altrimenti testo senza link).
- [ ] Commit `feat(desktop): automazioni nel progetto, nella Home e in ⌘K`.

### Task 9: Documenti, screenshot, follow-up

`apps/desktop/docs/area7-notes.md` (niente parità: area nuova) con dove vive ogni voce dello spec e il test che la copre; `capture.mjs`: scatti `a7-*` (elenco, costruttore di «Nuovo contratto», passo di Claude, prova a metà, esecuzione con registro, approvazione in Home, sorgenti) light/dark, en/it a 1440 e uno a 1024; vite ucciso. «Area 7 — minori aperti» in `ossatura-follow-ups.md` con la nota che Claude che costruisce e prova le automazioni è della fase su Claude. Suite, typecheck, lint, build verdi. Commit `docs(desktop): note dell'area 7`.

Dopo il Task 9: revisione finale del branch (area 7) e revisione visiva di Impeccable.
