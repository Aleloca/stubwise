# Shape brief — Destinazione «Chat» e canale

Superficie: `#/chat` (colonna + `ChannelView`), `#/chat/<channelId>`, la
sezione «Chat» del progetto (`#/projects/<code>/chat/<channelId>`) e le
viste «Threads» e «Mentions». Piano: Task 4, 6, 8. Spec: area 4 «Canali»,
«Messaggi», «Citazioni», «Menzioni e non letti», «Eventi», «Dove vive».
Mondo: «Catalogo numerato», modalità **Operate**; il testo dei messaggi è
un tratto di **Read**. Deve sembrare della stessa famiglia della
conversazione con Claude (`conversation.md`). **[ASSUNZIONE]** = da
confermare.

## 1. Lavoro e pubblico

- Tutti i reparti, tutto il giorno: chi passa dal canale del progetto a un
  messaggio diretto, chi recupera dopo una riunione, chi cita una task per
  chiedere a un collega. Conoscono Slack: canali, DM, thread, reazioni,
  menzioni devono stare dove se li aspettano.
- Due ritmi: **scorrere** (cosa è successo, cosa mi riguarda) e
  **rispondere** (scrivo, cito, reagisco). Il primo vive nella colonna, il
  secondo nel canale.

## 2. Esito e prova

- Azione primaria: leggere ciò che mi riguarda e rispondere; secondaria:
  citare un oggetto di Stubwise senza uscire.
- Successo: dalla colonna capisco dove ci sono messaggi nuovi e dove sono
  chiamato **io**, senza aprire nulla; un oggetto citato si legge come
  codice + nome e si apre con un clic; gli eventi di sistema non
  sommergono le persone.
- Verità del prodotto: lo storico non scade; ogni citazione segue la
  visibilità di chi legge (R-E9); i canali di un progetto sono **gli
  stessi** nella Chat e nel progetto.

## 3. Direzione scelta

- **Tesi**: l'impianto di Slack (colonna di canali, flusso a sinistra con
  avatar, thread a destra) dentro la forma del Catalogo: niente bolle,
  niente colori per autore, filetti al posto dei riquadri, codici in cifre
  tabellari. Le uniche cose con un contorno nel flusso sono le **schede**:
  eventi di sistema e (nel thread) proposte di Claude — come nella
  conversazione.
- **Colonna** (240px, nessun titolo: l'h1 è del canale): bottone a tutta
  riga «New message» (⌘N in questa destinazione **[ASSUNZIONE]**), campo
  32px «Search messages» con ⌘F (vedi `chat-search.md`), poi voci 32px
  **Threads** e **Mentions** con conteggio; filetto; `heading-group`
  CHANNELS con i sottogruppi per progetto (riga 28px: codice 600 + nome
  muted, freccia per chiudere), poi il sottogruppo «Company» dei generali;
  in coda «Browse channels»; filetto; `heading-group` DIRECT MESSAGES.
- **Ordine dei progetti**: prima i progetti fissati nel binario, nel loro
  ordine, poi gli altri in ordine alfabetico di codice **[ASSUNZIONE]**.
  Un sottogruppo senza nulla di non letto è **chiuso** di default (si vede
  solo la riga del progetto) e si ricorda aperto/chiuso per persona: con
  ~50 progetti la colonna altrimenti è un muro di «general»
  **[ASSUNZIONE]**. *(Approvato dal maintainer il 24 ott 2026: i progetti
  né fissati né con non letti o menzioni si raccolgono in una riga chiusa
  «Other projects · N» / «Altri progetti · N», così i DM stanno sopra la
  piega a 1440×900.)*
- **Riga canale**: glifo `#` (aperto) o lucchetto (privato) + nome; letto
  = ink-muted; **non letto** = ink 600; **menzioni** = conteggio in
  pastiglia piena d'inchiostro a destra (il segnale «ti aspetta» del
  sistema, mai rosso); silenziato = ink-faint con campanella barrata, non
  diventa grassetto. Bozza presente: matita 12px al posto del conteggio.
  Riga chiusa del progetto: punto pieno se qualcosa sotto ha menzioni,
  grassetto se solo non letti.
