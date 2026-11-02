# Shape brief — Le azioni di Claude nella conversazione: righe eseguite, schede per classe, «Undo», righe D

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[CA n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 2 nov 2026: le classi A/B/C/D e i soli due criteri della A (avvisa altre
> persone? fa partire un'automazione?); una classe sale, mai scende;
> «Modifica» solo per `createTask` e `createRequest`; @Claude nella Chat
> resta tutto proposte.

Superficie: dentro `Conversation` (riquadro e destinazione, `conversation.md`
per il resto del flusso):
- `pages/claude/conversation/ExecutedRow.tsx` — la **riga eseguita**;
- `pages/claude/conversation/UndoControl.tsx` — «Undo» e i suoi stati;
- `pages/claude/conversation/ProposalCard.tsx` — la **scheda B/C** (righe
  dei motivi, «Can't be undone», segno della riconferma);
- la **riga D**, che è testo di Claude con un link (nessun tipo d'evento
  nuovo).

Piano 10a: Task 9 (dati: Task 4, 5, 6). Spec area 10: «La regola della
conferma», «Cosa Claude non fa», parte 2 «Annulla», parte 5 «Agire
sull'app». Mondo: «Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**: chi ha chiesto a Claude di fare qualcosa (Giulia, Roberta,
  Laura). Vuole sapere **cosa è successo, su cosa, e se può tornare
  indietro**, in una riga.
- **Chi legge dopo**: un collega che apre una conversazione pubblica di
  Giulia. Deve capire cosa ha fatto Claude senza poter premere niente.
- **Stato d'animo**: fiducia sorvegliata. Un'azione partita da sola deve
  essere evidente quanto una confermata, e mai più importante del testo.

## 2. Esito e prova

- **Azioni primarie**: leggere la riga di ciò che è stato fatto; aprire il
  codice; premere **Undo**; confermare una scheda leggendo chi ne sarà
  toccato; seguire il link di una riga D.
- **Successo**:
  - Giulia: «crea “Prova” in MKX» → riga «✓ Created **MKX-31** “Prova” ·
    assigned to you» con **Undo** a destra; premo Undo → la riga dice
    «Undone»; MKX-31 non c'è più;
  - stessa frase in AUD → Claude scrive «I'm asking first: Matteo Conti
    follows new tasks in AUD.» e sotto la scheda con «Notifies Matteo
    Conti»;
  - «approva il piano di AUD-4» → una riga: «Approving a plan is yours to
    do. Open the plan of AUD-4 →».
- **Verità del prodotto**:
  - **nessuna azione invisibile**: ogni scrittura di Claude è una riga o una
    scheda confermata, col codice apribile;
  - **la UI non afferma ciò che il dato non dimostra**: «Notifies Marco
    Bellini» solo se `reasons` lo dice; «Undone» solo con `undone`;
    «changed it afterwards» solo con `changed_after`; «Done» solo con
    l'esito;
  - **la pagina non decide**: classe, motivi e stato di Undo arrivano da
    `cls`, `reasons`, `undo[groupId]`; nessun `can()` qui.

## 3. Direzione scelta

- **Tesi**: **una riga di catalogo con un verbo al passato**. La riga
  eseguita sta nella gerarchia dell'area 3 al livello delle «righe di
  risultato» (14px ink con segno), sotto il testo di Claude e sopra le righe
  d'azione tecniche. Non è una scheda: le schede restano l'unico contorno
  del flusso, e dicono «decidi tu» **[CA 1]**.
- **Segno**: ✓ ink per eseguita; ↺ ink per annullata; ✕ `critical` solo
  per «Didn't run». Il colore non è mai l'unico segnale: c'è sempre la
  parola.

### La riga eseguita (classe A, e B/C dopo la conferma)

- **Forma**: segno · **verbo al passato** · **codice** 600 cifre tabellari
  (link all'oggetto) · nome tra virgolette · dettagli dopo «·» · a destra
  il controllo di Undo. 14px, altezza minima 32px; va a capo a parole nel
  riquadro.
- **Frasi** (dalle azioni del catalogo, en / it):

| `fn` | en | it |
|---|---|---|
| `createTask` | Created **MKX-31** “Prova” · assigned to you · W45 | Creata **MKX-31** «Prova» · assegnata a te · S45 |
| `updateTask` (stato) | Moved **MKX-31** to In progress | Spostata **MKX-31** in In corso |
| `updateTask` (assegnatario) | Assigned **MKX-31** to Marco Bellini | Assegnata **MKX-31** a Marco Bellini |
| `planTask` | Planned **MKX-31** for W46 · Giulia Ferri | Pianificata **MKX-31** per S46 · Giulia Ferri |
| `setSubscription` | Turned on alerts for new tasks in **MKX** | Accesi gli avvisi per le task nuove in **MKX** |
| `archiveProject` | Archived **OLV** | Archiviato **OLV** |
| `saveProjectAutomations` | Turned off Weekly brief in **MKX** | Spento il Brief settimanale in **MKX** |
| `deleteTask` | Deleted **MKX-31** “Prova” | Eliminata **MKX-31** «Prova» |
| `startRun` | Started Claude on **ACQ-14** | Avviato Claude su **ACQ-14** |

  Le altre voci del catalogo seguono la stessa forma «verbo + oggetto», con
  i nomi delle impostazioni come nelle loro pagine. Il codice di un oggetto
  eliminato o non più visibile si legge come uno inesistente: testo
  `ink-faint`, non link, senza nome (R-E9) **[CA 2]**.
- **Coda in pausa** (9b): «Started Claude on **ACQ-14** · waiting: queue
  paused by Roberta Fontana» / «Avviato Claude su **ACQ-14** · in attesa:
  coda messa in pausa da Roberta Fontana».
- **Più azioni nello stesso gruppo** (una scheda confermata con due righe):
  una riga per azione, una sotto l'altra, e **un solo** controllo Undo
  sotto l'ultima, che dice «Undo both» / «Annulla entrambe» (due) o «Undo
  all 3» / «Annulla tutte e 3» (più) — si annullano insieme o niente
  **[CA 3]**.

### «Undo» e i suoi stati (`UndoControl`, da `ConversationDetail.undo`)

| Stato | Cosa si vede (en / it) |
|---|---|
| `available` | bottone testo **Undo** / **Annulla** a destra della riga (o sotto, nel riquadro stretto) |
| `available` + `needsReauth` | **Undo** e, 12px `ink-faint` accanto, «asks for your code» / «chiede il codice» |
| `undone` (chi guarda) | ↺ «Undone» / «Annullata», 13px `ink-muted`, al posto del bottone; il codice della riga diventa testo se l'oggetto non c'è più |
| `undone` (altra persona, dopo un «vedi come») | ↺ «Undone by Giulia Ferri» / «Annullata da Giulia Ferri» |
| `changed_after` con nome e codice | «Marco Bellini changed it afterwards · can't undo from here» / «Marco Bellini l'ha modificata dopo · non si annulla da qui» + link «Open MKX-31» / «Apri MKX-31» |
| `changed_after` senza nome o codice | «It was changed afterwards · can't undo from here» / «È stata modificata dopo · non si annulla da qui», nessun link |
| `not_undoable` | «Can't be undone» / «Non si annulla», 13px `ink-muted`, nessun bottone |
| `not_yours` | niente: la riga è chiusa |

- Per un oggetto al maschile (progetto, traguardo) le frasi it concordano:
  «Annullato», «l'ha modificato dopo».
- **Rifiuti al clic** (la riga sostituisce il controllo con la frase; niente
  cambia):
  - `forbidden`: «You can no longer undo this in OLV. · Who?» / «Non puoi
    più annullarlo in OLV. · Who?» (`WhoCanLink` con `whoAction` e
    progetto; senza progetto: «You can no longer undo this. · Who?»);
  - `busy`: «Can't undo yet: Claude is working on **MKX-31**.» / «Non si
    annulla ancora: Claude sta lavorando su **MKX-31**.»; «…: pull request
    #42 is open on **MKX-31**.» / «…: la pull request #42 è aperta su
    **MKX-31**.»; poi «Try again when it's done.» / «Riprova quando ha
    finito.» e **Undo** resta premibile;
  - `changed_after`: come la riga della tabella;
  - `already_undone`: «Already undone.» / «Già annullata.»;
  - `not_found`: «Can't find MKX-31.» / «Non trovo MKX-31.» (la stessa di un
    codice inesistente);
  - riconferma chiusa senza codice: niente cambia, toast «Nothing was
    changed.» / «Non è cambiato nulla.», **Undo** di nuovo premibile;
  - errore del livello finto: «Couldn't undo. Try again.» / «Impossibile
    annullare. Riprova.» · **Retry** / **Riprova**; dopo un Retry riuscito la
    riga diventa «Undone» (il seguito arriva).
- **Fuoco**: dopo Undo (riuscito o rifiutato) il fuoco resta sulla riga, sul
  suo testo nuovo (`tabIndex=-1`), non torna in cima.

### «Didn't run»

- Un'azione A che parte all'invio e viene rifiutata: ✕ `critical` «Didn't
  run: <motivo>» / «Non eseguita: <motivo>», con il verbo al presente
  dell'azione nella riga sotto, 13px `ink-muted` («Create “Prova” in
  MKX» / «Creare «Prova» in MKX»). Motivi:
  - permesso: «you can't create tasks in MKX · Who?» / «non puoi creare
    task in MKX · Who?» (`whoAction` della voce);
  - oggetto non trovato: «can't find MKX-31» / «non trovo MKX-31»;
  - `busy`: le ragioni in parole come sopra;
  - `invalid`: «something in the request isn't valid, nothing was changed»
    / «qualcosa nella richiesta non è valido, non è cambiato nulla».
- Nessun Undo (non è cambiato niente).
- **Classe salita fra calcolo ed esecuzione**: non è un «Didn't run». Claude
  scrive «I'm asking first: <motivo>» / «Ti chiedo prima: <motivo>» e sotto
  arriva la scheda B (`classRaised`).

### La scheda B/C (`ProposalCard`, area 3 più le righe dei motivi)

- Intestazione e righe d'azione come nell'area 3 («Claude proposes · 1
  change» / «Claude propone · 1 modifica»).
- **Sotto le righe d'azione, prima dei bottoni**, un blocco di righe 13px
  `ink-muted`, ognuna con un segno ink a sinistra (16px), nell'ordine:
  1. **notifies** (segno: campanella): «Notifies Marco Bellini» / «Avvisa Marco Bellini»;
     due: «Notifies Marco Bellini and Matteo Conti» / «Avvisa Marco Bellini
     e Matteo Conti»; tre o più: «Notifies Marco Bellini, Matteo Conti and
     Laura Costa»; con `more`: «Notifies Marco Bellini and others who
     follow this in AUD» / «Avvisa Marco Bellini e altri che lo seguono in
     AUD»; solo `more`: «Notifies people who follow this in AUD» / «Avvisa
     chi lo segue in AUD» — mai un numero **[CA 4]**;
  2. **automation** (segno delle automazioni): «An automation in ACQ starts
     when a task is created» / «In ACQ parte un'automazione quando nasce
     una task»; `task_closed`: «…when a task is closed» / «…quando una task
     si chiude»; senza nome né codice dell'automazione **[CA 5]**;
  3. **irreversible** (⊘): «Can't be undone» / «Non si annulla»;
  4. **reauth** (segno: lucchetto): «Asks for your two-step code» / «Chiede il codice a
     due fattori» — è il segno della classe C.
- **Bottoni**:
  - `createTask`, `createRequest`: **Edit** · **Cancel** · **Confirm**
    (come oggi);
  - tutte le altre: **Cancel** · **Confirm**, nessun Edit;
  - con `deleteTask` nel gruppo, **Confirm** è `critical` e dice «Delete» /
    «Elimina» **[CA 6]**.
- **Conferma C**: **Confirm** → il dialogo «Confirm it's you» (`entry.md`)
  si apre **sopra** il riquadro, con la frase dell'azione dal riassunto
  della scheda: «To add Luca Bianchi to ACQ as Developer, enter a code from
  your authenticator app.» / «Per aggiungere Luca Bianchi ad ACQ come
  Developer, inserisci un codice dell'app di autenticazione.» Codice giusto
  → l'azione riparte da sola, la scheda diventa «Done» senza un secondo
  clic; Cancel/Esc → la scheda resta aperta, toast «Nothing was changed.»,
  il fuoco torna su **Confirm**.
- **Dopo la conferma**: la scheda si riduce a «Done · **ACQ-15** created» /
  «Fatto · **ACQ-15** creata» (area 3) e **sotto l'esito** compare
  `UndoControl` del gruppo, con gli stati della tabella. Una scheda con
  `irreversible` non ha Undo: «Can't be undone».
- **Esiti negativi** (area 3): «Couldn't do it: you can no longer archive
  projects in OLV. Nothing was changed. · Who?» / «Non è stato possibile:
  non puoi più archiviare progetti in OLV. Non è cambiato nulla. · Who?».
- **Scheda di Giulia confermata dopo il passaggio a Sara**: non succede, la
  scheda non è nel DOM di Sara; tornando a Giulia è ancora aperta.

### La riga D (Claude non lo fa)

- È **testo di Claude**: una frase, poi un link in fondo con la freccia.
  Nessuna scheda, nessun bottone, nessun Undo.

| Tema | en | it | Link |
|---|---|---|---|
| `approve_plan` | Approving or rejecting a plan is yours to do. Open the plan of **AUD-4** → | Approvare o rifiutare un piano tocca a te. Apri il piano di **AUD-4** → | la scheda del piano |
| `merge` | Merging is yours to do, from the release queue. Open the release queue of **ACQ** → | Il merge tocca a te, dalla coda di rilascio. Apri la coda di rilascio di **ACQ** → | coda di rilascio |
| `answer_question` | Answering Claude's question is yours to do. Open the question on **AUD-4** → | Rispondere alla domanda di Claude tocca a te. Apri la domanda su **AUD-4** → | la conversazione |
| `record_decision` | The decision log is written by people, not by me. Open “Record a decision” for **AUD-4** → | Il registro decisioni lo scrivono le persone, non io. Apri «Registra una decisione» per **AUD-4** → | dialogo con testo **vuoto** |
| `activate_automation` | Turning an automation on is yours to do. Open **ACQ-A3** in the builder → | Accendere un'automazione tocca a te. Apri **ACQ-A3** nel costruttore → | costruttore |
| `secret` | I don't create or show tokens, keys or invite links. Open Preferences → Tokens → | Non creo e non mostro token, chiavi o link d'invito. Apri Preferenze → Token → | il dialogo vero |
| `server` | I don't act on servers. Open **SRV-2** → | Non agisco sui server. Apri **SRV-2** → | pagina del server |
| `send` | Sending is yours to do: I don't send emails or replies. Open the reply → | L'invio tocca a te: non mando email né risposte. Apri la risposta → | il campo |
| deploy | Stubwise doesn't deploy: merging a pull request is as far as it goes. | Stubwise non fa deploy: si ferma al merge di una pull request. | nessuno |

- Senza un oggetto riconosciuto, il link porta al posto generale (le
  Decisioni, Preferenze → Token, Amministrazione → Invita).
- **Codice invisibile o inesistente**: «Can't find AUD-99.» / «Non trovo
  AUD-99.», identico nei tre casi (invisibile, inesistente, eliminata).

### Una conversazione pubblica letta da un altro

- Righe eseguite: segno, verbo, codice (link solo se chi legge lo vede,
  altrimenti `ink-faint` senza nome), nessun controllo Undo e **nessuno
  stato** di Undo (`not_yours`): la riga non dice «Undone» né «changed it
  afterwards» **[CA 7]**.
- Schede: chiuse; aperte si leggono «Proposal for Giulia Ferri» (area 3),
  confermate «Done · …», senza Undo. Le righe dei motivi restano: sono
  scritte con la visibilità di chi le legge (nomi che non vede: la riga
  non c'è).
- Righe D: testo normale; il link funziona solo se chi legge vede la meta.

```
1440 ── riquadro (400px) ──────────────────────────
│ GIULIA FERRI · on MKX                            │
│ ░ create "Prova" in MKX for me                  ░│
│ (CL) Claude · 10:41                              │
│ Done. It's yours, in MKX for this week.          │
│ ✓ Created MKX-31 “Prova” · assigned     Undo     │
│   to you · W45                                   │
│ GIULIA FERRI                                     │
│ ░ same in AUD                                   ░│
│ Claude · 10:42                                   │
│ I'm asking first: Matteo Conti follows new tasks │
│ in AUD.                                          │
│ ┌ ● Claude proposes · 1 change ────────────────┐ │
│ │ Create in AUD: “Prova” · Giulia Ferri · W45  │ │
│ │ (bell) Notifies Matteo Conti                 │ │
│ │                  [Edit] [Cancel] [Confirm]   │ │
│ └──────────────────────────────────────────────┘ │
│ Claude · 10:43                                   │
│ Approving or rejecting a plan is yours to do.    │
│ Open the plan of AUD-4 →                         │
```

## 4. Ambito e confini

- **Dentro**: riga eseguita (singola e di gruppo), tutti gli stati di Undo
  e i rifiuti, «Didn't run», righe dei motivi, scheda C con riconferma,
  esiti, righe D, lettura altrui.
- **Fuori**: le azioni in blocco di S4 con «tolgo una riga» e le righe sotto
  la scheda (10b); le schede di scelta di S1/S5 (10b); la «Modifica» di
  azioni diverse da `createTask`/`createRequest`.
- **Anti-obiettivi**: un Undo visibile a chi non ha chiesto; un'azione
  partita da sola che appare come proposta (o il contrario); una riga dei
  motivi che conta o nomina persone che chi chiede non vede; un bottone
  «Approve», «Merge», «Activate», «Send» nel flusso; un Edit che apre il
  dialogo di un'azione vietata; «Undone» quando il gruppo non è annullato.

## 5. Stati e intervalli

- Gruppi da 1 a ~20 azioni (le schede in blocco del 10b arrivano a
  decine; qui oltre 5 righe la scheda mostra le prime 5 e «Show 3 more» /
  «Mostra altre 3»).
- Nomi fino a ~80 caratteri: la riga va a capo, il codice non si spezza.
- Righe dei motivi: da 0 (nessun blocco) a 4.
- Persone in «Notifies»: fino a 3 per nome, poi «and 4 more» / «e altre 4»
  — solo persone visibili, quindi il numero conta solo quelle **[CA 4]**.
- **Senza permessi**: «Didn't run … · Who?» e il rifiuto di Undo con
  «Who?». Nessun bottone spento senza frase.

## 6. Interazione e layout

- Una riga eseguita compare nel flusso con la dissolvenza degli eventi
  (150ms); il passaggio «Undo» → «Undone» è un cambio di testo (150ms), la
  riga non salta.
- **1440** (destinazione a pagina intera, colonna ≤ 720px): riga su una
  linea, Undo a destra, allineato al bordo della colonna; scheda con i
  bottoni a destra.
- **Riquadro (360–400px) e 1024**: la riga va a capo dopo il nome; Undo
  resta a destra della prima linea se c'è posto, altrimenti scende sotto,
  allineato a destra. I bottoni della scheda vanno a capo con il primario
  per ultimo a destra (area 3). Le righe dei motivi sempre a tutta
  larghezza.
- Annunci: una riga eseguita è annunciata `polite` («Created MKX-31»);
  «Undone» anche.

## 7. Vincoli

- Si leggono `cls`, `reasons`, `undo[groupId]`, `whoAction`, `busy`; mai
  `can()` né `viewer` nei file di `pages/claude/conversation/` toccati qui.
- **Dove compare «Who?»**: «Didn't run» per permesso; rifiuto `forbidden` di
  Undo; esito «Couldn't do it» di una scheda per permesso. **Non** in
  `busy`, `changed_after`, `not_found`, `already_undone`, nelle righe D.
- **Dove compare +R**: la scheda C (riga «Asks for your two-step code» e
  dialogo alla conferma); Undo con `needsReauth` («asks for your code» e
  dialogo al clic). Classi C del 10a: `addMember`, `removeMember`,
  `setMemberRole`, `registerPlugin`, `updatePluginRef`, `saveStorage`.
  «Delete task» non è +R.
- **Voci del registro** (frasi in `claude-trace.md`): ogni azione eseguita
  scrive le voci del suo tipo con `via: "claude"`; ogni Undo scrive le voci
  del tipo inverso con `undoOf`. La conversazione non scrive voci sue.
- Testi en/it con parità; in it «Annulla» è sia «Cancel» della scheda
  aperta sia «Undo» della riga: non compaiono mai insieme.

## Scelte del brief (scelte del controller, da confermare)

1. **[CA 1]** La riga eseguita è una riga di risultato, non una scheda.
2. **[CA 2]** Il codice di un oggetto eliminato nella riga si legge come uno
   inesistente.
3. **[CA 3]** Un gruppo ha un solo Undo, «Undo both» / «Undo all 3».
4. **[CA 4]** «Notifies» elenca fino a 3 persone visibili; `more` diventa
   «and others who follow this in AUD», mai un numero.
5. **[CA 5]** La riga dell'automazione non nomina l'automazione (il motivo
   porta solo il progetto).
6. **[CA 6]** Con `deleteTask` nella scheda, Confirm è rosso e dice
   «Delete».
7. **[CA 7]** Chi legge una pubblica altrui non vede lo stato di Undo,
   nemmeno «Undone».

## Scelte confermate (2 nov 2026)

1. **[CA 4]** *(scelta del controller, confermata)*: con persone che chi
   chiede non vede, «… and others who follow this in AUD» / «… e altri che
   lo seguono in AUD», mai un numero.
2. *(maintainer)*: un'azione A eseguita lascia **solo** la riga nella
   conversazione e la voce nel registro; **nessun toast**, né nel riquadro
   né sulla pagina sotto, anche a riquadro chiuso.
3. *(controller)*: il nome del seme è **Matteo Conti** (non «Matteo
   Rossi»): testi e test del Task 9 lo usano.
4. Le altre scelte di questo brief sono approvate col brief.
