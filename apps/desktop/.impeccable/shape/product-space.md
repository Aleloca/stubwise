# Shape brief — Lo spazio «Prodotto» dei Docs: pagina iniziale, albero, barra della pagina, esportazione, ⌘K

> Shape scritto dal costruttore senza intervista (5 nov 2026): il brief
> nasce dalla spec dell'area 11, dal piano 11a (Task 0, Global
> Constraints, decisioni Q1–Q4) e dagli shape `docs.md`, `drive.md`,
> `claude-drafts.md`, `claude-trace.md`, che **non riscrive**: qui c'è solo
> ciò che lo spazio Prodotto aggiunge o cambia. Ogni scelta che non viene
> dal maintainer è marcata *(scelta del costruttore)*; le regole sono
> numerate **[PS n]** per i task e le revisioni. Le domande aperte sono in
> fondo, «Domande per il maintainer».

Superficie:
- `pages/docs/DocsHome.tsx` — il gruppo **PRODUCT** per primo, **CODE**
  sotto; `DocsTurnedOff` con «Turn on Docs»;
- `pages/productDocs/{ProductSpace,ProductTree,ProductIndex,ProductPageRoute,ReadOnlyLine,parts}.tsx`
  — lo spazio, l'albero, l'indice, la testata e la barra della pagina;
- `pages/productDocs/export/ExportMenu.tsx` — il menu e i suoi stati;
- `pages/settings/GeneralSettings.tsx` — l'interruttore «Docs» (Q4);
- `palette/CommandPalette.tsx`, `pages/docs/DocsChat.tsx` — ambito, gruppo
  e fonte «Product».

I codici `ACQ-D3n` degli esempi sono segnaposti: li fissa il seme del Task 3.

Rotte: `#/p/<P>/docs` (pagina iniziale), `#/p/<P>/docs/product` (indice
dello spazio), `#/p/<P>/docs/product/<codice>` (pagina, `?comment=<id>`
apre un filo: `product-comments-history.md`). Piano 11a: Task 2, 6, 7, 12.
Mondo: «Catalogo numerato»; modalità **Read** per indice e pagina letta,
**Operate** per albero, barra ed esportazione. L'editor è in
`product-editor.md`, commenti e cronologia in `product-comments-history.md`.

## 1. Lavoro e pubblico

- **Laura Costa** (Project Lead di ACQ e di `VRD`, `docs.edit`): il PO che
  oggi scrive la doc col cliente in Google Docs. Arriva nei Docs per
  **scrivere**: aprire la pagina giusta, crearne una sotto «Features»,
  spostarla, esportarla per una riunione.
- **Marco Bellini, Matteo Conti** (`docs.edit` in ACQ): scrivono qualche
  frase, rispondono a un commento.
- **Sara Montanari** (Contributor, solo `docs.view`): **legge** cosa deve
  fare il prodotto, prima di costruirlo o di rispondere a un cliente.
- **Giulia Ferri** (Project Lead di MKX, modulo Docs spento): accende i
  Docs per cominciare.
- Stato d'animo: la doc è il riferimento di tutti. Chi scrive vuole che non
  si perda niente; chi legge vuole sapere subito se può cambiare qualcosa
  e, se no, perché.

## 2. Esito e prova

- **Successo**:
  - nella pagina iniziale dei Docs di ACQ il gruppo **PRODUCT** sta sopra
    **CODE**; in `VRD` (nessun repository) c'è solo **PRODUCT**, senza inviti
    ad aggiungere repository;
  - Laura apre lo spazio, trascina «Bills» sopra «Sign-in», crea «Payments»
    sotto «Features» col «+», rinomina sul posto: tutto senza dialoghi
    tranne l'eliminazione;
  - Sara apre «Sign-in»: nessuna maniglia, nessun «+», una riga sotto la
    testata che dice perché non può scrivere, con «Who?»;
  - Laura esporta «Sign-in» in PDF: la finestra di salvataggio del sistema,
    poi «Saved the PDF»;
  - ⌘K dentro lo spazio cerca solo nelle pagine di prodotto, Tab allarga.
