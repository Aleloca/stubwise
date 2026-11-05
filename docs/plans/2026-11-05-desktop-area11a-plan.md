# App desktop, area 11a: lo spazio Prodotto, l'editor a blocchi, i commenti, la cronologia e la scrittura dal vivo — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la metà dell'area 11 che
serve a chi scrive la doc di prodotto **senza** il lavoro automatico di
Claude:
- lo **spazio «Prodotto»** dei Docs, per primo e separato dagli spazi
  «Codice», anche in un progetto senza repository, col modulo Docs che si
  accende e si spegne;
- l'**albero delle pagine** (trascinabile, rinominabile, sottopagine);
- il **documento a blocchi con id stabili** (decisione 4 della spec);
- l'**editor** come Notion: «/» per i blocchi, immagini con didascalia,
  file del Drive, decisioni del registro, codici apribili (`CodeLink`);
- i **commenti** ancorati a un blocco, con @menzioni, risposte in fila,
  «Risolto» e «Frase eliminata»;
- la **cronologia** della pagina e **seguire** una pagina;
- la **scrittura dal vivo** simulata dai copioni dei dati finti: cursori,
  avatar, e il segnale «qualcuno scrive in questa sezione» che il 11b usa;
- l'**esportazione** in PDF e Word (un solo messaggio IPC nuovo);
- **ricerca, ⌘K e chat del progetto** che trovano le pagine di prodotto;
- lo **stato senza permesso di scrittura** (frase e «Who?»);
- i **dati finti** degli spazi ancora senza contenuti di Claude.

Restano al piano **11b** (da scrivere dopo questo): la prima versione di
Claude e «Annulla tutto»; gli aggiornamenti automatici dalle quattro fonti
con la regola chiara/vaga/niente; il segno a margine con «Va bene» /
«Annulla»; i commenti-domanda con le risposte; i due `notification_kind`
`product_doc.updated` e `product_doc.question`; le voci di backlog proposte
da una pagina; le bozze di schermata; le voci del catalogo del riquadro; la
coda del budget; i copioni di tutto questo (*scelta del controller*, 5 nov
2026).

**Architecture:**
- **Il documento è dati, non testo.** Il corpo di una pagina di prodotto è
  `ProductBlock[]`, con id stabili che non si riusano mai
  (`state.productBlockIds` li ricorda tutti). Ogni ancora — commento,
  presenza, e nel 11b il segno — punta a un **id d'ancora**: l'id del blocco,
  o della cella per una tabella. Le pagine manuali dei repository restano
  Markdown, intatte.
- **Una sola strada di scrittura.** Ogni modifica del corpo passa da
  `writeProductBlocksAs(me, pageId, ops, meta)`, che applica le operazioni
  pure di `domain/productDocs/blocks.ts`, scrive la revisione e avvisa gli
  iscritti della pagina. La pagina chiama `saveProductBlocks` (con la
  `sessionId` dell'editor), i copioni la chiamano come la persona finta, il
  11b la chiamerà con `via` e `source`.
- **Il motore è puro, la pagina legge.** Albero, sezioni, operazioni sui
  blocchi, scorciatoie, «/» e il modello d'esportazione stanno in
  `domain/productDocs/*`, senza stato. La UI legge `permissions`,
  `anchorGone`, `writersNear` dal livello dati, non li calcola.
- **Dal vivo senza rete.** La presenza è nello store
  (`state.productPresence`); un copione per pagina, partito alla prima
  apertura nella generazione dello store, scrive come una persona del seme
  con `streamDelay()`; gli iscritti (`subscribeProductPage`) ricaricano.
  Nessun timer sull'orologio del prototipo.
- **Esportazione.** Il modello (`exportModelOf`) è puro; il PDF lo stampa
  il processo principale (`printToPDF` della finestra, con una vista di
  stampa montata solo per quel momento), il Word lo costruisce il renderer
  con `docx`; entrambi escono dal **solo** canale nuovo `file:save`, che apre
  la finestra di salvataggio.

**Tech Stack:** quello delle aree 1–10b. **Editor: nessuna libreria** —
un `contenteditable` per blocco, **controllato**: ogni `beforeinput`
(`insertText`, `deleteContentBackward`, `insertParagraph`, `formatBold`…)
diventa un'operazione pura sul testo con i segni (`RichText`, testo più
intervalli di grassetto, corsivo e link), e il DOM si ridisegna dal modello.
Così il documento a blocchi con id stabili resta l'unica verità (una
libreria ProseMirror/Lexical porterebbe un secondo modello da tenere
allineato) e i test in happy-dom guidano l'editor con eventi `InputEvent`
senza dipendere dalla selezione nativa. Trascinamento con `@dnd-kit/core` e
`@dnd-kit/sortable`, già dipendenze. **Dipendenza nuova: `docx`** (Word, MIT,
JS puro).

**Spec:** `docs/plans/2026-11-05-desktop-area11-product-docs-design.md`
(approvato il 5 nov 2026). La sezione «Decisioni dopo la lettura del
costruttore (5 nov 2026)» prevale sulle sezioni prima. Valgono per il 11a:
- «Perché», «Obiettivi» (tranne «Claude scrive la prima versione», «Claude
  tiene la doc aggiornata», «Dalla doc al lavoro», le bozze di schermata),
  «Non obiettivi», gli anti-obiettivi «Confondere la doc con il registro» e
  «Rivelare l'invisibile»;
- «Dove vive», «Permessi» (scrivere e commentare; annullare e confermare
  sono 11b), «Struttura di una pagina» (tranne la prima stesura e il blocco
  bozza di schermata);
- «Avvisi», solo «Chi riceve» per la lista di chi segue (le notifiche sono
  11b);
- «Commenti» (tranne le domande di Claude), «Scrittura dal vivo» (tranne
  «Claude che aspetta», di cui il 11a dà il segnale), «Esportazione»;
- «Stati»: spazio vuoto (solo «Inizia da una pagina vuota»), modulo spento,
  pagina senza permesso;
- «Dati finti»: ACQ maturo **scritto da persone**, il progetto nuovo senza
  repository con lo spazio vuoto, l'istanza vuota;
- «Parità con il web»: tabelle, scrittura dal vivo, esportazione;
- decisioni 4, 7 e 8 tutte; la 5 solo per «il segno sta nei dati» (il campo
  c'è, il segno no); la 9 e la 2 solo per i campi della revisione.

Contesto da leggere:
- `docs/plans/2026-11-02-desktop-area10b-plan.md` e
  `2026-11-02-desktop-area10a-plan.md` (forma, Global Constraints, lezioni);
- `docs/plans/2026-10-25-desktop-area5-docs-drive-design.md` e lo shape
  `apps/desktop/.impeccable/shape/docs.md` (spazi, albero, lettura, ⌘K);
- `apps/desktop/docs/ossatura-follow-ups.md` (invarianti §1–§18) e
  `area10-parity.md`;
- nel desktop (percorsi relativi a `apps/desktop/src/renderer/`):
  - `data/docs/{reads,writes,chat}.ts`, `domain/docs.ts`,
    `pages/docs/{DocsHome,DocSpace,DocTree,DocPageView,ManualPageForm,DocsChat,parts}.tsx`;
  - `data/model.ts` (Docs, `CitationRef`, `AppNotification`),
    `data/store.ts` (`State`, `ApiFnName`, `gate`, `newId`, `nextSeq`,
    `streamDelay`, `storeGeneration`, `docCodeSeq`);
  - `data/api.ts` (`resolveCodes`, `resolveCitations`, le menzioni `#`,
    `listDocPages`), `domain/claude/intents/howto.ts` (`docsAnswer`);
  - `components/CodeLink.tsx`, `components/WhoCanLink.tsx`,
    `tasks-ui/ClaudeDraftMark.tsx` (solo da leggere: non cambia),
    `pages/claude/conversation/MentionMenu.tsx`, `data/chat/mentions.ts`;
  - `pages/drive/{openFile,FilePreview,glyphs,Picker}.tsx`;
  - `notifications/NotificationItem.tsx`, `data/admin/members.ts`
    (`publishMemberAdded`, il modello di una notifica diretta);
  - `palette/CommandPalette.tsx`, `router.tsx`, `data/routes.ts`;
  - `src/main/{index,security}.ts`, `src/preload/index.ts`, `env.d.ts`;
  - `apps/desktop/DESIGN.md`.

## Global Constraints

- **Valgono tutte le Global Constraints dei piani 10a e 10b**, così come
  sono scritte lì: nessuna rete né modello; en/it con parità; temi; niente
  monospace salvo codice e affini; colore mai unico segnale; movimento
  150–250 ms con reduced-motion; pagine solo via `data/queries.ts` e
  `data/queries/*`; stati completi (caricamento, vuoto, errore con «Riprova»,
  pieno, senza permessi); commenti in italiano; un solo «adesso» (`now()`,
  `architecture.clock.test.ts` verde); l'orologio fermo (`nextSeq()`, mai
  `at`, per ogni «prima/dopo»: revisioni, commenti, presenza); R-G5 con i
  test in minuscolo; si deriva a lettura ciò che si può derivare; i campi
  nuovi sono facoltativi; Impeccable obbligatorio; il ciclo TDD; i comandi.
- **Le lezioni delle aree 9b, 9c, 10a e 10b, vincolanti:**
  - ogni bottone spento ha la sua frase; quello spento per un permesso anche
    il `WhoCanLink` (qui l'azione `editDocs`); quello spento per una regola
    («ha sottopagine») la frase senza «Who?»;
  - la pagina non ricalcola le regole del livello dati: niente `can()` in
    `pages/productDocs/` (test sul sorgente nel Task 7);
  - a 1024 px il layout segue lo shape, non si comprime da solo;
  - gli scatti si rifanno dopo ogni correzione visiva, prima del commit;
  - la UI non afferma ciò che il dato non dimostra: «Frase eliminata» solo
    con `anchorGone`, «Marco Bellini is writing here» solo con una presenza
    viva su quell'ancora, «Saved» solo dopo la risposta;
  - dopo un dialogo o un menu «⋯» il fuoco torna a chi l'ha aperto;
  - `write.run(..., onDone)` dà seguito anche dopo un Retry.
- **Dipendenze.** L'unica nuova è **`docx`** (in `dependencies` di
  `@stubwise/desktop`, aggiunta con `pnpm --filter @stubwise/desktop add
  docx`; il lockfile cambia solo così). Nessuna libreria d'editor. Se in
  revisione `docx` non passa, il Task 12 toglie il Word, tiene il PDF e lo
  scrive in `ossatura-follow-ups.md` (decisione 8 della spec).
- **Un solo messaggio IPC nuovo**, `file:save` (decisione 8). Nessun altro
  canale, nessun accesso del renderer al disco o a Node; il preload espone
  solo `window.stubwise.saveFile`. La validazione è pura in
  `src/main/security.ts`, coi suoi test.
- **Il documento a blocchi** (decisione 4):
  - una pagina di prodotto non ha Markdown, in nessun campo; il markdown non
    si vede mai nell'editor (le scorciatoie «# », «- », «1. », «[] », «> »,
    «---» diventano subito il blocco, e i loro segni spariscono);
  - il testo di ogni frase (paragrafo, titolo, voce, cella) è un `RichText`:
    testo semplice più segni a intervalli (`bold`, `italic`, `link`), come in
    Notion *(maintainer, 5 nov 2026, Q2)*. I segni non entrano mai nel testo
    (nessun «**», nessun tag); ricerca, chat, citazioni dei commenti e
    `excerpt` leggono il solo testo;
  - un link ha solo un indirizzo `http:` o `https:` (`safeLinkHref`): ogni
    altro schema (`javascript:`, `file:`, `data:`, relativo) si rifiuta
    quando si scrive e si scarta quando si incolla; il link si apre col
    browser di sistema (il `setWindowOpenHandler` di oggi), mai nella
    finestra;
  - ⌘K resta della palette: nell'editor il link si mette dalla barra della
    selezione;
  - un id di blocco o di cella non si riusa mai, neanche dopo
    un'eliminazione o in un'altra pagina (`invalid: block_id_taken`);
  - dividere un blocco tiene l'id sulla prima parte (i commenti restano
    lì); unire tiene l'id del primo, e i commenti del secondo **passano al
    blocco unito** nella stessa scrittura *(maintainer, 5 nov 2026, Q3)*:
    «Frase eliminata» resta solo per un'ancora cancellata;
  - le pagine manuali dei repository e i loro test non cambiano.
- **Permessi** (spec «Permessi», decisione 7): leggere lo spazio e le
  pagine con `docs.view`; scrivere, creare, rinominare, spostare, eliminare,
  commentare, rispondere, «Risolto» con `docs.edit`; seguire con la sola
  lettura; accendere e spegnere il modulo Docs con
  `project.settings.manage`. Nessun permesso nuovo. Un progetto invisibile,
  inesistente o col modulo spento risponde come uno che non esiste
  (`docsAccess`, la stessa funzione dei Docs).
- **Nessun Claude nel 11a.** Nessuna voce del catalogo, nessun intento,
  nessuna scrittura con `via`. I campi per Claude (`via`, `source`,
  `undoOf`, `groupId`) esistono nei tipi e restano vuoti in ogni riga del
  seme e di ogni scrittura del 11a. `ClaudeDraftMark` e i suoi test non
  cambiano (decisione 5).
- **R-G5 nella doc di prodotto.** Un codice nel testo che chi legge non
  vede è il codice tenue di `CodeLink`; un file del Drive nascosto, tolto o
  di un progetto invisibile è «This file is no longer available» col solo
  codice; una decisione del registro che chi legge non vede non mostra
  titolo né data. Le pagine di prodotto non compaiono in ricerca, ⌘K,
  menu `#`, chat e citazioni per chi non ha `docs.view` nel progetto o col
  modulo spento — nascosto e inesistente identici. L'esportazione esce come
  la vede chi esporta.
