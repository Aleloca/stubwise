# App desktop Stubwise, area 8: Releases, Support e Servers — design

Data: 28 ott 2026. Ottavo documento della serie (ossatura
`docs/plans/2026-10-23-desktop-ossatura-design.md`, aree 2–7 accanto). Si
costruisce nel prototipo `apps/desktop` con dati finti, con le stesse
regole: ogni pagina definita fino in fondo, stati veri, permessi verificati
col «vedi come». Linguaggio visivo `apps/desktop/DESIGN.md`; UI e UX
definite con Impeccable (shape → costruzione → revisione).

Le decisioni marcate *(maintainer)* vengono dalla conversazione del 28 ott
2026; quelle marcate *(scelta del controller)* sono proposte confermabili,
prese per non lasciare buchi a chi costruisce. Quello che manca davvero e
cambierebbe cosa si costruisce è stato chiesto al maintainer e risolto lo
stesso giorno (risposte A–C e H, sotto marcate *(maintainer)*); le scelte
D–G vengono dalla revisione del costruttore *(scelta del controller)*.

## Due piani: 8a e 8b *(maintainer)*

L'area si costruisce in **due piani**, ciascuno con le sue revisioni e il
suo push:

- **8a — avvisi, rilasci, PR, supporto**: il sistema di iscrizioni agli
  avvisi (catalogo, Preferenze → Notifiche, scorciatoia dal progetto,
  destinatari calcolati a lettura); Releases (PR aperte con l'analisi, coda
  di rilascio, stato del rilascio, rilascio fallito e «Fai sistemare a
  Claude», ambienti); analisi e correzione di tutte le PR (impostazione per
  repository e «Solo analisi» per PR); Support e richieste dei clienti; il
  bug del compositore della Posta.
- **8b — server**: la parte server del Monitor portata dal web (sezione
  Servers, dettaglio con grafici, servizi, dischi, controlli, soglie, nuovo
  server e chiave dell'agente), gli accessi SSH, l'analisi automatica, la
  correzione da task con `servers.operate`.

**Cosa 8b usa di 8a**, e quindi 8a deve già offrire *(scelta del
controller)*:

- il **catalogo dei tipi di avviso** come punto di estensione: 8b aggiunge
  le righe «server in difficoltà / non risponde / rientrato» e «diagnosi
  di un server pronta», senza toccare il meccanismo (in 8a il catalogo
  porta già i `monitor.*` esistenti con la loro regola di oggi);
- il **calcolo dei destinatari a lettura** (iscrizioni × permessi);
- gli **ambienti** del progetto (in 8a nella sezione Releases), da cui 8b
  ricava quali server appartengono a un progetto;
- il **permesso nuovo e i preset locali** in `data/viewer.ts` hanno la
  forma che 8a fissa per `support.reply`; 8b aggiunge `servers.operate` e
  `servers.ssh.manage` allo stesso modo;
- le persone del seme aggiunte da 8a per i casi negativi (vedi «Dati
  finti»).

8a non dipende da 8b: lo stato «senza pipeline» legge il commit che
l'agente riporta sull'ambiente di produzione, un dato che il seme ha già
in 8a anche senza la sezione Servers.

## Perché

L'ossatura ha lasciato tre moduli di progetto come segnaposto: Releases,
Support e Servers (`PROJECT_SECTIONS` in
`apps/desktop/src/renderer/data/routes.ts`, voci con `module`; testi in
`placeholder.sections.{releases,support,servers}` di
`i18n/locales/it.json`; accesi di default per il modello `software` in
`domain/templates.ts`). Sul web le stesse cose sono sparse in quattro posti
(coda di rilascio `/release`, Monitor, conversazioni del widget, ambienti e
adozione delle PR nel dettaglio progetto e ticket) e si fermano tutte prima
del punto in cui servirebbero:

1. **Dopo il merge non si sa niente.** La coda di rilascio
   (`apps/server/src/services/release.ts`) finisce col merge; se la pipeline
   fallisce lo scopre chi guarda GitHub.
2. **Un server in difficoltà manda un avviso e basta** (`monitor.alert`):
   qualcuno deve entrare, guardare, capire.
3. **Le PR dei colleghi sono di serie B**: vanno adottate a mano da un
   maintainer (`docs/invariants/pr-corrections.md`, «Adottare una PR aperta
   da altri») prima che Stubwise possa toccarle.
4. **Le richieste dei clienti arrivano mezze vuote**: il widget e il server
   MCP si fermano dopo poche domande (le `instructions` del server MCP dicono
   «di solito bastano tre domande al massimo… se l'utente ha fretta non
   insistere»), e il team deve tornare dal cliente.
5. **Gli avvisi passano da Slack**, che è in dismissione *(maintainer)*:
   l'app (desktop e telefono) lo sostituisce.

## Obiettivi

- **Releases**: le PR aperte (di Stubwise e di chiunque) con la loro analisi,
  la coda di rilascio col merge, e **lo stato del rilascio dopo il merge**
  *(maintainer)*.
- **Rilascio fallito che si ripara da solo, ma sotto controllo**: avviso,
  errore leggibile, spiegazione di Claude, «Fai sistemare a Claude» che apre
  una task normale *(maintainer)*.
- **Iscrizioni agli avvisi per progetto**: un sistema generale, non una
  spunta per i rilasci *(maintainer)*, su cui le altre aree aggiungeranno i
  loro tipi.
- **Support**: richieste dei clienti con un triage completo, la conversazione
  intera allegata, lo stato visibile al cliente e le risposte date da una
  persona dall'app *(maintainer)*.
- **Servers**: avviso → analisi automatica di Claude in sola lettura → task
  con diagnosi e proposta → correzione da task con accesso di correzione
  *(maintainer)*; accessi SSH collegati dall'app in tre passi *(maintainer)*.
- **Ogni PR analizzata**, e corretta da Claude quando serve, anche sul ramo
  di un collega *(maintainer)*.
- **Il bug dell'area 6** «Salvato» con modifiche non salvate *(maintainer)*.

## Non obiettivi

- **Il motore sul server** *(maintainer)*: lettura vera delle run di CI
  (GitHub Actions, Bitbucket Pipelines), SSH vero, agenti veri sul worker,
  push vero sul ramo dei colleghi, push sul telefono vero. È un progetto a
  parte, come per l'area 7; qui si definisce l'interfaccia e il
  comportamento che il motore dovrà rispettare. Vedi «Quanto è vero nel
  prototipo».
- **Lanciare un rilascio** *(maintainer)*: nessun bottone «Deploy», nessun
  «Riprova la pipeline». Il merge resta il confine per i rilasci.
- **La vista complessiva dei server** e le impostazioni d'istanza delle
  notifiche (webhook in uscita): area 9 (Amministrazione), come da ossatura.
- **Slack**: niente DM Slack nelle preferenze; non si porta *(maintainer:
  in dismissione)*.
- **Rispondere al cliente in automatico** *(maintainer)*: Claude prepara solo
  bozze.

## Anti-obiettivi

Ciò che quest'area non deve mai produrre, anche per sbaglio:

1. **Un rilascio partito da Stubwise** *(maintainer)*. Leggere lo stato di
   una pipeline sì; avviarla, rilanciarla o «promuoverla» no.
2. **Un'azione sul server che nessuno ha deciso** *(scelta del controller,
   dalla decisione 11)*. L'analisi automatica gira **solo** con l'accesso di
   sola lettura; l'accesso di correzione si usa **solo** da una task,
   avviato da chi ha `servers.operate`, dopo un piano **sempre** approvato
   *(maintainer)*.
