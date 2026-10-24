# Shape brief — Rassegna del giorno «By person»

Superficie: `pages/projects/PeopleActivity.tsx`, dentro `#/projects` →
scheda **Activity**, vista «By person». Piano: Task 10. Spec: area 3 §6,
«Permessi nuovi». Mondo: «Catalogo numerato», modalità **Operate** con un
tratto di **Read**. **[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Chi coordina (full admin, Project Lead, chiunque abbia
  `people.activity.view`): a fine giornata o la mattina dopo rivede cosa
  ha fatto ogni persona, **in ogni reparto** — non solo i commit.
- Stato d'animo: rassegna, non sorveglianza. Scorre, si ferma su chi ha
  qualcosa di insolito, apre la task. Non confronta né classifica.

## 2. Esito e prova

- Azione primaria: scorrere le persone di un giorno e aprire ciò che
  merita attenzione (una task chiusa, un commit, una decisione).
- Successo: a 1440×900 si vedono ~10 persone con il loro riassunto senza
  aprire nulla; cambiare giorno è un tasto.
- Verità: solo eventi di Stubwise dei progetti che chi guarda può vedere;
  la descrizione dei commit è **testo generato** e lo dice; posta e
  calendario personali non entrano mai.

## 3. Direzione scelta

- **Tesi**: un **registro per persona**, una riga di sintesi ciascuna in
  prosa con numeri tabellari, che si apre sul dettaglio. Nessun grafico,
  nessuna classifica, nessun punteggio: l'ordine non premia chi fa di più.
- **Sequenza**: testata di All projects invariata (h1, schede) → nella
  scheda Activity un segmentato `By project · By person` (il secondo solo
  con il permesso) → barra: selettore data «‹ Today, Fri Oct 24 ›»,
  Department ▾, ricerca persona, «Expand all» → gruppi per reparto
  (`heading-group` con il listello del reparto **solo come legenda** della
  testata **[ASSUNZIONE]**) → persone.
- **Riga persona** (44px): avatar · nome · sintesi «2 closed · 5 moved ·
  4 comments · 1 decision · 1 request · 6 commits» (solo voci non zero) ·
  stato del report per chi ha commit. Chiusa di default.
- **Aperta**: sottogruppi in ordine fisso — Closed · Moved · Comments ·
  Decisions · Requests · Commits — ogni voce è una riga del catalogo
  (codice + nome + progetto + ora). Le task usano `TaskRow` compatta con
  il listello del reparto della **task**.
- **Momento focale**: la persona aperta, con i suoi commit e la
  descrizione generata etichettata.

```
│ All projects 20                                                          │
│ [Projects | Stalled | Activity]                                          │
│ [By project | By person]  ‹ Today, Fri Oct 24 ›  Dept: Any ▾  Person…   │
│ ▌DEVELOPMENT 4                                         Expand all        │
│ ▾ SR Simone Rossetti  1 closed · 3 moved · 2 comments · 6 commits        │
│      CLOSED   STW-3  Board view with keyboard drag and drop  STW 16:20   │
│      MOVED    STW-12 Timeline view…  To do → In progress     STW 11:02   │
│      COMMITS  stubwise/web · 6        Daily report: ready · Open          │
│        a41c9e2  Add lane keyboard handlers                    10:14      │
│                 Generated text · Lets a card move between lanes with…    │
│ ▸ MB Marco Bellini    2 moved · 1 decision · 3 commits   Generate report │
│ ▌MARKETING 3                                                             │
│ ▸ EM Elena Moretti    2 closed · 4 comments · 1 request                  │
│ NO ACTIVITY  Laura Costa · Federico Sartori                              │
│ COMMITS FROM UNLINKED AUTHORS  2 · “dev-bot” 2 commits   Link a person   │
```

## 4. Ambito e confini

- Dentro: segmentato By project/By person, data (oggi e indietro, niente
  futuro), filtro reparto, ricerca persona, per persona le sei categorie,
  commit con descrizione generata, stato del report con «Generate report»,
  gruppo autori non collegati con «Link a person», gruppo «No activity».
- Fuori: posta, calendario, chat; metriche di produttività; esportazione
  **[ASSUNZIONE]**; confronti fra giorni.
- Anti-obiettivi: classifica per numero di commit; colore per «poco
  attivo»; la descrizione AI scambiata per il messaggio di commit.

## 5. Stati e intervalli

- Volumi: 1–~60 persone visibili; per persona 0–~40 voci al giorno;
  commit 0–~30 per persona su 1–4 repository.
- Ordine: reparti nell'ordine configurato, persone alfabetiche dentro il
  reparto; una persona in più reparti sta sotto il suo reparto principale
  **[ASSUNZIONE]**. Claude non è una persona della rassegna
  **[ASSUNZIONE]** (il suo lavoro sta nella destinazione Claude).
- «Moved» = cambio di stato o di settimana pianificata, una riga per
  movimento con «From → To» in parole.
- Commit: sha 7 caratteri (Archivo tabellare, non monospace), messaggio
  originale in ink, sotto la descrizione con `GeneratedTag` «Generated
  text» in muted; repository come intestazione del sottogruppo.
- Report giornaliero (chi ha commit): «Daily report: ready · Open»,
  «Generating…» con l'anello, «Not generated · Generate report» (permesso
  di oggi per generarlo), «Failed · Retry».
- Autori non collegati: gruppo in coda con nome dell'autore git e numero di
  commit; «Link a person» apre il menu persone (permesso di oggi); dopo il
  collegamento i commit passano sotto la persona.
- Senza permesso: il segmentato non mostra «By person»; un link diretto
  mostra «You can't see people's activity» **[ASSUNZIONE sul testo]**.
- Giorno senza attività: «Nothing happened on Sunday, Oct 19» + «Previous
  day». Filtro senza risultati: «Nobody matches · Clear filters».
  Caricamento: 8 righe scheletro. Errore: «Couldn't load the review» +
  «Retry».

## 6. Interazione e layout

- Data: ‹ › cambiano giorno (tasti `[` e `]` **[ASSUNZIONE]**), clic sulla
  data apre un calendario mensile; «Today» torna a oggi. Data e reparto
  nell'URL (`?view=person&date=2026-10-24&dept=…`).
- Riga persona: clic o Enter apre/chiude (chevron, 150ms); J/K fra
  persone; «Expand all» / «Collapse all». Clic su una task → pannello
  `?task=` (affiancato ≥1200); clic su una richiesta → la richiesta nel
  suo progetto; commit → link al repository (esterno).
- 1024×680: la sintesi va a capo sotto il nome; nelle voci cade la colonna
  progetto nel `title`; lo stato del report va sotto i commit.
- Larghezza piena dell'area (come Projects e Stalled), colonne fisse a
  destra per progetto (codice) e ora.

## 7. Vincoli e decisioni aperte

- Permesso `people.activity.view` letto dal livello dati;
  `listPeopleActivity` esclude i progetti invisibili a chi guarda, anche
  nei conteggi della sintesi.
- Ora locale di chi guarda per i confini del giorno **[ASSUNZIONE]** (il
  report giornaliero di oggi usa il giorno UTC: la rassegna lo mostra sul
  giorno locale senza ricalcolarlo).
- Tabular figures su ore, sha, conteggi; testo ≥ 11px.