- **Le immagini** hanno sempre `src` `data:` (il seme con l'import
  `?inline` di Vite, l'incolla e il trascina con `FileReader`): niente
  `fetch` né `file://`, e il CSP di oggi (`img-src 'self' data:`) basta. Un
  file oltre `PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024` si rifiuta con la
  sua frase. Formati: PNG, JPEG, GIF, WebP.
- **I codici delle pagine** di prodotto sono della stessa serie delle pagine
  dei Docs (`<P>-D<n>`, `state.docCodeSeq`) e si citano come
  `CitationRef` `{ kind: "doc" }`: lo stesso componente di citazione
  (spec «Dove vive»). Un codice non si riusa dopo un'eliminazione.
- **I campi nuovi sono facoltativi** (cambi additivi):
  `ProjectDocsHome.product`, `DocsAnswer.sources[].space`,
  `ProductRevision.{via,source,undoOf,groupId,sessionId}`. Ogni fixture dei
  test che li legge si lascia **senza** quei campi almeno una volta.
- **Un `notification_kind` nuovo, `product_doc.mention`** *(maintainer, 5
  nov 2026, Q1)*: una @menzione in un commento avvisa la persona. È il terzo
  kind dell'area oltre ai due del 11b; va in parità con la regola di
  rollback del CLAUDE.md (non si scende d'immagine sul server finché ne
  esistono righe) e con i cambi additivi verso l'app (l'enum dei client
  passa da `readerSchema`). Titolo e corpo si compongono a lettura.
- **Comandi.**
  - Un singolo file di test: `pnpm --filter @stubwise/desktop test -- <file>`.
  - Prima di ogni commit: `pnpm --filter @stubwise/desktop test`,
    `pnpm --filter @stubwise/desktop typecheck` e `pnpm lint` dalla radice.
    Alla fine anche `pnpm --filter "@stubwise/desktop..." build`.
  - Commit `feat(desktop): …` / `fix(desktop): …` / `docs(desktop): …` in
    italiano, con il messaggio in HEREDOC e i trailer:

    ```
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm
    ```
  - Verifica UI: `pnpm --filter @stubwise/desktop preview:web` +
    `node apps/desktop/scripts/capture.mjs`, scatti `a11a-*` a 1440 chiaro e
    scuro × en e it, più 1024 scuro-en (`narrow-en`) e chiaro-it
    (`narrow-it`), come le varianti di `capture.mjs` del 10b. Vite ucciso
    alla fine. Mai `pkill` su vitest.
- **Il ciclo di ogni task** (TDD), con gli elenchi «Test» come passi:
  1. scrivere i test elencati, coi valori del task;
  2. lanciarli (`pnpm --filter @stubwise/desktop test -- <file del task>`)
     e vederli fallire per il motivo atteso (funzione, campo o testo che
     manca), non per un errore d'altro tipo;
  3. implementare le firme dell'Interfaces;
  4. rilanciarli e vederli passare;
  5. suite, typecheck e lint, poi il commit indicato.
  Un test scritto per riprodurre un difetto si guarda **perché** è verde
  (lezione (c) del CLAUDE.md): gli id generati dagli helper non devono
  togliere la condizione che il test prova (due ancore con lo stesso testo,
  due revisioni della stessa sessione).

## Review Focus

1. **Due persone nello stesso blocco.** Il copione di Marco scrive
   nell'ancora in cui chi guarda ha il cursore. Ci si aspetta che il testo
   di chi guarda non sparisca mentre scrive, che il cursore non salti, e
   che dopo l'uscita dal blocco valga l'ultima scrittura con **entrambe**
   le versioni in cronologia (nessuna persa). → Task 5, Task 11.
2. **Dividere, unire, cancellare un blocco commentato.** Invio a metà di un
   blocco con un commento: il commento resta sulla prima parte (l'id
   resta), e un grassetto a cavallo del taglio si divide fra le due parti.
   Backspace in testa al blocco dopo: il commento del secondo blocco passa
   al blocco unito (Q3), con la sua frase citata; i segni del secondo
   restano sulle stesse lettere. Una tabella con una cella commentata,
   tolta una riga: la cella diventa «Frase eliminata», e il filo non
   sparisce mai dalla colonna. → Task 1, Task 4, Task 10.
3. **Incollare.** Testo da Google Docs con grassetto, corsivo e link: un
   blocco paragrafo per riga, segni tenuti, nient'altro dell'HTML (né stili
   né tag nel testo); un link `javascript:` o relativo resta testo senza
   link. Un'immagine dagli appunti: un blocco immagine dopo il blocco
   corrente. Un'immagine di 8 MB: rifiutata con la frase, nessun blocco.
   → Task 1, Task 8, Task 9.
4. **Il nome del file esportato e l'esito.** Un titolo con «/», «:» o «..»
   («Fatture 2026/27: regole»): un nome di file valido, mai un percorso.
   Finestra annullata: nessun messaggio d'errore e nulla scritto. Word che
   fallisce a costruirsi: un avviso con «Riprova», non il silenzio. Nel
   `preview:web`, senza `window.stubwise`, il PDF apre la stampa del browser
   e il Word si scarica. → Task 12.
5. **La pagina che sparisce sotto le mani.** La pagina aperta viene
   eliminata (o il modulo spento, o il permesso perso col «vedi come»)
   mentre il copione ci scrive: il copione si ferma senza errori, la pagina
   dice «non trovata» come una che non esiste, nessuna presenza resta
   appesa, nessuna notifica di menzione apre più nulla. → Task 2, Task 5,
   Task 7.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer **prima del Task 1**, in
`apps/desktop/.impeccable/shape/`. Nessun codice. Partono da `docs.md`,
`drive.md`, `claude-drafts.md` e `claude-trace.md`, e non li riscrivono. Le
domande al maintainer le pone il controller (con `AskUserQuestion`, la
risposta consigliata per prima); le risposte si scrivono in «Decisioni del
maintainer sugli shape del Task 0». Le domande Q1–Q4 del piano hanno già
risposta (in fondo).