3. **Un segreto che esce** *(scelta del controller)*. Le chiavi SSH private
   non si mostrano mai (nemmeno a chi le ha create), non entrano in un
   prompt, in un worktree, in un log, in una notifica; Claude usa l'accesso
   attraverso uno strumento che esegue il comando, mai leggendo la chiave.
   È la stessa famiglia di «Solo l'ambiente `test` entra in un worktree»
   (CLAUDE.md).
4. **Un commit che riscrive il lavoro di un collega** *(scelta del
   controller, dalla decisione 15)*: mai un force push, mai un rebase, mai
   un push su un ramo protetto, su un fork o sul ramo di destinazione.
5. **Un avviso su ciò che non puoi vedere** *(maintainer)*: le iscrizioni
   sono filtrate dai permessi, e la revoca vale a lettura.

## Invarianti del CLAUDE.md che quest'area cambia DELIBERATAMENTE

Sono decisioni di prodotto nuove, non dettagli implementativi. Quando si
costruirà il motore, il CLAUDE.md e `docs/invariants/` vanno riscritti
**prima** del codice, con queste parole.

### 1. «Stubwise non fa deploy: il merge è il confine (fase 8)»

*(maintainer, decisioni 2 e 13)*

- **Cosa NON cambia.** Per i rilasci il merge resta l'unica azione: nessun
  deploy, nessuna esecuzione di pipeline, nessun riavvio. Lo stato del
  rilascio **legge** (run di CI, commit che l'agente di monitoraggio
  riporta, con la stessa regola `sameCommit` di `release.ts`), e «non ancora
  in produzione» resta un'osservazione, mai qualcosa che Stubwise potrebbe
  rendere vero.
- **Cosa cambia.** Esiste ora **un'azione sull'ambiente**, una sola: la
  **correzione di un problema di un server**, partita da una task, con
  l'accesso SSH di correzione di quel server, avviata da chi ha
  `servers.operate` e con il piano sempre approvato prima. Gli ambienti
  (`project_environments`) smettono di essere «pura anagrafica» solo in
  questo senso: un server collegato può avere un accesso di correzione.
- **Il confine nuovo, scritto per non superarlo «tanto manca poco»**:
  l'accesso di correzione non si usa per rilasciare, aggiornare
  un'immagine, fare il pull di un commit o riavviare servizi come passo di
  un rilascio. Si usa per riportare il server a funzionare come prima,
  secondo la diagnosi della task. Una task di correzione server che
  «rilascia» è un piano da rifiutare; il prompt lo dice, il gate lo
  controlla. Chi collega l'accesso di correzione a un rilascio rompe questa
  frase, non solo il codice.

### 2. «I due divieti dell'operatore» (divieto 2: niente produzione senza `release.merge`)

Il divieto sul **merge** resta identico. Ma la correzione di un server tocca
la produzione, e il divieto 2 si riscrive così *(maintainer, risposta A)*:

> Chi non ha `release.merge` non può mergiare. Un'azione su un server
> (l'unica: la correzione da task) ha **due condizioni, sempre**: chi la
> avvia ha `servers.operate` nel progetto, e il piano di Claude è
> **approvato prima che parta qualunque comando** — anche se chi l'avvia ha
> `plans.approve`. Non esiste la pre-approvazione né il «parte subito» per
> chi ha `plans.approve`: la stessa persona può approvare il piano che ha
> avviato, se ha `plans.approve`, ma deve farlo come gesto esplicito.

È un'eccezione **voluta** alla riga del gate di `jobs.ts` (`needsApproval
= (!plans.approve && !planPreApproved) || requirePlanApproval`): per una
correzione server `requirePlanApproval` è sempre vero e
`planPreApproved` non conta. Con il backend va verificato
**negativamente**, come i due divieti di oggi: senza `servers.operate`
403 e nessun job; con `servers.operate` e `plans.approve`, il job nasce
fermo sul piano e nessun comando parte prima dell'approvazione.

### 3. Correzioni post-PR e adozione (`docs/invariants/pr-corrections.md`)

*(maintainer, decisioni 14 e 15)*

- **Superate**: «Adottare una PR aperta da altri — chi, quale, dove» (non
  c'è più un'adozione: ogni PR su un repository collegato è analizzata e
  correggibile), e nella voce «Una correzione non forza MAI il push» la
  frase «mai il branch di una PR scritta da una persona se non dopo
  un'ADOZIONE esplicita».
- **Restano vere, e valgono anche sulle PR dei colleghi**: niente force push
  e push sempre in avanti; i rami vietati di oggi (fork, fork non
  verificabile, `stubwise/…` di un altro ticket, ramo di default, ramo di
  destinazione, rami protetti con `isProtectedBranch`); la difesa
  fail-closed contro il ciclo che si innesca da sé (gli eventi degli account
  di Stubwise non contano come richieste umane); il contatore dei giri che
  si deriva; «Una correzione non è un piano nuovo».
- **Cambia** «Il ciclo di correzione non si innesca da sé» nel senso di
  prodotto: sulle PR dei colleghi la **prima** correzione parte da sola
  dopo l'analisi, senza che una persona la chieda, salvo che il repository
  sia su «solo analisi» o «spento» o la PR su «Solo analisi». I limiti
  sono in «PR».
- **Un motore solo** *(scelta del controller, E)*: l'analisi di ogni PR, di
  Stubwise o di un collega, è la **review firmata di oggi, estesa** («Le
  review di Stubwise sono FIRMATE», «Il revisore effettivo si risolve in UN
  posto» restano vere); il tetto delle correzioni automatiche vale per
  tutte le PR.

### 4. Le istruzioni del server MCP per i collaboratori

*(maintainer, decisione 5)* La regola «fermati appena il quadro è chiaro
(di solito bastano tre domande al massimo), e se l'utente ha fretta non
insistere» (`instructions` di `@stubwise/mcp`, CLAUDE.md «Modalità
collaboratore») diventa: domande una alla volta **finché** non è chiaro
cosa il cliente vuole ottenere, anche a costo di insistere. La stessa regola
vale per il widget.

### 5. Notifiche: kind nuovi e Slack

Ogni `notification_kind` nuovo porta con sé la regola di rollback già
scritta (non si scende d'immagine sul server finché ne esistono righe) e
la regola dei cambi additivi verso l'app mobile (kind sconosciuti come
`UNKNOWN` via `readerSchema`; campi nuovi mai obbligatori). Il DM Slack
delle preferenze sparisce *(maintainer)*.

## Rilasci

### Cosa si vede *(maintainer per gli stati; forma: scelta del controller)*

Sezione **Releases** del progetto (`#/p/<CODE>/releases`), tre parti
*(maintainer, 28 ott 2026: «una lista, due gruppi»: PR aperte e coda sono
la stessa lista, divisa in «Pronte per il rilascio» e «Non ancora pronte»,
non due viste)*:

1. **PR aperte**: tutte le PR aperte sui repository del progetto, di
   Stubwise e di chiunque, **nella stessa lista e con la stessa forma**
   *(maintainer)*: titolo, autore, repository e numero, task collegata se
   c'è, analisi di Claude (esito in una riga, rischio, problemi trovati),
   controlli della piattaforma, review, «già su» (ambienti). Le PR dei
   colleghi hanno solo un segno «di <nome>», nessun bottone «Adotta».
2. **Pronte per il rilascio** (la coda, primo gruppo della stessa lista:
   non una seconda lista con le stesse PR): le PR che si possono mergiare, con
   **Rilascia** → conferma a due tempi (come sul web) per chi ha
   `release.merge`. Gli errori del web restano tutti (`already_closed`,
   `checks_failed`, `checks_unreadable`, `not_mergeable`, `merge_forbidden`,
   `not_found`).
3. **Rilasci**: i merge recenti (anche quelli fatti fuori da Stubwise, sul
   ramo di rilascio) con il loro stato.

La scheda «Releases» dei Docs (note di rilascio notturne) si rinomina
**«Note di rilascio» / «Release notes»** *(maintainer, 28 ott 2026)*, per
non avere due «Releases» nello stesso progetto.

Più **Ambienti** (come il web: nome, tipo test/staging/produzione, URL,
server collegato, versione che vi gira secondo l'agente; modifica con
`environments.manage`).

La **vista trasversale** dell'ossatura («Release queue → vista trasversale
nella Home per chi può mergiare»): un blocco della Home dal catalogo,
«Rilasci», con le PR pronte nei progetti dove chi guarda ha `release.merge`
e i rilasci falliti che lo riguardano *(scelta del controller)*.

