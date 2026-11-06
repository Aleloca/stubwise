# Shape brief — Il segno di Claude, la cronologia delle sue modifiche e i due avvisi

> Shape scritto dal costruttore senza intervista (6 nov 2026), dalla spec
> dell'area 11 («Il segno e la cronologia», «Avvisi», decisioni 1, 2, 4, 5,
> 9, 10), dal piano 11b (Global Constraints «La fonte vista da chi legge»,
> «Il segno», «Notifiche nuove»; Task 3, Task 9, parte UI del Task 10;
> Review Focus 3 e 4) e dagli shape `product-editor.md`,
> `product-comments-history.md`, `claude-drafts.md`, `claude-trace.md`,
> `claude-actions.md`, che **non riscrive**: qui c'è solo ciò che il 11b
> aggiunge. Ogni scelta che non viene dal maintainer è marcata *(scelta del
> costruttore)*; le regole sono numerate **[PM n]**. Le domande aperte sono
> in fondo.

Superficie:
- `pages/productDocs/claude/ProductClaudeMark.tsx` — il segno, chiuso e
  aperto, dentro `BlockShell`;
- `pages/productDocs/claude/SourceLine.tsx` — la fonte nelle sue forme, una
  sola resa per segno, cronologia, card, Home, riga della prima versione;
- `pages/productDocs/history/HistoryPanel.tsx` — le righe di Claude,
  «Undo» / «Undo all», «Undone by», la risposta a una domanda, la prima
  versione;
- `notifications/NotificationItem.tsx` — `composedOf` per
  `product_doc.updated` (le domande: `product-claude-questions.md`).
- `tasks-ui/ClaudeDraftMark.tsx` **non cambia** (né il file né i suoi test).

Piano 11b: Task 3 (dati), Task 9 (UI), Task 10 (card). Mondo: «Catalogo
numerato», modalità **Operate**; il testo prima e dopo è **Read**. Nomi del
seme: il piano scrive «Laura Conti», nel seme è **Laura Costa** (`p-laura`);
qui si usa il nome del seme. Codici: `ACQ-D5` Sign-in, `ACQ-D6` Bills,
`ACQ-D7` Meter reading, `ACQ-D8` Fault reports, `ACQ-D10` Client decisions,
`ACQ-D11` Phases (seme del 11a).

## 1. Lavoro e pubblico

- **Laura Costa** (Project Lead di ACQ, `docs.edit`) apre «Sign-in» il
  lunedì: vuole vedere **subito** cosa ha cambiato Claude, da dove viene, e
  poterlo tenere o togliere in un gesto.
- **Marco Bellini** (`docs.edit`) ha riscritto una frase che Claude aveva
  cambiato: non deve poter perdere il suo testo per un «Annulla» altrui.
- **Sara Montanari** (Contributor, solo `docs.view`) legge la stessa
  pagina: vede che una frase è di Claude e da dove viene, ma **non** il
  contenuto di un'email che non ha ricevuto (decisione 1).
- Stato d'animo: fiducia sorvegliata. Il rischio che il maintainer teme di
  più è il cambio che nessuno nota; il secondo è la decisione inventata. Il
  segno esiste per il primo, la fonte per il secondo.

## 2. Esito e prova

- **Successo**:
  - Laura apre «Sign-in»: accanto a «Login only with Google» c'è il segno a
    margine; un clic lo apre: «Updated by Claude · on behalf of Laura
    Costa · Nov 4», «From the email “Login: confirmation” · Nov 4»,
    **Looks good** · **Undo**. «Looks good»: il segno sparisce per tutti, il
    fuoco torna al blocco;
  - Sara apre la stessa pagina: lo stesso segno dice «From an email of
    Laura Costa · Nov 4», senza link; nessuna parola dell'oggetto in tutto
    il DOM (Review Focus 3); al posto dei bottoni la frase col «Who?»;
  - una modifica su tre blocchi, Marco ne ha toccato uno (Review Focus 4):
    il suo segno è sparito, in cronologia il suo «Undo» è spento con
    «Marco Bellini edited it afterwards», e così «Undo all»; gli altri due
    si annullano uno per uno dalla cronologia o dal loro segno;
  - Marco riceve la card «Claude updated ACQ-D5 · Sign-in», il clic lo
    porta alla pagina col segno aperto.
- **Verità del prodotto**:
  - **il segno si legge dal dato, non si deduce**: si vede se
    `listProductMarks` lo dà; «Undo» è acceso se `undo.enabled`; il perché
    e il nome vengono da `undo.reason` e `undo.byId`. La pagina non
    confronta revisioni;
  - **una sola frase per la fonte**: `sourceViewOf(me, ref)` compone
    l'etichetta; ogni superficie la mostra così com'è;
  - **il testo dell'email non compare mai**, in nessuna superficie;
    il titolare si nomina sempre (è un membro del progetto).

