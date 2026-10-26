# Shape brief — Costruttore delle automazioni

Superficie: `pages/automations/builder/*`, rotta `#/automations/<code>/edit`
**[A 1]**, aperta da «Edit» nel dettaglio di un'automazione
(`automations.md`), da «New automation» (Automations, ⌘K, vuoti) e dai
modelli. Piano: Task 6 (modello `Step`/`AutomationFlow` del Task 1,
`availableFields` e `validateFlow` del Task 2). Spec: area 7 «Il modello»,
«In quale progetto agisce», «Inizi», «Passi», «Permessi», «Anti-obiettivi».
La prova (simulazione) è di `automation-test.md`; elenco, dettaglio,
esecuzioni e versioni sono di `automations.md`; sorgenti e tabella cliente →
progetto di `automation-sources.md`. Mondo: «Catalogo numerato», modalità
**Operate**. **[A n]** = «[scelta del brief]», numerata e raccolta in fondo.

## 1. Lavoro e pubblico

- **Chi**: chi ha `automations.manage` — nel progetto (preset Project Lead)
  per le automazioni di progetto, d'istanza (preset admin) per le generali.
  Nel seme: Laura Costa (Project Lead, sviluppo), Matteo Conti (Project
  Lead, commerciale), Roberta Fontana (admin). **Molti non hanno mai scritto
  una regola**: il commerciale che vuole smettere di creare a mano le task
  dopo un contratto, la PM che ricorda al cliente di mandare i dati.
- **Quando**: raramente e con calma. Si costruisce un'automazione in 10–30
  minuti, la si prova, la si accende, la si ritocca settimane dopo quando
  il processo cambia.
- **Stato d'animo**: prudente. La paura dichiarata del maintainer è
  **un'automazione che esce dai binari**; quella di chi costruisce è più
  semplice: «non so se ho capito cosa farà». Il costruttore deve far
  **leggere** il flusso come una procedura scritta, non farlo **disegnare**.
- Chi ha solo il permesso di vedere (membri del progetto, Viewer) apre la
  stessa pagina in sola lettura per capire cosa fa un'automazione che gli
  crea task.

## 2. Esito e prova

- **Azione primaria**: arrivare a un flusso senza problemi, provarlo
  («Test») e accenderlo. Il costruttore è riuscito quando chi lo usa sa
  dire, a voce, cosa succede quando arriva l'evento.
- **Successo** a 1440×900, aprendo «Nuovo contratto» (`AUT-1`):
  - il flusso si legge dall'alto in basso come una ricetta numerata: ogni
    passo è **una frase** («Create a task “Kickoff call with {Client
    name}” for Sales · due in 2 days»), i rami sono rientrati sotto la
    domanda che li apre e dicono in parole quando si prendono;
  - i passi che chiedono un'approvazione si riconoscono senza aprirli;
  - un passo incompleto lo dice sulla sua riga e la testata conta i
    problemi; Test e Turn on restano chiusi finché ce ne sono;
  - aggiungere un passo è un «+» nel punto giusto e una scelta da un menu
    con nomi comprensibili, non una tavolozza di nodi.
- **Verità del prodotto** (le tre regole dell'anti-obiettivo, rese
  visibili):
  1. **Un'approvazione blocca davvero** → l'approvazione è una proprietà
     scritta sul passo, sempre leggibile sulla riga («Asks Laura Costa»),
     mai un passo separato che si possa spostare o cancellare per errore
     **[A 2]**.
  2. **Claude sceglie solo fra le strade disegnate** → il passo di Claude
     mostra le sue uscite come rami con nome, e un testo fisso lo dice
     («Claude only picks one of these outcomes and fills these fields. It
     never acts on its own: actions are the steps you add.»). Nessun campo
     di testo libero «cosa deve fare Claude dopo».
  3. **Tutto tracciato** → non è di questa pagina (registro in
     `automations.md`), ma il costruttore dà a ogni passo un **numero
     stabile nella lettura** che il registro e la prova riusano («Step 7»).
- **Il flusso è un albero**: nessun salto all'indietro, nessuna freccia
  da trascinare. I cicli esistono solo come contenitori («For each»,
  «Repeat until») con il loro limite scritto nell'intestazione.

## 3. Direzione scelta

- **Tesi**: **la procedura scritta**. Il flusso è un **elenco numerato
  verticale con rami annidati** (un sommario rientrato, come un indice
  con sottosezioni), non un grafo **[A 3]**. Motivi: un grafo chiede di
  leggere frecce e posizioni, e per 40 passi diventa una mappa da
  esplorare; un elenco rientrato si legge come un documento, si scorre, si
  usa da tastiera e si traduce senza rompersi. È la forma del Catalogo:
  righe, numeri in cifre tabellari, filetti.