### Lo stato del rilascio *(maintainer)*

Dopo il merge ogni rilascio ha uno stato, con la regola del progetto:

- **Con pipeline** (GitHub Actions o Bitbucket Pipelines; il caso che
  diventerà il più diffuso): **in corso / riuscito / fallito**, con il link
  alla run. Se il merge avvia più run, il rilascio è «fallito» se una
  fallisce, «in corso» finché una gira, «riuscito» quando tutte sono
  riuscite; il dettaglio le elenca una per una *(scelta del controller)*.
- **Senza pipeline**: **«non ancora in produzione»** finché il commit del
  merge non compare sul server dell'ambiente di produzione secondo l'agente
  di monitoraggio, poi **«in produzione»** con l'ora in cui è comparso. Il
  server si legge dall'**ambiente di produzione** del progetto (ambiente →
  server collegato, come sul web) *(scelta del controller, D)*.
  Senza ambiente di produzione collegato a un server: «stato non
  disponibile», con il perché e, per chi ha `environments.manage`, il link
  agli ambienti *(scelta del controller)*.

Quali run contano *(scelta del controller)*: per ogni repository, in
Settings → repository (chi ha `repos.manage`), «Pipeline di rilascio»:
**automatica** (tutte le run avviate dal commit del merge sul ramo di
rilascio) oppure un elenco di workflow/pipeline scelti per nome. Il ramo di
rilascio è il ramo di default, modificabile lì. Senza run lette entro un
tempo ragionevole il progetto è trattato come «senza pipeline».

Chi vede lo stato: chi vede la PR (membri del progetto). Il **log
dell'errore** di una run lo vede chi ha `repos.view` *(scelta del
controller: i log di CI possono contenere più dettagli del codice)*.

### Rilascio fallito *(maintainer)*

- **Chi è avvisato**: chi ha fatto il merge, **sempre**, senza iscrizione;
  più chi è iscritto a «rilascio fallito» nel progetto. Se il merge è stato
  fatto fuori da Stubwise, «chi ha fatto il merge» è la persona collegata
  all'identità git che ha mergiato; se non è collegata a nessuno, l'avviso
  obbligatorio va all'autore della task collegata, se c'è *(scelta del
  controller)*.
- **Dall'avviso** si apre il dettaglio del rilascio: la run fallita, il
  passo che è fallito, le ultime righe del log (con «vedi tutto» e il link
  alla piattaforma).
- **«Chiedi a Claude di spiegarlo»**: apre una conversazione nella
  destinazione Claude (area 3) con il rilascio come oggetto di contesto (PR,
  diff, log della run); è una conversazione di chi la apre, con le regole di
  privacy dell'area 3 *(scelta del controller)*.
