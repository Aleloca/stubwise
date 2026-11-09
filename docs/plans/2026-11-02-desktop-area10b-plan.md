# App desktop, area 10b: gli scenari di Claude, le automazioni scritte da Claude, le bozze nei campi e i suggerimenti — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere nel prototipo `apps/desktop` l'area 10 sopra il 10a:
- i **quattro scenari** del maintainer, calcolati sui dati veri: costruire
  un'automazione (S1), rispondere sui dati (S2 progetti fermi, S3 spesa del
  mese), agire in blocco e sui membri (S4 archiviare gli inattivi, S5 Luca
  Developer in ACQ), scrivere bozze nel contesto (S6 risposta di supporto,
  S6b note di rilascio), più la **risposta onesta** (S0);
- **Claude che costruisce e prova un'automazione**: la bozza nasce spenta,
  la prova è la simulazione vera dell'area 7, il costruttore si apre con la
  bozza e l'esito; accendere resta un clic della persona;
- le **bozze nei campi** della pagina col segno «Bozza di Claude», con una
  regola sola anche per Posta e Supporto;
- i **suggerimenti discreti** «Claude può aiutarti a…»;
- **filtro, lingua e tema** lato pagina, e il filtro salvato personale;
- **«Show N more»** e le righe a parte nelle schede in blocco.

**Architecture:**
- **Il motore resta puro** (`domain/claude/*`): legge da `ctx.read`, decide,
  e restituisce un `Answer` con campi nuovi (`trial`, `draft`, `page`,
  `aside`, `capabilities`). Non scrive mai: le azioni A diventano un
  `executed` `pending` (come nel 10a), la prova un `trial` `pending`, la
  bozza un `draft` `pending`, le azioni della pagina un `pageAction`
  `pending`.
- **`freeTurn` risolve i `pending` di dati** prima di `runScript`:
  `executed` (10a), poi `trial` (la prova con `trialAs`, sincrona, sul
  gruppo appena eseguito). **Le `pending` della pagina** (`draft`,
  `pageAction`) le risolve il riquadro, nel renderer, con il registro dei
  campi riempibili (`layout/claudePanel/fillable.ts`) e quello delle azioni
  della pagina (`layout/claudePanel/pageActions.ts`), e le chiude con
  `settlePageEvent`.
- **Il catalogo cresce** di tre voci per le automazioni (`createAutomation`,
  `saveAutomationDraft`, `deleteAutomationDraft`) e due per il filtro
  salvato (`saveFilter`, `deleteFilter`), in un file a sé
  (`data/claude/catalogMore.ts`). Lingua, tema, filtro della pagina e bozza
  non sono nel catalogo: sono `PAGE_ACTIONS`, sempre A, con l'inverso nel
  renderer.
- **La scheda di scelta** (S1 reparto, S5 più Luca) è la domanda dell'area
  4 (`question`) portata nella conversazione libera: la risposta riprende
  la stessa richiesta, senza scrivere nel registro decisioni.

**Tech Stack:** quello delle aree 1–10a, senza dipendenze nuove.

**Spec:** `docs/plans/2026-11-02-desktop-area10-claude-integration-design.md`
(approvato il 2 nov 2026). Valgono per il 10b:
- parte 1, «Le pagine che si possono riempire»;
- parte 2, le tre righe delle automazioni, le righe «Filtro» e «Bozza in un
  campo», lingua e tema di «Le tue preferenze»;
- parte 4 «Rispondere sui dati», tutta;
- parte 5, le azioni in blocco (S4) e le righe a parte sotto la scheda;
- parte 6 «Automazioni», tutta (con «Cosa serve al motore»);
- parte 7 «Riassunti e bozze», tutta;
- parte 8 «Suggerimenti discreti», tutta;
- parte 9 «Gli scenari», S0–S6b;
- «Quanto è vero nel prototipo»: gli intenti nuovi, la prova vera;
- «Dati finti», tranne le conversazioni del riquadro e la notifica
  annullata (fatte nel 10a);
- «Cosa cambia deliberatamente» 3, 4 e 5;
- «Review Focus» 2, 8, 9, 10 e la parte di 1 sulle risposte.

Il resto del design (riquadro, classi, catalogo, `via`, «Annulla»,
«Elimina task») è già nel prototipo dal 10a e non cambia, salvo dove un task
qui sotto lo dice.

Contesto da leggere:
- `docs/plans/2026-11-02-desktop-area10a-plan.md` (forma, Global
  Constraints, ruling P1–P26);
- `apps/desktop/docs/ossatura-follow-ups.md`, «Area 10a — minori aperti»
  (con «Rinviati al 10b» e le decisioni del 2 nov) e le invarianti §12–§15;
- `apps/desktop/docs/area10-parity.md`;
- `docs/plans/2026-10-26-desktop-area7-automations-design.md` (le tre regole,
  la prova);
- nel desktop (percorsi relativi a `apps/desktop/src/renderer/`):
  - `data/claude/{catalog,classes,actions,via,context,types}.ts`;
  - `data/api-mutations.ts` (`freeTurn`, `readsAs`, `answerQuestion`,
    `settleProposal`, `prepareExecuted`);
  - `domain/claude/{intents,answers,context,parse}.ts` e `intents/*`;
  - `layout/claudePanel/*`, `pages/claude/conversation/*`;
  - `data/automations/{writes,simulate,examples,sources,plans}.ts`,
    `domain/automations/{validate,triggerFields}.ts`,
    `pages/automations/{builder,test}/*`;
  - `data/support/{visibility,writes}.ts`, `pages/support/ReplyComposer.tsx`,
    `pages/mail/ClaudeDraftButton.tsx`;
  - `data/releases/*`, `pages/releases/{PrPanel,ReleaseDetail}.tsx`;
  - `data/instance/usage.ts`, `data/projectSettings/{usage,archive}.ts`,
    `domain/stalled.ts`;
  - `apps/desktop/DESIGN.md`.

## Global Constraints

- **Valgono tutte le Global Constraints del piano 10a**, così come sono
  scritte lì: nessuna rete né modello; en/it con parità; temi; niente
  monospace salvo codice e affini; colore mai unico segnale; movimento
  150–250 ms con reduced-motion; pagine solo via `data/queries.ts`; stati
  completi; commenti in italiano; un solo «adesso» (`now()` di
  `data/store.ts`, `architecture.clock.test.ts` verde); Claude agisce con i
  permessi di chi lo chiama; la regola della conferma A/B/C/D, dove una
  classe sale e non scende mai; la classe la calcola il livello dati; R-G5
  anche nelle risposte, con i test in minuscolo; il registro salva valori
  stabili; i campi nuovi sono facoltativi; i tipi del catalogo nella foglia
  `data/claude/types.ts`; l'orologio fermo (`nextSeq()`, mai `at`, per ogni
  «prima/dopo»); si deriva a lettura ciò che si può derivare; le lezioni
  delle aree 9b, 9c e 10a; riconferma, budget e coda; Impeccable
  obbligatorio; il ciclo TDD di ogni task; i comandi.
- **Le decisioni del maintainer per l'area 10 valgono anche qui** (2 nov
  2026, `ossatura-follow-ups.md`, «Decisioni del maintainer»):
  - le impostazioni d'istanza nel catalogo sono tutte le scritture del 9b
    senza segreti, e le +R sono classe C;
  - «Modifica» c'è solo dove il dialogo vero esiste già: `createTask` e
    `createRequest`. Le schede del 10b (archiviazione in blocco,
    `addMember`) hanno solo Conferma e Annulla;
  - le conferme di @Claude nella Chat portano «Claude on behalf of …», e
    le regole dell'area 4 restano (tutto proposte, niente «Annulla»);
  - un'azione A eseguita non mostra un toast: bastano la riga e la voce.
    Vale anche per le bozze e le azioni della pagina;
  - «Elimina task» a mano: dialogo col bottone rosso;
  - assegnare una task avvisa chi la riceve (`task.assigned`);
  - il chip «ACQ-3 · task» anche in it; «Annulla l'azione» per l'Undo in
    it; «W» in en e «S» in it per le settimane (`shortWeekIn`).
- **Claude non accende mai un'automazione** *(maintainer)*. Nessuna voce
  del catalogo, nessun intento e nessuna riga chiama `activate` o
  `publish` (`neverInCatalog.test.ts` resta verde e copre i file nuovi). La
  bozza nasce `status: "draft"` e `ownerId: null`. La riga finale dice «È
  spenta: accendila dal costruttore quando ti va bene» / «It's off: turn it
  on from the builder when you're ready».
- **La prova non ha effetti** (area 7). `trialAs` scrive solo la prova in
  memoria (`sims`) e, a prova finita bene, `testedRev` della bozza (come la
  prova a mano). Nessuna task, notifica, email, esecuzione o voce del
  registro nasce da una prova. Claude non approva e non rifiuta nella
  prova: non manda mai `approved` né `rejected` a `simulationStep`.
- **Una bozza non si salva e non si invia da sola** *(maintainer)*. Non c'è
  un'azione «invia» né «salva» nel catalogo né in `PAGE_ACTIONS`. La bozza
  va solo in un **campo dichiarato** della **pagina aperta**
  (`useFillableField`); altrimenti resta nella conversazione con «Put it in
  the field» / «Metti nel campo». Un testo che esce (cliente, email) segue
  la regola di `draftText` del Supporto: niente nomi del team, stime né
  commenti interni.
- **Il segno «Bozza di Claude»: una regola sola** *(maintainer)*. Resta
  finché il testo del campo è identico a quello che Claude ci ha messo.
  Sparisce alla prima modifica e all'invio. Vale per il riquadro, per «Ask
  Claude» della Posta e per «Bozza di Claude» del Supporto. La riga
  «Edited from Claude's draft» / «Modificata dalla bozza di Claude» della
  Posta sparisce (differenza deliberata 4). Una bozza inviata è della
  persona e non porta «per conto di».
- **La forma delle risposte** *(maintainer: anti-obiettivi)*:
  - la prima riga risponde alla domanda;
  - ogni numero e ogni fatto su un oggetto cita l'oggetto col codice
    apribile;
  - una deduzione porta il segno «Hypothesis» / «Ipotesi», non sta mai
    nella prima riga ed è un `aside` a sé, non una frase del testo;
  - un dato che manca si dice («Non ho i consumi per persona»), non si
    stima;
  - un elenco si ferma a 5 righe, poi «and N more · open the list» / «e
    altri N · apri l'elenco», dove N conta solo ciò che chi chiede vede;
  - come è calcolato sta chiuso sotto «Details» / «Dettagli».
- **Le risposte sono calcolate, non testi fissi**: ogni scenario rilegge lo
  stato vivo con le letture della persona. Dopo un'archiviazione la domanda
  successiva lo sa. Nessun numero del design (3 progetti, 3 avvisi, $X) è
  scritto nel codice: i test confrontano col calcolo indipendente sul seme.
- **Le richieste che toccano l'invisibile**: Claude risponde sulla parte
  visibile **come se il resto non esistesse**. Mai «solo quelli che vedi»,
  mai un conteggio o un totale che includa l'invisibile.
- **I suggerimenti**: al massimo uno per pagina, sotto la testata, in tono
  quieto; solo se la persona può fare ciò che propone (niente «Who?» in un
  suggerimento); mai su un oggetto con una proposta, una domanda o un piano
  aperti; «Not now» / «Non ora» in `localStorage`, con try/catch, per
  pagina e per persona. La riga scrive la richiesta nella casella **senza
  inviarla** e apre sempre una conversazione nuova.
- **La scheda di scelta nella libera** non è una domanda dell'agente
  (`ask_user`): la risposta non entra nel registro decisioni, la dà solo
  chi ha aperto la conversazione, e riprende la stessa richiesta.
- **Nella Chat** (`ctx.classify` assente) il motore non emette eventi
  `trial`, `draft` né `pageAction`: nessuno li risolverebbe. Al loro posto
  una riga che rimanda al riquadro. `aside` e `capabilities` si
  disegnano anche nella Chat (`pages/chat/ClaudeReply.tsx`) *(ruling del controller (pre-flight), P11)*.
- **I campi nuovi sono facoltativi** (cambi additivi), e un campo letto dal
  web si difende nel punto di lettura. I campi nuovi di questo piano:
  `ProposedAction.why`, `proposal.notes`, `proposal.blocked`,
  `question.resume`, gli eventi `trial`, `draft`, `pageAction`, `aside`,
  `capabilities`, `OpenPullRequest.{releaseNotes,commits}`,
  `Release.releaseNotes`, `Automation.createdVia`,
  `SimulationView.filteredOut`, il `ContextRef` `mail` (D1), il
  `notification_kind` `member.added` (D4, con la regola di rollback del
  CLAUDE.md per il motore), `AppNotification.roleId` *(ruling del controller (pre-flight), P25)*. Ogni fixture dei
  test che li copre si lascia **senza** quei campi almeno una volta.
- **Il 10a ha già chiuso il riquadro**: il 10b non cambia `ClaudePanel`,
  `classOf`, `executeGroup`, `undoClaudeActions` salvo dove un task lo
  elenca nei suoi **Files**.
- **Comandi e scatti**: come nel 10a, con gli scatti `a10b-*` a 1440 e 1024,
  chiaro e scuro, en e it. Commit con i trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e
  `Claude-Session: https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm`.
- **Le risposte del maintainer alle domande del piano** *(maintainer, 2
  nov 2026)* sono marcate D1–D4 nei task e raccolte in «Decisioni del
  maintainer sulle domande del piano», in fondo:
  - **D1**: i campi in cui il riquadro scrive una bozza sono quattro:
    risposta di supporto, note di rilascio, corpo dell'email, descrizione
    di una task. La Chat resta esclusa;
  - **D2**: finita la prova, Claude apre da sé il costruttore;
  - **D3**: il filtro sta sull'inizio, e la prova dice «Wouldn't start» /
    «Non partirebbe»;
  - **D4**: aggiungere un membro avvisa la persona aggiunta, con la
    notifica nuova `member.added`.
