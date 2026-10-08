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

Tabella nuova `agent_sessions`, con un owner per tipo e un CHECK «esattamente
uno valorizzato», sullo stesso modello di `agent_runs` (che resta com'è: è la
contabilità dei consumi per `(job, fase, modello)`, non un handle di
sessione). **DA VERIFICARE nel piano**: l'elenco degli owner e dove ogni tipo
di run nasce oggi, in particolare la chat del backlog (un turno per job) e la
generazione Docs (decine di run, a volte in pausa per ore).

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
stamperebbe nello stream, visibili a tutti per 14 giorni. Il worker conosce i
valori che ha materializzato e **li sostituisce con `•••` in ogni evento
prima di salvarlo o inoltrarlo**, parziali compresi. Non è una difesa
completa (un valore derivato, codificato o spezzato fra due eventi parziali
passa), e la guida lo dice. Si oscurano solo valori di lunghezza minima
ragionevole, per non trasformare un `1` o un `true` in `•••` ovunque.

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
(`pending`) e fa `NOTIFY`; il worker che possiede il processo la scrive su
stdin e la marca `delivered`.

- Run già finito → **409 `session_ended`**, niente scritto.
- Run finito o worker riavviato dopo la scrittura → la riga diventa
  `undelivered` e la vista lo dice: mai perso in silenzio.
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
esecuzione, self-repair, correzione, deep dive, chat del backlog, review,
generazione Docs. Un tipo di run nuovo non entra da solo. Un job fermo su una
domanda (`awaiting_input`) non ha un processo vivo: lì il campo non c'è, c'è
la domanda (§8.3).

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

- **Al lavoro ora**: tipo di run, progetto/ticket, da quanto gira, stato
  (lavora / aspetta una risposta / in pausa per limite / in coda), e la riga
  con l'ultima azione.
- **Concluse**: replay degli ultimi 14 giorni, filtrabile per progetto ed
  esito.

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
  nome;
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
