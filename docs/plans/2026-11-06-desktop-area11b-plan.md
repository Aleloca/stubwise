# App desktop, area 11b: Claude nella documentazione di prodotto — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere al prototipo `apps/desktop` la metà dell'area 11 che
fa lavorare Claude nella doc di prodotto, sopra il 11a:
- la **regola di Claude** (chiara → modifica, vaga o in contrasto →
  domanda, estranea → niente) sulle quattro fonti (email, riunioni,
  decisioni del registro, lavoro fatto), con i copioni dei dati finti;
- il **segno a margine** sui blocchi cambiati da Claude, con la fonte,
  «Va bene» e «Annulla», e la **cronologia** con «per conto di», la fonte,
  «Annulla» e «Annulla tutto»;
- le **domande di Claude** come commenti con le risposte («Aggiorna così»,
  «Lascia com'è», «Apri una richiesta»), anche in Home «Decidi»;
- i due `notification_kind` **`product_doc.updated`** e
  **`product_doc.question`**;
- la **prima versione** scritta da Claude dalle fonti scelte, con
  l'avanzamento, la riga in cima alle pagine e «Annulla» tutto insieme;
- le **voci di backlog proposte** da una pagina o da una fase, col legame
  «Dalla doc: <pagina>»;
- le **bozze di schermata** (blocco `wireframe`);
- le **voci del riquadro di Claude** e la doc di prodotto nelle risposte;
- la **coda del budget** per gli aggiornamenti automatici;
- §21 nelle invarianti, i dati finti, la parità.

**Architecture:**
- **Nessun modello, solo copioni.** Il prototipo non «legge» le fonti: per
  ogni fonte il seme dice quali **fatti** contiene (`ProductFact`, con la
  frase nuova, il blocco toccato e se la fonte lo dice chiaramente). La
  regola che decide cosa farne è **pura** (`decideFact` in
  `domain/productDocs/claudeRule.ts`) ed è il cuore dell'anti-obiettivo
  «decisioni inventate»: è testata da sola, a tappeto.
- **Una sola strada di scrittura, quella del 11a.** Ogni modifica di Claude
  passa da `writeProductBlocksAs(actorId, pageId, ops, { via: "claude",
  source, groupId, kind })`. Il segno, la cronologia e «Annulla» leggono le
  revisioni; il segno si salva come riga (`state.productMarks`) solo per
  ricordare «Va bene».
- **Si deriva a lettura.** Se il segno si vede, se «Annulla» è acceso, chi
  ha toccato il blocco dopo, come si dice la fonte a chi guarda (R-G5 e
  decisione 1), titolo e corpo delle due card: tutto si calcola in lettura
  dal livello dati. La pagina non ricalcola niente.
- **Il motore aspetta chi scrive.** Prima di scrivere in una sezione,
  `applyProductFacts` chiede `writersNear`; se c'è qualcuno, l'aggiornamento
  resta in attesa (`state.productPending`) e riparte su `onProductPresence`.
  Le domande partono subito.
- **Budget e pausa con la coda dell'area 9b.** Se `aiBlockFor(projectId)`
  dice di aspettare, la fonte entra in `holdJob` con un `JobKind` nuovo
  (`product_doc_update`); al rilascio le fonti si elaborano in ordine
  d'arrivo e gli avvisi si raccolgono per pagina.

**Tech Stack:** quello delle aree 1–11a. **Nessuna dipendenza nuova.**

**Spec:** `docs/plans/2026-11-05-desktop-area11-product-docs-design.md`
(approvato il 5 nov 2026); la sezione «Decisioni dopo la lettura del
costruttore (5 nov 2026)» prevale. Il 11b copre tutto ciò che il piano 11a
lasciava fuori (vedi il suo «Goal»). Le interfacce del 11a che il 11b usa
sono elencate in «Cosa il piano 11b consuma» di
`docs/plans/2026-11-05-desktop-area11a-plan.md`, e non cambiano.

Contesto da leggere (percorsi relativi a `apps/desktop/src/renderer/`):
- `docs/plans/2026-11-05-desktop-area11a-plan.md` (Global Constraints,
  «Cosa il piano 11b consuma»), `apps/desktop/docs/area11-parity.md`,
  `apps/desktop/docs/ossatura-follow-ups.md` (§5, §10, §12, §13, §16, §19,
  la nota su §21, «Area 11a — minori aperti»);
- 11a: `data/productDocs/{reads,writes,revisions,comments,follows,presence,events}.ts`,
  `domain/productDocs/{blocks,richText,shortcuts,exportModel}.ts`,
  `data/seed/productDocs/{acq,index,presence}.ts`,
  `pages/productDocs/{ProductIndex,ProductSpace,HistoryPanel,SideColumn,BlockBody}.tsx`
  e `pages/productDocs/comments/*`;
- area 10: `data/claude/{types,catalog,catalogMore,classes,actions,via,drafts}.ts`,
  `domain/claude/{intents,answers,context}.ts`,
  `domain/claude/intents/{general,howto,archive}.ts`,
  `pages/claude/conversation/{ProposalCard,ExecutedRow,UndoControl,CapabilitiesList,BudgetBand}.tsx`,
  `tasks-ui/ClaudeDraftMark.tsx` (solo da leggere: non cambia);
- Home «Decidi»: `data/types.ts` (`ClaudeDecision`),
  `pages/home/blocks/ClaudeDecisionItem.tsx`;
- budget e coda: `data/instance/{blocks,queue,budget}.ts`;
- posta, calendario, registro, rilasci: `data/mail/{visibility,writes,transcripts}.ts`,
  `data/calendar/{visibility,writes}.ts`, `data/seed/mail/incoming.ts`,
  `data/releases/{reads,simulate}.ts`, `listDecisionLog` in `data/api.ts`;
- richieste e task: `data/api-mutations.ts` (`NewRequestInput`,
  `createRequestAs`), `pages/task/LinksSection.tsx`;
- `data/viewer.ts` (`CLAUDE_PROJECT_PERMISSIONS`: ha già `docs.edit`),
  `data/seed/people.ts` (`CLAUDE_ID`), `data/seed/notifications.ts`
  (`LOCAL_NOTIFICATION_KINDS`), `notifications/NotificationItem.tsx`
  (`composedOf`).

## Global Constraints

- **Valgono tutte le Global Constraints del piano 11a**, così come sono
  scritte lì (nessuna rete né modello; en/it; temi; pagine solo via
  `data/queries*`; stati completi; un solo `now()`; `nextSeq()` per ogni
  prima/dopo; R-G5 con test in minuscolo; campi nuovi facoltativi;
  Impeccable; ciclo TDD; comandi; scatti; commit e trailer). Gli scatti di
  quest'area hanno il prefisso `a11b-`.
- **Le lezioni vincolanti** del 11a valgono uguali: bottone spento con la
  sua frase e, per un permesso, il `WhoCanLink`; niente `can()` in
  `pages/productDocs/` (il test sul sorgente del 11a resta verde); a 1024 il
  layout segue lo shape; la UI non afferma ciò che il dato non dimostra; il
  fuoco non finisce mai sul body; un doppio clic non fa due scritture;
  scatti rifatti dopo ogni correzione visiva.
- **Decisioni inventate (anti-obiettivo del maintainer).** Una modifica
  entra da sola **solo** se il fatto è `clarity: "clear"`, non contraddice
  un blocco scritto da una persona, e chi agisce ha `docs.edit`. In ogni
  altro caso è una domanda o niente. Claude non scrive mai «deciso» per
  conto suo: il testo che entra è quello del fatto, parola per parola.
- **Claude non scrive mai nel registro decisioni partendo dalla doc**
  (anti-obiettivo della spec). Nessun modulo nuovo del 11b chiama
  `recordDecision` né scrive `state.decisionLog`: test sul sorgente nel
  Task 1, accanto a `neverInCatalog.test.ts`.
- **Chi agisce** (decisione 2):
  - email: il titolare è chi ha scelto il progetto
    (`MailProposal.projectChosenById`) se c'è, altrimenti il primo dei
    `mailboxPersonIds` che è membro del progetto;
  - riunione: l'organizzatore (`CalendarAttendee.organizer`);
  - decisione del registro, task chiusa, rilascio: `CLAUDE_ID`;
  - `actorId` = il titolare, `via: "claude"`; se il titolare non ha
    `docs.edit` nel progetto, il fatto diventa una domanda.
- **La fonte vista da chi legge** (decisione 1 e R-G5), una sola funzione,
  `sourceViewOf(me, ref)`, usata da segno, cronologia, card, Home, riga
  della prima versione e risposte del riquadro:
  - email che chi guarda può aprire (`canSeeMessage`): l'oggetto e il link;
  - email che non può aprire: «From an email of <titolare> · <data>» /
    «Da un'email di <titolare> · <data>», **senza** link, oggetto né testo;
  - riunione: lo stesso schema con `canSee…` del calendario e
    l'organizzatore («From a meeting of …» / «Da una riunione di …»);
  - decisione, task, rilascio: il `CodeLink` (codice tenue se invisibile);
  - fonte che non esiste più (email tolta dallo stato, riunione cancellata):
    «Source no longer available» / «Fonte non più disponibile», e «Annulla»
    resta.
  Il titolare si nomina sempre (è un membro del progetto); il testo
  dell'email mai, in nessuna superficie.
- **Classi del riquadro** (decisione 3 e spec «Claude nel riquadro»):
  - «scrivi la prima versione» e «disegna questa schermata» sono **A**
    con «Undo» (non avvisano nessuno: chi crea segue);
  - «aggiorna la pagina da questa email o riunione» è **B**, perché avvisa
    chi segue: un `case` nuovo in `dataReasons` (`classes.ts`) con la
    ragione `notifies`, test in `classes.test.ts`;
  - «proponi le voci di backlog» è la scheda in blocco (B) di
    `createRequest`;
  - «cosa è cambiato nella doc questa settimana» è una lettura.
  Nessuna B diventa A: la classe si calcola come oggi (`classOf` sale e
  non scende).
- **Il segno** (spec «Il segno», decisioni 4, 5, 9):
  - si vede su un blocco se esiste una revisione `via: "claude"` (non
    `first_version`, non `answer`) che lo cambia, il blocco non è stato
    toccato dopo (`touchedAfter`) e nessuno ha premuto «Va bene»;
  - «Va bene» e «Annulla» chiedono `docs.edit`; «Va bene» toglie il segno ma
    lascia «Annulla» in cronologia;
  - «Annulla» è acceso finché il blocco non è toccato da altri; dopo è
    spento con la frase e il «Who?» («Marco Bellini edited it afterwards» /
    «Marco Bellini l'ha modificata dopo»);
  - un'unione porta il segno sul blocco unito (`onAnchorsMerged`);
  - componente nuovo `ProductClaudeMark`: riusa l'aspetto e la riga «Used: …»
    di `ClaudeDraftMark`, che **non cambia** (né il file né i suoi test).
- **Notifiche nuove** (spec «Avvisi», decisione 10): `product_doc.updated`
  (una card per fonte; dopo un rilascio della coda, una card per pagina con
  più fonti) e `product_doc.question`. Destinatari:
  `productDocRecipients(pageId)` del 11a. Titolo e corpo si compongono a
  lettura (come `product_doc.mention`), con `objectGone` se la pagina non si
  vede più. Vanno in `LOCAL_NOTIFICATION_KINDS`, non in
  `DECISION_NOTIFICATION_KINDS`. Parità: rollback e cambi additivi (§5).
- **Le domande** *(maintainer, 6 nov 2026, Q1)*: si risponde **nel
  commento** della pagina e **in Home «Decidi»** (una `ClaudeDecision` di
  tipo nuovo). La notifica `product_doc.question` avvisa e porta al filo;
  non ha bottoni. Una domanda ha una sola risposta: il secondo clic, o la
  seconda persona, riceve `alreadyAnswered`.
- **Il budget** (decisione 10, area 9b §10): con `aiBlockFor(projectId)`
  non nullo, le fonti automatiche aspettano in `holdJob`; si rilasciano con
  `releaseBudgetHolds` in ordine d'arrivo. La prima versione e i gesti del
  riquadro non passano dalla coda: col budget finito sono spenti con la
  frase del riquadro di oggi (`BudgetBand`).
- **I campi nuovi sono facoltativi** e le fixture che li leggono restano
  senza almeno una volta: `ProductComment.question`,
  `ProjectRequest.origin` col ramo `product_doc`, `AppNotification.productUpdate`,
  `AppNotification.productQuestion`, il blocco `wireframe`.

## Review Focus

1. **Un fatto vago dentro un'email chiara.** L'email dice «Confermiamo: login
   solo con Google. Forse più avanti anche Apple». Ci si aspetta una
   modifica per la prima frase e una **domanda** per la seconda, mai la
   seconda scritta nel testo. → Task 1 (`decideFact`), Task 2.
2. **Claude aspetta, poi la frase è cambiata.** Marco scrive nella sezione;
   arriva un fatto chiaro per un blocco di quella sezione. Ci si aspetta
   che Claude aspetti; se intanto Marco riscrive proprio quel blocco,
   all'uscita il fatto **non sovrascrive**: diventa una domanda, perché ora
   contraddice testo scritto da una persona. → Task 2.
3. **La fonte per chi non è destinatario.** Sara non ha ricevuto l'email.
   Sul segno, in cronologia, nella card e in Home legge «Da un'email di
   Laura Conti · 4 nov», senza oggetto, senza link, e nessuna parola
   dell'email in nessun nodo del DOM. → Task 1, Task 9, Task 10.
4. **«Annulla» dopo che altri hanno toccato.** Una modifica su tre blocchi;
   Marco ne tocca uno. «Annulla» di quel blocco è spento col «Who?» di
   Marco; gli altri due si annullano uno per uno; «Annulla tutto» è spento
   con la stessa frase. Un blocco cancellato e rimesso con l'«Annulla» della
   cancellazione torna con lo stesso id e il suo segno. → Task 3.
5. **Il budget torna con tre fonti per la stessa pagina.** Due email e una
   task chiusa aspettano; nel frattempo una delle email sparisce. Al
   rilascio: le due fonti rimaste in ordine d'arrivo, una sola card per
   la pagina con due fonti, la fonte sparita non fa niente e non lancia. →
   Task 2, Task 5.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer **prima del Task 1**, in
`apps/desktop/.impeccable/shape/`. Nessun codice. Partono dagli shape del
11a (`product-space.md`, `product-editor.md`,
`product-comments-history.md`) e da `claude-drafts.md`, `claude-trace.md`,
`claude-actions.md`, `claude-panel.md`, `home.md`, e non li riscrivono. Le
domande al maintainer le pone il controller (`AskUserQuestion`, la risposta
consigliata per prima); le risposte si scrivono in «Decisioni del
maintainer sugli shape del Task 0».

- **`product-claude-mark.md`** (segno, cronologia, avvisi):
  - il segno a margine: dove sta rispetto al blocco, alla maniglia ⋮⋮ e
    alla colonna dei commenti; chiuso (un tratto) e aperto (etichetta
    «Updated by Claude» / «Aggiornato da Claude», «on behalf of Laura
    Conti», la fonte, «Looks good» / «Va bene», «Undo» / «Annulla»);
  - la fonte nelle sue cinque forme (email aperta, email di un altro,
    riunione, codice, non più disponibile);
  - «Annulla» spento col «Who?»; un gruppo su più blocchi;
  - la cronologia: la riga di Claude («Claude, on behalf of Laura Conti ·
    from an email»), «Undo all», la riga «Undone by …», la riga «Laura,
    from Claude's question», la prima versione;
  - le due card in inbox (`product_doc.updated`, anche quella per pagina
    con più fonti; `product_doc.question`);
  - 1024: il segno aperto con la colonna sovrapposta.
- **`product-claude-questions.md`** (domande e prima versione):
  - il filo-domanda nella colonna: autore Claude, la fonte, la frase
    proposta (per «Aggiorna così» il prima e dopo), i bottoni, lo stato
    risposto; la divergenza da una task chiusa;
  - la domanda in Home «Decidi» accanto a quelle dei task;
  - lo spazio vuoto con le due strade, «Write the first version with
    Claude» per prima;
  - la finestra delle fonti: email e riunioni del progetto che chi chiede
    vede, testo incollato, file del Drive; nessuna fonte → bottone spento
    con la frase;
  - l'avanzamento per pagina mentre Claude scrive;
  - la riga in cima a ogni pagina («First version written by Claude from:
    …», «Accept» / «Accetta», «Undo the first version» / «Annulla la prima
    versione» e la sua conferma), spenta col «Who?» dopo un tocco;
  - «N questions to close» nel riquadro di Claude;
  - la riga del budget e della pausa in cima allo spazio.
- **`product-claude-backlog.md`** (backlog e bozze di schermata):
  - il gesto «Propose backlog items» / «Proponi le voci di backlog» nella
    barra della pagina («⋯») e su un titolo di fase;
  - la scheda in blocco nel riquadro (quella di oggi), con la frase della
    pagina in ogni voce e le note («already proposed»);
  - «From the doc: <page>» / «Dalla doc: <pagina>» su richiesta, ticket e
    task; le voci collegate in fondo alla pagina;
  - il blocco bozza di schermata: fil di ferro in bianco e nero,
    etichetta «Claude's draft» / «Bozza di Claude», «Redraw» / «Rifai»,
    «Replace with an image» / «Sostituisci con un'immagine», nel menu «/»
    («Screen sketch» / «Bozza di schermata») e «Draw this screen» /
    «Disegna questa schermata» in «⋯».

### Task 1: §21, i tipi, la regola pura e la fonte vista da chi legge

**Files:**
- Modify: `apps/desktop/docs/ossatura-follow-ups.md` (scrive §21, sostituisce
  la nota «rimandata al 11b»)
- Modify: `data/model.ts`
- Create: `domain/productDocs/claudeRule.ts`, `data/productDocs/sources.ts`
- Test: `domain/productDocs/claudeRule.test.ts`,
  `data/productDocs/sources.test.ts`,
  `data/productDocs/neverWritesDecisions.test.ts`

**Interfaces:**
- Consumes: `ProductSourceRef`, `ProductBlock`, `RichText`, `anchorText`,
  `listProductRevisions` (11a); `canSeeMessage`, `stubwiseRecipients`
  (`data/mail/visibility.ts`); la visibilità del calendario
  (`data/calendar/visibility.ts`); `CLAUDE_ID`.
- Produces (in `data/model.ts`):
  - `ProductFact = { id: string; pageId: string; anchorId: string | null;
    change: { kind: "replace"; text: RichText } | { kind: "insert_after";
    block: ProductBlock } | { kind: "link_task"; taskCode: string } |
    { kind: "diverges"; built: string }; clarity: "clear" | "vague";
    contradicts?: boolean; options?: { apply?: RichText; request?: { title:
    string; description: string } } }`
  - `ProductFactDecision = { kind: "edit" } | { kind: "question"; reason:
    "vague" | "contradicts_person" | "contradicts" | "diverges" |
    "no_permission" } | { kind: "none" }`
  - `ProductSourceView = { kind: ProductSourceRef["kind"]; label: Utterance;
    code: string | null; link: string | null; ownerId: string | null; at:
    string | null; gone: boolean }`
  - `ProductMark = { id: string; pageId: string; anchorId: string;
    revisionId: string; acceptedById: string | null; acceptedSeq: number |
    null }` e `State.productMarks: ProductMark[]`
- Produces (funzioni):
  - `decideFact(fact: ProductFact, ctx: { lastWriterIsPerson: boolean;
    actorCanEdit: boolean }): ProductFactDecision` (pura)
  - `sourceOwnerOf(ref: ProductSourceRef, projectId: string): string` —
    la regola di «Chi agisce» delle Global Constraints
  - `sourceViewOf(me: string, ref: ProductSourceRef): ProductSourceView`

- [ ] **Step 1: §21** in `ossatura-follow-ups.md`, fra le invarianti da
  riscrivere prima del motore, accanto a `mailbox_owner`: «Email e riunioni
  attribuite al progetto aggiornano la doc di prodotto senza il consenso
  di chi le ha ricevute (decisione del maintainer, 5 nov 2026): il segno
  nomina la fonte a tutto il progetto; a chi non può aprirla dice "da
  un'email di <titolare> · <data>", senza link, oggetto né testo;
  `mailbox_owner` resta valida per l'email stessa». Togli la nota «rimandata
  al 11b» e la riga gemella in fondo al file.
- [ ] **Step 2: test di `decideFact`** (`claudeRule.test.ts`), uno per
  riga:
  - chiaro, nessun contrasto, permesso → `edit`;
  - vago → `question` / `vague`, anche con permesso e senza contrasto;
  - chiaro con `contradicts: true` → `question` / `contradicts`;
  - chiaro su un blocco scritto da una persona e `contradicts: true` →
    `contradicts_person`;
  - chiaro senza permesso del titolare → `no_permission`;
  - `diverges` → sempre `question` / `diverges`, anche chiaro;
  - `link_task` (il lavoro coincide) → `edit` (aggiunge il solo link);
  - nessun `change` applicabile (blocco `anchorId` assente su `replace`) →
    `none`;
  - l'esempio del Review Focus 1, come due fatti della stessa email:
    il primo `edit`, il secondo `question`.
- [ ] **Step 3: test di `sourceViewOf`** (`sources.test.ts`) sul seme, in
  minuscolo: Laura destinataria vede l'oggetto e il link; Sara no:
  «da un'email di laura conti», nessun oggetto, `link: null`, e nessuna
  parola dell'oggetto nell'`Utterance` composta; la riunione allo stesso
  modo con l'organizzatore; un codice invisibile dà `code` col codice e
  nessun titolo; un'email tolta dallo stato dà `gone: true` e «source no
  longer available»; `sourceOwnerOf` sceglie `projectChosenById` prima di
  `mailboxPersonIds`, e `CLAUDE_ID` per decisione, task e rilascio.
- [ ] **Step 4: test sul sorgente** (`neverWritesDecisions.test.ts`):
  nessun file di `data/productDocs/` né `domain/productDocs/` nomina
  `recordDecision`, `decisionLog.push` o `state.decisionLog =`.
- [ ] **Step 5:** vedili fallire, implementa le firme, vedili passare.
- [ ] **Step 6:** suite, typecheck, lint; commit
  `feat(desktop): la regola di Claude e la fonte vista da chi legge`.

### Task 2: Il motore degli aggiornamenti

**Files:**
- Create: `data/productDocs/claude.ts`
- Modify: `data/instance/queue.ts` (`JobKind` + `product_doc_update`),
  `data/model.ts` (`AppNotification.productUpdate?`, `State.productPending`),
  `data/seed/notifications.ts` (`LOCAL_NOTIFICATION_KINDS`)
- Test: `data/productDocs/claude.test.ts`

**Interfaces:**
- Consumes: Task 1; `writeProductBlocksAs`, `touchedAfter`,
  `listProductRevisions`, `writersNear`, `onProductPresence`, `sectionOf`,
  `productDocRecipients` (11a); `can`; `aiBlockFor`, `holdJob`,
  `releaseBudgetHolds`; `nextSeq`, `newId`.
- Produces:
  - `applyProductSource(ref: ProductSourceRef, projectId: string, facts:
    readonly ProductFact[]): ProductSourceOutcome` dove
    `ProductSourceOutcome = { held: boolean; edits: string[]; questions:
    string[]; pending: string[]; none: number }` (id di revisioni, di
    commenti-domanda e di fatti in attesa)
  - `AppNotification.productUpdate?: { pageId: string; revisionIds:
    string[]; sources: ProductSourceRef[] }`
  - `askProductQuestion(pageId, anchorId, fact, ref, reason): string` (id
    del commento; la usa anche il Task 4 per la forma del filo)
  - `whenProductClaudeIdle(): Promise<void>` per i test

- [ ] **Step 1: test** (`claude.test.ts`), sul seme di ACQ con fatti
  costruiti nel test:
  - un fatto chiaro su un blocco: una revisione con `via: "claude"`,
    `actorId` = il titolare, `source` = la fonte, un `groupId`; il testo del
    blocco è esattamente quello del fatto, segni compresi;
  - tre fatti chiari della stessa fonte su tre blocchi: **una** revisione
    con tre `changes` e un `groupId`, e **una** card
    `product_doc.updated` per i destinatari;
  - un fatto vago: nessuna revisione, un commento-domanda di `CLAUDE_ID`
    sull'ancora, una card `product_doc.question`;
  - il titolare senza `docs.edit`: domanda, nessuna revisione;
  - Review Focus 2: Marco presente nella sezione (`writersNear`) → nessuna
    revisione, `pending` col fatto; Marco riscrive quel blocco ed esce → il
    fatto (con `contradicts: true`) diventa una domanda
    `contradicts_person`, il testo di Marco resta; senza riscrittura → la
    revisione parte all'uscita (`onProductPresence`);
  - la domanda parte subito anche con Marco nella sezione;
  - budget finito (`simulateBudgetReached`): `held: true`, nessuna
    scrittura, un `heldJobs()` di tipo `product_doc_update`; tre fonti in
    attesa sulla stessa pagina, una tolta dallo stato prima del rilascio,
    poi `releaseBudgetHolds()`: due revisioni in ordine d'arrivo (`seq`
    crescente), **una** card per la pagina con `sources.length === 2`,
    nessuna eccezione (Review Focus 5);
  - una pagina eliminata o il modulo spento prima del rilascio: il fatto
    non fa niente;
  - nessuna card per chi non vede più la pagina; Claude non è mai
    destinatario.
- [ ] **Step 2:** vedili fallire.
- [ ] **Step 3: implementa** `applyProductSource`: per ogni fatto,
  `decideFact` con `lastWriterIsPerson` dall'ultima revisione del blocco
  (`via` assente) e `actorCanEdit` da `can(owner, "docs.edit", project)`;
  raggruppa gli `edit` per pagina in una scrittura con un `groupId`; i fatti
  in una sezione occupata vanno in `state.productPending` e si ritentano
  su `onProductPresence` (rivalutando `decideFact`); la card si pubblica
  dopo la scrittura. Col blocco del budget o della pausa, `holdJob` con
  `start` che rientra in `applyProductSource`; le card dei lavori rilasciati
  nello stesso giro si raccolgono per pagina (un microtask di raccolta).
- [ ] **Step 4:** vedili passare; suite, typecheck, lint; commit
  `feat(desktop): Claude aggiorna la doc di prodotto dalle fonti`.

### Task 3: Il segno, «Va bene», «Annulla» e la cronologia (dati)

**Files:**
- Create: `data/productDocs/marks.ts`
- Modify: `data/productDocs/revisions.ts` (la vista della riga di
  cronologia), `data/queries/*` per le letture nuove, `data/api.ts` (`gate`)
- Test: `data/productDocs/marks.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2; `touchedAfter`, `onAnchorsMerged`,
  `writeProductBlocksAs` (con `kind: "undo"`, `undoOf`).
- Produces:
  - `listProductMarks(me, pageId): ProductMarkView[]` con `ProductMarkView =
    { anchorId; revisionId; groupId; actorId; source: ProductSourceView;
    canAccept: boolean; undo: ProductUndoView }`
  - `ProductUndoView = { enabled: true } | { enabled: false; reason:
    "changed_after" | "no_permission" | "already_undone"; byId: string |
    null }`
  - `acceptProductMarkAs(me, pageId, anchorId): void`
  - `undoProductChangeAs(me, revisionId, anchorId?: string): { revisionId:
    string }` (senza `anchorId`: «Annulla tutto»); lancia `refused` con la
    ragione
  - `ProductRevisionView` (la riga di cronologia del 11a) guadagna `via?`,
    `onBehalfOfId?`, `source?: ProductSourceView`, `undo?:
    ProductUndoView`, `undoneById?`, `answerOf?: string` (id del filo)

- [ ] **Step 1: test** (`marks.test.ts`):
  - dopo una modifica di Claude su tre blocchi, tre segni; «Va bene» su uno
    lo toglie a tutti quelli che guardano e lascia «Annulla» acceso in
    cronologia;
  - una modifica a mano del blocco toglie il segno senza «Va bene»;
  - Review Focus 4: Marco tocca un blocco → l'`undo` di quel blocco è
    `changed_after` con `byId` Marco, «Annulla tutto» pure; gli altri due si
    annullano uno per uno e tornano al `before` intero, segni compresi; la
    riga «Undone by» porta `undoOf`;
  - un secondo «Annulla» della stessa cosa → `already_undone`, nessuna
    scrittura (doppio clic);
  - Sara senza `docs.edit`: `canAccept: false` e `undo` `no_permission`
    con `byId: null`;
  - un'unione porta il segno sul blocco unito; una cancellazione
    del blocco lo toglie, l'«Annulla» della cancellazione lo rimette;
  - le revisioni `first_version` e `answer` non hanno segno;
  - la riga di cronologia di una modifica di Claude ha `onBehalfOfId` = il
    titolare (assente per `CLAUDE_ID`) e la fonte vista da chi guarda.
- [ ] **Step 2:** vedili fallire; implementa; vedili passare.
- [ ] **Step 3:** suite, typecheck, lint; commit
  `feat(desktop): il segno di Claude e il suo Annulla`.

### Task 4: Le domande di Claude (dati) e Home «Decidi»

**Files:**
- Modify: `data/model.ts` (`ProductComment.question?`,
  `AppNotification.productQuestion?`), `data/types.ts` (`ClaudeDecision`
  col ramo `productQuestion`), `data/productDocs/comments.ts`,
  il lettore di «Decidi», `data/api-mutations.ts` (`NewRequestInput.origin`
  col ramo `product_doc`), `data/model.ts` (`ProjectRequest.origin`)
- Test: `data/productDocs/questions.test.ts`

**Interfaces:**
- Consumes: Task 2 (`askProductQuestion`); `listProductComments`;
  `createRequestAs`.
- Produces:
  - `ProductComment.question?: { sourceRef: ProductSourceRef; reason:
    ProductFactDecision["reason"]; forId: string | null; apply: RichText |
    null; request: { title: string; description: string } | null; answer:
    { byId: string; option: "apply" | "keep" | "request"; seq: number } |
    null }`
  - `answerProductQuestionAs(me, commentId, option: "apply" | "keep"):
    void` (lancia `alreadyAnswered`, `changed_after`, `forbidden`)
  - `productQuestionRequestDraft(me, commentId): ProposedAction[]` — una
    `createRequest` con `origin: { kind: "product_doc"; pageId; anchorId;
    questionId }`, da aprire come scheda B del riquadro
  - `ProjectRequest.origin` e `NewRequestInput.origin` accettano
    `{ kind: "product_doc"; pageId: string; anchorId: string | null;
    questionId?: string }`; `createRequestAs` con `questionId` chiude la
    domanda (`option: "request"`) nella stessa scrittura
  - `ClaudeDecision` col ramo `{ kind: "productQuestion"; commentId; pageId;
    pageCode; quote; options: ("apply" | "keep" | "request")[] }`, letto per
    chi riceve la domanda (`productDocRecipients`) e vede la pagina

- [ ] **Step 1: test** (`questions.test.ts`):
  - «Aggiorna così»: una revisione `kind: "answer"` con `actorId` chi
    risponde e **senza** `via`, nessun segno; il filo è risolto con la
    risposta; la domanda sparisce da «Decidi»;
  - un secondo clic, o Marco dopo Laura → `alreadyAnswered`, nessuna
    seconda revisione;
  - il blocco toccato dopo la domanda → «Aggiorna così» `changed_after`, la
    domanda resta aperta, «Lascia com'è» resta possibile;
  - «Lascia com'è»: chiude senza revisioni;
  - «Apri una richiesta»: la bozza ha `origin.product_doc` col
    `questionId`; confermarla crea la richiesta e chiude la domanda; senza
    il permesso del backlog la scheda è B col blocco di oggi; annullata, la
    domanda resta aperta;
  - Sara senza `docs.edit`: `forbidden`, e in «Decidi» non c'è;
  - una domanda la cui pagina non si vede più non compare in «Decidi» né
    in inbox (`objectGone`).
- [ ] **Step 2:** vedili fallire; implementa; vedili passare.
- [ ] **Step 3:** suite, typecheck, lint; commit
  `feat(desktop): le domande di Claude sulla doc di prodotto`.

### Task 5: Le fonti che arrivano e il seme del 11b per ACQ

**Files:**
- Create: `data/productDocs/sourceEvents.ts`,
  `data/seed/productDocs/facts.ts`, `data/seed/productDocs/acq11b.ts`
- Modify: i punti in cui arriva una fonte: `data/mail/writes.ts`
  (`advanceSync` e l'attribuzione a mano), il pronto della trascrizione
  (`data/mail/transcripts.ts`), la registrazione di una decisione, la
  chiusura di una task, `data/releases/simulate.ts`; `data/store.ts` (il
  seme); `data/seed/productDocs/index.ts`
- Test: `data/productDocs/sourceEvents.test.ts`, `data/seed/seed.11b.test.ts`

**Interfaces:**
- Consumes: Task 2 (`applyProductSource`).
- Produces:
  - `PRODUCT_SOURCE_FACTS: Record<string, readonly ProductFact[]>` con
    chiave `<kind>:<id>` (seme)
  - `noteProductSource(ref: ProductSourceRef, projectIds: readonly
    string[]): void` — chiamata dai punti d'arrivo; per un progetto senza
    spazio Prodotto, o una fonte senza fatti, non fa niente

- [ ] **Step 1: test** (`sourceEvents.test.ts`): l'email in arrivo del
  seme (`INCOMING_MESSAGE_ID`), attribuita ad ACQ, porta il suo fatto
  chiaro (una revisione); l'attribuzione a mano di un'email incerta passa
  da `noteProductSource` una volta sola; la trascrizione pronta di una
  riunione porta un fatto vago (una domanda); registrare la decisione
  preparata nel seme porta una modifica di `CLAUDE_ID` con la decisione
  come fonte; chiudere la task preparata (costruita diversa) porta una
  domanda `diverges`; il rilascio simulato porta un `link_task`; la stessa
  fonte arrivata due volte non scrive due volte.
- [ ] **Step 2: il seme di ACQ** (`acq11b.ts`, spec «Dati finti»), scritto
  come stato già accaduto (revisioni, segni, commenti, notifiche):
  - Sign-in: una modifica di Claude da un'email di Laura («login solo con
    Google»), segnata, con la card `product_doc.updated`; Sara non è
    destinataria;
  - Bills: una domanda nata da una riunione (vaga), aperta, in «Decidi» di
    Laura;
  - Meter reading: una divergenza da una task chiusa, aperta;
  - Client decisions: una modifica da una decisione del registro, già
    accettata («Va bene»);
  - Fault reports: un segno la cui email non c'è più («Fonte non più
    disponibile»);
  - due richieste con `origin.product_doc` da Phases e una task nata da una
    di esse.
- [ ] **Step 3: test del seme** (`seed.11b.test.ts`): i casi qui sopra si
  leggono con le funzioni dei Task 1–4; i codici e gli id non collidono
  con il 11a; i fatti dei copioni coprono le tre uscite della regola.
- [ ] **Step 4:** vedili fallire; implementa; vedili passare; suite,
  typecheck, lint; commit `feat(desktop): le fonti della doc di prodotto e
  il seme del 11b`.

### Task 6: La prima versione (dati) e la bozza di VRD

**Files:**
- Create: `data/productDocs/firstVersion.ts`,
  `data/seed/productDocs/vrdFirstVersion.ts`
- Modify: `data/model.ts` (`State.productFirstVersions`)
- Test: `data/productDocs/firstVersion.test.ts`

**Interfaces:**
- Consumes: `createProductPageAs`, `writeProductBlocksAs` (con `kind:
  "first_version"`, `source: { kind: "first_version"; ids }`),
  `askProductQuestion`, `streamDelay`, `storeGeneration`, `aiBlockFor`.
- Produces:
  - `FirstVersionSource = { kind: "email"; id } | { kind: "meeting"; id } |
    { kind: "text"; text: string } | { kind: "drive"; fileId: string }`
  - `firstVersionSourcesFor(me, projectId): { emails; meetings; files }` —
    solo ciò che `me` vede nel progetto
  - `startFirstVersionAs(me, projectId, sources: readonly
    FirstVersionSource[]): { groupId: string }` (lancia `space_not_empty`,
    `no_sources`, `ai_blocked`, `forbidden`)
  - `ProductFirstVersion = { projectId; groupId; byId; status: "writing" |
    "done" | "undone"; pagesDone: number; pagesTotal: number; sources:
    ProductSourceRef[]; acceptedPageIds: string[] }` e la lettura
    `productFirstVersionOf(me, projectId)` con `undo: ProductUndoView`
  - `acceptFirstVersionPageAs(me, pageId)`, `undoFirstVersionAs(me,
    projectId)`
  - `openProductQuestions(me, projectId): { count; items: { commentId;
    pageCode; quote }[] }` (per «N domande da chiudere»)

- [ ] **Step 1: test** (`firstVersion.test.ts`):
  - VRD vuoto, Laura con un'email e il testo incollato: l'albero della
    bozza nasce pagina per pagina (`pagesDone` sale fino a `pagesTotal`), ogni
    pagina con revisione `first_version`, `via: "claude"`, `actorId` Laura,
    e Laura segue ogni pagina;
  - le pagine non hanno segni; ogni pagina ha la riga della prima versione
    finché Laura non l'accetta (`acceptedPageIds`);
  - le domande della bozza sono commenti-domanda e `openProductQuestions`
    le conta;
  - «Annulla la prima versione» toglie tutte le pagine (i codici non si
    riusano) finché nessuno ne ha toccata una; dopo un tocco di Marco è
    spento col suo «Who?»;
  - Sara (solo lettura): `forbidden`; uno spazio non vuoto:
    `space_not_empty`; nessuna fonte: `no_sources`; budget finito:
    `ai_blocked`, niente scritto;
  - un'email che chi chiede non vede non è fra le fonti possibili;
  - il seme di un progetto senza bozza preparata: la bozza generica
    (Panoramica, Funzionalità, Schermate, Decisioni con il cliente, Fasi)
    con le frasi che citano le fonti scelte;
  - la pagina eliminata o la generazione dello store cambiata a metà: il
    copione si ferma senza eccezioni.
- [ ] **Step 2: la bozza di VRD** (`vrdFirstVersion.ts`, spec «Dati
  finti»): una decina di pagine, tre domande aperte, una bozza di schermata
  (Task 7), due immagini (import `?inline`), un file del Drive del progetto.
  VRD resta **vuoto** nel seme *(maintainer, 6 nov 2026, Q2)*: la prima
  versione la lancia chi prova l'app.
- [ ] **Step 3:** vedili fallire; implementa; vedili passare; suite,
  typecheck, lint; commit `feat(desktop): la prima versione di Claude`.

### Task 7: Le voci di backlog da una pagina e le bozze di schermata (dati)

**Files:**
- Create: `data/productDocs/backlog.ts`, `data/productDocs/wireframes.ts`,
  `data/seed/productDocs/wireframes.ts`
- Modify: `data/model.ts` (blocco `wireframe`), `domain/productDocs/blocks.ts`,
  `domain/productDocs/shortcuts.ts` (`SLASH_ITEMS` + `wireframe` nel gruppo
  `insert`), `domain/productDocs/exportModel.ts`,
  `data/productDocs/writes.ts` (validazione del blocco)
- Test: `data/productDocs/backlog.test.ts`,
  `data/productDocs/wireframes.test.ts`, `domain/productDocs/exportModel.test.ts`

**Interfaces:**
- Produces:
  - `backlogCandidatesOf(blocks: readonly ProductBlock[], fromAnchorId:
    string | null): { anchorId: string; title: string; description:
    string }[]` (pura: voci di elenco e liste di controllo della pagina, o
    della sola sezione di `fromAnchorId`; il titolo è la frase, la
    descrizione cita la frase e il titolo della sezione)
  - `proposeBacklogFromPage(me, pageId, fromAnchorId?): { actions:
    ProposedAction[]; notes: ProposalNote[] }` — `createRequest` con
    `origin.product_doc`; una frase già proposta (una richiesta con lo
    stesso `pageId` e `anchorId`) non torna, e diventa una nota
    `already_proposed`
  - `listProductLinkedRequests(me, pageId): { code; title; taskCodes }[]` e
    `productOriginOf(me, request | task): { pageId; code; title } | null`
    (nullo se la pagina non si vede)
  - il blocco `{ type: "wireframe"; id: string; wireframeId: string;
    variant: number }`; `PRODUCT_WIREFRAMES: Record<string, { keywords:
    string[]; variants: string[] }>` (SVG in bianco e nero)
  - `drawWireframeAs(me, pageId, afterAnchorId): { blockId }` e
    `redrawWireframeAs(me, pageId, blockId)` (variante seguente), entrambe
    `via: "claude"`; la scelta del disegno legge le parole della pagina
  - l'esportazione mette la bozza come immagine (`svgToPng` nel renderer
    per il Word; il PDF la stampa com'è)

- [ ] **Step 1: test**: le candidate di Phases; quelle della sola sezione di
  una fase; le già proposte escluse con la nota; `productOriginOf` di una
  task nata da una richiesta della doc; nascosto per chi non vede la
  pagina; un blocco `wireframe` con un `wireframeId` sconosciuto →
  `invalid("wireframe")`; «Rifai» cambia la variante e lascia una revisione;
  il menu «/» ha `wireframe`; `exportModelOf` dà un'immagine per la bozza,
  e mai il suo segno.
- [ ] **Step 2:** vedili fallire; implementa; vedili passare; suite,
  typecheck, lint; commit `feat(desktop): voci di backlog dalla doc e
  bozze di schermata`.

### Task 8: Il riquadro di Claude

**Files:**
- Modify: `data/claude/types.ts`, `data/claude/catalogMore.ts` (o
  `catalog.ts`), `data/claude/classes.ts`, `domain/claude/intents.ts`,
  `domain/claude/context.ts` (`ReadApi` + letture della doc di prodotto),
  `domain/claude/intents/{general,howto}.ts`, `data/model.ts`
  (`CapabilityId`), i18n
- Create: `domain/claude/intents/productDocs.ts`
- Test: `domain/claude/intents/productDocs.test.ts`, `classes.test.ts`,
  `neverInCatalog.test.ts` (invariato, deve restare verde)

**Interfaces:**
- Produces:
  - azioni nuove del catalogo: `writeFirstVersion` (A, inversa
    `undoFirstVersion`), `updateProductPage` ({ pageId, source }, B con la
    ragione `notifies`), `drawWireframe` (A, inversa: eliminare il blocco);
    il backlog usa `createRequest` di oggi
  - un `Intent` nuovo `productDoc` con i sotto-casi: prima versione,
    aggiorna da questa email o riunione, proponi le voci di backlog, disegna
    questa schermata, cosa è cambiato questa settimana
  - `CapabilityId` + `productFirstVersion`, `productUpdate`,
    `productBacklog`, `productWireframe`, `productChanges` in S0
  - le risposte del progetto (`howto`) citano anche le pagine di prodotto
    (`productAnswerPage`, `CitationRef` `doc`)

- [ ] **Step 1: test**: ogni frase delle cinque riconosciuta in en e it;
  «aggiorna Sign-in da questa email» con un'email che chi chiede non vede →
  rifiutato senza nominarla; la scheda B per l'aggiornamento elenca i
  blocchi e chi verrà avvisato; «cosa è cambiato questa settimana» elenca
  solo pagine visibili, con la fonte vista da chi chiede, e nulla per Sara
  su una pagina che non vede; S0 elenca le cinque capacità; `classOf` di
  `updateProductPage` è B anche quando non ci sono seguaci (il fallback di
  `productDocRecipients`), e `writeFirstVersion` è A; con il budget finito
  nessuna azione parte (`BudgetBand`).
- [ ] **Step 2:** vedili fallire; implementa; vedili passare; suite,
  typecheck, lint; commit `feat(desktop): la doc di prodotto nel riquadro
  di Claude`.

### Task 9: Il segno a margine e la cronologia (UI)

**Files:**
- Create: `pages/productDocs/claude/ProductClaudeMark.tsx`,
  `pages/productDocs/claude/SourceLine.tsx`
- Modify: `pages/productDocs/BlockShell.tsx`, `HistoryPanel.tsx`, i18n
- Test: `ProductClaudeMark.test.tsx`, `HistoryPanel.claude.test.tsx`

Shape: `product-claude-mark.md`. Impeccable obbligatorio. Test:
- il segno chiuso e aperto, con «on behalf of Laura Conti» e la fonte;
- «Looks good» e «Undo» (il fuoco va al blocco dopo «Undo», mai al body);
- «Undo» spento con la frase e il «Who?» di Marco;
- Sara: nessun bottone, la frase «Only people who can edit the Docs…» e il
  «Who?»;
- Review Focus 3 in DOM: per Sara nessuna parola dell'oggetto dell'email, in
  minuscolo, in tutta la pagina;
- la cronologia: «Undo all», la riga «Undone by», «Laura, from Claude's
  question», la prima versione;
- un doppio clic su «Undo» fa una sola scrittura;
- `ClaudeDraftMark.tsx` e i suoi test invariati (`git diff` vuoto).

Scatti `a11b-mark-*`, `a11b-history-*`. Commit `feat(desktop): il segno di
Claude nella pagina`.

### Task 10: Le domande nella colonna, in Home e nelle card (UI)

**Files:**
- Create: `pages/productDocs/comments/QuestionThread.tsx`
- Modify: `pages/productDocs/comments/*`,
  `pages/home/blocks/ClaudeDecisionItem.tsx`,
  `notifications/NotificationItem.tsx` (`composedOf` per i due kind), il
  riquadro di Claude («N questions to close»), i18n
- Test: `QuestionThread.test.tsx`, `ClaudeDecisionItem.product.test.tsx`,
  `NotificationItem.productClaude.test.tsx`

Shape: `product-claude-questions.md`. Test:
- il filo-domanda con la fonte, il prima e dopo di «Update it» e i tre
  bottoni; risposta → il filo risolto con «Answered by Laura: Update it»;
- «Open a request» apre il riquadro con la scheda B;
- `alreadyAnswered` dice «Marco answered first» e ricarica;
- in Home: la domanda in «Decide», risposta da lì, sparisce; l'«Undo» di
  «Decide» di oggi non vale per «Update it» (risposta subito, la
  modifica si annulla dalla cronologia) *(scelta del costruttore)*;
- le due card: titolo e corpo composti a lettura, la fonte vista da chi
  guarda, la card per pagina con due fonti, `objectGone`;
- la card fixture senza `productUpdate`/`productQuestion` non lancia;
- «N questions to close» nel riquadro porta ai fili.

Scatti `a11b-questions-*`, `a11b-inbox-*`, `a11b-home-*`. Commit
`feat(desktop): le domande di Claude nella colonna e in Home`.

### Task 11: La prima versione e la riga del budget (UI)

**Files:**
- Create: `pages/productDocs/claude/FirstVersionDialog.tsx`,
  `FirstVersionBanner.tsx`, `FirstVersionProgress.tsx`,
  `ClaudeWaitingLine.tsx`
- Modify: `pages/productDocs/ProductIndex.tsx` (`EmptySpace`: la seconda
  strada per prima), `ProductSpace.tsx`, i18n
- Test: `FirstVersion.test.tsx`, `ClaudeWaitingLine.test.tsx`

Shape: `product-claude-questions.md`. Test:
- lo spazio vuoto con «Write the first version with Claude» per prima, e
  spenta col «Who?» per Sara, con la frase del budget se finito;
- la finestra: le fonti visibili, «Start» spento senza fonti con la frase,
  Esc e il fuoco che torna al bottone;
- l'avanzamento per pagina e, alla fine, l'albero;
- la riga in cima, «Accept», «Undo the first version» con la sua
  conferma, spenta col «Who?» dopo un tocco;
- la riga «Claude will resume updating the doc when the budget is back» /
  «Claude riprenderà ad aggiornare la doc quando torna il budget» con lavori
  in attesa, e quella della pausa col nome di chi l'ha messa;
- a 1024 la finestra e la riga seguono lo shape.

Scatti `a11b-first-*` su VRD (prima, durante, dopo), `a11b-waiting-*`.
Commit `feat(desktop): la prima versione di Claude nello spazio`.

### Task 12: Backlog dalla doc e bozze di schermata (UI)

**Files:**
- Create: `pages/productDocs/claude/LinkedRequests.tsx`,
  `pages/productDocs/blocks/WireframeBlock.tsx`
- Modify: `ProductSpace.tsx` («⋯»: Propose backlog items, Draw this
  screen), `BlockBody.tsx`, `SlashMenu.tsx`, `pages/task/LinksSection.tsx`
  e la vista della richiesta («From the doc: …»), l'esportazione, i18n
- Test: `LinkedRequests.test.tsx`, `WireframeBlock.test.tsx`,
  `LinksSection.productDoc.test.tsx`

Shape: `product-claude-backlog.md`. Test:
- «Propose backlog items» dalla barra e dal titolo di una fase apre il
  riquadro con la scheda in blocco; confermata, le voci compaiono in fondo
  alla pagina;
- «From the doc: Phases» su richiesta e task, link alla pagina; nascosto per
  chi non vede la pagina;
- la bozza: etichetta, «Redraw», «Replace with an image» (il blocco
  immagine prende il suo posto), «/» con «Screen sketch», Sara senza
  bottoni;
- l'esportazione PDF e Word contiene la bozza.

Scatti `a11b-backlog-*`, `a11b-wireframe-*`. Commit `feat(desktop):
backlog dalla doc e bozze di schermata`.

### Task 13: Documenti, parità, scatti, follow-up

- `apps/desktop/docs/area11-parity.md`: le voci del 11b (regola, segno,
  «Annulla», domande, prima versione, backlog, bozze, riquadro, budget),
  dove vivono e i test. Per il prodotto vero: il lavoro del worker che
  rilegge le fonti sotto le regole del giro notturno e della quota; la
  tabella dei segni; il ramo `product_doc` di `origin`;
  **`product_doc.updated`** e **`product_doc.question`** con rollback (§5)
  e cambi additivi verso l'app; la regola «decisioni inventate» come
  istruzione del prompt **e** come controllo sul risultato (un fatto
  vago non diventa mai una modifica).
- `ossatura-follow-ups.md`: «Area 11b — minori aperti» con le scelte del
  costruttore e il loro costo se sbagliate (fra queste: i fatti dei copioni
  al posto del modello; la bozza generica della prima versione; il
  titolare dell'email; le card raccolte per pagina al rilascio; «Update it»
  senza la finestra di «Undo» di «Decide»; la bozza di schermata come SVG
  del seme), e in fondo le decisioni del maintainer Q1–Q2.
- `capture.mjs`: i set `a11b-*` dei Task 9–12, a 1440 chiaro e scuro × en e
  it, a 1024 `narrow-en` e `narrow-it`. Vite ucciso.
- `emptyInstance.test.tsx`: nessun copione del 11b parte sull'istanza
  vuota.
- Suite, typecheck, lint e build verdi. Commit `docs(desktop): note
  dell'area 11b`.

Dopo il Task 13: revisione finale del branch (area 11b), revisione visiva
di Impeccable, poi le prove a mano dell'11a e dell'11b insieme al
maintainer.

---

## Decisioni del maintainer sulle domande del piano (6 nov 2026)

1. **Q1 — dove si risponde a una domanda di Claude** *(maintainer, 6 nov
   2026)*: nel commento della pagina e in Home «Decidi», come le domande di
   Claude sui task; la notifica avvisa e porta al filo, senza bottoni.
   Global Constraints, Task 4, Task 10.
2. **Q2 — VRD nel seme** *(maintainer, 6 nov 2026)*: vuoto; la prima
   versione la lancia chi prova l'app, e gli scatti si fanno dopo averla
   lanciata. Task 6, Task 11.

## Decisioni del maintainer sugli shape del Task 0

(da scrivere dopo il Task 0)