- **Riga DM**: avatar 20px con iniziali + nome; gruppo = nomi separati da
  virgola con ellissi e numero «+2»; non letto in grassetto con conteggio
  (ogni messaggio di un DM conta come menzione, come in Slack).
- **Testata del canale**: h1 28px «AUD · general» (codice in cifre
  tabellari, ink-muted; il nome in ink); sotto, 13px muted «Open · 14
  members · Topic: Release 2.4 on Nov 3» (argomento cliccabile da chi può
  modificarlo); a destra avatar impilati + numero membri (apre Members),
  interruttore «People only» (nasconde i messaggi di sistema), «⋯»
  (Settings, Notifications, Copy link, Leave). Filetto sotto.
- **Momento focale**: la riga «New» nel canale con il primo messaggio che
  mi menziona sotto, e la pastiglia di menzione nella colonna.

```
┌rail┬column──────────────────┬─AUD · general────────────────────────────┐
│    │ [+ New message      N] │ Open · 14 members · Topic: 2.4 on Nov 3  │
│ 💬●│ ⌕ Search messages  ⌘F  │                   (GF)(MB)+12 People only⋯│
│    │ Threads             2  │ ── Yesterday ──────────────────────────── │
│    │ Mentions            1  │ (MB) Marco Bellini · 16:02                │
│    │ ─────────────────────  │      Export is green. AUD-88 Invoice      │
│    │ CHANNELS               │      export check can close.              │
│    │ ▾ AUD Audin 2.0        │      👍 3   ✅ 1                           │
│    │   # general       (1)  │      (GF)(EM) 4 replies · last by Elena   │
│    │   # releases           │ ┌ Release page · AUD 2.4 published ─────┐ │
│    │ ▸ MKX Campagne prim… ● │ │ REL-7 Audin 2.4 · 12 changes · Open    │ │
│    │ ▸ STW Stubwise         │ └────────────────────────────────────────┘ │
│    │   Company              │ ── New ─────────────────────────────────── │
│    │   # announcements      │ (EM) Elena Moretti · 09:14                │
│    │ Browse channels        │      @Giulia can you check AUD-91 Price   │
│    │ ─────────────────────  │      list sync before noon?               │
│    │ DIRECT MESSAGES        │ ┌────────────────────────────────────────┐│
│    │ (MB) Marco Bellini  2  │ │ Message AUD · general                  ││
│    │ (EM) Elena, Sara +1    │ │ [📎]          # objects · @ people [Send]││
└────┴────────────────────────┴─┴────────────────────────────────────────┴┘
```

## 4. Ambito e confini

- Dentro: colonna, canale (flusso, casella, testata), viste Threads e
  Mentions, sezione Chat del progetto, segnale sul binario, stati del
  messaggio e del canale, «Crea task/richiesta» dal messaggio.
- Fuori: pannello thread e @Claude (`chat-thread.md`), creazione e
  impostazioni dei canali, DM nuovi, Browse (`chat-manage.md`), ricerca
  (`chat-search.md`), chiamate, presenza, messaggi programmati.
- Anti-obiettivi: bolle o colori per autore; un pallino rosso «stile
  Slack» (il rosso è critico); eventi automatici che occupano più spazio
  di un messaggio di persona; un secondo posto con messaggi diversi per lo
  stesso canale.

## 5. Stati e intervalli

- Volumi: 0–~80 canali per persona, 0–~40 DM; un canale da 0 a migliaia
  di messaggi (finestra di 50, «Load earlier» automatico salendo,
  posizione mantenuta); messaggi da una parola a ~4.000 caratteri; 0–40
  reazioni diverse (vanno a capo); blocchi di codice larghi: scorre il
  **blocco**, mai la pagina; nomi canale fino a 40 caratteri (ellissi in
  colonna, intero nel `title`).
- **Raggruppamento**: stesso autore entro 5 minuti e senza separatori =
  un gruppo; solo il primo ha avatar 32px e «Nome · 16:02»; i successivi
  mostrano l'ora 12px faint nel margine dell'avatar al passaggio.
- **Separatori di giorno**: filetto con etichetta a sinistra «Today»,
  «Yesterday», «Thursday, Oct 22», «Oct 2, 2025» (anno solo se diverso);
  l'etichetta resta in cima mentre si scorre **[ASSUNZIONE]**.