- **Le bozze nei quattro campi** *(maintainer, 2 nov 2026, D1)*:
  - scrivere in un campo è sempre classe A: nessuno vede il testo finché
    la persona non lo invia o lo salva;
  - **inviare l'email resta un gesto della persona** (classe D, la riga
    `send` del 10a), come la risposta al cliente;
  - **la descrizione di una task** si scrive nel campo **aperto** (il
    modo modifica di `DescriptionSection`) e diventa una modifica della
    task solo quando la persona salva. Il salvataggio passa da
    `updateTask` a mano, senza segno `via`: è un gesto suo.

## Review Focus

1. **R-G5 e segreti nelle risposte, nelle scelte e nei suggerimenti.**
   - «e altri N» conta solo progetti visibili; il totale d'istanza della
     spesa non arriva a chi non ha `usage.view`, né come numero né come «di
     più»; «Other projects» solo con `usage.view`.
   - La scheda di scelta dei Luca elenca solo persone che chi chiede vede.
   - «Who?» delle risposte nomina solo progetti visibili.
   - Il testo di un suggerimento e la riga di una bozza non nominano un
     oggetto invisibile.
   - Il link d'invito di S5 non compare mai: né nel testo, né negli
     eventi salvati, né nei parametri dell'indirizzo del dialogo.

   → Task 6, 7, 8, 12.
2. **Una richiesta che tocca il visibile e l'invisibile.** «Archivia i
   progetti senza attività da 3 mesi» per Giulia (ne gestisce uno e non vede
   gli altri) e per Laura (ne vede uno che non gestisce) *(ruling del controller (pre-flight), P19)*; «Quanto spende Roberta?» (nessun dato per
   persona); «Quali progetti sono fermi?» per Giulia e per Roberta sullo
   stesso seme. Claude risponde sulla parte visibile come se il resto non
   esistesse: nessuna frase cambia a seconda di quanto non si vede.
   → Task 6, 7.
3. **Automazioni scritte da Claude.**
   - Una bozza che arriva accesa, o con `ownerId`.
   - Una prova con un effetto vero (task, notifica, esecuzione, email).
   - Un'approvazione approvata da Claude nella prova.
   - Un reparto avvisato con persone che non vedono il progetto.
   - «Annulla» della bozza dopo che la persona l'ha salvata o accesa.
   - Una richiesta che il motore non sa fare diventa un passo inventato.

   → Task 2, 3, 5.
4. **Il segno «Bozza di Claude».**
   - Resta dopo una modifica, o sparisce senza.
   - Finisce dentro il testo inviato.
   - Copre il testo che la persona aveva già scritto senza chiedere
     «Replace or add below?».
   - Una bozza per una pagina lasciata finisce in un campo di un'altra
     pagina, o in un campo non dichiarato.
   - «Annulla» della bozza dopo che la persona l'ha ritoccata.
   - Un'email partita senza il clic di «Send», o una descrizione di task
     salvata senza il salvataggio della persona (D1).
   - Una bozza nel corpo di un'email di un'altra casella (`mailbox_owner`).

   → Task 8, 10.
5. **Ipotesi e lunghezza.** Una deduzione scritta come fatto o nella prima
   riga; un numero senza l'oggetto da cui viene; un elenco di 8 righe senza
   «e altri 3 · apri l'elenco»; una risposta di tre righe quando ne
   basterebbe una (S0 compresa). → Task 6.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer **prima dei task UI** (le parti UI
dei Task 2, 7, 9, 10, 11, 12), in `apps/desktop/.impeccable/shape/`. Nessun
codice. Partono da `claude-panel.md`, `claude-actions.md` e
`automation-builder.md` / `automation-test.md`, e non li riscrivono.

- **`claude-scenarios.md`** (la conversazione negli scenari):
  - la risposta corta: prima riga, elenco di 5 con «and 3 more · open the
    list», la riga «Hypothesis» (`aside`), «Details» chiuso;
  - la risposta onesta S0: la frase e l'elenco degli scenari cliccabili
    (`capabilities`), nel riquadro e nella destinazione; nella Chat
    l'elenco senza clic;
  - la scheda di scelta nella libera (reparto, più Luca), consigliata per
    prima, e come si riduce a una riga dopo la risposta;
  - la scheda in blocco di S4: il perché per riga («last activity: Aug 4»),
    «Show 3 more» / «Mostra altre 3» oltre 5, le righe a parte sotto la
    scheda («On 2 of these you can't archive · Who?», «MKX has Claude
    working: it can be archived when that ends»), la casella per togliere
    una riga;
  - la scheda C di S5 con la riga bloccante dell'`escalation` e il Confirm
    spento con la sua frase;
  - le righe delle azioni della pagina (filtro, lingua, tema) con
    «Undo».