## 3. Direzione scelta

- **Tesi**: **una nota a margine, come un correttore che firma a matita**.
  Il segno sta **fuori** dalla colonna di lettura, sul margine destro, come
  la sigla di chi ha corretto una bozza stampata; aperto diventa una nota a
  piè del blocco con la stessa forma della nota «Claude's draft» dei campi
  ([DR 1]): una riga quieta, nessun fondo, nessuna cornice. Il testo resta
  al centro e non cambia aspetto **[PM 1]**.

### 3.1 Dove sta il segno

- **Le tre corsie del blocco**, da sinistra a destra (misure del 11a):
  - gutter sinistro 48: «+» e ⋮⋮ ([PE 4]), solo al passaggio;
  - il testo, ≤ 692 (la colonna di 720 meno i 28 a destra);
  - corsia dei commenti, 28 **dentro** la colonna: il glifo col numero dei
    fili ([PC 6]) e la nota «is writing here» ([PE 18]);
  - **corsia di Claude, 32 fuori dalla colonna** (il `pr-8` della colonna
    di lettura, che il 11a ha tenuto libero apposta): il segno **[PM 2]**.
- Così il segno non tocca mai la maniglia, non si sovrappone al glifo dei
  commenti e non va sotto la colonna laterale agganciata a 1440/1200 (la
  colonna sta **dopo** la lettura, non sopra).

### 3.2 Il segno chiuso

- **Forma**: l'anello di Claude **fermo** da 12px ([CT 2]) all'altezza
  della prima riga del blocco (`--block-pt`), e sotto di lui un **tratto**
  verticale tratteggiato 2px `ink-muted` (trattini 3/3) lungo tutta
  l'altezza del blocco meno 4px. Anello + tratto = «questa frase l'ha
  cambiata Claude»; il tratteggio è la stessa firma dell'anello, ed è ciò
  che lo distingue dal filetto pieno e neutro della citazione (che sta a
  sinistra, dentro la colonna) **[PM 3]** *(scelta del costruttore: il
  piano dice «un tratto»; l'anello in testa lo rende riconoscibile senza
  colore)*.
- È **un bottone**, area di clic 20px di larghezza per tutta l'altezza del
  tratto (al minimo 24px). Riposo `ink-muted`; passaggio e fuoco `ink`,
  tinta ink 6% sull'area; fuoco con l'anello di fuoco 2px. Tooltip dopo
  250ms: «Updated by Claude · Nov 4» / «Aggiornato da Claude · 4 nov».
- **Nome accessibile**: «Updated by Claude on behalf of Laura Costa. Open
  the change.» / «Aggiornato da Claude per conto di Laura Costa. Apri la
  modifica.»; per `CLAUDE_ID` senza «on behalf of». `aria-expanded` e
  `aria-controls` sulla nota aperta.
- **Un blocco non di testo** (immagine, file, decisione, tabella inserita da
  Claude): stesso segno, il tratto lungo tutto il blocco.
- **Tabella** con celle cambiate: **un** segno sulla tabella intera; aperto,
  elenca le celle (§3.3).
- **Chi lo vede**: tutti quelli che leggono la pagina, anche Sara
  (decisione 5: il segno sta nei dati). Nella pagina esportata no (spec
  «Esportazione»).
- **Un'unione** (Backspace in testa, Q3 del 11a) porta il segno sul blocco
  unito: il tratto si allunga al blocco nuovo, senza animazione.

### 3.3 Il segno aperto (la nota)

- Clic sul segno (o Invio/Spazio col fuoco): **sotto il blocco**, a tutta
  larghezza del testo (≤ 692), si apre la nota; il blocco dopo scende.
  Rientro sinistro 0, filetto `rule` di 1px a sinistra + 12px, 12/16 e
  13/18; nessun fondo, nessuna ombra **[PM 4]**. Una sola nota aperta per
  pagina: aprirne un'altra chiude la prima.
