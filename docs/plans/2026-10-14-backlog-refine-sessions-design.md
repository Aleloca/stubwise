# Sessioni di refinement del backlog

Data: 14 ott 2026. Stato: design approvato dal maintainer, una sezione alla
volta. Le premesse segnate «DA VERIFICARE» si controllano nel piano.

## 1. Il problema

Su una voce di backlog oggi si lavora con due strumenti: la chat a bottoni
(modalità DOCS, testo libero via RAG) e, in modalità CODE, una chat **a turni**
in cui ogni messaggio diventa un run `claude` separato su UNA repository, in sola
lettura, con la risposta mostrata come bolla. Il deep dive è un run singolo che
produce un JSON.

Il maintainer vuole poter **iniziare una sessione di Claude Code** su una voce:
una conversazione in streaming, nella stessa vista delle sessioni degli agenti
(`docs/plans/2026-10-08-agent-sessions-design.md`), in cui fare refinement della
voce e far scrivere all'agente il **design** e il **piano**, come farebbe con
Claude Code aperto in locale. La chat a bottoni, il deep dive e la modalità CODE
restano: questa è una porta in più, non un rifacimento.

## 2. Decisioni del maintainer

1. **Scrittura** (opzione 1): l'agente scrive design e piano **direttamente**,
   con dei tool; il valore precedente si conserva.
2. **Chi** (opzione 2): chiunque possa lavorare sul backlog del progetto —
   `member` compresi — avvia la sessione e ci scrive. È la prima sessione in
   cui un `member` scrive all'agente, ed è voluto: chi ha chiesto la voce è
   spesso chi ha più da dire.
3. **Vita** (opzione 1): la sessione si chiude dopo un periodo di inattività e
   si **riprende**: una sola sessione per voce, storia continua, ripresa con
   `--resume`. In più, un bottone **«Chiudi sessione»** per chiuderla quando si
   vuole.
4. **Codice** (opzione 1): **tutte** le repository del progetto, in sola
   lettura.
5. **Perimetro** (opzione 2): design, piano e i **metadati** della voce
   (titolo, effort, rischio con la sua nota, urgenza). Niente creazione,
   cancellazione o fusione di voci in v1.
6. **Tecnica** (strada B): la sessione è continua per l'utente, ma dietro le
   quinte **un turno per messaggio** che riprende la stessa conversazione CLI.
   Scartata la strada A (un processo `claude` sempre acceso): andrebbe contro la
   chiusura di stdin a fine risposta, il timeout totale del run e il recupero
   degli orfani, occuperebbe uno slot e memoria a vuoto, e un riavvio del worker
   la ucciderebbe comunque.

### Cosa NON cambia (i due divieti dell'operatore)

Un piano scritto su una voce di backlog **non è un piano approvato**. La
conversione in ticket e il run che segue passano dal gate di sempre
(`apps/server/src/services/jobs.ts`): un `member` che scrive il piano in una
sessione di refinement non lo approva, e niente in questa funzione tocca
`resolvePlan`/`preApprovePlan`/`revokePlanApproval` né il rilascio.

## 3. Ciclo di vita e dati

### 3.1 Una sessione per voce, continua nel tempo

Ogni voce di backlog ha **al più una** sessione di refinement:

- una sessione dell'agente di tipo nuovo **`backlog_refine`**, con
  `owner_key = backlog_refine:<itemId>`. È SEPARATA dalla sessione
  `backlog_item` di oggi (che ospita deep dive, stime e turni della chat CODE):
  il relay degli interventi sceglie il processo per id di sessione
  (`apps/worker/src/sessions/relay.ts`, `handleFor` prende l'ultimo
  registrato), e con una sessione condivisa un messaggio potrebbe arrivare a un
  deep dive;
- una riga in una tabella nuova **`backlog_refine_sessions`**: `item_id`
  (UNIQUE, `ON DELETE CASCADE`), `agent_session_id`, `status`
  (`active`/`closed`, CHECK), `cli_session_id` (nullable), `started_by_user_id`
  (FK `ON DELETE SET NULL`), `last_activity_at`, `closed_at`, `closed_reason`
  (`user`/`idle`/`item_closed`, CHECK, nullable).

Riprendere una sessione chiusa **riapre la stessa riga e la stessa sessione**: la
trascrizione resta una, e il CLI riparte con `--resume` dal `cli_session_id`.

