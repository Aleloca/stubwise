# MCP di Stubwise anche per i collaboratori non tecnici — design (19 ott 2026)

## Perché

Il plugin `stubwise` per Claude Code (server MCP `@stubwise/mcp` + skill +
comandi) oggi è pensato per sviluppatori: collegare un repository, portare
design e piani in backlog e ticket, lanciare esecuzioni. Molti collaboratori
del maintainer, anche **non tecnici**, usano già Claude Code. Oggi le loro
richieste arrivano al maintainer per altre vie (mail, messaggi), spesso
confuse o senza contesto: due esempi reali del 19 ott 2026 sono una lista
numerata incollata senza spiegazioni («Audin non vede le email partite da
Gmail…», «8. Quando creo un contatto…», «Non ancora») e una mail lunga e
chiara sullo spegnimento di HubSpot. Il maintainer deve poi ricostruire cosa
volevano.

L'idea: far parlare il collaboratore con Claude **dentro Claude Code**,
con l'MCP di Stubwise che ha accesso alla documentazione dei progetti. Claude
fa le domande giuste mentre il collaboratore ha ancora davanti il problema, e
apre bug o richieste di backlog **già chiari**.

## Cosa deve saper fare (per chiunque, non solo i non tecnici)

1. **Rispondere a domande sul funzionamento di un progetto**, dalla
   documentazione di Stubwise (Docs generati dai repository).
2. **Raccogliere un bug** e aprirlo come ticket.
3. **Raccogliere una richiesta** (funzionalità, cambio di comportamento) e
   aprirla come voce di backlog.
4. **Dire a che punto sono le richieste dell'utente**: «a che punto è la mia
   richiesta sulle email?», «cosa ho segnalato questo mese?».

## Decisioni del maintainer

- **Account**: ogni collaboratore ha un suo utente Stubwise (ruolo normale,
  creato dal maintainer) e un suo token personale (PAT).
- **Configurazione dal web**: nelle impostazioni di Stubwise una sezione
  dedicata («Claude Code») dove l'utente crea il PAT e la pagina genera un
  **comando pronto** da copiare e incollare nel terminale. Il comando installa
  il plugin e salva indirizzo dell'istanza e token. Nessuna variabile
  d'ambiente da impostare a mano.
- **Progetto**: un collaboratore può lavorare su più progetti. L'agente
  **intuisce** il progetto dal contesto (l'MCP dà l'elenco), ma **chiede
  sempre conferma** all'utente prima di usarlo («Parli di Audin AI,
  giusto?»); se non lo intuisce, mostra l'elenco e chiede. Confermato, resta
  quello per la conversazione salvo cambio di argomento.
- **Bug, regola o richiesta** (il flusso, vedi sotto): se ciò che l'utente
  descrive è il comportamento previsto, l'agente spiega la regola e chiede se
  intende altro; se l'utente vuole qualcosa che contrasta una regola, l'agente
  propone una **richiesta di backlog** che spiega cosa gli servirebbe e perché
  ciò che c'è non va bene.
- **Seguire le proprie richieste**: sì, l'utente può tornare a chiedere a che
  punto sono.
- **Un solo plugin**, nessuna limitazione di strumenti: i permessi li decide il
  server sul token (l'MCP non può fare nulla che l'utente non possa fare dal
  web). Si adattano le **istruzioni**, non i tool.
- **Le risposte le scrive il Claude Code dell'utente, non il server.** L'MCP
  restituisce i passaggi pertinenti della documentazione (recupero, senza
  generazione) e il Claude locale compone la risposta. Niente chat dei Docs
  lato server per questo: nessun costo sulla chiave API dell'istanza, nessun
  limite per utente da gestire, funziona anche senza provider con chiave, e il
  registro lo decide il Claude che sta parlando con l'utente.
- **Il maintainer viene avvisato**: quando un utente apre un bug o una
  richiesta, al maintainer arriva una card in inbox (web e app) con push.
- **Criteri di insuccesso**: non noti ora — «vedremo man mano che lo
  utilizzano». Quindi: partire semplice, regole facili da ritoccare (testo di
  istruzioni, non logica cablata).