- **«Fai sistemare a Claude»** *(maintainer)*: crea una **task** (tipo
  `bug`) nel progetto, collegata alla PR originale (e con un collegamento
  «correlata» alla task della PR, se c'era), con l'errore della run
  allegato (passo, log essenziale, link). Segue il **percorso normale**:
  piano, gate di approvazione per chi non ha `plans.approve`, PR. Stessi
  controlli di una task normale: serve `tickets.create` per crearla e
  `runs.start` per far partire Claude; chi ha solo il primo crea la task e
  la vede aspettare qualcuno che la avvii *(scelta del controller)*. Il
  merge della correzione produce un **nuovo rilascio** col suo stato.
- **Un rilascio fallito ha al massimo una task di riparazione aperta**: un
  secondo clic apre quella esistente *(scelta del controller)*.

## Notifiche: iscrizioni per progetto *(maintainer)*

### Il modello

- **Un catalogo di tipi di avviso**, ciascuno con: il nome in parole, il
  **permesso** che serve per iscriversi (non ti iscrivi a ciò che non puoi
  vedere), il valore di partenza, ed eventuali **destinatari obbligatori**
  (chi lo riceve senza iscrizione). Le aree successive aggiungono righe al
  catalogo, non meccanismi nuovi.
- **Un'iscrizione** = persona × progetto × tipo, accesa o spenta, con due
  canali: **App** (pannello notifiche e notifica di sistema del desktop) e
  **Telefono** (push dell'app mobile) *(scelta del controller: telefono per
  tipo, perché «rilascio riuscito» sul telefono è rumore e «server non
  risponde» no)*.
- **Destinatari calcolati a lettura** *(scelta del controller, F)*: un
  avviso non porta `recipientIds` fissi (oggi `AppNotification.recipientIds`
  in `data/model.ts`, che per i tipi del catalogo smette di decidere); chi
  lo riceve si calcola quando l'avviso si legge, da iscrizioni, destinatari
  obbligatori e permessi di adesso. Stessa forma di «La revoca si applica a
  lettura» (`docs/invariants/permissions.md`): chi perde il permesso smette
  di vedere anche gli avvisi già arrivati, senza che l'iscrizione si
  cancelli; se lo riacquista, riprende. La pagina mostra l'iscrizione come
  «sospesa: non vedi più …».
- **Spegnere vale solo per il futuro** *(scelta del controller, F)*: un
  avviso già ricevuto resta nel pannello di chi l'ha ricevuto anche dopo
  che ha spento l'iscrizione. Per farlo, a lettura conta lo stato
  dell'iscrizione **al momento dell'avviso** (l'iscrizione tiene la storia
  delle sue accensioni e spegnimenti), mentre i permessi contano **adesso**.
- **Letto, archiviato e posticipato per persona** *(scelta del controller,
  28 ott)*: con i destinatari calcolati, lo stato di una notifica non sta più
  sulla riga (oggi un flag unico, condiviso fra i destinatari) ma per persona
  (`notificationMarks` nel prototipo): che Laura la legga non la segna letta
  per Marco.
- **Decisioni ≠ avvisi** (ossatura): ciò che chiede una decisione (piano da
  approvare, domanda di Claude) va nel «Da decidere» di chi deve decidere,
  non passa dalle iscrizioni (`DECISION_NOTIFICATION_KINDS` in
  `data/seed/notifications.ts` resta com'è).

### Il catalogo di partenza *(maintainer per i tipi nominati; permessi e default: scelta del controller)*

| Tipo | Permesso per iscriversi | Default | Obbligatorio per |
|---|---|---|---|
| Nuova PR (di Stubwise o di altri) | membro | spento | — |
| Analisi di una PR con problemi | `repos.view` | acceso per chi ha `release.merge` | l'autore della PR |
| Claude ha corretto la tua PR | — | — | l'autore della PR, sempre |
| Nuovo rilascio (merge) | membro | spento | — |
| Rilascio riuscito / in produzione | membro | spento | — |
| Rilascio fallito | membro | acceso per chi ha `release.merge` | chi ha fatto il merge |
| Nuova nota di rilascio (Docs) | `docs.view` | spento | — |
| Nuova task | `tickets.view_all` | spento | — |
| Nuova richiesta di un cliente | `backlog.view_all` | acceso per chi ha `backlog.edit` | — |
| Il cliente ha risposto | `support.reply` | acceso per chi ha `support.reply` | chi segue quella conversazione |
| Server in difficoltà / non risponde / rientrato (8b) | membro, server dell'ambiente di produzione del progetto | acceso per chi ha `servers.operate` | — |
| Diagnosi di un server pronta (task aperta) (8b) | membro, come sopra | acceso per chi ha `servers.operate` | — |

I tipi già esistenti dell'inbox (`job.pr_opened`, `review.completed`,
`job.failed`, `project.brief`, `docs.nightly_attention`, `monitor.*`,
`ticket.created`, `request.created`) entrano nel catalogo con la loro
regola di destinatari di oggi come default, così il passaggio non cambia ciò
che ognuno riceve finché non tocca qualcosa *(scelta del controller)*.
`security.alert` resta fuori: ignora le preferenze e va solo
all'interessato (`docs/invariants/second-factor.md`).

### Dove si gestisce *(scelta del controller)*

- **Preferenze → Notifiche** (`#/preferences`, oggi `Placeholder`): la
  pagina personale con tutte le iscrizioni, raggruppate per progetto (i
  progetti fissati prima), una riga per tipo con App/Telefono; azioni in
  blocco «come questo progetto» e «spegni tutto per questo progetto». Il
  resto delle Preferenze (account, sicurezza, lingua…) resta segnaposto
  fino alla sua area: si costruisce solo la cornice e la sezione Notifiche.
- **Scorciatoia dal progetto**: un controllo «Avvisi» nella testata del
  progetto apre un popover con le iscrizioni di quel progetto e il link alla
  pagina intera.
- Dal pannello notifiche, su ogni avviso: «Non avvisarmi più di questo in
  <progetto>», che spegne quell'iscrizione per gli avvisi futuri (con
  Annulla; l'avviso su cui si è cliccato resta). Non c'è per gli
  avvisi obbligatori, che lo dicono («ricevi questo perché hai fatto il
  merge»).

## Support e richieste dei clienti

### Il triage *(maintainer, decisione 5)*

Ogni canale da cui un cliente apre richieste (**widget**, **server
MCP/plugin**, altri futuri) fa un triage completo: domande **una alla
volta** finché il cliente non ha spiegato bene **cosa vuole ottenere**,
anche a costo di insistere. Il triage risponde anche, come oggi, alle
domande che la documentazione copre: se la risposta basta, non si apre
niente.

*(scelta del controller)* Prima di aprire, il canale mostra al cliente il
desiderio riscritto e chiede «è questo?»; il cliente può correggerlo. Se il
cliente se ne va prima, non si apre nessuna richiesta: la conversazione
resta in Support come «non conclusa», e una persona del team può aprire la
richiesta a mano da lì.

### Cosa contiene una richiesta *(maintainer, decisione 6)*

- Il **desiderio riscritto** in modo chiaro (il titolo e la descrizione).
- La **conversazione completa** che ha portato lì, allegata e leggibile
  dalla richiesta.
- **Non** un design né un piano. Trasformarla in piano è di chi ha
  `backlog.edit`, nella **sessione dedicata** di refine che il desktop ha
  già (area 2, «Rifinisci con Claude», `RefineView.tsx`).
- Il canale di provenienza e il cliente (identità dichiarata dal widget o
  utente del token MCP).

Per il server MCP *(scelta del controller)*: `create_backlog_item` riceve
in più la conversazione (campo nuovo, facoltativo: cambio additivo), e
l'istruzione dice all'utente che la conversazione verrà allegata.

### Le email *(maintainer, decisione 7)*

- **Una richiesta non nasce MAI da un'email, né in automatico né a mano**
  *(decisione del maintainer, 28 ott 2026: era la sua intenzione fin
  dall'inizio; la scelta del controller che permetteva di crearla a mano
  dalla Posta è tolta)*. Le richieste nascono solo dai canali col triage
  (widget, plugin/MCP e simili). Non esistono l'azione «Crea richiesta»
  nella Posta, una funzione del livello dati che la crei da un thread, un
  canale «Email» in Support né una provenienza «da un'email».
- **Eccezione che resta: le proposte della Posta dell'area 6** *(decisione
  del maintainer, 28 ott 2026)*. La proposta di Claude «Crea richiesta in
  <progetto>» su un'email, che una persona conferma, resta com'è: è una
  proposta confermata, non una richiesta di un cliente aperta da Support.
  Quest'area non la tocca.