- **Topologia** (binario 64 · colonna 240 · area di lavoro):
  - La **colonna** resta quella di Automations (`automations.md`), con
    l'automazione corrente evidenziata: il costruttore è una pagina di
    Automations, non un editor a tutto schermo **[A 4]**. A 1024 la colonna
    si chiude come nelle altre pagine larghe.
  - **Area di lavoro** divisa in due: a sinistra **il flusso** (colonna di
    lettura, 520–760px), a destra **il passo selezionato**, pannello
    agganciato 400px (ridimensionabile 360–560) con filetto a sinistra —
    lo stesso schema del dettaglio task. Nessun passo selezionato: il
    pannello mostra **l'inizio** («When this starts»), che è sempre il
    primo elemento del flusso.
- **Sequenza (testata, fissa in alto mentre il flusso scorre)**:
  1. riga di ritorno «← Automations» (o «← AUT-1 Nuovo contratto» se si
     arriva dal dettaglio);
  2. h1 28px col **nome** (va a capo per intero, nessuna ellissi), codice
     tnum 600 accanto (`AUT-1`, `AUD-A1`); per una bozza mai salvata il
     codice non c'è ancora e al suo posto «New automation»;
  3. riga meta 13px: progetto («General · uses the client's project» o
     «AUD Audin 2.0») · stato in parole («Draft», «On», «Paused») · versione
     («Editing version 3 · version 2 is on») · proprietario («Acts as Matteo
     Conti») · salvataggio («All changes saved» / «Saving…» / «Couldn't
     save · Retry»);
  4. a destra: contatore problemi («3 problems», con icona e `critical`,
     clic = va al primo; assente se zero) · «⋯» (Rename and describe ·
     Discard this draft · Delete draft · Copy link) · **Test** · **Turn
     on** / **Publish version 3**.
- **Il flusso** (dall'alto):
  - **Inizio** — riga speciale non numerata «When» con glifo della
    sorgente, frase («When a deal is won in Audin») e sotto, 12px muted,
    «12 pieces of data available · See». Non si sposta, non si cancella;
    si cambia dal pannello.
  - **Passi** — righe numerate 1…N nell'ordine di lettura, contando anche
    i passi dentro i rami (vedi «Numerazione»).
  - In fondo al ramo principale: riga «+ Add a step» sempre visibile, poi
    la riga di chiusura «End» in `ink-faint`.
- **Riga di passo** (min 48px, una o due righe di testo):
  `[numero tnum] [glifo del tipo 16px] frase del passo` · a destra i segni:
  approvazione · progetto se diverso dal proprio · problemi · «⋯».
  - La **frase** è generata dai campi, con i riferimenti ai dati come
    gettoni in linea (`{Client name}` reso come gettone, vedi §6). Si
    tronca a due righe nell'elenco; intera nel pannello.
  - Segno di **approvazione**: icona «mano alzata» + «Asks Laura Costa» /
    «Asks the Project Lead» / «Asks the owner», 12px ink-muted. Assente se
    «Runs by itself»: l'assenza è il default e non va gridata **[A 5]**.
  - Segno di **progetto**: «in the client's project» o «in BRN» (codice +
    nome nel `title`), solo se il passo non agisce nel progetto
    dell'automazione.
  - Segno di **problema**: icona + «Incomplete» / «Data not available» /
    «Approver can't see BRN» in `critical`, sempre parola + icona.
  - Selezionata: tinta ink 10%, come le righe correnti della colonna.
