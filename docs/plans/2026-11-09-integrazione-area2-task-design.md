# Integrazione dell'area 2 (task) — dall'app prototipo all'app vera — design

Data: 9 nov 2026. Primo documento della **integrazione** del prototipo
desktop (`apps/desktop`, completo in `main` dalla PR #122) con il backend
vero. Parte dall'area 2 del prototipo (`docs/plans/2026-10-23-desktop-area2-task-design.md`,
«il nucleo delle task»), che resta la specifica funzionale ed estetica: qui
non si ridisegna niente, si decide **come farlo funzionare davvero**, sia
nell'app desktop sia nel browser.

Le decisioni marcate *(maintainer)* vengono dalla conversazione del 9 nov
2026; quelle marcate *(scelta del costruttore)* sono proposte confermabili.

## Perché

Il prototipo è la specifica dell'app vera, ma oggi vive solo di dati finti.
L'area 2 è il motivo per cui l'app esiste (il posto in cui tutti i reparti
tengono il lavoro al posto di Jira): è la prima che deve funzionare davvero.
Il web deve diventare, pian piano, una copia del prototipo per funzioni ed
estetica *(maintainer)*: farlo con un secondo codice vorrebbe dire due
interfacce che divergono, la trappola che questo repo evita altrove.

## Obiettivi

- Le pagine dell'area 2 del prototipo funzionano contro il server vero,
  **identiche** (struttura, testi, stati, permessi, estetica) a come sono
  nel prototipo.
- **Un codice solo** per desktop e browser *(maintainer)*: lo stesso
  renderer gira in Electron e come SPA servita da caddy.
- Il prototipo **resta avviabile coi dati finti** come specifica viva
  *(maintainer)*.
- Niente si rompe per chi usa oggi il web vecchio, l'app mobile, il plugin
  MCP e la pipeline di Claude.

## Non obiettivi

- Ridisegnare pagine o cambiare comportamenti decisi nel prototipo. Una
  divergenza scoperta in integrazione (il prototipo calcolava qualcosa che il
  server non può sapere) si porta al maintainer, non si risolve in silenzio.
- Le aree 3–11 (Claude completo, chat, docs, posta, automazioni, rilasci,
  amministrazione — tranne Reparti, vedi sotto —, integrazione di Claude,
  documentazione di prodotto).
- Firma, notarizzazione, auto-update e CI di pacchetti per l'app desktop
  *(maintainer)*.
- Ritirare il web vecchio: succede quando la nuova interfaccia copre
  abbastanza, con una decisione a sé.
- Rimuovere l'enum `tickets.status`: succede con il ritiro del web vecchio.

## Anti-obiettivi

- Due copie della stessa pagina (una in `apps/web`, una nel renderer).
- Dati finti davanti a un utente vero, in qualunque build che non sia il
  prototipo.
- Una regola di dominio (chi può, cosa è fermo, cosa aspetta te) calcolata
  dal client quando il server la sa: il prototipo la calcola nel suo «server
  finto», l'app vera la legge dal server (invariante «il client legge i
  permessi calcolati dal server», `docs/invariants/permissions.md`, e la
  famiglia di trappole «si derivano a lettura» in `CLAUDE.md`).
- Una pagina che mischia lo stile vecchio e quello nuovo.
- Un cambio non additivo su una rotta che l'app mobile o il web vecchio
  leggono.

## Architettura *(maintainer)*

### Un renderer, tre build

Il renderer di `apps/desktop/src/renderer` diventa il codice unico
dell'interfaccia. Si costruisce in tre modi:

| Build | Dati | Dove gira | Login |
|---|---|---|---|
| **prototipo** | finti (seed in memoria, come oggi) | `pnpm --filter @stubwise/desktop dev` / `preview:web` | nessuno («vedi come») |
| **app desktop** | server vero | Electron, build locale non firmata (.app/.dmg) sul Mac del maintainer, puntata all'istanza di produzione *(maintainer)* | come l'app mobile (sotto) |
| **app web** | server vero | SPA servita da caddy su un **percorso separato** (es. `/app`), il web vecchio resta alla radice *(maintainer)* | sessione a cookie del web |