- **`claude-automations.md`**:
  - la riga che riassume il flusso («Starts when an urgent support request
    arrives · creates a task for Support · notifies Support · runs on its
    own»), e la nota dell'email che chiede approvazione;
  - la riga della prova (`trial`): un esito per esempio, «Example written
    by Claude» quando l'evento è scritto, «It would stop here for Laura
    Costa's approval», «Wouldn't start» / «Non partirebbe» (D3, la stessa
    parola della prova dell'area 7);
  - l'apertura del costruttore *(maintainer, 2 nov 2026, D2)*: la prova nell'area
    principale, il riquadro che resta, «Back to <pagina>»;
  - nella prova dell'area 7: la riga «Wouldn't start: the start filter
    doesn't match this example» / «Non partirebbe: il filtro dell'inizio
    non vale per questo esempio» (`filteredOut`, D3);
  - nel costruttore: «Notify» con un reparto («Support · department»), e
    la riga di stato «Created by Claude on behalf of Laura Costa».
- **`claude-drafts.md`**:
  - il segno «Claude's draft» / «Bozza di Claude» accanto a un campo, uno
    solo per i quattro campi di D1 (risposta di supporto, note di
    rilascio, corpo dell'email, descrizione di una task) e per «Ask
    Claude» della Posta;
  - «Replace or add below?» quando il campo ha testo;
  - la riga `draft` nella conversazione: «Put a draft in the reply to
    ACQ-S2», «Undo», e «Put it in the field» quando la pagina è un'altra;
  - il campo «Release notes» / «Note di rilascio» nel pannello della PR e
    nel dettaglio del rilascio dopo il merge (dove sta, stati, «Save»);
  - la descrizione di una task: la bozza apre il campo in modifica
    (`DescriptionSection`) col segno, e «Save» resta della persona; il
    pannello della task col riquadro accanto a 1024;
  - la Posta: la bozza del riquadro nel corpo di una risposta o di
    un'email nuova, il segno, «Send» invariato; niente più «Edited from
    Claude's draft».
- **La notifica `member.added`** (D4): titolo e corpo in en/it, col
  prefisso «Claude on behalf of …» e «Undone by …» come `task.assigned`
  (in `claude-scenarios.md`, accanto a S5).
- **`claude-suggestions.md`**: la riga «Claude can help you…» / «Claude può
  aiutarti a…» sotto la testata delle cinque pagine, «Not now», il fuoco,
  la convivenza con le altre righe sotto la testata.

### Task 1: Il seme del 10b e l'ultima attività di un progetto

Le aggiunte vanno **in fondo** ai semi, senza spostare indici o codici di
oggi (come RNC nel 9c e il seme del 10a).

**Files:**
- Create: `data/projectActivity.ts`; test `data/seed.10b.test.ts`,
  `data/projectActivity.test.ts`.
- Modify:
  - `data/seed/projects.ts`: quattro progetti in fondo, dopo RNC: `ORT`,
    `SPZ`, `LNT`, `BSC` (nomi e clienti inventati come gli altri), con
    `createdAt` fra 150 e 200 giorni prima di `TODAY`;
  - `data/access/seed.ts`: le loro appartenenze, scritte esplicitamente
    (non calcolate dall'indice): `ORT` con Giulia Project Lead; `SPZ` senza
    Giulia; `BSC` senza Giulia; `LNT` con Laura Contributor;
  - `data/seed/activity.ts`, `data/seed/tasks.ts`: due o tre task per
    progetto nuovo, con l'ultima attività fra 95 e 140 giorni prima di
    `CLOCK_START`;
  - `data/seed/conversations/work.ts`: una sessione `task_run` viva su una
    task di `BSC` (la rende `busy` per `busyReasonsOf`);
  - `data/seed/requests.ts`: in ACQ due richieste nate dal supporto
    (`origin: { kind: "support", conversationId }`), una con `urgency:
    "high"` e una con `"low"`;
  - `data/seed/support/conversations.ts`: `ACQ-S5` e `ACQ-S6`, da cui
    nascono le due richieste;
  - `data/model.ts`: `OpenPullRequest.commits?: { sha: string; message:
    string }[]`;
  - il seme delle PR (`data/seed/releases/*`): una PR aperta di ACQ nella
    coda di rilascio, `origin: "stubwise"`, con `taskId`, una descrizione e
    tre commit (due che citano un codice di task di ACQ, uno senza);
  - `data/seed/tasks.ts` (D1): in ACQ una task nata dalla conversione della
    richiesta `high` qui sopra, assegnata a Laura, con la descrizione
    vuota (la descrizione di una task nel riquadro, Task 8);
  - `data/seed/usage.ts`: righe fra il 1° del mese e `CLOCK_START` su almeno
    5 progetti, di cui almeno uno che Laura non vede e almeno due dove ha
    `project.usage.view`;
  - `data/access/effective.test.ts`: il controllo di `PARITY_PROJECT_IDS`
    esclude anche `prj-ort`, `prj-spz`, `prj-lnt`, `prj-bsc`, con un commento
    come per RNC; il fixture non si rigenera *(ruling del controller (pre-flight), P1)*.

**Interfaces, prodotte:**

```ts
// data/projectActivity.ts
/** I giorni oltre i quali un progetto è «senza attività» (S4: «da 3 mesi»). */
export const INACTIVE_DAYS = 90;
/**
 * L'ultima attività di un progetto (ISO), il massimo fra i segnali dichiarati:
 * voci di `state.activity` sulle sue task, creazione delle task, `createdAt` e
 * `objectWrites` delle richieste, voci del registro del progetto, messaggi di
 * supporto, PR aperte o rilasci. NON contano: le sessioni di Claude e le
 * letture. `null` = nessun segnale.
 */
export function lastActivityOf(projectId: string): string | null;
```

Se un progetto del seme di oggi risultasse senza attività da 90 giorni, si
aggiunge **in fondo** una sua voce d'attività recente: la regola non si
piega al seme.

Test:
- [ ] `lastActivityOf`: il massimo dei segnali, `null` senza segnali; una
  sessione viva non la sposta (il caso `BSC`).
- [ ] Gli inattivi da `INACTIVE_DAYS` su `now()`, fra i progetti aperti
  visibili: per Roberta esattamente `ORT`, `SPZ`, `LNT`, `BSC` (RNC
  archiviato no); per Giulia `ORT` e nessun altro nuovo visibile; Giulia
  gestisce `ORT` (`project.settings.manage`); Laura vede `LNT` e non lo
  gestisce; `busyReasonsOf(BSC)` non è vuoto.
- [ ] ACQ: le due richieste dal supporto con `urgency` `high` e `low`; Luca
  non è membro di ACQ; Laura ha `project.members.manage` e
  `automations.manage` in ACQ; Davide ha `support.reply` in ACQ; Sara non
  ha né `automations.manage` né un permesso sui consumi; almeno una persona
  del reparto Support vede ACQ.
- [ ] `ACQ-S2` aspetta il team (`supportState === "waiting_us"`): è la
  conversazione di S6 (se il seme di oggi non lo garantisce, il task
  sposta S6 su `ACQ-S5`, e il test lo dice).
- [ ] La task convertita di ACQ (D1): `requestId` della richiesta `high`,
  descrizione vuota, Laura assegnataria con `tickets.edit`; Giulia ha
  almeno una conversazione della Posta con un messaggio a cui rispondere
  (quelle del seme di oggi; il test la sceglie e la nomina).
- [ ] La PR del seme è in `listReleaseQueue(ACQ)` per Laura, senza
  `releaseNotes`, con tre commit di cui uno senza codice.
- [ ] I consumi del mese coprono almeno 5 progetti; Laura ne vede almeno
  due con `project.usage.view` e almeno uno non lo vede.
- [ ] Le suite delle aree 1–10a restano verdi (conteggi di progetti,
  richieste, conversazioni di supporto, PR e consumi aggiornati dove li
  contano).
- [ ] `effective.test.ts`: la parità copre i progetti di prima, e i quattro
  nuovi sono esclusi per nome *(ruling del controller (pre-flight), P1)*.
- [ ] Commit `feat(desktop): il seme degli scenari di Claude e l'ultima attività di un progetto`.

### Task 2: Il motore delle automazioni: urgenza, supporto, reparto, filtro nella prova

Le due aggiunte di «Cosa serve al motore» (design, parte 6), più la prova
che rispetta il filtro dell'inizio *(maintainer, 2 nov 2026, D3: la prova
dice «Wouldn't start» / «Non partirebbe», anche quella fatta a mano)*. Le parti UI
aspettano lo shape `claude-automations.md`.

**Files:**
- Modify:
  - `domain/automations/triggerFields.ts`: `request_created` +
    `{ key: "richiesta.urgenza", label: "Urgenza", type: "text" }` e
    `{ key: "richiesta.dal_supporto", label: "Dal supporto", type: "boolean" }`;
  - `data/automations/sources.ts`: `happenings` scrive `urgenza:
    r.urgency` (`"low" | "medium" | "high"`) e `dal_supporto:
    r.origin?.kind === "support"`;
  - `data/model.ts`: lo step `notify` diventa `who: PersonTarget | {
    departmentId: string }`; `SimulationView.filteredOut?: boolean` (in
    `data/types.ts`);
  - `data/automations/plans.ts`: un `notify` a un reparto avvisa i membri
    del reparto **che vedono il progetto** del passo, uno per persona;
    `NotifyPlan` porta `personIds: string[]` al posto di `personId`
    *(ruling del controller (pre-flight), P23)*;
  - `domain/automations/preview.ts`, `pages/automations/format.ts`,
    `pages/automations/FlowSummary.tsx`: la lettura di `who` accetta
    `{ departmentId }` *(ruling del controller (pre-flight), P23)*;
  - `domain/automations/validate.ts`: `FlowIssueCode` +
    `"department_cant_see"`; `ValidateContext.departmentSees?(departmentId,
    projectId)`, facoltativa: assente = non si segnala, così i test che
    costruiscono il contesto (`data/seed.test.ts`, `validate.test.ts`)
    restano validi *(ruling del controller (pre-flight), P2)*; il chiamante (`data/automations/*`) la soddisfa;
  - `data/automations/simulate.ts`: all'avvio, un `trigger.filter` che non
    passa con l'evento chiude la prova `status: "done"`, `filteredOut:
    true`, senza anteprime e senza `markTested`;
  - UI: `pages/automations/builder/ActionForms.tsx` (il destinatario di
    «Notify» accetta un reparto), `pages/automations/test/Summary.tsx` (la
    riga di `filteredOut`, senza «Turn on» e con «Change example» primario,
    [AU 10]), `pages/automations/builder/StartPanel.tsx` e
    `ConditionEditor.tsx` (il menu «low · medium · high» dell'urgenza,
    [AU 9]) *(ruling del controller (pre-flight), P17)*; i18n `automations.builder.notify.department`,
    `automations.test.filteredOut`, `automations.issues.department_cant_see`.
- Test: `domain/automations/validate.test.ts`, `data/automations/simulate.test.ts`,
  `data/automations/automations.test.ts`, `pages/automations/builder/Builder.test.tsx`,
  `pages/automations/test/Test.test.tsx`.

**Interfaces, prodotte:**

```ts
// data/model.ts (lo step notify)
| { id: string; kind: "notify"; who: PersonTarget | { departmentId: string }; text: string; approval: Approval }
// domain/automations/validate.ts
export interface ValidateContext {
  // …come oggi, più:
  /** Qualcuno del reparto vede il progetto? `projectId` null = non noto prima dell'evento (non si segnala). */
  // Facoltativa *(ruling del controller (pre-flight), P2)*: assente = non si segnala.
  departmentSees?(departmentId: string, projectId: string | null): boolean;
}
```

Test:
- [ ] `happenings` della richiesta `high` di ACQ: `richiesta.urgenza` è
  `"high"`, `richiesta.dal_supporto` è `true`; una richiesta nata a mano
  ha `dal_supporto` `false`.
- [ ] Un'automazione attiva di ACQ con il filtro `dal_supporto is true` e
  `urgenza is "high"` parte per la richiesta `high` e non per la `low`
  (`automationsStartingOn`).
- [ ] L'esecuzione vera di un `notify` al reparto Support: una notifica per
  ogni membro di Support che vede ACQ, nessuna per chi non lo vede (una
  persona aggiunta al reparto nel test, senza ACQ).
- [ ] `validateFlow` con un reparto di cui nessuno vede il progetto:
  `department_cant_see` sul percorso del passo.
- [ ] La prova con l'esempio `low`: `filteredOut: true`, `status: "done"`,
  nessuna anteprima, `testedRev` invariato; con `high`: le anteprime di
  task e notifiche come prima.
- [ ] UI: nel costruttore «Notify» si sceglie «Support» fra i reparti; la
  prova a mano con un esempio che il filtro esclude dice «Wouldn't start…»
  in en e «Non partirebbe…» in it, e nessuna anteprima (D3).
- [ ] La prova `filteredOut`: nessun «Turn on», «Change example» è il
  primario; nel costruttore l'urgenza si sceglie da un menu di tre valori
  *(ruling del controller (pre-flight), P17)*.
- [ ] Le suite dell'area 7 restano verdi (un `notify` a una persona non
  cambia).
- [ ] Commit `feat(desktop): urgenza e supporto nelle richieste, «Avvisa» un reparto, il filtro nella prova`.

### Task 3: Le automazioni nel catalogo e la prova di Claude

**Files:**
- Create: `data/claude/catalogMore.ts` (le voci nuove del 10b; `catalog.ts`
  le unisce a `ENTRIES`, come chiede il minore T4 del 10a); test
  `data/claude/automations.test.ts`.
- Modify:
  - `data/automations/writes.ts`: `createAutomationAs`, `saveDraftAs`,
    `deleteDraftAs` (le pubbliche diventano `writer()` + `…As`, nessun
    comportamento cambia); `noteWrite("automation", id, me,
    currentVia()?.actionId)` in **ogni** scrittura che cambia
    un'automazione (`createAutomation`, `saveDraft`, `renameAutomation`,
    `publish`, `activate`, `pause`, `deleteDraft`); `createAutomationAs`
    scrive `createdVia: "claude"` quando `currentVia()` non è `null`;
  - `data/store.ts`: `ObjectWrite.kind` + `"automation"`;
  - `data/model.ts`: `Automation.createdVia?: "claude"`; `TrialOutcome`;
  - `data/claude/types.ts`: `ClaudeActionFn` + `"createAutomation" |
    "saveAutomationDraft" | "deleteAutomationDraft"`; `ObjectRef` + `{
    kind: "automation"; id: string }`;
  - `data/claude/actions.ts`: `writesOn` e `projectOfRef`/`codeFor` per
    `automation` (da `state.objectWrites`, come richieste e traguardi);
  - `data/automations/simulate.ts`: `startSimulationAs`, `trialAs`;
  - `data/automations/examples.ts`: `pickTrialExamples`.

**Interfaces, prodotte:**

```ts
// data/automations/writes.ts
export function createAutomationAs(me: string, input: { name: string; description?: string; projectId: string | null; flow: AutomationFlow }): Automation;
export function saveDraftAs(me: string, id: string, flow: AutomationFlow, meta?: AutomationMeta, opts?: { expected?: number | null }): Automation;
export function deleteDraftAs(me: string, id: string, opts?: { expected?: number | null }): void;
// data/automations/simulate.ts
export function startSimulationAs(me: string, automationId: string, version: number | "draft", event: Record<string, unknown>): string;
// `TrialOutcome` vive in `data/model.ts`: lo legge l'evento `trial` (Task 5), e
// `model.ts` non importa da `data/automations/*` (la stessa ragione di P10).
export interface TrialOutcome {
  simId: string;
  /** `filtered_out`: il filtro dell'inizio non passa (Task 2). */
  status: RunStatus | "filtered_out";
  tasks: number; notifications: number; emails: number; requests: number; milestones: number;
  /** Chi dovrebbe approvare alla prima fermata `waiting_approval`; `null` se non c'è o chi chiede non lo vede (R-G5). */
  approverId: string | null;
  /** Il passo di Claude su cui la prova si è fermata (non lo esegue: la prova di Claude non chiama `claudeFake`). */
  stoppedAtClaude: boolean;
}
/** Avvia la prova della bozza e la porta alla prima fermata con `run`, mai con `approved`/`rejected`. La prova resta in `sims` (il costruttore la apre). */
export function trialAs(me: string, automationId: string, event: Record<string, unknown>): TrialOutcome;
// data/automations/examples.ts
export interface TrialExample { event: Record<string, unknown>; label: Utterance; written: boolean }
/**
 * Per ogni `want`, l'evento più recente della sorgente che chi chiede vede e
 * che il filtro fa passare (o no); se non c'è, uno scritto da Claude dai
 * campi dell'inizio, `written: true` («Example written by Claude»).
 */
export function pickTrialExamples(me: string, automationId: string, wants: ("passes" | "fails")[]): TrialExample[];
```

Le voci del catalogo (`catalogMore.ts`):

| `fn` | `apiFn` | base | inverso | `whoAction` |
|---|---|---|---|---|
| `createAutomation` | `automations.createAutomation` | A | `deleteAutomationDraft` (eccezione senza scheda, come `createTask`) | `manageProjectAutomations` *(ruling del controller (pre-flight), P3)* |
| `saveAutomationDraft` | `automations.saveDraft` | A | `saveAutomationDraft` col flusso di prima | come sopra |
| `deleteAutomationDraft` | `automations.deleteDraft` | B, non si annulla | — | come sopra |

Regole:
- `createAutomation.run` rifiuta (`invalid: flow`) un flusso con problemi di
  `validateFlow`, prima di ogni scrittura: il motore lo controlla, il
  livello dati lo ricontrolla. Forza `status: "draft"` e `ownerId: null`
  qualunque cosa dicano gli argomenti. Con `projectId: null` rifiuta
  (`invalid: project`): il riquadro crea solo bozze di progetto, e il
  `whoAction` della voce è uno solo *(ruling del controller (pre-flight), P3)*.
- **La prova non è una voce del catalogo** *(scelta del costruttore)*: non
  scrive nulla da annullare, quindi non ha inverso, e una voce A senza
  inverso violerebbe il test del registro del 10a («nessuna voce che non si
  annulla parte in classe A»). La esegue `freeTurn` dopo il gruppo (Task 5).
- `classOf` non ha motivi di dati per queste voci: una bozza spenta non
  avvisa e non fa partire nulla. Restano A.
- **«Com'era»**: dopo l'azione, qualunque `noteWrite("automation")` di
  un'altra persona (o di Claude fuori dal gruppo) rende l'«Annulla»
  `changed_after`. Accendere la bozza è una scrittura: dopo, «Laura Costa
  changed it afterwards · can't undo from here».

Test:
- [ ] Le `…As` e le pubbliche: stesso esito sullo stesso stato (riuscita,
  `forbidden`, `not_found`, `invalid: stale`), e nessuna è una `Promise`.
- [ ] `createAutomation` dal catalogo con Laura in ACQ: `ACQ-A<n>`, `status:
  "draft"`, `ownerId: null`, `createdVia: "claude"`; con `ownerId` o
  `status: "active"` negli argomenti esce lo stesso spenta; con un flusso
  che ha problemi: `invalid: flow`, niente nasce.
- [ ] `classOf` di `createAutomation` e `saveAutomationDraft`: A senza
  motivi; `deleteAutomationDraft`: B con `irreversible`.
- [ ] «Annulla» della creazione: l'automazione non c'è più; dopo un
  `saveDraft` di Laura a mano: `changed_after` con «Laura Costa»; dopo
  `activate`: `changed_after`, e l'automazione resta accesa.
- [ ] `trialAs` con la richiesta `high`: `status: "done"`, `tasks: 1`,
  `notifications` = i membri di Support che vedono ACQ; con la `low`:
  `filtered_out`. Con un passo `sendEmail` «Chiede approvazione al
  proprietario»: `waiting_approval`, `approverId` = chi prova. Prima e dopo
  ogni prova sono identici (deep equal) `state.tasks`,
  `state.notifications`, `state.automationRuns`, `state.mailMessages`,
  `state.changelog`.
- [ ] `pickTrialExamples`: con una richiesta `high` vera visibile la
  sceglie (`written: false`); senza richieste che passano scrive un evento
  coi campi dell'inizio (`written: true`); un evento di un progetto che chi
  chiede non vede non viene mai scelto.
- [ ] `neverInCatalog.test.ts` copre `catalogMore.ts` ed è verde;
  `catalog.test.ts` copre le voci nuove (classe, inverso nel catalogo,
  `whoAction` in `ACTIONS`).
- [ ] Commit `feat(desktop): le bozze di automazione nel catalogo di Claude e la prova senza effetti`.

### Task 4: Le schede di scelta nella conversazione libera

**Files:**
- Modify:
  - `data/model.ts`: l'evento `question` + `resume?: string` (la richiesta
    da riprendere, solo nella libera);
  - `domain/claude/answers.ts`: `Answer.ask` + `resume?: string`; `toSteps`
    lo scrive sulla domanda;
  - `data/api-mutations.ts`:
    - `freeTurn` passa `asks: true` al motore, e `asks: false` dopo due
      domande per la stessa richiesta (un contatore sulla riga di
      `resume`) *(scelta del costruttore: progetto, poi reparto)*;
    - `answerQuestion` per `c.kind === "free"`: risponde solo chi ha aperto
      la conversazione (`not_yours` → `forbidden`), **senza** la voce del
      registro decisioni che scrive per le sessioni, poi
      `inTurn(c.id, () => freeResume(me, c, `${resume} ${label}`, freeCut(c.id), gen))`
      *(ruling del controller (pre-flight), P24)*;
    - `freeResume`: come `freeTurn` (compreso il controllo del `cut` di
      «Ferma»), ma senza l'evento `user`;
  - `data/store.ts` (`conversationPermissions`): `canAnswer` di una libera
    = proprietario con `canWrite`.
- Test: `data/claude/freeQuestion.test.ts`.

**Interfaces, prodotte:**

```ts
// data/model.ts, l'evento question
resume?: string;
// data/api-mutations.ts (interna)
// Col `cut` di «Ferma», come `freeTurn` *(ruling del controller (pre-flight), P24)*.
async function freeResume(me: string, c: Conversation, text: string, cut: number, gen: number): Promise<void>;
```

Test:
- [ ] Giulia, libera, «assegna MKX-31» (senza a chi): una `question` con le
  persone di MKX e nessuna `proposal`; risponde «Giulia Ferri» → la riga
  `executed` A (o la scheda, se la classe sale), nessun evento `user` in
  più, e `state.decisionLog` invariato.
- [ ] Una seconda risposta: `already_answered`; un'altra persona (la
  conversazione resa pubblica): `forbidden`.
- [ ] Le suite dell'area 3 sulla libera: dove oggi «assegna X» senza a chi
  rispondeva con una frase, ora c'è la domanda; i test si aggiornano, e
  nella Chat nulla cambia.
- [ ] Commit `feat(desktop): le schede di scelta di Claude nella conversazione libera`.

### Task 5: L'intento «automazione» e la prova nel flusso (S1)

**Files:**
- Create: `domain/claude/intents/automation.ts`,
  `domain/automations/draftFlow.ts`; test
  `domain/claude/intents.10b.automation.test.ts`,
  `domain/automations/draftFlow.test.ts`, `data/claude/automationTurn.test.ts`.
- Modify:
  - `domain/claude/intents.ts`: `Intent` + `"automation"`, riconosciuto
    dopo `refused` e prima dei comandi;
  - `domain/claude/context.ts`: `ReadApi` + `canManageAutomations`,
    `validateAutomationFlow`, `listDepartments`;
  - `domain/claude/answers.ts`: `Answer.trial?`; `toSteps` emette il
    `trial` `pending` subito dopo l'`executed`;
  - `data/model.ts`: l'evento `trial`;
  - `data/api-mutations.ts`: `readsAs` con le letture nuove; `freeTurn`
    risolve i `trial` `pending` dopo `prepareExecuted` (`prepareTrials`);
  - i18n `claude.answers.automation.*`.

**Interfaces, prodotte:**

```ts
// domain/automations/draftFlow.ts — pura
export interface FlowSpec {
  event: "request_created";
  when: { fromSupport?: boolean; urgency?: "low" | "medium" | "high" };
  steps: (
    | { kind: "createTask"; departmentId: string; dueInDays: number }
    | { kind: "notify"; departmentId: string }
    | { kind: "sendEmail" }
  )[];
}
/** Il flusso coi soli blocchi del motore: il filtro sull'inizio (D3, maintainer), passi «Parte da solo», l'email «Chiede approvazione al proprietario». */
export function draftFlow(spec: FlowSpec, t: T): AutomationFlow;
// domain/claude/context.ts, ReadApi
canManageAutomations(projectId: string | null): Promise<boolean>;
validateAutomationFlow(flow: AutomationFlow, projectId: string | null): Promise<FlowIssue[]>;
listDepartments(): Promise<Department[]>;
// domain/claude/answers.ts
Answer.trial?: { wants: ("passes" | "fails")[] };
// data/model.ts, ConversationEvent
| {
    id: string; at: string; type: "trial";
    status: "pending" | "done" | "skipped";
    wants: ("passes" | "fails")[];
    automationId?: string;
    code?: string;
    results?: (TrialOutcome & { label: Utterance; written: boolean })[];
    /** La prova che il riquadro apre da sé nel costruttore (D2, maintainer): la prima che passa. */
    openSimId?: string | null;
  }
```

Il riconoscimento (en/it, varianti comprese): una frase che comincia con
«quando», «ogni volta che», «when», «whenever», o che chiede di «creare /
costruire / fare un'automazione», con dentro un evento e almeno un'azione
che il motore sa fare. Le parole:
- evento: «richiesta (di supporto)», «support request» → `request_created`
  (+ `fromSupport` se c'è «supporto/support»); «urgente», «urgent» →
  `urgency: "high"`;
- azioni: «crea una task», «create a task» → `createTask` con scadenza 1
  giorno; «avvisa il reparto», «notify the department» → `notify`; «manda
  un'email», «send an email» → `sendEmail`.

Regole:
- **Progetto**: dal contesto. Senza contesto, una scheda di scelta coi
  progetti dove `canManageAutomations`.
- **Reparto**: nominato nella frase, o una scheda di scelta con i reparti;
  «Support» è consigliato quando l'evento viene dal supporto.
- **Senza permesso** (`canManageAutomations` falso): tre righe che
  descrivono il flusso, poi «You can't create automations in ACQ ·
  [Who?](who:manageProjectAutomations/ACQ)». Nessun `execute`.
- **Validazione**: `validateAutomationFlow` prima dell'`execute`. Correggo
  da solo solo un titolo mancante; `department_cant_see` diventa una scheda
  di scelta («Nobody in Marketing sees ACQ: which department should I
  notify?»); ogni altro problema si dice e non crea niente.
- **Ciò che il motore non sa fare** («pubblica su Slack», «chiama il
  cliente»): Claude costruisce il resto della bozza e lo dice in una riga,
  nominando a parole il passo più vicino che sa fare (`notify`), senza
  aggiungerlo né proporlo con una scheda ([AU 11]) *(ruling del controller (pre-flight), P18)*. Nessun
  passo inventato.
- **Risposta**: la riga che riassume il flusso, `execute:
  [createAutomation]` (A), `trial: { wants: ["passes", "fails"] }`.
- **`prepareTrials`**: per ogni `trial` `pending` dopo un `executed` `done`
  che ha creato un'automazione, `pickTrialExamples` + `trialAs` per esempio;
  l'evento diventa `done` con i risultati e `openSimId`. Poi una frase
  calcolata dal primo esito che passa («It would create a task for Support
  and notify 3 people»), e la riga finale «It's off: turn it on from the
  builder when you're ready». Con l'`executed` fallito o salito a scheda:
  `skipped`, senza frase.

Test:
- [ ] `draftFlow` dello scenario: il filtro con le due condizioni; i passi
  `createTask` (reparto Support, `dueInDays: 1`, `auto`) e `notify`
  (reparto Support, `auto`); con `sendEmail`: `approval: { mode: "ask",
  who: { owner: true } }`; `validateFlow` senza problemi.
- [ ] S1 (Laura, contesto Support di ACQ, en e it, tre varianti di frase):
  la scheda di scelta con Support consigliato; risposto Support →
  `executed` `done` con `ACQ-A<n>`, poi `trial` `done` con due esiti (`done`
  con `tasks: 1` e le notifiche calcolate; `filtered_out`), poi la frase e
  la riga «It's off…». Nessuna task, notifica o esecuzione nuova nello
  stato; l'automazione è `draft`.
- [ ] Il reparto nominato nella frase («…avvisa il reparto Support»):
  nessuna scheda di scelta.
- [ ] Sara: nessuna automazione, tre righe e il link `who:`.
- [ ] «…e manda un'email al cliente»: il riassunto dice che l'email chiede
  approvazione; la prova si ferma `waiting_approval` e la riga lo dice
  col nome di Laura.
- [ ] «…e pubblicalo su Slack»: la bozza nasce senza la parte Slack, la riga
  onesta nomina `notify` a parole; nessun passo nuovo, nessun `notify`
  aggiunto e nessuna scheda *(ruling del controller (pre-flight), P18)*.
- [ ] Senza contesto di progetto: prima la scheda dei progetti, poi quella
  dei reparti; una terza mancanza è una riga, non una scheda.
- [ ] Coda di ACQ in pausa (9b): la bozza nasce e la prova gira (non sono
  lavoro di Claude in coda).
- [ ] Commit `feat(desktop): Claude scrive e prova un'automazione, e la lascia spenta`.

### Task 6: Rispondere sui dati: la risposta onesta, i progetti fermi, la spesa (S0, S2, S3)

**Files:**
- Create: `domain/claude/intents/stalled.ts`, `domain/claude/intents/spend.ts`;
  `data/claude/answersData.ts` (le letture nuove); test
  `domain/claude/intents.10b.data.test.ts`, `data/claude/answersData.test.ts`.
- Modify:
  - `domain/claude/intents/general.ts`: la risposta onesta S0;
  - `domain/claude/intents.ts`: `Intent` + `"stalled" | "spend"`,
    riconosciuti dopo `refused` e prima dei comandi e di `explain` *(ruling del controller (pre-flight), P10)*;
  - `domain/claude/context.ts`: `ReadApi` + `listStalledProjects`,
    `spendThisMonth`;
  - `domain/claude/answers.ts`: `Answer.aside?`, `Answer.capabilities?`;
    `bulleted(t, lines, max, more?: { route: string })` con «and N more ·
    open the list»; `toSteps` emette gli `aside` dopo il `say`, e
    `capabilities` come evento;
  - `data/model.ts`: gli eventi `aside` e `capabilities`, e i tipi
    `CapabilityId`, `StalledProject`, `SpendView` (con `ArchiveCandidates`
    del Task 7) accanto a `TrialOutcome`: `answers.ts` e `answersData.ts`
    li importano da lì (la ragione di P10) *(ruling del controller (pre-flight), P5)*;
  - `data/api-mutations.ts`: `readsAs`;
  - i18n `claude.answers.{general,capabilities,stalled,spend,aside}.*`
    (sostituisce il testo di `claude.answers.general`, che dice ancora
    «always asking you to confirm before I change anything»);
  - `pages/claude/conversation/AssistantMessage.tsx`: `whoOf` accetta anche
    il «Who?» d'istanza senza codice, `who:<azione>` (S3; decisione del
    maintainer, 2 nov 2026: il formato si allinea qui). Un'azione d'istanza
    di `ACTIONS` diventa `WhoCanLink` con `projectId={null}`, senza
    controllo di visibilità (non c'è un progetto da nascondere); un
    `who:<azione>` di progetto senza codice, o un'azione che `ACTIONS` non
    ha, resta testo. Test in
    `pages/claude/conversation/AssistantMessage.who.test.tsx`.

**Interfaces, prodotte:**

```ts
// data/model.ts *(ruling del controller (pre-flight), P5)*
export interface StalledProject {
  projectId: string; code: string; stalled: number;
  /** La task ferma da più tempo, col motivo di `stallOf`. */
  // `reason` intero, per la riga di §3.3 dello shape *(ruling del controller (pre-flight), P6)*: `personId`
  // e `taskId` solo se chi chiede li vede, altrimenti la forma senza.
  oldest: { taskCode: string; days: number; reason: StallReason; plannedWeek: string | null };
  /** La soglia del progetto, per i «Details» ([SC 3]) *(ruling del controller (pre-flight), P6)*. */
  thresholdDays: number;
}
/** I progetti aperti e visibili con task ferme, dal più fermo; `stallOf` e il blocco «Fermo» del polso. */
// `projectId`: solo quel progetto (S2 dall'Overview, [SG 3]) *(ruling del controller (pre-flight), P16)*.
// data/claude/answersData.ts
export function stalledProjectsFor(me: string, projectId?: string | null): StalledProject[];
// data/model.ts *(ruling del controller (pre-flight), P5)*
export type SpendView =
  | { scope: "instance"; totalUsd: number; budgetUsd: number | null;
      /** I 3 che spendono di più; `projectId` `null` = «Other projects» (solo `usage.view`). */
      top: { projectId: string | null; code: string | null; usd: number }[] }
  | { scope: "projects"; totalUsd: number; projects: { projectId: string; code: string; usd: number }[] }
  | { scope: "none" };
/** La spesa dal 1° del mese a `now()`: `usageView` per chi ha `usage.view`, la somma per progetto dove ha `project.usage.view`. */
export function spendThisMonthFor(me: string): SpendView;
// domain/claude/context.ts, ReadApi
listStalledProjects(projectId?: string | null): Promise<StalledProject[]>;
spendThisMonth(): Promise<SpendView>;
// domain/claude/answers.ts
Answer.aside?: { kind: "hypothesis" | "details"; text: string }[];
Answer.capabilities?: CapabilityId[];
// data/model.ts *(ruling del controller (pre-flight), P5)*
// (maintainer, 2 nov 2026: nove voci, con email e descrizione di D1)
export type CapabilityId = "automation" | "stalled" | "spend" | "archive" | "addMember" | "supportReply" | "releaseNotes" | "mailBody" | "taskDescription";
// data/model.ts, ConversationEvent
| { id: string; at: string; type: "aside"; kind: "hypothesis" | "details"; text: string }
| { id: string; at: string; type: "capabilities"; items: CapabilityId[] }
```

Le risposte:
- **S0**: «In the prototype I can do these things:» / «Nel prototipo so
  fare queste cose:», poi l'evento `capabilities`. Ogni voce, in Task 11,
  scrive nella casella la frase d'esempio nella lingua di chi guarda
  (`claude.answers.capabilities.prompt.<id>`). Nella Chat lo stesso evento,
  senza clic *(scelta del costruttore)*. Le voci sono **nove**: le sette
  degli scenari più `mailBody` (email e risposte nella Posta) e `taskDescription`
  *(maintainer, 2 nov 2026)*; etichette e frasi d'esempio, coi segnaposti
  fra parentesi quadre e mai un oggetto del seme, nello shape
  `claude-scenarios.md` §3.5 *(scelta del controller)*.
- **S2** («quali progetti sono fermi e perché?», «which projects are
  stuck?»): prima riga «3 projects have stalled tasks» (il numero dal
  calcolo); una riga per progetto, «ACQ — 4 stalled tasks, the oldest for
  12 days (waiting for a reply)»; oltre 5 «and N more · open the list»
  verso l'elenco dei fermi di All projects (`PortfolioStalled`, con
  l'indirizzo che quella pagina usa già). Un'**ipotesi** solo quando la
  più vecchia è `idle` e senza settimana: «Maybe it fell out of planning:
  it has no week» (un `aside` `hypothesis`). «Details»: come è contato
  (`stallOf`, soglie del progetto).
  Col contesto di un progetto (l'Overview, o il chip su un progetto) e una
  frase che lo nomina o dice «in questo progetto», S2 si restringe a quel
  progetto: «Which tasks are stalled in ACQ, and why?» risponde con le task
  ferme di ACQ ([SG 3]) *(ruling del controller (pre-flight), P16)*.
- **S3** («quanto abbiamo speso in AI questo mese?»):
  - `instance` (Roberta): totale, confronto col budget («$412 of $600
    this month»), i 3 che spendono di più, link a Consumi;
  - `projects` (Laura): «In the projects whose usage you can see: $X», con
    l'elenco; nessun totale d'istanza; riga finale «The total is visible
    to people who can see usage · [Who?](who:seeUsage)», il «Who?»
    d'istanza nella forma nuova di `whoOf` qui sopra;
  - `none` (Sara): «You can't see the usage of any project ·
    [Who?](who:seeUsage)».
- **Dato che manca**: «Quanto spende Roberta?» → «I don't have usage per
  person» / «Non ho i consumi per persona», niente stima.

Test:
- [ ] S0 in en e it: la prima riga e le nove voci *(maintainer)*; nessuna
  frase d'esempio contiene un codice o un nome del seme *(scelta del
  controller)*; nessuna riga dice che
  Claude chiede sempre conferma; nella Chat lo stesso evento.
- [ ] S2 per Giulia e per Roberta sullo stesso seme: i numeri uguali al
  calcolo indipendente (`stallOf` sui progetti che ciascuna vede); la
  risposta di Giulia non contiene (in minuscolo) codici, nomi o conteggi
  dei progetti che vede solo Roberta; nessuna frase «only the ones you
  see».
- [ ] S2 con 8 progetti fermi (task rese ferme nel test): 5 righe e «and 3
  more · open the list» col link.
- [ ] Con un solo progetto fermo (gli altri sbloccati nel test): una riga
  sola, «ACQ has 4 stalled tasks, the oldest for 12 days (…)», senza
  elenco.
- [ ] L'ipotesi: è un `aside` `hypothesis`, mai nel `say`; senza le sue
  condizioni non c'è.
- [ ] S2 ristretto: Giulia dall'Overview di ACQ, «Quali task sono ferme in
  ACQ, e perché?» → solo le task ferme di ACQ, i numeri uguali a `stallOf`
  su ACQ, nessun altro progetto *(ruling del controller (pre-flight), P16)*.
- [ ] La riga di S2 dice la persona della decisione e la task che blocca
  solo se chi chiede le vede; i «Details» dicono la soglia *(ruling del controller (pre-flight), P6)*.
- [ ] «which projects are stuck?» e «quanto abbiamo speso in AI questo
  mese?» danno `stalled` e `spend`, non `explain` né `general` *(ruling del controller (pre-flight), P10)*.
- [ ] S3 Roberta: totale = `getUsage({ range: { month: true }, groupBy: "project" })` *(ruling del controller (pre-flight), P20)*, top 3
  coi codici, «Other projects» possibile; Laura: totale = somma di
  `getProjectUsage` dei suoi progetti, nessun numero uguale al totale
  d'istanza nel testo, nessun «Other projects»; Sara: la riga `none`.
- [ ] «Quanto spende Roberta?»: la frase del dato che manca, nessuna cifra.
- [ ] `whoOf`: `who:seeUsage` diventa `WhoCanLink` d'istanza (la lista
  dice chi ha `usage.view`); `who:recordDecision/AUD` resta com'è (con e
  senza visibilità di AUD); `who:recordDecision` senza codice e
  `who:nonEsiste` restano testo. La riga di Laura in S3 resa nel flusso ha
  il link.
- [ ] Il mese si misura su `now()` (con «Fai passare il tempo» al mese
  dopo, la spesa riparte).
- [ ] Commit `feat(desktop): Claude risponde sui progetti fermi e sulla spesa, e dice onestamente cosa sa fare`.

### Task 7: Le azioni in blocco e i membri (S4, S5)

**Files:**
- Create: `domain/claude/intents/archive.ts`, `domain/claude/intents/member.ts`,
  `domain/names.ts`; test `domain/claude/intents.10b.actions.test.ts`,
  `data/claude/bulk.test.ts`, `domain/names.test.ts`.
- Modify:
  - `data/model.ts`: `ProposedAction.why?: Utterance`; l'evento `proposal`
    + `notes?: ProposalNote[]` e `blocked?: { kind: "escalation"; roleId:
    string }`;
  - `domain/claude/context.ts`: `ReadApi` + `listArchiveCandidates`,
    `findPeople`, `listProjectRoles`, `canGrantRole`;
  - `domain/claude/intents.ts`: `Intent` + `"archive" | "member"`,
    riconosciuti dopo `refused` e **prima dei comandi** («add Luca to ACQ
    as Developer» e «aggiungi Luca…» oggi cadono in `CREATE`) *(ruling del controller (pre-flight), P10)*;
  - `domain/claude/answers.ts`: `Answer.notes?`, `Answer.blocked?`, scritti
    sulla `proposal`;
  - `data/claude/answersData.ts`: le letture nuove;
  - `data/claude/classes.ts`: `addMember` + motivo `notifies` con la
    persona aggiunta, calcolato con la stessa funzione dei destinatari che
    usa la scrittura (`memberAddedRecipientOf`) *(maintainer, 2 nov 2026,
    D4)*;
  - `data/claude/classes.test.ts`: «addMember è C con la riconferma» si
    aggiorna (`notifies` con la persona, poi `reauth`). Effetto dichiarato:
    l'«Annulla» di un `removeMember` di Claude (inverso `addMember`) ora
    avvisa, quindi passa da una scheda (`undoAsks`) *(ruling del controller (pre-flight), P7)*;
  - `data/admin/members.ts`: `writeJoin` (quindi `addMemberAs` e le
    proposte della posta, `data/mail/proposals.ts`) pubblica la notifica
    `member.added` alla persona aggiunta *(maintainer, 2 nov 2026, D4;
    la posta *(ruling del controller (pre-flight), P25)*)*:
    - parte sia per un'aggiunta a mano (Amministrazione → Membri, Settings
      → Members) sia per una di Claude per conto di qualcuno, che porta
      `viaClaude` come `task.assigned`;
    - parte anche per le persone aggiunte da una proposta della posta
      confermata *(ruling del controller (pre-flight), P25)*;
    - non parte per chi aggiunge sé stesso (anche il Project Lead di un
      progetto appena creato), né per Claude collega;
    - dentro un «Annulla» non parte (`silencedByUndo`), e quella di prima
      si legge «Undone by …», derivato a lettura;
    - `setMemberRole` non la manda (non è un'aggiunta);
  - `data/model.ts` (o dove vive l'elenco dei tipi di notifica): il tipo
    `member.added`, con `projectId` e `roleId` come valori stabili
    (`AppNotification.roleId?`, facoltativo) *(ruling del controller (pre-flight), P25)*;
  - `notifications/NotificationItem.tsx`: titolo «You've been added to ACQ
    as Developer» / «Sei stato aggiunto ad ACQ come Developer», il nome del
    ruolo letto a lettura; col segno, corpo «Claude on behalf of Laura
    Costa added you to ACQ as Developer.» / «Claude per conto di Laura
    Costa ti ha aggiunto ad ACQ come Developer.»; il link al progetto
    (parte UI dopo lo shape, Task 0);
  - `pages/admin/InviteDialog.tsx`, `pages/admin/PeoplePage.tsx`:
    `?invite=1&inviteProject=<CODE>&inviteRole=<roleId>` apre il dialogo
    con progetto e ruolo scelti e l'email vuota;
  - `router.tsx` (`AppSearch`, `PEOPLE_SEARCH_KEYS`) e `data/routes.ts`
    (il validatore dei link): `inviteProject` (codice) e `inviteRole` (id
    di un ruolo), con un caso in `data/routes.test.ts` *(ruling del controller (pre-flight), P9)*;
  - `data/claude/classes.ts` e `pages/claude/conversation/ProposalCard.tsx`:
    la frase sopra la scheda e la riga «Notifies» usano `nameList`
    (minore T5 e M6 del 10a);
  - i18n `claude.answers.{archive,member}.*`, `notifications.memberAdded.*`
    (en e it);
  - test anche in `data/admin/memberAdded.test.ts`,
    `notifications/NotificationItem.memberAdded.test.tsx`.

**Interfaces, prodotte:**

```ts
// data/model.ts
export type ProposalNote =
  /** Progetti che chi chiede vede ma non gestisce: il numero dei visibili, col «Who?». */
  | { kind: "not_manageable"; count: number; whoAction: string;
      /** I codici di quei progetti, tutti visibili a chi chiede: il «Who?» per progetto (maintainer, 2 nov 2026, SC 11). Facoltativo. */
      codes?: string[] }
  /** Un progetto `busy`, con le ragioni di `busyReasonsOf` come le legge chi chiede. */
  | { kind: "busy"; code: string; reasons: ClaudeBusyReason[] };
// data/model.ts *(ruling del controller (pre-flight), P5)*
export interface ArchiveCandidates {
  candidates: { projectId: string; code: string; name: string; lastActivity: string }[];
  busy: { code: string; reasons: ClaudeBusyReason[] }[];
  notManageable: number;
}
// data/claude/answersData.ts
/** I progetti aperti e visibili senza attività da `days` su `now()` (`lastActivityOf`), divisi per ciò che chi chiede può fare. */
export function archiveCandidatesFor(me: string, days: number): ArchiveCandidates;
// domain/claude/context.ts, ReadApi
listArchiveCandidates(days: number): Promise<ArchiveCandidates>;
/** Le persone che chi chiede vede, il cui nome (o nome e cognome) è `name`, senza maiuscole. */
findPeople(name: string): Promise<Person[]>;
listProjectRoles(): Promise<{ id: string; name: string }[]>;
canGrantRole(projectId: string, roleId: string): Promise<"ok" | "escalation" | "forbidden">;
// data/admin/members.ts (D4)
/** Chi riceve `member.added`: la persona aggiunta, se non è chi agisce né Claude collega; `null` altrimenti. */
export function memberAddedRecipientOf(me: string, personId: string): string | null;
// domain/names.ts
/** «Marco Bellini», «Marco Bellini and Laura Costa», «A, B, C and 2 more»: una funzione sola per scheda e motivi. */
export function nameList(t: T, names: string[], max?: number): string;
```

Le risposte:
- **S4** («archivia i progetti senza attività da 3 mesi», «archive projects
  with no activity for 90 days», varianti con «fermi», «inattivi», giorni
  o mesi): la prima riga col numero dei candidati; una scheda B con un
  `archiveProject` per candidato, `why` «last activity: Aug 4» /
  «ultima attività: 4 ago»; `notes` per i `busy` e per i non gestibili.
  Nessun candidato: una riga («No project you manage has been inactive for
  3 months»), e le `notes` se ci sono. Conferma: tutti insieme o nessuno
  (`executeGroup`); «Annulla» li riapre tutti.
- **S5** («invita Luca come Developer in ACQ», «add Luca to ACQ as
  Developer»):
  - un Luca visibile, non membro → «Luca Bianchi is already in Stubwise:
    I'll add him to ACQ as Developer», scheda C con `addMember`;
  - più Luca → una scheda di scelta (Task 4) coi soli visibili;
  - già membro → una riga, nessuna scheda;
  - nessun Luca → un invito vero: il link è un segreto, quindi la riga D
    porta al dialogo «Invite» già compilato (`Answer.place`, progetto e
    ruolo nell'indirizzo, mai un'email inventata né un link);
  - ACQ invisibile o inesistente → «Can't find the project ACQ» (la frase
    di `explain.notFound`);
  - `canGrantRole` `escalation` → la scheda nasce con `blocked`, e la sua
    riga lo dice prima della conferma (Task 11 spegne Confirm);
  - un ruolo che non esiste → una scheda di scelta coi ruoli.

Test:
- [ ] `archiveCandidatesFor`: Roberta → `ORT`, `SPZ`, `LNT` candidati e
  `BSC` in `busy` (RNC mai); Giulia → `ORT` candidato, `notManageable` 0, e
  nient'altro dei nuovi; Laura → `LNT` in `notManageable`.
- [ ] S4 Roberta: una scheda con tre azioni e i loro `why`; la nota `busy`
  di `BSC`; confermata: tre voci del registro «Claude on behalf of Roberta
  Fontana archived …»; «Annulla» li riapre tutti, e le automazioni di un
  progetto tornano accese solo se lo erano (regola del 9c, un'automazione
  attiva su `ORT` creata nel test); dopo che Roberta ne
  riapre uno a mano, l'«Annulla» è `changed_after` e gli altri restano
  archiviati.
- [ ] La nota `not_manageable` porta `codes` coi soli codici visibili
  (Laura: `["LNT"]`), lunga quanto `count`; una fixture senza `codes`
  rende la riga senza menu dei progetti *(maintainer)*.
- [ ] S4 Giulia: il testo e la scheda non contengono (in minuscolo) `spz`,
  `lnt`, `bsc` né i loro nomi, né un numero che li conti.
- [ ] S4 con 8 candidati (progetti resi inattivi nel test): la scheda ha 8
  azioni (le mostra Task 11 con «Show 3 more»).
- [ ] S5 Laura: scheda C con `addMember` (Luca, ACQ, Developer), «Notifies
  Luca Bianchi» *(D4)*; Conferma → codice → Luca è membro, Luca ha la
  notifica `member.added` con `viaClaude`; «Annulla» con la grazia scaduta
  chiede il codice; annullata, Luca non ha una seconda notifica e la prima
  si legge «Undone by Laura Costa».
- [ ] `member.added` a mano (D4): Laura aggiunge Luca da Settings →
  Members → Luca la riceve, senza segno; `memberAddedRecipientOf(LAURA,
  LAURA)` e `memberAddedRecipientOf(LAURA, CLAUDE_ID)` sono `null`
  *(ruling del controller (pre-flight), P8)*;
  `setMemberRole` → nessuna; titolo e corpo in en e in it, con il ruolo
  letto a lettura (rinominato il ruolo dopo, la notifica dice il nome
  nuovo); fixture di una notifica senza `viaClaude`, apposta.
- [ ] S5 con un secondo Luca (aggiunto nel test) visibile e un terzo che
  Laura non vede: la scheda di scelta ha due opzioni.
- [ ] S5 senza Luca («invita Pietro come Developer in ACQ»): nessuna
  proposta, la riga D col link `#/admin/people?invite=1&inviteProject=ACQ&inviteRole=…`;
  nessun evento contiene `/invite/` né un token (regex sul JSON degli
  eventi); il link apre il dialogo con progetto e ruolo, email vuota.
- [ ] S5 da chi non vede ACQ: «Can't find the project ACQ», identica a un
  codice inesistente.
- [ ] S5 con un ruolo che dà permessi che Laura non ha: `blocked` sulla
  scheda.
- [ ] `nameList` in en e it fino a 3 nomi e oltre; la frase sopra la
  scheda e la riga «Notifies» dicono le stesse persone con due nomi.
- [ ] `member.added` dalla posta: confermata una proposta che aggiunge
  qualcuno a un progetto, la persona aggiunta riceve la notifica, senza
  segno; chi conferma non la riceve *(ruling del controller (pre-flight), P25)*.
- [ ] «add Luca to ACQ as Developer», «aggiungi Luca ad ACQ come
  Developer» e «archive projects with no activity for 90 days» danno
  `member` e `archive`, mai `create` *(ruling del controller (pre-flight), P10)*.
- [ ] `addMember` ha `notifies` con la persona aggiunta; l'«Annulla» di un
  `removeMember` di Claude apre una scheda *(ruling del controller (pre-flight), P7)*.
- [ ] L'indirizzo dell'invito sopravvive al router: `inviteProject` e
  `inviteRole` arrivano a `PeoplePage` *(ruling del controller (pre-flight), P9)*.
- [ ] Commit `feat(desktop): archiviare in blocco e aggiungere un membro dal riquadro di Claude`.

### Task 8: Le bozze: note di rilascio, testi delle bozze, l'intento «bozza» (S6, S6b, Posta, descrizione)

Dati e motore. Il campo, il segno e la riga nella conversazione sono del
Task 10. I campi sono i quattro di D1 *(maintainer, 2 nov 2026)*: risposta
di supporto, note di rilascio, corpo dell'email, descrizione di una task.

**Files:**
- Create: `data/releases/notes.ts`, `data/claude/drafts.ts` (le bozze di
  Posta e descrizione), `domain/claude/intents/draft.ts`; test
  `data/releases/notes.test.ts`, `data/claude/drafts.test.ts`,
  `domain/claude/intents.10b.draft.test.ts`.
- Modify:
  - `data/model.ts`: `OpenPullRequest.releaseNotes?: string | null`,
    `Release.releaseNotes?: string | null`; l'evento `draft`; il tipo
    `FieldRef`; `ContextRef` + `{ kind: "mail"; threadId: string | null }`
    (D1: `null` = l'email nuova di `compose=new`);
  - `layout/claudePanel/pageContext.ts`: `#/mail/<threadId>` → `mail` con
    l'id, `#/mail?compose=new` → `mail` con `null`;
  - `data/claude/context.ts`: `contextOf` per `mail`: solo se chi guarda
    vede la conversazione (`canSeeMessage`, cioè la sua casella:
    `mailbox_owner`, mai quella di un altro, admin compresi), chip
    «email» senza codice; `presentEventFor` come sotto;
  - `data/releases/writes.ts`: `setPrReleaseNotes`; `mergePr` copia le
    note sul `Release`;
  - `data/releases/visibility.ts` (dove vivono `OpenPrView` e
    `ReleaseView`): `OpenPrView.canEditReleaseNotes`; `releaseNotes` arriva
    già da `OpenPullRequest` e da `Release` *(ruling del controller (pre-flight), P15)*;
  - `data/store.ts`: `ApiFnName` + `"releases.setPrReleaseNotes"`;
  - `data/queries.ts`: `useSetPrReleaseNotes`;
  - `domain/claude/intents.ts`: `Intent` + `"draft"`. Si prova **prima di
    `refused`** solo se il comando comincia con un verbo di scrittura
    («scrivi», «prepara», «write», «draft»): così «scrivi e manda
    l'email» dà la bozza più la riga D `send`, mentre «manda l'email» da
    solo resta la riga D del 10a (`intents.10a.test.ts` resta verde);
  - `domain/claude/context.ts`: `IntentContext.context?: ContextRef | null`
    (solo se `contextOf` lo vede); `ReadApi` + `supportReplyDraft`,
    `releaseNotesDraft`, `mailDraft`, `taskDescriptionDraft`;
  - `domain/claude/answers.ts`: `Answer.draft?`; `toSteps` emette il
    `draft` `pending`;
  - `data/api-mutations.ts`: `freeTurn` passa `context`; `readsAs`;
  - `data/claude/context.ts`: `presentEventFor` toglie testo e bersaglio
    di un `draft` a chi non vede l'oggetto del campo; per un `mail` a
    chiunque non sia il proprietario della casella;
  - i18n `claude.answers.draft.*`.

**Interfaces, prodotte:**

```ts
// data/model.ts
/** Un campo che una pagina dichiara riempibile (design, parte 1). */
export type FieldRef =
  | { kind: "supportReply"; conversationId: string }
  | { kind: "releaseNotes"; prId: string }
  /** D1: il corpo di una risposta (`threadId`) o di un'email nuova (`null`), solo nella propria casella. */
  | { kind: "mailBody"; threadId: string | null }
  /** D1: la descrizione di una task, nel campo aperto di `DescriptionSection`. */
  | { kind: "taskDescription"; taskId: string };
// ConversationEvent
| {
    id: string; at: string; type: "draft";
    field: FieldRef;
    text: string;
    /** I codici citati (note di rilascio): ogni riga ne ha uno. */
    sources?: string[];
    /** `pending` fino al riquadro; `placed` nel campo; `waiting` = pagina lasciata («Put it in the field»). */
    status: "pending" | "placed" | "waiting" | "undone" | "changed_after";
  }
// data/releases/writes.ts
/** Le note di una PR aperta: chi può modificare la task della PR (`tickets.edit`) o mergiarla (`release.merge`). */
export async function setPrReleaseNotes(prId: string, text: string): Promise<OpenPrView>;
// data/releases/notes.ts
/**
 * La bozza delle note: una riga per task, «- ACQ-12: <titolo>», dalla task
 * della PR e dai commit che citano un codice di task visibile; un commit
 * senza codice, o con un codice invisibile o eliminato, non dà righe.
 * `null` se chi chiede non può modificare le note.
 */
export function releaseNotesDraftFor(me: string, prId: string): { text: string; sources: string[] } | null;
// data/support/visibility.ts (esiste: `draftText`)
/** La bozza della risposta, se chi chiede ha `support.reply` nel progetto; altrimenti `null`. */
export function supportReplyDraftFor(me: string, conversationId: string): string | null;
// data/claude/drafts.ts (D1)
/**
 * La bozza del corpo di un'email: `draftReply` (`domain/claude/intents/mailDraft.ts`,
 * la stessa di «Ask Claude» della Posta) con le letture di chi chiede.
 * `null` se la conversazione non è nella sua casella; un'email nuova senza
 * indicazione è `{ ok: false, reason: "hint" }`.
 */
export async function mailDraftFor(me: string, threadId: string | null, hint: string): Promise<
  | { ok: true; text: string; used: string[] }
  | { ok: false; reason: "not_found" | "hint" }
>;
/**
 * La bozza della descrizione di una task: dalla richiesta d'origine (titolo,
 * descrizione, urgenza) e dalla conversazione di supporto da cui viene, solo
 * se chi chiede le vede. Senza `tickets.edit` sul progetto: `forbidden`;
 * senza fonti: `no_source` (Claude non inventa una descrizione).
 */
export function taskDescriptionDraftFor(me: string, taskId: string):
  | { ok: true; text: string; sources: string[] }
  | { ok: false; reason: "not_found" | "forbidden" | "no_source" };
// domain/claude/context.ts, ReadApi
supportReplyDraft(conversationId: string): Promise<string | null>;
releaseNotesDraft(prId: string): Promise<{ text: string; sources: string[] } | null>;
mailDraft(threadId: string | null, hint: string): ReturnType<typeof mailDraftFor>;
taskDescriptionDraft(taskId: string): Promise<ReturnType<typeof taskDescriptionDraftFor>>;
// domain/claude/answers.ts
Answer.draft?: { field: FieldRef; text: string; sources?: string[] };
```

Il riconoscimento (en/it, varianti comprese):
- «scrivi/prepara la risposta», «write the reply»: col contesto `support`
  → `supportReply`; col contesto `mail` → `mailBody` della conversazione
  aperta;
- «scrivi le note di rilascio», «draft the release notes»: contesto `pr`
  → `releaseNotes`;
- «scrivi un'email a … per dire che …», «write an email to … saying …»:
  contesto `mail` con `null` (la nuova email aperta) → `mailBody` con
  l'indicazione dopo «per dire che» / «saying»; senza indicazione, una
  riga che la chiede («What should the email say?»), nessuna bozza;
- «scrivi la descrizione di ACQ-14», «write the description for ACQ-14»
  (anche senza codice col contesto `task`) → `taskDescription`. «Descrivi
  ACQ-14» resta `explain`: non scrive niente;
- un codice nella frase (`ACQ-S2`, `ACQ-14`) vale come il contesto;
- un contesto che non porta a uno dei quattro campi: «Open the
  conversation, the email, the pull request or the task and ask me
  again», con il link se la frase nomina un codice.

Le regole di D1 *(maintainer, 2 nov 2026)*:
- tutte le bozze sono classe A e non scrivono dati: il testo va nel campo
  (Task 10);
- **inviare l'email resta della persona**: «scrivi e manda l'email»
  scrive la bozza e poi la riga D `send` del 10a («Sending is yours…»),
  nessun invio;
- **la descrizione** non chiama `updateTask`: diventa una modifica della
  task solo col «Save» della persona; `no_source` è la frase del dato che
  manca («I have nothing to write ACQ-14's description from: tell me what
  it should say»), `forbidden` la riga con `[Who?](who:editTasks/ACQ)`;
- il messaggio della Chat resta escluso: «scrivi un messaggio nel canale»
  risponde che lì la bozza la scrive @Claude nel thread (area 4), senza
  bozza.

Test:
- [ ] `releaseNotesDraftFor` sulla PR del seme: due righe, ognuna con il
  suo codice; il commit senza codice non c'è; un codice di una task resa
  invisibile o eliminata non c'è (in minuscolo).
- [ ] `setPrReleaseNotes`: Laura sì; un Contributor senza `tickets.edit` né
  `release.merge` → `forbidden`; una PR di un progetto invisibile →
  `not_found`; dopo `mergePr` il rilascio ha le note.
- [ ] S6 (Davide, contesto `ACQ-S2`): un `draft` `supportReply` col testo
  di `draftText`; il testo non contiene nomi di persone del team (in
  minuscolo, `PEOPLE` meno il cliente); nessun messaggio nuovo nella
  conversazione di supporto.
- [ ] S6 da Sara (senza `support.reply`): «You can't reply to this
  conversation · [Who?](who:replyCustomers/ACQ)», nessun `draft`.
- [ ] S6b (Laura, contesto la PR): un `draft` `releaseNotes` con `sources`;
  le note della PR restano `undefined` (la bozza non si salva da sola).
- [ ] Una conversazione pubblica con un `draft` letta da chi non vede ACQ:
  né testo né codice nel JSON letto (in minuscolo).
- [ ] Posta (D1), Giulia sulla sua conversazione del seme: «scrivi la
  risposta» → un `draft` `mailBody` col testo di `mailDraftFor` (lo stesso
  di «Ask Claude» con la stessa indicazione); nessun messaggio inviato
  (`state.mailMessages` invariato); il testo non nomina persone del team
  diverse da chi scrive.
- [ ] Posta, email nuova: con «per dire che slitta a giovedì» la bozza;
  senza indicazione la riga che la chiede e nessun `draft`.
- [ ] Posta, `mailbox_owner`: il contesto di una conversazione della
  casella di Marco, aperto da Roberta (admin), non c'è (`contextOf`
  `null`), e «scrivi la risposta» non produce bozza; una pubblica di
  Giulia con un `draft` `mailBody` letta da Roberta non ha né testo né
  oggetto (in minuscolo).
- [ ] «Scrivi e manda l'email»: la bozza e la riga D `send`; nessun invio.
- [ ] Descrizione (D1), Laura sulla task convertita del seme: un `draft`
  `taskDescription` che cita il codice della richiesta e il suo testo;
  `description` della task invariata e nessuna voce d'attività nuova.
- [ ] Descrizione senza fonti (una task nata a mano, nel test):
  `no_source`, la frase del dato che manca, nessun `draft`; da Sara su una
  task di ACQ senza `tickets.edit`: la riga col «Who?».
- [ ] «Descrivi ACQ-14» resta `explain`; «scrivi un messaggio nel canale»
  non produce un `draft`.
- [ ] Commit `feat(desktop): le note di rilascio delle PR e le bozze di Claude per supporto, note, Posta e descrizioni`.

### Task 9: Le azioni della pagina: filtro, lingua, tema, filtro salvato

Lato pagina *(scelta del controller del 10a, «Filtro, lingua e tema lato
pagina → 10b»)*. Il filtro salvato personale è invece una scrittura dei
dati, e va nel catalogo. La parte UI aspetta lo shape `claude-scenarios.md`.

**Files:**
- Create: `domain/claude/intents/page.ts`, `layout/claudePanel/pageActions.ts`,
  `pages/claude/conversation/PageActionRow.tsx`; test
  `domain/claude/intents.10b.page.test.ts`, `layout/claudePanel/pageActions.test.tsx`,
  `data/claude/savedFilter.test.ts`.
- Modify:
  - `data/api-mutations.ts`: `saveFilterAs`, `deleteFilterAs`; la mutazione
    `settlePageEvent`;
  - `data/claude/catalogMore.ts`: `saveFilter` (A, inverso `deleteFilter`;
    `invalid: visibility` se non è `"private"`) e `deleteFilter` (B, non si
    annulla); `data/claude/types.ts`: `ClaudeActionFn` + i due;
    `ObjectRef` + `{ kind: "filter"; id: string }`; `whoAction: null`
    per i due (un filtro personale non chiede permessi) *(ruling del controller (pre-flight), P4)*;
  - `data/claude/actions.ts`: `projectOfRef` → `null` e `writesOn` da
    `state.objectWrites` per `filter`; `data/store.ts`: `ObjectWrite.kind`
    + `"filter"`, con `noteWrite` in `saveFilter`, `updateFilter`,
    `deleteFilter` *(ruling del controller (pre-flight), P4)*;
  - `data/claude/catalog.test.ts`: i casi di `saveFilter` in `SCENARIOS`,
    e l'eccezione del `whoAction` `null` estesa ai due filtri
    *(ruling del controller (pre-flight), P4)*;
  - `domain/claude/intents.ts`: `Intent` + `"page"`, riconosciuto dopo
    `refused` e prima dei comandi e di `explain` («show ACQ tasks…» ha un
    codice noto) *(ruling del controller (pre-flight), P10)*;
  - `data/model.ts`: l'evento `pageAction`;
  - `domain/claude/answers.ts`: `Answer.page?`; `toSteps` emette il
    `pageAction` `pending`;
  - `layout/claudePanel/ClaudePanel.tsx`: monta `usePageEventRunner`
    (esegue i `pageAction` `pending` di chi guarda, una volta; i `draft`
    li aggiunge il Task 10) *(ruling del controller (pre-flight), P22)*;
  - `pages/claude/conversation/EventList.tsx`, `flow.ts`: il tipo
    `pageAction`;
  - i18n `claude.answers.page.*`, `claude.conversation.page.*`.

**Interfaces, prodotte:**

```ts
// data/model.ts
export type PageAction =
  | { kind: "language"; to: "en" | "it" }
  /** I valori di `ThemePreference` (`theme/theme.ts`), scritti qui: `model.ts` non importa dal tema. */
  | { kind: "theme"; to: "system" | "light" | "dark" }
  /** `route` e `search` come li usa la pagina: Tasks legge i criteri da `filters`. */
  | { kind: "filter"; route: string; search: Record<string, unknown> };
// ConversationEvent
| { id: string; at: string; type: "pageAction"; action: PageAction;
    status: "pending" | "done" | "undone" | "changed_after" | "failed" }
// data/api-mutations.ts
/** Chiude un evento `draft` o `pageAction` del riquadro: solo chi ha aperto la conversazione, solo un evento `pending`/`placed`/`waiting`/`done`. Nessun'altra scrittura. */
export async function settlePageEvent(conversationId: string, eventId: string, status: "placed" | "waiting" | "done" | "undone" | "changed_after" | "failed"): Promise<void>;
// layout/claudePanel/pageActions.ts
/** Il valore di prima, in memoria per persona (svuotata da `onStoreReset`): l'«Annulla» lo rimette solo se c'è ancora il valore di Claude. */
export function usePageEventRunner(conversationId: string | null): void;
export function undoPageEvent(eventId: string): "undone" | "changed_after" | "not_undoable";
```

Regole:
- Sempre classe A: toccano solo chi chiede e si rimettono a posto.
- Il riconoscimento: «passa al tema scuro», «dark theme», «metti
  l'interfaccia in inglese», «switch to Italian»; «mostrami le task di
  Marco in ACQ», «show ACQ tasks assigned to Marco» (progetto + persona +
  «aperte/ferme», con `FilterCriteria`); «salva questo filtro come …» (il
  `saveFilter` del catalogo, privato).
  «Questo filtro» sono i criteri dell'ultimo `pageAction` `filter` `done`
  della conversazione: il contesto della pagina non porta la ricerca.
  Senza, una riga chiede di filtrare prima, e non nasce niente
  *(ruling del controller (pre-flight), P21)*.
- L'«Annulla» rimette il valore di prima **solo se c'è ancora quello di
  Claude**; altrimenti `changed_after` («You changed it afterwards»).
  Dopo un ricaricamento non c'è più il valore di prima: «Can't be undone
  anymore», niente bottone.
- **Il «vedi come»**: il runner esegue solo gli eventi della persona della
  sessione, e la memoria è per persona.

Test:
- [ ] Il motore: le frasi en/it danno il `pageAction` giusto e nessuna
  `proposal`; «tema scuro» con un tema già scuro risponde che lo è già.
- [ ] Il runner: un `language` `pending` cambia lingua una volta (anche
  dopo un secondo render), chiude l'evento `done`; «Undo» rimette la
  lingua; dopo un cambio a mano, «Undo» è `changed_after`.
- [ ] Il filtro: la pagina sotto passa all'indirizzo con i criteri;
  «Undo» torna all'indirizzo di prima se è ancora quello di Claude.
- [ ] `saveFilter` dal catalogo: A, nasce privato; «Annulla» lo elimina;
  con `visibility: "public"`: `invalid`.
- [ ] `settlePageEvent` da un'altra persona: `forbidden`.
- [ ] «salva questo filtro come Marco in ACQ» dopo «mostrami le task di
  Marco in ACQ» salva quei criteri; senza un filtro prima, la riga che lo
  chiede e nessun `saveFilter` *(ruling del controller (pre-flight), P21)*.
- [ ] `catalog.test.ts` verde coi due filtri; dopo un `updateFilter` della
  persona l'«Annulla» del `saveFilter` è `changed_after` *(ruling del controller (pre-flight), P4)*.
- [ ] «show ACQ tasks assigned to Marco» e «passa al tema scuro» danno
  `page`, non `explain` *(ruling del controller (pre-flight), P10)*.
- [ ] Nessun toast per un'azione A della pagina (decisione del maintainer).
- [ ] Commit `feat(desktop): filtro, lingua, tema e filtro salvato dal riquadro di Claude`.

### Task 10: I campi riempibili e il segno «Bozza di Claude» (UI)

Segue lo shape `claude-drafts.md`. Le pagine che dichiarano un campo sono
quattro *(maintainer, 2 nov 2026, D1)*: Supporto, PR, Posta, Task.

**Files:**
- Create: `layout/claudePanel/fillable.ts`, `pages/claude/conversation/DraftRow.tsx`,
  `tasks-ui/ClaudeDraftMark.tsx`, `pages/releases/ReleaseNotesField.tsx`;
  test `layout/claudePanel/fillable.test.tsx`,
  `pages/claude/conversation/DraftRow.test.tsx`,
  `pages/releases/ReleaseNotes.test.tsx`, `pages/support/ReplyComposer.claude.test.tsx`,
  `pages/mail/Composer.claude.test.tsx`, `pages/task/DescriptionSection.claude.test.tsx`.
- Modify:
  - `pages/support/ReplyComposer.tsx`: dichiara il campo
    (`useFillableField`) e usa `useClaudeDraftMark` per la bozza preparata,
    per il bottone della barra e per il riquadro. Il bottone «Claude's
    draft» / «Bozza di Claude» diventa «Ask Claude» / «Chiedi a Claude»
    (chiave nuova, comportamento invariato): «Bozza di Claude» resta solo
    del segno *(maintainer, 2 nov 2026)*. La casella non intercetta più
    ⌘J *(maintainer, 2 nov 2026)*;
    via la riga `support.reply.editedFrom` (en e it), perché il segno unico
    vale anche qui, e via ⌘J dal `title` del bottone; si aggiornano
    `pages/support/Support.test.tsx` e `pages/mail/Compose.test.tsx` *(ruling del controller (pre-flight), P12)*;
  - `pages/mail/ClaudeDraftButton.tsx`, `pages/mail/Composer.tsx`: il segno
    con `useClaudeDraftMark`; via la riga `mail.compose.edited`; il
    campo `mailBody` lo dichiara la pagina (`ReadingPane`/`MailPage`): la
    conversazione aperta della propria casella, anche senza casella di
    scrittura aperta (allora `put` apre «Reply», [DR 6]), o l'email nuova
    con `null` (D1) *(ruling del controller (pre-flight), P13)*. «Send»
    non cambia: è il solo modo di inviare. `Composer.tsx` non intercetta
    più ⌘J: «Ask Claude» resta un bottone, ⌘J è del riquadro
    *(maintainer, 2 nov 2026)*;
  - `pages/task/DescriptionSection.tsx` (D1): dichiara il campo
    `taskDescription` quando chi guarda può modificare (`canEdit`); `put`
    apre il modo modifica (`draft`) col testo di Claude e il segno. «Save»
    (⌘/Ctrl+Invio) resta della persona e salva con `updateTask` a mano,
    senza segno `via`; Esc chiude e butta la bozza (la riga diventa
    `changed_after`). Senza `canEdit` il campo non si dichiara;
  - `pages/releases/PrPanel.tsx`, `pages/releases/ReleaseDetail.tsx`: il
    campo «Release notes» (modificabile con `canEditReleaseNotes`, «Save»),
    le note lette dopo il merge;
    il salvataggio fallito dice «Save again» / «Salva di nuovo», non
    «Retry» / «Riprova», che `test/noDeploy.ts` vieta *(ruling del controller (pre-flight), P26)*;
  - `layout/claudePanel/pageActions.ts`: `usePageEventRunner` esegue anche i
    `draft`;
  - `pages/claude/conversation/EventList.tsx`, `flow.ts`: il tipo `draft`;
  - i18n `claude.drafts.*`, `releases.notes.*`; via `mail.compose.edited`
    da en e it.

**Interfaces, prodotte:**

```ts
// layout/claudePanel/fillable.ts
export interface FillableField {
  ref: FieldRef;
  /** L'etichetta del campo, per la riga («the reply to ACQ-S2»). */
  labelKey: string;
  get(): string;
  /** Mette il testo e il segno; «Replace or add below?» lo chiede chi chiama, se `get()` non è vuoto. */
  put(text: string, how: "replace" | "below"): void;
}
/** Una pagina dichiara un campo riempibile finché è montata. */
export function useFillableField(field: FillableField): void;
/** Il campo dichiarato dalla pagina aperta adesso, o `null`. */
export function fillableFor(ref: FieldRef): FillableField | null;
// tasks-ui/ClaudeDraftMark.tsx
/** Il segno resta finché `current === placed`. */
export function useClaudeDraftMark(current: string): { placed: string | null; place(text: string): void; clear(): void; shown: boolean };
export function ClaudeDraftMark(): JSX.Element;
```

Regole:
- Il runner mette un `draft` `pending` nel campo dichiarato se la sua pagina
  è aperta; se il campo ha già testo, la riga chiede «Replace or add
  below?» prima di scrivere. Se la pagina non è aperta: `waiting`, con «Put
  it in the field», che naviga alla pagina e mette la bozza appena il campo
  si dichiara.
- «Undo» della riga rimette il testo di prima, solo se il campo ha ancora il
  testo di Claude; altrimenti `changed_after`.
- Il segno: lo stesso componente in Supporto, Posta, note di rilascio e
  descrizione; sparisce alla prima modifica, all'invio e al salvataggio.
- «Put it in the field» porta alla pagina del campo: `#/mail/<threadId>` (o
  la nuova email), `#/p/<CODE>/tasks?task=<codice>` per la descrizione,
  la conversazione di supporto, la PR. Il runner aspetta che il campo si
  dichiari, e mette la bozza una volta sola.

Test:
- [ ] S6 nel riquadro, sulla pagina di `ACQ-S2`: il testo nel campo della
  risposta col segno; un tasto nel campo e il segno sparisce; inviato, il
  messaggio non contiene il segno né «on behalf of», e il segno non c'è
  più.
- [ ] Con testo già nel campo: «Replace or add below?»; «Add below» tiene
  il testo di prima sopra; «Undo» rimette solo il testo di prima.
- [ ] Una bozza per `ACQ-S2` chiesta da Tasks: la riga è `waiting` con «Put
  it in the field»; il clic porta alla conversazione e mette la bozza; mai
  in un campo di un'altra pagina (con la Posta aperta nel test il corpo
  dell'email resta com'era).