- **Verità del prodotto**:
  - lo spazio Prodotto **esiste anche senza repository**: il modulo Docs
    vuol dire «Docs di prodotto e di codice» (decisione 7 della spec);
  - nascosto, inesistente e modulo spento sono **identici** (R-G5): «This
    page doesn't exist or you can't see it»;
  - la pagina **non ricalcola** i permessi: legge `permissions.edit`,
    `permissions.delete`, `deleteBlocked` dalla vista.

## 3. Direzione scelta

- **Tesi**: **lo stesso scaffale dei Docs, con un ripiano in cima scritto
  dal team**. Lo spazio Prodotto ha la stessa ossatura dello spazio di un
  repository (albero 240 ridimensionabile, colonna di lettura ≤ 720,
  cassetto sotto i 1200): chi conosce i Docs lo riconosce senza imparare
  niente. Ciò che cambia lo dice la mano: maniglie, «+» e una barra della
  pagina con i gesti di chi scrive **[PS 1]**.

### 3.1 La pagina iniziale dei Docs (`DocsHome`)

- I gruppi, dall'alto: START HERE · **PRODUCT** · **CODE** (l'attuale
  SPACES, rinominato) · DECISIONS · WHAT'S NEW **[PS 2]** *(scelta del
  costruttore sul nome: «Spaces» non distingueva più le due famiglie)*.
- **PRODUCT** ha una riga sola da 44px, come la riga di uno spazio di
  repository: «Product» / «Prodotto» 600 · «8 pages» `ink-faint` · «Updated
  Nov 4 by Laura Costa» `ink-muted`. Clic → indice dello spazio. Il gruppo
  ha il conteggio delle pagine accanto al titolo.
- **Spazio vuoto** nella riga: «No pages yet» / «Nessuna pagina» al posto
  della data; a destra, per chi ha `docs.edit`, il bottone testo «Start from
  a blank page» / «Inizia da una pagina vuota» (stessa azione del §3.6).
- **START HERE** guadagna, **per prima**, la prima pagina radice dello
  spazio Prodotto (codice + titolo + «Product» 12px faint) quando esiste
  **[PS 3]** *(scelta del costruttore: in `VRD` senza repository è l'unica
  riga, e il gruppo non resta vuoto)*. Senza pagine e senza repository
  START HERE non c'è.
- **CODE** resta com'era (righe dei repository, stato di generazione). In
  un progetto senza repository il gruppo **non c'è** e nemmeno lo stato
  «No repository has documentation yet»: l'invito ad aggiungere un
  repository vive solo nelle impostazioni del progetto **[PS 4]**.
- La chat del progetto resta a destra (360) anche con le sole pagine di
  prodotto, e le cita (§3.8).
- Fixture senza `product` (cambio additivo): la pagina si disegna come
  prima, senza gruppo PRODUCT né riga rotta **[PS 5]**.

```
1440 · Docs di ACQ (Laura) ───────────────────────────────────────────────────────────
│rail│ ACQ        │ Docs                                          │ Ask the docs  (360)│
│    │ Overview   │ Portale utenti Acquedotto delle Colline · …   │                    │
│    │ Tasks      │ START HERE                                    │ How do meter       │
│    │ …          │ ACQ-D30  Overview · Product                   │ readings work?     │
│    │ Docs       │ ─────── Project brief · acq-portal            │ …                  │
│    │ Drive      │ PRODUCT 8                                     │                    │
│    │            │ Product   8 pages · Updated Nov 4 by Laura C. │                    │
│    │            │ CODE 1                                        │                    │
│    │            │ acq-portal  24 pages · Generated Oct 30 at …  │                    │
│    │            │ DECISIONS 5                See the whole register                   │
│    │            │ …                                             │ [Ask about ACQ…]   │
```