### Cosa vede il cliente e come gli si risponde *(maintainer, decisione 8)*

- Il cliente vede lo **stato della sua richiesta** dove l'ha aperta, e si
  aggiorna da solo (nel widget, con lo stesso canale SSE di oggi; nel MCP,
  con `my_requests`). Stati in parole *(scelta del controller)*: ricevuta →
  in valutazione → pianificata → in lavorazione → rilasciata, oppure «non
  procediamo», ricavati dallo stato della richiesta e delle task che ne
  nascono (rilasciata = rilascio riuscito o in produzione della PR).
  Il cliente non vede mai commenti interni, persone, stime.
- **Si risponde dall'app**: la sezione Support mostra le conversazioni e
  chi ha `support.reply` scrive la risposta, che arriva al cliente nel
  canale da cui ha scritto.
- **Nessuna risposta automatica**: Claude prepara una **bozza** (come la
  bozza della Posta, area 6), una persona la rilegge e la invia. Un cliente
  che ha lasciato un indirizzo si raggiunge dalla Posta con «Scrivigli
  anche per email» (qui sotto).
- **Il cliente che non è più sul sito** vede la risposta quando torna
  *(maintainer, risposta H)*. **Nessuna email automatica**, nemmeno un
  semplice avviso «hai una risposta». Se serve, il team manda a mano
  un'email dalla Posta, partendo da una bozza preparata da Claude
  (nel dettaglio della conversazione: «Scrivigli anche per email», che apre
  il compositore dell'area 6 con la bozza, se il cliente ha lasciato un
  indirizzo).

### La sezione Support *(forma: scelta del controller)*

`#/p/<CODE>/support`: elenco delle conversazioni (canale, cliente, ultimo
messaggio, stato: in triage, richiesta aperta, aspetta una risposta da noi,
non conclusa), dettaglio con la conversazione, la richiesta nata e il
compositore della risposta con «Bozza di Claude». In alto, per chi ha
`widget.manage`, «Widget»: l'elenco dei widget del progetto come sul web
(nuovo, modifica, snippet da incollare, guida, elimina). Un blocco della
Home dal catalogo, «Clienti in attesa», per chi ha `support.reply`.

## Server

### L'avviso *(maintainer, decisione 9)*

Un problema su un server (soglie dell'agente: CPU, memoria, disco
prolungati; controlli http/tcp/processo/database giù; agente muto) arriva
come avviso nell'app e sul telefono, dentro le iscrizioni dei progetti a
cui il server è collegato.

**Come un server appartiene a un progetto** *(scelta del controller, D)*:
attraverso gli **ambienti**, come sul web (ambiente → server collegato).
L'iscrizione «server del progetto» e lo stato «senza pipeline» dei rilasci
leggono l'**ambiente di produzione**; un server collegato solo a un
ambiente di test o staging compare nella sezione Servers ma non manda gli
avvisi del catalogo.

### L'analisi automatica *(maintainer, decisione 10)*

- All'avviso parte **da solo** un agente Claude che entra nel server via SSH
  con l'accesso **di sola lettura**, analizza (log, processi, disco,
  memoria, container) e, appena ha identificato il problema, **apre una
  task** con ciò che ha trovato e cosa suggerisce di fare.
- *(scelte del controller)*:
  - **Un'analisi per episodio** (dall'allarme al rientro); un secondo
    allarme sullo stesso server durante l'analisi si aggiunge a quella.
  - Se il server rientra durante l'analisi, l'analisi finisce lo stesso e
    la task lo dice («rientrato alle 14:32»).
  - **Senza accesso di lettura collegato** niente analisi: l'avviso lo dice
    e, a chi ha `servers.ssh.manage`, offre «Collega l'accesso SSH».
  - **Server irraggiungibile via SSH**: la task si apre comunque, con
    «non raggiungibile» e cosa è stato provato.
  - **In quale progetto**: nel progetto il cui ambiente di produzione usa
    il server (D). Se sono più d'uno, nel **progetto principale** del
    server (il primo fra quelli, modificabile da chi ha `monitor.manage`);
    gli altri la vedono collegata dalla sezione Servers.
  - La task è `bug`, senza incaricato, con la sorgente «server» (valore
    nuovo di `TaskSource`) e il server collegato. La sessione dell'analisi
    compare nella destinazione Claude (un `ConversationKind` nuovo).
  - Un tetto di durata e di costo per analisi, con valori sensati scelti
    dal costruttore.

### La correzione *(maintainer, decisione 11 e risposta A)*

- Dalla task si fa partire Claude **per risolvere il problema nel modo
  indicato nella task**, con l'**accesso di correzione**: comandi **liberi**
  sul server, senza approvazione dei singoli comandi.
- **Due condizioni, sempre** *(maintainer)*:
  1. **avviarla** richiede il permesso nuovo **`servers.operate`** nel
     progetto della task (vedi «Permessi»); `runs.start` da solo non basta,
     e su una task di server il normale «Avvia» di Claude (`runs.start`)
     non usa mai l'accesso di correzione;
  2. il **piano di Claude è sempre approvato prima che parta un comando**,
     anche se chi l'avvia ha `plans.approve`. Niente pre-approvazione,
     niente partenza diretta. Può approvarlo la stessa persona che l'ha
     avviata, se ha `plans.approve`, con il gesto esplicito «Approva il
     piano»; altrimenti lo approva chi ha `plans.approve` nel progetto.
     Approvato il piano, i comandi non si approvano uno per uno.
- **Stati della task di server** *(scelta del controller per i nomi)*:
  diagnosi pronta → correzione avviata, piano in scrittura (sola lettura)
  → **piano da approvare** (sempre; il «Da decidere» di chi ha
  `plans.approve`, compreso chi l'ha avviata) → piano rifiutato (con
  indicazioni; si può riavviare) → **correzione in corso** (comandi nel
  registro) → fermata (da una persona) → correzione finita, controllo in
  sola lettura: risolto / non risolto → task chiusa da una persona. Un
  accesso di correzione revocato o non più verificato mentre il piano
  aspetta: il piano resta, l'approvazione è spenta con il motivo.
- **Ogni comando eseguito resta nel registro della task** (comando, ora,
  esito, uscita troncata), nella sezione Claude della task, come i passi di
  un lavoro. Si può **fermare** come ogni sessione (area 3).
- *(scelte del controller)*: l'avvio c'è solo se il server ha un accesso di
  correzione verificato e la task è legata a quel server; Claude usa
  l'accesso solo su quel server; il prompt vieta azioni da rilascio (vedi
  l'invariante 1); finito il lavoro, Claude rilancia un controllo in sola
  lettura e scrive nella task se il problema è sparito.

### Gli accessi SSH *(maintainer, decisione 12)*

