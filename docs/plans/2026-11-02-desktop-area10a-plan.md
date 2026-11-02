# App desktop, area 10a: il riquadro di Claude, la conferma per classi, «per conto di» e «Annulla» — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la prima metà dell'area 10:
- il **riquadro di Claude**, che si apre da ogni pagina ed è la conversazione
  libera dell'area 3;
- la **regola della conferma** con le classi A/B/C/D, e la classe
  **calcolata sui dati** del momento;
- la **trasparenza** «Claude per conto di [persona]» (`via: "claude"`) nel
  registro, nei commenti, nelle notifiche e nella storia, con i segni e il
  filtro «Fatte con Claude» del registro;
- **«Annulla»**, come azione nuova e inversa;
- **«Elimina task»**, usabile anche a mano;
- il **catalogo delle azioni** e i **divieti** della classe D.

Restano al piano 10b: gli scenari S0–S6b e i loro dati, la costruzione e la
prova delle automazioni, le bozze nei campi col segno «Bozza di Claude», le
righe «Claude può aiutarti a…», e le azioni del catalogo che vivono nella
pagina e non nel livello dati: filtro, lingua, tema, bozza (*scelta del
controller*, 2 nov 2026).

**Architecture:**
- **Il catalogo** (`data/claude/catalog.ts`) è l'elenco chiuso delle azioni
  che il riquadro può produrre. Ogni voce chiama la forma sincrona («As») di
  una scrittura che la pagina usa già: il catalogo non ha scritture sue. La
  voce dichiara classe di partenza (A o B), inverso, azione di «Who?» e la
  funzione dell'API; la classe C la dà `REAUTH_REQUIRED`, mai la voce.
- **La classe** la calcola il livello dati (`classOf`, `data/claude/classes.ts`)
  con due soli controlli: chi riceverebbe un avviso e quale automazione
  attiva partirebbe. Una classe sale, mai scende. Il motore di intenti la
  riceve come lettura (`ctx.classify`), così resta puro.
- **L'esecuzione** passa da `applyActions` (`data/api-mutations.ts`), unico
  esecutore del «tutto o niente», dentro `runAsClaude` (`data/claude/via.ts`).
  Le scritture leggono `currentVia()` e scrivono il segno; nessuna funzione
  pubblica accetta `via` come argomento.
- **Le azioni eseguite** stanno in `state.claudeActions`, a gruppi (una riga
  eseguita, o una scheda confermata). «Annulla» esegue gli inversi del
  gruppo con lo stesso esecutore, dopo il controllo «com'era»: nessuna
  scrittura sugli oggetti toccati dopo l'azione.
- **Il riquadro** è un host montato una volta in `AppLayout`, nascosto e non
  smontato quando è chiuso: conversazione e bozza restano. Il contesto della
  pagina si ricava dall'indirizzo (`pageContextOf`), come riferimento.

**Tech Stack:** quello delle aree 1–9c, senza dipendenze nuove.

**Spec:** `docs/plans/2026-11-02-desktop-area10-claude-integration-design.md`
(approvato il 2 nov 2026). Di quel documento valgono per il 10a:
- «Perché», «Obiettivi», «Non obiettivi», «Anti-obiettivi» (con «L'anti-
  obiettivo dell'area 3 che cambia»);
- «Regole di fondo», tutta;
- parte 1 «Il riquadro», tranne «Le pagine che si possono riempire» (10b);
- parte 2 «Il catalogo delle azioni», tranne le tre righe delle automazioni,
  le righe «Filtro» e «Bozza in un campo», e lingua e tema di «Le tue
  preferenze» (10b, *scelta del controller*); le notifiche delle preferenze
  restano qui (`setSubscription`);
- parte 3 «Trasparenza»;
- parte 5 «Agire sull'app», per la forma delle righe e delle schede (le
  azioni in blocco di S4 sono 10b);
- «Quanto è vero nel prototipo»: stream, riconferma, consumi `chat`;
- «Dati finti»: le conversazioni del riquadro e la notifica annullata;
- «Parità e invarianti toccate», tutta;
- «Review Focus» 1, 3, 4, 5, 6, 7.