```
1024 · Docs di VRD (Laura, nessun repository, spazio vuoto) ─────────
│rail│ VRD        │ Docs                                          │
│    │ Overview   │ App prenotazioni Palestra Verde Città · …     │
│    │ …          │ PRODUCT 0                                     │
│    │ Docs       │ Product   No pages yet  Start from a blank page│
│    │            │ DECISIONS 0                                   │
│    │            │ No decisions yet.                             │
│    │            │ ASK THE DOCS                                  │
│    │            │ [Ask about VRD…]                              │
```

### 3.2 Modulo Docs spento

- La pagina «Docs isn't turned on for MKX» resta (shape `docs.md` [A 5]),
  ma il gesto cambia **[PS 6]**:
  - chi ha `project.settings.manage` (Giulia): la frase «This project
    doesn't use the documentation yet. Turn it on to write product pages
    and read the repositories' docs.» e il bottone primario **Turn on
    Docs** / **Accendi i Docs**, che accende il modulo **sul posto**
    (`useSetDocsModule`). Fatto, la pagina diventa la pagina iniziale col
    gruppo PRODUCT vuoto e «Start from a blank page»; il fuoco va su
    quell'azione. In corso: «Turning on…» / «Accendo…», bottone spento.
    Errore: riga «Couldn't turn on Docs · Retry» sotto il bottone;
  - gli altri: la frase «This project doesn't use the documentation. It
    can be turned on by people who manage MKX's settings.» + `WhoCanLink`
    (`manageProjectSettings`). Nessun bottone.
- La voce «Docs» della colonna di progetto non c'è finché il modulo è
  spento (com'è oggi); dopo l'accensione compare senza ricaricare.

### 3.3 L'interruttore in Settings → General (Q4)

- Una riga nell'elenco dei moduli di General, nella stessa forma delle
  altre: titolo «Docs», descrizione «Product pages and the repositories'
  documentation.» / «Pagine di prodotto e documentazione dei repository.»,
  interruttore a destra.
- Spento (o mentre lo si spegne), sotto la descrizione la riga `ink-muted`:
  «Pages are kept. Turning Docs back on shows them again.» / «Le pagine
  restano. Riaccendendo i Docs tornano visibili.» **[PS 7]**.
- Nessun dialogo di conferma: è reversibile e non perde dati *(scelta del
  costruttore)*. Chi non ha `project.settings.manage` vede l'interruttore
  spento con la riga di sola lettura delle impostazioni di oggi.

### 3.4 Lo spazio: barra, albero, lettura

- **Barra dello spazio** (40px, filetto sotto), **una sola** per spazio e
  pagina *(scelta del costruttore: niente seconda barra della pagina, la
  testata della pagina resta pulita come nei Docs)*:
  - a sinistra: (sotto i 1200) «Pages» / «Pagine» che apre il cassetto,
    poi «Product» / «Prodotto» 600 come nome dello spazio, poi le briciole
    della pagina aperta in `ink-muted` separate da «›» («Features ›
    Sign-in»), ellissi a metà sulle intermedie;
  - a destra, sulla pagina, i **gesti nell'ordine fisso** **[PS 8]**:
    stato di salvataggio («Saving…» / «Saved», `product-editor.md`) ·
    avatar di chi c'è (`product-editor.md`) · **Follow** · **Comments 2** ·
    **History** · **Export ▾** · **⋯** (Copy link; Delete page… con
    `docs.edit`). Sull'indice dello spazio: **Export ▾** soltanto (con le
    sole voci WHOLE SPACE) e «Search ⌘K».
  - Follow, Comments e History sono bottoni testo con icona 16px, stato
    premuto con `aria-pressed` e tinta ink 10%. Il numero di «Comments» è
    il numero di fili **aperti** (tnum); a zero, «Comments» senza numero.
