# Shape brief — Gli effetti dell'istanza nelle altre aree

> Shape scritto dal controller senza intervista (30 ott 2026). Le scelte
> non coperte da design e piano sono marcate **scelta del controller** e
> numerate **[EF n]** in fondo. Decisioni del maintainer del 30 ott 2026
> che reggono questo shape:
> - un passo d'automazione con il budget esaurito **resta fermo e riparte da
>   solo** quando il budget torna disponibile (come il `budget_held` del
>   web), non fallisce;
> - la pausa della coda **non** tocca «Chiedi a Claude»: la ferma solo il
>   budget.

Superficie: nessuna pagina nuova. Frasi, stati e controlli spenti che le
impostazioni d'istanza (`admin-ai.md`, `admin-integrations.md`,
`admin-instance.md`) producono **altrove**:
- la sezione **Claude** della task (`pages/task/ClaudeSection.tsx`,
  `task-claude.md`) e la sua storia del lavoro;
- la **testata della colonna del progetto** (riga del progetto);
- il composer di **«Chiedi a Claude»** (conversazione libera,
  `claude-destination.md`, `conversation.md`);
- il dettaglio e l'elenco delle **esecuzioni delle automazioni**
  (`automations.md`);
- il **Drive** e gli allegati dei composer (`drive.md`, `chat.md`);
- l'avvio dell'**analisi** e della **correzione** di un server (`servers.md`,
  `server-task.md`).

Piano 9b: Task 6 (dati: Task 2, 3, 4, 5). Spec area 9: «Quanto è vero nel
prototipo → Impostazioni», «Il lavoro nella coda». Mondo: «Catalogo
numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**: chiunque lavori in un progetto e trovi Claude fermo — Marco che
  preme «Start» su STW-14, Sara che allega un file in chat, Laura che segue
  un'automazione di ACQ. **Non** è chi ha cambiato l'impostazione: spesso non
  sa che esiste una pausa o un budget.
- **Stato d'animo**: sorpresa. La frase deve dire **cosa è successo**,
  **chi o cosa lo decide**, **se si sblocca da solo** e **a chi chiedere**
  («Who?»), senza nomi d'impostazione tecnici.

## 2. Esito e prova

- **Successo**:
  - col budget raggiunto, sulla task di ACQ leggo «Ready to start» con
    **Start** spento e sotto «The monthly AI budget is used up. New work
    waits until someone raises it. **Who?**»; il «Who?» mi dice Roberta;
  - con la coda di STW in pausa, su STW-14 leggo «STW's queue is paused by
    Roberta Fontana» e **Start** acceso; premuto, la riga di stato dice
    «Waiting: queue paused by Roberta Fontana», e alla ripresa parte da sola
    e arriva il piano;
  - un'esecuzione d'automazione di ACQ dice «Waiting: monthly AI budget
    reached» nel suo riquadro «Now» e «It starts again on its own when the
    budget is available» — e non compare fra quelle fallite;
  - in «Chiedi a Claude», con STW in pausa, Claude risponde; col budget
    raggiunto il composer dice perché non può;
  - nella sezione Claude leggo «Model: Haiku · Account: Backup Max
    (subscription)»;
  - col caricamento spento, «Upload» nel Drive è spento con la frase e
    **Who?**.
- **Verità del prodotto**:
  - **il lavoro già partito finisce** (budget e pausa fermano solo il
    nuovo);
  - **sulla coda in pausa «Avvia» non è rifiutato**: entra in attesa e parte
    una volta sola; un secondo «Avvia» non c'è (la sessione è viva);
  - **col budget raggiunto «Avvia» è rifiutato**, prima (bottone spento) e
    dopo (risposta `monthly_budget`);
  - **i passi d'automazione col budget esaurito aspettano**, e ripartono da
    soli solo quando il budget torna disponibile;
  - **«Chiedi a Claude» non è nella coda di un progetto**;
  - **auto-fix, soglie d'effort e approvazione da effort non hanno effetti
    visibili** (si salvano e basta): nessuna frase qui li nomina.

## 3. Direzione scelta

- **Tesi**: **un blocco è una frase sola, sempre nello stesso posto: sopra
  il controllo che ferma**. Stessa forma ovunque — glifo, frase in parole,
  «Who?» se lo sblocca un permesso — così la si riconosce in task,
  automazioni, server e Drive. Due famiglie di frasi, mai mescolate:
  **budget** («The monthly AI budget is used up») e **coda** («STW's queue is
  paused by Roberta Fontana»). Quando valgono entrambe, il budget vince
  (ferma, la pausa fa solo aspettare) **[EF 1]**.

### Le frasi del blocco (`AiBlock`)