- **Blocchi con rami** (Condition, Claude con uscite, For each, Repeat
  until): la riga del blocco è la **domanda**; sotto, ogni ramo è una
  **corsia** rientrata di 20px con una linea guida verticale `rule` a
  sinistra e un'**etichetta di corsia** 12px 600 in testa:
  - Condition: «If {Amount} is more than 10,000» / «Otherwise»;
  - Claude: una corsia per uscita, «If Claude says “All present”», «If
    Claude says “Something is missing”»; un passo di Claude senza uscite
    (solo campi) non ha corsie e prosegue in riga;
  - For each: una corsia «For each {product} in {Products sold}» con, a
    destra dell'etichetta, «up to 50 times» `ink-faint`;
  - Repeat until: corsia «Repeat until {Reply received} is yes · at most 2
    times», più la corsia «When the limit is reached».
  - Ogni corsia finisce con la sua riga «+ Add a step» (13px muted, sempre
    visibile: è l'invito per i rami vuoti) e una corsia vuota dice «Nothing
    happens here» in `ink-faint` sopra l'invito.
  - Il blocco ha un chevron che lo richiude: chiuso, mostra «3 branches ·
    9 steps» (e i problemi interni sommati: «1 problem inside»).
- **Momento focale**: il **passo di Claude** del flusso «Nuovo contratto» —
  la riga «Claude reads the contract and lists the tasks to create» con le
  sue uscite come corsie sotto. È il punto in cui chi non è tecnico deve
  capire che Claude decide **solo** fra strade già scritte, e la forma lo
  dice da sola.

```
┌─work area──────────────────────────────────────────┬─Step 2 ─────────────────────┐
│ ← Automations                                      │ ✦ Claude                    │
│ Nuovo contratto  AUT-1                             │ Reads and decides. It never │
│ General · On · Editing version 3 · v2 is on ·      │ acts on its own.            │
│ Acts as Matteo Conti · All changes saved           │                             │
│                      1 problem  ⋯  [Test] [Publish]│ INSTRUCTION                 │
│ ─────────────────────────────────────────────────  │ Read the contract and list  │
│ ⚡ When a deal is won in Audin                      │ the tasks to activate each  │
│    12 pieces of data available · See               │ product sold to {Client     │
│  1 ◇ Create milestone “Activation – {Client name}” │ name}.        [+ Insert data]│
│      in the client's project                       │                             │
│  2 ✦ Claude reads the contract and lists the tasks │ WHAT CLAUDE CAN READ        │
│  │ IF CLAUDE SAYS “TASKS FOUND”                    │ ☑ Contract (PDF)            │
│  │  3 ↻ For each {task} in {Tasks}  up to 50 times │ ☑ Products sold             │
│  │  │  4 ▣ Create task {task › title} for          │                             │
│  │  │      {task › department} · due in {task›days}│ OUTCOMES                    │
│  │  │  + Add a step                                │ Tasks found      [branch]   │
│  │  + Add a step                                   │ Nothing to do    [branch]   │
│  │ IF CLAUDE SAYS “NOTHING TO DO”                  │ + Add an outcome            │
│  │  5 ◔ Notify {Owner}: “No tasks in …”            │                             │
│  │  + Add a step                                   │                             │
│  │  + Add a step                                   │ FIELDS                      │
│  6 ✉ Send welcome email to {Client email}          │ Tasks · list of: title,     │
│      ✋ Asks Matteo Conti  ⚠ Incomplete             │ department, days            │
│  + Add a step                                      │ + Add a field               │
│  End                                               │                             │
└────────────────────────────────────────────────────┴─────────────────────────────┘
```

- **Conseguenza per chi costruisce**: un componente `FlowList` ricorsivo
  (riga di passo + corsie), un `StepPanel` con un modulo per tipo, un solo
  componente «campo con dati» per tutti i testi, un solo `DataPicker`.
  Tutto legge `availableFields(flow, path)` e `validateFlow(...)`: la UI
  non decide mai da sola cosa è disponibile o cosa è un errore.

## 4. Ambito e confini

- **Dentro**: inizio e dati disponibili; i dodici tipi di passo; corsie e
  annidamento; aggiunta, riordino, spostamento fra corsie, duplicazione,
  eliminazione (mouse e tastiera); progetto del passo; riferimenti ai dati;
  approvazione per passo; problemi di configurazione; salvataggio della
  bozza, pubblicazione, accensione con cambio di proprietario; bozza della
  versione successiva su un'automazione attiva; «New automation» con i
  modelli; nome, descrizione e modello del titolo delle esecuzioni; sola
  lettura per chi non può modificare.
- **Fuori**: la prova (`automation-test.md`); elenco, dettaglio, pausa,
  storico delle versioni e delle esecuzioni (`automations.md`); collegare
  sorgenti e tabella cliente → progetto (`automation-sources.md`); Claude
  che costruisce o corregge il flusso (fase finale su Claude).
- **Anti-obiettivi**:
  - un **grafo a nodi e frecce** con zoom e trascinamento libero;
  - un campo dove scrivere un'**espressione** o del codice (le condizioni
    si compongono con campo · operatore · valore);
  - un passo che **salta indietro** («torna al passo 3»): l'unico modo di
    ripetere è un contenitore con limite;
  - un'approvazione che si può **togliere senza vederlo** (un interruttore
    nascosto in un menu, o un passo «Approvazione» che si sposta via);
  - un passo di Claude con un campo «azioni libere» o che manda email,
    crea task, avvia altro;
  - gergo da programmatore nell'interfaccia: «trigger», «payload», «node»,
    «true/false», «null», nomi di chiave come `trattativa.cliente`
    (le chiavi esistono nel modello, l'utente vede le etichette).

## 5. Stati e intervalli

- **Dimensioni**: tipico 5–15 passi e 1–3 livelli; massimo verificato **40
  passi e 5 livelli** di annidamento. Nomi di automazione fino a ~120
  caratteri; titoli di passo con 3–4 gettoni.
- **Numerazione** **[A 6]**: numeri progressivi in ordine di lettura su
  tutto l'albero (1…40), non «3.2.1». Si leggono ad alta voce («il passo
  12») e sono gli stessi della prova e del registro della versione. Si
  rinumerano quando si sposta un passo nella bozza; una versione pubblicata
  ha i suoi numeri fissi.
- **40 passi**: la testata resta fissa; la barra dei problemi porta al
  passo; «⋯» della testata offre «Collapse all branches» / «Expand all»;
  aprendo un passo dal contatore problemi o da un link «Step 27» il
  flusso scorre e lo seleziona.
- **5 livelli**: rientro 20px per livello (100px al quinto), la frase ha
  sempre almeno 360px; oltre il terzo livello il pannello del passo mostra
  in testa il **percorso** in 12px muted («Inside: If Claude says “Tasks
  found” › For each task › If {task.department} is empty») **[A 7]**. Un
  sesto livello non si può creare: il «+» dentro una corsia di quinto
  livello non offre i tipi con rami, e una riga 12px lo spiega («Branches
  can go 5 levels deep.»).