- **Righe**, dall'alto:
  1. l'anello fermo 12px · «Updated by Claude» / «Aggiornato da Claude»
     600 `ink` · « · on behalf of Laura Costa» / « · per conto di Laura
     Costa» `ink-muted` · « · Nov 4, 10:12» `ink-faint` tnum. Per
     `CLAUDE_ID`: «Updated by Claude · Nov 4, 10:12»;
  2. **la fonte** (`SourceLine`, §3.4), 12px;
  3. con più blocchi nello stesso gruppo: «Part of a change to 3
     sentences · See it in the history» / «Parte di una modifica a 3
     frasi · Vedila in cronologia» `ink-muted`; il link apre la cronologia
     con quella riga aperta (§3.6);
  4. **le azioni**, allineate a **sinistra** (restano a vista anche con la
     colonna sovrapposta a 1024, §5): **Looks good** / **Va bene**
     (secondario piccolo, con la spunta) · **Undo** / **Annulla** (bottone
     testo). Per una tabella, una riga per cella: «Row 2, column 1» /
     «Riga 2, colonna 1» · «Looks good» · «Undo».
- La nota **non ripete il testo** della frase: è lì sopra. Il prima e dopo
  sta in cronologia («See it in the history») *(scelta del costruttore: la
  nota resta di tre righe; chi vuole il confronto lo trova dove stanno
  tutti i confronti)*.
- **Si chiude** con Esc, col clic sul segno, aprendo un'altra nota, o dopo
  «Looks good» e «Undo». Il clic altrove **non** la chiude (è una nota, non
  un menu).

### 3.4 La fonte (`SourceLine`) nelle sue forme

Una sola resa, 12px `ink-muted`, testo che va a capo; i link 600 `ink`
sottolineati al passaggio; i codici con `CodeLink` (`quiet`, tnum). Le
etichette le compone `sourceViewOf` **[PM 5]**:

