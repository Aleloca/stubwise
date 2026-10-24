# Shape brief — La conversazione con Claude (componente unico)

Superficie: `pages/claude/conversation/*` — `Conversation({ id, side? })`,
usato da destinazione Claude (pagina intera), dettaglio task (pannello),
refine delle richieste, sessioni automatiche. Piano: Task 5. Spec: area 3
§1, §3, «Regole di fondo». Mondo: «Catalogo numerato», modalità **Operate**
con un tratto di **Read** (il testo di Claude). **[ASSUNZIONE]** = da
confermare.

## 1. Lavoro e pubblico

- Chiunque, di ogni reparto: chi chiede «cosa devo fare oggi», chi segue
  Claude mentre lavora su una task, chi risponde a una sua domanda, chi
  approva un piano, chi rivede una sessione automatica conclusa.
- Stato d'animo: due ritmi. **Seguire** (la sessione scorre, si guarda) e
  **decidere** (una scheda chiede qualcosa a me, ora). Il componente deve
  servire entrambi senza che il secondo si perda nel primo.

## 2. Esito e prova

- Azione primaria: leggere cosa dice/fa Claude e, quando serve, decidere
  sul posto (proposta, domanda, piano) in un clic.
- Successo: il testo di Claude è in primo piano e le azioni tecniche sono
  una riga sotto voce (anti-obiettivo: un log travestito da chat); nessuna
  modifica ai dati senza una scheda confermata da chi l'ha chiesta.
- Verità del prodotto: ogni oggetto citato porta **codice + nome** ed è
  apribile solo se chi guarda lo può vedere; un prodotto della pipeline
  (codice, design, piano del refine) compare come riga **già eseguita**,
  non come proposta.

## 3. Direzione scelta

- **Tesi**: interazione dell'app di Claude (messaggi puliti in diretta,
  azioni compatte richiudibili, schede di scelta nel flusso, casella con
  «/»), **forma del Catalogo**: una colonna di lettura, filetti, codici in
  cifre tabellari, nessuna bolla, nessun colore che non sia stato.
- **Allineamento**: tutto a sinistra in una colonna di lettura. Messaggio
  dell'utente = riga «Giulia Ferri · 10:41» + testo su una **fascia** a
  tinta d'inchiostro 5%, raggio 6px. Messaggio di Claude = testo nudo,
  preceduto (solo a inizio turno) da avatar CL con l'anello tratteggiato e
  «Claude · 10:41». Si distinguono per fondo e nome, non per lato.
- **Gerarchia del flusso** (dal più forte): schede di decisione (proposta,
  domanda, piano) → testo di Claude (14px ink, markdown) → righe di
  risultato del lavoro (14px, segno) → separatori di fase → righe d'azione
  (13px ink-muted, 28px).
- **Le schede sono l'unico contorno del flusso**: 1px `rule-strong`, 8px,
  nessuna ombra. Tutto il resto è testo e filetti.
- **Momento focale**: la scheda aperta che aspetta *me*, con il bottone
  primario a portata e il punto «ti aspetta» nella sua intestazione.