- *(scelta del costruttore)* Dove sta fisicamente il renderer (resta in
  `apps/desktop` con un target web, o si estrae in un package condiviso) lo
  decide il piano; il vincolo è uno solo: nessuna pagina esiste due volte.
- Il livello dati ha **due implementazioni dietro la stessa interfaccia**:
  oggi `data/queries.ts` importa `* as api from "./api"` (letture) e le
  mutazioni da `data/api-mutations.ts`. La build sceglie l'implementazione
  (finta: il codice di oggi; vera: su `@stubwise/api-client`). *(scelta del
  costruttore)* Il meccanismo (alias di Vite per build, o un provider
  iniettato) lo sceglie il piano; i test del prototipo (~6700) devono
  continuare a girare sull'implementazione finta senza modifiche.
- L'implementazione vera di una lettura che nel prototipo è **derivata**
  (es. `stalledTasks`, `pulseOf`, `waitingOnMe`, permessi) chiama una rotta
  del server che la calcola; non porta la regola nel client. Dove il
  prototipo ha la regola in `domain/` pura e condivisibile, il piano valuta se
  spostarla in `@stubwise/shared`/`@stubwise/notifications` perché la usino
  sia il server sia il seed finto (una regola, un posto).
- `@stubwise/api-client` cresce con i gruppi nuovi dell'area 2; resta il
  client condiviso con l'app mobile (cambi additivi, vedi `CLAUDE.md`).

### Login dell'app desktop *(maintainer)*

Come l'app mobile: al primo avvio si sceglie l'indirizzo dell'istanza, poi
login con email, password e secondo fattore attraverso la porta che rilascia
un token (`/mobile-login` o una sorella, dentro le regole di
`docs/invariants/second-factor.md`: ogni porta che dà un token passa dal
secondo fattore). Il token sta nel **portachiavi del sistema** (Keychain su
Mac), mai nel renderer: il preload espone solo funzioni strette (es.
`window.stubwise.session`), mai il token in chiaro né `ipcRenderer`. Le
richieste HTTP partono dal processo main o dal renderer con il token
iniettato dal main — *(scelta del costruttore)* lo decide il piano, tenendo
le protezioni della finestra (`sandbox`, `contextIsolation`, CSP) e
aggiungendo l'origine dell'istanza alla `connect-src` della CSP.

La build web usa la sessione a cookie del web di oggi (stessa origine,
dietro caddy).

### Le aree non ancora integrate *(maintainer)*

Nelle build «app» le destinazioni delle aree non integrate restano nella
navigazione con uno stato neutro **«in arrivo»**, senza dati. ⌘K e
notifiche non cercano né linkano oggetti di quelle aree. Dentro una pagina
integrata, una sezione che appartiene a un'area futura mostra lo stesso
stato (salvo dove questo documento dice altro).

### Caddy e deploy

- Il bundle web nuovo si builda nell'immagine caddy (`Dockerfile.caddy`)
  come gli altri, servito sul suo percorso con il fallback SPA.
- Rotte API nuove → `server`; colonne che il worker nomina → prima il
  server, poi worker (regola ricorrente di `docs/operations/deploy-log.md`).
  Ogni fetta ha la sua voce nel deploy-log, con rollback.

## Le fette *(maintainer)*

L'area 2 si integra **a fette**, ognuna con design (questo documento per la
fetta 1, un'appendice o un documento suo per le altre), piano e rilascio
propri:

1. **Ossatura vera + Tasks** (sotto, in dettaglio).
2. **Planning e La mia settimana**: settimana pianificata, slittamento,
   carico in taglie, Planning di progetto e trasversale, vista Timeline,
   `planning.others` *(maintainer: Timeline e settimana qui, non nella 1)*.
3. **Home a blocchi e filtri salvati**: Home per reparto e personale,
   catalogo dei blocchi, «Da decidere», `department.home.manage`, filtri
   privati/pubblici (sopra `saved_views`).