## Il flusso di bug e richieste

1. **Capire.** L'utente racconta a modo suo. L'agente fa domande **una per
   volta**: cosa stava facendo, cosa si aspettava, cosa è successo invece (bug);
   qual è il problema, in che contesto, come se la cava oggi (richiesta). Se il
   primo messaggio è già completo, non chiede.
2. **Confrontare con la documentazione** del progetto (tool di recupero dei
   Docs).
3. **Comportamento previsto** → spiega la regola in parole semplici e chiede
   «è questo che intendevi, o ti serve altro?». Se basta la spiegazione, fine:
   niente aperto. Se all'utente serve qualcosa di diverso → **richiesta di
   backlog** con: cosa gli servirebbe, perché quello che c'è non va, la regola
   attuale con cui si scontra.
4. **Difetto vero** → **bug** (ticket di tipo `bug`) con passi, atteso,
   ottenuto, dove e da quando.
5. **Funzionalità nuova** non coperta dai Docs → **richiesta di backlog** con
   problema, contesto, come se la cava oggi.
6. **Prima di aprire**: l'agente mostra la bozza e **chiede conferma**. Nella
   bozza non inventa dettagli che l'utente non ha dato.

Precedente da riusare: il prompt del widget del customer service
(`apps/server/src/routes/widget-chat.ts`, `buildWidgetSystemPrompt`, e
`docs/plans/2026-08-06-widget-guided-intake-design.md`) fa già domande di
chiarimento (al massimo 3, una per volta, saltate se il messaggio è già
completo) e compone un corpo per tipo. Le regole e il modello del corpo si
riusano; gli endpoint del widget no (autenticazione per chiave, persistenza
propria).

## Cosa c'è già e cosa manca (ricognizione del 19 ott 2026)

**C'è, lato server:**
- Recupero dai Docs: `retrieveChunksForProject` (usato dalla chat dei Docs di
  progetto, `apps/server/src/routes/project-docs.ts`) trova i passaggi
  pertinenti su tutti i repository del progetto. Esposti oggi:
  `GET /api/projects/:projectId/docs/search?q=` (solo **frammenti brevi**:
  slug, titolo, snippet, punteggio, repository) e la lettura di una pagina
  `GET /api/repositories/:repositoryId/docs/pages/:slug`. La chat dei Docs
  (`POST …/docs/chat?stream=false`) genera lato server con la chiave API
  dell'istanza: **non** si usa per questa funzione (vedi decisioni).
- Ticket: `POST /api/tickets` con `type: "bug"`. Un ticket manuale **non
  avvia nulla** da solo (nessun job AI). ⚠️ Un ticket `feature`/`feedback` su
  un progetto col backlog acceso viene **deviato** in intake e chiuso
  (`maybeEnqueueBacklogIntake`): le richieste vanno comunque aperte come voci
  di backlog, non come ticket.
- Backlog: `POST /api/backlog` (202, job di intake) + `GET /api/backlog/jobs/:jobId`;
  l'MCP ha già `create_backlog_item` che segue il job. ⚠️ L'intake può
  **fondere** la richiesta in una voce esistente molto simile (soglia 0.90) e
  riassume sempre il testo.
- MCP: `list_projects`, `get_project_brief`, `create_ticket`,
  `create_backlog_item`, `list_backlog`, `list_tickets`, `get_ticket`,
  `get_backlog_item`, ecc.

**Manca:**
- Nell'MCP nessun tool sui Docs, e nessun endpoint che restituisca il testo
  completo dei passaggi recuperati.
- Nessuna notifica alla creazione manuale: `POST /api/tickets` e
  `POST /api/backlog` non pubblicano nulla (`ticket.created` lo pubblica solo
  l'ingest dell'SDK, `apps/server/src/ingest/processor.ts`).
- L'MCP non manda **istruzioni di server** (`instructions` di `McpServer`):
  tutta la guida sta nelle descrizioni dei tool e nella skill `stubwise`, che
  è scritta per sviluppatori (frontmatter, `docs/plans/`, stati automatici
  `in_progress`/`in_review`, `/stubwise:init`).