- [ ] S6b: le note nel campo della PR col segno, non salvate; «Save»
  le salva; dopo il merge il dettaglio del rilascio le mostra.
- [ ] Posta: dopo una modifica il segno sparisce e non compare «Edited from
  Claude's draft» (la chiave non esiste più in en né in it).
- [ ] Posta dal riquadro (D1): Giulia sulla sua conversazione, «scrivi la
  risposta» → il corpo con la bozza e il segno; nessun messaggio inviato
  finché non preme «Send»; inviato, il messaggio non ha il segno né «on
  behalf of». Con l'email nuova aperta e «scrivi un'email … per dire che
  …» la bozza va nel corpo dell'email nuova.
- [ ] Descrizione dal riquadro (D1): Laura col pannello della task
  convertita aperto, «scrivi la descrizione» → il campo si apre in
  modifica col testo e il segno; la task non cambia (nessuna attività)
  finché Laura non salva; salvata, `description` è il testo, l'attività è
  di Laura senza segno «Claude on behalf of». Esc: la descrizione resta
  com'era e la riga dice `changed_after`. Con una descrizione già scritta:
  «Replace or add below?».
- [ ] Descrizione chiesta con il pannello di un'altra task aperto: la riga
  è `waiting`, e la descrizione della task aperta non cambia.
