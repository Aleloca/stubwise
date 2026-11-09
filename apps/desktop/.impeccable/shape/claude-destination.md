# Shape brief — Destinazione «Claude»

Superficie: `#/claude` (colonna + elenchi) e `#/claude/<id>` (pagina della
conversazione o della sessione). Piano: Task 6. Spec: area 3 §2, §4, §5.
Mondo: «Catalogo numerato», modalità **Operate**. Il flusso stesso è in
`conversation.md`. **[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Chiunque vuole chiedere qualcosa a Claude (conversazione libera); chi
  coordina e vuole vedere cosa sta facendo Claude adesso nei suoi progetti;
  chi ritrova una conversazione o una sessione finita.
- Stato d'animo: o «chiedo» (vuole scrivere subito), o «controllo» (scorre
  le sessioni vive). La destinazione apre sul primo, mostra il secondo a un
  clic con il conteggio già in colonna.

## 2. Esito e prova

- Azione primaria: iniziare una conversazione; seconda: aprire una
  sessione viva.
- Successo: dalla colonna si capisce quante sessioni sono vive e se una
  aspetta me, senza aprire nulla; una conversazione pubblica si legge e si
  continua senza mescolare identità.
- Verità: ogni riga ha tipo, titolo, progetto con codice, stato o esito e
  ciò che Claude sta facendo **adesso** in parole («Editing
  `src/export.ts`», «Asking a question»).

## 3. Direzione scelta

- **Tesi**: la stessa forma delle altre destinazioni personali — colonna di
  ambiti, area di lavoro con h1 — più un elenco **Recent** in colonna, come
  l'app di Claude, per tornare in un clic alle proprie conversazioni.
- **Colonna** (240px, nessun titolo): bottone a tutta riga «New
  conversation» (⌘N in questa destinazione **[ASSUNZIONE]**) → voci 32px
  con conteggio: **Working now** N (punto «ti aspetta» se una sessione mi
  chiede qualcosa) · **Mine** · **Public** (solo con `claude.public.view`)
  · **Finished** → filetto → `heading-group` RECENT con le ultime 8 mie
  conversazioni (titolo su una riga, anello se Claude ci lavora)
  **[ASSUNZIONE]**.
- **Atterraggio** `#/claude` = nuova conversazione vuota **[ASSUNZIONE]**:
  h1 «New conversation», casella grande in alto, sotto quattro suggerimenti
  come righe di testo («What should I do today?», «Where do my projects
  stand?», «Explain AUD-12», «How does Gmail sync work in STW?»), chip
  «Project: none ▾».
- **Elenchi** (`?scope=live|mine|public|finished`): h1 col nome
  dell'ambito e conteggio, barra filtri (Project, Type, Outcome — Outcome
  solo in Finished), righe 44px.
- **Pagina** `#/claude/<id>`: h1 = titolo (una riga, ellissi), sotto la
  riga meta «Task run · AUD-91 Price list sync · Working» oppure «Private
  conversation · Project: AUD» e a destra «Make public» + «⋯» (Rename,
  Archive, Delete); poi la conversazione. Sessione legata a un oggetto: a
  destra il **lato oggetto** (pannello agganciato 360px) con la task o la
  richiesta in breve (codice, titolo, stato, persona, taglia) e «Open task».
- **Momento focale**: la riga di Working now che aspetta me, in testa
  all'elenco col punto pieno.