- Senza `.stubwise.json` l'errore dice «lancia /stubwise:init».
- **Nessun autore** su ticket e voci di backlog: non si può chiedere «le mie
  richieste».
- Configurazione: token e indirizzo solo da variabili d'ambiente della shell;
  installazione con comandi da terminale; serve Node (`npx`).
- Gli avvisi dell'MCP (`packages/mcp/src/notices.ts`) contengono comandi da
  terminale.

## Cosa si costruisce

### 1. Autore delle richieste (server, DB)

- Colonna «richiesto da» (utente, nullable, `ON DELETE SET NULL`) su
  `tickets` e `backlog_items`, valorizzata con l'utente autenticato alla
  creazione da API (ticket manuale, voce di backlog).
- Per le voci di backlog la creazione passa dall'intake asincrono: l'autore
  va portato nel payload del job e scritto dal worker. Se l'intake **fonde** la
  richiesta in una voce esistente, chi l'ha chiesta deve comunque ritrovarla
  fra le sue: serve una relazione voce ↔ utenti richiedenti (molti a uno), non
  una sola colonna, oppure una scelta equivalente — vedi «Lasciato al
  costruttore».
- Filtro «solo le mie» sulle liste di ticket e backlog (API), esposto dall'MCP.
- **Quali origini contano** (scelta del costruttore, confermabile): solo le
  creazioni fatte da un utente autenticato (web, MCP — stessa API). Widget,
  Slack e proposte dalla posta restano senza autore. Una voce di backlog
  convertita in ticket **passa l'autore al ticket**, così «rilasciata» si
  segue fino alla PR. Nessun recupero dello storico: prima del rilascio
  «le mie richieste» è vuoto.

### 1-bis. Avviso al maintainer (server, app, web)

- Alla creazione di un bug o di una richiesta da parte di un utente, una card
  in inbox per il maintainer (gli admin), con push: «X ha segnalato un bug su
  Audin AI» / «X ha chiesto … su Audin AI», che apre il ticket o la voce.
  Per una richiesta la card nasce quando l'intake ha creato (o fuso) la voce,
  non al 202.
- Un tipo di notifica nuovo (o il riuso di `ticket.created` per i bug): vedi
  CLAUDE.md sulle notifiche — i campi letti dal client si derivano a lettura,
  e un `notification_kind` nuovo rende non sicuro scendere d'immagine sul
  server finché ne esistono righe (voce nel deploy-log).
- Non avvisa chi ha aperto la richiesta (non obiettivo: lo chiede lui).

### 2. MCP

- **Tool nuovi** (nomi indicativi):
  - `search_project_docs` — dato un progetto e una domanda, restituisce i
    **passaggi pertinenti** della documentazione con il loro testo (non solo
    frammenti) e la fonte (repository, pagina). Nessuna generazione lato
    server: la risposta la scrive il Claude locale. Serve un endpoint nuovo
    sul recupero esistente (`retrieveChunksForProject`) oppure ricerca +
    lettura pagina — scelta del costruttore.
  - `read_doc_page` — il testo completo di una pagina, quando i passaggi non
    bastano.
  - `my_requests` — bug e richieste aperti dall'utente del token, con stato
    in parole semplici (vedi sotto), su uno o tutti i progetti.
  - `list_decisions` e `get_project_brief` esistono già e completano il
    contesto (perché una regola è com'è, dove sta il progetto).
- **Stati in parole semplici** (mappatura nel tool o nelle istruzioni):
  ricevuta / non ancora presa in carico, in lavorazione, in verifica,
  rilasciata, archiviata o chiusa; se c'è un commento o una nota del
  maintainer, riassunta.
- **Istruzioni di server** (`instructions`): il flusso «capire → confrontare
  con i Docs → regola / bug / richiesta → bozza → conferma», la regola del
  progetto (intuire e confermare sempre), il registro (parole semplici, niente
  gergo, niente comandi), cosa dire quando l'intake fonde la richiesta in una
  esistente («la tua richiesta è stata unita a una simile già aperta: …»).
- **Senza repository collegato** nessun riferimento a `/stubwise:init`: il
  messaggio d'errore chiede di indicare il progetto (o l'agente usa l'elenco).
- **Configurazione da file**: se `STUBWISE_TOKEN`/`STUBWISE_URL` non sono
  nell'ambiente, l'MCP li legge da un file di configurazione personale nella
  cartella utente scritto dal comando di installazione. Le variabili
  d'ambiente, se presenti, vincono (chi usa la configurazione di oggi non
  cambia nulla).