Due accessi per server, **lettura** e **correzione**, configurabili
dall'app nella sezione Servers (dettaglio del server → «Accesso SSH»):

1. **«Collega l'accesso SSH»** → l'app genera le due coppie di chiavi. Le
   chiavi private sono segrete, cifrate, **mai più mostrate**.
2. Mostra **un solo comando** da incollare sul server, che crea due utenti
   e autorizza le chiavi:
   - `stubwise-read`: sola lettura di log, processi, disco, memoria;
   - `stubwise-fix`: l'utente di correzione.
3. **«Verifica»** prova i due accessi e dice cosa funziona.

Poi: **Rigenera** (chiavi nuove, comando nuovo; le vecchie restano valide
finché la verifica delle nuove non riesce), **Revoca** (Stubwise dimentica
le chiavi e mostra il comando che rimuove i due utenti dal server), **ultimo
uso** di ciascun accesso (quando e da quale task o analisi).

*(scelte del controller sul comando e sugli utenti)*:

- Il comando è **leggibile**: uno script con le chiavi pubbliche dentro,
  niente `curl | sh` da un indirizzo esterno; chi lo incolla vede cosa fa.
- Le chiavi autorizzate hanno le restrizioni di `authorized_keys`
  (`no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`, e
  `from=` sull'indirizzo dell'istanza se noto).
- `stubwise-read` **non** entra nel gruppo `docker` (equivale a root): legge
  log e container con regole `sudo` limitate a comandi di lettura elencati
  (`journalctl`, `docker ps`, `docker logs`, `docker stats`, `df`, `free`,
  `ps`…). **Escluso `docker inspect`**, che mostra le variabili d'ambiente
  dei container.
- `stubwise-fix` ha `sudo` senza password: «comandi liberi» vuol dire
  questo, e la UI lo scrive accanto al comando («questo utente può fare
  tutto sul server»).
- **Verifica** controlla anche il contrario: che `stubwise-read` **non**
  possa scrivere (es. `sudo -n true` fallisce). Un accesso di lettura che
  scrive è un errore, non un successo.

## PR *(maintainer, decisioni 14 e 15)*

- **Nessun bottone «Adotta».** Ogni PR aperta su un repository collegato,
  chiunque l'abbia aperta, è **analizzata automaticamente** da Claude e
  compare nel progetto e nella coda dei rilasci come quelle di Stubwise, con
  l'analisi. L'analisi si rifà a ogni nuovo commit in testa alla PR.
- **Un motore solo** *(scelta del controller, E)*: l'analisi è la review
  firmata di oggi, estesa a tutte le PR; il tetto delle correzioni
  automatiche vale per tutte, di Stubwise e dei colleghi. Le due liste
  hanno davvero la stessa forma: cambiano solo l'autore e le regole dei
  rami vietati.

### Due livelli di regolazione *(maintainer, risposta C)*

- **Per repository** (Settings → repository, chi ha `repos.manage`), per
  le PR dei colleghi: **«Analisi e correzioni»** (default), **«Solo
  analisi»**, **«Spento»** (nessuna analisi: la PR compare nella lista e
  nella coda senza analisi, con «analisi spenta per questo repository»).
  Le PR aperte da Stubwise seguono la review di oggi e non dipendono da
  questa scelta *(scelta del controller)*.
- **Sulla singola PR**: **«Solo analisi»**, che può dire l'autore della PR
  (se è una persona di Stubwise) o chi ha `prs.adopt` (sotto). Vale solo
  restringendo: su un repository «Spento» non si riaccende una PR.
- **Una PR di un collega non diventa una task** *(scelta del controller)*:
  vive nella sezione Releases come PR. Se il collega l'ha collegata a una
  task (nome del ramo o riferimento), si vede lì.
- Se l'analisi trova problemi, **Claude può correggere direttamente sul
  ramo del collega** con un commit sopra.

### I limiti *(scelta del controller)*

1. **Tetto di giri** *(scelta del controller, 28 ott: un solo tetto, quello del progetto)*:
   le correzioni automatiche si fermano al **`correctionCap` del progetto**
   (lo stesso numero di oggi, default 3), per **ogni** PR (E), di Stubwise e
   dei colleghi; i nuovi commit dell'autore non azzerano il conto, o il
   costo non avrebbe fine. Oltre il tetto va solo una persona con
   `plans.approve` («Il budget di una correzione lo scavalca solo chi ha
   `plans.approve`»). Nessun tetto fisso separato.
2. **Niente force push, niente rebase**: un commit sopra, push in avanti.
3. **Se l'autore spinge in parallelo**: il push di Claude è rifiutato, la
   correzione si **scarta** (nessun tentativo di unire), e l'analisi riparte
   sulla nuova testa; il giro scartato non conta nel tetto.
4. **Rami vietati** come oggi: fork (analizzati, mai corretti), rami
   protetti, ramo di default e di destinazione, rami `stubwise/…` di altre
   task. Su questi l'analisi resta, con «Claude non può correggere qui:
   <motivo>».
5. **L'autore è sempre avvisato** quando Claude spinge sul suo ramo
   (avviso obbligatorio), con il commit e il perché; e il commit porta un
   commento sulla PR (template, mai prosa libera nella firma).
6. **«Solo analisi»** (del repository o della PR): da lì Claude non spinge
   più su quella PR; una correzione già in volo si ferma prima del push.
7. **Nessun gate di piano** per queste correzioni: restano «una correzione
   non è un piano nuovo».

### Permesso

`prs.adopt` non ha più un'adozione da proteggere. *(scelta del
controller)* Si tiene la chiave (nessuna migrazione dei ruoli) e cambia
etichetta e significato: «Gestire le correzioni sulle PR di altri»
(accendere/spegnere «Solo analisi» su una PR, chiedere una correzione
oltre il giro automatico su una PR altrui). La scelta per repository è di
`repos.manage`. Preset invariati: Project Lead e
Developer sì, Legacy Member no.

## Permessi

| Permesso | Livello | Cosa | Preset |
|---|---|---|---|
| `release.merge` | progetto | Rilascia (merge), invariato | invariato |
| `repos.view` | progetto | Leggere il log di una run fallita | invariato |
| `environments.manage` | progetto | Ambienti, invariato | invariato |
| `tickets.create` + `runs.start` | progetto | «Fai sistemare a Claude» | invariati |
| `plans.approve` | progetto | Approvare il piano della correzione di un server (sempre richiesto, anche al proprio) | invariato |
| **`servers.operate`** (nuovo, 8b) | progetto | Avviare la correzione di un server da una task (accesso di correzione) | nessun preset di progetto; implicito per il full admin |
| `repos.manage` | progetto | Analisi e correzioni delle PR altrui per repository | invariato |
| `prs.adopt` (etichetta nuova) | progetto | Correzioni sulle PR di altri, vedi sopra | invariato |
| **`support.reply`** (nuovo) | progetto | Rispondere ai clienti, vedere le bozze di Claude | Project Lead, Developer, Legacy Member |
| `widget.manage` | progetto | I widget del progetto, invariato | invariato |
| `backlog.edit` | progetto | Trasformare una richiesta in piano (refine), invariato | invariato |
| `monitor.manage` | istanza | Server, chiave dell'agente, soglie, controlli, progetto principale | invariato |
| **`servers.ssh.manage`** (nuovo) | istanza | Collegare, verificare, rigenerare, revocare gli accessi SSH | Admin |