### 3.2 Cosa succede a un messaggio

Lo decide il **server**, e la regola è che **un messaggio non si perde e non
finisce mai `undelivered`**:

1. **L'agente sta lavorando** (sessione viva, segmento attivo che accetta
   input): il messaggio è un **intervento** normale, entra nel turno in corso e
   si vede quando il CLI lo prende (eco con `uuid`, come oggi).
2. **L'agente è fermo** (sessione attiva ma non viva, o chiusa su una voce
   aperta): il messaggio diventa un **turno nuovo**. Nella stessa transazione il
   server scrive l'input in `agent_session_inputs` e un `backlog_jobs`
   `kind = refine_turn` con payload `{ itemId, inputId }`, e se la sessione era
   chiusa la riapre (`status = active`, `closed_*` azzerati).
3. **Caso limite**: il messaggio arriva come intervento mentre il turno sta
   finendo, e il relay non riesce più a consegnarlo (`stdin_closed`, o nessun
   processo registrato). Per le sessioni `backlog_refine` il relay **non** lo
   marca `undelivered`: accoda un `refine_turn` con quell'input. È l'unica
   regola del relay che cambia, e solo per questo tipo.

Il turno usa l'input come messaggio d'apertura: il worker lo marca
`delivered` alla scrittura su stdin e l'evento `input` nasce all'eco, come per
gli interventi (regola 8 di `buildTranscript` invariata).

I turni della stessa voce passano da un serializer **per voce** (lo stesso
schema di `chat-turn-poller.ts`), **mai** da quello del progetto: una sessione
aperta non blocca fix, review né Docs. Il serializer del progetto si usa solo
per il tempo di aprire i worktree, come la chat CODE di oggi.

### 3.3 Fine della sessione

- **Inattività**: uno sweep (cadenza 60 s, come `sweepCodeSessions`) chiude le
  sessioni con `last_activity_at` più vecchio di
  `BACKLOG_REFINE_IDLE_MINUTES` (default 30) e nessun turno in coda o in corso:
  `closed_reason = idle`, worktree smontati.
- **«Chiudi sessione»**: lo stesso, subito. Un turno in corso viene interrotto
  e chiuso come annullato; un `refine_turn` ancora in coda passa a `failed` con
  un messaggio da template.
- **Voce convertita in ticket o archiviata**: la sessione si chiude con
  `item_closed` e da lì non si riapre (409 `item_closed`). Va fatto negli
  stessi punti che oggi chiudono la sessione CODE e le domande di backlog.

### 3.4 I worktree

Al primo turno si apre un worktree **per ogni repository del progetto**, in una
cartella comune (una sottocartella per repository, `mirrorSlug` come in
`withProjectWorktrees`), dalla head del default branch, su un branch effimero
`stubwise/backlog-refine-<sessionId>` che non si pusha mai. Restano aperti
finché la sessione è attiva, in un registro in memoria (lo schema di
`code-session.ts`: `itemId → { sessionId, parentDir, cliSessionId, remove }`).
`withProjectWorktrees` è a callback e non va bene per un handle lungo: serve
un'apertura «lunga» di N worktree con la sua pulizia (helper nuovo in
`MirrorManager`, o N `openWorktree` con la `dir` imposta).

**Riavvio del worker**: il registro si svuota; il turno successivo riapre i
worktree e riprende con `--resume` dal `cli_session_id` salvato. DA VERIFICARE
che `--resume` funzioni dopo un riavvio (i file di sessione del CLI devono
stare su un volume persistente, `claude-config`?) e con una cwd ricreata nello
stesso percorso. Se il resume fallisce, il turno riparte **con il prompt
d'avvio** (§4.1) più gli ultimi messaggi della trascrizione, e riscrive
`cli_session_id`.

Avvertenza nota (`mirrors.ts`): un `fetch --prune` di un altro job dello stesso
progetto può potare un ref `stubwise/*` di un worktree vivo. Senza commit è
innocuo; il worktree resta leggibile.

## 4. Il turno e i tool di scrittura

### 4.1 Il turno

Ogni turno è un segmento nuovo **`refine`** della sessione `backlog_refine`:

- **interattivo** (`INTERACTIVE_SEGMENTS`): accetta messaggi finché il CLI
  lavora, con la grazia di sempre a fine risposta (`RESULT_GRACE_MS`);