- **`product-space.md`** (lo spazio e l'albero):
  - la pagina iniziale dei Docs con il gruppo «Product» / «Prodotto» per
    primo e «Code» / «Codice» sotto, anche senza repository;
  - lo spazio: barra, albero a sinistra (come lo spazio di un repository:
    240 px, ridimensionabile, cassetto sotto i 1200 px), colonna di lettura;
  - l'albero: sottopagine, il trascinamento con la sua ombra e la linea di
    destinazione (dentro / prima / dopo), rinomina sul posto, «+» per una
    sottopagina, «⋯» con Move up / Move down / Indent / Outdent / Delete, la
    voce spenta «Delete» per una pagina con sottopagine e la sua frase;
  - gli stati: spazio vuoto per chi scrive («Start from a blank page» /
    «Inizia da una pagina vuota», e il posto dove il 11b mette «Scrivi la
    prima versione con Claude») e per chi legge; modulo Docs spento con
    «Turn on Docs» / «Accendi i Docs» per chi gestisce il progetto, la frase
    e «Who?» per gli altri; l'interruttore «Docs» in Settings → General;
  - la barra della pagina: ordine e nome dei gesti (Follow, History,
    Comments, Export ▾), gli avatar di chi c'è, la riga di sola lettura
    (frase + «Who?»);
  - l'esportazione: il menu (This page / Whole space × PDF / Word), lo stato
    «Preparing…», l'avviso d'errore con «Retry»;
  - la parte di ⌘K: l'ambito «In Product» dentro lo spazio, il gruppo delle
    pagine di prodotto fuori, la fonte «Product» nella chat del progetto.
- **`product-editor.md`** (l'editor e la scrittura dal vivo):
  - la tipografia dei blocchi (titoli 1–3, paragrafo, elenchi, liste di
    controllo, citazione, separatore, tabella), la maniglia ⋮⋮ e il «+» a
    sinistra al passaggio, il fuoco;
  - il menu «/»: voci, gruppi, filtro mentre si scrive, frecce e Invio, Esc;
  - immagine con didascalia (vuota: «Add a caption»), trascinare e
    incollare, l'immagine troppo grande;
  - il blocco file del Drive (la riga del Drive, «Open»), il selettore, il
    file non più disponibile;
  - il blocco decisione del registro (titolo, data, chi), e quella che chi
    legge non vede;
  - grassetto, corsivo e link nella frase (Q2): la barra della selezione
    (Bold, Italic, Link, Comment), ⌘B / ⌘I, il campo dell'indirizzo del
    link e il suo rifiuto («Only http and https links»), il link letto e
    aperto;
  - i codici nel testo (`CodeLink`), il selettore «Link to…» (task,
    richiesta, pagina, file);
  - la tabella: aggiungere e togliere righe e colonne, Tab fra le celle;
  - i cursori degli altri: colore, etichetta col nome, selezione, la
    persona nello stesso blocco di chi guarda; gli avatar in cima;
  - «Saving…» / «Saved» e l'errore di salvataggio con «Retry»;
  - 1024 px: colonna dei commenti chiusa o sovrapposta, quale vince col
    riquadro di Claude e col pannello della task.
- **`product-comments-history.md`** (commenti, cronologia, seguire):
  - la colonna dei commenti a destra, allineata al blocco; il bottone
    «Comment» sulla selezione; la frase citata in cima al filo;
  - @menzioni (il menu, solo persone che leggono i Docs del progetto),
    risposte in fila, «Resolve» / «Risolvi» e i risolti chiusi in fondo
    («2 resolved»), «Reopen»;
  - «Frase eliminata» / «Sentence deleted»: dove sta il filo quando il
    blocco non c'è più;
  - chi legge soltanto: i fili si leggono, nessuna casella, la frase;
  - la cronologia: un pannello, le righe (chi, quando, cosa: «Created the
    page», «Edited 3 sentences», «Renamed from …», «Moved under …»),
    «Before» / «After» per frase, una frase tolta e una aggiunta;
  - «Follow» / «Following» (premuto), e il testo della notifica di
    menzione `product_doc.mention` (Q1).

### Task 1: Il modello a blocchi, il testo coi segni e il motore puro

**Files:**
- Create: `domain/productDocs/richText.ts`, `domain/productDocs/blocks.ts`,
  `domain/productDocs/sections.ts`, `domain/productDocs/tree.ts`,
  `domain/productDocs/shortcuts.ts`; test `domain/productDocs/richText.test.ts`,
  `blocks.test.ts`, `sections.test.ts`, `tree.test.ts`, `shortcuts.test.ts`.
- Modify: `data/model.ts` (sezione nuova `// --- Doc di prodotto (area 11) ---`).

**Interfaces, prodotte:**

```ts
// data/model.ts
export type InlineMark =
  | { type: "bold" | "italic"; start: number; end: number }
  | { type: "link"; start: number; end: number; href: string }; // href solo http(s)
/** Una frase: testo semplice più segni [start, end), normalizzati (ordinati, mai vuoti, mai sovrapposti fra segni dello stesso tipo). */
export interface RichText { text: string; marks: InlineMark[] }
export interface ProductTableCell { id: string; content: RichText }
export interface ProductTableRow { id: string; cells: ProductTableCell[] }
export type ProductBlock =
  | { id: string; type: "heading"; level: 1 | 2 | 3; content: RichText }
  | { id: string; type: "paragraph" | "quote"; content: RichText }
  | { id: string; type: "bullet" | "numbered"; content: RichText; indent: 0 | 1 | 2 }
  | { id: string; type: "todo"; content: RichText; checked: boolean }
  | { id: string; type: "divider" }
  | { id: string; type: "table"; rows: ProductTableRow[] }
  | { id: string; type: "image"; src: string; caption: string; alt: string }
  | { id: string; type: "drive"; fileId: string; code: string }
  | { id: string; type: "decision"; decisionId: string };
// Il 11b aggiunge `{ type: "wireframe"; … }` in coda all'unione.
export type ProductBlockType = ProductBlock["type"];
export type ProductBlockOp =
  | { op: "set"; block: ProductBlock }
  | { op: "insert"; afterId: string | null; block: ProductBlock }
  | { op: "delete"; blockId: string }
  | { op: "move"; blockId: string; afterId: string | null }
  /** Q3: unisce `secondId` in `firstId` (id e tipo del primo); chi scrive sposta sul primo le ancore del secondo. */
  | { op: "merge"; firstId: string; secondId: string };
export interface ProductBlockChange {
  blockId: string;
  before: ProductBlock | null;
  after: ProductBlock | null;
  /** Le ancore (blocco, o celle di una tabella) il cui testo, i cui segni o la cui presenza sono cambiati. */
  anchors: string[];
  /** Solo per un `merge`: l'ancora assorbita e dove cominciano le sue lettere nel blocco unito. */
  mergedFrom?: { anchorId: string; offset: number };
}
// domain/productDocs/richText.ts — pure
export function plain(text: string): RichText;
export function safeLinkHref(href: string): string | null;  // `new URL` valido con protocollo http: o https:, altrimenti null
export function insertText(rt: RichText, at: number, text: string): RichText; // un segno che copre `at` si allarga, la fine di un link no
export function deleteRange(rt: RichText, start: number, end: number): RichText;
export function toggleMark(rt: RichText, start: number, end: number, type: "bold" | "italic"): RichText; // tutto segnato → toglie, altrimenti mette
export function setLink(rt: RichText, start: number, end: number, href: string | null): RichText; // `invalid: href` se `safeLinkHref` è null; null toglie
export function splitRich(rt: RichText, at: number): [RichText, RichText];
export function concatRich(a: RichText, b: RichText): RichText; // i segni di b scalati di a.text.length
/** I pezzi da disegnare o esportare: testo coi segni attivi; i codici (`CODE_TOKEN_RE`) sono pezzi a sé. */
export function richSegments(rt: RichText): { text: string; bold: boolean; italic: boolean; href: string | null; code: string | null }[];
/** L'HTML degli appunti in frasi: solo testo, <b>/<strong>, <i>/<em>, <a href> con `safeLinkHref`; tutto il resto diventa testo (`DOMParser`). */
export function richFromHtml(html: string): RichText[]; // una per paragrafo o riga
// domain/productDocs/blocks.ts — pure
export function makeBlockId(): string;                       // `blk-${crypto.randomUUID()}`
export function anchorIdsOf(block: ProductBlock): string[];   // [id] per i testi, gli id delle celle per una tabella, [id] per immagine/drive/decisione/separatore
export function anchorText(blocks: readonly ProductBlock[], anchorId: string): string | null; // il solo testo; null = ancora che non c'è più
export function applyBlockOps(blocks: readonly ProductBlock[], ops: readonly ProductBlockOp[]): ProductBlock[]; // lancia `invalid: op` (id che manca, insert di un id già presente)
export function blockChanges(before: readonly ProductBlock[], after: readonly ProductBlock[]): ProductBlockChange[];
export function splitBlock(block: ProductBlock, offset: number, newId: string): [ProductBlock, ProductBlock]; // `splitRich`
export function mergeBlocks(first: ProductBlock, second: ProductBlock): ProductBlock; // id e tipo del primo, `concatRich`
export function plainTextOf(blocks: readonly ProductBlock[]): string;  // per ricerca e chat: una riga per ancora, didascalie comprese, mai un href
export function excerptOfBlocks(blocks: readonly ProductBlock[]): string; // il primo paragrafo non vuoto, ≤ 200
/** I codici citabili nel testo: task, richiesta, pagina, file, conversazione di supporto. */
export const CODE_TOKEN_RE: RegExp; // /\b[A-Z]{2,4}-(?:[DFRS])?\d+\b/g
// domain/productDocs/sections.ts — pure
/** Il titolo sopra l'ancora (qualunque livello); `null` = prima del primo titolo. */
export function sectionOf(blocks: readonly ProductBlock[], anchorId: string): string | null;
/** Le ancore della sezione: dal titolo fino al prossimo titolo di livello uguale o più alto. */
export function sectionRange(blocks: readonly ProductBlock[], headingId: string | null): string[];
/** `b` sta nella sezione di `a` (il segnale «qualcuno scrive qui»). */
export function inSectionOf(blocks: readonly ProductBlock[], a: string, b: string): boolean;
// domain/productDocs/tree.ts — pure
export function buildProductTree(pages: readonly ProductPageRef[]): ProductTreeNode[]; // fratelli per `order`, poi codice
export function flattenTree(nodes: readonly ProductTreeNode[]): { page: ProductPageRef; depth: number }[];
export function canMoveUnder(pages: readonly ProductPageRef[], pageId: string, parentId: string | null): boolean; // no a sé né a un discendente
// domain/productDocs/shortcuts.ts — pure
export type SlashItemId =
  | "heading1" | "heading2" | "heading3" | "paragraph" | "bullet" | "numbered"
  | "todo" | "table" | "quote" | "divider" | "image" | "drive" | "link" | "decision";
export interface SlashItem { id: SlashItemId; labelKey: string; keywords: string[] }
export const SLASH_ITEMS: readonly SlashItem[]; // il 11b aggiunge "wireframe"
export function filterSlashItems(q: string, label: (key: string) => string): SlashItem[];
/** Le scorciatoie in testa a un blocco: «# » → titolo 1 … «---» → separatore. */
export function typeShortcut(text: string): { type: ProductBlockType; level?: 1 | 2 | 3; rest: string } | null;
```

`ProductPageRef` e `ProductTreeNode` sono del Task 2 (stesso file
`data/model.ts`): il Task 1 li dichiara insieme al resto della sezione.

Test:
- [ ] `safeLinkHref`: `https://acq.example/bills` e `http://x.it` passano;
  `javascript:alert(1)`, `JavaScript:x`, `file:///etc`, `data:text/html,x`,
  `/bills`, `acq.example` → `null`.
- [ ] `toggleMark` su 11–22 («with Google») di «Login only with Google»:
  un `bold` 11–22; di nuovo: nessun segno; su 0–15 con 11–22 già grassetto:
  un solo `bold` 0–22. `insertText` dentro il grassetto lo allarga, alla
  fine di un link no; `deleteRange` su metà di un segno lo accorcia, su
  tutto lo toglie. `setLink` con `javascript:` lancia `invalid: href`.
- [ ] `splitRich` a metà di un corsivo: corsivo in entrambe le parti;
  `concatRich` scala i segni del secondo.
- [ ] `richSegments` di «See ACQ-14 at site» con `bold` su «ACQ-14» e
  `link` su «site»: `ACQ-14` è un pezzo `code` in grassetto, «site» ha
  `href`.
- [ ] `richFromHtml('<p><b>One</b> <a href="javascript:x">two</a></p><p><i>Three</i></p>')`:
  due frasi; «One» grassetto, «two» senza link, «Three» corsivo; nessun «<»
  nel testo.
- [ ] `applyBlockOps`: `insert` dopo `null` mette in testa; `move` dopo un
  id; `delete` di un id che manca e `insert` di un id già presente lanciano
  `invalid: op`; `merge` di «Login only» e «**with Google**» dà un blocco
  con l'id del primo, testo «Login onlywith Google» e il grassetto 10–21;
  l'array in ingresso non cambia.
- [ ] `blockChanges`: un paragrafo cambiato → `before`/`after` e `anchors:
  [id]`; **un grassetto in più e nient'altro** è un cambio; una tabella con
  una cella cambiata → `anchors: [<id cella>]`; una riga tolta → le sue
  celle in `anchors`; un `merge` → sul primo `mergedFrom: { anchorId:
  <secondo>, offset: 10 }`; un blocco spostato e non cambiato non è un
  cambio.
- [ ] `splitBlock` di «Login only with Google» a 10: il primo tiene l'id e
  «Login only», il secondo ha l'id nuovo e lo stesso tipo (un titolo diviso
  dà un paragrafo).
- [ ] `anchorText` di una cella che non c'è più: `null`; due ancore con lo
  stesso testo restano distinte per id; `plainTextOf` non contiene href.
- [ ] `sectionOf`/`sectionRange` su [H2 «Rules», P1, H3 «Edge cases», P2,
  H2 «Screens», P3]: `sectionOf(P2) = H3`; `sectionRange(H2 Rules)` = H2,
  P1, H3, P2 (non P3); `inSectionOf(P1, P2)` vero (P2 sta sotto Rules),
  `inSectionOf(P2, P1)` falso (P1 non sta in Edge cases), `inSectionOf(P1,
  P3)` falso; un blocco prima del primo titolo: sezione `null`.
- [ ] `buildProductTree`: fratelli per `order`; `canMoveUnder` rifiuta sé
  stesso e un nipote.
- [ ] `typeShortcut`: «# Titolo» → heading 1 «Titolo»; «## », «### »,
  «- », «* », «1. », «[] », «> », «---»; «#Titolo» (senza spazio) e
  «Totale #1» → `null`.
- [ ] `filterSlashItems("tab")` → `table`; `("tit")` in it → i tre titoli;
  stringa vuota → tutte, nell'ordine.
- [ ] `richSegments(plain("See ACQ-14 and ACQ-D31."))` → testo, codice
  `ACQ-14`, testo, codice `ACQ-D31`, «.»; «ISO-8601» non è un codice.
- [ ] Commit `feat(desktop): il documento a blocchi, il testo coi segni e il motore puro della doc di prodotto`.

### Task 2: Lo spazio Prodotto nel livello dati

**Files:**
- Create: `data/productDocs/{index,reads,writes,revisions,follows}.ts`,
  `data/queries/productDocs.ts`; test `data/productDocs/productDocs.test.ts`,
  `data/productDocs/revisions.test.ts`.
- Modify:
  - `data/model.ts`: i tipi qui sotto;
  - `data/store.ts`: `State` + `productPages`, `productRevisions`,
    `productFollows`, `productBlockIds: Set<string>`; `freshState()` e
    `emptyStore()`; `ApiFnName` + le voci `productDocs.*`;
  - `data/api.ts`: `export * as productDocs from "./productDocs"`;
  - `data/projectSettings/general.ts`: `setDocsModule`;
  - `data/projectSettings/repositories.ts`: il nome `product` è riservato
    (`invalid: name_reserved`), perché `#/p/<P>/docs/product` è lo spazio
    Prodotto;
  - `data/docs/reads.ts`: `ProjectDocsHome.product`;
  - `data/queries.ts`: le scritture di prodotto ricaricano l'area
    `productDocs` e `citations`, `codeCitations`, `mentions`.

**Interfaces, prodotte:**

```ts
// data/model.ts
export interface ProductPage {
  id: string; code: string; projectId: string;
  parentId: string | null; order: number;
  title: string; blocks: ProductBlock[];
  createdById: string; createdAt: string;
  updatedById: string; updatedAt: string;
}
/** Una fonte di una modifica (11b). Nel 11a nessuna riga la ha. */
export type ProductSourceRef =
  | { kind: "email" | "meeting" | "decision" | "task" | "release"; id: string }
  | { kind: "first_version"; ids: string[] };
export type ProductRevisionKind =
  | "create" | "edit" | "rename" | "move"
  | "undo" | "first_version" | "answer"; // le ultime tre le scrive il 11b
export interface ProductRevision {
  id: string; pageId: string; seq: number; at: string;
  /** Chi agisce: la persona (anche quando Claude agisce per lei, 11b) o il Claude collega. */
  actorId: string;
  via?: "claude"; source?: ProductSourceRef; undoOf?: string; groupId?: string;
  /** La sessione dell'editor che l'ha scritta: le scritture della stessa sessione si uniscono. */
  sessionId?: string;
  kind: ProductRevisionKind;
  changes: ProductBlockChange[];
  title?: { before: string; after: string };
  parent?: { beforeId: string | null; afterId: string | null };
}
export interface ProductFollow { pageId: string; personId: string; since: string }
export interface ProductPageRef {
  id: string; code: string; projectId: string; parentId: string | null; order: number;
  title: string; excerpt: string; updatedAt: string; updatedById: string;
}
export interface ProductTreeNode { page: ProductPageRef; children: ProductTreeNode[] }
export interface ProductSpaceView {
  projectId: string; projectCode: string;
  tree: ProductTreeNode[]; pageCount: number;
  /** Aggiornate di recente (al più 5). */
  recent: ProductPageRef[];
  permissions: { edit: boolean };
}
export interface ProductPageView extends ProductPage {
  breadcrumbs: ProductPageRef[];
  permissions: { edit: boolean; delete: boolean; deleteBlocked: "has_children" | null };
  following: boolean;
  /** Le decisioni citate, risolte per chi legge; `null` = non visibile (R-G5). */
  decisions: Record<string, { title: string; decidedAt: string; decidedByName: string | null } | null>;
  /** Fili aperti, per la barra. */
  openComments: number;
}
export interface ProductRevisionView extends ProductRevision { actorName: string }
// ProjectDocsHome (additivo)
product?: { pageCount: number; updatedAt: string | null; canEdit: boolean } | null;
// data/productDocs/reads.ts
export function productPageById(id: string): ProductPage | undefined;
export function productPageByCode(code: string): ProductPage | undefined;
export function productPageRef(page: ProductPage): ProductPageRef;
/** Le pagine di prodotto che chi guarda legge, in ogni progetto (`docsAccess === "read"`). */
export function readableProductPages(me: string): ProductPage[];
export async function getProductSpace(projectId: string): Promise<ProductSpaceView | null>; // `forbidden` come i Docs
export async function getProductPage(code: string): Promise<ProductPageView | null>;
// data/productDocs/writes.ts — ogni scrittura: `gate()`, poi controlli, poi stato
export async function createProductPage(projectId: string, input: { title: string; parentId?: string | null; afterId?: string | null }): Promise<ProductPage>;
export async function renameProductPage(pageId: string, title: string): Promise<ProductPage>;
export async function moveProductPage(pageId: string, to: { parentId: string | null; index: number }): Promise<ProductPage>;
export async function deleteProductPage(pageId: string): Promise<void>;
export async function saveProductBlocks(pageId: string, ops: ProductBlockOp[], opts: { sessionId: string }): Promise<ProductPage>;
/** L'unica strada del corpo: la usano la pagina, i copioni e (11b) Claude. Sincrona. */
export function writeProductBlocksAs(
  me: string, pageId: string, ops: readonly ProductBlockOp[],
  meta: { sessionId?: string; kind?: ProductRevisionKind; via?: "claude"; source?: ProductSourceRef; groupId?: string; undoOf?: string },
): ProductPage;
/** Chi tiene ancore le sposta quando un `merge` assorbe un blocco (stessa scrittura, nessuna promessa). */
export function onAnchorsMerged(fn: (pageId: string, from: string, to: string, offset: number) => void): void;
// data/productDocs/revisions.ts
export async function listProductRevisions(pageId: string): Promise<ProductRevisionView[]>; // dalla più recente
/** La prima revisione dopo `seq` che ha toccato l'ancora (il «toccata da altri» del 11b). */
export function touchedAfter(pageId: string, anchorId: string, seq: number): ProductRevision | null;
// data/productDocs/follows.ts
export async function followProductPage(pageId: string): Promise<void>;
export async function unfollowProductPage(pageId: string): Promise<void>;
/** Chi segue la pagina e la legge ADESSO (un permesso perso toglie, senza riscrivere). */
export function followersOf(pageId: string): string[];
/** Chi riceve gli avvisi della pagina (11b): chi la segue; se nessuno, chi ha `docs.edit` nel progetto. Mai Claude. */
export function productDocRecipients(pageId: string): string[];
// data/projectSettings/general.ts
export async function setDocsModule(projectId: string, on: boolean): Promise<void>; // `project.settings.manage`
// data/queries/productDocs.ts
useProductSpace(projectId: string); useProductPage(code: string); useProductRevisions(pageId: string);
useCreateProductPage(); useRenameProductPage(); useMoveProductPage(); useDeleteProductPage();
useSaveProductBlocks(); useFollowProductPage(); useUnfollowProductPage(); useSetDocsModule();
```

Regole:
- `createProductPage`: `docs.edit`; titolo vuoto → `invalid: title`; codice
  `<P>-D<n>` da `state.docCodeSeq`; un paragrafo vuoto come primo blocco;
  revisione `create`; chi crea la segue (`ProductFollow`).
- `saveProductBlocks` → `writeProductBlocksAs(me, …, { sessionId })`. Ogni
  id di un `insert` (e ogni id di cella nuova) deve mancare da
  `state.productBlockIds`, altrimenti `invalid: block_id_taken`; dopo la
  scrittura gli id entrano nell'insieme. **Unione delle revisioni**: se
  l'ultima revisione della pagina ha la stessa `sessionId`, lo stesso
  `actorId`, nessun `via` e `kind: "edit"`, la scrittura le si aggiunge
  (per ancora resta il primo `before` e l'ultimo `after`; un'ancora tornata
  com'era esce dai cambi); altrimenti nasce una revisione nuova con
  `nextSeq()`. Nessuna revisione per una scrittura che non cambia niente.
  Le revisioni salvano i blocchi interi, quindi `before`/`after` portano i
  segni: un grassetto tolto è un cambio, e il 11b annulla tornando ai
  segni di prima.
- `writeProductBlocksAs` valida i segni di ogni blocco scritto (intervalli
  dentro il testo, `href` con `safeLinkHref`, altrimenti `invalid: marks`),
  qualunque strada abbia preso la scrittura. Per ogni `mergedFrom` chiama
  gli spostamenti d'ancora registrati (`onAnchorsMerged`, il Task 4 ci
  aggancia i commenti, il 11b il segno) dentro la stessa scrittura.
- `moveProductPage`: `canMoveUnder` o `invalid: cycle`; un genitore di un
  altro progetto → `not_found`; revisione `move`.
- `deleteProductPage`: con sottopagine `invalid: has_children`; toglie
  pagina, commenti, chi segue e presenza; revisioni tolte; il codice non si
  riusa; una citazione della pagina si legge come una pagina che non c'è.
- `setDocsModule(projectId, false)` nasconde Docs e Prodotto ma tiene i dati
  (riacceso, le pagine ci sono).

Test:
- [ ] Laura in ACQ (`docs.edit`) crea «Payments» sotto «Features»: codice
  `ACQ-D<n+1>` dopo l'ultima pagina dei Docs di ACQ, Laura la segue, una
  revisione `create` di Laura senza `via` né `source`.
- [ ] Sara in ACQ (Contributor, `docs.view` senza `docs.edit`):
  `getProductSpace` con `permissions.edit` falso; ogni scrittura
  `forbidden`, stato invariato (deep equal); `followProductPage` riesce.
- [ ] Un progetto invisibile, inesistente o col modulo spento: `null` e
  `not_found`, identici; visibile senza `docs.view`: `forbidden`.
- [ ] `saveProductBlocks` con due scritture della stessa `sessionId`: una
  revisione, con il primo `before`; una scrittura di Marco in mezzo: tre
  revisioni, in ordine di `seq`; una scrittura che lascia tutto com'era:
  nessuna revisione.
- [ ] Un `insert` con l'id di un blocco eliminato (anche di un'altra
  pagina): `invalid: block_id_taken`.
