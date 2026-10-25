# Shape brief — Posta

Superficie: destinazione «Mail» sul binario (`#/mail`, conversazione aperta
`#/mail/<threadId>`, parametri `mailbox`, `importance`, `project`, `q`),
colonna personale delle caselle, elenco per conversazione, pannello di
lettura, proposte accanto all'email (`MailProposalCard`, la stessa anche in
«Da decidere»), trascrizione di un Meet, allineamento con Google. Piano:
Task 7 (dati: Task 1–3, 6). Spec: area 6 «Posta» (Cosa si vede, La
classificazione, Proposte da un'email, Una proposta condivisa, Riunioni
registrate), «Allineamento», «Permessi», «Stati», «Dati finti». La
scrittura (rispondi, inoltra, nuova email, bozza di Claude, invio) è di
`mail-compose.md`; il calendario e la scheda di preparazione di
`calendar.md` e `meeting-prep.md`. Mondo: «Catalogo numerato», modalità
**Operate**, con un tratto di **Read** (il corpo delle email). **[A n]** =
scelta del brief, numerata in fondo.

## 1. Lavoro e pubblico

- **Chi**: chiunque abbia collegato il proprio account Google, di ogni
  reparto: il commerciale che riceve le richieste del cliente, il Project
  Lead in copia su tutto, lo sviluppatore che riceve due email al giorno.
  Ognuno vede **solo la propria posta**: nessuna casella condivisa, nessuna
  eccezione per gli admin.
- **Quando**: la mattina, per vedere se c'è qualcosa di nuovo e di
  importante; poi più volte al giorno, entrando da «Email importanti»
  della Home, da una proposta in «Da decidere» o da una ricerca.
- **La fatica vera** (spec, «Perché»): non leggere la posta, ma
  **trasformarla a memoria** in task, richieste e aggiornamenti. La Posta
  di Stubwise esiste perché questo passo lo faccia già il modello, e a chi
  legge resti solo da decidere.
- Stato d'animo: due ritmi. **Smistare** (scorrere, capire cosa conta,
  aprire) e **decidere** (una proposta accanto all'email: confermo,
  correggo, passo, ignoro). Il secondo non deve perdersi nel primo.

## 2. Esito e prova

- Azione primaria: aprire un'email importante e chiudere le sue proposte
  sul posto, in uno o due clic, correggendo un campo se serve.
- Successo: a 1440×900, aprendo Posta, le email importanti si distinguono
  dalle altre senza leggere; ogni riga dice progetto, scadenza e se c'è
  qualcosa da decidere; aprendo un'email la proposta è **accanto al
  messaggio da cui nasce**, con le parole che il modello ha letto a un clic
  di distanza; dopo la conferma la proposta diventa una riga con il codice
  della task nata (AUD-96), apribile.
- Verità del prodotto:
  - **Nessun filtro d'ingresso**: ogni email passa dal modello (salvo la
    casella con le proposte spente). Newsletter, notifiche e posta
    personale restano in elenco **senza progetto e senza proposte**.
  - **Una proposta per email e progetto, condivisa** fra i destinatari in
    Stubwise membri del progetto: chi decide per primo chiude per tutti, e
    gli altri vedono chi e cosa.
  - **Conferma chi ha il permesso dell'azione nel progetto**; chi non ce
    l'ha la **passa al progetto**. Il permesso lo dice il livello dati
    (`canConfirm`, `canHand`), il client non lo deduce.
  - **Riassunto e trascrizione di un Meet li vede solo chi c'era.**
  - **La posta è viva quanto Google**: ogni vista dice quanto è aggiornata
    e si riallinea con un clic.

## 3. Direzione scelta

- **Tesi**: la Posta è un **registro di protocollo**. Ogni conversazione è
  una riga a tre linee che dice chi, cosa, per quale progetto e cosa resta
  da fare; il pannello di lettura è una colonna di lettura come la
  conversazione con Claude, e le proposte sono **schede nel flusso**,
  subito sotto il messaggio che le ha fatte nascere — l'unico contorno
  della pagina oltre ai dialoghi. Niente colori per mittente, niente
  stelle, niente etichette colorate: l'importanza è forma (un glifo e il
  peso del testo), lo stato della scadenza è il solo colore.
- **Le email non hanno codice** **[A 1]**: come le conversazioni con
  Claude («Conversations-Have-No-Code Exception» di DESIGN.md), un'email è
  personale e non si cita ad altri: nessun codice inventato. I codici
  compaiono per ciò che ne nasce (AUD-96, AUD-R14) e per i progetti
  (codice tnum + nome).