- [ ] Sara su una task senza `canEdit`: il campo non c'è, e il runner non
  scrive mai nella descrizione.
- [ ] Un lettore della pubblica che non vede ACQ: la riga `draft` è chiusa
  e non dice il codice.
- [ ] Una fixture di `PrPanel` e una di `ReleaseDetail` senza
  `releaseNotes` né `canEditReleaseNotes`, apposta: il pannello si disegna
  in sola lettura senza note *(ruling del controller (pre-flight), P14)*.
- [ ] Il salvataggio delle note fallito: «Save again», e `expectNoDeploy()`
  verde sul pannello *(ruling del controller (pre-flight), P26)*.
- [ ] Posta, conversazione della propria casella senza casella di
  scrittura aperta: la bozza dal riquadro apre «Reply» col testo e il segno
  *(ruling del controller (pre-flight), P13)*.
- [ ] Nel Supporto, dopo una modifica, il segno sparisce e «Edited from
  Claude's draft» non c'è (la chiave non esiste in en né in it) *(ruling del controller (pre-flight), P12)*.
- [ ] Il bottone della barra del Supporto si chiama «Ask Claude» / «Chiedi
  a Claude» e fa ciò che faceva; «Claude's draft» / «Bozza di Claude»
  compare solo come segno *(maintainer)*.