4. **Requests, Overview, Tutti i progetti**: backlog → Requests con codici
   `R<n>`, Overview (a che punto è, cosa è aperto, cosa è fermo), cronologia,
   registro decisioni, **gestione dei traguardi** (che nel prototipo vive
   nell'Overview, *maintainer*), portafoglio, nuovo progetto con modelli.

## Fetta 1 — ossatura vera e Tasks

### Cosa entra

**Ossatura**
- La shell del prototipo (binario, colonna, ⌘K, notifiche, temi, lingue)
  sui dati veri, con le destinazioni non integrate «in arrivo».
- **Notifiche** *(maintainer)*: una sola inbox, la stessa del web vecchio e
  del mobile (`/api/inbox`), con lo stato «letta» condiviso. Si mostrano
  **tutte** le card: quelle delle aree integrate si risolvono sul posto, le
  altre (proposte della posta e del pulse, piani da approvare, domande di
  Claude…) hanno **«Apri nel web»** verso la pagina del web vecchio. Le
  notifiche nuove di questa fetta (Segui, richieste di decisione) arrivano
  ovunque, anche nell'inbox del web vecchio e come push sul mobile.
- Login (desktop: istanza + token; web: cookie), logout, sessione scaduta.
- La persona corrente e i suoi permessi letti dal server (sostituiscono il
  «vedi come», che resta solo nel prototipo).
- Progetti visibili (membri o full admin), progetti fissati per persona.
- **Codici di progetto**: campo nuovo `projects.code`, unico. *(scelta del
  costruttore)* Per i progetti esistenti si ricava dallo slug (maiuscolo,
  troncato, disambiguato se collide), modificabile da chi ha
  `project.settings.manage`. Le task mostrano `<CODICE>-<number>`; il
  `number` di oggi non cambia.
- **Tipi di task** *(maintainer)*: l'app vera mostra i **tre tipi del
  prototipo** (bug, funzionalità, attività). Nel DB restano i cinque di oggi:
  «attività» ↔ `task`; `feedback` si mostra come funzionalità, `review` come
  attività; una task creata o modificata dall'app nuova scrive `bug`,
  `feature` o `task`. Pipeline, web vecchio, mobile e MCP vedono il valore
  vero.
- **Reparti** *(maintainer)*: tabelle nuove (reparto: nome, colore dalla
  palette del prototipo; appartenenza persona↔reparto, molti a molti) e
  `tickets.department_id`. Entra **la sola pagina Reparti**
  dell'amministrazione del prototipo (`pages/admin/DepartmentsPage.tsx`,
  `DepartmentPanel.tsx`: nome, colore, membri); il resto
  dell'amministrazione resta «in arrivo». La migrazione crea un reparto
  **«Generale»** e ci mette tutte le persone e tutte le task esistenti. Una
  task nuova nasce col primo reparto di chi la crea; *(scelta del
  costruttore)* una task senza creatore umano (SDK, widget, posta,
  automazioni, intake convertito, pipeline) nasce in «Generale».
  «Generale» si rinomina ma non si elimina (è il ripiego), quindi
  `tickets.department_id` può essere `NOT NULL`. *(scelta del
  costruttore)* Il permesso di gestione è quello che il prototipo usa per
  quella pagina; i ruoli di reparto (`department.home.manage`) arrivano con
  la fetta 3.