- **Topologia** (binario 64 · colonna 240 · area di lavoro):
  - **Colonna personale** «Mail» (nessun titolo, come le destinazioni
    personali): gruppo VIEWS — «All mail» (conteggio non letti), «Important»
    (= `importance=high`), «No project» (= `project=none` **[A 2]**);
    gruppo MAILBOXES — una riga per casella collegata (indirizzo, seconda
    linea 12px con lo stato di allineamento, vedi §5), più «All mailboxes»
    in testa quando sono due o più; gruppo PROJECTS — i progetti delle mie
    email degli ultimi 90 giorni, ordinati per email più recente, codice
    tnum + nome, conteggio dei non letti `ink-faint`, i primi 8 + «Show
    all N» **[A 3]**. In fondo, separato da filetto: «Google account» (apre
    il dialogo dell'account dell'area 5, dove sta l'interruttore «Proposals
    on for this mailbox»).
  - **Elenco** (380px fissi, filetto a destra) **[A 4]**: in testa la
    barra 40px con il campo «Search mail» (⌘F) e due menu a gettone
    **Importance ▾** (Any · High · Normal · Low) e **Project ▾** (elenco
    cercabile dei progetti delle mie email + «No project»); «Clear filters»
    quando ce n'è uno. Sotto, la riga di stato 28px: «Updated 2 min ago ·
    Refresh» (vedi §5). Poi le righe, più recenti in alto, separate da
    filetti; in fondo all'elenco la nota 12px `ink-faint` «Stubwise keeps
    the last 90 days of mail. Older mail is on Gmail.» + «Open Gmail».
  - **Pannello di lettura** (il resto, colonna di lettura fino a 760px,
    32px di margine): testata della conversazione, poi i messaggi, con le
    schede delle proposte nel flusso, in fondo la casella di risposta
    (`mail-compose.md`).