- [ ] ⌘J con il fuoco nella casella della Posta e in quella del Supporto
  apre e chiude il riquadro, e non avvia una bozza né cambia il corpo
  (`pages/mail/Composer.claude.test.tsx`,
  `pages/support/ReplyComposer.claude.test.tsx`) *(maintainer)*.
- [ ] Commit `feat(desktop): le bozze di Claude nei campi della pagina, col segno unico`.

### Task 11: Gli scenari nella conversazione (UI)

Segue gli shape `claude-scenarios.md` e `claude-automations.md`.

**Files:**
- Create: `pages/claude/conversation/TrialRow.tsx`,
  `pages/claude/conversation/AsideRow.tsx`,
  `pages/claude/conversation/CapabilitiesList.tsx`; test
  `pages/claude/conversation/Scenarios.test.tsx`,
  `pages/claude/conversation/TrialRow.test.tsx`.
- Modify:
  - `pages/claude/conversation/ProposalCard.tsx`: i `why` per riga, «Show N
    more» oltre 5 (le righe nascoste restano nella scelta), le `notes` sotto
    la scheda, `blocked` (Confirm spento con la frase dell'`escalation`);
  - `pages/claude/conversation/QuestionCard.tsx`: la scheda di scelta nella
    libera (nessuna riga «whoCanAnswer», risponde solo chi ha aperto la
    conversazione);
  - `pages/claude/conversation/EventList.tsx`, `flow.ts`: `trial`,
    `aside`, `capabilities`;
  - `pages/claude/conversation/Composer.tsx` o `useComposerField.ts`: una
    voce di `capabilities` scrive la frase nella casella, senza inviare;
  - `layout/claudePanel/ClaudePanel.tsx`: alla prima resa di un `trial`
    `done` del turno in diretta, la navigazione a
    `#/automations/<code>/test?sim=<openSimId>` e «Back to <pagina>»
    *(maintainer, 2 nov 2026, D2)*;
    con `openSimId` `null` va a `#/automations/<code>/edit` ([AU 6])
    *(ruling del controller (pre-flight), P17)*;
  - `pages/automations/test/useTestRun.ts`, `TestPage.tsx`: `?sim=<id>`
    adotta la prova esistente (se è di chi guarda) invece del dialogo
    degli esempi; altrimenti il dialogo come oggi;
  - `router.tsx` (`AUTOMATION_SEARCH_KEYS`) e `data/routes.ts`: il
    parametro `sim` (un id), con un caso in `data/routes.test.ts` *(ruling del controller (pre-flight), P9)*;
  - `pages/chat/ClaudeReply.tsx`: `capabilities` come elenco senza bottoni
    e senza frasi ([SC 7]) e `aside` *(ruling del controller (pre-flight), P11)*;
  - `pages/automations/DetailHeader.tsx` e la riga meta del costruttore:
    «Created by Claude on behalf of Laura Costa» da `createdVia`. È
    l'**origine** e resta per sempre: dopo l'accensione, le pause e le
    versioni nuove *(maintainer, 2 nov 2026)*;
  - i18n `claude.conversation.{trial,aside,capabilities,proposal.notes,proposal.blocked}.*`.

Test:
- [ ] S1 nel riquadro, da Support di ACQ: la scheda di scelta, la riga
  eseguita con «Undo», la riga della prova con due esiti («Wouldn't
  start» / «Non partirebbe» per il secondo, D3), la riga «It's off…»; il
  costruttore si apre da sé nell'area principale sulla prova (D2,
  maintainer), una volta sola e solo nel turno in diretta (riaprendo la
  conversazione non si naviga), il riquadro resta aperto
  con «Back to Support»; il bottone «Turn on» del costruttore c'è, e nel
  flusso non c'è nessun «Turn on» / «Activate».