- **Albero** (240, ridimensionabile 200–360 dal bordo, filetto a destra;
  sotto i 1200 cassetto sovrapposto 280 aperto da «Pages», ⌘\) — la stessa
  meccanica dello spazio di repository **[PS 9]**. In testa una riga 36px:
  «Pages» `heading-group` col numero e, per `docs.edit`, «+ New page» /
  «+ Nuova pagina» a destra (pagina radice in fondo).
- **Colonna di lettura** (≤ 720, centrata nel residuo, margine sinistro
  48 per le maniglie dei blocchi: `product-editor.md`). Con commenti o
  cronologia aperti la colonna si restringe: le regole di larghezza stanno
  in `product-editor.md` §6.
- **Testata della pagina**: riga 12px «ACQ-D31 · Product» (codice 600 tnum
  `ink-muted`, clic copia il link come nei Docs); h1 28px = titolo (per chi
  scrive è modificabile sul posto: `product-editor.md` §3.1); riga meta
  13px `ink-muted`: «Updated Nov 4 by Laura Costa · Created by Laura Costa».
  Poi, per chi legge soltanto, la **riga di sola lettura** (§3.7). Poi il
  corpo.
- **Indice dello spazio** (`…/docs/product`): h1 «Product» / «Prodotto»;
  meta «8 pages · Updated Nov 4 by Laura Costa»; per `docs.edit` il bottone
  «New page» accanto all'h1; poi `heading-group` **RECENTLY UPDATED** (al più
  5: codice tnum · titolo · «Laura Costa · Nov 4» 12px faint), poi **ALL
  PAGES** come elenco rientrato dell'albero (righe 32px, codice + titolo)
  per chi arriva al cassetto chiuso *(scelta del costruttore)*.

```
1440 · pagina «Sign-in» di ACQ (Laura), commenti chiusi ──────────────────────────────────────────
│rail│ ACQ        │ Product  Features › Sign-in       Saved  (MB)(MC)  Follow  Comments 2  History  Export ▾  ⋯ │
│    │ Overview   ├───────────────┬─────────────────────────────────────────────────────────────────────┤
│    │ Tasks      │ PAGES 8 + New │      ACQ-D31 · Product                                              │
│    │ …          │ ▾ Overview    │      Sign-in                                                        │
│    │ Docs       │ ▾ Features    │      Updated Nov 4 by Laura Costa · Created by Laura Costa          │
│    │ Drive      │  ▌Sign-in   +⋯│                                                                     │
│    │ …          │   Bills       │  ⋮⋮+ Login only with Google. Customers with an email account …      │
│    │            │   Meter readi…│      ## Rules                                                       │
│    │            │   Fault repor…│      …                                                              │
│    │            │   Screens     │                                                                     │
│    │            │   Client deci…│                                                                     │
│    │            │   Phases      │                                                                     │
```

```
1024 · stessa pagina, cassetto chiuso ───────────────────────────────
│rail│ ACQ        │ Pages  Product › … › Sign-in    Saved (MB) Follow ⋯│
│    │ …          ├────────────────────────────────────────────────────┤
│    │            │   ACQ-D31 · Product                                │
│    │            │   Sign-in                                          │
│    │            │   Updated Nov 4 by Laura Costa                     │
│    │            │ ⋮⋮+ Login only with Google. …                      │
```

- **1024** **[PS 10]**: la barra non va a capo. Restano sempre «Pages»,
  «Product», l'ultima briciola, stato di salvataggio, avatar (al più 2 +
  «+N») e **Follow**; Comments, History ed Export finiscono nel «⋯» in
  quest'ordine, **prima** di Copy link e Delete, se non stanno (stessa
  misura di `OPTIONAL_BAR` dello spazio di repository). Il numero dei
  commenti aperti resta leggibile nella voce del menu («Comments (2)»).
  La riga meta lascia cadere «Created by …».

### 3.5 L'albero