- **Bozza nuova** (vuota): inizio «Choose how this starts» evidenziato come
  primo problema, pannello aperto sull'elenco degli inizi; sotto, una sola
  riga «+ Add a step» e la frase muted «Steps run from top to bottom.
  Add the first one when you've chosen how it starts.»
- **Salvataggio** **[A 8]**: la bozza si salva da sola a ogni modifica
  (lo stesso negozio delle bozze dell'area 6), con «All changes saved» /
  «Saving…» / «Couldn't save · Retry» nella riga meta. Nessun bottone «Save
  draft»: salvare una bozza non cambia mai ciò che gira, quindi non c'è
  niente da confermare. ⌘S forza il salvataggio e lo annuncia. Uscire con
  un salvataggio fallito chiede conferma.
- **Stati dell'automazione nel costruttore**:
  - *Draft, mai accesa*: primario **Turn on**.
  - *On, senza modifiche*: aprire «Edit» non crea nulla finché non si
    cambia qualcosa; alla prima modifica nasce la bozza della versione
    successiva e la riga meta diventa «Editing version 3 · version 2 is
    on». Fascia 13px sotto la testata, una volta: «Your changes are a draft.
    Version 2 keeps running until you publish. Runs in progress finish with
    the version they started with.» Primario **Publish version 3**; «⋯ ›
    Discard this draft» la butta (conferma, «Undo» per 8s).
  - *Paused*: si modifica come una bozza; primario **Publish version 3**
    che pubblica e **resta in pausa** (lo dice il dialogo); la ripresa è
    del dettaglio (`automations.md`) **[A 9]**.
- **Problemi di configurazione** (da `validateFlow`, codici del Task 2),
  testo per l'utente:
  - `incomplete`: «Incomplete: choose who gets the task» (il campo
    mancante per nome);
  - `unknown_ref`: «{Reply text} isn't available here» — succede dopo uno
    spostamento: il gettone diventa barrato `critical` con tooltip «This
    data comes from step 6, which runs later or in another branch»;
  - `type_mismatch`: «For each needs a list. {Client name} is text.»;
  - `approver_cant_see`: «Laura Costa can't see BRN, so she'd never get
    the request. Choose someone else.»;
  - `source_disconnected`: sull'inizio, «HubSpot is disconnected. Reconnect
    it in Sources» con link (solo con `integrations.manage`, altrimenti
    «Ask someone who manages sources»);
  - `limit`: «Repeat until needs a maximum between 1 and 10.»
  Ogni problema sta **sulla riga** (parola + icona) e **sul campo** nel
  pannello (testo sotto il campo, `aria-describedby`). La testata li conta;
  clic sul contatore = primo problema, poi ogni clic il successivo
  (oppure F8 / Maiusc+F8 **[A 10]**). Test e Turn on/Publish sono
  disabilitati con il motivo nel tooltip e accanto: «Fix 3 problems to
  test».
- **Proprietario e cambio** (spec «Permessi»): il dialogo di **Turn on** /
  **Publish** dice sempre chi diventerà proprietario e cosa vuol dire:
  - titolo «Turn on “Richiesta dati al cliente”?» / «Publish version 3?»;
  - corpo: «From now on it acts as you: tasks are created with your
    permissions and emails go out from giulia.ferri@example.com.» Se prima
    era di un altro: riga in più «Today it acts as Laura Costa. After this,
    it acts as you.» Con esecuzioni in corso: «2 runs in progress finish
    with version 2.» Se non è mai stata provata in questa bozza: «You
    haven't tested this version yet.» con «Test first» come secondo bottone
    **[A 11]**;
  - casella mittente: se il flusso ha passi «Send email», menu «Send from»
    con le caselle collegate di chi accende; nessuna casella → dialogo
    bloccato «Connect a mailbox to turn this on — it sends emails» con
    link all'account Google (area 5/6);
  - permessi di chi accende: se gli mancano (es. non può creare task in
    BRN fissato da un passo) il dialogo li elenca e non accende: «You
    can't create tasks in BRN. Ask someone who can, or change step 5.»
  - bottoni: «Cancel» · **Turn on** / **Publish**. Dopo: toast «AUT-1 is
    on · acting as Matteo Conti» e ritorno al dettaglio.
- **Sola lettura** (vede ma non ha `automations.manage`): stessa pagina,
  nessun «+», nessun «⋯» di passo, pannello in lettura, testata con la
  riga «Only someone who can manage automations in AUD can change this.»
  invece di Test/Publish. I gettoni restano leggibili.
- **Caricamento**: scheletro testata + 6 righe; **errore**: «Couldn't load
  this automation» + Retry; **nascosta o inesistente**: identiche (R-G5),
  «This automation doesn't exist or you can't see it».
- **Modifiche concorrenti**: due persone sulla stessa bozza → chi salva
  dopo vede la fascia «Matteo Conti changed this draft 1 min ago · Reload»
  e il suo salvataggio si ferma finché non ricarica (nessuna fusione
  silenziosa) **[A 12]**.

## 6. Interazione e layout

### L'inizio e i dati disponibili

- Selezionando «When», il pannello mostra **Start** con l'elenco degli
  inizi raggruppati (heading-group): FROM OTHER SYSTEMS (una riga per
  sorgente collegata: «A deal is won in Audin», «A deal is won in HubSpot ·
  Expired», «A webhook arrives · {name}»), IN STUBWISE («A task is
  created», «A task is closed», «A request is created», «A milestone is
  reached», «An email arrives in your mailbox»), ON A SCHEDULE («On a date
  or a schedule»), BY HAND («Someone starts it»). Una sorgente scaduta o
  scollegata resta selezionabile ma genera il problema.
- Scelto l'inizio: i suoi parametri (filtro sulle task/email con lo stesso
  costruttore di condizioni; ricorrenza con «Every [Monday] at [9:00]» a
  menu, mai una RRULE scritta), poi la sezione **DATA YOU CAN USE**: tabella
  etichetta · tipo in parole («Text», «Number», «Date», «Email address»,
  «Person», «List of…», «File») · esempio dall'ultimo evento della sorgente
  in `ink-faint` («Rossi Srl»). Le liste si aprono e mostrano i loro
  campi. «12 pieces of data available · See» sulla riga dell'inizio apre
  proprio questa sezione.