*(scelte del controller)*:

- `servers.ssh.manage` è **d'istanza** perché un server è un oggetto
  d'istanza collegato a più progetti, e **separato** da `monitor.manage`:
  chi installa l'agente non ottiene per questo la possibilità di dare a
  Claude la root di un server.
- `servers.operate` *(maintainer: un permesso apposito; nome e posto:
  scelta del controller)* è **di progetto** (il server si lega al progetto
  attraverso l'ambiente di produzione, e la task da cui parte la
  correzione è del progetto) e si assegna **a persona nel progetto**, come
  i ruoli: Progetto → Settings → Membri, aggiungendolo al ruolo di quella
  persona o con un ruolo personalizzato. **Nessun preset di progetto lo
  contiene** (né Project Lead né Developer): dare a qualcuno la possibilità
  di far eseguire comandi liberi su un server di produzione è una scelta
  persona per persona, non un effetto di un ruolo. Il full admin ce l'ha
  implicito, come ogni permesso di progetto. Non basta da solo: il piano va
  comunque approvato.
- La sezione **Servers** di un progetto la vedono i membri (come la sezione
  server del dettaglio progetto sul web): stato, grafici, servizi, dischi,
  controlli. Lo stato degli accessi SSH (collegato, verificato, ultimo uso)
  lo vedono tutti quelli che vedono il server; le azioni solo
  `servers.ssh.manage`.
- Le **conversazioni di Support** le vedono i membri del progetto; scrivere
  al cliente vuole `support.reply`.