- **Nodi** 28px: freccia (solo con figli) · titolo `ink-muted` (corrente
  `ink` 600 con tinta 10%). Il codice sta nel `title`, non sul nodo (come
  i Docs, `docs.md` [A 4]). Rientro 12px per livello. Profondità senza
  limite nei dati; oltre 4 livelli il rientro smette di crescere e la
  profondità resta nella lettura del nodo («level 5») *(scelta del
  costruttore)*.
- **Al passaggio o al fuoco** (solo `docs.edit`) **[PS 11]**:
  - a sinistra, nella fascia del rientro, la maniglia ⋮⋮ 16px `ink-faint`
    (trascinare);
  - a destra «+» (sottopagina) e «⋯», 20px ciascuno, `ink-muted`.
  - Sara non ha né maniglie, né «+», né «⋯», né «+ New page»: l'albero è
    quello dei Docs.
- **Trascinare** (`@dnd-kit/sortable` sulla lista piatta) **[PS 12]**:
  - **ombra**: la riga presa segue il puntatore al 90% d'opacità, fondo
    `surface`, bordo `rule-strong`, raggio 6, l'ombra del tooltip (galleggia
    per un momento: unica ombra concessa); al suo posto resta lo spazio
    vuoto della riga con un tratteggio `rule`;
  - **destinazione**: *prima* / *dopo* = linea 2px ink fra due righe, che
    parte dal rientro della profondità di arrivo (si legge il livello dalla
    lunghezza della linea); *dentro* = la riga di destinazione con tinta
    ink 10% e bordo 1px ink 40%, e la sua freccia si apre dopo 600ms di
    sosta. La profondità cambia col trascinamento orizzontale (24px = un
    livello). Il nome della destinazione è annunciato: «Inside Features» /
    «Dentro Features», «After Sign-in» / «Dopo Sign-in»;
  - una destinazione impossibile (sotto sé stessa o un discendente) non
    mostra linea: il cursore `not-allowed` e la riga torna al posto;
  - rilasciata: posizione nuova subito (ottimistica); errore → la riga
    torna dov'era con l'avviso «Couldn't move “Bills” · Retry» in cima
    all'albero, 6s o fino a Retry.
- **«⋯» del nodo** (menu, 220px) **[PS 13]**: Rename · New subpage ·
  divisore · Move up · Move down · Indent · Outdent · divisore · Copy link ·
  Delete…. Ogni voce impossibile è **spenta con la sua frase** sotto, 12px
  `ink-faint`, mai nascosta:
  - Move up sulla prima figlia: «Already first»; Move down sull'ultima:
    «Already last»;
  - Indent senza una sorella sopra: «Needs a page above it to go under»;
    Outdent su una radice: «Already at the top level»;
  - **Delete** con sottopagine: «Move or delete its subpages first» /
    «Sposta o elimina prima le sue sottopagine», **senza «Who?»** (è una
    regola, non un permesso).
  - Dopo una voce, il fuoco torna al nodo (che resta lo stesso anche se
    si è spostato).