- con un tipo di deliverable nuovo in `SEGMENT_DELIVERABLE`, **`conversation`**:
  non si chiude agli input al primo `result` riuscito (a differenza di
  `"output"`), e **non** si accoda `DELIVERABLE_REMINDER` agli interventi —
  qui il deliverable è la conversazione, non c'è un output finale da
  proteggere;
- timeout per turno `BACKLOG_REFINE_TURN_TIMEOUT_MS` (default 15 min);
- `pauseKey = backlog_refine:<sessionId>:<jobId>`: il tetto della pausa vale
  per turno.

Il **prompt d'avvio** (primo turno, o ripartenza senza `--resume`) contiene: la
voce (titolo, testo originale, design e piano attuali, metadati), le repository
aperte e dove stanno, le ultime decisioni del registro del progetto, e il
mandato:

- discutere con le persone, leggere il codice per fondare le risposte;
- fare domande **scrivendo in chat** — niente `ask_user`: la conversazione è già
  il canale;
- salvare design, piano e metadati **con i tool** quando sono maturi, e dirlo;
- non concludere il lavoro da solo: il turno finisce con una risposta a chi
  scrive.

Un turno successivo con `--resume` riceve solo il messaggio.

### 4.2 Sola lettura per costruzione

Non la plan mode: blocca i tool MCP di scrittura (vedi «Fase 1» nel CLAUDE.md:
servirebbe un `readOnlyHint` falso) e fa ragionare l'agente in termini di
«uscire dal piano». Il turno gira con `permissionMode: "default"` e un
`allowedTools` **chiuso**: `Read`, `Grep`, `Glob`, i tool del grafo
(`GRAPHIFY_AGENT_ALLOWED_TOOLS`) e i tre tool di scrittura. Niente `Edit`,
`Write`, `Bash`, `WebFetch`: in `-p` un tool fuori elenco è rifiutato, perché
nessuno lo approva. DA VERIFICARE con la versione pinnata del CLI
(`2.1.287`) che un tool non elencato sia davvero negato e non chiesto.

**Plugin**: il turno entra nel perimetro plugin come la chat di analisi
(`openRunPlugins`, `--setting-sources ""`): `superpowers` porta brainstorming
e writing-plans, che qui servono. Il contratto del plugin base
(`apps/worker/plugins/`) aggiunge che, in una sessione di refinement, design e
piano **non sono file del repository**: si salvano con i tool.

### 4.3 I tre tool

`set_design(markdown)`, `set_plan(markdown)`,
`update_item({ title?, effort?, risk?, riskNote?, urgency? })`.

- **Server MCP stdio bundlato nel worker**, come `ask_user`
  (`apps/worker/src/refine-mcp/`), avviato via `--mcp-config` +
  `--strict-mcp-config`.
- **Ponte**: il worker apre un endpoint HTTP **solo su loopback** e passa al
  server MCP, via env, l'URL e un **segreto casuale per turno**. Il server MCP
  non vede il DB né credenziali (`buildAgentEnv` continua a negare
  `DATABASE_URL`/`ENCRYPTION_KEY`/`SESSION_SECRET`). Il segreto finisce nel
  file temporaneo della config MCP: vale solo per quel turno e solo per quella
  voce, e il worker lo invalida a fine turno.
- Il worker **valida**: segreto e turno vivi, sessione `active`, voce aperta,
  lunghezze massime, valori ammessi (gli schemi dei metadati sono quelli delle
  rotte). Poi scrive e risponde **subito** all'agente: «salvato» o l'errore
  preciso, così l'agente può correggersi nello stesso turno.
- **Stesse regole delle rotte di oggi**, estratte in un modulo condiviso fra
  server e worker (`packages/notifications`, come le altre regole condivise):
  il primo design preserva il testo originale in `origin_content` (una volta
  sola), il piano sostituisce `implementation_plan`, i metadati passano dagli
  stessi campi di `PATCH /api/backlog/:id`. Le rotte vengono riscritte su quel
  modulo: mai due copie.
- **Ogni sovrascrittura dell'agente salva il valore precedente** in una tabella
  nuova **`backlog_item_revisions`** (`item_id` CASCADE, `field`, `previous`
  jsonb, `agent_session_id`, `created_at`), nella stessa transazione. In v1 è
  una rete di sicurezza recuperabile a mano; un «ripristina» nella UI si
  aggiunge se serve.