```
┌rail┬column───────────────┬─Working now 4──────────────────────────────┐
│    │ [+ New conversation]│ Project ▾  Type ▾                          │
│ ✳● │ Working now   4 ●   │ ● Task run  AUD-91 Price list sync   AUD   │
│    │ Mine         12     │     Asking a question             2 min    │
│    │ Public        3     │ ◌ Task run  STW-3 Board view with drag STW │
│    │ Finished            │     Editing src/board/Lane.tsx     now     │
│    │ ─ RECENT ────────── │ ◌ Refine    STW-R4 Quiet hours        STW  │
│    │ Plan next week AUD  │     Updating the plan              1 min   │
│    │ Explain OLV-14      │ ◌ Docs      Generating 6 pages        AUD  │
│    │ ◌ Run STW-R1        │     Writing “Invoices”             now     │
└────┴─────────────────────┴────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: colonna, quattro elenchi con filtri, atterraggio vuoto, pagina
  con lato oggetto, rinomina/archivia/elimina, `PublishDialog`, «Make
  private», `ContinueBanner` e continuazione, voci del palette «New
  conversation with Claude» e «Ask Claude…».
- Fuori: il flusso (componente); scelta di modelli/provider; condivisione
  delle sessioni di lavoro (seguono il progetto, niente «Make public»).
- Anti-obiettivi: una tabella tecnica di job; tipi distinti solo per
  colore; sessioni di posta visibili a chi non è il titolare.

## 5. Stati e intervalli

- Volumi: Working now 0–~15; Mine 0–~200 (archiviate escluse, filtro
  «Archived» in Mine **[ASSUNZIONE]**); Public 0–~50; Finished ultimi 14
  giorni poi «Show older». Titoli fino a ~80 caratteri.
- **Riga**: segno di stato · tipo (parola: Conversation, Task run, Refine,
  PR review, Docs, Brief, Daily report, Mail, Intake) · codice + titolo (o
  titolo della conversazione) · progetto (codice) · attività corrente o
  esito · tempo. Una riga da 44px in Mine, Public e Finished; in **Working
  now** due righe da 56px con l'attività sotto il titolo, perché lì è
  l'informazione principale **[ASSUNZIONE]**. Sotto 1280 il tipo cade nel
  `title`, l'attività resta, il tempo si accorcia.
- Stato con segno + parola: anello tratteggiato «Working», punto pieno
  «Waiting on you» / «Waiting for an answer», «Waiting for approval»,
  «Paused», esiti «Done», «Failed» (critico), «Timed out» (avviso),
  «Stopped».
- Vuoti: Working now «Claude isn't working on anything you can see»; Mine
  «No conversations yet · New conversation»; Public «Nobody has shared a
  conversation yet»; filtri senza risultati «Nothing matches · Clear
  filters». Caricamento: 8 righe scheletro. Errore: «Couldn't load
  conversations» + «Retry».
- Senza `claude.public.view`: niente voce Public; un link diretto a una
  pubblica → «This conversation doesn't exist or you can't see it».
- Testata di una pubblica: «Public · made public by Giulia Ferri on Oct 22»
  (12px muted, con «Make private» per l'autore).

## 6. Interazione e layout

- **Make public** → dialogo 480px «Make this conversation public?»: frase
  «Anyone who can see public conversations will read it, including what
  Claude found.»; `heading-group` «PROJECTS CLAUDE READ OR CHANGED» con
  righe codice + nome (lette e toccate, senza distinguere
  **[ASSUNZIONE]**); frase «People who can't see one of these projects will
  read the text, but its codes won't open.»; bottoni «Cancel» · **«Make
  public, I'm responsible»** **[ASSUNZIONE: niente casella da spuntare, la
  responsabilità sta nel bottone]**. Nessun progetto toccato: l'elenco dice
  «Claude didn't use any project».
- Se dopo la pubblicazione Claude tocca un progetto nuovo: i messaggi
  successivi restano privati; fascia nel flusso «New messages are private:
  Claude used MKX. Confirm to share them» → stesso dialogo con il solo
  progetto nuovo.
- **Continue banner** (pubblica altrui): fascia sopra la casella «What you
  write starts your own private conversation. Claude will act as you.»;
  segnaposto «Continue in your own conversation…». All'invio si naviga
  alla continuazione (transizione 200ms), che porta in testa «Continues
  from “Plan next week AUD” · Giulia Ferri» (link). Le proposte della
  pubblica sono in sola lettura per chi continua.
- **Rename**: l'h1 diventa campo sul posto (Enter salva, Esc annulla).
  **Archive**: toglie da Mine e Recent, toast «Archived · Undo». **Delete**:
  dialogo «Delete “…”? This can't be undone. Public copies others continued
  stay theirs.» — solo l'autore; sessioni di lavoro non si eliminano.
- **Lato oggetto**: agganciato da 1200px, sotto diventa un bottone «Task
  AUD-91» in testata che apre il pannello sovrapposto.
- Tastiera: J/K fra righe, Enter apre, N nuova conversazione
  **[ASSUNZIONE]**, Esc dalla pagina torna all'elenco da cui si è arrivati.
- 1024×680: colonna intatta, area 720px; riga senza tipo; nella pagina il
  lato oggetto non si aggancia.

## 7. Vincoli e decisioni aperte

- Visibilità decisa da `canSeeConversation` nel livello dati; la colonna
  conta solo ciò che chi guarda vede.
- Cambio di persona: elenchi e Recent si ricaricano; la pagina di una
  conversazione non più visibile mostra «doesn't exist or you can't see it».
- **[ASSUNZIONE]** Titolo automatico = prima domanda accorciata a ~60
  caratteri, sostituito dopo la prima risposta da un titolo breve.
- **[ASSUNZIONE]** Le sessioni brief e report giornaliero compaiono solo in
  Finished (nascono concluse).
