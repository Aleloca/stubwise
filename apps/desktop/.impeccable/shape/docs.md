# Shape brief — Docs del progetto

Superficie: sezione «Docs» del progetto (modulo `docs`):
`#/p/<code>/docs` (pagina iniziale con la chat del progetto),
`#/p/<code>/docs/<repo>` (indice del repository), `…/<repo>/<slug>`
(pagina), `…/<repo>/new` e `…/<repo>/<slug>/edit` (pagina manuale),
`…/<repo>/brief`, `…/<repo>/releases`, `…/<repo>/graph`, la chat del
repository e la ricerca ⌘K con ambito. Piano: Task 1–3. Spec: area 5
«Docs», «Codici», «Permessi», «Stati»; parità: `web-inventory.md`
«Documentation». Mondo: «Catalogo numerato»; modalità **Read** per la
pagina e l'indice, **Operate** per generazione, grafo, form e chat.
**[A n]** = assunzione numerata in fondo, da confermare.

## 1. Lavoro e pubblico

- Chi apre i Docs: lo sviluppatore che cerca come funziona un modulo, chi
  fa assistenza e deve rispondere a un cliente («come funziona la
  richiamata?»), il commerciale che vuole il quadro del prodotto, il Project
  Lead che controlla che la documentazione sia fresca. Molti non tecnici.
- Due ritmi: **leggere** (arrivo da un link, da ⌘K o da una citazione di
  Claude, leggo una pagina e me ne vado) e **chiedere** (non so dove sta,
  scrivo una domanda alla chat e seguo le fonti).
- Promessa del maintainer: i Docs funzionano e non danno problemi — si
  portano **come sono**. Il lavoro qui è ricollocarli e farli parlare il
  linguaggio del Catalogo, non inventare.

## 2. Esito e prova

- Azione primaria: arrivare alla pagina giusta e leggerla; secondaria:
  chiedere alla chat e aprire la fonte citata.
- Successo: dalla pagina iniziale si capisce in un colpo d'occhio quali
  repository hanno documentazione, quanto è fresca e da dove cominciare;
  ogni pagina dice da sola se è generata o manuale, a quale commit, e se è
  **vecchia**; ogni pagina ha un codice (`AUD-D12`) che si incolla in Chat
  e in una task.
- Verità del prodotto: le pagine nascono dal giro notturno sui repository
  (non si scrivono a mano, salvo le manuali); un codice `AUD-D12` è stabile
  anche se cambiano titolo o percorso; nascosto e inesistente sono identici
  (R-G5).
- Prova di parità: ogni voce «Documentation» dell'inventario ha un posto
  qui (tabella in `area5-parity.md`). Il «Docs hub» non ha pagina: i Docs di
  più progetti si cercano da ⌘K; il registro decisioni intero sta in
  Overview (area 2), qui solo la sintesi col link.

## 3. Direzione scelta

- **Tesi**: una biblioteca a scaffale aperto dentro il progetto. Il
  progetto resta la cornice (colonna di progetto intatta); dentro l'area di
  lavoro, lo **spazio del repository** ha un suo indice laterale (albero)
  e una colonna di lettura stretta. Niente riquadri: filetti, gruppi con
  `heading-group`, codici in cifre tabellari accanto ai titoli.
- **Colonna di progetto**: la voce «Docs», quando è corrente, si apre in
  sottovoci 28px rientrate, una per spazio di repository (nome del
  repository + numero di pagine in `ink-faint`), come i canali sotto
  «Chat» **[A 1]**.
- **Pagina iniziale** (`#/p/<code>/docs`), due colonne a 1440:
  - Sinistra (lettura, ≤ 720px): h1 28px «Docs»; sotto, 13px muted, la
    riga d'identità del brief («Audin 2.0 · Dialer and CRM for outbound
    sales teams»). Poi gruppi con `heading-group`:
    **START HERE** (2 righe: brief del progetto, panoramica del repository
    principale, ciascuna codice + titolo); **SPACES** (una riga 44px per
    repository: nome 600, «38 pages», stato di generazione in parole —
    «Generated Oct 24 at a1b2c3d», «Manual pages only», «Not generated
    yet», «Paused: usage limit» — con il segno di stato del §6);
    **DECISIONS** (le ultime 3: titolo + «decided by Laura Costa · Oct 21»,
    poi «See the whole register» → Overview); **WHAT'S NEW** (ultime 5
    releases di tutti i repository: versione tnum, repository, data, prima
    riga, «Minor» in parola).
  - Destra: la **chat del progetto** come pannello agganciato 360px con
    filetto a sinistra, sempre presente sulla pagina iniziale **[A 2]**.