- Dopo ogni scrittura una notifica (`pg_notify` della sessione), così la pagina
  della voce e il riquadro della sessione (§6) si aggiornano. Nella trascrizione
  la chiamata è una normale card del tool.

## 5. Permessi, API e stato

### 5.1 Avvio e chiusura

Rotte del backlog, `requireAuth`: chiunque possa lavorare sul backlog, come la
chat di oggi.

- `POST /api/backlog/:id/refine-session` — crea o riapre la sessione, risponde
  con l'id della sessione dell'agente. Non fa partire niente da sola, salvo un
  `message` facoltativo nel body, che diventa il primo turno (§3.2 caso 2).
  409 `item_closed` su una voce convertita o archiviata.
- `DELETE /api/backlog/:id/refine-session` — «Chiudi»: interrompe il turno in
  corso, chiude, smonta i worktree. Idempotente (204).

### 5.2 Scrivere nella sessione

La rotta di sempre, `POST /api/agent-sessions/:id/messages`. Il
`preHandler: requireAdmin` diventa un **controllo per tipo dentro il servizio**
(`sendAgentMessage`): per `backlog_refine` può scrivere chiunque possa lavorare
sul backlog del progetto; per **ogni altro tipo resta solo admin**, invariato.
Il controllo va scritto in UN posto, e la regola «quali tipi aprono la
scrittura ai member» è un elenco esplicito in `@stubwise/shared` accanto a
`INTERVENABLE_SESSION_KINDS` (un tipo nuovo non la eredita per default).

Test **negativi a due ruoli**, che asseriscono sulle righe e non solo sullo
status: un member scrive in una `backlog_refine` (riga creata); lo stesso
member su una `ai_job` riceve 403 e nessuna riga `agent_session_inputs` nasce.

### 5.3 Permessi derivati dal server

I client li leggono, non li deducono (stesso criterio di `canMerge`):

- `canWrite`: per `backlog_refine` vero su una sessione **attiva o chiusa su una
  voce aperta** (scrivere la riprende), per chi può scrivere (§5.2);
- `canInterrupt`: solo con un turno vivo, regole di oggi;
- **`canClose`** (nuovo, `.default(false)`): sessione `active`, per chi può
  scrivere.

### 5.4 Stato