- [ ] Un `set` con un link `javascript:alert(1)` o un segno oltre la fine
  del testo: `invalid: marks`, pagina invariata; un `set` che mette solo un
  grassetto dà una revisione con il blocco senza segno in `before`.
- [ ] `touchedAfter(page, anchor, seq)`: la revisione di Marco dopo `seq` su
  quell'ancora; `null` se dopo hanno toccato solo altre ancore.
- [ ] `moveProductPage` sotto un proprio discendente: `invalid: cycle`;
  `deleteProductPage` con sottopagine: `invalid: has_children`, e
  `permissions.deleteBlocked === "has_children"` nella vista.
- [ ] `followersOf`: chi ha perso `docs.view` non c'è più, senza scrivere
  righe; `productDocRecipients` senza seguaci = chi ha `docs.edit` in ACQ,
  Claude escluso.
- [ ] `setDocsModule`: Giulia (Project Lead di MKX, modulo spento) lo
  accende e `getProductSpace(MKX)` risponde vuoto; Marco in ACQ:
  `forbidden`; spento in ACQ e riacceso, le pagine ci sono.
- [ ] `getProjectDocsHome` di ACQ: `product.pageCount` e `canEdit`; una
  fixture senza `product`, apposta, si legge senza errori nel test del
  Task 7.
- [ ] Un repository chiamato «product» (o «Product»): `invalid:
  name_reserved`.
- [ ] `emptyStore()`: nessuna pagina, revisione, seguace, id ricordato.
- [ ] Commit `feat(desktop): lo spazio Prodotto nel livello dati, con revisioni e chi segue`.

### Task 3: Il seme del 11a

Le aggiunte vanno **in fondo** ai semi, senza spostare indici o codici di
oggi (come nel 10b).

**Files:**
- Create: `data/seed/productDocs/{index,acq,presence}.ts`,
  `assets/productDocs/acq-sign-in.png`, `assets/productDocs/acq-bills.png`
  (due schermate finte, in bianco e grigio, ≤ 60 KB); test
  `data/seed.11a.test.ts`.
- Modify:
  - `data/seed/projects.ts`: in fondo, dopo `BSC`, il progetto `VRD`
    «App prenotazioni Palestra Verde Città», cliente «Palestra Verde Città
    Srl», template `client` (modulo `docs`), **senza repository**;
  - `data/access/seed.ts`: le appartenenze di `VRD`, scritte: Laura Project
    Lead, Marco Developer, Sara Contributor;
  - `data/access/effective.test.ts`: `PARITY_PROJECT_IDS` esclude anche
    `prj-vrd`, con un commento come per i progetti del 10b;
  - `data/seed/drive/*`: in fondo un file caricato di ACQ, `ACQ-F<n>`
    «Client brief.pdf», di Laura;
  - `data/seed/decisionLog.ts`: in fondo due decisioni di ACQ («Sign-in
    only with Google», «Readings close on the 25th»);
  - `data/store.ts`: lo stato parte da `PRODUCT_PAGES`, `PRODUCT_REVISIONS`,
    `PRODUCT_FOLLOWS`; `productBlockIds` dagli id del seme.

Il seme di ACQ (testi in inglese, come il resto del seme), tutto **scritto
da persone**:
- l'albero: Overview; Features → Sign-in, Bills, Meter reading, Fault
  reports; Screens; Client decisions; Phases (8 pagine);
- Overview con un blocco Drive (`ACQ-F<n>`), un codice di una richiesta di
  ACQ nel testo, una frase con un grassetto e un corsivo e un link
  `https://` al sito del cliente (inventato); Bills con un codice di una task di ACQ e uno di una task
  di un progetto che Sara non vede (`STW-…`); Screens con le due immagini e
  le didascalie; Client decisions con i due blocchi decisione; Meter reading
  con le sezioni «Rules» (con la frase «Readings close on the 25th of each
  month.») e «Edge cases» (H2, H3) e una tabella; Phases con
  una lista di controllo;
- revisioni: `create` per ogni pagina, poi modifiche di Laura, Marco e
  Matteo, ognuna con `seq` crescente;
- seguaci: Laura su tutte le pagine create da lei, Marco su Sign-in;
- `presence.ts`, il copione della pagina Meter reading (usato dal Task 5):
  Marco entra nella sezione «Rules», scrive «Readings sent after the 25th
  count for the next bill.» in un paragrafo nuovo, in 8 pezzi, e se ne va;
  Matteo è presente senza scrivere;
- i commenti del seme li aggiunge il Task 4 (`data/seed/productDocs/acq.ts`,
  in fondo).

`VRD` ha lo spazio Prodotto **vuoto** (il 11b lo riempie con la prima
versione di Claude).

Test:
- [ ] ACQ: 8 pagine, l'albero con Features e quattro figlie; ogni pagina ha
  una revisione `create`; nessuna revisione del seme ha `via`, `source`,
  `undoOf` o `groupId`.
- [ ] Gli id di blocco e di cella del seme sono tutti diversi e tutti in
  `productBlockIds`; nessun blocco del seme ha testo Markdown (nessun «#»,
  «**», «- » in testa); ogni segno del seme passa la validazione di
  `writeProductBlocksAs` e ogni `href` è `https:`.
- [ ] Le immagini del seme hanno `src` che comincia con `data:image/png`.
- [ ] `VRD`: nessun repository, modulo `docs` acceso, nessuna pagina; Laura
  ha `docs.edit`, Sara solo `docs.view`.
- [ ] Sara in ACQ: `docs.view` sì, `docs.edit` no; non vede il progetto del
  codice `STW-…` citato in Bills; Marco e Laura hanno `docs.edit` in ACQ.
- [ ] Il blocco Drive di Overview punta a `ACQ-F<n>` che Laura e Sara
  vedono; le due decisioni sono di ACQ.
- [ ] I codici di prodotto di ACQ seguono l'ultimo `ACQ-D` dei Docs e
  nessuno coincide con una pagina dei Docs.
- [ ] Le suite delle aree 1–10b restano verdi (conteggi di progetti, file
  del Drive e decisioni aggiornati dove li contano); `effective.test.ts`
  esclude `prj-vrd` per nome.
- [ ] Commit `feat(desktop): il seme della doc di prodotto (ACQ e il progetto nuovo)`.

### Task 4: I commenti ancorati e le menzioni (dati)

**Files:**
- Create: `data/productDocs/comments.ts`; test
  `data/productDocs/comments.test.ts`.
- Modify: `data/model.ts`; `data/store.ts` (`productComments`, `ApiFnName`);
  `data/productDocs/index.ts`; `data/queries/productDocs.ts`;
  `data/seed/productDocs/acq.ts` (i commenti in fondo);
  `notifications/NotificationItem.tsx` e i18n `notifications.productDocMention.*`;
  `data/api.ts` (`listNotifications`: `objectGone` per
  `product_doc.mention`); test anche
  `notifications/NotificationItem.productDoc.test.tsx`.

**Interfaces, prodotte:**

```ts
// data/model.ts
export interface ProductComment {
  id: string; pageId: string;
  /** L'id d'ancora (blocco o cella). */
  anchorId: string;
  /** La frase scelta al momento del commento (≤ 200): resta anche se l'ancora sparisce. */
  quote: string;
  authorId: string; body: string; createdAt: string; seq: number;
  /** Risposte in fila: solo a una radice. */
  replyToId: string | null;
  /** Solo la radice. */
  resolved: { byId: string; at: string } | null;
  mentionIds: string[];
  // Il 11b aggiunge `question?: …` (le domande di Claude).
}
export interface ProductCommentView extends ProductComment { authorName: string }
export interface ProductCommentThread {
  root: ProductCommentView;
  replies: ProductCommentView[];
  /** L'ancora non c'è più: «Frase eliminata». Derivato a lettura. */
  anchorGone: boolean;
}
// data/productDocs/comments.ts
export async function listProductComments(pageId: string): Promise<{ open: ProductCommentThread[]; resolved: ProductCommentThread[] }>; // aperti nell'ordine delle ancore, i senza ancora in fondo
export async function addProductComment(pageId: string, input: { anchorId: string; quote: string; body: string; replyToId?: string }): Promise<ProductComment>;
export async function resolveProductComment(rootId: string): Promise<void>;
export async function reopenProductComment(rootId: string): Promise<void>;
/** Chi si può menzionare: chi legge i Docs del progetto (R-G5), Claude escluso. */
export async function productMentionCandidates(projectId: string, q: string): Promise<{ id: string; name: string }[]>;
// data/queries/productDocs.ts
useProductComments(pageId: string); useAddProductComment(); useResolveProductComment();
useReopenProductComment(); useProductMentionCandidates(projectId: string, q: string);
```

Regole:
- tutto con `docs.edit` (anche rispondere e «Risolto»); `body` vuoto →
  `invalid: body`; un'ancora che non c'è nella pagina **adesso** →
  `invalid: anchor` per una radice (una risposta a un filo con l'ancora
  sparita si può ancora scrivere); `replyToId` di una risposta → `invalid:
  reply`;
- commentare, rispondere ed essere menzionati **non** scrivono un
  `ProductFollow` *(maintainer, 5 nov 2026)*: seguono solo chi crea la
  pagina e chi chiama `followProductPage`;
- `mentionIds` = `directMentionIds(body)` filtrato su chi legge i Docs del
  progetto e diverso da chi scrive;
- per ogni menzionato una notifica diretta `product_doc.mention`
  *(maintainer, 5 nov 2026, Q1)* (forma di `publishMemberAdded`:
  `actorId`, `objectCode` = codice della pagina, link
  `#/p/<P>/docs/product/<codice>?comment=<id radice>`, titolo e corpo
  composti a lettura: «Laura Costa mentioned you in ACQ-D31 · Sign-in» /
  «Laura Costa ti ha menzionato in ACQ-D31 · Sign-in»; quelli salvati sono
  la resa inglese); a lettura `objectGone` se la pagina o il commento non ci
  sono più o chi riceve non legge più i Docs; una menzione ripetuta nello
  stesso commento avvisa una volta;
- **unire due blocchi** *(maintainer, 5 nov 2026, Q3)*: `comments.ts` si
  aggancia a `onAnchorsMerged` (Task 2) e sposta sul blocco unito ogni filo
  (radici e risposte) ancorato al blocco assorbito, nella stessa scrittura;
  la `quote` resta com'era. «Frase eliminata» vale solo per un'ancora
  cancellata (blocco tolto, riga o colonna di tabella tolta).

Il seme (in fondo ad `acq.ts`): su Sign-in un filo aperto di Laura con
«@Marco Bellini» e una risposta di Marco; su Bills un filo risolto da Laura;
su Phases un filo su un blocco poi eliminato (una revisione di Matteo lo
toglie), che si legge «Frase eliminata».

Test:
- [ ] Laura commenta un blocco di Sign-in: la radice ha `quote`, `seq`
  crescente, `resolved: null`; Marco risponde; Sara: `forbidden` su
  commento, risposta e «Risolto», stato invariato.
- [ ] Un commento su un'ancora che non esiste: `invalid: anchor`; la
  risposta al filo di Phases (ancora sparita): riesce.
- [ ] `listProductComments` di Phases: il filo con `anchorGone: true` e la
  frase citata; dopo `resolveProductComment` il filo di Sign-in passa in
  `resolved`, e `reopenProductComment` lo riporta.
- [ ] Dividere il blocco commentato (Task 1, `splitBlock` con
  `saveProductBlocks`): il filo resta sulla prima parte, `anchorGone`
  falso. Un filo su una cella della tabella di Meter reading, tolta la sua
  riga: `anchorGone` vero (Review Focus 2).