| Forma | en | it | Link |
|---|---|---|---|
| email che chi guarda apre | From the email “Login: confirmation” · Nov 4 | Dall'email «Login: conferma» · 4 nov | l'oggetto apre la conversazione in Posta |
| email di un altro | From an email of Laura Costa · Nov 4 | Da un'email di Laura Costa · 4 nov | nessuno; nessun oggetto, nessun testo |
| riunione che chi guarda vede | From the meeting “ACQ weekly” · Nov 3 | Dalla riunione «ACQ settimanale» · 3 nov | il titolo apre il Calendario su quell'evento |
| riunione che non vede | From a meeting of Laura Costa · Nov 3 | Da una riunione di Laura Costa · 3 nov | nessuno (l'organizzatore) |
| task | From **ACQ-14** Fix bill download | Da **ACQ-14** Fix bill download | `CodeLink` col nome |
| rilascio | From the release **ACQ-V7** | Dal rilascio **ACQ-V7** | `CodeLink` |
| decisione del registro | From the decision “Sign-in only with Google” · Oct 21 | Dalla decisione «Sign-in only with Google» · 21 ott | il titolo apre la riga nel registro |
| codice che chi guarda non vede | From **ACQ-14** | Da **ACQ-14** | codice tenue `ink-faint`, nessun nome, non link |
| decisione che non vede | From a decision you can't see | Da una decisione che non puoi vedere | nessuno |
| fonte che non c'è più | Source no longer available | Fonte non più disponibile | nessuno |

- Le decisioni del registro **non hanno un codice di catalogo** (il
  modello non ne ha): si citano col titolo e la data, come il blocco
  decisione del 11a ([PE 11]), e la forma invisibile riusa le parole di
  quel blocco *(scelta del costruttore: il piano dice «il CodeLink» per
  decisione, task e rilascio; per la decisione non c'è un codice da
  mostrare)*.
- **Divergenza dal riuso di `ClaudeDraftMark`**: la riga ha l'aspetto della
  riga «Used: …» (12px, codici 600 tnum quieti, a capo, «+N» oltre due
  fonti), ma **non** comincia con «Used:» / «Usati:». Qui la fonte è la
  **causa** della modifica, e l'etichetta di `sourceViewOf` comincia già con
  «From…» / «Da…» in tutte le superfici *(scelta del costruttore)*. Il
  componente di 10b resta intatto: `SourceLine` è un componente nuovo che
  ne copia le classi.
- **Mai** nel DOM di chi non apre l'email: l'oggetto, nemmeno in un
  `title`, in un `aria-label`, in un attributo `data-*` o in un nodo
  nascosto. Il test cerca in minuscolo in **tutta** la pagina.

### 3.5 «Looks good», «Undo» e i loro stati

- **Looks good** (`canAccept`): toglie il segno a **tutti** quelli che
  guardano; la cronologia tiene «Undo» acceso (decisione 9). In corso il
  bottone è spento con «Saving…» / «Salvataggio…» (un secondo clic non fa
  niente). Fatto: la nota si chiude, il segno sparisce (dissolvenza 150ms),
  annuncio `polite` «Marked as reviewed» / «Segnata come vista», il **fuoco
  va al blocco** (il gruppo `BlockShell`, `tabIndex=-1`, lo stesso anello
  dell'oggetto scelto con Esc, [PE 5]).
- **Undo** (`undo.enabled`): la frase torna esattamente a com'era (testo e
  segni), la riga «Undone by …» entra in cronologia, la nota si chiude.
  Annuncio `polite` «Undone: the sentence is back as it was» / «Annullata:
  la frase è tornata com'era»; **fuoco al blocco** tornato. Se l'«Undo»
  toglie un blocco **aggiunto** da Claude, il fuoco va al blocco prima (o
  all'h1 se era il primo). Un doppio clic fa **una** scrittura: il primo
  clic spegne il bottone («Undoing…» / «Annullo…»), il secondo trova
  `already_undone` e non scrive.
- **Stati spenti** (bottone con `aria-disabled`, la frase sotto, 12px
  `ink-muted`, `aria-describedby` sul bottone) **[PM 6]**:

| `undo` | Frase (en / it) | «Who?» |
|---|---|---|
| `changed_after`, `byId` Marco | **Marco Bellini** edited it afterwards / **Marco Bellini** l'ha modificata dopo | il nome **è** il chi: link alla scheda della persona; nessun `WhoCanLink` (è un fatto, non un permesso, come [PS 13]) |
| `changed_after`, `byId` nullo | It was edited afterwards / È stata modificata dopo | nessuno |
| `already_undone` | Already undone by Laura Costa / Già annullata da Laura Costa | nessuno |
| `no_permission` | (vedi la sola lettura qui sotto) | `WhoCanLink` `editDocs` |

- **Chi legge soltanto** (Sara, `canAccept: false`, `no_permission`):
  nessun bottone; al loro posto la frase 12px `ink-muted`: «Only people who
  can edit the Docs in ACQ can accept or undo it. · Who?» / «Solo chi può
  modificare i Docs di ACQ può accettarla o annullarla. · Chi?»
  (`WhoCanLink`, `editDocs`).
- **Errore** del livello finto: riga 12px `critical` con l'icona, `role=
  "alert"`: «Couldn't undo · Retry» / «Annullamento non riuscito ·
  Riprova» (o «Couldn't save · Retry» per «Looks good»); Retry rifà lo
  stesso gesto; il fuoco resta sul bottone.
- **Cambia sotto gli occhi** (un altro preme «Looks good», tocca la frase o
  annulla mentre la nota è aperta): la nota resta finché la si chiude, i
  bottoni spariscono e una riga dice cosa è successo: «Marco Bellini said
  it looks good» / «Marco Bellini ha detto che va bene», «Marco Bellini
  edited it» / «Marco Bellini l'ha modificata», «Undone by Marco Bellini» /
  «Annullata da Marco Bellini». Esc la chiude e il fuoco va al blocco.

### 3.6 La cronologia: le righe di Claude

Stessa colonna, stesse righe del 11a ([PC 9], [PC 10]); in più **[PM 7]**:

- **Riga di una modifica di Claude per conto di una persona**: iniziali
  della **persona** (20px, senza anello, [CT 6]) · «Claude on behalf of
  Laura Costa» / «Claude per conto di Laura Costa» 600 · ora; sotto l'ora
  l'anello fermo 12px con `title` «Made with Claude» / «Fatta con Claude»
  ([CT 3]). Seconda riga: «Edited 3 sentences» (il tipo del 11a). Terza
  riga: la **fonte** (`SourceLine`). *(Il piano scrive «Claude, on behalf
  of … · from an email»: la virgola cade per usare la stessa frase del
  registro, `changelog.via.actor`, [CT 1]; la fonte è la sua riga, non un
  «from an email» generico, perché la riga intera dice di più.)*
- **Claude collega** (`CLAUDE_ID`: decisione, task, rilascio): l'avatar di
  Claude · «Claude» 600 · ora, stesso anello sotto l'ora; il resto uguale.
- **«Undo» nella riga** (a destra della seconda riga, bottone testo):
  - un blocco solo: **Undo** / **Annulla**;
  - più blocchi: **Undo all** / **Annulla tutto**; aperta la riga, ogni
    ancora ha il suo **Undo** accanto all'etichetta «After», con lo stesso
    stato di §3.5. «Undo all» è spento con la stessa frase se **anche una**
    delle ancore è `changed_after` (Review Focus 4): la frase nomina chi e
    dice «Undo the others one by one» / «Annulla le altre una per una»;
  - sola lettura: nessun bottone e nessuna frase nella riga (la frase
    col «Who?» sta già nel segno; la cronologia si legge) *(scelta del
    costruttore: ripeterla su ogni riga sarebbe rumore)*.
- **Riga dell'annullamento** (`kind: "undo"`, `undoOf`): iniziali di chi ha
  annullato · nome · ora; seconda riga «Undid Claude's change» / «Ha
  annullato la modifica di Claude»; terza riga 12px `ink-muted` col segno
  ↺: «Undid: Claude on behalf of Laura Costa · Edited 3 sentences · Nov 4,
  10:12» / «Ha annullato: Claude per conto di Laura Costa · Ha modificato 3
  frasi · 4 nov, 10:12»; la data è un link che scorre alla riga annullata e
  la evidenzia 1,5s (tinta ink 10%, niente con movimento ridotto), come
  [CT 4]. Aperta: prima e dopo come ogni riga.
- **Sulla riga annullata**: al posto dell'«Undo», 12px `ink-muted` col
  segno ↺: «Undone by Laura Costa» / «Annullata da Laura Costa» (tutto il
  gruppo), oppure «1 of 3 undone · Laura Costa» / «1 di 3 annullate · Laura
  Costa» (in parte); nella riga aperta, l'ancora annullata ha «Undone» al
  posto del suo «Undo» *(scelta del costruttore)*.
- **Risposta a una domanda** (`kind: "answer"`, nessun `via`): iniziali di
  chi ha risposto · «Laura Costa, from Claude's question» / «Laura Costa,
  dalla domanda di Claude» 600 · ora; seconda riga «Edited 1 sentence»;
  terza riga «See the question» / «Vedi la domanda» (bottone testo):
  apre la colonna dei commenti **al posto** della cronologia ([PE 19]) sul
  filo risolto, fuoco al filo. **Nessun anello, nessun «Undo» di Claude**:
  è una modifica della persona (decisione 6).
- **Prima versione** (`kind: "first_version"`): iniziali della persona ·
  «Claude on behalf of Laura Costa» · ora, anello sotto l'ora; seconda riga
  «Wrote the first version» / «Ha scritto la prima versione»; terza riga
  «From: an email of Laura Costa · Nov 2, pasted text, **VRD-F1** Brief» /
  «Da: un'email di Laura Costa · 2 nov, testo incollato, **VRD-F1**
  Brief» (le prime due, poi «+N» col `title`). **Nessun «Undo» nella riga**:
  la prima versione si annulla tutta insieme dalla riga in cima alla
  pagina (`product-claude-questions.md` §3.6); al suo posto 12px
  `ink-faint` «Undo it from the line at the top of the page» / «Si annulla
  dalla riga in cima alla pagina» finché quella riga c'è *(scelta del
  costruttore)*. Aperta, la riga non elenca blocchi (sarebbe l'intera
  pagina): dice «The whole page» / «Tutta la pagina».
- **Annunci** `polite` come §3.5; dopo «Undo» o «Undo all» dalla
  cronologia il fuoco resta sulla riga (sul suo testo nuovo,
  `tabIndex=-1`), come [CA] «il fuoco resta sulla riga».

```
1440 · «Sign-in» di ACQ (Laura), segno aperto, commenti chiusi ────────────────────────────────────────
│rail│ ACQ      │ Product  Features › Sign-in       Saved  (MB)  Following  Comments 1  History  Export ▾  ⋯ │
│    │ …        ├─────────────┬──────────────────────────────────────────────────────────────────────────┤
│    │          │ PAGES 9     │        ACQ-D5 · Product                                                  │
│    │          │ ▾ Features  │        Sign-in                                                           │
│    │          │  ▌Sign-in   │        Updated Nov 4 by Laura Costa · Created by Laura Costa             │
│    │          │   Bills     │                                                                          │
│    │          │   …         │        How customers sign in                                             │
│    │          │             │        Login only with Google. Customers with an email      ▢1   ◌      │
│    │          │             │        account sign in with a link.                               ┆      │
│    │          │             │        │◌ Updated by Claude · on behalf of Laura Costa · Nov 4, 10:12    │
│    │          │             │        │From the email “Login: confirmation” · Nov 4                     │
│    │          │             │        │Part of a change to 3 sentences · See it in the history          │
│    │          │             │        │[✓ Looks good]  Undo                                             │
│    │          │             │        What the portal stores                                     ◌      │
│    │          │             │        Only the name and the email address that Google gives us.  ┆      │
```

```
1440 · stessa pagina vista da Sara (solo lettura) ──────────────────────────────────────────
│    │          │        Login only with Google. Customers with an email      ▢1   ◌      │
│    │          │        │◌ Updated by Claude · on behalf of Laura Costa · Nov 4, 10:12    │
│    │          │        │From an email of Laura Costa · Nov 4                             │
│    │          │        │Only people who can edit the Docs in ACQ can accept or undo it.  │
│    │          │        │Who?                                                             │
```

```
1440 · cronologia di «Sign-in», Review Focus 4 (colonna 296) ─
│ HISTORY                              × │
│ TODAY                                  │
│ LC Claude on behalf of      10:12 ▾    │
│    Laura Costa                ◌        │
│    Edited 3 sentences      Undo all    │
│    From the email “Login: confirm…     │
│    Marco Bellini edited one afterwards.│
│    Undo the others one by one.         │
│    ── Paragraph ──────────────         │
│    Before …  After …        Undo       │
│    Before …  After …   Marco Bellini   │
│                   edited it afterwards │
│    Before …  After …        Undo       │
```

### 3.7 La card `product_doc.updated`

Nella forma della card di menzione del 11a ([PC 12]), titolo e corpo
composti **a lettura** **[PM 8]**:

- **Riga del codice**: **ACQ-D5** (tnum 600) · «Product» / «Prodotto» · ora.
- **Titolo**: «Claude updated ACQ-D5 · Sign-in» / «Claude ha aggiornato
  ACQ-D5 · Sign-in».
- **Corpo** (al più 2 righe, intero nel `title`):
  - una fonte, per conto di una persona: «Claude on behalf of Laura Costa
    changed 3 sentences. From an email of Laura Costa · Nov 4.» / «Claude
    per conto di Laura Costa ha cambiato 3 frasi. Da un'email di Laura
    Costa · 4 nov.» (la fonte nella forma di chi **riceve**: Laura legge
    l'oggetto, Sara no);
  - `CLAUDE_ID`: «Claude changed 1 sentence. From ACQ-14 Fix bill
    download.» / «Claude ha cambiato 1 frase. Da ACQ-14 Fix bill
    download.»;
  - **una card per pagina con più fonti** (rilascio della coda): «Claude
    changed 4 sentences from 2 sources, after waiting for the budget.» /
    «Claude ha cambiato 4 frasi da 2 fonti, dopo aver aspettato il
    budget.»; sotto, una riga per fonte (`SourceLine`, al più 2 e «+N»).
    Nessun «on behalf of» nel corpo (le persone possono essere più d'una):
    lo dice la cronologia *(scelta del costruttore)*.
- **Annullata del tutto** dopo la pubblicazione: riga 12px `ink-muted`
  «↺ Undone by Laura Costa» sotto il corpo, senza data, nessuna seconda
  notifica ([CT 10]).
- **Clic**: se almeno un segno di quella revisione è ancora visibile, la
  pagina con `?mark=<ancora>` — il blocco scorre in vista e la sua nota si
  apre, fuoco sulla prima riga della nota (`tabIndex=-1`); altrimenti
  `?history=<revisione>` — la cronologia si apre con la riga aperta e il
  fuoco su di lei *(scelta del costruttore: l'indirizzo porta sempre a ciò
  che c'è ancora da vedere)*. A 1024 `?history=` apre la colonna
  sovrapposta (è un gesto, [PC 14]).
- **`objectGone`** (pagina eliminata, Docs spenti, chi riceve non legge
  più): titolo «A product page Claude updated» / «Una pagina di prodotto
  aggiornata da Claude», corpo «This page is no longer available.» /
  «Questa pagina non è più disponibile.», nessun codice, titolo, fonte né
  link (R-G5).
- Una fixture senza `productUpdate` non lancia: titolo e corpo del caso
  `objectGone`.

```
1440 · pannello notifiche (Sara) ─────────────────────
│ ● ACQ-D5 · Product · 10:14                         │
│   Claude updated ACQ-D5 · Sign-in                  │
│   Claude on behalf of Laura Costa changed 3        │
│   sentences. From an email of Laura Costa · Nov 4. │
```

## 4. Ambito e confini

- **Dentro**: segno chiuso e aperto, la fonte nelle sue forme, «Looks good»,
  «Undo» e i loro stati, le righe di Claude in cronologia, la card
  `product_doc.updated`.
- **Fuori**: la card `product_doc.question` e il filo-domanda
  (`product-claude-questions.md`); la riga della prima versione in cima
  alla pagina (idem); la bozza di schermata, che **non** ha il segno a
  margine: la sua etichetta «Claude's draft» è il suo segno finché non la
  si tiene («Keep»), e il livello
  dati non dà segni per i blocchi `wireframe` (`product-claude-backlog.md`
  §3.5) *(scelta del costruttore, da allineare nel Task 3)*.
- **Anti-obiettivi**:
  - un evidenziatore colorato o un fondo sulla frase cambiata;
  - un segno dentro la colonna dei commenti, o sopra la maniglia;
  - un «Undo» che cancella il testo di Marco;
  - l'oggetto o il testo di un'email in qualunque nodo per chi non la apre;
  - un «Who?» su un fatto («l'ha modificata dopo»);
  - un segno che sparisce perché qualcuno ha solo **letto** la pagina
    (spec: leggere da solo non basta).

## 5. Stati e intervalli, 1440 e 1024

- **Volumi**: 0–30 segni per pagina; un gruppo di 1–20 blocchi; nomi fino a
  40 caratteri, oggetti d'email fino a 120 (a capo nella nota, ellissi
  nella riga di cronologia col `title`, **solo** per chi apre l'email).
- **1440 e 1200**: il segno nella corsia di 32 a destra della colonna di
  lettura; con la colonna laterale agganciata (296) il segno resta fra la
  lettura e la colonna, a vista. La nota si apre nella colonna di lettura.
- **1024** **[PM 9]**: la colonna di lettura è tutta l'area (≤ 720). Il
  segno sta nella stessa corsia. La colonna dei commenti o la cronologia
  si aprono **solo con un gesto** e si sovrappongono (360) dal bordo
  destro ([PE 22], emendamento di [PC 14]): **coprono la corsia di
  Claude**. Aprire un segno **non** apre né chiude la colonna sovrapposta;
  la nota sta nella colonna di lettura, allineata a sinistra, con le azioni
  a sinistra, così resta leggibile nei ~312px scoperti accanto alla
  colonna aperta. «See it in the history» **apre** la cronologia
  sovrapposta (è un gesto) e chiude i commenti se erano aperti (una
  colonna alla volta). Col pannello della task aperto vince l'ultimo
  aperto, come oggi.

```
1024 · «Sign-in» (Laura), cronologia sovrapposta 360, segno aperto ──────
│rail│ ACQ        │ Pages  Product › Sign-in  │ HISTORY                 × │
│    │ …          ├───────────────────────────┤ TODAY                     │
│    │            │   Login only with Google. │ LC Claude on behalf  10:12│
│    │            │   Customers with an email │    of Laura Costa    ◌    │
│    │            │   account sign in with a  │    Edited 3 sentences     │
│    │            │   │◌ Updated by Claude ·  │              Undo all     │
│    │            │   │on behalf of Laura Cos…│    From the email “Login… │
│    │            │   │From the email “Login: │                           │
│    │            │   │confirmation” · Nov 4  │                           │
│    │            │   │[✓ Looks good]  Undo   │                           │
```

- **Caricamento**: i segni arrivano con la pagina (nessuno scheletro
  proprio). **Errore** della lettura dei segni: nessun segno e, in cima
  alla colonna di lettura, la riga 12px «Couldn't load Claude's changes ·
  Retry» / «Modifiche di Claude non caricate · Riprova» *(scelta del
  costruttore: meglio dirlo che mostrare una pagina senza segni)*.
- **Cambio di persona** («vedi come»): la nota aperta si chiude, i segni si
  rileggono con la vista nuova (la fonte cambia forma).

## 6. Tastiera e fuoco

- Il segno è nel gruppo del blocco, **dopo** il glifo dei commenti: chi
  legge soltanto ci arriva con Tab; chi scrive, che dentro un blocco ha Tab
  per i rientri ([PE 5]), ci arriva con **Esc** (il blocco scelto come
  oggetto) e poi **Tab**, oppure dal menu del blocco ⋮⋮, che guadagna la
  voce **Claude's change** / **Modifica di Claude** subito dopo «Comment»
  quando il blocco ha un segno *(scelta del costruttore: nessuna
  scorciatoia nuova, ⌘J resta al riquadro)*.
- Aperta la nota, il fuoco va sulla sua prima riga (`tabIndex=-1`); Tab
  percorre fonte, «See it in the history», «Looks good», «Undo», «Who?».
- **Dopo ogni gesto**: «Looks good», «Undo» → il blocco (o il blocco prima,
  se è sparito); Esc → il segno; «See it in the history» → la riga in
  cronologia; Retry → lo stesso bottone. **Mai il body.**
- Cronologia: ↑/↓ fra le righe, Invio o → apre, ← chiude ([PC 13]); dentro
  una riga aperta Tab percorre gli «Undo» delle ancore.

## 7. Movimento

- Nota: apertura in altezza 150ms ease-out; il segno sparisce in
  dissolvenza 150ms; evidenziazione della riga annullata 1,5s.
- **Movimento ridotto**: tutto a zero. La nota compare e sparisce senza
  transizione, l'evidenziazione è una tinta fissa finché la riga ha il
  fuoco.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| segno | Updated by Claude · on behalf of {{name}} · Updated by Claude on behalf of {{name}}. Open the change. | Aggiornato da Claude · per conto di {{name}} · Aggiornato da Claude per conto di {{name}}. Apri la modifica. |
| gruppo | Part of a change to {{count}} sentences · See it in the history | Parte di una modifica a {{count}} frasi · Vedila in cronologia |
| azioni | Looks good · Undo · Undo all · Saving… · Undoing… | Va bene · Annulla · Annulla tutto · Salvataggio… · Annullo… |
| spento | {{name}} edited it afterwards · It was edited afterwards · Already undone by {{name}} · Undo the others one by one | {{name}} l'ha modificata dopo · È stata modificata dopo · Già annullata da {{name}} · Annulla le altre una per una |
| sola lettura | Only people who can edit the Docs in {{code}} can accept or undo it. · Who? | Solo chi può modificare i Docs di {{code}} può accettarla o annullarla. · Chi? |
| sotto gli occhi | {{name}} said it looks good · {{name}} edited it · Undone by {{name}} | {{name}} ha detto che va bene · {{name}} l'ha modificata · Annullata da {{name}} |
| annunci | Marked as reviewed · Undone: the sentence is back as it was | Segnata come vista · Annullata: la frase è tornata com'era |
| errori | Couldn't undo · Couldn't save · Retry · Couldn't load Claude's changes | Annullamento non riuscito · Salvataggio non riuscito · Riprova · Modifiche di Claude non caricate |
| tabella | Row {{row}}, column {{col}} | Riga {{row}}, colonna {{col}} |
| menu del blocco | Claude's change | Modifica di Claude |
| cronologia | Made with Claude · Undid Claude's change · Undid: … · Undone by {{name}} · {{done}} of {{count}} undone · {{name}}, from Claude's question · See the question · Wrote the first version · Undo it from the line at the top of the page · The whole page | Fatta con Claude · Ha annullato la modifica di Claude · Ha annullato: … · Annullata da {{name}} · {{done}} di {{count}} annullate · {{name}}, dalla domanda di Claude · Vedi la domanda · Ha scritto la prima versione · Si annulla dalla riga in cima alla pagina · Tutta la pagina |
| card | Claude updated {{code}} · {{title}} · Claude on behalf of {{name}} changed {{count}} sentences. · Claude changed {{count}} sentences from {{sources}} sources, after waiting for the budget. · A product page Claude updated · This page is no longer available. | Claude ha aggiornato {{code}} · {{title}} · Claude per conto di {{name}} ha cambiato {{count}} frasi. · Claude ha cambiato {{count}} frasi da {{sources}} fonti, dopo aver aspettato il budget. · Una pagina di prodotto aggiornata da Claude · Questa pagina non è più disponibile. |
| fonti | §3.4 | §3.4 |

## 9. Vincoli

- Nessun `can(` né `viewer` in `pages/productDocs/` (test del 11a): segno,
  bottoni e frasi leggono `ProductMarkView` e `ProductRevisionView`.
- `ClaudeDraftMark.tsx` e i suoi test: `git diff` vuoto.
- La corsia di Claude (32 a destra) resta riservata al segno: nessun altro
  elemento del 11b ci va.
- Nessun colore nuovo: anello e tratto sono ink (Hue-Neutral Claude Rule).
- Scatti `a11b-mark-*` (chiuso, aperto, Sara, spento, fonte sparita,
  1024 con la cronologia) e `a11b-history-*` (Undo all, Undone by, risposta,
  prima versione), più `a11b-inbox-updated-*`.

## Decisioni del maintainer (6 nov 2026)

1. **«Va bene» vale per una frase alla volta** *(maintainer, 6 nov 2026)*:
   ogni blocco ha il suo «Looks good», che toglie solo il suo segno; non
   c'è un «Looks good» per tutta la modifica, né nella nota né in
   cronologia. → §3.3, §3.5.

Emendamento (controller, 6 nov 2026, fix round 1 del Task 9): nella frase
di un «Undo» spento per `changed_after` il nome della persona («**Marco
Bellini** edited it afterwards») è testo in grassetto (600 `ink`), non un
link alla sua scheda: l'unica scheda di una persona (`/admin/people/…`) non
la apre chiunque legga la pagina, e la pagina non calcola permessi. Resta
il «chi» della frase, senza `WhoCanLink`. → §3.5, tabella degli stati spenti.

Le altre scelte marcate *(scelta del costruttore)* sono da approvare col
brief.