Per `backlog_refine` lo stato derivato
(`deriveAgentSessionState`) è: `working` (viva), `queued` (un `refine_turn`
in coda), **`idle`** (nuovo: attiva ma ferma — «pronta, scrivi per
continuare»), `ended` (chiusa). `idle` è un valore nuovo su un enum che l'app
legge: passa da `readerSchema` (un'app vecchia lo vede `UNKNOWN`); sul web va
difeso nel punto di lettura. `possiblyActiveSql` va tenuto d'accordo (una
sessione `idle` è nell'elenco delle attive? sì: è aperta).

### 5.5 Costi e limiti

- **Budget mensile**: lo controlla ogni turno al claim. Oltre il budget il turno
  non parte e nella trascrizione compare un messaggio da template. Stessa
  regola delle correzioni (`correctionManualTrigger`): il messaggio di un admin
  passa, quello di un member no.
- **Concorrenza**: i `refine_turn` li prende il poller veloce della chat
  (2 s), con un tetto d'istanza `BACKLOG_REFINE_MAX_CONCURRENT` (default 2);
  quelli in più aspettano in coda e la sessione si mostra `queued`.
- **Orfani**: un `refine_turn` `running` oltre la soglia (la formula di
  `chatTurnStaleMinutes` sul timeout del turno, pausa compresa) diventa
  `failed`, senza retry, con un messaggio da template nella trascrizione.
- **Retention**: quella delle sessioni (14 giorni dall'ultima attività,
  `pruneAgentSessions`). Una sessione potata e poi «ripresa» rinasce vuota con
  il prompt d'avvio: va bene, design e piano stanno sulla voce.

### 5.6 Cosa non c'è

Nessuna notifica in inbox, nessun commento su ticket (la voce non ha un
ticket). La sessione è visibile a tutti gli utenti autenticati, come le altre.

## 6. Interfaccia

### 6.1 Web

- **Pagina della voce** (`apps/web/src/routes/backlog/$id.tsx`): un bottone
  «Sessione di refinement». Senza sessione o a sessione chiusa: «Inizia
  sessione» / «Riprendi sessione», con un campo per il primo messaggio. Con
  una sessione attiva: lo stato («l'agente sta lavorando» / «pronta») e il
  link alla sessione.
- **Vista della sessione** (`/agents/:id`), tre aggiunte:
  1. il composer montato con `canWrite` anche in `idle` (scrivere avvia il
     turno);
  2. «Chiudi sessione» con `canClose`, con conferma;
  3. un **riquadro della voce** in testa (design, piano, metadati attuali,
     link alla voce), che si aggiorna quando l'agente scrive.
- La chat a bottoni, il deep dive e la modalità CODE restano dove sono.

### 6.2 App

- **`BacklogItemScreen`**: lo stesso bottone; apre `AgentSession` sul root
  stack via `openAgentSession`, come le altre sessioni.
- **`AgentSessionScreen`**: le stesse tre aggiunte del web.
- L'app si aggiorna dagli store: contro un server senza la funzione (404 SENZA
  `code` sulla rotta d'avvio) il bottone non compare. Valgono le regole delle
  sessioni nell'app: niente su AsyncStorage (`shouldPersistQuery`), stream
  vivo solo a schermata a fuoco.

## 7. Test

- **Worker**: messaggio a sessione ferma → turno; messaggio rifiutato dal relay
  → turno, mai `undelivered` (e per gli altri tipi resta `undelivered`);
  `--resume` e ripartenza col contesto; sweep di inattività (non chiude con un
  turno in coda); «Chiudi» che interrompe il turno; ponte dei tool (segreto
  sbagliato o scaduto rifiutato, voce chiusa rifiutata, revisione salvata,
  regole di `origin_content`); `allowedTools` senza `Edit`/`Write`/`Bash`;
  budget a due ruoli.
- **Server**: scrittura a due ruoli in entrambi i versi; `canWrite` in `idle`,
  `canClose`; stato `idle`/`queued`; avvio e chiusura (409 `item_closed`,
  idempotenza); le rotte del design/piano/PATCH riscritte sul modulo condiviso
  passano i loro test di oggi senza modifiche.
- **Web e app**: fixture **senza** i campi nuovi (`canClose`, `idle`) per
  provare i default; i bottoni secondo i permessi; il doppio del client
  dell'app completato coi metodi nuovi prima dei test.
- **Golden** (manuale, `apps/worker/scripts/golden/`): scenario nuovo
  `refine`, 3 lanci — l'agente salva design e piano coi tool e non scrive
  file, risponde in chat alle domande senza chiudere il lavoro da solo, un
  messaggio a metà turno è assorbito.

## 8. Deploy e rollback

**Migrazione additiva**:

- tabelle nuove `backlog_refine_sessions` e `backlog_item_revisions`;
- CHECK `agent_sessions_kind_chk` allargato a `backlog_refine`;
- `refine_turn` su `backlog_job_kind`, che è un **pgEnum**: `ALTER TYPE … ADD
  VALUE` in uno statement a sé e mai usato nella stessa migrazione (trappola
  delle migrazioni batch);
- se `active_segment_label` o gli eventi hanno un CHECK sulle etichette dei
  segmenti, allargarlo a `refine` (DA VERIFICARE).

**Ordine**: prima il server, poi la verifica della migrazione, poi worker e
caddy — con il worker senza lavoro dell'agente in corso (il controllo
d'inattività in più campioni, sessioni vive comprese).

**Rollback**:

- server vecchio: la rotta d'avvio è 404, il bottone sparisce (sul web perché
  il caddy scende insieme, nell'app per il 404 senza `code` di §6.2), le
  sessioni già fatte restano leggibili come sessioni d'archivio; ma un enum
  `kind` sconosciuto nella risposta di `/api/agent-sessions` — DA VERIFICARE
  che il server vecchio serializzi una riga `backlog_refine` senza un 500
  sull'intero elenco (stessa famiglia di `project.pulse` in fase 2): se non
  la serializza, prima di scendere si cancellano le sessioni `backlog_refine`;
- worker vecchio: i `refine_turn` restano in coda senza consumatore. Prima di
  scendere: `update backlog_jobs set status='failed' where kind='refine_turn'
  and status in ('queued','running');` e chiudere le sessioni
  (`update backlog_refine_sessions set status='closed', closed_reason='user',
  closed_at=now() where status='active';`).

La voce di deploy va aggiunta al CLAUDE.md insieme alla funzione.