- [ ] Il costruttore aperto da un'altra persona (vedi come) con `?sim=`
  non trova la prova e mostra il dialogo degli esempi.
- [ ] Nessun esempio passa (`openSimId` `null`): D2 apre il costruttore
  `/edit`, non la prova *(ruling del controller (pre-flight), P17)*.
- [ ] Nella Chat, «Qual è la capitale del Portogallo?» con @Claude:
  l'elenco di S0 come testo; «passa al tema scuro» o «scrivi la risposta
  ad ACQ-S2» non lasciano eventi `pageAction`/`draft` `pending`, ma una
  riga che rimanda al riquadro *(ruling del controller (pre-flight), P11)*.
- [ ] La bozza nel costruttore dice «Created by Claude on behalf of Laura
  Costa»; una bozza fatta a mano non lo dice (fixture senza
  `createdVia`). Accesa da Laura e poi pubblicata una versione nuova, il
  costruttore e il dettaglio lo dicono ancora *(maintainer)*.
- [ ] S0 nel riquadro mostra nove voci *(maintainer)*.
- [ ] S4 con 8 progetti: 5 righe e «Show 3 more»; aperto, 8; togliere una
  riga e confermare archivia le altre 7; le righe delle `notes` sotto la
  scheda con «Who?» (`WhoCanLink`, `manageProjectSettings`).