- **Avvisi** (`notices.ts`) leggibili anche da un non tecnico.

### 3. Plugin (skill e comandi)

- La skill `stubwise` resta per il lavoro sui repository, ma con la
  descrizione ristretta a quel contesto, così non scatta (e non applica i
  suoi automatismi) in una conversazione da collaboratore.
- Una skill nuova (o le istruzioni di server da sole — vedi «Lasciato al
  costruttore») per domande, bug e richieste.
- Eventuali comandi brevi in italiano per chi preferisce un punto d'ingresso
  esplicito sono facoltativi.

### 4. Web: sezione «Claude Code» nelle impostazioni

- Accanto ai token di accesso (`apps/web/src/routes/settings/access-tokens.tsx`,
  che già cita lo `STUBWISE_TOKEN` dell'MCP): crea un PAT e mostra **un
  comando** pronto da copiare che installa marketplace e plugin e scrive il
  file di configurazione con URL dell'istanza e token.
- Istruzioni minime: serve Claude Code installato; serve Node (il plugin
  avvia l'MCP con `npx`) — il comando lo verifica e dice cosa fare se manca.
- Il token si vede una volta sola (come oggi): il comando va generato al
  momento della creazione.

### 5. Guida e rilascio

- Guida utente (`apps/docs`): una pagina per i collaboratori (installazione
  dal web, cosa chiedere, cosa succede alle loro richieste).
- Rilascio del plugin secondo CLAUDE.md: changeset che nomina
  `@stubwise/claude-plugin` **e** `@stubwise/mcp`, versioni sincronizzate con
  `pnpm version-packages`; `.mcp.json` sempre in forma `${VAR:-}`.
- Voce nel deploy-log (migrazione della colonna/relazione autore).

## Obiettivi e non obiettivi

- **Obiettivo**: richieste che arrivano al maintainer già comprensibili, e
  domande sul funzionamento che non arrivano proprio al maintainer.
- **Richieste su un progetto col backlog spento** (scelta del costruttore,
  confermabile): diventano un ticket di tipo `feature` invece di una voce di
  backlog, così finiscono dove il maintainer guarda.
- **Note del maintainer verso il collaboratore** (scelta del costruttore): per
  i ticket l'agente riassume i commenti; per le voci di backlog nella prima
  versione c'è solo lo stato (nessun campo note nuovo). Si aggiunge se l'uso
  lo chiede.

- **Non obiettivi**: permessi per progetto (oggi ogni utente vede tutti i
  progetti, e resta così); limitare gli strumenti per profilo; far eseguire
  fix o approvare piani ai collaboratori (resta il gate di sempre); notifiche
  push ai collaboratori sullo stato delle loro richieste (lo chiedono loro).
- **Anti-obiettivo dichiarato**: nessuno per ora; si osserva l'uso e si
  ritocca.

## Lasciato al costruttore

- Nomi dei tool, forma esatta degli stati in parole semplici.
- Se le regole del flusso stanno nelle `instructions` del server MCP, in una
  skill nuova, o in entrambe (le `instructions` raggiungono anche chi non ha
  la skill; la skill è più lunga e ritoccabile senza rilasciare l'MCP — ma
  entrambe passano dal rilascio del plugin).
- Come rappresentare «più richiedenti» di una voce fusa dall'intake.
- Percorso e formato del file di configurazione; come il comando lo scrive su
  macOS/Windows/Linux.
- Quanti passaggi restituire e quanto testo (limite di contesto del Claude
  locale), e se includere il contesto del grafo come fa la chat dei Docs.