- [ ] **Unire (Q3)**: due paragrafi di Sign-in, «Login only» e «with
  Google», un filo su ciascuno (con una risposta sul secondo). Un `merge`
  del secondo nel primo: tutti e due i fili hanno `anchorId` = id del
  primo, `anchorGone` falso, la risposta segue la sua radice, la `quote` del
  secondo è ancora «with Google»; nessun filo diventa «Frase eliminata». I
  due commenti del test hanno `quote` diverse apposta, e il test controlla
  che l'id di partenza del secondo filo fosse diverso da quello del primo
  (la condizione che il test prova).
- [ ] `productMentionCandidates(ACQ, "ma")`: comprende Marco Bellini e
  Matteo Conti, nessuno che non legge i Docs di ACQ, mai Claude.
- [ ] Nessun seguire implicito: Matteo commenta Bills e menziona Sara;
  `followersOf(Bills)` resta com'era (né Matteo né Sara).
- [ ] Menzioni (Q1): «@Marco Bellini» (due volte nel testo) → una sola
  notifica `product_doc.mention` a Marco, nessuna a chi scrive né a un nome
  che non legge ACQ; la pagina eliminata → `objectGone`; la card in it dice
  «Laura Costa ti ha menzionato in ACQ-D<n> · Sign-in»; una notifica con
  `kind` ignoto alla UI di oggi non rompe l'elenco (fixture apposta).
- [ ] Commit `feat(desktop): commenti ancorati ai blocchi, menzioni e «Risolto» nella doc di prodotto`.

### Task 5: La presenza e i copioni dal vivo (dati)

**Files:**
- Create: `data/productDocs/presence.ts`; test
  `data/productDocs/presence.test.ts`.
- Modify: `data/model.ts`; `data/store.ts` (`productPresence`,
  `ApiFnName`); `data/productDocs/{index,writes}.ts` (ogni scrittura avvisa
  gli iscritti); `data/queries/productDocs.ts`.

**Interfaces, prodotte:**

```ts
// data/model.ts
export interface ProductPresence {
  pageId: string; personId: string;
  /** Dove scrive; `null` = c'è ma non scrive. */
  anchorId: string | null;
  offset: number;
  selection: [number, number] | null;
  seq: number;
}
export interface ProductPresenceView extends ProductPresence {
  name: string; initials: string;
  /** Uno dei colori della presenza (`--presence-1`…`--presence-6`), stabile per persona. */
  color: 1 | 2 | 3 | 4 | 5 | 6;
}
export type ProductPageEvent = "blocks" | "presence" | "comments" | "gone";
// data/productDocs/presence.ts
export async function joinProductPage(pageId: string): Promise<void>;   // avvia il copione della pagina, una volta per generazione dello store
export async function leaveProductPage(pageId: string): Promise<void>;
export async function setProductPresence(pageId: string, at: { anchorId: string; offset: number; selection?: [number, number] | null } | null): Promise<void>;
export async function getProductPresence(pageId: string): Promise<ProductPresenceView[]>; // gli altri, non chi guarda
export function subscribeProductPage(pageId: string, cb: (event: ProductPageEvent) => void): () => void;
/** IL SEGNALE DEL 11b: chi (persone, anche chi guarda) scrive adesso nella sezione dell'ancora. */
export function writersNear(pageId: string, anchorId: string): string[];
/** Si sveglia quando una presenza cambia (il 11b ci riprova quando la sezione si libera). */
export function onProductPresence(fn: (pageId: string) => void): () => void;
/** Si risolve quando nessun copione ha più passi in corso (test). */
export function whenProductIdle(): Promise<void>;
// data/model.ts, i passi dei copioni del seme
export type ProductScriptStep =
  | { step: "enter"; personId: string; anchorId: string | null }
  | { step: "insert"; personId: string; afterId: string; blockId: string }
  | { step: "type"; personId: string; anchorId: string; text: string }
  | { step: "leave"; personId: string };
// data/queries/productDocs.ts
useProductPresence(pageId: string);         // iscrizione: ricarica presenza; "blocks"/"comments" invalidano pagina e commenti; "gone" la pagina
useJoinProductPage(pageId: string | null);  // join al montaggio, leave allo smontaggio e al cambio di persona
useSetProductPresence();
```

Regole:
- i passi del copione aspettano `streamDelay()` e scrivono con
  `writeProductBlocksAs(personId, …, { sessionId: "script:<pageId>:<personId>" })`;
  la presenza con `nextSeq()`; nessun timer sull'orologio;
- il copione si ferma senza errori quando la generazione dello store cambia,
  la pagina non c'è più, o la persona finta non legge più i Docs; a quel
  punto la sua presenza si toglie e gli iscritti ricevono `gone` o
  `presence`;
- `writersNear` conta le presenze con `anchorId` dentro `sectionRange(
  sectionOf(ancora))` (Task 1), compresa quella di chi guarda; una presenza
  senza `anchorId` non scrive.

Test:
- [ ] `joinProductPage(Meter reading)` come Laura, con `setLatency(0)`:
  dopo `whenProductIdle()` il paragrafo di Marco c'è, con id nuovo, una sola
  revisione di Marco per il copione, e la sua presenza non c'è più; un
  secondo `join` nella stessa generazione non lo rifà; dopo `resetStore()`
  sì.
- [ ] A metà copione (dopo «enter» e due «type»): `getProductPresence` per
  Laura dà Marco con `anchorId` nella sezione «Rules» e Matteo con
  `anchorId: null`; `writersNear(page, <un paragrafo di Rules>)` = Marco;
  `writersNear(page, <un paragrafo di Edge cases>)` = vuoto; con Laura nel
  cursore su Edge cases, `writersNear(Edge cases)` = Laura.
- [ ] La pagina eliminata a metà copione: il copione si ferma, nessuna
  eccezione, gli iscritti ricevono `gone`, nessuna presenza resta.
- [ ] Laura scrive nel blocco in cui scrive Marco: dopo il suo salvataggio
  vale il testo di Laura, e la cronologia ha la revisione di Marco **e**
  quella di Laura (Review Focus 1, lato dati).
- [ ] `subscribeProductPage`: un commento nuovo dà `comments`, una scrittura
  `blocks`, una presenza `presence`; dopo la disiscrizione niente.
- [ ] Commit `feat(desktop): presenza e copioni dal vivo nelle pagine di prodotto`.

### Task 6: Ricerca, ⌘K, menu `#`, citazioni e chat del progetto

**Files:**
- Create: `data/productDocs/search.ts`; test
  `data/productDocs/search.test.ts`, `palette/CommandPalette.product.test.tsx`,
  `pages/docs/DocsChat.product.test.tsx`.
- Modify:
  - `data/api.ts`: `resolveCodes`, `resolveCitations` (caso `doc`: anche
    `productPageById`, con la route di prodotto), il menu `#` (le pagine di
    prodotto con le altre, `detail` «ACQ · Product»);
  - `domain/claude/intents/howto.ts`: `docsAnswer` riceve `DocsAnswerPage[]`;
  - `data/docs/chat.ts`: la chat **del progetto** (senza `repositoryId`)
    legge anche le pagine di prodotto; quella di un repository no;
  - `data/model.ts`: `DocsAnswer.sources[].space?: "product"`;
  - `pages/docs/DocsChat.tsx`: la fonte «Product» / «Prodotto» al posto del
    nome del repository;
  - `palette/CommandPalette.tsx`: dentro `#/p/<P>/docs/product` l'ambito «In
    Product» / «Nel Prodotto» (solo pagine di prodotto, da un carattere);
    fuori, un gruppo delle pagine di prodotto accanto a quello dei Docs;
  - `data/queries/productDocs.ts`: `useProductSearch`.

**Interfaces, prodotte:**

```ts
// data/model.ts
export interface ProductSearchHit { page: ProductPageRef; projectCode: string; passage: string }
// data/productDocs/search.ts
/** Come `searchDocs`: parole piegate, tutte, in codice, titolo, testo (`plainTextOf`). */
export async function searchProductPages(q: string, opts?: { projectId?: string }): Promise<ProductSearchHit[]>;
// domain/claude/intents/howto.ts
export interface DocsAnswerPage { id: string; code: string; title: string; excerpt: string; body: string; spaceName: string }
export function docsAnswer(text: string, pages: readonly DocsAnswerPage[], t: T, opts: { scope: string }): { text: string; refs: CitationRef[]; pages: DocsAnswerPage[] };
export function docAnswerPage(page: DocPage, repoName: string): DocsAnswerPage;
export function productAnswerPage(page: ProductPage, spaceName: string): DocsAnswerPage;
// data/queries/productDocs.ts
useProductSearch(q: string, projectId: string | null, enabled?: boolean);
```

Test:
- [ ] `searchProductPages("readings 25th")` come Laura: Meter reading, col
  passaggio della frase; come Sara: lo stesso; come una persona che non
  vede ACQ, o col modulo spento: vuoto, identico a «nessun risultato».
  Una parola in grassetto di Overview si trova; il dominio del link di
  Overview no (gli `href` non sono testo), e il passaggio non ha segni.
- [ ] `resolveCodes(["ACQ-D<sign-in>"])`: visibile, nome «Sign-in», route
  `#/p/ACQ/docs/product/ACQ-D<sign-in>`; pagina eliminata: non torna, come
  un codice che non c'è.
- [ ] Menu `#` con «sign»: la pagina di prodotto, `detail` «ACQ ·
  Product».
- [ ] Chat del progetto ACQ, «How do meter readings work?»: cita
  Meter reading (`ref` `doc`), `sources[0].space === "product"`, e la UI
  scrive «Product»; la chat del repository `portale-utenti` non la cita;
  una fixture di `DocsAnswer` senza `space`, apposta, mostra il nome del
  repository.
- [ ] ⌘K dentro lo spazio Prodotto di ACQ, «bill»: solo pagine di
  prodotto, ambito «In Product»; Tab allarga a «Everywhere» con i due
  gruppi; un clic apre la pagina.
- [ ] I test di oggi di `docsAnswer` e dell'howto restano verdi con
  `docAnswerPage`.
- [ ] Commit `feat(desktop): le pagine di prodotto in ricerca, ⌘K, citazioni e chat del progetto`.

### Task 7: Docs, lo spazio Prodotto e l'albero (UI)

Segue lo shape `product-space.md`.

**Files:**
- Create: `pages/productDocs/{ProductSpace,ProductTree,ProductIndex,ProductPageRoute,ReadOnlyLine,parts}.tsx`;
  test `pages/productDocs/ProductSpace.test.tsx`,
  `pages/productDocs/ProductTree.test.tsx`,
  `pages/productDocs/architecture.test.ts`.
- Modify:
  - `router.tsx`: `productSpaceRoute` (`/p/$code/docs/product`, prima di
    `docSpaceRoute`, col commento della trappola della rotta letterale),
    figlio indice e figlio `$page` (il codice); `data/routes.ts` e
    `data/routes.test.ts` (il caso `#/p/ACQ/docs/product/ACQ-D31`);
  - `pages/docs/DocsHome.tsx`: il gruppo «Product» per primo e «Code»
    sotto; in un progetto senza repository solo «Product»; la chat del
    progetto c'è anche con le sole pagine di prodotto; `DocsTurnedOff` con
    «Turn on Docs» (`useSetDocsModule`) per chi gestisce, la frase e
    `WhoCanLink` (`manageProjectSettings`) per gli altri;
  - `pages/settings/GeneralSettings.tsx`: l'interruttore «Docs»
    *(maintainer, 5 nov 2026, Q4)* (spento: «Pages are kept. Turning Docs
    back on shows them again.»), con un test: spento da Giulia in MKX la
    colonna perde «Docs», riacceso le pagine ci sono;
  - i18n `productDocs.space.*`, `productDocs.tree.*`, `docs.home.product*`,
    `docs.off.turnOn*`, `projectSettings.general.docs*`.

L'albero: `@dnd-kit/sortable` sulla lista piatta di `flattenTree`, con la
profondità dal trascinamento orizzontale; la tastiera con «⋯» (Move up,
Move down, Indent, Outdent) e Invio/F2 per rinominare. Spostare chiama
`moveProductPage`; un errore rimette la pagina dov'era con l'avviso.

Test:
- [ ] DocsHome di ACQ: «Product» prima di «Code», con il numero di pagine;
  DocsHome di `VRD`: solo «Product», nessun «Code», nessun invito ad
  aggiungere un repository nel gruppo «Product».
- [ ] La fixture di `ProjectDocsHome` senza `product`, apposta: la pagina
  si disegna come prima, senza gruppo «Product» rotto.
- [ ] MKX (modulo spento) come Giulia: «Turn on Docs» → lo spazio vuoto
  con «Start from a blank page»; come un membro di MKX senza
  `project.settings.manage` (il test lo sceglie dal seme e lo nomina): la
  frase e «Who?», nessun bottone.
- [ ] Spazio vuoto di `VRD` come Laura: «Start from a blank page» crea la
  pagina «Untitled» / «Senza titolo» e apre il titolo in modifica; come
  Sara: «No product pages yet», nessun bottone.
- [ ] L'albero di ACQ: Features con quattro figlie, apri/chiudi; Laura
  trascina «Bills» sopra «Sign-in» → `moveProductPage` con `index: 0`; con
  la tastiera «Indent» su «Screens» la mette sotto «Features»; «Delete» su
  «Features» è spento con «Move or delete its subpages first» e senza
  «Who?».
- [ ] Rinomina sul posto: Invio salva, Esc torna al titolo di prima e il
  fuoco resta sulla voce.
- [ ] Sara: nessuna maniglia, nessun «+», nessun «⋯» di modifica; la riga
  «You can read this page. Editing is for people with Edit docs in ACQ» /
  «Puoi leggere questa pagina. Scrivere è di chi ha Modifica Docs in ACQ»
  con «Who?» (`editDocs`).
- [ ] La pagina eliminata da un altro mentre è aperta (o il modulo spento,
  o il «vedi come» su chi non vede ACQ): la vista dice «This page doesn't
  exist» come per un codice inventato (Review Focus 5).
- [ ] Nessun `can(` né `viewer` in `pages/productDocs/` (test sul
  sorgente).
- [ ] Commit `feat(desktop): lo spazio Prodotto nei Docs, l'albero delle pagine e il modulo Docs`.