- **Rinominare sul posto** **[PS 14]**: Rename o F2 sul nodo trasformano il
  titolo in un campo della stessa altezza, testo selezionato. **Invio**
  salva, **Esc** torna al titolo di prima; in entrambi i casi il fuoco
  resta sul nodo. Uscire col clic fuori salva. Vuoto: torna al titolo di
  prima e il `title` del campo dice «A page needs a title» / «Una pagina ha
  bisogno di un titolo». Invio sul nodo fuori dalla rinomina **apre** la
  pagina, come nel pattern `tree` dei Docs *(scelta del costruttore: il
  piano dice «Invio/F2 per rinominare»; Invio resta «apri» per non rompere
  l'albero dei Docs, Invio salva dentro la rinomina, F2 la avvia)*.
- **«+»** crea «Untitled» / «Senza titolo» come **ultima** sottopagina,
  apre il genitore, apre la pagina nuova col **titolo dell'h1 in
  modifica e selezionato** (non il nodo). «+ New page» fa lo stesso alla
  radice.
- **Delete…** apre il dialogo: «Delete “Bills”?» / «Eliminare «Bills»?»,
  corpo «Its comments and history are deleted too, and links to ACQ-D32
  stop working. This can't be undone.» / «Vengono eliminati anche i suoi
  commenti e la cronologia, e i link ad ACQ-D32 smettono di funzionare.
  Non si può annullare.» · Cancel · **Delete** (critico). In corso
  «Deleting…»; dopo, si apre il genitore (o l'indice) e il fuoco va al suo
  nodo.

### 3.6 Spazio vuoto

- **Chi scrive** (Laura in `VRD`) **[PS 15]**: nella colonna di lettura
  dell'indice, titolo 20px «No product pages yet» / «Ancora nessuna pagina
  di prodotto», due frasi `ink-muted`: «Write what the product must do,
  its screens, the decisions taken with the client and the phases. Start
  from a blank page and add subpages as you go.»; poi le **strade**, come
  righe 44px con filetto (non card):
  - **Start from a blank page** / **Inizia da una pagina vuota** →
    `createProductPage` «Untitled», titolo in modifica;
  - *posto riservato al 11b*, **sopra** la riga vuota: «Write the first
    version with Claude» / «Scrivi la prima versione con Claude». Nel 11a
    non si disegna: l'elenco ha una riga sola e il 11b ne aggiunge una in
    testa senza spostare il resto *(scelta del costruttore)*.
  - L'albero, vuoto, mostra solo «+ New page».
- **Chi legge** (Sara): «No product pages yet» e «When someone writes the
  first page, it shows up here.» / «Quando qualcuno scrive la prima pagina,
  compare qui.». Nessun bottone, nessun «Who?» (non c'è niente da
  chiedere: lo spazio è vuoto per tutti).

### 3.7 La riga di sola lettura (`ReadOnlyLine`)

- Sotto la riga meta della testata, 13px `ink-muted`, con l'icona del
  lucchetto 14px: «You can read this page. Editing is for people with Edit
  docs in ACQ» / «Puoi leggere questa pagina. Scrivere è di chi ha Modifica
  Docs in ACQ» + `WhoCanLink` (`editDocs`) **[PS 16]**.
- Una per pagina, sempre (non si chiude); sull'indice dello spazio la
  stessa frase con «…read these pages…» / «…leggere queste pagine…».

### 3.8 Esportazione

- **Export ▾** apre un menu 240px con due gruppi `heading-group`
  **[PS 17]**:
  - **THIS PAGE** / **QUESTA PAGINA**: «PDF» · «Word (.docx)»;
  - **WHOLE SPACE** / **TUTTO LO SPAZIO**: «PDF» · «Word (.docx)», con la
    riga 12px faint «8 pages, in tree order» / «8 pagine, nell'ordine
    dell'albero».
  - Sotto, una riga 12px `ink-faint`: «Comments aren't included.» /
    «I commenti non sono inclusi.».
- **In corso**: il bottone diventa «Preparing…» / «Preparo…», spento, con
  il cerchio d'attesa neutro 12px (non l'anello di Claude: non è Claude).
  Poi la finestra di salvataggio del sistema. Nomi proposti: «ACQ-D31
  Sign-in», «ACQ Product» / «ACQ Prodotto».
- **Esiti** (avvisi del prototipo in basso a destra, come gli altri):
  - salvato: «Saved the PDF» / «PDF salvato», «Saved the Word file» /
    «File Word salvato»; con un WebP lasciato fuori: «Saved the Word file.
    1 image was left out (WebP).» / «File Word salvato. 1 immagine è
    rimasta fuori (WebP).»;
  - finestra annullata: **niente**, nessun avviso;
  - errore: «Couldn't export · Retry» / «Esportazione non riuscita ·
    Riprova», `role="alert"`; Retry rifà la stessa esportazione.
- Il fuoco torna su «Export ▾» alla chiusura del menu e alla fine
  dell'esportazione **[PS 18]**.
- Nel `preview:web` il PDF apre la stampa del browser e il Word si scarica:
  stesso menu, stessi testi.

### 3.9 ⌘K, menu `#` e chat del progetto

- **Ambito** dentro `#/p/<P>/docs/product…`: nella riga d'ingresso della
  palette il gettone «In Product» / «Nel Prodotto», il suggerimento «Tab:
  search everything» / «Tab: cerca ovunque»; risultati dal primo carattere,
  solo il gruppo **PRODUCT PAGES** (codice · titolo · passaggio 12px faint
  con le parole evidenziate) **[PS 19]**.
- **Fuori ambito**: il gruppo **PRODUCT PAGES** / **PAGINE DI PRODOTTO**
  subito **dopo** PAGES (i Docs dei repository), stessa riga, `detail` «ACQ
  · Product».
- **Menu `#`**: le pagine di prodotto con le altre pagine, detail «ACQ ·
  Product» / «ACQ · Prodotto».
- **Chat del progetto**: la fonte di una pagina di prodotto dice «from
  Product» / «da Prodotto» al posto del nome del repository («Used:
  ACQ-D35 Meter reading · from Product»). La chat di un repository non le
  legge.

## 4. Ambito e confini

- **Dentro**: pagina iniziale, modulo spento, interruttore, spazio, albero,
  barra, testata, sola lettura, esportazione, ⌘K/`#`/chat.
- **Fuori (11b)**: «Write the first version with Claude», la riga «First
  version written by Claude…», la riga del budget, le domande di Claude,
  «Propose backlog items». Questo shape riserva solo il posto della prima.
- **Anti-obiettivi**:
  - due barre sovrapposte (spazio + pagina);
  - lo spazio Prodotto come «un altro repository» in CODE;
  - un bottone nascosto per chi non può (si spegne con la frase, o non
    c'è per chi legge soltanto, come nei Docs);
  - un «Who?» su una regola («ha sottopagine»);
  - codici sui nodi dell'albero; colori per livello o per pagina.

## 5. Stati e intervalli

- **Volumi**: 0–200 pagine per spazio, 1–6 livelli; titoli fino a 120
  caratteri (a capo nell'h1, ellissi nell'albero e nelle briciole con
  `title`). Avatar: 0–8 persone.
- **Caricamento**: albero scheletro (8 righe), testata e 3 blocchi grigi;
  mai pagina bianca. **Errore** di lettura: «Couldn't load the product
  pages · Retry».
- **Non trovata** (codice inventato, pagina eliminata da un altro mentre è
  aperta, modulo spento, «vedi come» su chi non vede il progetto): «This
  page doesn't exist or you can't see it» + «Back to the index» —
  **identica** nei quattro casi **[PS 20]**. La barra perde i gesti, gli
  avatar spariscono, il cassetto si chiude.
- **Cambio di persona** («vedi come»): spazio e pagina si ricaricano coi
  permessi nuovi; un campo in rinomina si scarta senza chiedere.

## 6. Tastiera e fuoco

- ⌘K palette con ambito, Tab allarga; ⌘\ cassetto dell'albero (sotto i
  1200); Esc chiude cassetto, menu e dialoghi.
- **Albero** (`role="tree"`, `aria-level`, `aria-expanded`): ↑/↓ muovono,
  →/← aprono/chiudono o vanno al genitore, Invio apre, F2 rinomina,
  ⇧F10 o il tasto Menu aprono «⋯». Nessuno spostamento da tastiera fuori dal
  menu *(scelta del costruttore: le voci del menu bastano e si testano)*.
- Dopo un menu o un dialogo il fuoco torna a chi l'ha aperto (nodo, «⋯»
  della barra, «Export ▾»); dopo un'eliminazione al nodo del genitore.