- I tre permessi nuovi nascono **locali al prototipo** (`LocalProjectPermission`
  / `LocalInstancePermission` in `data/types.ts`, preset in `data/viewer.ts`
  come `automations.manage` dell'area 7) ed entrano nel registro di
  `@stubwise/shared` col backend.

## Quanto è vero nel prototipo *(maintainer: interfaccia con dati finti; forma: scelta del controller)*

| Cosa | Nel prototipo | Nel motore (progetto a parte) |
|---|---|---|
| Run di CI e stato del rilascio | Run del seme; nel dettaglio del rilascio «Simula esito» (in corso → riuscito/fallito) e «Simula comparsa sul server» | Lettura delle run da GitHub/Bitbucket, webhook, campioni dell'agente |
| Log della run | Testo finto del seme | Log vero, troncato, con i segreti mascherati dalla piattaforma |
| Analisi delle PR e correzioni | Esiti deterministici del seme; «Simula push dell'autore» per il caso del rifiuto | Agente sul worker, push vero sul ramo |
| Accessi SSH | Chiavi finte («generate dal prototipo»), comando vero nella forma ma con chiavi finte, «Verifica» con esito scelto («Simula: riesce / fallisce lettura / lettura scrive») | Generazione e cifratura delle chiavi, SSH vero |
| Analisi e correzione del server | Sessione scritta (`data/conversation-scripts.ts`), stesso streaming dell'area 3; comandi e uscite finti | Agente vero, strumento di esecuzione via SSH |
| Avvisi al telefono | La riga «Telefono» si salva; un'etichetta dice che sul prototipo non parte nulla | Push relay esistente (`apps/push-relay`) |
| Notifiche di sistema del desktop | Notifica di sistema vera di Electron, se il builder la aggiunge senza toccare la sicurezza del processo principale; altrimenti solo il pannello | — |
| Widget e cliente | «Anteprima del cliente» nel dettaglio della conversazione: cosa vede il cliente adesso; «Simula un messaggio del cliente» | Widget vero (`packages/widget`), SSE |

Tutto ciò che è «Simula …» esiste solo nel prototipo e lo dice.

## Codici *(scelta del controller)*

- PR: `owner/repo#<n>` (com'è già in `PrRef`).
- Rilascio: `<PRJ>-V<n>`, numerato per progetto, stabile.
- Conversazione di Support: `<PRJ>-S<n>`.
- Server: `SRV-<n>` (già prefisso degli eventi in
  `data/seed/notifications.ts`, `EVENT_PREFIXES`).
- Codici scritti a mano diventano link se visibili; nascosto e inesistente
  sono identici (R-G5).

## Stati

Ogni pagina: caricamento, vuoto, errore con «Riprova», pieno, senza
permessi (nascosto e inesistente identici). In più:

- **Rilascio**: in corso, riuscito, fallito, non ancora in produzione, in
  produzione, stato non disponibile (col perché), task di riparazione aperta.
- **PR**: in analisi, analizzata senza problemi, con problemi, correzione in
  corso, corretta da Claude, correzione scartata (push dell'autore), tetto
  raggiunto, solo analisi, non correggibile (motivo).
- **Accesso SSH**: non collegato, in attesa del comando, verificato,
  verifica fallita (quale e perché), lettura che scrive (errore), da
  rigenerare, revocato.
- **Server**: in salute, in difficoltà, non risponde, rientrato, analisi in
  corso, diagnosi pronta, correzione in corso.
- **Task di server**: gli stati della sezione «La correzione» (piano da
  approvare sempre presente fra avvio e primo comando).
- **Repository** (PR dei colleghi): analisi e correzioni, solo analisi,
  spento.
- **Conversazione di Support**: in triage, richiesta aperta, aspetta noi,
  risposta inviata, non conclusa.
- **Iscrizione**: accesa, spenta, sospesa (permesso perso), obbligatoria.

## Dati finti *(scelta del controller)*

Su AUD e STW (software, membri scritti a mano in `data/seed/projects.ts`) e
ACQ (che ha già l'allarme `SRV-1`):

- AUD: una PR di Stubwise pronta per il rilascio; un rilascio **riuscito**
  con GitHub Actions; un rilascio **fallito** mergiato da Laura, con log e
  avviso; una PR di **Marco aperta fuori da Stubwise** con problemi e una
  correzione di Claude sopra; una PR da **fork** analizzata e non
  correggibile; una PR in «tetto raggiunto».
- STW: senza pipeline; un rilascio «non ancora in produzione» e uno «in
  produzione» secondo l'agente.
- ACQ: `SRV-1` con accesso SSH verificato, l'allarme memoria già nel seme →
  analisi finita → task con diagnosi; un secondo server senza accesso SSH
  collegato.
- Support su ACQ: una conversazione del widget in triage, una con richiesta
  aperta che aspetta una nostra risposta (con bozza di Claude), una non
  conclusa; una richiesta nata dal server MCP con la conversazione.
- Iscrizioni di partenza secondo i default del catalogo.
- **«Vedi come»** (`data/viewer.ts`): Laura (Project Lead AUD: merge,
  approva, ma non `servers.ssh.manage`), Marco (Developer: avvia senza
  `plans.approve` → gate; autore della PR corretta), Sara (Contributor: vede
  poco, non risponde ai clienti), Roberta (admin: `servers.ssh.manage`),
  Matteo (Project Lead senza ruoli tecnici, per gli avvisi).
- **Membership e persone del seme** *(scelta del controller, G)*: toccare
  le membership del seme (`data/seed/projects.ts`, `REFERENCE_MEMBERS`) è
  lecito, purché i test delle aree 2–7 restino verdi. Si aggiungono le
  persone che servono ai casi negativi, ad esempio: su ACQ un membro
  **senza `support.reply`** (Contributor o Viewer) e uno **con**; su ACQ
  qualcuno con `servers.operate` **senza** `plans.approve` (avvia, non
  approva) e un Project Lead **senza** `servers.operate` (approva, non
  avvia); un repository di AUD su «Solo analisi» e uno su «Spento».
  `servers.operate` si concede nel seme come le concessioni di
  `data/seed/grants.ts`, ma per progetto.

## Bug dell'area 6: «Salvato» con modifiche non salvate *(maintainer, trovato il 28 ott 2026)*

Nel compositore della Posta (`pages/mail/Composer.tsx`, stato da
`pages/mail/useComposerDraft.ts`) «Salvato» resta visibile mentre ci sono
modifiche non ancora salvate. Due cause, entrambe in `useComposerDraft.ts`:

1. `setFields` segna `dirty` e programma il salvataggio, ma **non tocca
   `status`**: dopo il primo salvataggio, ogni modifica successiva lascia
   «Salvato» per tutto l'intervallo prima del salvataggio automatico.
2. `saveNow` porta `status` a `"saved"` alla fine della mutazione anche se
   nel frattempo è arrivata un'altra modifica (`dirty` di nuovo vero).

Correzione attesa: una modifica riporta lo stato a «non salvato» (nessuna
etichetta, o «Modifiche non salvate», scelta del costruttore); a fine
salvataggio «Salvato» solo se non è arrivato nulla di nuovo. Test: modifica
dopo un salvataggio → niente «Salvato» finché il nuovo salvataggio non
finisce; modifica durante un salvataggio → niente «Salvato» al suo termine.

## Parità con il web

Si portano (tabella da scrivere in `apps/desktop/docs/area8-parity.md`, come
`area6-parity.md`): coda di rilascio con tutti i suoi esiti; ambienti;
widget (elenco, modifica, snippet, guida); conversazioni del widget; server
del progetto con grafici, servizi, dischi, controlli, soglie,
impostazioni, nuovo server e chiave dell'agente (per `monitor.manage`).
**Non si portano, di proposito**: l'adozione delle PR (sostituita, decisione
14) e il DM Slack nelle preferenze (decisione 4). La vista complessiva dei
server resta all'area 9.

## Lasciato al costruttore

- Forma visiva della sezione Releases (tre parti in una pagina o a schede),
  del dettaglio di un rilascio, della pagina Notifiche (shape Impeccable).
- Come si legge un log lungo (troncamento, «vedi tutto», ricerca).
- Il testo dei prompt di analisi PR, analisi server, correzione server e
  triage, e il tono delle bozze ai clienti.
- I valori dei limiti (durata e costo di un'analisi, uscita troncata dei
  comandi, tempo dopo cui un progetto senza run è «senza pipeline»).
- L'elenco esatto dei comandi di lettura ammessi a `stubwise-read` e la
  forma dello script da incollare, nel rispetto delle scelte sopra.
- Scorciatoie da tastiera, voci di ⌘K (rilasci, conversazioni, server per
  codice; azioni «Collega l'accesso SSH», «Preferenze notifiche»).

## Review Focus

Dove chi rivede il piano e poi il codice deve guardare per primo:

1. **L'accesso di correzione** si raggiunge **solo** da una task legata al
   server, avviata da chi ha `servers.operate`, con il piano approvato
   **sempre** prima del primo comando: nessun altro percorso (analisi
   automatica, «Avvia» con `runs.start`, automazioni dell'area 7, «Fai
   sistemare a Claude» di un rilascio, conversazione libera) lo usa. Test
   negativi che asseriscono sullo stato (nessuna sessione, nessun comando
   nel registro), non solo sul bottone nascosto:
   - senza `servers.operate` (anche con `runs.start` e `plans.approve`):
     l'avvio è rifiutato e non nasce niente;
   - con `servers.operate` **e** `plans.approve`: la correzione si ferma
     comunque su «piano da approvare», zero comandi finché non approva;
   - con `servers.operate` senza `plans.approve`: non può approvare il
     proprio piano;
   - una pre-approvazione del piano sulla task non lo salta;
   - accesso revocato mentre il piano aspetta: approvazione spenta, zero
     comandi.
2. **Le chiavi private**: generate, cifrate, mai restituite da nessuna
   lettura del livello dati, mai in un prompt, in un registro, in una
   notifica. Il comando mostra solo chiavi pubbliche.
3. **`stubwise-read` è davvero di sola lettura** (niente gruppo `docker`,
   niente `docker inspect`, verifica al contrario).
4. **Nessun bottone, comando o passo d'automazione avvia un rilascio**.
5. **Correzioni sulle PR**: un motore solo e un tetto per tutte; tetto per
   PR che non si azzera, push rifiutato → correzione scartata senza
   rebase, rami vietati e fork, avviso obbligatorio all'autore; «Solo
   analisi» e «Spento» del repository e «Solo analisi» della PR rispettati
   sotto lock (anche da una correzione in volo).
6. **Destinatari calcolati a lettura** da iscrizioni e permessi, senza
   `recipientIds` fissi; avvisi obbligatori che arrivano anche a
   iscrizione spenta; spegnere non toglie gli avvisi già ricevuti; nessun
   avviso di un progetto invisibile.
7. **Il cliente vede solo il suo**: stati in parole, mai commenti interni;
   nessuna risposta parte senza il clic di una persona con `support.reply`;
   nessuna email automatica al cliente, nemmeno di solo avviso.
8. **Il bug del compositore** coperto dai due test sopra.
9. Le **invarianti cambiate** (sezione apposita) riscritte in CLAUDE.md e
   `docs/invariants/` prima del codice del motore.

## Domande aperte per il maintainer

Nessuna (28 ott 2026): le tre domande della prima stesura hanno avuto
risposta (A: `servers.operate` e piano sempre approvato; H: nessuna email
automatica al cliente; C: regolazione per repository e per PR).