- **Stati per progetto** *(maintainer)*: tabella `project_statuses` (nome,
  ordine, famiglia `todo`/`active`/`closed`) e `tickets.status_id` come
  verità. Impostazioni del progetto → Stati, come nel prototipo
  (aggiungi, rinomina, riordina, elimina con spostamento delle task; almeno
  uno stato per famiglia).
  - L'enum `tickets.status` **resta** come colonna di compatibilità,
    **derivata** dallo stato (una sola scrittura, nella stessa transazione,
    in un solo posto): web vecchio, app mobile, MCP, notifiche e pipeline
    continuano a leggerla.
  - Quando la pipeline o un client vecchio scrivono l'enum (es. la pipeline
    porta a `in_review` o `done`, il web vecchio sposta una carta), lo stato
    vero si muove con la regola del prototipo: il primo stato `active` dopo
    quello di partenza per un passaggio «in corso/in revisione», il primo
    `closed` per un passaggio a chiuso, il primo `todo` per una riapertura.
  - *(scelta del costruttore)* La mappatura esatta famiglia ↔ valori
    dell'enum (es. `todo` → `open`/`triaged`, `active` → `in_progress`/
    `in_review`, `closed` → `done`/`closed`) e come conservare la distinzione
    `in_progress`/`in_review` che il codice di oggi legge, la fissa il piano
    dopo aver censito i lettori dell'enum; ogni lettore elencato con la sua
    riga.
  - La migrazione dà a ogni progetto esistente gli stati del modello
    «Software» del prototipo e mappa gli stati di oggi su quelli.
- **Taglie** *(scelta del costruttore)*: XS–XL prendono il posto dello sforzo
  1–5 (1→XS, 2→S, 3→M, 4→L, 5→XL), anche come uscita del triage AI e nel
  gate dell'auto-fix (`effort <= maxEffort` diventa lo stesso confronto sulle
  taglie). La forma (colonna nuova o reinterpretazione di `effort`) la
  sceglie il piano; il web vecchio e il mobile continuano a vedere il valore
  che leggono oggi.

**Tasks di progetto**
- Viste **Elenco** e **Board** del prototipo, con la barra dei filtri
  (senza «Salva come filtro», che arriva con la fetta 3); raggruppamento,
  ordinamento, selezione multipla e azioni in blocco; board con colonne per
  stato del progetto, trascinamento mouse/tastiera ottimistico con ritorno
  indietro su errore. La **Timeline** è «in arrivo» (fetta 2).
- Il **dettaglio della task** a pannello, con indirizzo suo: testata e
  campi, descrizione, task collegate (`ticket_links`), richiesta d'origine
  (lettura), attività (commenti di oggi con risposte, modifica ed
  eliminazione, e cambiamenti di campo da `ticket_events`), esporta come
  Markdown, origine e payload tecnico. Il campo «settimana» è assente fino
  alla fetta 2.
- **Ferma con motivo** *(maintainer)*: motivi automatici calcolati dal
  server (bloccata da <task>, non assegnata, nessuno la tocca da N giorni,
  aspetta la decisione di <persona>, Claude ha una domanda aperta), «Segna
  ferma» a mano con motivo e nota, «Non è più ferma», soglie nelle
  impostazioni del progetto (7/14 giorni di default, come nel prototipo).
- **Richieste di decisione** *(maintainer)*: «Chiedi una decisione» a una
  persona (domanda, opzioni facoltative, «Altro…»), risposta, ritiro, più
  richieste aperte verso persone diverse; la risposta entra nell'attività e
  avvisa chi l'ha chiesta. Finché la Home è «in arrivo», la persona a cui si
  chiede la trova **nelle notifiche** (notifica nuova, risolvibile dal
  pannello della task). Non entrano nel registro decisioni in automatico.
  Nuovo `notification_kind`: la voce del deploy-log dice quando lo scendere
  d'immagine smette di essere sicuro.
- **Allegati** *(maintainer)*: elenco, aggiungi, rimuovi con conferma.
  *(scelta del costruttore)* Si **riusa** quello che esiste: tabella
  `attachments`, `apps/server/src/routes/attachments.ts`, storage S3 delle
  impostazioni d'istanza, download presigned, gli stessi limiti di oggi
  (10 MB, allowlist dei tipi MIME), gli stessi allegati che vedono web
  vecchio e mobile. Con S3 non configurato l'istanza dice che gli allegati
  sono spenti, come oggi.
- **Segui la task** *(maintainer)*: chi segue riceve le notifiche dei
  cambiamenti (stato, assegnatario, commenti, decisioni). Chi crea e chi è
  assegnato seguono in automatico *(scelta del costruttore, come nel
  prototipo)*, **da ora in avanti**: nessun backfill dei follower sui ticket
  esistenti. I cambi automatici della pipeline (`in_review`, `done`) non
  notificano i follower: hanno già le loro notifiche.