- Per «An email arrives»: riga fissa «Only your mailboxes. An automation
  never reads someone else's mail.» e la scelta della casella fra le
  proprie.
- Cambiare inizio quando i passi usano dati del vecchio: dialogo «4 steps
  use data from “A deal is won”. They'll show a problem until you change
  them.» · Cancel · **Change start**.

### Aggiungere, spostare, eliminare

- **«+» fra due righe**: al passaggio o al fuoco di una riga compare,
  sulla linea sotto di essa, un «+ Add step here» 24px; la riga «+ Add a
  step» in fondo a ogni corsia è sempre visibile. Entrambi aprono il
  **menu dei passi** (Menu 320px, cercabile, frecce/Enter):
  - DO SOMETHING — Create a task · Create a milestone · Create a request ·
    Send an email · Notify someone · Start another automation;
  - WAIT — Wait;
  - ASK CLAUDE — Claude reads and decides;
  - BRANCH AND REPEAT — If… otherwise · For each · Repeat until.
  Ogni voce: nome + una riga muted di cosa fa («Branch: different steps
  depending on the data»). Scelto il tipo, la riga nasce **selezionata**
  con il pannello aperto sul primo campo; i campi vuoti obbligatori sono
  già problemi («Incomplete»), così non si dimenticano.
- **Riordino col puntatore**: maniglia a sei punti che appare al passaggio
  (sempre presente al fuoco), trascinamento verticale con indicatore di
  inserimento (linea ink 2px) **anche dentro e fuori dalle corsie**; un
  blocco si sposta con tutti i suoi rami. Lo stesso motore e gli stessi
  annunci di `HomeEditor` (dnd-kit, «Step 5 picked up… moved to
  position 3 in “If Claude says Tasks found”»).
- **Riordino da tastiera** (come la Home): fuoco sulla maniglia, Spazio
  prende, ↑/↓ sposta nel flusso in ordine di lettura (entrando e uscendo
  dalle corsie una posizione alla volta), Spazio lascia, Esc annulla e
  rimette il passo dov'era. Alternativa esplicita in «⋯ › Move to…»: un
  dialogo con l'albero delle corsie («Main steps», «If Claude says “Tasks
  found”», «For each task»…) e la posizione **[A 13]**.
- **Navigazione del flusso**: il flusso è un `role="tree"`: ↑/↓ fra righe,
  → apre/entra in un blocco, ← lo richiude/esce al genitore, Enter
  seleziona (apre nel pannello), Tab passa al pannello. Scorciatoie sulla
  riga selezionata **[A 14]**: «A» = aggiungi un passo dopo (apre il menu),
  ⌘D = duplica, ⌫/Canc = elimina, ⌥↑/⌥↓ = sposta di uno senza entrare in
  modalità presa. Tutte anche nel «⋯» della riga, con le scorciatoie scritte
  accanto.
- **Eliminare**: un passo semplice si elimina subito con toast «Step 7
  deleted · Undo» (8s). Un blocco con passi dentro chiede conferma: «Delete
  “If {Amount}…” and the 6 steps inside it?» · Cancel · **Delete**. Se
  altri passi usano i suoi dati, il dialogo lo dice («Steps 9 and 12 use
  data from it and will show a problem.»).
- **Duplicare**: copia subito sotto, con «(copy)» nel titolo; le corsie si
  copiano intere.

### Il pannello del passo

- Testata: numero «Step 7» tnum + tipo («Send an email»), il percorso se
  annidato (§5), «⋯» (Duplicate · Move to… · Delete). Corpo a sezioni con
  heading-group, dall'alto: cosa fa → dove (progetto) → quando parte
  (approvazione). Ogni modifica si vede subito nella frase della riga.