- [ ] S5 `blocked`: Confirm spento con la sua frase, senza «Who?».
- [ ] `aside`: «Hypothesis» col suo segno (non solo colore); «Details»
  chiuso, si apre da tastiera.
- [ ] S0: un clic su una voce scrive la frase nella casella, nessun
  messaggio inviato; nella Chat le voci non sono bottoni.
- [ ] Nessun `can(` né `viewer` nei file toccati di
  `pages/claude/conversation/` (test sul sorgente, come nel 10a).
- [ ] Commit `feat(desktop): scenari, prova delle automazioni e schede in blocco nella conversazione`.

### Task 12: I suggerimenti discreti

Segue lo shape `claude-suggestions.md`.

**Files:**
- Create: `data/claude/suggestions.ts`, `tasks-ui/ClaudeSuggestionRow.tsx`;
  test `data/claude/suggestions.test.ts`, `tasks-ui/ClaudeSuggestionRow.test.tsx`.
- Modify:
  - `data/api.ts`, `data/queries.ts`: `getClaudeSuggestion`,
    `useClaudeSuggestion`;
  - `layout/claudePanel/panelEvents.ts`: `ClaudePanelEventDetail.fresh?:
    boolean` (apre una conversazione nuova);
  - le cinque pagine: `pages/support/ConversationDetail.tsx`,
    `pages/releases/PrPanel.tsx`, `pages/automations/ProjectAutomations.tsx`,
    `pages/overview/OverviewPage.tsx`, `pages/admin/ai/UsagePanel.tsx`;
  - i18n `claude.suggestions.*`.

**Interfaces, prodotte:**

```ts
// data/claude/suggestions.ts
export type SuggestionPlace =
  | { kind: "support"; conversationId: string }
  | { kind: "pr"; prId: string }
  | { kind: "automations"; projectId: string }
  | { kind: "overview"; projectId: string }
  | { kind: "usage" };
export interface ClaudeSuggestion {
  id: "supportReply" | "releaseNotes" | "buildAutomation" | "whyStalled" | "monthSpend";
  /** La riga e la richiesta da scrivere nella casella, nella lingua di chi guarda. */
  lineKey: string;
  promptKey: string;
  params?: Record<string, string>;
}
/** La riga di una pagina per chi guarda, o `null`. Nessun `can()` nella pagina. */
export function suggestionFor(me: string, place: SuggestionPlace): ClaudeSuggestion | null;
```

Quando c'è (le cinque di partenza del design):

| Luogo | Quando | Permesso | Mai se |
|---|---|---|---|
| `support` | `waiting_us` | `support.reply` | — |
| `pr` | senza note | `canEditReleaseNotes` | la task della PR ha un piano in attesa o una domanda aperta |
| `automations` | nessuna automazione nel progetto | `automations.manage` | — |
| `overview` | task ferme | vede il progetto | una proposta del polso aperta sul progetto |
| `usage` | sempre | `usage.view` | — |

In tutti i luoghi: **mai con il budget mensile esaurito** ([SG 5]).
La richiesta della riga Overview è quella dello shape, ristretta al
progetto, che il Task 6 riconosce ([SG 3]) *(ruling del controller (pre-flight), P16)*.

«Not now» scrive `stubwise.claudeSuggestion.<personId>.<chiave del luogo>`
in `localStorage`, con try/catch. La chiave del luogo è **l'oggetto**, non il
tipo di pagina *(maintainer, 2 nov 2026)*: `support:<conversationId>`,
`pr:<prId>`, `automations:<projectId>`, `overview:<projectId>`, `usage`
(`suggestionKeyOf(place)`, esportata da `data/claude/suggestions.ts`). Senza
archivio senza archivio la riga c'è e «Not now» la
nasconde solo fino al cambio di pagina.

Test:
- [ ] Per ogni luogo: c'è con il permesso, non c'è senza (Sara su `ACQ-S2`,
  Laura su Consumi); mai un «Who?» nella riga.
- [ ] Il «mai se»: la PR con un piano in attesa non ha la riga; un
  progetto con una proposta del polso aperta neanche.
- [ ] Budget mensile esaurito: nessuna riga in nessuno dei cinque luoghi *(ruling del controller (pre-flight), P16)*.
- [ ] La riga dell'Overview di ACQ, inviata, risponde solo sulle task ferme
  di ACQ *(ruling del controller (pre-flight), P16)*.
- [ ] Il clic apre il riquadro con una conversazione nuova e la richiesta
  nella casella, non inviata; Invio la manda (S6 dalla riga: la bozza
  arriva nel campo).
- [ ] «Not now» su `ACQ-S2`: sparisce, ricaricata la pagina resta nascosta;
  su un'altra conversazione che aspetta il team la riga c'è *(maintainer)*; con
  `localStorage` che lancia, la pagina si disegna e la riga si nasconde.
- [ ] Il testo della riga non contiene codici o nomi che chi guarda non
  vede (in minuscolo).
- [ ] Commit `feat(desktop): «Claude può aiutarti a…» nelle pagine di partenza`.

### Task 13: Documenti, parità, scatti, follow-up

- `apps/desktop/docs/area10-parity.md`: una sezione «Area 10b», una riga per
  voce nuova (dove vive, test fra virgolette): scenari S0–S6b, automazioni
  dal riquadro e prova, «Avvisa» un reparto e i due dati di
  `request_created`, bozze nei campi e segno unico, note di rilascio,
  azioni della pagina e filtro salvato, suggerimenti, schede in blocco.
  Le differenze deliberate 3, 4 e 5 del design, con il riferimento. Per le
  note di rilascio e `member.added` *(D4)*: cosa fa il web oggi (per
  `member.added`, come per `task.assigned` nel 10a: un
  `notification_kind` nuovo, con la regola di rollback e quella dei cambi
  additivi verso l'app).
- `capture.mjs`, scatti `a10b-*`:
  - S1: la scheda di scelta, la riga della prova, il costruttore con la
    prova e il riquadro aperto;
  - S2 e S3 (Roberta e Laura), con «Hypothesis» e «Details»;
  - S4 con «Show 3 more» e le righe a parte;
  - S5 con la riconferma sopra il riquadro;
  - S6 nel campo col segno, e la riga «Put it in the field»;
  - S6b nel pannello della PR;
  - la bozza nel corpo di un'email (risposta ed email nuova) e nella
    descrizione aperta di una task (D1);
  - la notifica `member.added`, a mano e «Claude on behalf of …» (D4);
  - S0 nel riquadro;
  - un suggerimento per pagina di partenza;
  - un'azione della pagina con «Undo».

  Tutto a 1440 e 1024, chiaro e scuro, en e it. Vite ucciso. Rifatti dopo
  ogni correzione visiva.
- `ossatura-follow-ups.md`:
  - «Area 10b — minori aperti»: le scelte del costruttore di questo piano,
    ognuna col costo se sbagliata (fra queste: la prova fuori dal
    catalogo, due domande per richiesta, la Chat senza clic su S0, la
    memoria del «prima» delle azioni della pagina, l'ipotesi di S2 solo
    per `idle` senza settimana; l'«Annulla» di un `removeMember` che
    diventa una scheda per `member.added` *(ruling del controller (pre-flight), P7)*); «Testo generato» non usato (nessun
    intento del prototipo scrive un riassunto lungo); il messaggio della
    Chat fuori dai campi delle bozze (D1); e in fondo le decisioni del
    maintainer D1–D4 del 2 nov 2026;
  - nelle invarianti da riscrivere prima del motore:
    - **§16** «Le bozze di Claude vanno solo in un campo dichiarato della
      pagina aperta (risposta di supporto, note di rilascio, corpo
      dell'email nella propria casella, descrizione di una task), non si
      salvano né si inviano da sole, e il segno resta finché il testo è
      quello di Claude» (accanto a «I campi che un
      client legge su una card di inbox si derivano a lettura»);
    - **§17** «Un'automazione scritta da Claude nasce spenta e senza
      proprietario; la prova di Claude non ha effetti e non approva;
      accendere è un gesto della persona» (con il test sul sorgente
      `neverInCatalog.test.ts`);
    - **§18** «Le risposte sui dati non contano né sommano l'invisibile»:
      la spesa d'istanza solo con `usage.view`, «e altri N» sui soli
      visibili, il motivo di un rifiuto senza nomi invisibili.
- `emptyInstance.test.tsx`: sull'istanza vuota S0 risponde, nessun
  suggerimento compare, S2 dice «No project has stalled tasks».
- Suite, typecheck, lint e build verdi.
- Commit `docs(desktop): note dell'area 10b`.

Dopo il Task 13: revisione finale del branch (area 10b) e revisione visiva
di Impeccable.

---

## Decisioni del maintainer sulle domande del piano (2 nov 2026)

Ognuna è segnata nel testo come *(maintainer, 2 nov 2026, Dn)*.

1. **D1 — i campi delle bozze sono quattro**: risposta di supporto, note
   di rilascio, **corpo dell'email** e **descrizione di una task**. La Chat
   resta esclusa. Posta e Task dichiarano i loro campi col segno «Bozza di
   Claude». Il corpo dell'email resta una bozza: inviare è un gesto della
   persona (classe D). La descrizione scritta nel campo aperto è classe A,
   e diventa una modifica solo quando la persona salva. Global
   Constraints, Review Focus 4, Task 0 (`claude-drafts.md`), Task 1 (la
   task convertita), Task 8, Task 10, Task 13.
2. **D2 — finita la prova, Claude apre da sé il costruttore**, col riquadro
   aperto e «Back to <pagina>». La pagina lasciata ritrova indirizzo e
   scorrimento; i testi non salvati restano dove la pagina li tiene già
   (Supporto, Posta). Task 0 (`claude-automations.md`), Task 5, Task 11.
3. **D3 — il filtro sta sull'inizio**, e la prova (anche a mano) dice
   «Wouldn't start» / «Non partirebbe» quando il filtro non passa. Task 2,
   Task 5, Task 11.
4. **D4 — `member.added`**: «You've been added to ACQ as Developer» / «Sei
   stato aggiunto ad ACQ come Developer». Parte quando una persona
   aggiunge qualcuno e quando lo fa Claude per conto di qualcuno; non
   parte per chi aggiunge sé stesso. En e it, test propri, «Undone by …»
   derivato a lettura. Per il motore è un `notification_kind` nuovo, con la
   sua regola di rollback. Global Constraints, Task 7, Task 13.

Accettate anche le scelte del costruttore del piano. Il «Who?» d'istanza di
S3 si allinea a `whoOf` nel Task 6 stesso (`who:<azione>` senza codice).

## Decisioni del maintainer sugli shape del Task 0 (2 nov 2026)

Il maintainer ha approvato i quattro shape e ha scelto la risposta
consigliata alle quattro domande; ha accettato anche due note del
controller. Ognuna è segnata nel testo come *(maintainer)*.

1. **S0 a nove voci** (shape [SC 5]): `CapabilityId` + `mailBody`,
   `taskDescription`. Task 6, Task 11.
2. **«Non ora» per oggetto** (shape [SG 7]): la chiave del luogo è
   l'oggetto. Task 12.
3. **L'origine resta** (shape [AU 8]): «Created by Claude on behalf of …»
   resta anche dopo l'accensione. Task 11.
4. **«Ask Claude» nel Supporto** (shape [DR 5]): il bottone della barra si
   rinomina. Task 10.
5. **`codes` sulla nota `not_manageable`** (shape [SC 11]): campo
   facoltativo, solo codici visibili. Task 7, Task 11 (il menu dei
   progetti sotto «Who?»).
6. **⌘J resta al riquadro** (shape [DR 14]): Posta e Supporto non lo
   intercettano più, con un test. Task 10.

