# Le sessioni degli agenti: guardarle dal vivo e intervenire

Data: 8 ott 2026. Stato: design approvato dal maintainer, una sezione alla
volta. Le premesse segnate «DA VERIFICARE» si controllano nel piano.

## 1. Il problema

Un run dell'agente (piano, fix, correzione, review, deep dive, Docs…) oggi è
una scatola chiusa finché non finisce. Il worker lancia
`claude -p --output-format json` (`apps/worker/src/agent/claude-cli.ts`) e il
CLI restituisce **un solo oggetto JSON alla fine del run**. Mentre l'agente
lavora non si vede niente, e l'unico modo di orientarlo è aspettare che si
fermi da sé: una domanda `ask_user`, il gate del piano, una correzione dopo la
PR.

Il maintainer vuole quello che avrebbe con la sessione di Claude Code aperta
davanti: vedere cosa sta facendo l'agente e, se serve, scrivergli o fermarlo.
Vuole anche una sezione che mostri tutto ciò che gli agenti stanno facendo
**adesso**.

La premessa resta: il primo modo di intervenire sono gli strumenti che app e
web già offrono (domande, approvazione del piano, «Chiedi modifiche»,
«Riprendi»). Questa è una seconda via, più diretta.

## 2. Decisioni del maintainer

1. **Chi** (B): tutti guardano; scrivere all'agente e interromperlo spetta
   solo ai maintainer (`admin`). Scrivere all'agente è un modo di orientare il
   lavoro, quindi tocca i due divieti dell'operatore.
2. **Storico** (C): sessioni dal vivo più replay, conservato **14 giorni**.
3. **Quali run** (C): in vista ci vanno **tutti**. Si **interviene** solo sui
   run agentici lunghi (elenco esplicito, §5.4); un run di pochi secondi
   (classificazione, riassunto) si guarda e basta.
4. **Sezione d'insieme** (B): un elenco con una riga dal vivo che dice
   l'ultima azione di ogni agente.
5. **Un intervento resta anche come commento sul ticket** (B), non nel
   registro decisioni: un messaggio libero a metà run non è un fatto
   strutturato.