- **Create a task**: Title* (campo con dati) · Description (multilinea con
  dati) · **Who does it*** — segmentato «A person · A department · A role in
  the project», poi rispettivamente: scelta persona (o un dato di tipo
  Persona, «{Sales owner}»); reparto con la sua striscia 3px + nome, e la
  riga «The task has no assignee: anyone in Sales can pick it up»; ruolo
  («Project Lead», «Developer»…) e la riga «The first person with this role
  in the project, in alphabetical order. If nobody has it, the task starts
  without an assignee and the run log says so.» · Due — «No due date» /
  «[2] days after it's created» · Milestone — nessuno / un traguardo creato
  da un passo precedente («The milestone from step 2») · Where · Before it
  runs.
- **Create a milestone**: Name* · Due in N days · Where · Before it runs.
- **Create a request**: Title* · Description · Where · Before it runs.
- **Send an email**: To* (campo indirizzo che accetta indirizzi e dati di
  tipo Email: «{Client email}») · Subject* · Body* (multilinea con dati,
  grassetto/elenchi come il compositore dell'area 6) · Attachments (file
  dell'evento o del Drive del progetto, a gettoni) · riga fissa «Sent from
  the owner's mailbox when the automation runs.» · Before it runs (default
  **Asks the owner** per i passi email nuovi **[A 15]**).
- **Notify someone**: Who* (persona o dato Persona o ruolo) · Message* ·
  Before it runs.
- **Start another automation**: menu delle automazioni accese visibili a
  chi costruisce (codice + nome) · riga «It starts with its own steps and
  its own approvals.» · Before it runs. Un'automazione che avvia sé stessa
  (anche indirettamente) è un problema `incomplete` con testo «This would
  start itself again.» **[A 16]**.
- **Wait**: segmentato «Some time · A reply to an email · A task to be
  closed». Some time: «[3] days». Reply: menu dei passi «Send an email»
  precedenti nel ramo («The email from step 4») + «Stop waiting after [5]
  days» (obbligatorio). Task: menu dei passi «Create a task» precedenti +
  massimo giorni. La frase della riga dice il caso «primo dei due»: «Wait
  for a reply to step 4, at most 5 days». Dati che produce: «Reply
  received» (sì/no), «Reply text», «Reply attachments».