- **Spazio del repository** (`#/p/<code>/docs/<repo>/…`): sotto la
  testata, una barra secondaria 40px con: nome del repository (600) ·
  «Index» · «Brief» · «Releases 12» · «Graph» come voci di navigazione
  orizzontali, a destra «Search ⌘K» e «Chat» (interruttore del pannello).
  Sotto, tre zone: **albero** (240px, ridimensionabile 200–360 dal bordo,
  filetto a destra), **lettura** (colonna ≤ 720px, 72ch, centrata nel
  residuo con margine sinistro 32px), **chat del repository** (pannello
  agganciato 360px, chiuso di default, ricordato per persona) **[A 3]**.
- **Albero**: quattro gruppi `heading-group` nell'ordine TECHNICAL,
  FUNCTIONAL, PRODUCT, MANUAL, ciascuno con conteggio, freccia per
  chiuderlo e «⋯» con «Download as .zip»; in testa all'albero «Expand all
  / Collapse all». Nodi 28px: titolo (ink-muted, corrente ink 600 con
  tinta 10%), cartelle intermedie del percorso come nodi richiudibili;
  il codice `AUD-D12` **non** è nell'albero (appare al passaggio nel
  tooltip e sulla pagina) per non trasformare l'indice in un muro di
  numeri **[A 4]**. In fondo all'albero, separato da filetto, il
  **pannello di generazione** (§6).
- **Indice del repository** (`…/<repo>`): h1 = nome del repository; righe
  come la pagina iniziale ma per il repository: riassunto del brief
  (3 righe + «Read the brief»), START HERE, una riga per categoria con
  conteggio, WHAT'S NEW, RECENTLY UPDATED (5), MOST READ (5, dalle «view
  pings» di oggi, conteggio in `ink-faint`). Ogni riga pagina = codice
  tnum + titolo + percorso 12px faint.
- **Pagina** (`…/<repo>/<slug>`): sopra l'h1 una riga 12px: codice
  `AUD-D12` (600, tnum, ink-muted, clic copia il link) · categoria;
  h1 28px = titolo; sotto, riga meta 13px muted, separata da «·»:
  «Documents `src/dialer/callbacks.ts`» · «Generated at commit a1b2c3d»
  (link al commit) · «Updated Oct 24» · oppure «Manual page · by Marco
  Bellini». A destra della testata, per le manuali con `docs.edit`:
  «Edit» e «⋯» (Delete). Poi l'**avviso di pagina vecchia** (§5), poi il
  corpo Markdown (renderer esistente), poi «LINKED PAGES» con tre
  sottogruppi Implements / Implemented by / Related (codice + titolo).
- **Momento focale**: sulla pagina iniziale, la riga di uno spazio con il
  suo stato di freschezza accanto al nome; sulla pagina, il codice sopra
  il titolo e, se c'è, l'avviso di pagina vecchia subito sotto la meta.