- **Riga «New»**: filetto 1px d'inchiostro pieno con l'etichetta «New» in
  ink 600 a sinistra; resta finché si esce dal canale. Entrando, il canale
  si apre sulla riga «New» se c'è, altrimenti in fondo.
- **Reazioni**: gettoni alti 24px, raggio 6px, bordo `rule`, emoji +
  conteggio tabellare; la mia = tinta ink 10% e bordo `rule-strong`; clic
  = aggiungi/togli; passaggio = «Giulia Ferri, Marco Bellini and 3 others
  reacted with 👍». Al passaggio del messaggio compare un gettone «+».
  Selettore: 6 più usate da chi guarda in testa + griglia per categoria
  con ricerca, elenco fisso Unicode.
- **Conteggio thread**: riga sotto il messaggio, avatar impilati (max 3) +
  «4 replies» (ink 600) + «Last reply by Elena Moretti · 2h ago» muted;
  risposte nuove per me: punto pieno davanti. Claude sta rispondendo:
  anello tratteggiato + «Claude is replying…».
- **Risposta «anche nel canale»**: nel flusso con una riga sopra 12px
  muted «replied to a thread: Export is green…» (apre il thread).
- **Messaggio di sistema**: senza avatar di persona; scheda 1px
  `rule-strong` raggio 8px, alta una o due righe: intestazione 12px muted
  «Release page published · 09:02» poi riga catalogo «REL-7 Audin 2.4 ·
  12 changes» + «Open». Tipi: Release page, PR opened, PR merged,
  Milestone reached, Weekly brief ready, New request, Task closed. Eventi
  consecutivi dello stesso tipo entro 10 minuti si raccolgono in una
  scheda «3 tasks closed» con l'elenco richiudibile **[ASSUNZIONE]**.
- **Modificato**: «(edited)» 12px faint dopo il testo, `title` con ora.
  **Eliminato**: riga «Message deleted» 13px faint, nessun avatar né
  testo; se ha risposte resta con il conteggio thread; senza risposte e
  più vecchio di un giorno sparisce dal flusso **[ASSUNZIONE]**.
- **Consegna**: in invio = testo ink-muted, «Sending…» solo dopo 1s; non
  inviato = «Not sent» in critico + «Resend» · «Delete» sotto il
  messaggio; il testo resta lì finché non decidi.
- **Citazioni**: `CitationLink` della conversazione (codice 600 + nome,
  anteprima a 250ms con stato, persona, ultimo aggiornamento); un codice
  scritto a mano («AUD-88») diventa link da sé; invisibile = solo codice
  ink-faint non apribile, «You can't open this» (R-E9). Un messaggio da
  cui è nata una task porta una riga 12px «→ AUD-14 Banner copy review».
- Canale vuoto: «This is the start of AUD · releases» + descrizione +
  «Created by Marco Bellini on Oct 3». Colonna senza canali: «You're not
  in any channel yet · Browse channels». Caricamento: 6 gruppi scheletro.
  Errore: «Couldn't load messages» + «Retry»; invio fallito non tocca il
  resto.
- **Archiviato**: testata con «Archived» in parole; la casella è
  sostituita da una fascia «This channel was archived by Marco Bellini on
  Oct 20. You can read it, not write in it.» (+ «Unarchive» per chi
  gestisce). In colonna non compare; si raggiunge da ricerca e Browse.
- **Aperto non membro**: il flusso si legge; al posto della casella la
  fascia «You're not in this channel» + **Join channel**; in UI non c'è
  ingresso silenzioso al primo invio, perché senza adesione non c'è
  casella **[ASSUNZIONE]**.
- Inesistente o non leggibile: «This channel doesn't exist or you can't
  see it» (privato visto da chi gestisce: `chat-manage.md`).

## 6. Interazione e layout

- **Flusso**: colonna di lettura allineata a sinistra con 32px di
  margine, larga fino a 760px (testo ≤ 72ch) **[ASSUNZIONE]**; avatar
  32px, testo 14px ink, markdown della conversazione. Passaggio sul
  messaggio = tinta ink 4% su tutta la riga + barra flottante in alto a
  destra (bordo `rule-strong`, raggio 6px, ombra dei flottanti): 3 reazioni
  rapide, Reply in thread, «⋯».