```
┌─ conversation (reading column ≤ 720px) ──────────────────────────────┐
│  GIULIA FERRI · 10:41                                                 │
│ ░ What should I do today on AUD? Also plan AUD-91 for next week.   ░ │
│  (CL) Claude · 10:41                                                  │
│  ▸ 4 actions · Read your week, searched AUD tasks                     │
│  You have two things waiting on you and three tasks due today:        │
│  1. AUD-88 Invoice export check — due today, size S                   │
│  2. Elena asks a decision on AUD-77 Onboarding mail                   │
│  Used: AUD-88 Invoice export check · AUD-77 Onboarding mail           │
│ ┌ ● Claude proposes · 1 change ──────────────────────────────────────┐│
│ │ Plan AUD-91 Price list sync · Marco Bellini · W44 · M              ││
│ │                               [Edit] [Cancel]  [Confirm]           ││
│ └─────────────────────────────────────────────────────────────────────┘│
│ ┌─────────────────────────────────────────────────────────────────────┐│
│ │ Ask Claude…   / commands · # objects · @ people                     ││
│ │ [Attach] [Project: AUD ▾]                                   [Send] ││
│ └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: flusso, streaming, righe d'azione e gruppi, fasi, citazioni con
  anteprima, scheda proposta, scheda domanda, scheda piano, righe di
  risultato, casella (allegati, «#», «@», «/»), Ferma / Ferma e scrivi,
  stati di consegna, sola lettura, pillola, «Load earlier», riconnessione.
- Fuori: testata della pagina, colonna, pubblica/continua (vedi
  `claude.md`); lato oggetto (lo passa il chiamante in `side`).
- Anti-obiettivi: bolle colorate; JSON o nomi di strumenti in primo piano;
  marchio, arancio o stile grafico di Anthropic; un bottone «Conferma» visto
  da chi non ha chiesto la proposta.

## 5. Stati e intervalli

- Messaggi 1–~400 eventi; righe d'azione fino a 200+ per sessione
  (virtualizzate, gruppi chiusi); markdown lungo con tabelle e blocchi di
  codice larghi: il **blocco** scorre in orizzontale, mai la pagina;
  percorsi lunghi spezzati al `/` con `title` intero.
- **Streaming**: il testo cresce nello stesso messaggio; in coda un cursore
  sottile d'inchiostro (fermo con movimento ridotto). Una riga d'azione in
  corso mostra l'anello tratteggiato che pulsa; finita, un segno di spunta
  ink; fallita, segno + «failed» in rosso critico (stato vero).
- **Fasi**: filetto con etichetta a sinistra «Plan», «Execution»,
  «Correction 2», «Review» + esito in parole: «done · 4 min», «failed»,
  «timed out», «stopped by Giulia Ferri». Fase in corso: anello.
- **Citazioni**: in linea come «AUD-12 Invoice export» (codice 600
  tabellare + nome, sottolineatura al passaggio); in coda al messaggio una
  riga «Used: …». Anteprima al passaggio (250ms): superficie flottante
  320px con codice, nome, stato, persona. Oggetto non visibile: codice e
  nome in ink-faint, non link, tooltip «You can't open this».
  Ruling R-E9: per un oggetto che chi guarda non vede compare il solo
  **codice** in ink-faint, non apribile, con il tooltip «You can't open
  this»; il nome/titolo non compare (riservatezza) e il livello dati non lo
  espone. Pagine dei Docs e file non visibili: «An item you can't open».
- **Proposta**: intestazione «Claude proposes · N changes»; una riga per
  azione in forma catalogo («Create in AUD: “Banner copy review” · Marco
  Bellini · W44 · M»). Una: Edit · Cancel · **Confirm**. Più: casella per
  riga + **Confirm all** / «Confirm selected». Esiti in luogo dei bottoni:
  «Done · AUD-96 created» (codici apribili), «Cancelled», «Not carried out
  · expired», «Couldn't do it: you can no longer edit tasks in AUD. Nothing
  was changed.» Chi non l'ha chiesta legge «Proposal for Giulia Ferri».
- **Domanda**: «Claude asks» + testo; opzioni come righe 40px a tutta
  larghezza (etichetta + conseguenza su riga muted); la consigliata è
  **prima** con l'etichetta testuale «Recommended»; ultima riga «Other…»
  che apre un campo + «Send answer». Un clic su un'opzione risponde.
  Risposta: la scheda si riduce a «Answered by Giulia Ferri: Use the
  existing template · 10:44». Chi non può: opzioni in sola lettura +
  «Elena Moretti or someone who can approve plans in AUD can answer».
  Concorrente: «Already answered by Marco Bellini».
- **Piano**: «Plan · waiting for approval»; «In brief» (3–6 righe), poi
  «Read the full plan» che espande il markdown dentro la scheda. Con
  `canDecidePlan`: **Approve** · «Reject with instructions» (campo nella
  scheda + «Reject and send»). Senza: «Waiting for someone who can approve
  plans in AUD». Deciso: una riga «Approved by Giulia Ferri · 10:40 · Show
  plan».
- **Righe di risultato**: 14px ink con segno: «PR #142 opened · audin/web ·
  Open», «Review: changes requested», «Correction 2 sent», «Updated the
  design of STW-R4 · See».
- **Consegna** (sotto il messaggio, 12px): «Delivering…», «Delivered»
  (sparisce dopo 3s **[ASSUNZIONE]**), «Not delivered: <motivo> · Resend»
  con i motivi di oggi (es. «The agent had just finished this step: send it
  again now»).
- Riconnessione: riga in testa al flusso «Reconnecting…» con anello; la
  casella resta scrivibile, invio sospeso. Interrotta/finita: ultima fase
  con esito; casella chiusa con la frase del perché.
- Sola lettura: la casella è sostituita da una fascia con il motivo del
  server («This step can only be watched.», «Only someone who can edit
  requests in STW can write here.», «Only a maintainer can write to the
  agent.»).
- Vuoto (conversazione nuova): lo disegna `claude.md`.
- Errore di caricamento: «Couldn't load this conversation» + «Retry»;
  invisibile/inesistente: «This conversation doesn't exist or you can't see
  it».

## 6. Interazione e layout

- **Righe d'azione**: linguaggio semplice + oggetto: «Read `src/export.ts`»,
  «Searched AUD docs for “sync”», «Ran the tests», «Edited 2 files». Le
  consecutive diventano **un gruppo** «▸ 5 actions · Read 3 files, ran the
  tests» (chiuso di default; aperto mentre è in corso, con l'ultima azione
  visibile). Una riga si apre: ingresso e risultato in blocchi monospace di
  sistema, alti al massimo 240px con scorrimento, «Show all» se troncato.
- **Casella** in fondo, fissa: bordo `rule-strong` 8px, cresce fino a 8
  righe. Sotto: graffetta, chip contesto progetto (conversazione libera),
  suggerimento «/ commands · # objects · @ people», bottone di destra.
  Enter invia, Maiusc+Enter va a capo.
- **Allegati**: trascinando sul componente compare un velo «Drop to attach»;
  incolla immagini; chip sopra il campo (miniatura 32px o icona, nome,
  peso, ×). Limiti **[ASSUNZIONE]**: 10 file, 20 MB l'uno, errore in riga.
- **Menu «#», «@», «/»**: si aprono sopra il cursore (320px, flottanti),
  cercano mentre si scrive, frecce + Enter/Tab, Esc chiude. «#» gruppi
  Tasks · Requests · Docs · Files · Projects (codice + nome + progetto);
  «@» persone (avatar, nome, reparto). Scelto, l'oggetto entra come
  **gettone** atomico (codice + nome) che Backspace toglie intero. «/» si
  apre solo a inizio messaggio **[ASSUNZIONE]**: gruppi «Stubwise» e uno
  per plugin («superpowers»), riga = `/name` + descrizione + sorgente; senza
  progetto di contesto una riga in coda «Set a project to see its skills».
- **Ferma**: mentre Claude lavora il bottone di destra è **Stop**; con
  testo scritto diventa **Send** (assorbito nel turno, suggerimento «The
  message reaches Claude when the current action finishes») accanto a
  «Stop and send». Scorciatoia ⌘. = Stop **[ASSUNZIONE]**.
- **Scorrimento**: segue il fondo solo se sei in fondo; altrimenti pillola
  flottante «New messages ↓» sopra la casella. «Load earlier» in cima.
- **Pagina intera**: colonna di lettura fino a 720px (prosa ≤ 68ch), 32px
  di margine; `side` a destra come pannello agganciato.
- **Pannello 360–640px**: niente colonna avatar (nome in riga), fascia
  utente a tutta larghezza, bottoni delle schede che vanno a capo con il
  primario per ultimo a destra, gruppi d'azione sempre chiusi, suggerimento
  della casella ridotto a tre icone con nome accessibile.
- Movimento: comparsa degli eventi 150ms in dissolvenza; schede che si
  riducono a riga 200ms; nulla con movimento ridotto.

## 7. Vincoli e decisioni aperte

- Monospace solo dentro codice e percorsi (eccezione dichiarata nel piano).
- Annunci: `aria-live="polite"` per messaggi finiti di Claude (non per ogni
  frammento), «assertive» per una scheda che chiede a me.
- Permessi letti dal livello dati (`canWrite`, `canInterrupt`, `canAnswer`,
  `canDecidePlan`, richiedente della proposta), mai dedotti.
- **[ASSUNZIONE]** «Edit» su una proposta apre il dialogo della stessa
  azione precompilato; salvarlo esegue e chiude la proposta come
  «Done (edited)».
- **[ASSUNZIONE]** I comandi «/» di Stubwise iniziali: `/today`, `/status`,
  `/explain`, `/new-task`, `/plan`, `/run` (lo spec li lascia al piano).