- **Claude reads and decides**: riga fissa in testa (regola 2) ·
  INSTRUCTION* (multilinea con dati, 4–12 righe) · WHAT CLAUDE CAN READ
  (caselle: documenti dell'evento, risposta di un passo «Wait» precedente,
  «Files from the project's Drive» con scelta dei file o della cartella) ·
  OUTCOMES (elenco di etichette brevi, 0–6; ognuna crea una corsia; si
  rinominano sul posto; eliminare un'uscita con passi dentro chiede
  conferma) · FIELDS (nome · tipo dal menu dei tipi; «List of…» apre i
  sottocampi, max 6 **[A 17]**). Almeno un'uscita o un campo, altrimenti
  `incomplete` «Tell Claude what to answer». Riga muted in fondo: «If
  Claude's answer doesn't match these outcomes and fields, the step fails
  and the run stops. Nothing else happens.» Nessuna impostazione di
  approvazione: il passo non produce effetti.
- **If… otherwise**: costruttore di condizione a righe «[dato] [operatore]
  [valore]»; operatori in parole secondo il tipo («is», «is not»,
  «contains», «is empty», «is not empty», «is more than», «is less than»,
  per le date «is before/after»); valore = testo/numero/data o un altro
  dato; più righe unite da «All of these» / «Any of these» (un solo
  livello di gruppo nell'interfaccia **[A 18]**). Corsie «If…» e
  «Otherwise»; «Otherwise» può restare vuota.
- **For each**: List* (menu dei soli dati di tipo lista disponibili) ·
  «Call each one» [task] (il nome con cui il dato compare nei passi
  interni, precompilato al singolare dell'etichetta) · riga «Runs at most 50
  times. If the list is longer, the step stops with an error.»
- **Repeat until**: «Until» (stesso costruttore di condizione, sui dati
  dei passi interni) · **At most [2] times*** (1–10, nessun default vuoto:
  nasce a 3) · corsia «When the limit is reached» (può restare vuota). Riga
  muted: «Steps inside run first, then the condition is checked.»
- **Where** (passi che creano) — segmentato a tre **[A 19]**:
  «This automation's project (AUD)» (solo automazioni di progetto, ed è il
  default) · «The client's project» con il dato che identifica il cliente
  («{Client}») e la riga «Found in the client table. If the client isn't
  there, the run stops and asks the owner to choose.» + link «Client table»
  (`automation-sources.md`) · «Always this project» con scelta del progetto
  fra quelli in cui chi costruisce può creare. Nelle generali il default è
  «The client's project».
- **Before it runs** (passi che producono un effetto) — due radio a tutta
  larghezza con frase di conseguenza:
  - «Runs by itself» — «It happens as soon as the run reaches it.»
  - «Asks for approval» — «The run stops here until {who} approves. Nothing
    is created or sent before that.» Sotto: «Who approves» = una persona ·
    un ruolo nel progetto in cui agisce il passo · «The owner (whoever
    turned it on)». Un approvatore che non vede il progetto è
    `approver_cant_see`; per «the client's project», il controllo si fa
    durante l'esecuzione e il pannello lo dice in una riga.

### Riferimenti ai dati nei campi

- Ogni campo di testo del costruttore è un **campo con dati**: si scrive
  normalmente e si inserisce un dato con «{» (digitato) o con il bottone
  «+ Insert data» a destra del campo. Si apre il **DataPicker** (320px,
  cercabile): gruppi = provenienza («From the start: Deal won», «Step 3 ·
  Claude», «For each task», «Step 4 · Wait for a reply»), righe =
  etichetta + tipo in parole + esempio muted. Solo ciò che
  `availableFields` dà per quel punto; ciò che c'è altrove non compare
  (nessuna voce disabilitata da spiegare).
- Il dato inserito è un **gettone** atomico (tinta ink 6%, raggio 4px,
  etichetta 13px, Backspace lo toglie intero) — la stessa forma dei
  gettoni della casella di Claude. Per i sottocampi: «task › title».
  Tooltip: provenienza e tipo («From step 3 · Claude · Text»).
- Gettone non più valido: barrato, `critical`, icona, tooltip con il
  perché; la riga mostra il problema.

### Modelli e «New automation»

- «New automation» apre un dialogo (Dialog 640px): **Name** · **Where it
  works** «In a project» (scelta fra i progetti dove ho `automations.manage`)
  / «Across projects (general)» (solo con il permesso d'istanza; altrimenti
  assente) · **Start from**: «Blank» o i modelli, come righe con nome, frase
  di cosa fanno e numero di passi:
  - «New contract → tasks for everyone» — «When a deal is won, Claude reads
    the contract and creates a milestone and the tasks for each team.»
  - «Ask the client for information» — «Email the client, remind them up to
    twice, and check their reply with Claude.»
  Crea la bozza e apre il costruttore. Dal modello, le scelte personali
  (sorgente, approvatori, casella, reparti) arrivano **vuote** e quindi già
  segnate come problemi da completare, mai riempite con persone del seme
  **[A 20]**.

### Movimento e annunci

- Nuova riga: dissolvenza 150ms; blocco che si richiude: 200ms in altezza;
  pannello che cambia passo: nessuna animazione (cambia il contenuto).
  Nulla con movimento ridotto.
- `aria-live="polite"` per salvataggio, spostamenti, eliminazione con Undo;
  il contatore problemi annuncia solo quando passa da 0 a >0 e viceversa.

## 7. Vincoli e decisioni aperte

- Il formato è `AutomationFlow` del Task 1: la UI non aggiunge campi
  propri al flusso (le preferenze di vista — blocchi chiusi, larghezza del
  pannello — stanno nella memoria locale della vista).
- Dati disponibili ed errori **solo** da `availableFields` e `validateFlow`;
  la frase della riga è una funzione pura del passo (testabile, en/it).
- Limiti del Task: max 50 giri di For each, Repeat until 1–10, max 20
  email per esecuzione (problema `limit` se un flusso ne manda
  sicuramente di più, es. una email dentro un For each senza tetto
  → avviso, non errore **[A 21]**).
- en/it con parità; le frasi della riga sono composte da modelli i18n con
  segnaposto, mai concatenando pezzi tradotti; l'italiano è ~20% più
  lungo e va a capo senza rompere i segni a destra (vanno sotto la frase
  quando manca spazio).
- Colore: solo stato (`critical` per i problemi) e striscia di reparto nel
  campo «A department»; Claude resta ink (anello tratteggiato sul glifo
  del passo di Claude **[A 22]**); niente blu fuori dal fuoco.
- Glifi dei tipi di passo: una famiglia sola 16px in ink-muted, nome sempre
  scritto accanto nel menu e nel pannello (il glifo non è mai l'unico
  segnale).

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| azioni testata | Test · Turn on · Publish version {{n}} · Discard this draft | Prova · Accendi · Pubblica la versione {{n}} · Butta questa bozza |
| stato | Draft · On · Paused · Editing version {{n}} · version {{m}} is on | Bozza · Accesa · In pausa · Stai modificando la versione {{n}} · è accesa la versione {{m}} |
| salvataggio | All changes saved · Saving… · Couldn't save · Retry | Modifiche salvate · Salvataggio… · Non salvato · Riprova |
| problemi | {{count}} problems · Fix {{count}} problems to test | {{count}} problemi · Risolvi {{count}} problemi per provarla |
| inizio | When · Choose how this starts · {{count}} pieces of data available · See | Quando · Scegli come parte · {{count}} dati disponibili · Vedi |
| aggiungere | Add a step · Add step here · Nothing happens here | Aggiungi un passo · Aggiungi un passo qui · Qui non succede niente |
| gruppi del menu | Do something · Wait · Ask Claude · Branch and repeat | Fai qualcosa · Aspetta · Chiedi a Claude · Dividi e ripeti |
| tipi | Create a task · Create a milestone · Create a request · Send an email · Notify someone · Start another automation · Wait · Claude reads and decides · If… otherwise · For each · Repeat until | Crea una task · Crea un traguardo · Crea una richiesta · Manda un'email · Avvisa qualcuno · Avvia un'altra automazione · Aspetta · Claude legge e decide · Se… altrimenti · Per ogni · Ripeti finché |
| incaricato | Who does it · A person · A department · A role in the project | Chi la fa · Una persona · Un reparto · Un ruolo nel progetto |
| progetto | Where · This automation's project · The client's project · Always this project | Dove · Il progetto dell'automazione · Il progetto del cliente · Sempre questo progetto |
| approvazione | Before it runs · Runs by itself · Asks for approval · Asks {{name}} · The owner | Prima di partire · Parte da solo · Chiede approvazione · Chiede a {{name}} · Il proprietario |
| Claude | Claude only picks one of these outcomes and fills these fields. It never acts on its own: actions are the steps you add. | Claude sceglie solo una di queste uscite e compila questi campi. Non agisce mai da solo: le azioni sono i passi che aggiungi tu. |
| ripeti | At most {{n}} times · When the limit is reached | Al massimo {{n}} volte · Quando si arriva al limite |
| proprietario | From now on it acts as you · Today it acts as {{name}} | Da adesso agisce come te · Oggi agisce come {{name}} |
| sola lettura | Only someone who can manage automations in {{code}} can change this. | Solo chi gestisce le automazioni in {{code}} può modificarla. |

## Scelte del brief da confermare

1. **[A 1] [scelta del brief]** Rotta del costruttore `#/automations/<code>/edit`; una bozza
   nuova ha subito un codice (riservato alla creazione, mai riusato).
2. **[A 2] [scelta del brief]** L'approvazione è una proprietà del passo (sezione «Before it
   runs»), non un passo separato: non si può spostare o cancellare per
   sbaglio, e la riga la mostra sempre.
3. **[A 3] [scelta del brief]** Forma del flusso: **elenco numerato verticale con rami
   annidati in corsie rientrate**, niente grafo. Pannello del passo
   agganciato a destra.
4. **[A 4] [scelta del brief]** Il costruttore è una pagina di Automations (colonna visibile),
   non un editor a tutto schermo.
5. **[A 5] [scelta del brief]** «Parte da solo» è il default silenzioso; sulla riga si vede
   solo «Asks …».
6. **[A 6] [scelta del brief]** Numeri progressivi 1…N su tutto l'albero (non «3.2.1»), gli
   stessi della prova e del registro della versione.
7. **[A 7] [scelta del brief]** Percorso del passo in testa al pannello oltre il terzo
   livello; un sesto livello non si può creare.
8. **[A 8] [scelta del brief]** Bozza salvata da sola, senza bottone «Salva bozza» (⌘S forza).
9. **[A 9] [scelta del brief]** Pubblicare su un'automazione in pausa la lascia in pausa.
10. **[A 10] [scelta del brief]** F8 / Maiusc+F8 per passare da un problema all'altro.
11. **[A 11] [scelta del brief]** Provarla non è obbligatorio per accendere: il dialogo dice
    «non l'hai ancora provata» e offre «Prova prima».
12. **[A 12] [scelta del brief]** Bozza modificata da un altro: fascia «Ricarica», nessuna
    fusione automatica.
13. **[A 13] [scelta del brief]** Spostare fra corsie: trascinamento, frecce in modalità presa,
    e «Sposta in…» con l'albero delle corsie.
14. **[A 14] [scelta del brief]** Scorciatoie sulla riga: A aggiungi dopo, ⌘D duplica, ⌫
    elimina, ⌥↑/⌥↓ sposta.
15. **[A 15] [scelta del brief]** Un passo «Manda un'email» nuovo nasce con «Chiede
    approvazione al proprietario» (gli altri con «Parte da solo»).
16. **[A 16] [scelta del brief]** Un'automazione che avvierebbe sé stessa (anche tramite
    un'altra) è un problema di configurazione.
17. **[A 17] [scelta del brief]** Passo di Claude: 0–6 uscite, campi «Elenco di…» con al
    massimo 6 sottocampi.
18. **[A 18] [scelta del brief]** Condizioni con un solo livello di gruppo («Tutte» / «Almeno
    una») nell'interfaccia, anche se il modello ne ammette di più.
19. **[A 19] [scelta del brief]** «Dove» a tre scelte; default «Il progetto dell'automazione»
    per quelle di progetto, «Il progetto del cliente» per le generali.
20. **[A 20] [scelta del brief]** I modelli arrivano con sorgente, approvatori, casella e
    reparti vuoti (già segnati come problemi), mai riempiti col seme.
21. **[A 21] [scelta del brief]** Un'email dentro un «Per ogni» è un avviso sul limite delle
    20 email, non un errore che blocca.
22. **[A 22] [scelta del brief]** Il glifo del passo di Claude porta l'anello tratteggiato in
    ink (la firma di Claude nel resto dell'app), senza colore proprio.