Contesto da leggere:
- `docs/plans/2026-10-24-desktop-area3-claude-design.md` (proposte,
  `settleProposal`, «Claude agisce come l'utente»);
- `docs/plans/2026-10-31-desktop-area9c-plan.md` (forma, lezioni, `busy`);
- `apps/desktop/docs/area3-parity.md`, `area9-parity.md`,
  `ossatura-follow-ups.md` (invarianti §1–§11, «Area 9c — minori aperti»);
- nel desktop: `data/api-mutations.ts` (`freeTurn`, `applyActions`,
  `settleProposal`, `ProposalPlace`), `domain/claude/{intents.ts,answers.ts,context.ts}`,
  `pages/claude/conversation/*`, `data/changelog/*`, `data/alerts/*`,
  `data/automations/sources.ts`, `data/auth/reauth.ts`, `layout/useReauth.ts`,
  `layout/AppLayout.tsx`, `layout/useShortcuts.ts`, `palette/commands.ts`;
- `apps/desktop/DESIGN.md`.

## Global Constraints

- **Valgono tutte le Global Constraints delle aree 2–9c:**
  - nessuna rete, nessun modello;
  - en/it con parità;
  - temi;
  - niente monospace, salvo logo, codice, log, comandi, script, token,
    chiavi, URL e percorsi di file;
  - colore mai unico segnale;
  - movimento 150–250 ms, con reduced-motion;
  - pagine solo via `data/queries.ts` (e `data/queries/*`);
  - stati completi: caricamento, vuoto, errore con «Riprova», pieno, senza
    permessi;
  - commenti in italiano.
- **Un solo «adesso»**: ogni «quando», età o confronto di date usa `now()` di
  `data/store.ts` (registro, azioni di Claude, eliminazione, «Annulla»).
  `architecture.clock.test.ts` resta verde.
- **Claude agisce con i permessi di chi lo chiama** (maintainer). Ogni
  lettura e scrittura del riquadro gira come la persona della sessione, con
  le funzioni del livello dati delle pagine; fallisce con `forbidden` o
  `not_found` come a mano. Il permesso si controlla quando l'azione parte
  (invio per A, conferma per B/C) e di nuovo all'«Annulla». Nessun permesso
  nuovo a Claude collega (R-L9, R-L11): «per conto di» non è un permesso.
- **La regola della conferma** (maintainer):
  - **A** parte subito con «Annulla»: solo se l'azione **non avvisa altre
    persone** e **non fa partire un'automazione**. Sono i soli due criteri;
    che il risultato si veda nelle liste del progetto non conta;
  - **B** chiede una scheda (Conferma / Modifica / Annulla): persone,
    impostazioni condivise, permessi, e le azioni che non si annullano;
  - **C** è B più il codice: la funzione è in `REAUTH_REQUIRED`;
  - **D** non si esegue: Claude porta al posto vero in una riga.

  Una classe può solo salire. Nessuna C scende a B, nessuna B scende ad A.
  @Claude nella Chat resta tutto proposte (area 4).

  **Assegnare avvisa** *(decisione del maintainer, 2 nov 2026)*: chi riceve
  una task (creata già assegnata, riassegnata con `updateTask` o con
  `planTask`) riceve la notifica diretta `task.assigned` («You've been
  assigned ACQ-14» / «Ti è stata assegnata ACQ-14»), da una persona come da
  Claude per conto di qualcuno; chi si assegna una task da solo non la
  riceve. Così «di un altro» rientra nel criterio «avvisa altre persone»: la
  scheda dice «Notifies Marco Bellini» perché la notifica parte davvero
  (Task 3 la scrive, Task 4 la calcola).
- **«Modifica» solo dove il dialogo vero esiste già** *(maintainer, 2 nov
  2026)*: oggi `createTask` e `createRequest` (`EDITABLE` di
  `ProposalCard.tsx`, che non cambia). Le schede delle altre azioni hanno
  solo Conferma e Annulla.
- **La classe la calcola il livello dati** (`classOf`), e il client la legge
  da `proposal.cls`/`proposal.reasons`: la scheda e il motore di intenti non
  la deducono.
- **Il catalogo non nomina mai** (test sul sorgente, Task 4, che cerca
  riferimenti di codice — chiamate, import, `api.<ns>.<nome>` — e non
  parole: *ruling del controller (pre-flight)*, P11): approvare o
  rifiutare un piano (`decidePlan`, `preApprovePlan`, `revokePlanApproval`),
  `mergePr`, `answerQuestion`, `recordDecision`, `activate`/`publish` delle
  automazioni, `createToken`, `createClaudeCodeCommand`, `createInvite`,
  `createPasswordResetLink`, ogni funzione `servers.*`, ogni scrittura di
  segreti (`regenerateIngestionKey`, `regenerateWebhookSecret`,
  `importEnvFile`, `setEnvVar`, `createProvider`, `replace*`), `sendDraft`,
  `replyToCustomer`.
- **R-G5 anche nelle risposte di Claude.** Nessun nome, codice o conteggio di
  ciò che chi chiede non vede: nelle frasi, nelle schede, nelle righe
  «chi ne sarà toccato», nelle righe d'azione, nei motivi di «Annulla», nei
  «Who?». Un oggetto invisibile e uno inesistente ricevono la stessa frase
  («Can't find ACQ-99»). Una task eliminata si legge come un codice
  inesistente.
- **I test R-G5 non distinguono maiuscole e minuscole**: ogni controllo
  «non contiene RNC / Tenuta Ronchi / ACQ-99» si fa su testo e DOM portati
  in minuscolo (o con una regex `/i`).
- **Il registro salva valori stabili e li traduce quando li legge**: `via:
  "claude"`, `undoOf: <id della voce>`, codici e id; mai una frase. Le frasi
  «Claude per conto di …» e «… ha annullato: …» si compongono a lettura da
  template i18n. Nessun testo di Claude entra nel registro.
- **I campi nuovi sono facoltativi** (cambi additivi): `via`, `viaClaude`,
  `undoOf`, `cls`, `reasons`, `groupId`, `ConversationDetail.undo` (letto
  con `?? {}`, *ruling del controller (pre-flight)*, P25) si leggono assenti
  sulle righe nate prima. Un campo nuovo che il web leggerebbe va difeso nel
  punto di lettura.
- **I tipi del catalogo stanno in una foglia** *(ruling del controller
  (pre-flight), P10)*: `ClaudeActionFn`, `ObjectRef`, il tipo dell'inverso e
  `ClaudeActionRecord` vivono in `data/claude/types.ts`, senza import;
  `model.ts` e `catalog.ts` li leggono da lì. Un `import type` di
  `model.ts` verso `catalog.ts` porterebbe lo store e le letture del
  registro fino ad `admin/secrets.ts` (`architecture.secrets.test.ts`).
- **L'orologio è fermo** *(ruling del controller (pre-flight), P4)*: `now()`
  non distingue le scritture di una sessione, quindi ogni «prima/dopo» del
  10a (il «com'era» di «Annulla») si ordina con `nextSeq()`, mai con `at`.
- **Si deriva a lettura ciò che si può derivare** (invariante del
  CLAUDE.md): «Annullato da …» sulla notifica, «Task deleted» al posto del
  link, lo stato di «Annulla» di una riga. Si scrive nell'evento solo ciò
  che è vero solo al momento (`viaClaude` della notifica).
- **Lezioni delle aree 9b e 9c, valide per ogni task:**
  - **ogni bottone spento ha la sua frase**, e quello spento per un permesso
    anche il `WhoCanLink` con un'azione di `ACTIONS`; uno spento per una
    regola (task occupata, oggetto cambiato) ha la frase senza «Who?»;
  - **la pagina non ricalcola le regole del livello dati**: niente `can()`
    nel riquadro, nelle righe d'azione, nella scheda e nel dialogo di
    eliminazione; si leggono `cls`, `reasons`, `undo`, `canDelete`,
    `whoAction`, `busy`;
  - **le mutazioni con un segreto** usano `{ secret: true }`. Nel 10a
    nessuna azione del catalogo porta un segreto; se un task ne aggiunge
    una, è un errore del task (Global Constraint sopra);
  - **a 1024 px il layout segue lo shape**, non si comprime da solo;
  - **gli scatti si rifanno dopo ogni correzione** visiva, prima del commit
    che la chiude;
  - **la UI non afferma ciò che il dato non dimostra**: «Undone by Giulia
    Ferri» solo con `undone`, «Marco Bellini changed it afterwards» solo
    con una scrittura trovata dopo l'azione, «Done» solo con `status:
    "done"`, «Notifies Marco Bellini» solo se il calcolo lo dice;
  - **dopo un dialogo aperto da «⋯»** (o da un bottone) il fuoco torna a chi
    l'ha aperto, anche dopo una conferma che cambia o toglie la riga (dopo
    l'eliminazione di una task il fuoco va dove lo dice lo shape
    `task-delete.md`);
  - **`write.run(..., onDone)` dà seguito anche dopo un Retry**: «Annulla» e
    l'eliminazione passano da `useSettingsWrite` o dalla stessa forma, e
    il test prova il seguito dopo un Retry riuscito.
- **Riconferma** (area 9a): la classe C usa `useReauth` e `ReauthDialog`,
  aperto sopra il riquadro; dopo il codice l'azione riparte da sola. La
  finestra di grazia è di 10 minuti, per persona; un PAT non la soddisfa
  mai. «Annulla» chiede il codice se l'inverso è in `REAUTH_REQUIRED`.
  «Elimina task» non è in `REAUTH_REQUIRED`.
- **Budget e coda** (9b): col budget mensile esaurito il riquadro lo dice e
  non parte niente; la coda del progetto in pausa non ferma il riquadro,
  solo il lavoro che farebbe partire (`startRun` entra in coda). I consumi
  del riquadro sono operazione `chat`, sul progetto del contesto se c'è.
- **Impeccable obbligatorio per la UI**, con gli shape del Task 0 approvati
  e vincolanti, e la revisione visiva di Impeccable dopo l'ultimo task.
- **Il ciclo di ogni task** (TDD), con gli elenchi «Test» come passi:
  1. scrivere i test elencati, con i valori del task;
  2. lanciarli e vederli fallire per il motivo atteso (funzione o campo che
     manca), non per un errore d'altro tipo;
  3. implementare le firme dell'Interfaces;
  4. rilanciarli e vederli passare;
  5. suite, typecheck e lint (sotto), poi il commit indicato.
  Un test scritto per riprodurre un difetto si guarda **perché** è verde
  (lezione (c) del CLAUDE.md): gli id casuali degli helper non devono
  togliere la condizione che il test prova.
- **Comandi.**
  - Un singolo file di test: `pnpm --filter @stubwise/desktop test -- <file>`.
  - Prima di ogni commit: la suite desktop (`pnpm --filter @stubwise/desktop
    test`), `pnpm --filter @stubwise/desktop typecheck` e `pnpm lint` dalla
    radice. Alla fine anche `pnpm --filter "@stubwise/desktop..." build`.
  - Commit `feat(desktop): …` / `fix(desktop): …` in italiano, con i trailer
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e
    `Claude-Session: https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm`.
  - Verifica UI: `pnpm --filter @stubwise/desktop preview:web` +
    `apps/desktop/scripts/capture.mjs`, a 1440 e 1024, chiaro e scuro, en e
    it, scatti `a10a-*`.
  - Uccidere vite alla fine. Mai `pkill` su vitest.

## Review Focus

1. **Un'azione A che in realtà avvisa altri o fa partire un'automazione.**
   - Una task «tua» in AUD, dove Matteo segue le task nuove (seme
     `ALERT_SUBSCRIPTIONS`): sale a B con «Notifies Matteo Conti».
   - Una task tua in un progetto con un'automazione attiva su
     `task_created`: B con il motivo dell'automazione.
   - Una task tua chiusa con `updateTask`, con un'automazione su
     `task_closed`: B.
   - Una task assegnata a Marco in OLV, o una tua task spostata a lui con
     `planTask`: B con «Notifies Marco Bellini» (`task.assigned`,
     `planning.changed`) *(decisione del maintainer, 2 nov 2026)*.
   - Al contrario: una task tua senza iscritti né automazioni resta A,
     anche se compare nelle liste di tutti; un'automazione **in bozza** o
     **in pausa** sullo stesso evento non la alza.
   - Fra il calcolo e l'esecuzione qualcuno accende l'automazione: l'azione
     non parte, diventa una scheda col motivo.

   → Task 4, 5.
2. **«Annulla» dopo che altri hanno visto o toccato.** Le scene con Marco
   stanno in OLV o LMR, dove Marco è membro e Giulia Project Lead (Marco
   non è in MKX) *(ruling del controller (pre-flight), P3)*.
   - Marco ha aperto la task: si annulla (aprire non è scrivere).
   - Marco ha cambiato lo stato o commentato: «Marco Bellini changed it
     afterwards», niente cambia, il link porta alla task.
   - Roberta ha riaperto un progetto archiviato da Claude: il gruppo non si
     annulla, e nessuna delle sue azioni torna indietro (tutto o niente).
   - Chi chiede ha perso il permesso: rifiuto in parole con «Who?».
   - L'inverso chiede il codice e la grazia è scaduta: dialogo, poi l'inverso
     riparte da solo; chiuso il dialogo, niente cambia.
   - La notifica di Marco dice «Undone by Giulia Ferri», e Marco non riceve
     una seconda notifica.

   → Task 5, 8, 10.
3. **Strade laterali ai gesti delle persone.** Approvare un piano,
   mergiare, rispondere a una domanda, accendere un'automazione, registrare
   una decisione, creare un token o un link d'invito, un deploy, mandare
   un'email: nessuno passa dal riquadro, né come azione, né come «Modifica»
   di una scheda, né come inverso, né da una proposta iniettata nel flusso
   con una `fn` fuori dal catalogo (`applyActions` del riquadro la
   rifiuta). Per «registra la decisione» il dialogo si apre col **testo
   vuoto**. → Task 4, 6.
4. **Il «vedi come» a metà.**
   - Una scheda aperta da Giulia, confermata dopo il passaggio a Sara:
     `forbidden`, la scheda resta aperta per Giulia.
   - Un «Annulla» premuto da un'altra persona: `not_yours`.
   - La grazia della riconferma di Roberta non vale per Laura.
   - Il riquadro cambia conversazione con la persona; la bozza nella
     casella non passa all'altra.

   → Task 5, 7, 8.
5. **R-G5 nelle righe di Claude.**
   - La riga «chi ne sarà toccato» nomina solo persone che chi chiede vede,
     e non conta le altre.
   - «Can't find ACQ-99» identico per un codice invisibile, inesistente o di
     una task eliminata (anche citato in Chat, Docs, notifiche).
   - La voce `task.deleted` la leggono solo chi gestisce il progetto o ha
     `tickets.moderate` lì.
   - «Who?» di «Annulla» e dell'eliminazione mostra solo persone e progetti
     visibili.

   → Task 2, 5, 6, 9.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`.
Nessun codice.

- **`claude-panel.md`:**
  - il riquadro: aggancio a destra sopra la pagina, larghezza, ombra o
    bordo, come si chiude (Esc, ⌘J, la ×);
  - **convivenza col pannello della task** (`useDetailPanel`) a 1440, 1200,
    1024 e 800 px: affiancati, sovrapposti, quale vince;
  - la testata: titolo della conversazione, «New», «Open in Claude», il chip
    «You're looking at: ACQ-14 · task» con la × per toglierlo;
  - il bottone fisso nel binario (l'anello tratteggiato, in fondo) e lo
    stato «aperto»;
  - la conversazione vuota del riquadro (cosa invita a scrivere);
  - gli stati: in diretta, budget esaurito, sola lettura, «vedi come»
    appena cambiato;
  - la scorciatoia definitiva (⌘J, o un'altra se Electron la prende).
- **`claude-actions.md`:**
  - la **riga eseguita** (classe A, e B/C dopo la conferma): cosa, su cosa,
    il codice apribile, «Undo»; i suoi stati: annullabile, «Undone»,
    «Marco Bellini changed it afterwards · can't undo from here» col link,
    rifiuto con «Who?», «Didn't run» col motivo;
  - la **scheda B/C**: la riga «Notifies Marco Bellini», la riga del motivo
    di una classe salita («A automation in ACQ starts when a task is
    created»), «Can't be undone», il segno della riconferma per la C;
  - la **riga D**: una frase e il link al posto vero («Approving is yours:
    open the plan»);
  - come si legge tutto questo in una conversazione pubblica letta da un
    altro (righe chiuse, nessun bottone).
- **`claude-trace.md`:**
  - «Claude on behalf of Roberta Fontana» nel registro (Amministrazione e
    Progetto → Change log), la voce «… undid: …», e il filtro «Made with
    Claude»;
  - la testata del commento, l'evento nella storia della task, la riga
    nella rassegna del giorno per persona;
  - la notifica «Claude on behalf of Giulia Ferri assigned you ACQ-14» e il
    segno «Undone by Giulia Ferri».
- **`task-delete.md`:**
  - la voce «Delete task…» nel menu «⋯» della task, e quando è spenta (con
    la frase e il «Who?»);
  - il dialogo: codice e titolo, le figlie che restano senza madre, il
    `busy` in parole («Claude is working on it», «PR #42 is open»), il
    bottone rosso;
  - dopo: dove va il fuoco, il toast, la riga della richiesta d'origine
    («Task ACQ-14 was deleted»), la riga dell'esecuzione d'automazione, la
    notifica senza link («Task deleted»).

### Task 1: Le forme sincrone delle scritture del catalogo

Ogni scrittura che il catalogo chiama deve girare **senza attese** dentro
`applyActions`. Si estrae la sua parte dopo il cancello in una funzione
`…As(me, …)`, e la funzione pubblica diventa `writer()` + `…As`. Nessun
comportamento cambia.

**Files:**
- Modify:
  - `data/projectSettings/archive.ts`: `archiveProjectAs`, `reopenProjectAs`;
  - `data/projectSettings/general.ts`, `ai.ts`, `automations.ts`:
    `updateProjectGeneralAs`, `setProjectAiAs`, `saveProjectAutomationsAs`;
  - `data/admin/members.ts`: `addMemberAs`, `removeMemberAs`,
    `setMemberRoleAs`;
  - le scritture d'istanza del 9b che non portano segreti *(maintainer, 2
    nov 2026)*:
    - `data/instance/models.ts`: `setModelAs`;
    - `data/instance/budget.ts`: `saveBudgetAs` (budget e lingua dei
      contenuti);
    - `data/instance/automation.ts`: `saveAutomationAs` (automazione e
      regole delle PR);
    - `data/instance/providers.ts`: `setProviderEnabledAs`, `moveProviderAs`;
    - `data/instance/git.ts`: `updateGitAccountAs` (nome e workspace),
      `setDefaultReviewerAs`;
    - `data/instance/google.ts`: `updateGoogleAppAs` (nome, domini, client
      id);
    - `data/instance/plugins.ts`: `registerPluginAs`, `updatePluginRefAs`,
      `rerunSmokeAs`, `removePluginAs`;
    - `data/instance/queue.ts`: `pauseQueueAs`, `resumeQueueAs`;
    - `data/instance/retry.ts`: `retryJobAs`, che apre la sessione senza
      farla partire (la fa partire `CatalogRun.after`, Task 4, come
      `startRun` dopo una conferma);
    - `data/instance/storage.ts`: `saveStorageAs`, `setAttachmentsAs`;
    - `data/instance/webhook.ts`: `saveWebhookAs`;
  - `data/alerts/writes.ts`: `setSubscriptionAs`;
  - `data/api-mutations.ts`: `reopenRequestAs`, `deleteCommentAs`,
    `deleteMilestoneAs` (le pubbliche esistono già).
- Test: `data/claude/syncWrites.test.ts`.

Restano **senza** forma `…As`, perché non entrano nel catalogo:
- le scritture che creano, sostituiscono o cancellano un segreto
  (`createProvider`, `replaceProviderCredential`, `deleteProvider`,
  `createGitAccount`, `replaceGitToken`, `deleteGitAccount`,
  `createGoogleApp`, `replaceGoogleSecret`, `deleteGoogleApp`) *(maintainer:
  restano nel dialogo vero)*. Le tre `delete…` non portano il segreto negli
  argomenti, ma lo distruggono e il loro inverso dovrebbe riscriverlo;
- le verifiche (`testProvider`, `validateGitAccount`, `testStorage`,
  `testWebhook`), che non cambiano un'impostazione;
- le `simulate…` del riquadro «Prototype only».

Queste esclusioni sono *scelte del costruttore*, scritte nei follow-up del
Task 12.

**Interfaces, prodotte:** stesse firme delle pubbliche, sincrone e con `me`
in testa; stesso tipo di risposta (`ProjectResult`, `AdminResult`,
`InstanceResult<…>`; `void`/`throw` per quelle di `api-mutations.ts` e
`setSubscriptionAs`). Esempio:

```ts
export function archiveProjectAs(me: string, projectId: string): ProjectResult;
export function addMemberAs(me: string, projectId: string, personId: string, roleId: string): AdminResult;
export function setSubscriptionAs(me: string, projectId: string, type: string, change: { app?: boolean; phone?: boolean }): void;
export function moveProviderAs(me: string, id: string, toIndex: number): InstanceResult;
export function saveStorageAs(me: string, input: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey?: string }): InstanceResult;
export function retryJobAs(me: string, jobId: string): InstanceResult<{ conversationId: string }>;
```

La riconferma resta **dentro** le `…As` che la chiedono oggi
(`reauthRefusal(me, …)`): chi le chiama senza codice riceve
`reauth_required`.

Test:
- [ ] Per ognuna: la pubblica e la `…As` danno lo stesso esito sullo stesso
  stato (riuscita, `forbidden`, `invalid`, `reauth_required` dove c'è), e
  scrivono la stessa voce del registro.
- [ ] Nessuna `…As` gira con attese: il test chiama ognuna e verifica che
  il risultato non sia una `Promise` (`instanceof Promise` falso), non solo
  che il sorgente non dica `async` *(ruling del controller (pre-flight),
  P15)*.
- [ ] `retryJobAs` apre la sessione con l'`openRun` sincrono di
  `api-mutations.ts` (non con `startRunAs`, che è async) e non scrive
  eventi; la pubblica
  `retryJob` la fa partire come oggi (stesso esito del test del 9b).
- [ ] `registerPluginAs` e `updatePluginRefAs` senza riconferma →
  `reauth_required`, nessun job di plugin accodato.
- [ ] Le suite di 9a, 9b, 9c e dell'area 3 restano verdi.
- [ ] Commit `refactor(desktop): forme sincrone delle scritture del catalogo di Claude`.

### Task 2: «Elimina task» — livello dati

**Files:**
- Create: `data/taskDelete.ts`; test `data/taskDelete.test.ts`.
- Modify:
  - `data/store.ts`: `State.deletedTasks`, `freshState`; `ApiFnName` +
    `"deleteTask" | "getTaskDeletion"`;
  - `data/api-mutations.ts`: `buildTask` conta anche i codici di
    `state.deletedTasks` del progetto (un codice non si riusa mai);
  - `data/api.ts`: riesporta `deleteTask`, `getTaskDeletion`;
    `listNotifications` deriva `objectGone`; `listPortfolioActivity` e
    `listPeopleActivity` leggono l'evento d'eliminazione;
  - `data/types.ts`: `TimelineEvent` + `task_deleted`;
    `PersonDayActivity.tasksDeleted`;
  - `data/model.ts`: `AppNotification.objectGone?: boolean` e
    `ProjectRequest.deletedTaskCodes?: string[]`, entrambi solo a lettura
    (li derivano `listNotifications`, `getRequest`, `getRequestByCode` e
    `listRequests` da `state.deletedTasks`);
  - `data/automations/runView.ts`: un effetto `task` il cui codice è in
    `deletedTasks` si legge «task deleted», senza link;
  - `data/projectSettings/changeTypes.ts`: il tipo `task.deleted` (il file
    è già importato per effetto da `api-mutations.ts`; `taskDelete.ts` lo
    importa per effetto anche lui);
  - `data/changelog/visibility.ts`: `GROUP_ORDER` + `"tasks"` in fondo;
  - `domain/access/actions.ts`: `project("deleteTasks", "tickets.moderate")`,
    i18n `whoCan.actions.deleteTasks`;
  - i18n `changelog.kinds.task.deleted`, `changelog.groups.tasks`.

**Interfaces, prodotte:**

```ts
// data/model.ts
/** Una task eliminata: il codice resta preso per sempre (non si riusa). */
export interface DeletedTask { id: string; code: string; projectId: string; title: string; deletedAt: string; deletedById: string }
// data/taskDelete.ts
export type TaskBusyReason =
  | { kind: "claude_session"; code: string | null }   // null se chi guarda non vede la sessione
  | { kind: "open_pr"; repo: string; number: number }
  | { kind: "server_fix"; serverCode: string }
  | { kind: "release_fix"; releaseCode: string };
export interface TaskDeletionPreview {
  taskId: string; code: string; title: string;
  canDelete: boolean;
  /** Il «Who?» quando `canDelete` è falso per un permesso: `editTasks` (autore) o `deleteTasks`. */
  whoAction: "editTasks" | "deleteTasks" | null;
  busy: TaskBusyReason[];
  /** Le figlie che restano, senza madre. */
  children: { code: string; title: string }[];
}
export type TaskDeleteResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "forbidden" }
  | { ok: false; error: "busy"; reasons: TaskBusyReason[] };
export function canDeleteTask(me: string, task: Task): boolean;   // autore + tickets.edit, o tickets.moderate
export function deleteTaskAs(me: string, taskId: string): TaskDeleteResult;
export async function deleteTask(taskId: string): Promise<TaskDeleteResult>;
export async function getTaskDeletion(taskId: string): Promise<TaskDeletionPreview | null>; // null = invisibile o inesistente
```

`deleteTaskAs`, in quest'ordine (la forma di `data/admin/common.ts`):
`not_found` → `forbidden` → `busy` → scrittura + voce. La scrittura, tutta
insieme:
- toglie la task da `state.tasks` e aggiunge la riga a `state.deletedTasks`;
- toglie da ogni altra task i `links` verso di lei (`blocks`, `relates`,
  `parent`): le figlie restano, senza madre;
- toglie `activity`, `arrangements` e `decisionRequests` della task;
- lascia richiesta, traguardo, notifiche, esecuzioni d'automazione,
  conversazioni finite e PR chiuse: si leggono a lettura;
- `reindex()`;
- scrive `task.deleted` (scope progetto, `readPermission`
  `tickets.moderate`, gruppo `tasks`, `object: { type: "task", id, label:
  code }`, `params: { title }`).

`busy`: una conversazione `task_run` non `finished` della task (anche in
attesa), una PR aperta (`hasOpenPr`), una task con `serverRef` o
`releaseRef` non chiusa.

Test (`taskDelete.test.ts`):
- [ ] L'autore con `tickets.edit` elimina la sua; un altro senza
  `tickets.moderate` → `forbidden`, stato invariato, nessuna voce; con
  `tickets.moderate` (Laura in ACQ, se il ruolo lo dà, altrimenti una
  concessione nel test) → riesce.
- [ ] Claude collega non elimina una task che non ha creato lui (non ha
  `tickets.moderate`, R-L9; con `tickets.create`+`tickets.edit` la regola
  dell'autore gli lascerebbe le sue), e `whoCan(…, "deleteTasks", ACQ)` non
  lo include *(ruling del controller (pre-flight), P24)*.
- [ ] `busy` per ciascuna delle quattro ragioni; una sessione `finished`
  non conta.
- [ ] Figlie: restano nel progetto senza `parent`; una task bloccata solo da
  lei non è più bloccata (`linksOf`).
- [ ] Il codice non si riusa: elimino `ACQ-<max>`, la task nuova prende
  `ACQ-<max+1>`.
- [ ] Dopo: `getTaskByCode(code)` → `null` per tutti (come uno inesistente);
  la richiesta d'origine ha `deletedTaskCodes: [code]`; la notifica della
  task ha `objectGone: true`; l'effetto d'automazione dice «task deleted».
- [ ] La voce `task.deleted`: la legge Laura (Project Lead) e chi ha
  `tickets.moderate`; non la legge Sara (Contributor in ACQ); nessuna
  voce per chi non vede il progetto.
- [ ] `listPortfolioActivity` ha `task_deleted` con codice e titolo per chi
  vede il progetto; `listPeopleActivity` lo conta per chi l'ha eliminata.
- [ ] `getTaskDeletion` di una task invisibile → `null`; Sara su una task
  non sua → `canDelete: false`, `whoAction: "deleteTasks"`.
- [ ] Commit `feat(desktop): eliminare una task, con figlie, collegamenti e traccia`.

### Task 3: «Per conto di» nel livello dati

**Files:**
- Create: `data/claude/via.ts`; test `data/claude/via.test.ts`.
- Modify:
  - `data/changelog/types.ts`: `ChangeEntry` + `via?: "claude"`,
    `claudeActionId?: string`, `undoOf?: string`; `ChangeInput` **non**
    cambia; `ChangeFilter.via?: "claude"`; `ChangeFilterChoices.claude:
    boolean`;
  - `data/changelog/record.ts`: `recordChange` scrive `via`,
    `claudeActionId` e `undoOf` da `currentVia()`, mai dall'input;
  - `data/changelog/reads.ts`: il filtro `via`; `ChangeEntryView` porta
    `via` e `undoOf` (l'id solo se chi guarda legge anche la voce
    annullata, altrimenti `null`). La vista diventa `interface
    ChangeEntryView extends Omit<ChangeEntry, "undoOf" | "claudeActionId">`
    con `undoOf: string | null` calcolato, mai copiato con uno spread
    *(ruling del controller (pre-flight), P16)*;
  - `data/model.ts`: `ActivityEntry.via?: "claude"` e
    `ActivityEntry.claudeActionId?: string` (serve al «com'era» del Task 5
    per riconoscere le scritture del gruppo, *ruling del controller
    (pre-flight)*, P4); `AppNotification.viaClaude?: { personId: string;
    actionId: string }`; `DeletedTask.via?: "claude"` *(ruling del
    controller (pre-flight), P17)*;
  - `data/api-mutations.ts`: `publish`, `addCommentAs`, `commitTaskPatch`
    leggono `currentVia()`;
  - `data/alerts/publish.ts`: `publishAlert` lo stesso;
  - `data/api-mutations.ts`, la notifica diretta **`task.assigned`**
    *(decisione del maintainer, 2 nov 2026)*: `createTaskAs` (task nata già
    assegnata) e `commitTaskPatch` (ogni diff `assigneeId`, quindi anche
    `updateTask`, `planTask`, `reassignTask` e i bulk) chiamano
    `publish("task.assigned", task, assigneeId, …)` quando il nuovo
    assegnatario non è `null` e non è chi scrive. Nessuna notifica a chi si
    assegna da solo. Porta `viaClaude` come le altre. Un `planTask` che
    riassegna avvisa il nuovo assegnatario una volta sola: `task.assigned`
    sostituisce per lui `planning.changed`, che resta per chi perde la task
    e per uno spostamento di settimana senza riassegnazione. i18n
    `notifications.kinds.task_assigned` («You've been assigned ACQ-14» /
    «Ti è stata assegnata ACQ-14»); il tipo entra in ogni elenco di kind
    delle notifiche (filtri, icone, `NotificationItem`);
  - `data/api-mutations.ts`, `settleProposal` (una sola funzione, per ogni
    `ProposalPlace`: conversazione e thread della Chat; la Posta chiama
    `applyActions` da `mail/proposals.ts` e resta fuori): `applyActions`
    gira dentro `runAsClaude({ actionId: newId("ca"), undoOfActionId: null
    })`, così le scritture confermate in Chat portano il segno come quelle
    del riquadro *(maintainer, 2 nov 2026; dove: ruling del controller
    (pre-flight), P21)*. Il Task 5 sostituisce poi il ramo della
    conversazione con `executeGroup`. Le classi e le regole dell'area 4 non
    cambiano (tutto proposte), non nasce una riga in `state.claudeActions`
    e in Chat non c'è «Annulla»;
  - `data/taskDelete.ts`: l'evento d'eliminazione porta il segno
    (`DeletedTask.via`);
  - `data/types.ts`: `PersonDayActivity` (righe di task spostate,
    commenti, eliminate) + `viaClaude: boolean`; `TimelineEvent`
    `task_deleted` + `viaClaude?: boolean`.

**Interfaces, prodotte:**

```ts
// data/claude/via.ts — una foglia: non importa niente del livello dati.
export interface ViaClaude {
  /** L'azione di Claude che sta girando (`state.claudeActions`). */
  actionId: string;
  /** Solo dentro un «Annulla»: l'azione che si sta annullando. */
  undoOfActionId: string | null;
}
/** Esegue `fn` col segno; `fn` è sincrona (lancia se restituisce una Promise). */
export function runAsClaude<R>(mark: ViaClaude, fn: () => R): R;
/** Il segno dell'azione in corso, `null` fuori da `runAsClaude`. */
export function currentVia(): ViaClaude | null;
```

`recordChange` dentro un «Annulla» trova la voce dell'azione annullata
(stesso `object.id`, `claudeActionId` = `undoOfActionId`) e salva il suo id
in `undoOf`; se l'azione annullata non aveva scritto voci, `undoOf` resta
assente. Le voci salvano `via` come valore stabile; la frase
«Claude on behalf of …» la compone la pagina (Task 10).

Test:
- [ ] Fuori da `runAsClaude` nessuna voce, attività o notifica ha il segno.
- [ ] Dentro: la voce ha `actorId` = la persona e `via: "claude"`; il
  commento ha `authorId` = la persona e `via`; la notifica `planning.changed`
  ha `viaClaude.personId`; l'evento `task_deleted` ha `viaClaude`.
- [ ] `runAsClaude` con una funzione `async` lancia.
- [ ] Nessuna funzione esportata da `data/api.ts` accetta il segno come
  argomento: nessuna firma pubblica ha un parametro di tipo `ViaClaude` o
  `"claude"`; solo `via.ts` scrive il segno in modulo. Il `via` di
  `api.drive.recordOpen(fileId, via)` (anteprima/Google/download) non è il
  segno e il test non lo conta *(ruling del controller (pre-flight), P12)*.
- [ ] `task.assigned` *(decisione del maintainer)*: Giulia crea una task
  assegnata a Marco in OLV → Marco ha `task.assigned`; la riassegna a Elena
  con `updateTask` → Elena la riceve, Marco no; Giulia se l'assegna da sola
  → nessuna notifica; dentro `runAsClaude` la notifica ha
  `viaClaude.personId: "p-giulia"`; un `planTask` che sposta a Marco una
  task di Giulia dà a Marco una sola notifica (`task.assigned`); dentro un
  «Annulla» (`undoOfActionId` non nullo) nessuna. Le suite che contano le
  notifiche si aggiornano dove una scrittura assegna a un altro.
- [ ] `ChangeEntryView` letta da chi non legge la voce annullata: `undoOf`
  è `null`, e `claudeActionId` non c'è nella vista.
- [ ] `listChanges({ via: "claude" })` dà solo le voci col segno;
  `listChanges({ personId: "p-roberta" })` le include (la persona è
  Roberta); `listChangeFilterChoices().claude` è vero solo se chi guarda
  legge almeno una voce col segno.
- [ ] Una voce nata prima del 10a (senza `via`) si legge senza segno.
- [ ] @Claude nella Chat *(maintainer)*: una proposta `planTask` verso
  Marco (task di OLV, *ruling del controller (pre-flight)*, P3) confermata
  da Giulia in un thread → la voce o l'attività ha `via:
  "claude"` e `actorId` Giulia, la notifica di Marco ha
  `viaClaude.personId: "p-giulia"`, `state.claudeActions` non cambia; una
  scrittura a mano nello stesso thread (un messaggio di Giulia) non ha il
  segno.
- [ ] Commit `feat(desktop): il segno «per conto di» nelle scritture fatte da Claude`.

### Task 4: Il catalogo, le classi e i divieti

**Files:**
- Create: `data/claude/{types.ts,catalog.ts,classes.ts,index.ts}` (`types.ts`
  è la foglia dei tipi, senza import: `ClaudeActionFn`, `ObjectRef`,
  `CatalogInverse`, e dal Task 5 `ClaudeActionRecord`; *ruling del
  controller (pre-flight)*, P10); test
  `data/claude/catalog.test.ts`, `data/claude/classes.test.ts`,
  `data/claude/neverInCatalog.test.ts`.
- Modify:
  - `data/model.ts`: `ProposedAction.fn` + i nomi nuovi qui sotto (letti da
    `data/claude/types.ts`, mai da `catalog.ts`);
  - `data/api-mutations.ts`: `applyActions(me, actions, options?: {
    catalogOnly?: boolean })` esegue ogni `fn` del catalogo con
    `CLAUDE_CATALOG[fn].run`; con `catalogOnly` una `fn` fuori dal catalogo
    è `invalid: fn` prima di ogni scrittura (la Posta non lo passa)
    *(ruling del controller (pre-flight), P7)*; un rifiuto (`{ ok: false }`)
    diventa un `throw` col suo codice, così rimette lo stato.
    `FailureCode` + `"busy" | "reauth_required"` (oggi `failureCode()` li
    farebbe `"other"`), e un `busy` porta le sue ragioni fino ad `Applied`;
    i18n `claude.proposalFailed.{busy,reauth_required}` *(ruling del
    controller (pre-flight), P6)*.
    La voce `createTask` chiama `createTaskAs` (avviso `task.created`,
    `task.assigned` e segnale `task_created`), non più `buildTask`+`addTask`:
    così le ragioni di `classOf` sono quelle che succedono. Durante
    `applyActions` i segnali delle automazioni si **trattengono** (una coda
    nello store, `holdAutomationSignals()`): partono solo a gruppo riuscito
    e si scartano al rollback, perché `startRun` dell'ascoltatore di
    `sources.ts` parte subito e l'istantanea non lo ferma *(ruling del
    controller (pre-flight), P5)*. L'istantanea copre anche
    `projects`, `projectSettings`, `automationRuns`, `changelog`,
    `alertSubscriptions`, `deletedTasks`, `instance`, `googleWorkspaces`,
    `conversations` (la sessione aperta da `retryJob`) e `access` (questa
    con `writeAccess`, che tiene l'identità di `accessState()`). Una voce
    con `after` lo esegue solo dopo che tutto il gruppo è riuscito, come le
    sessioni di `startRun`: `applyActions` non attende, restituisce gli
    `after` e li chiama chi l'ha chiamata (`settleProposal`,
    `executeGroup`);
  - `data/store.ts`: la coda dei segnali trattenuti (P5);
  - `data/alerts/visibility.ts`: `wouldNotify`;
  - `data/automations/sources.ts`: `automationsStartingOn`;
  - `data/api.ts`: `export * as claude from "./claude"`.

**Interfaces, prodotte:**

```ts
// data/claude/types.ts — foglia, nessun import (P10)
export type ClaudeActionFn =
  | "createTask" | "updateTask" | "planTask" | "addComment" | "deleteComment"
  | "createRequest" | "convertRequest" | "archiveRequest" | "reopenRequest"
  | "startRun" | "createMilestone" | "deleteMilestone" | "deleteTask"
  | "archiveProject" | "reopenProject"
  | "addMember" | "removeMember" | "setMemberRole"
  | "updateProjectGeneral" | "setProjectAi" | "saveProjectAutomations"
  // Le impostazioni d'istanza del 9b senza segreti (maintainer, 2 nov 2026).
  | "setModel" | "saveBudget" | "saveAutomation"
  | "setProviderEnabled" | "moveProvider"
  | "updateGitAccount" | "setDefaultReviewer" | "updateGoogleApp"
  | "registerPlugin" | "updatePluginRef" | "rerunSmoke" | "removePlugin"
  | "pauseQueue" | "resumeQueue" | "retryJob"
  | "saveStorage" | "setAttachments" | "saveWebhook"
  | "setSubscription";
export type ObjectRef =
  | { kind: "task"; id: string }
  | { kind: "request"; id: string }
  | { kind: "milestone"; id: string }
  | { kind: "project"; id: string }
  | { kind: "member"; projectId: string; personId: string }
  | { kind: "projectSettings"; projectId: string }
  /**
   * Un'impostazione d'istanza: "budget", "model:<operation>", "automation",
   * "providers" (abilitazione e ordine), "gitAccount:<id>", "reviewer",
   * "googleApp:<id>", "plugin:<id>", "queue:<projectId>", "storage",
   * "attachments", "webhook". Il «com'era» la confronta con le voci del
   * registro sullo stesso oggetto.
   */
  | { kind: "instanceSetting"; key: string }
  | { kind: "subscription"; projectId: string; type: string };
/** L'inverso coi valori di prima, `null` = non si annulla. */
export type CatalogInverse = { fn: ClaudeActionFn; args: Record<string, unknown> } | null;
// data/claude/catalog.ts
export interface CatalogRun {
  codes: string[]; projectIds: string[];
  inverse: CatalogInverse;
  objects: ObjectRef[];
  /** Il lavoro che parte solo a gruppo riuscito (la sessione di `retryJob`). */
  after?: (gen: number) => Promise<void>;
}
export interface CatalogEntry {
  fn: ClaudeActionFn;
  apiFn: ApiFnName;
  /** La classe dichiarata: A o B. La C viene da `REAUTH_REQUIRED`, mai da qui. */
  baseClass: "A" | "B";
  /** Se la voce ha un inverso (il valore vero lo dà `run`). */
  undoable: boolean;
  /** L'azione di `ACTIONS` per il «Who?» di un rifiuto; `null` solo per `setSubscription` (P19). */
  whoAction: string | null;
  /** Sincrona; lancia come `applyActions` (`forbidden`, `not_found`, `invalid: …`, `busy`, `reauth_required`). */
  run(me: string, args: Record<string, unknown>): CatalogRun;
}
export const CLAUDE_CATALOG: Readonly<Record<ClaudeActionFn, CatalogEntry>>;
export const isCatalogFn: (fn: string) => fn is ClaudeActionFn;
/** La classe dichiarata alzata dalla riconferma: C se `apiFn` è in `REAUTH_REQUIRED`. */
export function declaredClassOf(fn: ClaudeActionFn): "A" | "B" | "C";
// data/claude/classes.ts
export type ClassReason =
  /** `personIds`: chi riceverebbe un avviso e chi chiede vede; `more`: ce n'è anche fuori da quelli (mai contati). */
  | { kind: "notifies"; personIds: string[]; more: boolean }
  | { kind: "automation"; projectId: string }
  | { kind: "irreversible" }
  | { kind: "reauth" };
export interface ActionClass { cls: "A" | "B" | "C"; reasons: ClassReason[] }
export function classOf(me: string, action: Pick<ProposedAction, "fn" | "args">): ActionClass;
/** La classe di un gruppo: la più alta, coi motivi di tutte. */
export function classOfGroup(me: string, actions: Pick<ProposedAction, "fn" | "args">[]): ActionClass;
// data/alerts/visibility.ts
export function wouldNotify(me: string, alert: { kind: string; projectId: string; mandatory?: { personId: string; reason: MandatoryReason }[] }): { personIds: string[]; more: boolean };
// data/automations/sources.ts
export function automationsStartingOn(h: Happening): string[]; // id delle attive che partirebbero (`startsOn`)
// data/api-mutations.ts (P6, P7)
export type FailureCode = "forbidden" | "not_found" | "invalid" | "conflict" | "busy" | "reauth_required" | "other";
export type Applied =
  | {
      ok: true; codes: string[]; projectIds: string[]; runs: Task[];
      /** Per azione, nell'ordine: inverso e oggetti (la riga di `state.claudeActions`). */
      catalogRuns: (CatalogRun | null)[];
      /** Il lavoro da far partire a gruppo riuscito (la sessione di `retryJob`). */
      after: ((gen: number) => Promise<void>)[];
    }
  | { ok: false; index: number; code: FailureCode; reasons?: (BusyReason | TaskBusyReason)[] };
export function applyActions(me: string, actions: ProposedAction[], options?: { catalogOnly?: boolean }): Applied;
```

Il catalogo, con i valori del design (parte 2) e le scelte del costruttore
per le voci che il design non elenca:

| `fn` | `apiFn` | base | inverso | `whoAction` |
|---|---|---|---|---|
| `createTask` | `createTask` | A | `deleteTask` (eccezione senza scheda) | `createTasks` |
| `updateTask` | `updateTask` | A | `updateTask` coi valori di prima | `editTasks` |
| `planTask` | `planTask` | A | `planTask` con assegnatario e settimana di prima | `editTasks` |
| `addComment` | `addComment` | B | `deleteComment` | `commentTasks`* |
| `deleteComment` | `deleteComment` | B | — | `moderateComments` |
| `createRequest` | `createRequest` | B | — | `addRequests` |
| `convertRequest` | `convertRequest` | B | — | `editBacklog` |
| `archiveRequest` | `archiveRequest` | B | `reopenRequest` | `editBacklog` |
| `reopenRequest` | `reopenRequest` | B | `archiveRequest` | `editBacklog` |
| `startRun` | `startRun` | B | — | `startRun` |
| `createMilestone` | `createMilestone` | B | `deleteMilestone` | `editTasks` (P19) |
| `deleteMilestone` | `deleteMilestone` | B | — | `editTasks` (P19) |
| `deleteTask` | `deleteTask` | B | — | `deleteTasks` |
| `archiveProject` | `projectSettings.archiveProject` | B | `reopenProject` | `manageProjectSettings` |
| `reopenProject` | `projectSettings.reopenProject` | B | `archiveProject` | `manageProjectSettings` |
| `addMember` | `admin.addMember` | (C) | `removeMember` | `manageMembers` |
| `removeMember` | `admin.removeMember` | (C) | `addMember` col ruolo di prima | `manageMembers` |
| `setMemberRole` | `admin.setMemberRole` | (C) | `setMemberRole` col ruolo di prima | `manageMembers` |
| `updateProjectGeneral` | `projectSettings.updateProjectGeneral` | B | valori di prima | `manageProjectSettings` |
| `setProjectAi` | `projectSettings.setProjectAi` | B | valori di prima | `manageProjectSettings` |
| `saveProjectAutomations` | `projectSettings.saveProjectAutomations` | B | valori di prima | `manageProjectSettings` |
| `setModel` | `instance.setModel` | B | modello di prima | `manageSettings` |
| `saveBudget` | `instance.saveBudget` | B | budget e lingua dei contenuti di prima | `manageSettings` |
| `saveAutomation` | `instance.saveAutomation` | B | regole e revisione delle PR di prima | `manageSettings` |
| `setProviderEnabled` | `instance.setProviderEnabled` | B | stato di prima | `manageAiProviders` |
| `moveProvider` | `instance.moveProvider` | B | `moveProvider` alla posizione di prima | `manageAiProviders` |
| `updateGitAccount` | `instance.updateGitAccount` | B | nome e workspace di prima | `manageGitAccounts` |
| `setDefaultReviewer` | `instance.setDefaultReviewer` | B | il revisore di prima (`replaced`) | `manageGitAccounts` |
| `updateGoogleApp` | `instance.updateGoogleApp` | B | nome, domini e client id di prima | `manageIntegrations` |
| `registerPlugin` | `instance.registerPlugin` | (C) | — | `managePlugins` |
| `updatePluginRef` | `instance.updatePluginRef` | (C) | — | `managePlugins` |
| `rerunSmoke` | `instance.rerunSmoke` | B | — | `managePlugins` |
| `removePlugin` | `instance.removePlugin` | B | — | `managePlugins` |
| `pauseQueue` | `instance.pauseQueue` | B | `resumeQueue` | `manageSettings` |
| `resumeQueue` | `instance.resumeQueue` | B | `pauseQueue` | `manageSettings` |
| `retryJob` | `instance.retryJob` | B | — | `manageSettings` (e `startRun` nel progetto: la funzione chiede tutti e due) |
| `saveStorage` | `instance.saveStorage` | (C) | valori di prima, senza chiave | `manageSettings` |
| `setAttachments` | `instance.setAttachments` | B | stato di prima | `manageSettings` |
| `saveWebhook` | `instance.saveWebhook` | B | acceso, formato, URL ed eventi di prima | `manageSettings` |
| `setSubscription` | `alerts.setSubscription` | A | stato di prima della riga | `null` (solo tuo) |

`*` se `ACTIONS` non ha già un'azione per quel permesso, si aggiunge con la
sua chiave i18n `whoCan.actions.<chiave>`; il test lo controlla. Dopo il
pre-flight l'unica nuova è `commentTasks` (`tickets.comment`): i traguardi
chiedono `tickets.edit`, che ha già `editTasks`, e un'azione doppia sullo
stesso permesso non serve *(ruling del controller (pre-flight), P19)*.

Le righe d'istanza *(maintainer, 2 nov 2026)*:
- `(C)` vuol dire che la classe viene da `REAUTH_REQUIRED`:
  `registerPlugin`, `updatePluginRef` e `saveStorage` ci sono. Per
  `saveStorage` il 9b chiede il codice solo con una chiave nuova, ma la
  classe segue il registro e non scende *(scelta del costruttore: una classe
  sale, mai scende)*;
- **nessun segreto entra da qui**: la voce `saveStorage` rifiuta
  (`invalid: secret_access_key`) degli argomenti con `secretAccessKey`, prima
  di ogni scrittura; la chiave si scrive solo nel dialogo vero. Il suo
  inverso rimette endpoint, regione, bucket e access key id, mai la chiave;
- `registerPlugin` e `updatePluginRef` non si annullano: il plugin gira già
  allo smoke run (CLAUDE.md, «Registrare un plugin ne ESEGUE già il
  codice»). Neanche `rerunSmoke`, `removePlugin` e `retryJob`, che fanno
  partire lavoro o tolgono ciò che si rimetterebbe solo con la riconferma;
- le altre si annullano col valore di prima, letto dentro `run` prima della
  scrittura.

`classOf`, in quest'ordine, e senza mai scendere sotto `declaredClassOf`:
- `createTask`: B se l'assegnatario è un'altra persona, con motivo
  `notifies` per lei (la notifica diretta `task.assigned`, *decisione del
  maintainer, 2 nov 2026*); motivo `notifies` anche da
  `wouldNotify(me, { kind: "task.created", projectId })`; motivo
  `automation` da `automationsStartingOn` con l'evento `task_created` e il
  payload costruito dagli argomenti (gli stessi campi di `happenings`).
  Una task non assegnata, senza avvisi né automazioni, resta A (*scelta del
  controller*, 2 nov 2026: i criteri del design sono solo due);
- `updateTask`: B se cambia l'assegnatario a un altro (`notifies` col nuovo
  assegnatario, `task.assigned`), o se porta la task in una famiglia
  `closed` e `automationsStartingOn` con `task_closed` trova qualcosa, o se
  la task non è assegnata a chi chiede;
- `planTask`: B quando l'insieme delle persone che `planTaskAs` avviserebbe
  (assegnatario di prima e di dopo, meno chi chiede: `planning.changed` e
  `task.assigned`) non è vuoto, con `notifies` quelle persone; quindi anche
  quando sposti la TUA task a Marco *(ruling del controller (pre-flight),
  P9)*. Le notifiche dirette (`publish`) non passano da `wouldNotify`, che
  resta per gli avvisi del catalogo: `classOf` usa per loro la stessa
  funzione dei destinatari che usa la scrittura (estratta da `planTaskAs` e
  `commitTaskPatch`), filtrata per visibilità come `wouldNotify`;
- `setSubscription`: A;
- tutte: `irreversible` se `undoable` è falso (sempre almeno B); `reauth`
  per le C.

Test:
- [ ] **Registro** (`catalog.test.ts`): ogni voce ha `baseClass`, `undoable`,
  `whoAction` presente in `ACTIONS` (o `null` solo per `setSubscription`);
  ogni `apiFn` in `REAUTH_REQUIRED` dà `declaredClassOf` = `"C"`; nessuna voce
  `undoable: false` ha `baseClass: "A"`; ogni inverso è a sua volta una
  voce del catalogo.
- [ ] **Mai nel catalogo** (`neverInCatalog.test.ts`, sullo stile di
  `decisions-never-ai.test.ts`): il sorgente di `data/claude/*.ts` e di
  `domain/claude/intents/*.ts` non fa riferimento in codice a nessuna delle
  funzioni della Global Constraint «Il catalogo non nomina mai»: chiamata
  (`\bnome\s*\(`), import (`import … nome`) o accesso
  (`api.<ns>.nome`, `.nome(`). Le parole in un commento, in una regex di
  riconoscimento o in un link non contano: `refused.ts` deve poter
  riconoscere «merge» e «publish» *(ruling del controller (pre-flight),
  P11)*. Il test prova anche il suo risolutore: un file finto con
  `mergePr(` viene trovato. `CLAUDE_CATALOG` non ha
  una chiave `recordDecision`, `mergePr`, `decidePlan`, `answerQuestion`,
  `activate`, `publish`, né una delle scritture di segreti del 9b
  (`createProvider`, `replaceProviderCredential`, `deleteProvider`,
  `createGitAccount`, `replaceGitToken`, `deleteGitAccount`,
  `createGoogleApp`, `replaceGoogleSecret`, `deleteGoogleApp`).
- [ ] **Nessun segreto dal riquadro**: `saveStorage` con `secretAccessKey`
  negli argomenti → `invalid`, `state.instance.storage` invariato, nessun
  valore nel caveau (`__secretValuesForTest()` uguale a prima).
- [ ] Gli inversi d'istanza: `moveProvider` annullato rimette l'ordine;
  `setDefaultReviewer` annullato rimette il revisore di prima (anche
  `null`); `saveBudget` annullato rimette budget **e** lingua dei
  contenuti; `pauseQueue` annullato riprende la coda.
- [ ] `retryJob` in un gruppo che poi fallisce: nessuna sessione nasce né
  parte; riuscito, la sessione parte dopo (`after`).
- [ ] **Classi** (`classes.test.ts`), Review Focus 1:
  - Giulia crea in MKX una task sua: A, nessun motivo;
  - in AUD (Matteo iscritto a `task.created`): B, `notifies` con
    `["p-matteo"]`;
  - con un'automazione attiva su `task_created` nel progetto (creata nel
    test): B, `automation`; la stessa in bozza o in pausa: A;
  - assegnata a Marco in OLV: B con `notifies` `["p-marco"]`
    (`task.assigned`, *decisione del maintainer*); una task di Giulia in
    OLV spostata a Marco con `planTask`: B con `notifies` `["p-marco"]`
    (P9); la stessa spostata solo di settimana, restando di Giulia: A;
  - `updateTask` della propria task a `done` con un'automazione su
    `task_closed`: B;
  - una task **non assegnata** di Giulia in MKX, senza avvisi né
    automazioni: A (*scelta del controller*);
  - `addMember` → C con `reauth`; `deleteTask` → B con `irreversible`;
  - le righe d'istanza: `setModel`, `saveWebhook`, `pauseQueue` → B;
    `registerPlugin`, `updatePluginRef`, `saveStorage` → C con `reauth`;
    `registerPlugin` e `retryJob` portano anche `irreversible`;
  - `notifies` non nomina chi chiede né Claude; una persona che chi chiede
    non vede non c'è in `personIds` e accende `more`.
- [ ] `applyActions` con `archiveProject` + un'azione che fallisce: lo
  stato torna com'era, `project.archived` compreso, e nessuna voce resta nel
  registro; con `addMember` + un fallimento, `accessState()` è lo stesso
  oggetto di prima con le stesse appartenenze.
- [ ] *(ruling del controller (pre-flight), P5)*: `createTask` dal catalogo
  in un progetto con un'automazione attiva su `task_created` fa partire
  l'esecuzione e pubblica `task.created`; lo stesso `createTask` seguito da
  un'azione che fallisce: nessuna esecuzione in `state.automationRuns`,
  nessun avviso, e la coda dei segnali trattenuti è vuota.
- [ ] *(ruling del controller (pre-flight), P6, P7)*: un `deleteTask`
  `busy` nel gruppo dà `{ ok: false, code: "busy", reasons }`; un
  `addMember` senza riconferma `code: "reauth_required"`; con `catalogOnly`
  una `recordDecision` è `invalid` senza scrivere, senza `catalogOnly`
  (Posta) gira come oggi; un gruppo riuscito ha `catalogRuns` con gli
  inversi e `after` con la sessione di `retryJob`.
- [ ] *(ruling del controller (pre-flight), P10)*: `architecture.secrets.test.ts`
  resta verde, e `data/claude/types.ts` non ha import.
- [ ] Commit `feat(desktop): catalogo delle azioni di Claude, classi calcolate e divieti`.

### Task 5: Eseguire per classe, il registro delle azioni e «Annulla»

**Files:**
- Create: `data/claude/actions.ts` (registro delle azioni e «Annulla»);
  test `data/claude/actions.test.ts`, `data/claude/undo.test.ts`.
- Modify:
  - `data/model.ts`:
    - `ConversationEvent` + il tipo `executed`;
    - l'evento `proposal` + `cls?`, `reasons?`, `groupId?`;
  - `data/store.ts`: `State.claudeActions`, `freshState`; `ApiFnName` +
    `"claude.undo"`;
  - `data/types.ts`: `ConversationDetail.undo?` (facoltativo, letto `?? {}`,
    *ruling del controller (pre-flight)*, P25);
  - `data/claude/types.ts`: `ClaudeActionRecord` (P10);
  - il `seq` (`nextSeq()`) sulle scritture che il «com'era» confronta:
    `ActivityEntry.seq?`, `ChangeEntry.seq?`, le voci della cronologia di
    richieste e traguardi e della `history` delle iscrizioni (che lo hanno
    già da R-K19), più `ActivityEntry.claudeActionId` del Task 3
    *(ruling del controller (pre-flight), P4)*;
  - `data/api-mutations.ts`:
    - `freeTurn` passa `classify` al motore e, prima di `runScript`,
      esegue gli eventi `executed` in attesa (sotto);
    - `settleProposal` registra il gruppo e chiede la riconferma per la C;
    - `ProposalOutcome` + `{ ok: false; error: "reauth_required" }`;
    - nel riquadro e nella destinazione «Claude», `applyActions` rifiuta
      (`invalid: fn`) una `fn` che non è nel catalogo, anche se l'evento è
      già nel flusso (Review Focus 3): `executeGroup` e la `settleProposal`
      delle conversazioni la chiamano con `{ catalogOnly: true }`; la Posta
      continua a usare le sue (`recordDecision`, `chooseProject`…) dal suo
      percorso, senza l'opzione *(ruling del controller (pre-flight), P7)*;
  - `data/api.ts`: `getConversation` calcola `undo`;
    `listNotifications` deriva `undoneByName`;
  - `data/queries.ts`: `useUndoClaudeActions` (`useWrite`, aree della
    conversazione, delle task, del registro e delle notifiche);
  - `domain/claude/context.ts`: `IntentContext.classify`;
  - `domain/claude/answers.ts`: `Answer.execute?: ProposedAction[]`, e
    `toSteps` che lo emette come `executed` `pending`;
  - `domain/claude/intents/change.ts`: con `ctx.classify`, `create`,
    `assign` e `plan` rispondono con la frase «fatto» e `execute` se A, con
    la frase della proposta e `proposal` se B/C; senza `classify` (Chat)
    come oggi; `run` resta sempre proposta;
  - i18n `claude.answers.{create.done,assign.done,plan.done,classRaised}`.

**Interfaces, prodotte:**

```ts
// data/claude/types.ts (foglia, P10)
export interface ClaudeActionRecord {
  id: string;               // newId("ca")
  groupId: string;
  conversationId: string;
  /** Chi l'ha chiesta: è anche chi agisce, per i permessi e il registro. */
  personId: string;
  at: string;               // now()
  /** `nextSeq()` all'esecuzione: l'ordine del «com'era» (l'orologio è fermo, P4). */
  seq: number;
  fn: ClaudeActionFn;
  args: Record<string, unknown>;
  cls: "A" | "B" | "C";
  inverse: CatalogInverse;
  objects: ObjectRef[];
  undone: { at: string; byId: string } | null;
}
// ConversationEvent, il tipo nuovo
| {
    id: string; at: string; type: "executed";
    groupId: string;
    actions: ProposedAction[];
    /** `pending` solo fra il motore e l'esecuzione: non arriva mai a chi legge. */
    status: "pending" | "done" | "failed";
    resultCodes?: string[];
    /** Perché non è partita (`claude.executed.failed.<codice>`). */
    errorText?: Utterance;
  }
// data/types.ts
export type UndoView =
  | { state: "available"; needsReauth: boolean }
  | { state: "undone"; byName: string; at: string }
  /** `byName`/`code` nulli se chi guarda non vede chi ha scritto o l'oggetto (R-G5). */
  | { state: "changed_after"; byName: string | null; code: string | null }
  | { state: "not_undoable" }
  /** Chi legge una pubblica altrui: la riga è chiusa. */
  | { state: "not_yours" };
ConversationDetail.undo?: Record<string /* groupId */, UndoView>;
AppNotification.undoneByName?: string | null;   // solo a lettura
// data/claude/actions.ts
/** Con `applyActions(…, { catalogOnly: true })`; scrive le righe da `Applied.catalogRuns`; gli `after` li chiama il chiamante a gruppo riuscito. */
export function executeGroup(me: string, conversationId: string, actions: ProposedAction[], cls: "A" | "B" | "C"): { ok: true; groupId: string; codes: string[]; projectIds: string[]; runs: Task[]; after: ((gen: number) => Promise<void>)[] } | { ok: false; index: number; code: FailureCode; reasons?: (BusyReason | TaskBusyReason)[] };
/** La prima scrittura sugli oggetti del gruppo con `seq` maggiore di quello della riga, che non sia del gruppo stesso (`claudeActionId`). */
export function laterChangeOf(group: ClaudeActionRecord[]): { byId: string | null; ref: ObjectRef } | null;
export function undoViewOf(viewerId: string, groupId: string): UndoView;
export type UndoResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "not_yours" | "already_undone" | "not_undoable" | "reauth_required" }
  | { ok: false; error: "changed_after"; byName: string | null; code: string | null }
  | { ok: false; error: "forbidden"; whoAction: string; projectId: string | null }
  | { ok: false; error: "busy"; reasons: (BusyReason | TaskBusyReason)[] };
export async function undoClaudeActions(conversationId: string, groupId: string): Promise<UndoResult>;
// domain/claude/context.ts
IntentContext.classify?: (actions: Pick<ProposedAction, "fn" | "args">[]) => Promise<ActionClass>;
```

Regole:
- **Esecuzione A.** Il motore (`toSteps`, qui sopra) emette un `executed` con `status:
  "pending"` quando `classify` dice A. `freeTurn`, prima di `runScript`,
  ricalcola `classOfGroup`: se è ancora A esegue (`executeGroup` dentro
  `runAsClaude`) e mette `done` coi codici, o `failed` con il motivo; se è
  salita, l'evento diventa un `proposal` aperto con `cls` e `reasons`, e
  segue la frase `claude.answers.classRaised`.
- **Esecuzione B/C.** `settleProposal` (conversazione) calcola `classOfGroup`
  sulle azioni scelte. Per una C senza riconferma fresca risponde
  `reauth_required` **senza toccare la proposta** (resta aperta, nessuna
  presa in `claims`). Poi `executeGroup`, e la proposta confermata porta
  `groupId`. La Chat (`ProposalPlace` dei thread) non cambia nelle classi
  e non ha «Annulla»; il segno `via` delle sue conferme lo mette il Task 3.
- **«Com'era»** (*scelta del costruttore*: confronto per scritture, non per
  versioni). Un oggetto è cambiato se dopo l'azione c'è, da una persona o
  da Claude fuori dal gruppo, una scrittura. «Dopo» vuol dire `seq`
  maggiore del `seq` della riga, mai `at`: con l'orologio fermo tutte le
  scritture della sessione hanno lo stesso `at`. «Fuori dal gruppo» vuol
  dire `claudeActionId` diverso dalle azioni del gruppo *(ruling del
  controller (pre-flight), P4)*. Le scritture contate:
  - task: una voce di `activity`, una conversazione `task_run` nata, o
    l'eliminazione;
  - richiesta, traguardo: un cambio di `status`/campo letto dalla loro
    cronologia, o l'eliminazione;
  - progetto, membro, impostazioni: una voce del registro sullo stesso
    oggetto;
  - iscrizione: una voce della `history` della riga.
  Aprire o leggere non conta.
- **«Annulla»**: solo chi l'ha chiesta (`not_yours` altrimenti, anche dopo
  il «vedi come»); `already_undone`; `not_undoable` se un'azione del gruppo
  non ha inverso; `changed_after` dal controllo qui sopra; poi gli inversi,
  in ordine inverso, con `executeGroup` dentro `runAsClaude({ undoOfActionId
  })`, tutti o nessuno. Un rifiuto dell'inverso diventa la risposta
  (`forbidden` con il `whoAction` della voce, `busy`, `reauth_required`).
  L'inverso di `createTask` è `deleteTask` senza scheda, con permesso,
  `busy` e traccia dell'eliminazione. Riuscito: `undone` su ogni azione del
  gruppo. Nessuna notifica nuova: `publish` e `publishAlert` dentro un
  «Annulla» non scrivono (`currentVia().undoOfActionId !== null`).
- **«Undone by»** sulla notifica: `viaClaude.actionId` → l'azione → il suo
  `undone.byId` → il nome, a lettura.

Test:
- [ ] Il motore: `create` con `classify` → A dà `create.done` ed `execute`;
  → B dà `create.proposal` e `proposal`; senza `classify` (Chat) la
  `proposal` di oggi.
- [ ] (`actions.test.ts`) Giulia, conversazione libera, «crea "Prova" in MKX»:
  la task nasce subito, il flusso ha un `executed` `done` con il codice,
  `state.claudeActions` ha una riga A, la task ha `createdById` Giulia.
- [ ] Stessa frase in AUD: nessuna task, una proposta aperta con `cls: "B"`
  e `reasons` `notifies` di Matteo.
- [ ] Fra il calcolo e l'esecuzione si accende un'automazione su
  `task_created`: proposta, non task. In `freeTurn` non c'è un'attesa fra
  `respond` e `runScript`, quindi il test accende l'automazione dentro uno
  spy di `ctx.classify`, dopo che ha risposto A; il ricalcolo
  `classOfGroup` di `freeTurn` la vede *(ruling del controller
  (pre-flight), P26)*.
- [ ] *(ruling del controller (pre-flight), P4)*: due azioni A di fila
  sulla stessa task (crea, poi «spostala a W46» in un secondo messaggio):
  la prima diventa `changed_after` con il nome di Giulia, anche se le due
  scritture hanno lo stesso `at`; la scrittura del gruppo stesso non
  rende `changed_after`.
- [ ] @Claude nella Chat con la stessa frase in MKX: proposta, come
  nell'area 4.
- [ ] C: `addMember` confermato senza riconferma → `reauth_required`, la
  proposta resta `open`, nessuna scrittura; dopo `markReauthenticated` →
  riesce; la grazia di Roberta non vale per Laura.
- [ ] Una proposta nel flusso con `fn: "recordDecision"` (iniettata con
  `runScript`) confermata nel riquadro → `failed` con `invalid`.
- [ ] Coda di MKX in pausa (9b): una scheda `startRun` confermata fa
  nascere la sessione in attesa, come a mano; la conversazione del riquadro
  risponde lo stesso.
- [ ] (`undo.test.ts`) Review Focus 2. Le task con Marco nascono in OLV
  (Marco membro, Giulia Project Lead, senza iscritti né automazioni su
  `task_created`), non in MKX, dove Marco non c'è *(ruling del controller
  (pre-flight), P3)*:
  - «Annulla» della task creata: la task non c'è più, voce `task.deleted`
    con `via` e `undoOf`, `undo` → `undone` per Giulia;
  - Marco commenta la task prima: `changed_after` con «Marco Bellini» e il
    codice; niente cambia;
  - Marco l'ha solo aperta (`getTask`): si annulla;
  - archiviazione di due progetti in una scheda, Roberta ne riapre uno:
    `changed_after`, l'altro resta archiviato;
  - Giulia perde `project.settings.manage` (concessione revocata nel test):
    `forbidden` con `whoAction: "manageProjectSettings"`;
  - `removeMember` come inverso con la grazia scaduta: `reauth_required`;
  - un'altra persona: `not_yours`; due volte: `already_undone`;
  - `planTask` verso Marco annullato: la notifica di Marco (`task.assigned`,
    *decisione del maintainer*) ha `undoneByName: "Giulia Ferri"`, e Marco
    non ha una seconda notifica;
  - l'inverso rifiutato per `busy` dà `{ error: "busy", reasons }` con le
    ragioni, quello senza riconferma `reauth_required` (P6).
- [ ] `getConversation` letto da un altro in una pubblica: ogni `undo` è
  `not_yours`, e nessuna `UndoView` nomina persone o codici che lui non vede
  (minuscole comprese).
- [ ] Commit `feat(desktop): Claude esegue per classe, e «Annulla» come azione inversa`.

### Task 6: Gli intenti del 10a

Il motore resta puro: legge, classifica (con `ctx.classify`), non scrive.

**Files:**
- Create: `domain/claude/intents/remove.ts` («elimina ACQ-14»),
  `domain/claude/intents/refused.ts` (la classe D); test
  `domain/claude/intents.10a.test.ts`.
- Modify:
  - `domain/claude/intents.ts`: `Intent` + `"remove" | "refused"`;
    `recognize` prova `refused` prima dei comandi (un «approva il piano di
    AUD-4» non diventa mai un'altra cosa), poi `remove` come comando;
  - `domain/claude/answers.ts`: `Answer.place?: { route: string | null;
    labelKey: string }` per la riga D, che `toSteps` scrive come un passo
    `say` con la frase e il link markdown al posto (nessun tipo d'evento
    nuovo);
  - `pages/overview/DecisionLog.tsx`: `?recordDecision=1&task=<code>` apre
    `RecordDecisionDialog` con progetto e task scelti e **testo vuoto**. Il
    dialogo oggi non ha la task: riceve una prop `taskId` (risolta dal
    codice con la visibilità di chi guarda; invisibile o inesistente: il
    dialogo si apre senza task) che va in `DecisionDraft.taskId`, già
    previsto dall'API, e la mostra in testa al dialogo, senza un selettore
    nuovo *(ruling del controller (pre-flight), P18)*. Il nome del
    parametro resta: il test `neverInCatalog` cerca riferimenti di codice,
    non parole (P11);
  - i18n `claude.answers.{remove.*,refused.*}`.

**Interfaces, prodotte:**

```ts
export type RefusedTopic =
  | "approve_plan" | "merge" | "answer_question" | "record_decision"
  | "activate_automation" | "secret" | "server" | "send";
export async function refused(text: string, ctx: IntentContext): Promise<Answer>;
export async function remove(text: string, ctx: IntentContext): Promise<Answer>;
export function refusedTopicOf(text: string): RefusedTopic | null;
```

Le righe D (en/it, una riga, poi il link al posto vero):
- `approve_plan` → la scheda del piano della task (`#/p/<CODE>/tasks?task=<code>`);
- `merge` → la coda di rilascio del progetto;
- `answer_question` → la conversazione con la domanda;
- `record_decision` → `#/p/<CODE>/overview?recordDecision=1&task=<code>`;
- `activate_automation` → il costruttore dell'automazione;
- `secret` → il dialogo vero (Integration, Preferenze → Token, Amministrazione
  → Invita), aperto dal link, mai un valore nella conversazione;
- `server` → la pagina del server; `send` → il campo dove si scrive (Posta,
  Supporto). Il deploy ha solo la riga, senza link (il confine del merge).

Un codice che chi chiede non vede riceve la frase di uno inesistente.

Test:
- [ ] Ogni `RefusedTopic` in en e in it (almeno due frasi per tema, una con
  cortesia in testa): intento `refused`, nessuna `proposal`, nessun
  `execute`, il link giusto.
- [ ] «Registra la decisione che usiamo Postgres su AUD-4»: il link apre il
  dialogo con AUD-4 in testa e il campo «Decision» vuoto; salvato, la voce
  ha `taskId` di AUD-4 (test della pagina, P18).
- [ ] «Elimina ACQ-14» (task visibile): proposta B con `deleteTask`;
  «elimina ACQ-99» e un codice invisibile: la stessa frase
  `claude.answers.explain.notFound`, confronto in minuscolo.
- [ ] Le domande con lo stesso verbo («chi ha eliminato ACQ-14?», «come si
  approva un piano?») non sono `remove` né `refused`.
- [ ] La riga D del deploy: `say` con la frase e senza link. Il controllo
  `expectNoDeploy()` non sta qui, perché un test di dominio non ha DOM e
  passerebbe sempre: è nel Task 9 (`ExecutedRow.test.tsx`) *(ruling del
  controller (pre-flight), P13)*.
- [ ] `refused.ts` riconosce «merge» e «publish» e passa
  `neverInCatalog.test.ts` (P11).
- [ ] Commit `feat(desktop): Claude rifiuta i gesti delle persone e propone l'eliminazione`.

### Task 7: Il seme del 10a

Le aggiunte vanno **in fondo** ai semi, senza spostare indici o codici di
oggi (come RNC nel 9c).

**Files:**
- Modify: `data/seed/conversations/free.ts`, `data/seed/notifications.ts`,
  `data/seed/changelog.ts`, `data/seed/activity.ts`, il seme di
  `state.claudeActions` (nuovo `data/seed/claudeActions.ts`), `data/store.ts`
  (`freshState`). Test `data/seed.10a.test.ts`.

Contenuto:
- **Conversazione 1 di Giulia** («Sposta la mia task di MKX»): un
  `planTask` A di una task di Giulia in MKX, eseguito e poi **annullato**;
  attività con `via`, `claudeActions` con `undone`.
- **Conversazione 2 di Giulia** («Brief di MKX e una task a Marco»): una
  scheda B confermata con due azioni, `planTask` di una task di **OLV** a
  Marco e `saveProjectAutomations` di MKX col brief spento; poi
  **annullata** da Giulia. Marco non è membro di MKX e `planTaskAs`
  rifiuterebbe l'assegnatario: la task va in OLV, dove Marco è membro e
  Giulia Project Lead *(ruling del controller (pre-flight), P3)*. Lascia:
  - due voci del registro con `via` (`project.switch_changed` e,
    all'«Annulla», la sua inversa con `undoOf`);
  - la notifica `task.assigned` a Marco con `viaClaude` (*decisione del
    maintainer*, Task 3), che a lettura dice «Undone by Giulia Ferri».
- Le righe del seme hanno `seq` coerenti con l'ordine (P4).
- Le date sono relative a `CLOCK_START`, dentro gli ultimi 7 giorni.

Test:
- [ ] Le due conversazioni sono private di Giulia; `getConversation` per
  Giulia dà `undo` → `undone` su entrambi i gruppi.
- [ ] Marco legge la notifica con `viaClaude` e `undoneByName`.
- [ ] Giulia (Change log di MKX, Project Lead) e Roberta (Amministrazione)
  trovano le due voci col filtro `via: "claude"` (Laura non è in MKX: non
  è il lettore di questa prova, *ruling del controller (pre-flight)*, P3).
- [ ] Le suite delle aree 1–9c restano verdi (conteggi di conversazioni,
  notifiche e voci aggiornati dove li contano, come P7 e P8 del 9c).
- [ ] Commit `feat(desktop): il seme delle azioni di Claude per conto di Giulia`.

### Task 8: Il riquadro (UI)

**Files:**
- Create:
  - `layout/claudePanel/{ClaudePanel.tsx,panelEvents.ts,pageContext.ts,ContextChip.tsx}`;
  - test `layout/claudePanel/ClaudePanel.test.tsx`, `pageContext.test.ts`.
- Modify:
  - `layout/AppLayout.tsx`: `<ClaudePanelHost />`, montato una volta;
  - `layout/useShortcuts.ts`: ⌘J / Ctrl+J apre e chiude (non dove si scrive
    in un dialogo modale; nel riquadro chiude);
  - `layout/Rail.tsx`: il bottone fisso in fondo, `aria-expanded`;
  - `palette/commands.ts`: `claude.ask` apre il riquadro con il testo nella
    casella, **non inviato**; il `ctx` dei comandi riceve `openClaudePanel`,
    e `palette/commands.test.ts` (oggi si aspetta `/claude?ask=…`, riga
    53) si aggiorna: il comando chiama `openClaudePanel({ draft })` e non
    naviga *(ruling del controller (pre-flight), P14)*;
  - `pages/claude/ClaudePage.tsx`: estrae `NewConversationComposer({ initial,
    onCreated })` da `NewConversation`, che il riquadro riusa;
  - `pages/claude/conversation/Conversation.tsx`: prop `draft?: { text:
    string; nonce: number }` che riempie la casella senza inviare; prop
    `context?: ContextRef | null` passata a `sendMessage`;
  - `data/model.ts`: `ContextRef`; `Conversation.context?: ContextRef |
    null`; l'evento `user` + `context?: ContextRef | null`;
  - `data/api-mutations.ts`: `sendMessage(id, message, { context })` salva il
    contesto sul messaggio, e `freeTurn` passa `contextProjectId` dal
    contesto quando c'è; ogni turno della libera registra i consumi con
    `recordUsage` (`data/instance/usage.ts`), operazione `chat`, sul
    progetto del contesto o senza progetto, se `freeTurn` non lo fa già;
  - `data/api.ts`: `describeContext`;
  - i18n `claude.panel.*`, e `claude.destination.landing.intro` sostituita
    con le due frasi della conversazione vuota dello shape («Ask about what
    you're looking at…» / «What only touches you happens right away and can
    be undone…»): «changes nothing without your confirmation» non è più vera
    con la classe A *(scelta del controller, [CP 9] di `claude-panel.md`)*;
  - `src/main/menu.ts`: la voce «Ask Claude…» con `CmdOrCtrl+J` accanto a
    «Search…», che manda il canale nuovo `MENU_ASK_CLAUDE`
    (`"menu:ask-claude"`); `src/preload/index.ts` e `src/renderer/env.d.ts`
    lo espongono come gli altri canali; `layout/useMenuEvents.ts` lo
    traduce in `openClaudePanel({ mode: "toggle" })` *(scelta del
    controller, [CP 7])*. Test in `src/main/main.test.ts` e
    `layout/useMenuEvents.test.ts`. Senza un dialogo modale aperto, ⌘J
    dalla tastiera e dal menu non scattano due volte (un solo toggle).
    Con un dialogo modale aperto non scatta nessuno dei due:
    `handleMenuChannel` ha la stessa guardia di `useShortcuts`
    (`document.querySelector('[aria-modal="true"]')`) per
    `MENU_ASK_CLAUDE` *(ruling del controller (pre-flight), P20)*.

**Interfaces, prodotte:**

```ts
// data/model.ts
export type ContextRef =
  | { kind: "release"; releaseId: string }
  | { kind: "task"; taskId: string }
  | { kind: "request"; requestId: string }
  | { kind: "support"; conversationId: string }
  | { kind: "pr"; prId: string }
  | { kind: "automation"; automationId: string }
  | { kind: "settings"; projectId: string | null; section: string }
  | { kind: "page"; route: string; projectId: string | null };
// data/api.ts
/** Il chip: rilegge il riferimento con la visibilità di chi guarda; `null` = invisibile o inesistente (R-G5). */
export async function describeContext(ref: ContextRef): Promise<{ code: string | null; labelKey: string; projectId: string | null } | null>;
// layout/claudePanel/pageContext.ts
export function pageContextOf(location: { pathname: string; search: Record<string, unknown> }, lookup: { projectIdOf(code: string): string | null }): ContextRef | null;
// layout/claudePanel/panelEvents.ts
export const CLAUDE_PANEL_EVENT = "stubwise:claude-panel";
export function openClaudePanel(detail?: { draft?: string; mode?: "open" | "toggle" }): void;
```

Regole (più lo shape `claude-panel.md`):
- chiuso è `hidden` e `inert`, **non smontato**: conversazione, scorrimento e
  testo non inviato restano;
- l'ultima conversazione per persona sta in memoria (`Map` per persona,
  svuotata da `onStoreReset`); «New» apre il compositore vuoto; «Open in
  Claude» porta a `/claude/<id>`;
- il componente ha chiave per persona: col «vedi come» rinasce con le
  conversazioni della nuova persona, senza la bozza dell'altra;
- il chip si aggiorna cambiando pagina; un messaggio già scritto tiene il
  suo contesto; la × toglie il contesto per i messaggi successivi;
- il fuoco: all'apertura nella casella, alla chiusura torna a chi l'ha
  aperto (`useRestoreFocus`).

Test:
- [ ] ⌘J da Tasks di ACQ apre il riquadro con il chip «ACQ-14 · task» se
  il pannello della task è aperto; Esc lo chiude e il fuoco torna dov'era;
  riaperto, testo non inviato e conversazione sono lì.
- [ ] ⌘K «Ask Claude: riassumi ACQ» apre il riquadro con il testo nella
  casella, nessun messaggio inviato.
- [ ] La pagina sotto resta viva: col riquadro aperto si scrive nel filtro
  di Tasks.
- [ ] La conversazione nata dal riquadro è in «My conversations» della
  destinazione, privata.
- [ ] «Vedi come» da Giulia a Sara col riquadro aperto: nessun evento né
  bozza di Giulia nel DOM.
- [ ] Un chip su una task diventata invisibile non si mostra, e Claude
  risponde «Can't find …» come per un codice inesistente.
- [ ] Budget esaurito: il riquadro lo dice, l'invio non parte.
- [ ] La voce di menu «Ask Claude…» (`MENU_ASK_CLAUDE`) apre e chiude il
  riquadro; ⌘J premuto una volta dà un solo toggle; con la riconferma (o
  la palette) aperta, la voce di menu non apre il riquadro (P20).
- [ ] `palette/commands.test.ts`: «Ask Claude: Explain AUD-3» chiama
  `openClaudePanel` col testo e non naviga (P14).
- [ ] L'atterraggio della destinazione e la conversazione vuota del
  riquadro non contengono più «changes nothing without your confirmation»
  (en) né la sua resa it.
- [ ] Un turno dal riquadro col chip su ACQ aggiunge una riga di consumo
  `chat` su ACQ; senza contesto, una riga senza progetto.
- [ ] `pageContextOf` per ogni forma di `ContextRef` e per una rotta senza
  oggetto (`page`).
- [ ] Layout a 1024 come lo shape, con il pannello della task aperto
  (scatto `a10a-panel-task-narrow`).
- [ ] Commit `feat(desktop): il riquadro di Claude, da ogni pagina`.

### Task 9: Righe eseguite, schede B/C e «Annulla» (UI)

**Files:**
- Create: `pages/claude/conversation/ExecutedRow.tsx`, `UndoControl.tsx`;
  test `pages/claude/conversation/ExecutedRow.test.tsx`,
  `ProposalCard.classes.test.tsx`.
- Modify:
  - `pages/claude/conversation/ProposalCard.tsx`: le righe dei `reasons`, la
    riga «Can't be undone», il segno C; `confirm` passa da `useReauth`
    (`action` = il riassunto della scheda); dopo la conferma, `UndoControl`
    sotto l'esito;
  - `pages/claude/conversation/EventList.tsx` e `flow.ts`: il tipo
    `executed` (un `pending` non si disegna mai);
  - i18n `claude.conversation.executed.*`, `claude.conversation.undo.*`,
    `claude.conversation.proposal.reasons.*`.

`UndoControl` legge `(ConversationDetail.undo ?? {})[groupId]` (P25) e non
decide niente da sé:
- `available` → «Undo»; con `needsReauth` passa da `useReauth`;
- `undone` → «Undone» (con il nome solo se non è chi guarda);
- `changed_after` → «<nome> changed it afterwards · can't undo from here»
  col link all'oggetto (o la frase senza nome e senza link se sono `null`);
- `not_undoable` → niente bottone, «Can't be undone»;
- `not_yours` → niente.

Il rifiuto al clic sostituisce la riga con la sua frase: `forbidden` con
`WhoCanLink` (`whoAction`, progetto), `busy` con le ragioni in parole,
`changed_after` come sopra, `reauth_cancelled` con il toast «Nothing was
changed.». Passa da `useSettingsWrite(...).run` o dalla stessa forma: il
seguito arriva anche dopo un Retry.

Test:
- [ ] Riga A: «Created MKX-<n> "Prova"», il codice apre la task, «Undo» la
  elimina e la riga dice «Undone».
- [ ] Scheda B in AUD: «Notifies Matteo Conti»; con un'automazione: la sua
  riga; `deleteTask`: «Can't be undone», nessun «Undo» dopo la conferma.
- [ ] `notifies` con `more` *(scelta del controller)*: «Notifies Matteo
  Conti and others who follow this in AUD»; solo `more`: «Notifies people
  who follow this in AUD»; nessuna cifra nella riga (regex `/\d/` sul testo
  della riga, en e it).
- [ ] Un'azione A eseguita *(maintainer)*: la riga nel flusso e la voce nel
  registro, **nessun toast** (né nel riquadro né sulla pagina sotto).
- [ ] «Modifica» *(maintainer)*: c'è sulla scheda di `createTask` e di
  `createRequest`; non c'è sulle schede di `deleteTask`, `archiveProject`,
  `addMember`, `saveWebhook` (solo «Confirm» e «Cancel»).
- [ ] Scheda C (`addMember` iniettata con `runScript`): Conferma → dialogo
  della riconferma sopra il riquadro → codice `123456` → la scheda dice
  «Done» senza un secondo clic; chiuso il dialogo: scheda ancora aperta,
  toast «Nothing was changed.».
- [ ] «Undo» dopo un commento di Marco: la frase e il link, nessuna
  scrittura.
- [ ] «Undo» senza permesso: la frase e «Who?» (`WhoCanLink`), e la lista
  di «Who?» non ha persone di progetti che Giulia non vede.
- [ ] «Undo» con un primo tentativo fallito (`failNext("claude.undo")`),
  poi Retry: la riga diventa «Undone» (il seguito dopo il Retry).
- [ ] Dopo «Undo» il fuoco resta sulla riga (sul suo testo nuovo), non
  torna in cima.
- [ ] Una pubblica di Giulia letta da Roberta: righe e schede chiuse,
  nessun bottone.
- [ ] Nessun `can(` né `viewer` nei file di `pages/claude/conversation/`
  toccati qui (test sul sorgente, come P13 del 9c).
- [ ] *(ruling del controller (pre-flight), P13)*: la riga D del deploy
  resa nel flusso (en). Il test verifica prima che ci sia la frase
  «Stubwise doesn't deploy: merging a pull request is as far as it goes.»
  e che non ci sia un link, poi chiama `expectNoDeploy()`.
- [ ] *(ruling del controller (pre-flight), P23)*, le regole dello shape
  `claude-actions.md`:
  - [CA 6]: una scheda con `deleteTask` ha il Confirm `critical` che dice
    «Delete»;
  - [CA 3]: un gruppo di due azioni confermato ha un solo controllo,
    «Undo both» (tre: «Undo all 3»), sotto l'ultima riga;
  - un'azione A rifiutata all'invio per permesso mostra «Didn't run: you
    can't create tasks in MKX · Who?» con `WhoCanLink`, e nessun Undo.
- [ ] *(decisione del maintainer)*: una scheda B «assegna OLV-<n> a Marco»
  dice «Notifies Marco Bellini» (la riga viene da `reasons`, ragione
  `task.assigned`).
- [ ] Commit `feat(desktop): righe eseguite, schede per classe e «Annulla» nella conversazione`.

### Task 10: «Elimina task» (UI)

**Files:**
- Create: `pages/task/DeleteTaskDialog.tsx`; test
  `pages/task/DeleteTaskDialog.test.tsx`.
- Modify:
  - `pages/task/TaskMoreMenu.tsx`: la voce «Delete task…» (o spenta con
    frase e «Who?», da `getTaskDeletion`);
  - `data/queries.ts`: `useTaskDeletion(taskId)`, `useDeleteTask()`;
  - le letture che mostrano un codice di task: la richiesta d'origine
    (`deletedTaskCodes` → «Task ACQ-14 was deleted», senza link), la riga
    dell'esecuzione d'automazione, `NotificationItem` (`objectGone` →
    «Task deleted», senza link);
  - i18n `task.delete.*`.

Segue lo shape `task-delete.md`. Il dialogo nomina codice e titolo, elenca
le figlie, dice il `busy` in parole e cosa aspettare; il bottone rosso è
spento con la sua frase finché c'è `busy`.

Test:
- [ ] Giulia elimina una sua task da «⋯» → dialogo → conferma: il pannello
  si chiude, il toast dice il codice, la task non è più nella lista, il
  fuoco va dove dice lo shape.
- [ ] Annulla del dialogo: il fuoco torna su «⋯».
- [ ] Sara su una task non sua: la voce è spenta, con la frase e «Who?»
  (`deleteTasks`).
- [ ] Una task con una sessione viva: il dialogo lo dice e il bottone è
  spento con la frase, senza «Who?».
- [ ] Due figlie: «2 tasks stay, without a parent» e i loro codici.
- [ ] La richiesta d'origine dice «Task ACQ-<n> was deleted» senza link; la
  notifica dice «Task deleted» senza link; il codice scritto nella Chat si
  legge come uno inesistente (stessa resa di «ACQ-99», confronto in
  minuscolo).
- [ ] Un fallimento poi Retry: il seguito (chiusura e toast) arriva.
- [ ] Commit `feat(desktop): «Elimina task» dal menu della task`.

### Task 11: «Per conto di» nelle pagine (UI)

**Files:**
- Modify:
  - `pages/admin/ChangeEntry.tsx`: il prefisso «Claude on behalf of <nome>»
    con `via`. Con `undoOf`, la voce resta quella inversa col prefisso e il
    suo prima/dopo, e sotto aggiunge una riga «Undid: <frase della voce
    annullata> · <data>», con la data che porta alla voce annullata, come
    [CT 4] di `claude-trace.md`. Non è una frase unica «… undid: …», che lo
    shape scarta perché perde il prima/dopo *(ruling del controller
    (pre-flight), P2)*;
  - `pages/admin/ChangeLogPage.tsx` e `pages/settings/ProjectChangeLog.tsx`:
    il filtro «Made with Claude» (solo se `choices.claude`), nell'indirizzo;
  - `pages/task/ActivityFeed.tsx`: la testata del commento e la riga di un
    cambio di campo col segno;
  - `notifications/NotificationItem.tsx`: il prefisso da `viaClaude` e
    «Undone by <nome>» da `undoneByName`; vale anche per le notifiche nate
    da una proposta di @Claude confermata in Chat *(maintainer, 2 nov
    2026)*. Il tipo nuovo `task.assigned` ha titolo «You've been assigned
    ACQ-14» / «Ti è stata assegnata ACQ-14» e, col segno, corpo «Claude on
    behalf of Giulia Ferri assigned you ACQ-14.» / «Claude per conto di
    Giulia Ferri ti ha assegnato ACQ-14.» *(decisione del maintainer, 2 nov
    2026)*;
  - la rassegna del giorno per persona (`pages/projects/PeopleActivity.tsx`)
    e la storia del progetto (`pages/projects/ActivityFeed.tsx`): il segno
    sulle righe con `viaClaude` *(percorsi: ruling del controller
    (pre-flight), P22)*;
  - i18n `changelog.via.*`, `notifications.viaClaude.*`,
    `activity.viaClaude`.
- Test: `pages/admin/ChangeEntry.claude.test.tsx`,
  `notifications/NotificationItem.claude.test.tsx`,
  `pages/task/ActivityFeed.claude.test.tsx`.

Segue lo shape `claude-trace.md`. Le frasi vengono dagli stessi template
delle voci, con il prefisso: nessuna frase nuova per tipo di voce.

Test:
- [ ] La voce del seme (Task 7) si legge «Claude on behalf of Giulia Ferri
  changed “Weekly brief” in MKX.» con la seconda riga «On → Off» in en, e
  la sua resa it («Claude per conto di Giulia Ferri ha cambiato “Brief
  settimanale” in MKX.» · «Acceso → Spento»). È il template vero di
  `project.switch_changed` e la frase di `claude-trace.md` *(ruling del
  controller (pre-flight), P1)*.
- [ ] L'inversa si legge «Claude on behalf of Giulia Ferri changed “Weekly
  brief” in MKX.» con «Off → On», e sotto la riga «Undid: Claude on behalf
  of Giulia Ferri changed “Weekly brief” in MKX · <data>»; la data porta
  alla voce annullata *(ruling del controller (pre-flight), P2)*.
- [ ] *(decisione del maintainer)*: la notifica `task.assigned` di Marco
  (seme) ha il titolo «You've been assigned OLV-<n>» e il prefisso «Claude
  on behalf of Giulia Ferri …».
- [ ] Il filtro «Persona» = Giulia trova le voci col segno; «Made with
  Claude» isola solo quelle; un lettore che non legge nessuna voce col
  segno non vede il filtro.
- [ ] Un'inversa letta da chi non legge la voce annullata: la sua frase col
  prefisso, senza la riga «Undid:» (R-G5).
- [ ] Il commento con `via`: testata «Claude on behalf of Giulia Ferri»,
  Giulia lo modifica e lo elimina come suo.
- [ ] La notifica di Marco (seme): prefisso e «Undone by Giulia Ferri».
- [ ] @Claude nella Chat *(maintainer)*: dopo la conferma in un thread di
  una proposta che sposta una task di Marco, la voce del registro e la
  notifica di Marco si leggono «Claude on behalf of Giulia Ferri …», senza
  «Undone by».
- [ ] Le righe nate prima del 10a non hanno segno (fixture **senza** i campi
  nuovi, apposta).
- [ ] Commit `feat(desktop): «Claude per conto di» nel registro, nei commenti e nelle notifiche`.

### Task 12: Documenti, parità, scatti, follow-up

- `apps/desktop/docs/area10-parity.md` (nuovo): il web non ha un riquadro,
  quindi nessuna parità da chiudere; una riga per voce nuova del 10a (dove
  vive, test fra virgolette): riquadro, classi, catalogo, divieti D,
  `via`, «Annulla», «Elimina task», filtro «Made with Claude», la notifica
  `task.assigned` (*decisione del maintainer*: da confrontare con ciò che
  il web manda oggi all'assegnatario). Le
  differenze deliberate del design («Cosa cambia deliberatamente» 1, 2 e 6)
  con il riferimento.
- `capture.mjs`, scatti `a10a-*`:
  - il riquadro aperto su Tasks, col chip;
  - il riquadro col pannello della task aperto, a 1440 e a 1024;
  - una riga A con «Undo», e la stessa «Undone»;
  - una scheda B con «Notifies …» e il motivo dell'automazione;
  - una scheda C col dialogo della riconferma sopra il riquadro;
  - «changed it afterwards»;
  - una riga D («Approving is yours: open the plan»);
  - il registro col filtro «Made with Claude» e una voce «undid»;
  - la notifica «Undone by»;
  - il dialogo «Delete task» con figlie e con `busy`.

  Tutto a 1440 e 1024, chiaro e scuro, en e it. Vite ucciso. Rifatti dopo
  ogni correzione visiva.
- `ossatura-follow-ups.md`:
  - «Area 10a — minori aperti», con le scelte del costruttore di questo
    piano (ognuna col costo se sbagliata) e, a parte, le decisioni del
    maintainer e del controller sulle domande del piano (sezione in fondo).
    Fra le scelte: le scritture d'istanza lasciate fuori dal catalogo
    (cancellazioni che distruggono un segreto, verifiche, `simulate…`), e
    `saveStorage` sempre C;
  - nelle invarianti da riscrivere prima del motore:
    - **§12** «Gli strumenti del riquadro girano con la sessione della
      persona, lato server; `via: "claude"` lo mette il server sullo
      strumento chiamato, mai il client; la classe la calcola il server sui
      dati del momento e il client la legge» (accanto a `permissions.md`);
    - **§13** «"Annulla" è uno strumento a sé: l'inverso come azione nuova,
      solo di chi l'ha chiesta, solo se nessuno ha scritto sull'oggetto
      dopo; "Annullato da" si deriva a lettura» (accanto a «Un commento
      eliminato non ha più testo»);
    - **§14** «Cosa Claude non fa», con il test sul sorgente
      (`neverInCatalog.test.ts`, stesso schema di
      `decisions-never-ai.test.ts`);
    - **§15** «Eliminare una task»: figlie, collegamenti, codice mai
      riusato, traccia `task.deleted`; sul web oggi non c'è.
- `emptyInstance.test.tsx`: il riquadro si apre sull'istanza vuota e la
  conversazione nuova funziona.
- Suite, typecheck, lint e build verdi.
- Commit `docs(desktop): note dell'area 10a`.

Dopo il Task 12: revisione finale del branch (area 10a) e revisione visiva
di Impeccable.

---

## Decisioni sulle domande del piano (2 nov 2026)

Ognuna è segnata nel testo con chi l'ha presa.

1. **Una task non assegnata, creata da Claude senza avvisi né automazioni →
   classe A** *(scelta del controller)*: i criteri del design sono solo
   due. Task 4 (`classOf` e test).
2. **Le impostazioni d'istanza nel catalogo → tutte le scritture del 9b che
   non portano segreti** *(maintainer)*: modelli, budget e lingua,
   automazione e regole delle PR, provider (abilita, ordina), account git
   (nome, revisore predefinito), app Google (senza segreto), plugin
   (registra e aggiorna in C, rilancia lo smoke, togli), coda, rilancio di
   un lavoro, archiviazione senza chiave, allegati, webhook. Quelle che
   portano o distruggono un segreto restano nel dialogo vero; le +R sono
   classe C. Task 1 (forme `…As`), Task 4 (catalogo, tabella, test).
3. **«Modifica» solo dove il dialogo vero esiste già** *(maintainer)*:
   `createTask` e `createRequest`; le altre schede hanno solo Conferma e
   Annulla. Global Constraints, Task 9.
4. **Filtro, lingua e tema lato pagina → 10b** *(scelta del controller)*.
   Goal e Spec.
5. **Le conferme di @Claude nella Chat portano «Claude on behalf of …»**
   nel registro e nelle notifiche, come il riquadro *(maintainer, 2 nov
   2026)*. Le regole dell'area 4 restano (tutto proposte, niente
   «Annulla» in Chat). Task 3 (segno), Task 11 (pagine).
6. **«Notifies» con persone che chi chiede non vede** → «… and others who
   follow this in AUD», mai un numero *(scelta del controller)*. Task 9.
7. **Un'azione A eseguita non mostra un toast**: bastano la riga nella
   conversazione e la voce nel registro *(maintainer)*. Task 9.
8. **«Elimina task» a mano**: dialogo col bottone rosso, senza codice da
   scrivere né riconferma *(maintainer)*. Task 10.
9. **Note del controller accettate**: il nome del seme è Matteo **Conti**
   (testi e test allineati); la frase dell'atterraggio di Claude si
   sostituisce ([CP 9]); «Ask Claude… ⌘J» nel menu dell'app ([CP 7]).
   Task 8, Task 9.
10. **Assegnare una task avvisa chi la riceve** *(decisione del maintainer,
    2 nov 2026)*: notifica diretta `task.assigned` («You've been assigned
    ACQ-14» / «Ti è stata assegnata ACQ-14») per chiunque riceva una task,
    da una persona o da Claude per conto di qualcuno; non a chi si assegna
    da solo. Global Constraints, Review Focus 1, Task 3 (scrittura), Task 4
    (classe), Task 9 (scheda), Task 11 (pagine).

## Ruling del controller (pre-flight, 2 nov 2026)

Dal pre-flight (`.superpowers/sdd/2026-11-02-desktop-area10a-plan/preflight.md`),
P1–P26, tutti accettati e già scritti nei task, ognuno marcato *ruling del
controller (pre-flight)* (P8 è la decisione 10 qui sopra):

- **P1, P2:** Task 11, la frase del seme e la riga «Undid:» come in
  `claude-trace.md`.
- **P3:** le scene con Marco in OLV (Task 3, 5, 7; Review Focus 2).
- **P4:** il «com'era» ordinato per `seq`, non per `at` (Global
  Constraints, Task 3, 5).
- **P5:** `createTask` del catalogo con `createTaskAs` e i segnali
  trattenuti (Task 4).
- **P6, P7:** `FailureCode`/`Applied`/`executeGroup` e `catalogOnly`
  (Task 4, 5).
- **P9:** la classe di `planTask` (Task 4).
- **P10:** la foglia `data/claude/types.ts` (Global Constraints, Task 4, 5).
- **P11:** `neverInCatalog` per riferimenti di codice (Global Constraints,
  Task 4, 6).
- **P12, P16, P17, P21:** Task 3.
- **P13:** `expectNoDeploy` spostato nel Task 9.
- **P14, P20:** Task 8.
- **P15:** Task 1.
- **P18:** Task 6.
- **P19:** Task 4.
- **P22:** Task 11.
- **P23:** Task 9.
- **P24:** Task 2.
- **P25:** Global Constraints, Task 5, 9.
- **P26:** Task 5.