```
1440 · spazio del repository, pagina, chat chiusa
┌rail┬project col────┬ audin-app  Index  Brief  Releases 12  Graph   Search ⌘K  Chat ┐
│    │ AUD           ├────────────────┬──────────────────────────────────────────────┤
│    │ Audin 2.0     │ Expand all     │ AUD-D12 · Functional                         │
│    │ Overview      │ TECHNICAL 14 ▾ │ Scheduled callbacks                          │
│    │ Tasks         │  Dialer      ▸ │ Documents src/dialer/callbacks.ts · Generated│
│    │ …             │ FUNCTIONAL 9 ▾ │ at commit a1b2c3d · Updated Oct 24           │
│    │ Docs          │ ▌Callbacks     │ ┊⚠ 3 commits since this page was updated  ▸ │
│    │  audin-app 38 │  Contacts      │                                              │
│    │  audin-web 12 │ PRODUCT 6    ▸ │ A callback is stored in UTC and shown in …   │
│    │ Drive         │ MANUAL 3     ▸ │                                              │
│    │ Chat          │ ────────────── │ LINKED PAGES                                 │
│    │               │ ◌ Paused: limit│ Implements  AUD-D4 Dialer queue              │
│    │               │ Resume now     │                                              │
└────┴───────────────┴────────────────┴──────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: tutte le voci «Documentation» dell'inventario (tranne il Docs hub
  come pagina e il registro intero, ricollocati come detto), i codici
  `<PRJ>-D<n>`, le fonti Drive nella chat (resa in `drive-search.md`).
- Fuori: nessuna funzione nuova; il registro decisioni (area 2); le
  impostazioni del repository e del modulo (impostazioni di progetto); la
  ricerca nei file del Drive (`drive-search.md`).
- **Anti-obiettivi**: un «Confluence» con editor ricco, commenti, pagine
  annidate create a mano; una pagina iniziale a schede colorate per
  repository; codici al posto dei titoli; colori per categoria (Technical
  blu, Product verde…: il colore è dei reparti); un avviso di pagina vecchia
  rosso che allarma (è informazione, non errore); il contatore «più lette»
  confuso con le aperture del Drive.

## 5. Stati e intervalli

- **Volumi**: 1–6 repository per progetto; 0–400 pagine per repository;
  titoli fino a 120 caratteri (a capo nell'h1, ellissi nell'albero con
  tooltip); percorsi lunghi spezzati sugli «/».
- **Modulo spento**: la voce Docs non c'è. URL diretto → la pagina
  «Docs isn't turned on for AUD» + per chi ha `project.settings.manage`
  «Turn it on in Settings» **[A 5]**.
- **Senza `docs.view`**: «You can't see this project's docs» (nessun
  conteggio, nessun titolo) **[A 6]**.
- **Progetto senza repository / spazi vuoti**: pagina iniziale con «No
  repository has documentation yet» + per `repos.manage` «Add a
  repository» (porta alle impostazioni) **[A 7]**.
- **Spazio mai generato**: indice con «Not generated yet», per
  `docs.generate` il bottone «Generate documentation», per gli altri «Ask a
  maintainer to generate it»; resta «+ New manual page» con `docs.edit`.
- **Generazione**: never · queued («Waiting in line») · running («Writing
  pages… 14 of ~38», segno di Claude al lavoro) · succeeded («Generated Oct
  24 at a1b2c3d · $3.12 · Claude Sonnet») · failed (motivo + «Retry» con
  `docs.generate`) · held («On hold: monthly budget reached» + motivo) ·
  paused («Paused: usage limit, resumes around 14:00» + «Resume now» con
  `docs.generate`). Gli stati avanzano col ritardo simulato.
- **Pagina vecchia**: fascia sotto la meta, fondo `ink/4` con angoli
  arrotondati come gli altri avvisi (niente filetto laterale colorato:
  deciso dal maintainer il 25 ott 2026, coerente con DESIGN.md)
  + icona e testo (mai solo colore): «3 commits since this page was
  updated», richiusa; aperta elenca sha (tnum) · messaggio · data, max 5 +
  «Show 4 more». Si chiude solo per la sessione.
- **Pagina non trovata** / codice di un progetto invisibile: «This page
  doesn't exist or you can't see it» + «Back to the index» (identico per
  i due casi, R-G5).
- **Pagina manuale**: form a pagina (non dialogo) — Title, Slug
  (facoltativo, generato dal titolo, anteprima «Will be at
  /docs/audin-app/onboarding-checklist»), Body Markdown con «Write /
  Preview». Errore di slug in riga: «Another page already uses this slug».
  «Cancel» · **Save page**. Uscire con modifiche → conferma «Discard your
  changes?» **[A 8]**. Elimina: dialogo «Delete “Onboarding checklist”? It
  can't be restored. Links from other pages will stop working.» · Delete.
- **Brief del repository**: sezioni Identity, Actors, Surfaces, Glossary,
  Business invariants, User journeys, Existing sources (gruppi con
  `heading-group`, testo a 72ch); CONFIDENTIAL FACTS come elenco a righe
  (fatto · perché · dove nel codice · «must not appear as»), con nota
  «Shown for audit; these never reach the public docs»; EXCLUDED PAGES con
  motivo. Vuoto: «No brief yet: it's written with the first generation».
  Errore con «Retry».
- **Releases**: campo «Search releases», interruttore «Significant only»;
  righe per release: versione tnum 600 · data · «Minor» in parola
  (`rule-strong`, 12px) · testo; «Pages touched» come gettoni codice +
  titolo. Vuoto: «No releases yet: they're written every night from new
  commits». Nessun risultato: «No releases match “export”».
- **Grafo**: disabled (spiegazione in due frasi; con `repos.manage`
  «Enable it in the repository», per gli altri «Ask a maintainer to enable
  it») · never (con `repos.manage` «Generate») · queued/running (si
  aggiorna da solo, segno di lavoro) · failed (motivo + «Retry») · ready:
  riga di conteggi tnum «1,284 nodes · 3,901 edges · 41 communities» +
  «Updated on push», etichette AI, grafo interattivo (apri/chiudi una
  comunità), COMMUNITIES (elenco con nome AI e dimensione), «Download
  graph.json», comando copiabile in blocco codice `graphify query "…"`.
  Azioni in «⋯» con `repos.manage`: Regenerate, Rebuild from scratch,
  Open setup PR / View the setup PR.
- **Chat** (progetto e repository): vuota = 3–4 domande suggerite come
  righe 36px cliccabili + campo; risposte con il componente della
  conversazione (Markdown, «Used:» con codice + titolo + «from audin-app»
  o con file del Drive `AUD-F7`, R-E9); «New chat» azzera. «Chat isn't
  available: it needs a provider with an API key. An admin can set it up
  in Settings.» al posto del campo. Errore di risposta in riga con «Try
  again».
- Caricamento: albero scheletro (12 righe), colonna di lettura con 3
  blocchi grigi; errore di caricamento con «Retry»; mai pagina bianca.
- **Cambio di persona**: chat azzerata, form manuale scartato senza
  chiedere, pagina ricaricata coi permessi nuovi; pagina non più visibile →
  stato «doesn't exist or you can't see it».

## 6. Interazione e layout

- **Segno di stato della generazione** (albero, spazi, indice): parola
  sempre presente; running/queued = anello tratteggiato di Claude al
  lavoro (ink, non tinta: è Claude che scrive) **[A 9]**; succeeded = nessun
  segno, solo la data; failed = `critical`; held/paused = `warning`; never
  = `ink-faint`.
- **Pannello di generazione** in fondo all'albero: chiuso è una riga
  (segno + stato breve + data); aperto (clic) mostra last generated,
  commit, cost, provider, motivo, e le azioni «Generate documentation» /
  «Resume now» (`docs.generate`) e «+ New manual page» (`docs.edit`)
  **[A 10]**.
- **Chat del repository**: pannello agganciato 360px da 1200px (stessa
  meccanica del dettaglio task), sotto 1200 sovrapposto 400px con fuoco
  dentro. Le fonti aprono la pagina nella colonna di lettura senza chiudere
  la chat.
- **Ricerca ⌘K con ambito**: dentro uno spazio Docs, ⌘K apre il palette
  con un gettone d'ambito nella riga d'ingresso «In audin-app docs» e il
  suggerimento «Tab: search everything»; Tab alterna «In audin-app docs» /
  «Everywhere». Con ambito, i risultati sono solo il gruppo PAGES (codice ·
  titolo · percorso 12px faint, passaggio con la parola evidenziata come
  nella ricerca Chat). Senza ambito il gruppo PAGES sta con gli altri
  oggetti (ordine in `drive-search.md`).
- **1024×680**: area 720px. Pagina iniziale a una colonna: la chat del
  progetto scende sotto come sezione «ASK THE DOCS» con il campo e le
  domande, e la conversazione si apre come pannello sovrapposto 400px
  **[A 2]**. Spazio: l'albero diventa un cassetto sovrapposto 280px aperto
  da «Pages» nella barra secondaria (⌘\ alterna); la lettura prende tutta
  la larghezza; «Releases 12» resta, le altre voci della barra non vanno a
  capo ma finiscono in «More» se non stanno.
- **Movimento**: cambio pagina in dissolvenza 150ms nella sola colonna di
  lettura (l'albero resta fermo); apertura dei nodi 150ms; nessuno con
  movimento ridotto.

## 7. Tastiera e accessibilità

- ⌘K ricerca con ambito, Tab allarga; ⌘\ albero (1024); ⌘⇧C chat del
  repository; nell'albero ↑/↓ muovono, →/← aprono/chiudono, Enter apre
  (pattern `tree` ARIA); ⌘C con il fuoco sul codice copia il link; J/K
  nelle liste dell'indice; Esc chiude chat sovrapposta e cassetto **[A 11]**.
- L'albero è `role="tree"` con `aria-expanded` e livelli; la pagina ha un
  solo h1 e i titoli Markdown scalano da h2; l'avviso di pagina vecchia è
  `role="note"` con testo, non solo colore; lo stato di generazione è
  parlato («Generation paused: usage limit»), e i cambi di stato sono
  annunciati in `aria-live="polite"`.
- Codici e date in cifre tabellari; percorsi e blocchi di codice sono gli
  unici in carattere a spaziatura fissa (sono codice) **[A 12]**.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| h1 sezione | Docs | Documenti |
| gruppi | Start here · Spaces · Decisions · What's new | Inizia da qui · Spazi · Decisioni · Novità |
| stato spazio | Generated {{date}} at {{commit}} · Manual pages only · Not generated yet | Generata il {{date}} al commit {{commit}} · Solo pagine manuali · Non ancora generata |
| registro | See the whole register | Vedi tutto il registro |
| barra | Index · Brief · Releases · Graph · Chat | Indice · Brief · Releases · Grafo · Chat |
| meta | Documents {{path}} · Generated at commit {{sha}} · Updated {{date}} · Manual page | Documenta {{path}} · Generata al commit {{sha}} · Aggiornata il {{date}} · Pagina manuale |
| vecchia | {{count}} commits since this page was updated | {{count}} commit dopo l'ultimo aggiornamento di questa pagina |
| non trovata | This page doesn't exist or you can't see it | Questa pagina non esiste o non puoi vederla |
| generazione | Generate documentation · Resume now · Paused: usage limit | Genera la documentazione · Riprendi ora · In pausa: limite d'uso |
| manuale | New manual page · Another page already uses this slug | Nuova pagina manuale · Un'altra pagina usa già questo slug |
| releases | Significant only · Minor · Pages touched | Solo significative · Minore · Pagine toccate |
| grafo | Enable it in the repository · Ask a maintainer to enable it | Attivalo nel repository · Chiedi a un maintainer di attivarlo |
| chat | Ask the docs · New chat · Chat isn't available: it needs a provider with an API key. | Chiedi ai documenti · Nuova chat · La chat non è disponibile: serve un provider con chiave API. |
| ⌘K | In {{repo}} docs · Tab: search everything | Nei documenti di {{repo}} · Tab: cerca ovunque |

## 9. Vincoli

- Pagine solo da `data/queries.ts`; visibilità in una funzione; R-G5 per
  `<PRJ>-D<n>`; «più lette» = view pings dei Docs, mai le aperture del
  Drive.
- Chat: stesso componente della conversazione dell'area 3; citazioni con
  R-E9.
- Testi pensati per l'italiano più lungo (barra secondaria e stati in
  parola non vanno a capo: ellissi + tooltip).

## Assunzioni da confermare

1. Nella colonna di progetto, «Docs» corrente si apre in sottovoci per
   repository (come i canali sotto «Chat»); con un solo repository nessuna
   sottovoce.
2. La chat del progetto vive sulla pagina iniziale come pannello agganciato
   360px sempre presente a 1440; a 1024 diventa la sezione «Ask the docs»
   sotto il contenuto e la conversazione si apre sovrapposta.
3. Nello spazio del repository: albero 240px ridimensionabile, lettura
   ≤ 720px, chat del repository chiusa di default e ricordata aperta/chiusa
   per persona.
4. L'albero mostra solo i titoli; il codice `AUD-D12` sta nel tooltip, sulla
   pagina e nei risultati, non su ogni nodo.
5. URL diretto a Docs con il modulo spento: pagina che lo dice, con «Turn it
   on in Settings» a chi gestisce il progetto (invece di un rinvio muto alla
   panoramica).
6. Senza `docs.view` la sezione c'è ma dice «You can't see this project's
   docs» (nel web la rotta è vuota); in alternativa la voce si nasconde.
7. Progetto col modulo acceso ma senza repository: stato vuoto con «Add a
   repository» per `repos.manage`, che porta alle impostazioni del
   progetto.
8. Il form della pagina manuale è una pagina (non un dialogo), con «Write /
   Preview» e conferma all'uscita con modifiche non salvate.
9. Generazione in coda o in corso = anello tratteggiato di «Claude al
   lavoro» (ink), non una tinta; fallita `critical`, sospesa/in pausa
   `warning`.
10. Il pannello di generazione resta in fondo all'albero come nel web,
    chiuso in una riga e aperto al clic; «+ New manual page» vive lì e
    anche nella testata dell'indice.
11. Scorciatoie: ⌘\ albero, ⌘⇧C chat del repository, frecce nell'albero,
    J/K nelle liste dell'indice.
12. Percorsi di file (`src/…`) e il comando `graphify query` in carattere a
    spaziatura fissa, come i blocchi di codice della conversazione.
13. «Download as .zip» di una categoria nel «⋯» del gruppo: nel prototipo
    scarica uno zip finto e mostra l'avviso «Downloaded Functional.zip (9
    pages)».
14. L'avviso di pagina vecchia si richiude per la sessione, non per
    sempre.