### Task 8: L'editor: i blocchi di testo, i segni nella frase, «/» e la tastiera

Segue lo shape `product-editor.md`.

**Files:**
- Create: `pages/productDocs/editor/{BlockEditor,RichBlock,RichView,SelectionBar,LinkField,SlashMenu,BlockHandle,useEditorSession}.tsx`,
  `pages/productDocs/editor/{keys,input,domRange,undo}.ts`; test
  `pages/productDocs/editor/keys.test.ts`,
  `pages/productDocs/editor/input.test.ts`,
  `pages/productDocs/editor/undo.test.ts`,
  `pages/productDocs/editor/BlockEditor.test.tsx`.
- Modify: `pages/productDocs/ProductPageRoute.tsx` (titolo modificabile,
  editor); i18n `productDocs.editor.*`; `styles/tokens.css` se lo shape
  chiede token nuovi per la tipografia dei blocchi.

**Interfaces, prodotte:**

```ts
// pages/productDocs/editor/input.ts — pura
/** Un `beforeinput` sul testo coi segni: il risultato e dove va il cursore; `null` = non è nostro (lo prende `editorKey`). */
export function applyInput(
  rt: RichText,
  sel: { start: number; end: number },
  e: { inputType: string; data: string | null },
): { content: RichText; caret: number } | null;
// insertText, insertReplacementText, deleteContentBackward/Forward, deleteWordBackward,
// formatBold, formatItalic; insertParagraph e insertLineBreak tornano `null`.
// pages/productDocs/editor/domRange.ts
/** Fra il DOM disegnato da `RichView` (uno span per pezzo di `richSegments`) e gli scarti del testo. */
export function offsetOf(root: HTMLElement, node: Node, offset: number): number;
export function placeCaret(root: HTMLElement, start: number, end?: number): void;
// pages/productDocs/editor/keys.ts — pura
export type EditorKeyResult =
  | { kind: "split"; offset: number }
  | { kind: "mergeWithPrevious" }
  | { kind: "focusPrevious" | "focusNext" }
  | { kind: "indent" | "outdent" }
  | { kind: "moveBlock"; dir: "up" | "down" }
  | { kind: "toggleMark"; mark: "bold" | "italic" }
  | { kind: "openSlash" }
  | { kind: "undo" | "redo" }                 // ⌘Z / ⇧⌘Z (shape [PE 21])
  | { kind: "none" };
export function editorKey(e: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }, ctx: { text: string; caret: number; type: ProductBlockType; slashOpen: boolean }): EditorKeyResult;
/** Gli appunti in blocchi: con `text/html` le frasi di `richFromHtml`, altrimenti una riga di `text/plain` per paragrafo (righe vuote saltate). */
export function pasteBlocks(clip: { html: string | null; text: string }, makeId: () => string): ProductBlock[];
// pages/productDocs/editor/useEditorSession.tsx
export function useEditorSession(page: ProductPageView): {
  sessionId: string;
  save(ops: ProductBlockOp[]): void;          // in fila, una alla volta
  state: "idle" | "saving" | "saved" | "error";
  retry(): void;
  undo(): void; redo(): void;                 // solo le operazioni di questa sessione
  canUndo: boolean; canRedo: boolean;
  /** L'ultimo ⌘Z/⇧⌘Z saltato perché altri hanno cambiato quei blocchi. */
  skipped: boolean;
};
// pages/productDocs/editor/undo.ts — pura (shape [PE 21], maintainer 5 nov 2026)
export interface UndoEntry {
  forward: ProductBlockOp[]; backward: ProductBlockOp[];
  /** I blocchi toccati prima e dopo (`null` = non c'era / non c'è). */
  before: Record<string, ProductBlock | null>; after: Record<string, ProductBlock | null>;
}
export interface UndoStack { undo: UndoEntry[]; redo: UndoEntry[] }
/** La voce di una scrittura della sessione; `null` se non cambia niente. Un blocco eliminato torna con un id nuovo (`makeBlockId`): gli id non si riusano. */
export function undoEntryOf(blocks: readonly ProductBlock[], ops: readonly ProductBlockOp[], makeId: () => string): UndoEntry | null;
/** Si può annullare (o rifare) solo se i blocchi toccati sono ancora com'erano dopo (o prima). */
export function stillAsLeft(blocks: readonly ProductBlock[], expected: Record<string, ProductBlock | null>): boolean;
export function pushEntry(stack: UndoStack, entry: UndoEntry): UndoStack; // svuota `redo`, al più 100 voci
```

Regole:
- un blocco di testo è un `contenteditable` **controllato** (`RichBlock`):
  `RichView` lo disegna da `RichText` (grassetto `<strong>`, corsivo `<em>`,
  link `<a>` col solo `href` validato, i codici con `CodeLink`, aperti solo
  fuori dal fuoco); ogni `beforeinput` si annulla (`preventDefault`) e
  passa da `applyInput`; il cursore si rimette con `placeCaret`. Il DOM non
  è mai la fonte: un nodo estraneo (un'estensione, il correttore) si butta
  al ridisegno. L'IME (`compositionstart`…`end`) scrive alla fine della
  composizione;
- la barra della selezione (`SelectionBar`) su una selezione non vuota in
  un blocco: Bold, Italic, Link, Comment (Task 10); ⌘B / ⌘I; ⌘K resta la
  palette. «Link» apre `LinkField`: un indirizzo che `safeLinkHref` rifiuta
  dice «Only http and https links» / «Solo link http e https» e non
  scrive; un link letto si apre col browser di sistema
  (`window.open` → `setWindowOpenHandler`), mai nella finestra;
- si salva all'uscita dal blocco, a ogni gesto di struttura (dividere,
  unire, «/», spostare) e dopo 800 ms senza tasti; le scritture vanno in
  fila (`useEditorSession`), «Saving…» / «Saved», l'errore con «Retry» che
  rimanda le stesse operazioni;
- Invio divide (`splitBlock`, id nuovo da `makeBlockId`), Backspace in testa
  unisce al precedente con l'operazione `merge` (Q3: i commenti seguono),
  ↑/↓ in prima/ultima riga cambiano
  blocco, Tab/⇧Tab rientrano un elenco, ⌥⇧↑/↓ spostano il blocco; Invio su
  un elemento d'elenco vuoto lo riporta a paragrafo;