- **Menu «⋯»**: Reply in thread · Add reaction · Copy link · Mark unread
  from here **[ASSUNZIONE]** · Create task · Create request · Edit (solo
  miei) · Delete (solo miei, conferma in linea «Delete this message? ·
  Delete»). Crea task/richiesta aprono i dialoghi esistenti precompilati
  (titolo = prima riga, descrizione = testo + link al messaggio, progetto
  = quello del canale; nei generali e nei DM si sceglie).
- **Casella**: lo stesso `Composer` della conversazione (bordo
  `rule-strong` 8px, cresce fino a 10 righe), segnaposto «Message AUD ·
  general», suggerimento «# objects · @ people», nessun «/» in chat
  **[ASSUNZIONE]**. «@» offre persone del canale prima, poi reparti
  («@Marketing · 4 in this channel»), «@channel», «@Claude». Graffetta:
  «Upload files» e «From the project's Drive» (disattivata con «Available
  when the project Drive arrives» finché non c'è l'area 5
  **[ASSUNZIONE]**). Trascina/incolla come nella conversazione, limiti
  10 file da 20 MB **[ASSUNZIONE]**.
- **Bozza** per canale e per persona; sopravvive al cambio canale, sparisce
  al cambio di persona. ↑ nella casella vuota modifica il mio ultimo
  messaggio sul posto (Enter salva, Esc annulla) **[ASSUNZIONE]**.
- **Domanda a qualcuno**: un messaggio con «@persona» e «?» finale chiede
  risposta da sé; nel menu della casella «Ask for a reply» lo forza. Sotto
  il messaggio: «Asks Giulia Ferri for a reply» 12px muted, che diventa
  «Answered» dopo la risposta.
- **Letto**: il canale si segna letto quando il fondo è visibile; Esc nel
  canale = «Mark as read» **[ASSUNZIONE]**; Maiusc+Esc segna tutto letto.
- **Threads** (vista): h1 «Threads», righe per thread con risposte nuove:
  canale (codice · nome), estratto della radice, ultime 2 risposte, clic
  apre il pannello. **Mentions**: h1 «Mentions», messaggi che mi nominano
  per giorno, con canale; clic porta al messaggio evidenziato.
- **Sezione Chat del progetto**: nella colonna di progetto la voce «Chat»
  porta il conteggio menzioni del progetto; da corrente si apre sotto in
  sottovoci 28px rientrate con i canali del progetto (stessi segnali della
  Chat) **[ASSUNZIONE]**. Atterraggio = «general». Stesso `ChannelView`,
  stessi letti; «Open in Chat» non serve.
- **Binario**: punto pieno sulla voce Chat solo per menzioni, DM non letti
  o thread con risposte nuove — non per il traffico normale dei canali,
  che con 50 progetti lo terrebbe sempre acceso **[ASSUNZIONE]**.
- **Atterraggio** `#/chat` = l'ultimo canale aperto; la prima volta il
  «general» del primo progetto fissato **[ASSUNZIONE]**.
- Tastiera: ⌥↑/⌥↓ canale precedente/successivo, ⌥⇧↑/↓ non letto
  precedente/successivo, ⌘K «Go to channel…» **[ASSUNZIONE]**.
- 1024px: colonna intatta, flusso a tutta larghezza residua, la barra al
  passaggio perde le reazioni rapide.
- Movimento: nuovi messaggi in dissolvenza 150ms; scorrimento al nuovo
  solo se sei in fondo, altrimenti pillola «New messages ↓» (della
  conversazione); niente con movimento ridotto.

## 7. Vincoli e decisioni aperte

- Visibilità da `canSeeChannel`/`canReadChannel`; conteggi, anteprime e
  bozze contano solo ciò che chi guarda può leggere.
- Cambio di persona: flusso, bozza, riga «New» e thread aperto si
  azzerano; un canale non più leggibile mostra l'errore di inesistenza.
- `aria-live="polite"` per i messaggi in arrivo nel canale aperto
  (raggruppati, non uno per uno); la colonna espone i conteggi in parole
  («general, 3 unread, 1 mention»).
- Colore mai unico segnale: non letto = peso, menzione = numero, archiviato
  e privato = parola o glifo con nome accessibile.