- Annunci `polite`: «Moved Bills before Sign-in» / «Spostata Bills prima di
  Sign-in», «Renamed to …», «Page deleted».

## 7. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| gruppi home | Product · Code | Prodotto · Codice |
| riga spazio | {{count}} pages · Updated {{date}} by {{name}} · No pages yet | {{count}} pagine · Aggiornata il {{date}} da {{name}} · Nessuna pagina |
| start here | {{code}} {{title}} · Product | {{code}} {{title}} · Prodotto |
| modulo spento | Turn on Docs · Turning on… · Couldn't turn on Docs · Retry | Accendi i Docs · Accendo… · Non sono riuscito ad accendere i Docs · Riprova |
| interruttore | Docs · Product pages and the repositories' documentation. · Pages are kept. Turning Docs back on shows them again. | Docs · Pagine di prodotto e documentazione dei repository. · Le pagine restano. Riaccendendo i Docs tornano visibili. |
| barra | Pages · Product · Follow · Following · Comments · History · Export · Copy link · Delete page… | Pagine · Prodotto · Segui · Segui già · Commenti · Cronologia · Esporta · Copia il link · Elimina la pagina… |
| albero | Pages · New page · New subpage · Rename · Move up · Move down · Indent · Outdent · Delete… | Pagine · Nuova pagina · Nuova sottopagina · Rinomina · Sposta su · Sposta giù · Rientra · Riduci rientro · Elimina… |
| frasi spente | Already first · Already last · Needs a page above it to go under · Already at the top level · Move or delete its subpages first | È già la prima · È già l'ultima · Serve una pagina sopra sotto cui metterla · È già al primo livello · Sposta o elimina prima le sue sottopagine |
| nuova | Untitled · A page needs a title | Senza titolo · Una pagina ha bisogno di un titolo |
| vuoto | No product pages yet · Start from a blank page · When someone writes the first page, it shows up here. | Ancora nessuna pagina di prodotto · Inizia da una pagina vuota · Quando qualcuno scrive la prima pagina, compare qui. |
| sola lettura | You can read this page. Editing is for people with Edit docs in {{code}} · Who? | Puoi leggere questa pagina. Scrivere è di chi ha Modifica Docs in {{code}} · Chi? |
| export | This page · Whole space · PDF · Word (.docx) · Comments aren't included. · Preparing… · Saved the PDF · Couldn't export · Retry | Questa pagina · Tutto lo spazio · PDF · Word (.docx) · I commenti non sono inclusi. · Preparo… · PDF salvato · Esportazione non riuscita · Riprova |
| ⌘K | In Product · Tab: search everything · Product pages | Nel Prodotto · Tab: cerca ovunque · Pagine di prodotto |
| chat | from Product | da Prodotto |
| non trovata | This page doesn't exist or you can't see it · Back to the index | Questa pagina non esiste o non puoi vederla · Torna all'indice |

*(Il «Who?» usa la chiave esistente del `WhoCanLink`, qualunque sia la sua
resa italiana di oggi.)*

## 8. Vincoli

- Nessun `can(` né `viewer` in `pages/productDocs/` (test sul sorgente).
- Il nome di repository `product` è riservato: la rotta letterale
  `…/docs/product` è registrata **prima** di `…/docs/$repo`, col commento
  della trappola.
- Testi pensati per l'italiano più lungo: la barra misura e manda nel
  «⋯», non va mai a capo.
- Scatti `a11a-*` a 1440 chiaro/scuro × en/it, 1024 scuro-en e chiaro-it.

## Decisioni del maintainer (5 nov 2026)

Nessuna domanda in questo file. Le scelte marcate *(scelta del
costruttore)* sono approvate col brief *(maintainer, 5 nov 2026)*, in
particolare la barra unica e il suo ordine [PS 8], Invio apre e F2 rinomina
nell'albero [PS 14], il gruppo «Code» e la prima pagina radice del Prodotto
in START HERE [PS 2], [PS 3].