- **Riga di conversazione** (72px, tre linee):
  1. Punto «non letto» (ink pieno 8px, assente se letta) · partecipanti
     (mittenti della conversazione, «Marco Bellini, Mix Cucine +2», in
     600 se non letta) · numero di messaggi tnum `ink-faint` se più di uno
     («4») · graffetta se ci sono allegati · ora o data a destra tnum
     (oggi «10:42», quest'anno «Oct 22», altrimenti «Oct 22, 2025»).
  2. Glifo d'importanza (vedi sotto) · oggetto su una riga con ellissi
     (600 se non letta) · a destra la scadenza, se c'è.
  3. 12px: progetto (codice tnum + nome con ellissi, «+1» se più d'uno,
     tutti nel `title`) · segnale delle proposte · inizio del testo
     dell'ultimo messaggio in `ink-muted` con ellissi.
- **Importanza** **[A 5]**: *alta* = glifo «Important» 14px (due chevron
  verso l'alto, `ink`) davanti all'oggetto, con nome accessibile «High
  importance» e tooltip; *normale* = niente; *bassa* = partecipanti e
  oggetto in `ink-muted` e nessun glifo, nome accessibile «Low
  importance». Nessun colore: l'importanza non è uno stato (Color-Means-
  Something). L'ordine resta cronologico: l'importanza filtra, non
  riordina.
- **Scadenza** (12px tnum, a destra della seconda linea): futura «Due Oct
  29» `ink-muted`; oggi icona + «Due today» in `warning`; passata icona +
  «Overdue · Oct 22» in `critical`. Sempre parola + icona, mai solo colore.
- **Segnale delle proposte** sulla riga: «2 to decide» con il punto «ti
  aspetta» (ink pieno) quando almeno una proposta aperta aspetta me
  (`canConfirm` o `canHand`) **[A 6]**; «Analysing…» con l'anello
  tratteggiato piccolo (il segno di Claude al lavoro) mentre la
  classificazione è `pending`; «Analysis failed» icona + `critical` se
  `failed`. Bozza presente: matita 12px + «Draft».
- **Testata della conversazione** (nel pannello): oggetto in `headline`
  20px, che va a capo **per intero** (nessuna ellissi nel pannello,
  `overflow-wrap: anywhere`) **[A 7]**; sotto, riga 13px: progetti
  (codice + nome, link alla sezione del progetto), importanza in parole
  («High importance»), scadenza in parole, casella («in
  giulia.ferri@example.com», solo con due o più caselle). A destra:
  **Reply** · «Reply all» · «Forward» (aprono la casella in fondo,
  `mail-compose.md`) e «⋯»: Open in Gmail · Mark as unread · Repropose
  (quando il messaggio è `failed`, o ha proposte ignorate) · Copy link.
- **Messaggio** (espanso): avatar 32px (iniziali; per un indirizzo esterno
  la prima lettera su tinta ink 6%) · nome 600 + indirizzo 13px muted ·
  ora tnum a destra; sotto, 13px muted «to Giulia Ferri, Marco Bellini ·
  cc Laura Costa». Corpo 14px ink, prosa ≤ 68ch, link sottolineati.
  «··· Show quoted text» richiude il testo citato (chiuso di default).
  Allegati come gettoni 32px (glifo del tipo, nome con ellissi, peso tnum):
  clic = avviso del prototipo «Opens from Gmail»; con `drive.upload` nel
  progetto della conversazione, al passaggio «Save to AUD Drive» (lo
  stesso `SaveToDriveButton` della Chat) **[A 8]**.
- **Originale HTML**: di default si mostra il **testo pulito**; se il
  messaggio ha un HTML, «Show original» (nel «⋯» del messaggio e come link
  sotto il corpo) lo apre al posto del testo dentro un `iframe sandbox`
  con `srcdoc` (nessuno script, nessun form, nessuna navigazione), alto
  quanto il contenuto fino a 1200px poi scorre dentro **[A 9]**. Sopra il
  frame, una fascia 32px: icona immagine + «Remote images are blocked to
  protect your privacy.» + «Show images» (vale per quel messaggio, quella
  volta: non si ricorda). «Show text» torna indietro. Errori
  dell'originale in parole: «This message is no longer on Gmail», «Your
  Google connection expired · Reconnect», «Google isn't responding · Try
  again».
- **Messaggio di contesto** (`context: true`): riga 12px muted sopra il
  corpo «Earlier in the conversation · Stubwise didn't make proposals from
  this message».
- **Conversazione lunga**: espansi i non letti, l'ultimo, e il messaggio
  cercato; gli altri sono righe 40px (avatar 24px, nome, inizio del testo,
  ora). Oltre 6 messaggi chiusi consecutivi, si raccolgono in una fascia
  centrata «48 earlier messages» che li apre tutti **[A 10]**.
- **Momento focale**: la scheda di proposta aperta che aspetta me, subito
  sotto il messaggio, con il bottone primario a portata e il punto «ti
  aspetta» nell'intestazione.

```
┌rail┬column────────────────┬list (380)──────────────────┬reading──────────────────────────────┐
│    │ All mail          12 │ ⌕ Search mail   ⌘F         │ Revised quote for the spring        │
│ ✉● │ Important          3 │ [Importance ▾] [Project ▾] │ campaign — need it by Thursday      │
│    │ No project           │ Updated 2 min ago · Refresh│ MKX Campagne primavera · High       │
│    │ MAILBOXES            │────────────────────────────│ importance · Due Thu, Oct 29        │
│    │ giulia.ferri@…       │● Mix Cucine, Marco  3 10:42│      [Reply] Reply all  Forward  ⋯  │
│    │  Updated 2 min ago   │ ⏶ Revised quote for t… Due │─────────────────────────────────────│
│    │ PROJECTS             │ MKX Campagne… ● 2 to decide│ (MC) Monica Corsi · ordini@mix… 10:42│
│    │ MKX Campagne pri…  2 │────────────────────────────│ to Giulia Ferri · cc Marco Bellini  │
│    │ AUD Audin 2.0      1 │  Gemini              Yest. │ Ciao Giulia, ci servirebbe il       │
│    │ STW Stubwise         │   Notes: AUD weekly sync   │ preventivo rivisto entro giovedì…   │
│    │ ───────────────────  │ AUD Audin 2.0 · ◌ Analys…  │ ┌ ● Stubwise proposes · 2 changes ┐ │
│    │ Google account       │────────────────────────────│ │ ☑ Create task in MKX: “Send the  │ │
│    │                      │  Spring Deals (news…) Mon  │ │   revised quote…” · Chiara L. ·  │ │
│    │                      │   Weekly offers            │ │   Due Oct 29               Edit  │ │
└────┴──────────────────────┴────────────────────────────┴─────────────────────────────────────┘
```

## 4. Le proposte accanto all'email

Un solo componente, `MailProposalCard`, nella Posta (sotto il messaggio
d'origine) e in «Da decidere» (Home e Inbox). Parla il linguaggio della
`ProposalCardView` di Claude (`pages/claude/conversation/ProposalCard.tsx`):
scheda 1px `rule-strong`, raggio 8px, nessuna ombra; righe d'azione in
forma catalogo; l'esito prende il posto dei bottoni. Le differenze sono
quelle della posta: è **condivisa**, si **modifica sul posto** prima di
confermare, ha **passa al progetto** e l'incaricato **fuori dal progetto**.

- **Intestazione**: punto «ti aspetta» se aspetta me · «Stubwise proposes ·
  2 changes» · «for MKX Campagne primavera» (codice + nome) · a destra
  «⋯» (Move to another project · Show what Stubwise read). Sotto, 12px
  muted, se la condividono altri destinatari: «Also for Marco Bellini and
  Laura Costa» (solo destinatari membri del progetto: hanno già l'email)
  **[A 11]**.
- **«Show what Stubwise read»**: link 12px sotto le righe; apre l'estratto
  (`excerpt`) in un blocco citato 13px `ink-muted` con filetto sinistro
  `rule-strong`, alto fino a 200px poi scorre. Nell'Inbox/«Da decidere» e
  nella proposta passata vista da chi non ha l'email, l'estratto è **aperto
  di default**, perché è tutto ciò che quella persona può leggere.
- **Righe d'azione** (una per azione, 40px minimo, vanno a capo): casella
  (solo se le azioni sono più d'una e io posso confermare) + frase
  catalogo:
  - task: «Create task in MKX: “Send the revised quote to Mix Cucine” ·
    Chiara Lombardi · Due Oct 29» (senza incaricato: «· Unassigned»);
  - richiesta: «Create request in AUD: “Export orders to CSV”»;
  - «Update AUD-88 Invoice export check: due Oct 30»; «Comment on AUD-88
    Invoice export check: “Client confirms the new VAT field”»;
  - «Record decision in AUD: “Release 2.4 moves to Nov 10”»;
  - «Create milestone in AUD: “Go-live” · Nov 10».
  - **Incaricato fuori dal progetto** segnalato **già nella riga**, prima
    della conferma: dopo il nome, icona persona-più + «not in MKX» 12px
    `ink-muted` **[A 12]**.
  - A destra di ogni riga, con `canConfirm`: «Edit».
- **Modifica sul posto** **[A 13]**: «Edit» apre la riga in un piccolo
  modulo **dentro la scheda** (non un dialogo): campi dell'azione — task:
  titolo, descrizione (precompilata con le parole dell'email), incaricato
  (selettore delle persone di **tutto il team**, membri del progetto per
  primi, poi gli altri con «not in MKX»), scadenza, progetto non
  modificabile qui (si usa «Move to another project»); richiesta: titolo,
  descrizione; aggiornamento: task (selettore dei codici del progetto) e
  campo che cambia; commento: task e testo; decisione: titolo, decisione,
  contesto; traguardo: nome e data. «Done» richiude la riga mostrando i
  valori nuovi con la nota 12px «Edited» dopo la frase; «Reset» torna alla
  proposta del modello. Le modifiche valgono solo per la mia conferma e si
  perdono se un altro decide prima.
- **Bottoni** (in fondo a destra, il primario per ultimo):
  - con `canConfirm`: «Ignore» (quieto) · **Confirm** (una azione o tutte
    selezionate) / **Confirm 2 of 3** (selezione parziale); niente
    «Hand to the project» **[A 14]**;
  - senza `canConfirm` ma con `canHand`: righe in sola lettura (niente
    caselle, niente «Edit»), nota 13px muted «You can't create tasks in
    MKX. Hand it to the project and someone who can will decide.» ·
    «Ignore» · **Hand to the project**;
  - proposta `chooseProject` (il modello non è sicuro del progetto): la
    scheda dice «Which project is this about?» e mostra righe-opzione 40px
    per i progetti candidati (codice + nome, con la ragione 12px muted
    «Monica Corsi writes about the spring campaign») + «None of these»
    (= Ignore). Un clic sceglie: la scheda passa a «Analysing for MKX…» con
    l'anello, poi diventa la proposta di quel progetto.
- **Incaricato fuori dal progetto, alla conferma** **[A 15]**: se una
  delle azioni selezionate assegna a un non membro, «Confirm» non esegue
  subito: la scheda mostra **in fondo, sopra i bottoni**, un passo in
  linea con filetto sinistro `rule-strong`:
  - con `project.members.manage`: «Chiara Lombardi isn't in MKX. Add her
    as a Contributor? She'll be able to see MKX's tasks, docs and chat.»
    · «Choose someone else» · «Leave unassigned» · **Add and confirm**.
  - senza: «Chiara Lombardi isn't in MKX, and you can't add people to it.
    Choose someone else or leave the task unassigned.» · «Choose someone
    else» · **Confirm unassigned**.
  - «Choose someone else» riapre la riga in modifica con il fuoco sul
    campo incaricato. Più non membri: un elenco con un nome per riga e una
    sola domanda («Add Chiara Lombardi and Tommaso Riva as Contributors?»).
  - Tutto o niente: se l'aggiunta non riesce, nulla viene creato.
- **Esiti** (la scheda si riduce a una riga, 200ms; il fuoco va all'esito):
  - «Confirmed by you · 10:44 · MKX-96 Send the revised quote» (codici
    apribili); parziale: «· 2 of 3 done»; con aggiunta: «· Chiara Lombardi
    added to MKX as Contributor».
  - **Decisa da un altro**: «Confirmed by Marco Bellini · 10:42 · MKX-96
    Send the revised quote» (codice apribile se lo vedo, altrimenti solo
    codice `ink-faint`, R-E9); «Ignored by Marco Bellini · 10:42»;
    «Handed to the project by Laura Costa · 10:42 · waiting for someone who
    can create tasks in MKX».
  - **Decisa mentre la avevo aperta** (`already_handled`): la scheda si
    sostituisce con «Marco Bellini confirmed this a moment ago. Nothing
    was created twice.» + la riga d'esito; le mie modifiche si scartano
    con la nota «Your edits weren't applied.»
  - **Fallita**: icona + «Couldn't be completed: you can no longer create
    tasks in MKX. Nothing was changed.» + «Repropose».
  - Nessuna azione (il modello conclude che non c'è nulla da fare): niente
    scheda; una riga 12px `ink-faint` sotto il messaggio «Nothing to do
    for MKX».
- **Proposta passata vista da chi non ha l'email** (in «Da decidere» di un
  Project Lead): intestazione «Handed to MKX by Laura Costa · from an
  email to Laura Costa» · estratto aperto · righe con «Edit» · «Ignore» ·
  **Confirm**. Nessun link all'email (non la può aprire); il testo «from
  an email to…» non rivela altro che il destinatario che l'ha passata.
- **Proposta nell'Inbox/«Da decidere»**: sopra la scheda, una riga di
  contesto 13px «Monica Corsi · Revised quote for the spring campaign ·
  10:42» con «Open email» (solo per chi ha l'email).

## 5. Stati e intervalli

- **Volumi**: 0–3 caselle per persona **[A 16]**; 0–migliaia di
  conversazioni in 90 giorni (finestra di 50 righe, caricamento continuo
  scorrendo, posizione mantenuta); conversazioni da 1 a 60+ messaggi;
  0–40+ destinatari; 0–6 proposte per email, 1–3 progetti per email;
  oggetti da 0 a ~1.000 caratteri (vuoto: «(no subject)» in `ink-faint`).
- **Oggetto lunghissimo**: una riga con ellissi in elenco (`title` intero);
  per intero, a capo, nella testata del pannello.
- **40 destinatari**: nella riga del messaggio «to Giulia Ferri, Marco
  Bellini and 38 others»; «38 others» è un bottone che apre l'elenco
  completo sotto, a capo, raggruppato in To e Cc, alto al massimo 160px
  poi scorre, con «Show less». Le persone del team prima, per nome.
- **60 messaggi**: vedi «Conversazione lunga»; aprire la fascia mostra
  tutte le righe chiuse, non le espande.
- **Classificazione** (per messaggio e riflessa sulla riga):
  - `pending`: riga «Analysing…»; sotto il messaggio, riga 13px con
    l'anello «Stubwise is reading this email…»; nessuna scheda.
  - `done` con progetti e proposte: schede; con progetti senza proposte:
    «Nothing to do for AUD» (12px faint); **senza progetto**: nessuna
    etichetta di progetto, nessuna scheda, una riga 12px faint sotto la
    testata «Not about any of your projects».
  - `failed`: sotto il messaggio, icona + «Stubwise couldn't analyse this
    email.» in `critical` + **Repropose** (→ `pending` → esito).
  - `off` (casella con le proposte spente): nessun segnale in elenco; una
    sola volta, in testa all'elenco filtrato su quella casella, la nota
    12px «Proposals are off for this mailbox · Turn on» (apre il dialogo
    dell'account).
- **Trascrizione di un Meet** (`kind: "transcript"`): sopra il corpo, un
  blocco con filetto sinistro `rule-strong`: glifo videocamera + «Recorded
  meeting · AUD weekly sync · Yesterday 15:00–15:45 · 6 people» (link
  all'evento nel Calendario) e:
  - per chi ha partecipato: titolo di gruppo «SUMMARY» con la nota 12px
    `ink-faint` «Generated by Stubwise from the transcript» (narrativa,
    segnata come tale) · il riassunto 14px · «Open the transcript»
    (avviso del prototipo); le proposte nascono qui come da un'email, una
    scheda per progetto;
  - per un destinatario che **non** ha partecipato (email inoltrata): «The
    summary and the transcript are visible only to the people who were in
    the meeting.» e le sole proposte che gli spettano **[A 17]**;
  - documento in lettura: anello + «Reading the transcript…»;
    irraggiungibile: icona + «Stubwise couldn't open the transcript. It
    may have been moved or not shared with you.» + «Try again»; nessun
    riassunto, nessuna proposta.
- **Allineamento** (per casella, nella colonna e nella riga di stato
  dell'elenco):
  - ok: «Updated 2 min ago» 12px `ink-faint` + «Refresh» (link);
  - in corso: anello + «Updating…»; nuove email entrano in cima con una
    dissolvenza 150ms e la riga «1 new» in testa se ho scrollato;
  - vecchio (oltre 5 minuti): icona orologio + «Updated 12 min ago — may
    be behind Gmail» in `warning` + **Refresh now**;
  - fallito: icona + «Couldn't update · Try again» in `critical`;
  - **collegamento scaduto**: in colonna, sotto l'indirizzo, icona +
    «Connection expired» in `critical`; in testa all'elenco una fascia con
    filetto sinistro `critical`: «Your Google connection expired on Oct
    20. New mail isn't arriving and you can't send from
    laura.costa@example.com.» + **Reconnect**. L'elenco resta leggibile
    (quello che Stubwise aveva).
  - Con «All mailboxes» la riga di stato riporta la casella **peggiore**
    («laura.costa@… expired»), le altre stanno in colonna.
- **Account Google non collegato**: la pagina intera è uno stato vuoto
  centrato nella zona di lavoro (h1 «Mail» resta): «Connect your Google
  account to read your mail here. Stubwise reads your mail to suggest
  tasks for your projects; only you see your messages.» + **Connect
  Google account** (apre il dialogo dell'area 5) + nota 12px «Calendar
  uses the same account.» La colonna mostra solo «Google account».
- **Caricamento**: 8 righe scheletro (tre linee) nell'elenco; il pannello
  mostra testata e due messaggi scheletro.
- **Vuoti**: nessuna email «No mail in the last 90 days»; filtro senza
  risultati «No important mail» / «No mail for AUD» / «Nothing matches
  “preventivo”» + «Clear filters»; nessuna conversazione aperta: pannello
  con «Select a conversation» 14px `ink-faint` e, se ci sono proposte che
  mi aspettano, «3 conversations have proposals to decide · Show», che
  apre la prima di queste **[A 18]**.
- **Errori**: elenco «Couldn't load your mail» + «Retry»; conversazione
  inesistente o di un altro: «This conversation doesn't exist or you can't
  see it» (R-G5, identico per i due casi).
- **Cambio di persona** («vedi come»): elenco, conversazione aperta,
  ricerca, schede in modifica e passi «fuori dal progetto» si chiudono
  senza effetti; l'URL torna a `#/mail` senza `threadId` se la persona
  nuova non vede quella conversazione; nessun indirizzo della persona di
  prima resta a schermo.

## 6. Interazione e layout

- **Selezione**: clic su una riga apre la conversazione nel pannello e la
  segna letta (dopo 1 s di permanenza, non al passaggio rapido con la
  tastiera) **[A 19]**; la riga corrente ha la tinta ink 10%.
- **Ricerca** (⌘F nel Mail): cerca in oggetto, partecipanti e testo dei
  messaggi **che vedo**; i risultati sono righe normali con la terza linea
  sostituita dal frammento con la parola in 600; aprendo, il messaggio
  trovato è espanso e marcato da una tinta ink 6% per 2 s. La ricerca
  globale (⌘K) ha il gruppo «Mail» con le stesse regole.
- **Tastiera**:
  - ↑/↓ o J/K: conversazione precedente/successiva (apre nel pannello);
    Enter: porta il fuoco nel pannello; Esc: torna all'elenco.
  - nel pannello: N/P messaggio successivo/precedente (espande); O apre o
    chiude il messaggio; R Reply · A Reply all · F Forward
    (`mail-compose.md`); U segna non letta; ⌘F cerca; ⌘N **New email**
    (in Mail prende il posto del «New message» della Chat, come fa la
    destinazione Claude) **[A 20]**.
  - nella scheda di proposta: Tab fra righe e bottoni; Space spunta la
    riga; E apre «Edit» sulla riga col fuoco; ⌘Enter conferma (o passa,
    se non posso confermare); nessuna lettera singola conferma da sola.
  - Le lettere singole valgono solo con il fuoco nell'elenco o nel
    pannello, mai in un campo; elencate nel tooltip dei bottoni.
- **Finestra stretta**: con un'area di lavoro sotto i 1180px (a 1024 di
  finestra, tolti binario e colonna, restano 720px) elenco e pannello
  diventano **uno per volta**: l'elenco occupa l'area, aprire una
  conversazione la sostituisce con «← Mail» in testa al pannello
  **[A 4]**.
- **Segnale sul binario** **[A 6]**: «Mail» ha il punto «ti aspetta»
  quando almeno una proposta aperta aspetta me; tooltip «Mail · 3
  proposals to decide». Le email non lette non accendono nulla (la posta
  non è un'urgenza di per sé).
- **Movimento**: schede che si riducono a riga 200ms; nuove righe in
  dissolvenza 150ms; pannello che cambia conversazione senza animazione
  (è lettura); nulla con movimento ridotto.

## 7. Accessibilità

- Elenco come `listbox` con righe `option` (nome accessibile: «Unread ·
  High importance · Mix Cucine, Marco Bellini · Revised quote… · MKX
  Campagne primavera · Due Oct 29 · 2 proposals to decide · 10:42»);
  pannello come `article` per messaggio con intestazione.
- Importanza, scadenza, non letto, stati di analisi e allineamento sempre
  in parole (testo o `sr-only`), mai solo glifo o colore.
- L'iframe dell'originale ha `title` «Original message from Monica Corsi»
  e non riceve il fuoco finché non ci si entra con Tab.
- Schede: `region` con `aria-labelledby` sull'intestazione; il passo «fuori
  dal progetto» annunciato `assertive` (chiede a me); gli esiti `polite`.
- Contrasto: `ink-muted` per le righe a bassa importanza resta ≥ 4.5:1 in
  entrambi i temi (è testo da leggere, non decorazione).

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| colonna | All mail · Important · No project · Mailboxes · All mailboxes · Projects · Google account | Tutta la posta · Importanti · Senza progetto · Caselle · Tutte le caselle · Progetti · Account Google |
| filtri | Search mail · Importance · Any · High · Normal · Low · Project · No project · Clear filters | Cerca nella posta · Importanza · Qualsiasi · Alta · Normale · Bassa · Progetto · Senza progetto · Togli i filtri |
| riga | {{count}} to decide · Analysing… · Analysis failed · Draft · (no subject) · Due {{date}} · Due today · Overdue · {{date}} | {{count}} da decidere · In analisi… · Analisi fallita · Bozza · (senza oggetto) · Scade il {{date}} · Scade oggi · Scaduta · {{date}} |
| allineamento | Updated {{n}} min ago · Refresh · Updating… · may be behind Gmail · Refresh now · Couldn't update · Try again · Connection expired · Reconnect | Aggiornato {{n}} min fa · Aggiorna · Aggiornamento… · potrebbe essere indietro rispetto a Gmail · Aggiorna ora · Aggiornamento non riuscito · Riprova · Collegamento scaduto · Ricollega |
| scaduto | Your Google connection expired on {{date}}. New mail isn't arriving and you can't send from {{email}}. | Il collegamento con Google è scaduto il {{date}}. Le email nuove non arrivano e non puoi scrivere da {{email}}. |
| lettura | Reply · Reply all · Forward · Open in Gmail · Mark as unread · Repropose · Show quoted text · Show original · Show text · Remote images are blocked to protect your privacy. · Show images · {{count}} earlier messages · and {{count}} others | Rispondi · Rispondi a tutti · Inoltra · Apri in Gmail · Segna come non letta · Riproponi · Mostra il testo citato · Mostra l'originale · Mostra il testo · Le immagini esterne sono bloccate per proteggere la tua privacy. · Mostra le immagini · {{count}} messaggi precedenti · e altri {{count}} |
| analisi | Stubwise is reading this email… · Stubwise couldn't analyse this email. · Not about any of your projects · Nothing to do for {{code}} · Proposals are off for this mailbox · Turn on | Stubwise sta leggendo questa email… · Stubwise non è riuscito ad analizzare questa email. · Non riguarda nessuno dei tuoi progetti · Niente da fare per {{code}} · Le proposte sono spente per questa casella · Accendi |
| proposta | Stubwise proposes · {{count}} changes · for {{project}} · Also for {{names}} · Show what Stubwise read · Edit · Edited · Reset · Ignore · Confirm · Confirm {{n}} of {{count}} · Hand to the project · Move to another project · Which project is this about? · None of these · not in {{code}} | Stubwise propone · {{count}} modifiche · per {{project}} · Anche per {{names}} · Mostra cosa ha letto Stubwise · Modifica · Modificata · Ripristina · Ignora · Conferma · Conferma {{n}} di {{count}} · Passa al progetto · Sposta su un altro progetto · Di quale progetto si tratta? · Nessuno di questi · non è in {{code}} |
| permesso | You can't create tasks in {{code}}. Hand it to the project and someone who can will decide. | Non puoi creare task in {{code}}. Passala al progetto: deciderà chi può. |
| fuori | {{name}} isn't in {{code}}. Add her as a Contributor? She'll be able to see {{code}}'s tasks, docs and chat. · Add and confirm · Choose someone else · Leave unassigned · {{name}} isn't in {{code}}, and you can't add people to it. Choose someone else or leave the task unassigned. · Confirm unassigned | {{name}} non è in {{code}}. La aggiungi come Contributor? Vedrà task, documenti e chat di {{code}}. · Aggiungi e conferma · Scegli un'altra persona · Lascia senza incaricato · {{name}} non è in {{code}} e non puoi aggiungere persone. Scegli un'altra persona o lascia la task senza incaricato. · Conferma senza incaricato |
| esiti | Confirmed by {{name}} · Ignored by {{name}} · Handed to the project by {{name}} · {{name}} confirmed this a moment ago. Nothing was created twice. · Your edits weren't applied. · Couldn't be completed: {{reason}}. Nothing was changed. · {{n}} of {{count}} done · {{name}} added to {{code}} as Contributor | Confermata da {{name}} · Ignorata da {{name}} · Passata al progetto da {{name}} · {{name}} l'ha appena confermata. Non è stato creato nulla due volte. · Le tue modifiche non sono state applicate. · Non è stato possibile completarla: {{reason}}. Non è cambiato nulla. · {{n}} di {{count}} fatte · {{name}} aggiunta a {{code}} come Contributor |
| riunione | Recorded meeting · Summary · Generated by Stubwise from the transcript · Open the transcript · Reading the transcript… · Stubwise couldn't open the transcript. It may have been moved or not shared with you. · The summary and the transcript are visible only to the people who were in the meeting. | Riunione registrata · Riassunto · Generato da Stubwise dalla trascrizione · Apri la trascrizione · Lettura della trascrizione… · Stubwise non è riuscito ad aprire la trascrizione. Potrebbe essere stata spostata o non condivisa con te. · Riassunto e trascrizione li vede solo chi ha partecipato alla riunione. |
| vuoti | Connect your Google account to read your mail here. · No mail in the last 90 days · Select a conversation · This conversation doesn't exist or you can't see it · Stubwise keeps the last 90 days of mail. Older mail is on Gmail. | Collega il tuo account Google per leggere qui la tua posta. · Nessuna email negli ultimi 90 giorni · Scegli una conversazione · Questa conversazione non esiste o non puoi vederla · Stubwise conserva gli ultimi 90 giorni di posta. Quella più vecchia è su Gmail. |

Il genere nei testi «Add her» / «La aggiungi» segue la persona (chiavi
`_female`/`_male`/`_other` come gli altri testi con un nome) **[A 21]**.

## 9. Vincoli

- Privacy: ogni lettura passa da `canSeeMessage` e `canSeeMailProposal`
  (via `data/queries.ts`); admin compresi. Un progetto invisibile non
  compare in `projectIds` né nei filtri.
- Permessi letti dal livello dati (`canConfirm`, `canHand`, `outsiders`,
  `decidedBy`), mai dedotti; le azioni non permesse non compaiono.
- HTML ostile: `iframe sandbox` senza `allow-scripts`, `allow-forms`,
  `allow-top-navigation`; immagini remote sostituite finché non si clicca
  (come `untrusted-html-frame.tsx` del web); i link si aprono con
  l'avviso del prototipo.
- Prototipo: «Open in Gmail», «Open the transcript», allegati → avviso;
  arrivi e classificazioni via `gate()` con ritardo simulato; orologio
  fisso (`now()`), mai `Date.now()`.
- Filtri, conversazione aperta e ricerca nell'URL, validati in
  `data/routes.ts`.
- Nessun permesso nuovo; nessuna regola della posta per progetto, nessuna
  ammissione d'istanza (non si portano, per scelta del maintainer).

## Scelte del brief da confermare

Ogni voce è una **[scelta del brief]**, non scritta nello spec.

1. Le email non hanno un codice di catalogo, come le conversazioni con
   Claude: sono personali e non si citano ad altri.
2. «No project» è un filtro (`project=none`) e una voce della colonna.
3. Colonna personale con VIEWS (All mail, Important, No project),
   MAILBOXES e PROJECTS (i primi 8 per email più recente + «Show all»).
4. Elenco a 380px fissi accanto al pannello; sotto i ~1180px di area di
   lavoro elenco e pannello diventano uno per volta con «← Mail».
5. Importanza: glifo «Important» per alta, testo attenuato per bassa,
   niente per normale; nessun colore; l'ordine resta cronologico.
6. Il binario accende il punto di Mail solo per proposte che aspettano me,
   non per le email non lette; la riga dice «N to decide».
7. Oggetto per intero, a capo, nella testata del pannello.
8. Allegati: clic = avviso del prototipo; «Save to <code> Drive» con
   `drive.upload`, riusando il bottone della Chat.
9. Di default il testo pulito; l'originale HTML a richiesta («Show
   original»), nel frame isolato, immagini bloccate per messaggio e mai
   ricordate.
10. Conversazione lunga: espansi non letti, ultimo e cercato; oltre 6
    chiusi consecutivi una fascia «N earlier messages».
11. La scheda dice «Also for <nomi>» con gli altri destinatari membri che
    la condividono.
12. L'incaricato non membro è segnalato già nella riga («not in MKX»),
    prima della conferma.
13. La modifica dei campi avviene dentro la scheda (riga che si apre in un
    modulo), non in un dialogo come per le proposte di Claude; le
    modifiche valgono solo per la mia conferma.
14. Chi può confermare non vede «Hand to the project»; chi non può vede
    solo «Ignore» e «Hand to the project».
15. Il prompt «aggiungila come Contributor?» è un passo in linea in fondo
    alla scheda, non un dialogo; senza permesso il primario è «Confirm
    unassigned».
16. Fino a 3 caselle per persona.
17. Un destinatario non partecipante di un'email di Gemini (inoltrata) vede
    l'email ma non riassunto e trascrizione, con una frase che lo dice.
18. Pannello vuoto: se ci sono proposte che mi aspettano, «N conversations
    have proposals to decide · Show» apre la prima.
19. Una conversazione si segna letta dopo 1 s nel pannello, non al
    passaggio rapido con la tastiera.
20. Tastiera stile client di posta (J/K, R/A/F, U, N/P, O) solo con il
    fuoco fuori dai campi; ⌘N in Mail = New email.
21. I testi con il nome della persona da aggiungere seguono il suo genere
    nelle traduzioni.