- **Sezione Claude** *(maintainer)*: lo **stato reale** del lavoro di Claude
  letto dai job esistenti (nessuno, sta lavorando, aspetta una risposta,
  aspetta un'approvazione, fermo, finito) e le PR, con **«Apri nel web»**
  verso il dettaglio del web vecchio per piano, approvazione, domande e
  sessione dal vivo. «Assegna a Claude» e il resto arrivano con l'area 3.
- **Nuova task**: il dialogo del prototipo (titolo, progetto, reparto,
  descrizione, assegnatario, taglia, stato iniziale, traguardo), con
  `tickets.create` nel progetto; senza settimana fino alla fetta 2.
  *(scelta del costruttore)* Una task creata dall'app nuova **non** è deviata
  nell'intake del backlog (`maybeEnqueueBacklogIntake`), nemmeno se è una
  funzionalità su un progetto col backlog acceso: è una task per
  definizione, le richieste si mandano da Requests (fetta 4). Web vecchio,
  MCP e SDK restano come oggi. Il traguardo si sceglie fra quelli esistenti.
- **Traguardi** *(maintainer)*: nella fetta 1 si **assegna** un traguardo
  esistente a una task (dettaglio, nuova task, azioni in blocco, filtro),
  sopra la tabella `milestones` di oggi. Crearli, modificarli, chiuderli ed
  eliminarli, con l'avanzamento, arriva con l'Overview (fetta 4); nel
  frattempo si fa dal web vecchio.

**Pagine di progetto non in questa fetta**: Overview, Planning, Requests e le
altre impostazioni del progetto sono «in arrivo». *(scelta del costruttore)*
Aprire un progetto atterra su Tasks finché l'Overview non è integrata.
Home e Tutti i progetti: «in arrivo», tranne l'elenco dei progetti della
colonna che serve a navigare.

### Permessi

Si usano le chiavi di oggi (`tickets.create`, `tickets.edit`,
`tickets.comment`, `project.settings.manage`, …), calcolate dal server per
progetto e lette dal client. Ogni rotta nuova dichiara `config.access`. Un
progetto o una task invisibile risponde 404 come uno che non esiste; gli
elenchi filtrano nella WHERE prima di paginare e contare
(`docs/invariants/permissions.md`). Un permesso nuovo va nel registro di
`@stubwise/shared` con il suo gruppo e le frasi nelle due lingue.

### Compatibilità

- Ogni cambio alle risposte che mobile o web vecchio leggono è additivo; i
  campi nuovi nascono `.optional()`/`.default()`/`.nullable()` con il test
  che parsa una risposta senza (regola di `CLAUDE.md`).
- `tickets.status` resta scritta e coerente finché esiste il web vecchio.
- L'MCP (`list_tickets`, `set_ticket_status`, …) continua a funzionare con
  l'enum; *(scelta del costruttore)* imparare gli stati per progetto è un
  lavoro successivo.

### Verifica

- I test del prototipo restano verdi sull'implementazione finta.
- Test del server con Postgres vero per ogni rotta nuova, compresi i casi
  negativi di permesso (403 **e** stato invariato) e di visibilità (404).
- Test di parità: per ogni lettura dell'interfaccia dati, l'implementazione
  vera produce la stessa forma di quella finta (tipi condivisi, più un test
  di contratto per gruppo).
- Una tabella di controllo nel piano, una riga per voce di
  `apps/desktop/docs/area2-parity.md` che entra in questa fetta (dove vive,
  quale rotta, quale test), come per le aree del prototipo.
- Prova a mano del maintainer su desktop e browser prima del rilascio.

## Decisioni aperte

- Quando e come il web nuovo prende la radice e il vecchio si ritira.
- Quando l'MCP impara stati, reparti e taglie.
- Cosa fa Claude su una task non tecnica (dal prototipo, invariato).