6. **Tecnica** (strada 1): CLI in streaming bidirezionale, non Agent SDK. Il
   maintainer vuole continuare a usare gli account Claude Code (i termini
   d'uso scoraggiano gli account claude.ai dentro prodotti costruiti
   sull'SDK). Il ragionamento dell'agente (thinking) **non** è un requisito.
7. **La vista di una sessione è una chat**, come l'app di Claude per telefono
   e desktop, non un terminale.
8. **Nell'app, Agenti prende il posto di MBX nella barra**; posta e
   calendario si spostano dentro la pagina del profilo.
9. **La notifica di una domanda porta dentro la sessione**, e da lì si
   risponde.

## 3. Cosa è stato verificato (8 ott 2026)

Provato eseguendo il CLI **2.1.287** (la versione fissata nel worker) con
`-p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages`, non solo letto nei documenti:

- con l'input in stream-json **un processo regge più turni**: stdin resta
  aperto, e ogni turno emette `system/init` → eventi `assistant`/`user`/
  `stream_event` → `result`;
- l'evento `init` porta un array `capabilities` (`interrupt_receipt_v1`,
  `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `msg_lifecycle_v1`…);
- **interruzione**: `{"type":"control_request","request_id":"…","request":
  {"subtype":"interrupt"}}` su stdin durante un `Bash` in corso → il CLI
  risponde con un `control_response`, registra il tool come interrotto, chiude
  il turno con `result` `error_during_execution`, e **il processo resta
  vivo**;
- **un messaggio scritto a metà turno** (priorità di default `next`) non
  interrompe il tool in corso: viene letto dopo, e apre il turno successivo;
- i blocchi di **thinking arrivano vuoti** in headless (decisione 6: va bene
  così).

Dai documenti, non provato: le priorità `next`/`later`/`now` di un messaggio,
e `now` con `origin: {kind: "human"}` che manda in background il lavoro in
corso (2.1.286+). **Il protocollo su stdin è semi-interno**: documentato solo
attraverso l'SDK, con i tipi di controllo marcati alpha. Per questo il design
non si fida della versione ma delle `capabilities` (§7.2).

Scartati: **herdr** (multiplexer di TUI, accesso solo via SSH, nessun client
web o mobile; costringerebbe a lanciare `claude` in modalità interattiva,
perdendo risultati strutturati, costi e `--resume`), **ttyd/tmux** (stessa
ragione), **Remote Control** di Anthropic (vuole un abbonamento claude.ai e
mostra la sessione nella loro UI), **hook HTTP / lettura dei JSONL di
trascrizione / OpenTelemetry** (solo osservazione, parziale o ritardata,
nessun intervento).

## 4. Il modello: una sessione è un JOB, non un processo

Una domanda `ask_user` **chiude** il processo `claude`: il job va in
`awaiting_input` e alla risposta riparte un processo nuovo con `--resume`. Lo
stesso vale per piano → approvazione → esecuzione → self-repair. Se la
sessione fosse il processo, la notifica di una domanda porterebbe in una
sessione già finita.

Quindi **una sessione è l'unità di lavoro che l'utente riconosce**, e contiene
in ordine tutti i processi (segmenti) che la compongono:

- un job AI (`ai_jobs`): triage, piano, ripresa, esecuzione, self-repair,
  correzione;
- una review di PR (`pr_reviews`);
- un job di backlog (deep dive, intake) e la chat di analisi, legata alla
  voce di backlog;
- una generazione Docs;
- un run di solo testo (classificazione della posta, riassunti, daily report).

Tabella nuova `agent_sessions`. Il proprietario è una chiave testuale
**unica**, `owner_key` (`ai_job:<id>`, `pr_review:<id>`, `backlog_item:<id>`,
`doc_generation:<id>`…): è lei a garantire una sessione sola per unità di
lavoro, anche quando due call site dello stesso job la chiedono. Accanto,
colonne FK **facoltative** verso la riga che possiede la sessione
(`ai_job_id`, `backlog_item_id`, `pr_review_id`, `doc_generation_id`,
`backlog_job_id`), che servono a derivare stato ed esito a lettura (§8.2), e
`mailbox_owner_user_id` per la posta. Non c'è un CHECK «esattamente uno
valorizzato» (preflight dell'8 ott, §12): c'è invece, a livello di database,
`CHECK (kind <> 'email_message' OR mailbox_owner_user_id IS NOT NULL)`, perché
una sessione di posta senza proprietario sarebbe visibile a tutti (§5.6).
`agent_runs` resta com'è: è la contabilità dei consumi per `(job, fase,
modello)`, non un handle di sessione. L'elenco degli owner e dove nasce ogni
tipo di run sta nel piano A (Task 8 e 9).

## 5. Come gira un run e come escono gli eventi

### 5.1 Il processo

In `claude-cli.ts`, `--output-format json` diventa `--input-format stream-json
--output-format stream-json --verbose --include-partial-messages`. Il resto
dell'argv (permission mode, `--allowedTools`, `--mcp-config` +
`--strict-mcp-config`, `--plugin-dir`, `--setting-sources ""`, `--resume`)
**resta identico**. Il prompt non è più un argomento: è il primo messaggio
scritto su stdin.

stdin resta aperto per tutto il run. Quando arriva un `result` e **non** c'è
un intervento in coda, il worker chiude stdin e il processo esce come oggi.

### 5.2 L'esito

L'evento `result` finale porta gli stessi campi dell'oggetto JSON di oggi
(testo, costo, uso per modello, session id): chi consuma l'esito di un run non
si accorge del cambio.

⚠️ Un'interruzione produce un `result` con `error_during_execution`. Se dopo
c'è un messaggio del maintainer, **quello non è il fallimento del run**: è un
turno che continua. L'esito del run è quello dell'**ultimo** `result`, quello
dopo il quale stdin viene chiuso.

### 5.3 Dove finiscono gli eventi

- **Eventi completi** (messaggio dell'assistente, tool chiamato, risultato del
  tool, fine turno, `init`): il worker li scrive a piccoli lotti in
  `agent_session_events` (sessione, segmento, sequenza, tipo, payload jsonb) e
  fa `NOTIFY` col solo id (il payload di `NOTIFY` è limitato a 8 KB).
- **Eventi parziali** (il testo che si scrive dal vivo): **mai salvati**,
  accorpati ogni ~250 ms e inoltrati solo dal vivo.

Il server ascolta con `LISTEN` e inoltra a web e app via SSE (stesso schema
delle chat già esistenti, `apps/server/src/routes/docs-chat-core.ts`). Nessun
servizio nuovo nel compose. Chi si ricollega (riavvio del server, telefono
tornato online) rilegge la tabella dall'ultima sequenza vista.

### 5.4 Fail-open e scadenza

La scrittura degli eventi è **fail-open**: un errore si logga e non sale, il
run prosegue. Guardare è un di più e non deve mai far fallire un fix (stessa
regola di `recordRejection`). Il worker pota sessioni ed eventi più vecchi di
14 giorni nel tick (costante, non env).

### 5.5 I segreti

Nel worktree ci sono i `.env` del progetto: un `cat .env` o un test verboso li
stamperebbe nello stream, visibili a tutti per 14 giorni. E nell'ambiente del
processo `claude` c'è la credenziale del provider: un `env` o un `printenv`
la stamperebbe allo stesso modo. Il worker conosce questi valori e **li
sostituisce con `•••` in ogni evento prima di salvarlo o inoltrarlo**,
parziali e interventi compresi. L'insieme oscurato è:

- l'**unione** dei valori d'ambiente materializzati in **tutti** i repository
  del run (un fix multi-repo ne ha più d'uno), passata a **ogni** segmento di
  un run che usa un worktree: anche la pianificazione, perché nei fix in due
  fasi i `.env` sono già nel worktree quando il piano gira;
- la credenziale del provider del run (chiave API o token OAuth) e i valori
  delle variabili extra del runner, aggiunti dal runner stesso: non dipendono
  da chi lo chiama.

Non è una difesa completa (un valore derivato, codificato o spezzato fra due
eventi parziali passa), e la guida lo dice. Si oscurano solo valori di
lunghezza minima ragionevole, per non trasformare un `1` o un `true` in `•••`
ovunque.

### 5.6 La posta

Una sessione di classificazione email contiene il testo della mail di
qualcuno. Vale l'invariante `mailbox_owner`: **la vede solo il proprietario
della casella**, nessuna eccezione per gli admin, e non compare nell'elenco
degli altri. Il filtro è nella query, senza un ramo per ruolo.

## 6. Intervenire

### 6.1 Le azioni

- **Scrivi all'agente**: messaggio con priorità `next`, letto appena finiscono
  i tool in corso; l'agente prosegue tenendone conto.
- **Ferma e scrivi**: `control_request` di interruzione seguita dal messaggio.
  L'interruzione va **sempre** con un messaggio: un'interruzione a vuoto
  lascerebbe un run fermo senza istruzioni. Fermare del tutto un run è
  annullare il job, che è un'altra cosa e resta fuori.

### 6.2 Il percorso

`POST /api/agent-sessions/:id/messages` (`{ text, interrupt }`), con
`requireAdmin` sulla rotta **e** il controllo del ruolo dentro il servizio,
come `releasePullRequest`. Il server scrive la riga in `agent_session_inputs`
(`pending`) e fa `NOTIFY`; il worker che possiede il processo **la reclama
prima** (`UPDATE … SET status = 'delivered' WHERE status = 'pending'
RETURNING`), poi la scrive su stdin. Il claim prima della consegna è ciò che
impedisce di scriverla due volte quando la sveglia arriva da più strade
insieme (`LISTEN`, poll, registrazione del processo); se la scrittura su stdin
fallisce, la riga torna `undelivered` (`stdin_closed`).

- Run già finito → **409 `session_ended`**, niente scritto.
- Run finito o worker riavviato dopo la scrittura → la riga diventa
  `undelivered` e la vista lo dice: mai perso in silenzio. Il dettaglio della
  sessione porta l'elenco degli interventi (`inputs`: testo, stato, motivo,
  autore, data), e così il messaggio `session` dello stream SSE.
- Il worker è **un processo solo**: è l'unico a tenere lo stdin, la stessa
  assunzione del serializer di progetto e di `requeueWaitingReviews`. Va
  rivista insieme a loro il giorno in cui il worker diventasse multi-processo.

### 6.3 I due divieti dell'operatore restano intatti

Un `member` non scrive, quindi non può dire all'agente «salta il piano». Un
maintainer che scrive non scavalca niente: il permission mode del run resta
quello (un run in plan mode non scrive file nemmeno se glielo si chiede), e il
gate del piano lo applica la pipeline, non l'agente.

### 6.4 Dove si può scrivere

Elenco **esplicito** nel codice, non un default: piano, ripresa del piano,
esecuzione, self-repair, correzione, deep dive, chat del backlog, review. Un
tipo di run nuovo non entra da solo. Un job fermo su una domanda
(`awaiting_input`) non ha un processo vivo: lì il campo non c'è, c'è la
domanda (§8.3).

**La generazione Docs, in v1, si guarda e basta.** I suoi nodi girano in
parallelo (fino a `WORKER_CONCURRENCY`) dentro la stessa sessione, e un
intervento non saprebbe a quale processo andare. La sessione resta comunque
**viva finché almeno un segmento ha un heartbeat fresco**: ogni segmento vivo
rinfresca `heartbeat_at`, e la sessione tiene l'elenco dei segmenti aperti
(`live_segment_ids`). La fine di un segmento toglie solo sé stesso
dall'elenco, e svuota il segmento attivo solo quando l'elenco resta vuoto;
all'avvio il worker azzera gli elenchi, perché è un processo solo e un
segmento rimasto lì da un riavvio non è più vivo (§6.2).

### 6.5 Il tempo

Un intervento **non allunga** il timeout del run. Il tetto resta quello che
regge l'invariante di staleness (`WORKER_STALE_MINUTES` > 139'): un dialogo
lungo non deve far passare il job per morto.

### 6.6 Il commento sul ticket

Se la sessione ha un ticket, l'intervento diventa anche un commento a nome del
maintainer, introdotto da un template i18n («Scritto all'agente durante
l'esecuzione del fix:»). Mai AI. Le sessioni senza ticket (backlog, Docs) lo
tengono solo nella trascrizione.

## 7. Errori e versione del CLI

### 7.1 Il rischio più grande è il cambio di formato

Passare a `stream-json` cambia come il worker legge l'esito di **ogni** run,
non solo di quelli guardati. Difese:

- test del parser su **tracce vere registrate con la 2.1.287**: esito, costo,
  uso per modello, session id, errore, interruzione seguita da un messaggio,
  `--resume`;
- interruttore **`AGENT_STREAMING`** sul worker (default `true`; `false` =
  argv e parsing di oggi, nessuna sessione dal vivo). È il rollback innocuo,
  senza toccare immagini né schema;
- **scenari golden obbligatori** (cambia l'argv) più uno nuovo, `intervene`:
  un messaggio a metà run viene letto; «Ferma e scrivi» cambia direzione.

### 7.2 Capabilities, non versioni

Il worker salva le `capabilities` dell'`init` sulla sessione. Senza
`interrupt_*`, il server risponde `canInterrupt: false` e il client toglie
«Ferma e scrivi» invece di offrire un bottone che fallisce. Aggiornare il pin
del CLI resta la procedura di `CLAUDE.md`, con `intervene` fra gli scenari.

### 7.3 Altri errori

- **Processo appeso** (stdin aperto, nessuno che lo chiude): il worker chiude
  stdin a ogni `result` senza interventi in coda; il timeout di oggi resta la
  rete.
- **DA VERIFICARE nel piano**: `now` contro `next` sotto `--permission-mode
  plan`, l'interazione con `--resume` e con il parcheggio `ask_user`.

## 8. Cosa si vede

### 8.1 Dove sta

- **Web**: voce di menu «Agenti» (`/agents`), visibile anche ai member.
- **App**: la tab **AGT prende il posto di MBX**: INB/PRJ/WISEY/BLG/AGT.
  Posta e calendario si raggiungono dalla pagina del profilo. **DA
  VERIFICARE nel piano**: quale schermata è «il profilo» oggi, e ogni percorso
  che apre lo stack `Mbx` (deep link di calendario, card di proposta posta,
  link condivisi in `linking.ts`) va riportato lì. `CLAUDE.md` documenta le
  cinque tab come decisione: si aggiorna come quando DOC è uscita per Wisey.
- **Ticket**: con un run vivo, «Guarda la sessione» nella tab Stato dell'app e
  nel dettaglio web.

### 8.2 La sezione d'insieme

- **Al lavoro ora**: tipo di run, progetto/ticket, da quanto gira, stato e la
  riga con l'ultima azione. Lo stato lo **deriva il server** a lettura:
  `working` (un segmento vivo, oppure il lavoro che possiede la sessione è in
  corso fra due segmenti: job in triage o fix, review, generazione Docs o job
  di backlog in esecuzione), `waiting_input` (domanda aperta),
  `awaiting_approval` (piano in attesa di approvazione), `held` (job
  parcheggiato, o generazione Docs in pausa per limite), `queued` (job,
  generazione o job di backlog in coda), `ended`.
- **Concluse**: replay degli ultimi 14 giorni, filtrabile per progetto ed
  esito. L'esito (`completed` / `failed` / `skipped`, `null` se non si sa)
  **si deriva a lettura e non si scrive mai**: dallo stato del job, della
  review, della generazione Docs o del job di backlog che possiede la
  sessione; per le sessioni senza una riga con uno stato (voce di backlog,
  posta, brief, report) dall'ultimo `segment_end`. L'elenco accetta
  `?projectId=`; il filtro per esito lo fa il client sull'elenco ricevuto.
- **Dal ticket e dalle notifiche**: l'elenco accetta anche `?ticketId=` e
  `?aiJobId=`, e ogni riga porta `aiJobId`, così «Guarda la sessione» (§8.1) e
  la notifica di una domanda (§8.4) trovano la sessione giusta senza una
  rotta in più.

La durata la conta il **client** da `startedAt` (mai un numero calcolato dal
server, che invecchia in cache: stessa regola dei ticket fermi). La riga
dell'ultima azione («sta modificando `routes/tickets.ts`», «sta lanciando
`pnpm test`») la produce **una funzione pura in `@stubwise/shared`** che
traduce l'ultimo tool in una frase, usata da web e app: una regola in un
posto.

### 8.3 La vista di una sessione: una chat

- il testo dell'agente come messaggi in markdown, che si scrivono dal vivo;
- i tool come card compatte («Modifica `routes/tickets.ts`», «Esegue `pnpm
  test`») che si aprono su input e risultato, troncati ed espandibili;
- gli interventi del maintainer come messaggi dalla parte dell'utente, col
  nome. L'evento `input` porta `inputId` e `authorUserId`; il nome lo deriva
  il server a lettura (`authorName`), come per gli autori dei commenti: l'email
  dell'utente, `null` se non esiste più. Gli interventi non consegnati si
  vedono dall'elenco `inputs` del dettaglio (§6.2);
- i confini fra segmenti visibili («Piano pronto», «Ripreso dopo la
  risposta», «Esecuzione»);
- le domande `ask_user` **nel punto in cui l'agente le ha fatte**, come card
  coi bottoni. La risposta usa la **stessa rotta** di inbox, Slack e ticket,
  con le stesse regole su chi risponde (il richiedente, anche se `member`, o
  un maintainer): rispondere non è intervenire. Dopo la risposta il run
  riprende e lo stream continua nella stessa vista;
- il campo di scrittura in basso, solo per un maintainer, sui run abilitati
  (§6.4), a sessione viva. Il replay è la stessa vista senza campo.

Sull'app si caricano gli ultimi eventi e il resto scorrendo all'indietro.

### 8.4 Le notifiche

La notifica di una domanda dell'agente (inbox, push) apre la sessione sulla
domanda. Nessun kind di notifica nuovo: cambia solo dove porta l'azione
«apri». **DA VERIFICARE nel piano**: come lo fa oggi `openActionFor`
(`apps/mobile/src/lib/open-ticket.ts`) e l'equivalente web.

## 9. Deploy e rollback

Migrazione additiva: tabelle nuove `agent_sessions`, `agent_session_events`,
`agent_session_inputs`. Nessun `ALTER TYPE`, nessun kind di notifica, nessun
valore aggiunto a un enum esistente: niente della famiglia del 500 su
`/api/inbox`. Rebuild **server + worker + caddy**, ordine come le ultime
voci: prima il server (healthy + migrazione applicata), poi worker e caddy. Lo
schema drizzle del worker nuovo nomina le tabelle nuove; il worker vecchio
davanti allo schema nuovo è innocuo. L'app si aggiorna dagli store.

- **Server vecchio**: rotte 404. L'app è una per tutte le istanze, quindi la
  tab Agenti deve dire «non disponibile su questa istanza», né vuota né
  rotta (test che lo fissa). Va sceso col caddy come sempre.
- **Worker vecchio**: torna al formato di oggi; le sessioni smettono di
  nascere, quelle salvate restano leggibili.
- **Spegnere senza toccare immagini**: `AGENT_STREAMING=false`.
- Le tabelle sopravvivono a tutto.

## 10. I test che presidiano le invarianti

Negativi, e sulle righe, non solo sulla risposta:

- un `member` che scrive riceve 403 **e** nessuna riga in
  `agent_session_inputs`; stesso caso a due ruoli sugli stessi dati per
  `canWrite`, calcolato dal server;
- la sessione di una classificazione email è invisibile a un altro utente e a
  un admin, e visibile al proprietario (i due versi);
- un valore di un `.env` materializzato nel risultato di un tool non arriva
  mai in `agent_session_events` né nello stream;
- un errore di scrittura degli eventi non fa fallire il run;
- un `result` di interruzione seguito da un messaggio non chiude il run come
  fallito;
- la frase dell'ultima azione è la stessa funzione su web e app.

Le trappole note del repo: rotte letterali (`/api/agent-sessions/live`, se
esisterà) registrate prima di `/:id`; i campi nuovi letti dal web difesi con
`?? …`; fixture e doppi del client completi nei test dell'app; la guardia di
rete nei test del server.

## 11. Fuori da questo design

- Il ragionamento dell'agente (thinking): arriva vuoto in headless, e non è un
  requisito (decisione 6).
- Approvare a mano i permessi dei tool: i run restano con permessi decisi in
  anticipo.
- Annullare un run dalla sessione: è l'annullamento del job, che resta dov'è.
- Un worker multi-processo (§6.2).

## 12. Modifiche dal preflight dell'8 ott 2026

Il preflight del piano A
(`.superpowers/sdd/2026-10-08-agent-sessions-a-backend/preflight.md`) ha
confrontato piano e codice; il maintainer ha approvato queste correzioni.
Le sezioni toccate sopra sono già aggiornate.

- **H1 – `AGENT_STREAMING` arriva davvero al worker.** Il compose elenca le
  env del worker una per una: senza `AGENT_STREAMING=${AGENT_STREAMING:-true}`
  nel blocco del worker (e la voce in `.env.example`), il rollback di §7.1 e
  §9 sarebbe stato inerte in produzione.
- **H2 – Segreti: l'unione di tutti i `.env`, su ogni segmento, più chiave e
  variabili del runner (§5.5).** I `.env` sono nel worktree già prima del
  piano, un fix multi-repo ne ha più d'uno, e la credenziale del provider sta
  nell'ambiente del processo: oscurarne solo una parte lasciava un `env` o un
  `cat .env` leggibile a tutti per 14 giorni.
- **H3 – Docs solo in lettura in v1; viva se almeno un segmento è vivo
  (§6.4).** I nodi Docs girano in parallelo nella stessa sessione: colonne di
  segmento attivo uniche e un registro per sessione facevano vincere l'ultimo
  che scrive, con sessioni lette come finite mentre lavoravano e interventi a un nodo
  qualunque. Regola scelta: elenco `live_segment_ids` sulla sessione, ogni
  segmento toglie solo sé stesso, il segmento attivo si svuota solo a elenco
  vuoto, reset all'avvio del worker. Niente tabella dei segmenti.
- **H4 – Gli interventi non consegnati si vedono (§6.2, §8.3).** Senza una
  lettura di `agent_session_inputs` un `undelivered` restava invisibile,
  contro «mai perso in silenzio»: il dettaglio e il messaggio `session` dello
  stream portano `inputs` (`id`, `text`, `status`, `reason`, `authorUserId`,
  `createdAt`, più `authorName` derivato), `.default([])`.
- **H5 – Claim prima della consegna (§6.2).** La consegna partiva da quattro
  sveglie concorrenti e marcava la riga dopo aver scritto su stdin: lo stesso
  messaggio poteva arrivare due volte all'agente.
- **M1 – Lo stdout non si accumula in memoria.** Il runner in streaming legge
  lo stdout solo riga per riga (nessun buffer di execa) e tiene una coda
  limitata dello stderr; su un exit non-zero l'output è il testo dell'ultimo
  `result` più quella coda, non l'intero stream-json, che avrebbe gonfiato il
  log del job e il prompt del riassunto del fallimento.
- **M2 – Si potano anche gli eventi, e l'elenco guarda l'ultima attività
  (§5.4).** Una sessione di voce di backlog vive finché la voce riceve chat:
  i suoi eventi (e gli interventi) più vecchi di 14 giorni si potano da soli,
  e l'elenco filtra su `coalesce(last_event_at, started_at)`, la stessa
  espressione della potatura, invece che su `started_at`.
- **M3 – Stati: `queued` e `awaiting_approval`; la pausa Docs è `held`
  (§8.2).** Lo schema è nuovo: meglio decidere ora che aggiungere valori dopo.
  `working` copre anche il lavoro in corso fra due segmenti (install, test),
  che altrimenti sarebbe sembrato finito.
- **M4 – `outcome` derivato a lettura e filtro per progetto (§8.2).**
  `outcome` nullable e `.default(null)`, mai scritto; la sua fonte è lo stato
  della riga proprietaria o l'ultimo `segment_end`. Per derivarlo la sessione
  ha le FK facoltative `pr_review_id`, `doc_generation_id`, `backlog_job_id`.
- **M5 – `owner_key` resta, con un CHECK per la posta (§4).** La chiave unica
  regge l'idempotenza fra call site; la garanzia che conta a livello di
  database è che una sessione `email_message` abbia sempre il proprietario
  della casella.
- **M6 – Anche i riassunti scrivono nella sessione.** `plan_summary`,
  `failure_summary` e `pr_summary` passano da `apps/worker/src/summaries/*`,
  che ora ricevono la sessione: senza, sarebbero rimasti fuori dalla vista
  (decisione 3, «in vista ci vanno tutti»).
- **M8 – La sessione Docs prende progetto e titolo dal repository.**
  `doc_generations` ha solo `repository_id`; un aggiornamento automatico della
  documentazione (che può non avere una generazione) ha una sessione sua,
  chiavata sul job di aggiornamento.
- **M9 – L'intervento porta l'autore (§8.3).** `deliver(text, interrupt,
  { inputId, authorUserId })`; l'evento `input` porta i due id e il nome lo
  deriva il server, perché `users` non ha un nome: si mostra l'email, come
  per gli autori dei commenti.
- **M10 – Trovare la sessione di un ticket o di un job (§8.1, §8.4).**
  `aiJobId` nel riepilogo (nullable, `.default(null)`) e i filtri `?ticketId=`
  e `?aiJobId=` sull'elenco: senza, web e app non avevano modo di aprire «la
  sessione di questo job».
- **L1–L5 – Nomi veri del codice.** Gli helper di test (`seedTicket`
  restituisce `ticketId`), le colonne (`users` non ha `name`,
  `backlog_questions.asked_at`), gli import delle rotte (`routes/shared.js`) e
  il client (`createStubwiseClient`, `seg` da `query.js`, gruppo in
  `createEndpoints`, `streamPath`) erano sbagliati nel piano.
- **L6 – I nomi dei canali `NOTIFY` stanno in `@stubwise/shared`.** Erano
  scritti a mano in tre posti fra server e worker: un refuso avrebbe spento
  lo stream dal vivo senza un errore.
- **L7 – Un test a livello di database per l'oscuramento.** Oltre ai test del
  runner, uno che verifica che il valore non arrivi mai in
  `agent_session_events` (§10).
- **L8–L11 – Test e codice che non provavano niente.** Override del tick nella
  forma vera (`_internals?.x ?? impl`), test vuoti o senza asserzioni
  riscritti, e lo stream SSE che non perde più le notifiche arrivate durante
  una lettura (un flag «sporco» invece di aspettare il poll di 5 secondi).
- **L13 – Un indice sull'espressione dell'ultima attività**, usata dalla
  potatura a ogni tick e dall'ordinamento dell'elenco.
- **L14 – Nessuna attesa dopo il `result` per i run non interattivi.** Dove
  nessuno può scrivere, stdin si chiude subito: i 2 secondi di grazia si
  pagano solo dove servono, non su ogni classificazione di posta.
- **L15 – L'intervento finisce nei commenti del ticket, e quindi nei prompt
  successivi.** È voluto: un'indicazione data all'esecuzione vale anche per
  il self-repair e per i rilanci.