| Blocco | Prima di avviare (sopra il controllo) | Dopo (stato del lavoro in attesa) |
|---|---|---|
| `monthly_budget` | «○ The monthly AI budget is used up. New work waits until someone raises it. **Who?**» / «○ Il budget AI del mese è esaurito. Il lavoro nuovo aspetta finché qualcuno non lo alza. **Chi?**» | «◷ Waiting: monthly AI budget reached» / «◷ In attesa: budget AI del mese raggiunto» (solo passi d'automazione) |
| `queue_paused` | «‖ STW's queue is paused by Roberta Fontana since yesterday at 18:00. If you start now, Claude waits for it to resume.» / «‖ La coda di STW è in pausa da Roberta Fontana da ieri alle 18:00. Se avvii adesso, Claude aspetta la ripresa.» | «◷ Waiting: queue paused by Roberta Fontana» / «◷ In attesa: coda in pausa da Roberta Fontana» |

- «Who?» del budget = azione `manageSettings` («change the instance
  settings»), nel popover di `admin-audit.md`. La frase della pausa **non**
  ha «Who?» davanti a un bottone acceso (non è un permesso che manca); il
  nome di chi l'ha messa basta. *Scelta del controller*: chi vuole sapere a
  chi chiedere la ripresa trova il «Who?» nella testata del progetto (sotto).
- Glifi: ○ informazione, ‖ pausa, ◷ in attesa; nessun colore di stato (non è
  un errore). Il budget **raggiunto** nella sua pagina usa `critical`; qui no:
  per chi lavora è un'attesa, non un guasto.

### Sezione Claude della task

- **Ordine invariato** (`task-claude.md`): riga di stato → (blocco) → scheda →
  ultimo messaggio → PR → azioni → storia. Il blocco è una riga 13px subito
  sopra le azioni.
- **Budget raggiunto**:
  - «Ready to start»: **Start** spento, frase del budget con **Who?**;
  - fallita / fermata: **Relaunch with instructions** spento con la stessa
    frase;
  - PR aperta: **Request changes** spento con la stessa frase;
  - correzione ferma: **Resume correction** segue la stessa regola (il
    piano tocca anche `resumeCorrection`);
  - `working`: niente cambia; nessuna frase (il lavoro finisce).
  - Se la scrittura arriva lo stesso (budget raggiunto nel frattempo): riga
    ✕ sopra le azioni «Claude didn't start: the monthly AI budget is used
    up.» / «Claude non è partito: il budget AI del mese è esaurito.»
- **Coda in pausa** (progetto della task):
  - «Ready to start»: frase della pausa, **Start** acceso;
  - dopo Start: riga di stato «◷ Waiting: queue paused by Roberta Fontana» +
    età a destra, avatar CL **senza** anello (non sta lavorando); nessuna
    azione primaria; il menu «⋯» tiene **Stop** se c'era **[EF 2]**;
  - stesso comportamento per Relaunch, Request changes, Resume correction:
    accettati, il lavoro aspetta;
  - storia del lavoro: «Run started · waiting for the queue» / «Esecuzione
    avviata · in attesa della coda» e, alla ripresa, «Queue resumed by
    Roberta Fontana · run started» / «Coda ripresa da Roberta Fontana ·
    esecuzione partita».
- **Modello e account** **[EF 3]**: la riga `ProviderLine` sotto la riga di
  stato diventa «Model: Haiku · Account: Backup Max (subscription)» /
  «Modello: Haiku · Account: Backup Max (abbonamento)» (12px `ink-faint`);
  la chiave API: «Account: Billing key (API key)». È quello con cui la
  sessione è partita: un cambio successivo in Models non la riscrive. Nella
  storia: «Run started · Opus · Team Max» e, all'esecuzione, «Execution
  started · Sonnet» se il modello di `fix_execute` è diverso. Nella pagina
  della sessione (`#/claude/<id>`) la testata ha la stessa riga.
- I consumi della task (tabella «AI usage» dell'area 3) mostrano già il
  modello per riga: ora è quello di `modelFor`.

### Riga del progetto (testata della colonna del progetto) **[EF 4]**, confermata dal maintainer il 30 ott 2026

- Con la coda in pausa, sotto la riga del tipo di progetto, 12px
  `ink-muted`: «‖ Queue paused by Roberta Fontana» / «‖ Coda in pausa da
  Roberta Fontana», con `title` «Since yesterday at 18:00. New Claude work
  waits; work already running finishes.» e, accanto, **Who?** verso
  «Who can change the instance settings» (chi può riprenderla).
- Nessuna riga per il budget nella testata (vale per tutta l'istanza: lo
  dice ogni controllo che ferma).
- Nell'elenco **All projects**, la riga del progetto in pausa porta lo stesso
  «‖ Queue paused» sulla seconda linea.
- Le tessere del rail non cambiano.

### «Chiedi a Claude» (conversazione libera)

- **Coda in pausa**: nessun effetto, nessuna frase, anche con un progetto
  in pausa come contesto (decisione del maintainer).
- **Budget raggiunto**: sopra il composer, riga 13px «○ The monthly AI budget
  is used up: Claude can't answer until someone raises it. **Who?**» / «○ Il
  budget AI del mese è esaurito: Claude non può rispondere finché qualcuno
  non lo alza. **Chi?**»; **Send** spento, il testo scritto resta **[EF 5]**.
  Se il messaggio parte lo stesso ed è rifiutato: riga ✕ sotto il composer
  «Your message wasn't sent: the monthly AI budget is used up.» / «Il
  messaggio non è stato inviato: il budget AI del mese è esaurito.» e il
  testo torna nel composer.
- Una risposta di Claude già in corso finisce.

### Esecuzioni delle automazioni

- **Passo fermo per budget** (stato dell'esecuzione: resta viva, in attesa al
  confine del passo; in elenco la parola è «Waiting» / «In attesa» col glifo
  orologio `ink-muted`, come `waiting_event`) **[EF 6]**:
  - **frase di adesso** in elenco: «Waiting for the AI budget · step 4
    “Classify the request”» / «In attesa del budget AI · passo 4
    “Classifica la richiesta”»;
  - **riquadro «Now»** del dettaglio: frase grande «Waiting: monthly AI
    budget reached» / «In attesa: budget AI del mese raggiunto» · dettagli
    «Step 4 “Classify the request” starts again on its own when the budget is
    available — when someone raises it, or next month. Nothing is lost.» /
    «Il passo 4 “Classifica la richiesta” riparte da solo quando il budget
    torna disponibile — quando qualcuno lo alza, o il mese prossimo. Non si
    perde niente.» · **Who can raise it?** / **Chi può alzarlo?** (popover
    `manageSettings`);
  - **registro dell'esecuzione**: riga «Waiting: monthly AI budget reached»
    / «In attesa: budget AI del mese raggiunto» all'ora in cui si è fermata;
    alla ripartenza «Budget available again · step 4 started» / «Budget di
    nuovo disponibile · passo 4 partito»;
  - **«Pass time»** del prototipo: c'è e dice «Passing time won't move this
    run: it waits for the budget.» / «Far passare il tempo non sposta questa
    esecuzione: aspetta il budget.» con i bottoni spenti (come per le
    approvazioni);
  - **non** è in «Needs attention» (non è fallita, non aspetta me); è in
    «Runs in progress».
- **Passo fermo per la coda in pausa**: identico, con «Waiting: STW's queue
  is paused by Roberta Fontana» / «In attesa: la coda di STW è in pausa da
  Roberta Fontana» e «It starts again on its own when the queue resumes.» /
  «Riparte da solo quando la coda riprende.»; registro «Waiting: queue paused
  by Roberta Fontana» → «Queue resumed · step 4 started».
- **Due blocchi**: fermo per budget in un progetto in pausa; alzato il
  budget, la frase cambia in quella della pausa e il registro dice «Budget
  available again · still waiting: queue paused» / «Budget di nuovo
  disponibile · ancora in attesa: coda in pausa».

### Server: analisi e correzione

- **Budget raggiunto**: «Ask Claude to look» e «Start the fix» spenti con la
  frase del budget e **Who?**.
- **Coda in pausa** (progetto principale del server): accettati; lo stato del
  lavoro sul server dice «Waiting: queue paused by Roberta Fontana» al posto
  di «Claude is looking into it», senza anello.

### Drive e allegati (archiviazione)

- Quando `storageAllowsUploads()` è falso:
  - **Drive**: **Upload** spento, sopra la barra una riga 13px «○ Uploads
    are off on this instance. Files already here stay readable. **Who?**» /
    «○ I caricamenti sono spenti su questa istanza. I file già presenti
    restano leggibili. **Chi?**» (azione `manageSettings`); trascinare un
    file non apre il velo, il cursore dice «non si può»; «Add from Google
    Drive» resta acceso (collega, non carica) **[EF 7]**;
  - **composer** (chat, conversazioni, commenti con allegati): la graffetta
    è spenta con `title` «Uploads are off on this instance.» / «I
    caricamenti sono spenti su questa istanza.»; incollare o trascinare un
    file mostra la stessa frase sotto il composer per 4 s; allegare una task,
    una pagina o un file già nel Drive resta possibile;
  - un caricamento rifiutato (`storage_off`) già partito: «Upload failed:
    uploads are off on this instance.» / «Caricamento non riuscito: i
    caricamenti sono spenti su questa istanza.» · **Dismiss**.
- Il motivo preciso (allegati spenti, verifica fallita, non configurata) lo
  vede solo chi apre Amministrazione → Storage: per chi lavora la frase è una.

## 4. Ambito e confini

- **Dentro**: budget raggiunto e coda in pausa su task, sessioni, «Chiedi a
  Claude», automazioni, server; modello e account nella sezione Claude, nella
  storia e nella sessione; archiviazione spenta in Drive e composer; la riga
  del progetto.
- **Fuori**: effetti di auto-fix, soglie, approvazione da effort (si
  salvano e basta); account AI preferito del progetto e interruttori del
  progetto (9c); plugin spenti per progetto (9c); un lavoro senza nessun
  account disponibile (`pickProvider()` nullo: nel seme non si arriva, il
  prototipo non lo simula).
- **Anti-obiettivi**: un «Avvia» rifiutato su una coda in pausa; un passo
  d'automazione fallito per budget; «Chiedi a Claude» fermato dalla pausa;
  un blocco detto solo col colore; un controllo spento senza frase o senza
  «Who?» quando lo sblocca un permesso; il nome dell'impostazione
  («monthlyUsd», «queue») a schermo.

## 5. Stati e intervalli

- **Combinazioni**: nessun blocco · solo budget · solo pausa · entrambi (vince
  il budget per gli avvii; per i lavori già in attesa la frase è quella del
  blocco che vale adesso).
- **Transizioni**: alzato il budget, i controlli tornano accesi al giro
  successivo della query (nessun ricaricamento a mano); ripresa la coda, la
  riga di stato passa da «Waiting…» a «Working» con l'anello in 200ms e
  l'annuncio `aria-live` «Claude started on STW-14.» / «Claude è partito su
  STW-14.»
- **Persona disattivata** che ha messo la pausa: «Queue paused by Roberta
  Fontana (deactivated)».
- **Nomi lunghi** di progetto o persona: la frase va a capo, non si tronca.
- **Caricamento / errore**: i blocchi sono parte della risposta di ogni
  pagina; se la loro lettura fallisce la pagina mostra il suo errore
  normale, mai un controllo acceso «per sicurezza».

## 6. Interazione e layout

- La riga del blocco sta **sopra** il controllo che ferma, a tutta larghezza
  del contenitore (pannello 360–640px, dettaglio dell'esecuzione 960px).
- **1440×900**: nel pannello agganciato la frase sta su due righe; nel
  dettaglio dell'esecuzione su una.
- **1024×680**: il pannello è sovrapposto (400px), la frase va su tre righe e
  «Who?» resta in coda alla frase, mai su una riga da solo; nella testata
  della colonna (240px) «‖ Queue paused by Roberta Fontana» va a capo su due
  righe.
- «Who?» apre il popover di `admin-audit.md`; il fuoco torna al link alla
  chiusura.

## 7. Vincoli

- Le frasi leggono `aiBlockFor(projectId)`, `TaskWork.blocked`,
  `Conversation.waiting`, `Conversation.model` e `storageAllowsUploads()`
  attraverso le query: nessuna pagina decide da sola se il budget è
  raggiunto.
- `OPERATION_OF_KIND` decide il modello mostrato (`task_run` → `fix_plan`,
  poi `fix_execute`; `free` → `chat`; `server_analysis` → `fix_plan`, *scelta
  del controller* del piano).
- Nessuna voce del registro nasce da questi effetti (le scrive chi cambia
  l'impostazione o la coda).
- Testi en/it con parità.

## Scelte del brief (scelte del controller, da confermare)

1. **[EF 1]** Un blocco è una frase sopra il controllo; budget e pausa hanno
   frasi diverse; con entrambi vince il budget.
2. **[EF 2]** Con la coda in pausa un lavoro in attesa si può fermare dal
   «⋯» (Stop), come uno in corso.
3. **[EF 3]** Modello e account in una riga sola sotto lo stato, quelli con
   cui la sessione è partita.
4. **[EF 4]** La pausa si legge anche nella testata della colonna del
   progetto e nella riga di All projects, con «Who?» verso chi può
   riprenderla.
5. **[EF 5]** «Chiedi a Claude» col budget raggiunto: Send spento in
   anticipo, il testo resta.
6. **[EF 6]** Un'esecuzione ferma per budget usa la parola «Waiting» e il
   glifo orologio, non uno stato nuovo in elenco.
7. **[EF 7]** Con i caricamenti spenti, «Add from Google Drive» e gli
   allegati di oggetti già presenti restano possibili.

## Scelte confermate dal maintainer (30 ott 2026)

1. **[EF 4]** «Queue paused by …» / «Coda in pausa da …» compare anche nella
   testata della colonna del progetto e nella riga del progetto di «All
   projects» / «Tutti i progetti».