- «/» in un blocco vuoto apre `SlashMenu` (filtro mentre si scrive, frecce,
  Invio, Esc che lascia «/» com'era); le scorciatoie `typeShortcut`
  cambiano il tipo appena scritte;
- incollare: `pasteBlocks`; dentro una frase una sola riga si inserisce al
  cursore coi suoi segni, più righe diventano blocchi dopo quello corrente;
- ⌘Z / ⇧⌘Z *(maintainer, 5 nov 2026, shape [PE 21])*: una pila per pagina
  e per sessione dell'editor, riempita **solo** da `save()` di questa
  sessione (le scritture altrui, anche dal vivo, non entrano); annullare
  manda `backward` con `saveProductBlocks` (una revisione come le altre),
  rifare `forward`; la pila si svuota cambiando pagina o persona. Se un
  blocco da annullare è stato cambiato da altri dopo (`stillAsLeft` falso
  sui blocchi di `useProductPage`), quel passo si salta e si toglie dalla
  pila, nessuna scrittura, e lo stato dice «Changed by someone else, not
  undone» / «Cambiato da altri, non annullato»;
- per chi legge soltanto nessun `contenteditable`: solo `RichView`.

I test guidano l'editor con `InputEvent("beforeinput", { inputType, data })`
sul blocco e la selezione messa con `placeCaret`: non dipendono dalla
selezione nativa di happy-dom oltre a quella.

Test:
- [ ] `applyInput`: `insertText` «x» a 3 → testo e cursore 4; con una
  selezione 0–5 la sostituisce; `deleteContentBackward` a 0 → `null` (lo
  prende `editorKey`); `formatBold` su 0–5 → `bold` 0–5; `insertParagraph`
  → `null`.
- [ ] `editorKey`: Invio a metà → `split` con l'offset; Backspace a 0 →
  `mergeWithPrevious`, altrove `none`; Invio con il menu «/» aperto →
  `none`; ⌥⇧↓ → `moveBlock down`; ⌘B → `toggleMark bold`; ⌘K → `none` (la
  palette).
- [ ] `pasteBlocks({ html: null, text: "One\n\nTwo\n- Three" })` → tre
  paragrafi «One», «Two», «- Three» (il testo incollato non diventa un
  elenco); con `html` `<p><strong>One</strong></p><p><a href="javascript:x">Two</a></p>`
  → «One» grassetto, «Two» senza link; ogni id dal generatore.
- [ ] `offsetOf`/`placeCaret` su un `RichView` con un grassetto e un codice
  in mezzo: lo scarto 12 cade nella stessa lettera all'andata e al ritorno.
- [ ] Laura scrive in un paragrafo di Sign-in, esce: una chiamata a
  `saveProductBlocks` con un `set` e la `sessionId` dell'editor; «Saved».
- [ ] Laura sceglie «only with Google», ⌘B: nel DOM un `<strong>` con quel
  testo, nel `set` salvato un `bold` 6–22 e il testo invariato; ⌘B di nuovo
  lo toglie. «Link» con `javascript:alert(1)`: la frase di rifiuto, nessuna
  scrittura; con `https://acq.example`: un `<a>` con quell'`href`, e
  nessun `<a>` del DOM ha un altro schema.
- [ ] Un nodo estraneo infilato nel `contenteditable` (un `<span
  style>` aggiunto dal test) sparisce al primo ridisegno e non arriva nel
  testo salvato.
- [ ] Invio a metà di «Login only with Google»: due blocchi, il primo con
  l'id di prima, il fuoco sul secondo col cursore in testa; Backspace in
  testa al secondo manda un `merge` e i due tornano uno, col fuoco allo
  scarto 10.
- [ ] «/» poi «tab» poi Invio: un blocco tabella 2×2 al posto del blocco
  vuoto; Esc lascia «/» nel blocco.
- [ ] «## Rules» → titolo 2 «Rules», nessun «#» visibile in nessun punto
  della pagina (né nel blocco in modifica né nella lettura).
- [ ] Il salvataggio fallito (`failNext("productDocs.saveProductBlocks")`):
  «Couldn't save · Retry»; Retry rimanda le stesse operazioni e dice
  «Saved».
- [ ] Il titolo: modificato e uscito, `renameProductPage`; vuoto, torna a
  quello di prima con la frase.
- [ ] `undoEntryOf`: un `set` dà `backward` = il `set` del blocco di prima;
  un `delete` dà un `insert` con un id **nuovo** (diverso da quello tolto);
  una scrittura che non cambia niente → `null`. `stillAsLeft` falso se il
  blocco è cambiato o sparito; `pushEntry` svuota `redo`.
- [ ] `editorKey`: ⌘Z → `undo`, ⇧⌘Z → `redo`.
- [ ] Laura scrive «x» in un paragrafo di Sign-in, esce, ⌘Z: un secondo
  `saveProductBlocks` con il testo di prima e la stessa `sessionId`;
  ⇧⌘Z lo rimette.
- [ ] Marco (copione, `writeProductBlocksAs`) cambia lo stesso blocco dopo
  Laura: ⌘Z di Laura non scrive, dice «Changed by someone else, not
  undone», e la pila non ha più quel passo. La scrittura di Marco non è
  nella pila di Laura (la condizione che il test prova: le due scritture
  hanno `sessionId` diverse).
- [ ] Sara: nessun `contenteditable` nella pagina, nessuna barra della
  selezione per i segni; grassetto, corsivo e link si leggono; i codici sono
  link per ciò che vede, tenui per `STW-…`.
- [ ] Commit `feat(desktop): l'editor a blocchi delle pagine di prodotto, coi segni, «/» e la tastiera`.

### Task 9: I blocchi del design e dei collegamenti: immagini, Drive, decisioni, tabelle, codici

Segue lo shape `product-editor.md`.

**Files:**
- Create: `pages/productDocs/editor/{ImageBlock,DriveBlock,DecisionBlock,TableBlock,LinkPicker,DrivePicker,DecisionPicker}.tsx`,
  `pages/productDocs/editor/images.ts`; test
  `pages/productDocs/editor/MediaBlocks.test.tsx`,
  `pages/productDocs/editor/images.test.ts`.
- Modify: `pages/productDocs/editor/{BlockEditor,SlashMenu}.tsx`; i18n
  `productDocs.blocks.*`.

**Interfaces, prodotte:**

```ts
// pages/productDocs/editor/images.ts
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Un file in un blocco immagine (`data:` URL), o il motivo del rifiuto. */
export function readImageFile(file: File): Promise<{ ok: true; src: string; alt: string } | { ok: false; reason: "too_large" | "unsupported" }>;
```

Regole:
- immagine: «/image», incolla dagli appunti, trascina un file sul blocco
  (va dopo il blocco su cui cade); la didascalia è un campo di testo sotto
  («Add a caption»); oltre 5 MB «This image is larger than 5 MB» / «Questa
  immagine supera i 5 MB», nessun blocco;
- Drive: «/drive» apre il selettore dei file del Drive del progetto (le
  stesse letture del Drive, mai un nascosto); il blocco mostra la riga
  (glifo, nome, codice) e «Open» con `useOpenDriveFile`; un file non più
  disponibile per chi legge: «This file is no longer available» e il solo
  codice;
- decisione: «/decision» sceglie una riga del registro del progetto; il
  blocco legge `ProductPageView.decisions` (titolo, data, chi) e apre la
  riga nel registro; `null` → «A decision you can't see» / «Una decisione
  che non puoi vedere», senza titolo;
- codici: «/link» apre `LinkPicker` (gli oggetti del menu `#`, Task 6), che
  scrive il codice nel testo al cursore; i codici scritti a mano valgono
  uguale;
- tabella: Tab / ⇧Tab fra le celle, «⋯» della tabella con Add row, Add
  column, Remove row, Remove column; ogni cella nuova ha il suo id
  (`makeBlockId`).

Test:
- [ ] `readImageFile`: un PNG di 10 KB → `data:image/png…`; 6 MB →
  `too_large`; un PDF → `unsupported`.
- [ ] Incollare un'immagine in Screens: un blocco immagine dopo il blocco
  col fuoco, didascalia vuota con «Add a caption»; scrivere la didascalia
  e uscire salva un `set`.
- [ ] Il blocco Drive di Overview: «Client brief.pdf · ACQ-F<n>», «Open»
  apre l'anteprima; nascosto il file nel Drive, il blocco dice «This file
  is no longer available» e mostra solo il codice.
- [ ] Il blocco decisione come Laura: «Sign-in only with Google», la data,
  chi; la fixture con `decisions[id] = null`: «A decision you can't see»,
  nessun titolo nel DOM (in minuscolo).
- [ ] «/link» poi «ACQ-1»: il codice entra nel testo al cursore; fuori dal
  fuoco è un `CodeLink` aperto.
- [ ] Tabella di Meter reading: Tab dall'ultima cella della riga va alla
  prima della riga dopo; «Remove row» toglie la riga con un `set` della
  tabella; le celle nuove hanno id diversi da tutti quelli della pagina.
- [ ] Commit `feat(desktop): immagini, file del Drive, decisioni, tabelle e codici nelle pagine di prodotto`.

### Task 10: Commenti, cronologia e seguire (UI)

Segue lo shape `product-comments-history.md`.

**Files:**
- Create: `pages/productDocs/comments/{CommentsColumn,CommentThread,CommentComposer,SelectionCommentButton}.tsx`,
  `pages/productDocs/history/HistoryPanel.tsx`,
  `pages/productDocs/FollowButton.tsx`; test
  `pages/productDocs/comments/Comments.test.tsx`,
  `pages/productDocs/history/HistoryPanel.test.tsx`.
- Modify: `pages/productDocs/ProductPageRoute.tsx` (barra: Follow,
  History, Comments); `pages/productDocs/editor/{RichBlock,SelectionBar}.tsx`
  («Comment» nella barra della selezione, il segno dell'ancora commentata); i18n
  `productDocs.comments.*`, `productDocs.history.*`, `productDocs.follow.*`.

Regole:
- «Comment» compare sulla selezione dentro **un** blocco (o cella):
  ancora = quell'id, `quote` = il solo testo scelto, senza segni (≤ 200);
  da tastiera «⋯» del blocco → «Comment», con la frase intera;
- dopo un'unione (Q3) i fili del blocco assorbito stanno accanto al blocco
  unito, con la loro frase citata;
- la casella con @menzioni usa `SuggestionMenu` di `MentionMenu.tsx` con
  `useProductMentionCandidates`;
- la colonna: fili aperti allineati al loro blocco, «Frase eliminata» /
  «Sentence deleted» con la frase citata in fondo agli aperti, «N resolved»
  chiuso, «Reopen»;
- `?comment=<id>` apre la colonna su quel filo e ci mette il fuoco (il link
  della notifica);
- la cronologia: `useProductRevisions`, dalla più recente; ogni riga dice
  chi, quando (`formatDate`), cosa; aperta, «Before» / «After» per ancora
  (testo con `RichView`, coi segni; un cambio di soli segni si legge come
  «Formatting changed» / «Formattazione cambiata»; immagine: «Image: <didascalia>»; tolta: solo
  «Before»; aggiunta: solo «After»). Il 11b ci aggiunge «per conto di»,
  fonte e «Annulla»: qui non c'è;
- «Follow» / «Following» con `aria-pressed`, anche per chi legge soltanto;
- la colonna dei commenti *(maintainer, 5 nov 2026, shape [PC 14])*: si apre
  da sola aprendo una pagina con fili aperti, chiusa senza; aprirla o
  chiuderla a mano si ricorda **per persona**, in `localStorage`
  (`stubwise.productComments.<personId>` = `open` | `closed`) dentro
  try/catch, e prevale sull'apertura automatica; senza archivio vale la
  regola automatica. A 1024 è sovrapposta 360 e col pannello della task
  vince l'ultimo aperto ([PE 22]).

Test:
- [ ] Laura sceglie «only with Google» in Sign-in → «Comment» → scrive
  «@Mar» e sceglie Marco Bellini → il filo nella colonna con la frase
  citata (senza segni, anche se la frase è in grassetto); Marco ha la
  notifica `product_doc.mention` (Q1), e il suo clic apre la pagina col filo.
- [ ] Il filo di Phases: «Sentence deleted» / «Frase eliminata» e la frase;
  si risponde ancora.
- [ ] Unione nella UI (Q3): Backspace in testa a «with Google», che ha un
  filo: un blocco solo, il filo accanto a lui, nessun «Sentence deleted».
- [ ] Cronologia: un grassetto messo da Laura è una riga «Formatting
  changed»; una fixture di revisione con blocchi senza `marks` nel
  `content` non rompe il pannello.
- [ ] «Resolve» chiude il filo in «1 resolved»; «Reopen» lo riporta; il
  fuoco torna al bottone che ha aperto.
- [ ] Sara: legge i fili, nessuna casella, nessun «Resolve», nessun
  «Comment» sulla selezione; la riga della sola lettura con «Who?».
- [ ] `#/p/ACQ/docs/product/<Sign-in>?comment=<id>`: colonna aperta, fuoco
  sul filo.
- [ ] Cronologia di Meter reading: la riga di Marco del copione «Edited 1
  sentence» / «Ha modificato 1 frase» con «After» e il testo; la riga
  `create`; una riga `rename` «Renamed from …»; una fixture senza `via` né
  `sessionId`, apposta, si disegna.
- [ ] «Follow» su Bills come Sara: «Following», premuto; ricaricata la
  pagina resta.
- [ ] Colonna (PC 14): Sign-in (fili aperti) la apre da sola, Overview (nessun
  filo) no; Laura la chiude su Sign-in, apre Bills: chiusa (ricordato per
  persona); come Marco, Sign-in si apre da sola; con `localStorage` che
  lancia, la pagina si disegna con la regola automatica.
- [ ] Commit `feat(desktop): commenti con menzioni, cronologia e «Segui» nelle pagine di prodotto`.

### Task 11: La scrittura dal vivo (UI)

Segue lo shape `product-editor.md`.

**Files:**
- Create: `pages/productDocs/live/{PresenceAvatars,RemoteCursor,RemoteBlockNote}.tsx`;
  test `pages/productDocs/live/Live.test.tsx`.
- Modify: `pages/productDocs/ProductPageRoute.tsx` (`useJoinProductPage`,
  gli avatar), `pages/productDocs/editor/{RichBlock,BlockEditor}.tsx` (la
  presenza di chi guarda con `useSetProductPresence`, al più una ogni 150
  ms; i cursori degli altri); `styles/tokens.css` (`--presence-1`…`--presence-6`,
  chiaro e scuro, dalle tinte dei reparti 1–6 con nomi propri, usati solo
  nell'editor e sempre accanto al nome: «The Presence Exception» di
  `apps/desktop/DESIGN.md`, shape [PE 17]); i18n `productDocs.live.*`.

Regole:
- gli avatar in cima: gli altri presenti (non chi guarda), al più 4 e «+N»,
  col nome nel `title` e nell'etichetta accessibile;
- un cursore altrui nel testo letto: una barra del suo colore all'offset,
  con l'etichetta del nome (non solo il colore: il nome c'è sempre); una
  selezione altrui evidenziata;
- l'altro nello **stesso** blocco di chi scrive: niente barra dentro il
  blocco in modifica, ma la nota «Marco Bellini is writing here» / «Marco Bellini
  sta scrivendo qui» sul bordo del blocco; il testo e il cursore di chi
  guarda non cambiano mentre ha il fuoco: le scritture altrui su quel blocco
  arrivano all'uscita, e il salvataggio di chi guarda vale per ultimo
  (Review Focus 1);
- le scritture altrui sugli altri blocchi arrivano subito (l'iscrizione
  `blocks` ricarica la pagina, i blocchi senza fuoco si ridisegnano);
- reduced-motion: niente lampeggio del cursore.

Test:
- [ ] Laura apre Meter reading con `setLatency(0)`: gli avatar di Marco e
  Matteo; a copione finito resta Matteo.
- [ ] A metà copione: la barra di Marco con l'etichetta «Marco Bellini»
  nel paragrafo nuovo di «Rules»; il paragrafo cresce pezzo per pezzo.
- [ ] Laura col fuoco nello stesso paragrafo: «Marco Bellini is writing
  here» sul bordo, il testo del blocco resta quello di Laura finché non
  esce; uscita, la pagina ha il testo di Laura e la cronologia le due
  revisioni.
- [ ] Laura cambia persona col «vedi come»: la sua presenza sparisce
  (leave), quella della persona nuova arriva; chi non vede ACQ vede la
  pagina «non trovata» e nessun avatar.
- [ ] Commit `feat(desktop): cursori e avatar della scrittura dal vivo nelle pagine di prodotto`.

### Task 12: Esportare in PDF e Word

Segue lo shape `product-space.md` (il menu e gli stati).

**Files:**
- Create: `domain/productDocs/exportModel.ts`,
  `pages/productDocs/export/{ExportMenu,PrintView,exportProduct,docx}.tsx`,
  `platform/saveFile.ts`; test `domain/productDocs/exportModel.test.ts`,
  `pages/productDocs/export/docx.test.ts`,
  `pages/productDocs/export/Export.test.tsx`.
- Modify:
  - `src/main/security.ts` + `src/main/security.test.ts`: la validazione
    pura del canale;
  - `src/main/index.ts`: `ipcMain.handle("file:save", …)`;
  - `src/preload/index.ts`: `saveFile`; `src/renderer/env.d.ts`;
  - `styles/index.css`: `@media print` che mostra solo `#print-root` quando
    `body[data-printing]`;
  - `apps/desktop/package.json` (`docx`, con `pnpm --filter
    @stubwise/desktop add docx`) e `pnpm-lock.yaml` (solo così);
  - i18n `productDocs.export.*`.

**Interfaces, prodotte:**

```ts
// src/main/security.ts — pure
export type SaveFormat = "pdf" | "docx";
export type SaveFileRequest = { format: "pdf"; name: string } | { format: "docx"; name: string; data: Uint8Array };
export type SaveFileResult = { saved: true } | { saved: false; reason: "canceled" | "invalid" | "failed" };
export const MAX_SAVE_BYTES = 25 * 1024 * 1024;
/** `null` = rifiutata: formato ignoto, nome vuoto o > 120, `data` assente/estraneo/troppo grande, campi in più. */
export function parseSaveFileRequest(v: unknown): SaveFileRequest | null;
/** Un nome di file, mai un percorso: via separatori, caratteri di controllo, «..», `<>:"|?*`; spazi compressi; l'estensione giusta in coda. */
export function safeFileName(name: string, format: SaveFormat): string;
export function saveFilterFor(format: SaveFormat): { name: string; extensions: string[] };
/** Il percorso scelto con l'estensione del formato (aggiunta se manca). */
export function withExtension(path: string, format: SaveFormat): string;
// src/preload/index.ts → window.stubwise.saveFile(req: SaveFileRequest): Promise<SaveFileResult>
// platform/saveFile.ts
/** Con `window.stubwise.saveFile` il canale; senza (preview:web, test) PDF = `window.print()`, Word = un `Blob` coi byte e `a[download]`, come `downloadText`. */
export function saveExport(req: SaveFileRequest): Promise<SaveFileResult>;
// domain/productDocs/exportModel.ts — pura
export interface ExportDoc {
  title: string;
  pages: { code: string; title: string; depth: number; blocks: ExportBlock[] }[];
}
/** Un pezzo di frase coi suoi segni (da `richSegments`; un codice è testo semplice). */
export interface ExportRun { text: string; bold: boolean; italic: boolean; href: string | null }
export type ExportBlock =
  | { kind: "heading"; level: 1 | 2 | 3; runs: ExportRun[] }
  | { kind: "paragraph" | "quote"; runs: ExportRun[] }
  | { kind: "list"; ordered: boolean; indent: 0 | 1 | 2; runs: ExportRun[] }
  | { kind: "todo"; checked: boolean; runs: ExportRun[] }
  | { kind: "divider" }
  | { kind: "table"; rows: ExportRun[][][] }
  | { kind: "image"; src: string; caption: string }
  | { kind: "file"; line: string };
/** Pagina o spazio intero (ordine dell'albero), come lo legge chi esporta; grassetto, corsivo e link sì (ogni `href` ripassa da `safeLinkHref`); mai commenti, presenza o segni di Claude. */
export function exportModelOf(input: { title: string; pages: { page: ProductPage; depth: number }[] }, resolve: { driveLine(fileId: string, code: string): string; decisionLine(decisionId: string): string }): ExportDoc;
// pages/productDocs/export/docx.ts
export function buildDocx(doc: ExportDoc): Promise<Uint8Array>;
```

Il processo principale, alla richiesta: `parseSaveFileRequest` (`invalid`
se `null`); la finestra da `BrowserWindow.fromWebContents(event.sender)`
(nessuna → `invalid`); per il PDF `event.sender.printToPDF({
printBackground: true, pageSize: "A4" })`; `dialog.showSaveDialog(win, {
defaultPath: join(app.getPath("downloads"), safeFileName(...)), filters:
[saveFilterFor(...)] })`; annullata → `canceled`; `writeFile(withExtension
(...))`; un errore → `failed`. Il percorso non torna mai al renderer.

Il renderer: «Export ▾» → This page / Whole space × PDF / Word. Per il PDF
monta `PrintView` in `#print-root` (portale), mette `body.dataset.printing`,
chiama `saveExport`, poi smonta. Per il Word `buildDocx` →
`saveExport`. Nomi: «ACQ-D31 Sign-in» per una pagina, «ACQ Product» /
«ACQ Prodotto» per lo spazio (`safeFileName` li pulisce di nuovo nel main).
Immagini nel Word: PNG, JPEG e GIF decodificati dal `data:` URL; un WebP
esce con la sola didascalia (detto nell'avviso finale «1 image was left out
of the Word file»). I segni nel Word: `TextRun` con `bold` / `italics`, il
link con `ExternalHyperlink`; nel PDF `PrintView` disegna gli stessi
`ExportRun` (`<strong>`, `<em>`, `<a>`), così le due uscite leggono un
modello solo. `buildDocx` si prova anche con una funzione pura
`docxRunsOf(runs: ExportRun[])` che restituisce le descrizioni dei pezzi
(`{ text, bold, italics, link }`), esportata accanto.

Test:
- [ ] `parseSaveFileRequest`: `{ format: "pdf", name: "x" }` ok; `docx`
  senza `data`, con `data` stringa, con 26 MB, `format: "exe"`, nome vuoto,
  nome di 121 caratteri, un campo in più (`path`) → `null`.
- [ ] `safeFileName("Fatture 2026/27: regole", "pdf")` →
  `"Fatture 2026-27- regole.pdf"`; `"../../etc/passwd"` → nessun «/» né
  «..»; `"report.pdf"` in `docx` → `"report.pdf.docx"`; caratteri di
  controllo tolti; un nome che resta vuoto → `"Stubwise export.pdf"`.
- [ ] `withExtension("/Users/x/Desktop/Sign-in", "docx")` aggiunge
  `.docx`; con `.DOCX` lo lascia.
- [ ] `exportModelOf` dello spazio di ACQ: 8 pagine nell'ordine
  dell'albero con `depth`; nessun testo di commento né nome di chi è
  presente; il Drive come riga «File: Client brief.pdf (ACQ-F<n>)», la
  decisione come riga col titolo; come Sara, il codice `STW-…` resta testo
  e il file nascosto diventa «File: ACQ-F<n> (not available)». La frase di
  Overview esce con un pezzo `bold`, uno `italic` e uno con `href`
  `https://…`; un blocco di fixture con un link `javascript:` (scritto
  apposta nello stato, saltando la validazione) esce senza `href`.
- [ ] `docxRunsOf` della frase di Overview: `bold: true`, `italics: true` e
  un `link` con l'`https://` del seme; `buildDocx` del modello di Sign-in:
  byte che cominciano con `PK` (0x50 0x4B), non vuoti.
- [ ] `PrintView` di Overview: un `<strong>`, un `<em>` e un `<a>` con
  quell'`href`.
- [ ] Export, con un `window.stubwise.saveFile` finto: PDF di Sign-in →
  una chiamata `{ format: "pdf", name: "ACQ-D<n> Sign-in" }` con
  `#print-root` pieno durante la chiamata e vuoto dopo; Word dello spazio →
  `format: "docx"`, `data` `Uint8Array`; `canceled` → nessun avviso;
  `failed` → «Couldn't export · Retry», Retry rifà la stessa chiamata.
- [ ] Senza `window.stubwise`: il PDF chiama `window.print`, il Word scarica
  un file `.docx`.
- [ ] `main.test.ts` e `security.test.ts` di oggi restano verdi; nessun
  canale IPC nuovo oltre `file:save` (test sul sorgente di
  `src/main/index.ts` e `src/preload/index.ts`: i nomi dei canali sono
  `theme:changed`, i `menu:*` e `file:save`).
- [ ] Commit `feat(desktop): esportare una pagina o lo spazio Prodotto in PDF e Word`.

### Task 13: Documenti, parità, scatti, follow-up

- `apps/desktop/docs/area11-parity.md` (nuovo, gemello di
  `area10-parity.md`): il web non ha la doc di prodotto; una riga per voce
  del 11a (dove vive, test fra virgolette): spazio Prodotto, albero,
  documento a blocchi, editor, immagini, Drive, decisioni, codici,
  commenti e menzioni, cronologia, seguire, scrittura dal vivo,
  esportazione, ricerca/⌘K/chat, modulo Docs, nome `product` riservato. Per
  il prodotto vero: le tabelle (pagine, blocchi o documento jsonb con id
  stabili, revisioni, commenti, seguaci), il canale in tempo reale che il
  server non ha, l'esportazione lato server o client, il testo coi segni
  (`RichText`: testo più intervalli, gli `href` validati anche dal server,
  mai HTML salvato). **`product_doc.mention`** *(maintainer, 5 nov 2026,
  Q1)*: un `notification_kind` nuovo nello schema condiviso; **rollback**:
  finché ne esistono righe non si scende d'immagine sul server (500 su
  `/api/inbox`), la voce di deploy-log lo dice e indica la pulizia; **cambi
  additivi verso l'app**: il valore nuovo dell'enum arriva come `UNKNOWN`
  ai client vecchi grazie a `readerSchema`, ogni campo nuovo della card
  nasce facoltativo, titolo e corpo si derivano a lettura, e la fixture del
  test dell'app senza i campi nuovi c'è apposta.
- `capture.mjs`, scatti `a11a-*`:
  - DocsHome di ACQ e di `VRD`; MKX col modulo spento (Giulia, e il membro
    senza permesso del test del Task 7);
  - lo spazio di ACQ con l'albero, una pagina trascinata;
  - Sign-in in modifica con il menu «/» aperto, e con la barra della
    selezione e il campo del link (anche il rifiuto di un indirizzo);
  - la notifica `product_doc.mention` nell'inbox;
  - Screens con le immagini e le didascalie; Overview col blocco Drive;
    Client decisions coi blocchi decisione; Meter reading con la tabella;
  - la colonna dei commenti con un filo, una menzione nella casella, un filo
    «Frase eliminata», i risolti;
  - la cronologia aperta con «Before» / «After»;
  - Meter reading dal vivo: avatar, cursore di Marco, «Marco Bellini is
    writing here»;
  - Sara in sola lettura con «Who?» aperto;
  - il menu «Export» e l'avviso d'errore;
  - ⌘K con l'ambito «In Product».

  A 1440 chiaro e scuro, en e it; a 1024 `narrow-en` e `narrow-it`. Vite
  ucciso. Rifatti dopo ogni correzione visiva.
- `ossatura-follow-ups.md`:
  - «Area 11a — minori aperti», con le scelte del costruttore di questo
    piano, ognuna col costo se sbagliata (fra queste: nessuna libreria
    d'editor, il `contenteditable` controllato con `beforeinput` e il
    ridisegno dal modello; ⌘K lasciato alla palette (il link solo dalla
    barra); l'incolla che tiene solo grassetto, corsivo e link; l'unione
    delle revisioni per sessione dell'editor; niente modifica né
    eliminazione dei commenti; niente «Ripristina» nella cronologia; una
    pagina con sottopagine non si elimina; la chat di un repository senza
    le pagine di prodotto; la serie `-D` condivisa; il nome `product`
    riservato; il WebP fuori dal Word), e in fondo le decisioni del
    maintainer sulle domande Q1–Q4;
  - nelle invarianti da riscrivere prima del motore:
    - **§19** «Il corpo di una pagina di prodotto è un documento a blocchi
      con id stabili che non si riusano mai; ogni ancora (commento,
      presenza, segno) sta su un id di blocco o di cella; unendo due
      blocchi le ancore del secondo passano al blocco unito, un'ancora
      cancellata si dice "Frase eliminata"; il testo di una frase è testo
      più segni a intervalli, e un link è solo http(s)» (accanto a «Un
      commento eliminato non ha più testo»);
    - **§20** «L'app desktop esce dal renderer verso il disco solo dal
      canale `file:save`, validato nel processo principale; il percorso
      scelto non torna al renderer»;
    - la nota che il 11b scrive §21 (l'apertura di email e riunioni private
      nella doc, accanto a `mailbox_owner`, decisione 1 della spec).
- `emptyInstance.test.tsx`: sull'istanza vuota i Docs non hanno spazi
  Prodotto, ⌘K non trova pagine di prodotto, nessun copione parte.
- Suite, typecheck, lint e build verdi.
- Commit `docs(desktop): note dell'area 11a`.

Dopo il Task 13: revisione finale del branch (area 11a) e revisione visiva
di Impeccable.

---

## Cosa il piano 11b consuma

Il 11b non cambia queste interfacce: le usa, e aggiunge in coda ai tipi.

- **Il documento a blocchi** (Task 1): `ProductBlock` (il 11b aggiunge
  `wireframe`), `ProductBlockOp` (compreso `merge`), `applyBlockOps`,
  `blockChanges` (con `mergedFrom`), `anchorIdsOf`, `anchorText`,
  `makeBlockId`; `SLASH_ITEMS` (il 11b aggiunge `wireframe`).
- **Il testo coi segni** (Task 1): `RichText` e `InlineMark` per blocco e
  per cella; una modifica di Claude cambia solo le frasi toccate **con i
  loro segni** (`insertText`, `deleteRange`, `concatRich`), e «Annulla»
  rimette il `before` intero, segni compresi; `safeLinkHref` vale anche per
  un link scritto da Claude; `richSegments` per il segno a margine e la
  cronologia.
- **Le ancore che si spostano** (Task 2): `onAnchorsMerged(fn)` — il segno a
  margine del 11b ci si aggancia come i commenti, così un'unione porta
  anche il segno sul blocco unito.
- **La strada di scrittura** (Task 2): `writeProductBlocksAs(me, pageId,
  ops, { via: "claude", source, kind, groupId, undoOf })` — una modifica di
  Claude su più blocchi è una revisione con un `groupId` («Annulla tutto»),
  `actorId` = il titolare della fonte o il Claude collega (decisione 2);
  `createProductPage` per l'albero della prima versione.
- **Le revisioni** (Task 2): `ProductRevision` con `actorId`, `via`,
  `source: ProductSourceRef`, `kind` (`undo`, `first_version`, `answer`),
  `undoOf`, `groupId`; `touchedAfter(pageId, anchorId, seq)` per il «toccata
  da altri» di «Annulla» e del segno; `listProductRevisions` per la
  cronologia, dove il 11b aggiunge «per conto di», la fonte e «Annulla».
- **Le ancore dei commenti** (Task 4): `ProductComment.anchorId` e `quote`,
  `anchorGone` derivato; il 11b aggiunge `question?` e le risposte, e il
  segno a margine usa la stessa ancora.
- **Il segnale dal vivo** (Task 5): `writersNear(pageId, anchorId)` per
  «Claude non modifica una sezione in cui qualcuno sta scrivendo»,
  `onProductPresence(fn)` per riprovare quando la sezione si libera,
  `sectionOf` / `sectionRange` / `inSectionOf` per la definizione di sezione
  della decisione 4.
- **Chi segue** (Task 2): `followersOf(pageId)` e
  `productDocRecipients(pageId)` per `product_doc.updated` e
  `product_doc.question` (spec «Avvisi»); la forma di
  `product_doc.mention` (Task 4: composizione a lettura, `objectGone`) è il
  modello delle due card del 11b.
- **Ricerca e chat** (Task 6): `productAnswerPage` e `readableProductPages`
  per le fonti delle risposte del progetto e per S0.
- **Esportazione** (Task 12): `exportModelOf` (il 11b aggiunge le bozze di
  schermata come immagini) e `saveExport`.

---

## Decisioni del maintainer sulle domande del piano (5 nov 2026)

Ognuna è segnata nel testo come *(maintainer, 5 nov 2026, Qn)*.

1. **Q1 — una @menzione avvisa la persona** *(maintainer, 5 nov 2026)*:
   notifica diretta `product_doc.mention`, terzo `notification_kind`
   dell'area oltre ai due del 11b, con la regola di rollback e i cambi
   additivi verso l'app in parità. Global Constraints, Task 0
   (`product-comments-history.md`), Task 4, Task 10, Task 13.
2. **Q2 — grassetto, corsivo e link dentro una frase, come in Notion**
   *(maintainer, 5 nov 2026)*: il testo di ogni frase è `RichText` (testo
   più segni a intervalli), gli id dei blocchi restano la verità, i link
   sono solo http(s). L'editor diventa un `contenteditable` controllato per
   blocco, senza libreria. Tech Stack, Global Constraints, Review Focus 3,
   Task 0 (`product-editor.md`), Task 1, Task 2, Task 3, Task 6, Task 8,
   Task 10, Task 11, Task 12, Task 13.
3. **Q3 — unendo due blocchi, i commenti del secondo passano al blocco
   unito** *(maintainer, 5 nov 2026)*: non diventano «Frase eliminata»,
   che resta per un'ancora cancellata. L'operazione `merge` e
   `onAnchorsMerged`. Global Constraints, Review Focus 2, Task 1, Task 2,
   Task 4, Task 8, Task 10, Task 13.
4. **Q4 — l'interruttore «Docs» sta in Settings → General** *(maintainer, 5
   nov 2026)*: spento, nasconde Docs e Prodotto e tiene le pagine;
   riacceso, le pagine ci sono. Task 2, Task 7.

## Decisioni del maintainer sugli shape del Task 0

Gli shape `product-space.md`, `product-editor.md` e
`product-comments-history.md` sono approvati *(maintainer, 5 nov 2026)*,
con la risposta consigliata a tutte e cinque le domande:

1. **Colori della presenza** (`product-editor.md`): sei token
   `--presence-1…6`, solo dentro l'editor, sempre accanto al nome;
   l'eccezione è scritta in `apps/desktop/DESIGN.md` («The Presence
   Exception»). Task 11.
2. **Commenti e cronologia a 1024** (`product-editor.md`): colonna
   sovrapposta 360 dal bordo destro; col pannello della task vince l'ultimo
   aperto; il riquadro di Claude sta alla sua sinistra. Task 10.
3. **⌘Z / ⇧⌘Z** (`product-editor.md`): annulla e rifà per pagina e per
   sessione dell'editor, sulle stesse `ProductBlockOp`, solo le operazioni
   della propria sessione. Task 8.
4. **La colonna dei commenti a 1440** (`product-comments-history.md`): si
   apre da sola se la pagina ha fili aperti; il gesto a mano si ricorda per
   persona. Task 10.
5. **Chi segue** (`product-comments-history.md`): solo chi crea la pagina e
   chi preme «Follow»; commentare o essere menzionati non fa seguire.
   Task 4.

Approvate anche le scelte del costruttore negli shape, fra cui: la barra
unica della pagina e il suo ordine (stato di salvataggio, avatar, Follow,
Comments, History, Export, «⋯»); nell'albero Invio apre e F2 rinomina
(Invio salva dentro la rinomina); al più una colonna a destra della lettura
(commenti, cronologia o pannello della task); il gruppo «Code» al posto di
«Spaces» e la prima pagina radice del Prodotto in START HERE.
