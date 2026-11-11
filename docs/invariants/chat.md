# Chat fra persone (area 4)

Design: `docs/plans/2026-11-10-integrazione-area4-chat-design.md`. Fetta 1
(10 nov 2026): i canali di PROGETTO aperti, cioè il «general» e quelli
creati. Fetta 2 (10 nov 2026, piano
`docs/plans/2026-11-10-integrazione-area4-fetta2-plan.md`): DM, privati,
generali d'istanza, ricerca, domande, task e richieste nate da un messaggio.
Il codice sta in `apps/server/src/chat/`; le rotte in
`apps/server/src/routes/chat.ts`, sotto `/api/chat`.

## Chi vede, chi legge, chi gestisce: UN posto

`apps/server/src/chat/access.ts` è l'unico posto della regola (quella di
`data/chat/visibility.ts` del prototipo). Lista, lettura, stream, ricerca,
menzioni, domande e card d'inbox passano tutti da lì. **Vedere** un canale
vuol dire sapere che esiste (nome e membri); **leggerlo** vuol dire i
messaggi. Sono due cose diverse, e la seconda non discende dalla prima:

- un **aperto di progetto** lo vede e lo legge chi vede il progetto;
- un **aperto generale** (senza progetto) lo vedono e lo leggono tutti;
- un **privato** lo leggono solo i suoi membri. Chi gestisce quell'ambito
  (`chat.channels.manage` nel progetto, `chat.general.manage` per i generali,
  quindi anche il full admin) lo **vede** ma **non lo legge** (D2): riceve
  nome e membri, mentre argomento, descrizione, attività, messaggi, thread,
  stream e ricerca gli rispondono vuoti o 404. Un privato di progetto
  sparisce anche per un membro che non vede più il progetto;
- un **DM** esiste solo per chi partecipa, **nemmeno per il full admin**
  (D2). Per tutti gli altri è 404, e non compare in nessuna lista.

Un canale che non si vede risponde **404**, come uno che non esiste, e lo
stesso vale per un canale che si vede ma non si legge, sulle rotte dei
messaggi. Le due WHERE sono `channelVisibleSql` e `channelReadableSql`: chi
aggiunge una lettura di messaggi usa la seconda.

Del «general» di un progetto sono membri tutti quelli che vedono il progetto:
è un dato **derivato**, mai copiato in `chat_channel_members`, così chi entra
nel progetto ci scrive subito e chi ne esce smette subito.

**Chi fa cosa** (`channelAccess`, la `channelPermissions` del prototipo):
- **scrive** un membro, in un canale non archiviato;
- **nome, descrizione e archiviazione** li cambia il creatore o chi gestisce
  l'ambito;
- l'**argomento** lo cambia qualunque membro;
- **elimina** solo chi gestisce l'ambito, non il creatore (R-G3);
- **invita**: in un privato il creatore o chi gestisce, ma mai sé stesso
  (altrimenti «chi gestisce non legge» si aggirerebbe con un clic); in un
  aperto qualunque membro. Può entrare solo chi può stare nell'ambito: chi vede
  il progetto, o chiunque per un generale;
- **toglie** il creatore o chi gestisce. Un privato non resta mai senza
  membri (409 `last_member`);
- un **DM a due non si lascia**; da un gruppo si esce, e la sua `dm_key`
  segue chi resta;
- nel **«general»** e in un **DM** nessuno entra, esce, invita o toglie a
  mano, e il «general» non lo gestisce nessuno (409 `general_channel`).

Il client legge `canRead`, `canWrite`, `canInvite`, `canDelete` e gli altri
permessi calcolati dal server, e non li deduce. `canManage` resta per i client
della fetta 1 e vuol dire «almeno un'azione di gestione».

**I nomi sono unici solo fra i canali NON privati** (in un progetto, e fra i
generali). Se lo fossero anche fra i privati, un 409 `name_taken` direbbe a chi
non lo vede che quel privato esiste: crei `#hiring-plan` e scopri che c'è (D2,
review della fetta 2, scelta dell'orchestratrice). Due privati, o un privato e
uno aperto, possono quindi avere lo stesso nome.

**Le uscite e le rimozioni si mettono in fila sul canale**: `leave` e
`removeMember` prendono il lock della riga del canale (`SELECT … FOR
UPDATE`) e rileggono i membri DOPO il lock. Senza, due uscite insieme leggono
lo stesso conteggio: un privato resta a zero membri, o un DM resta con una
`dm_key` vecchia e chi ne è uscito non ritrova più il DM con gli altri.
`openDm` riapre un DM solo se i suoi membri sono esattamente quelle persone,
anche se la chiave combacia. Il test di concorrenza (`chat-review.test.ts`)
tiene le due uscite ferme su un lock e le rilascia insieme.

**Un DM si ritrova dalle sue persone**: `dm_key` sono i loro id ordinati.
`openDm` riapre il DM più vecchio con quella chiave, e due aperture uguali in
contemporanea si serializzano con `pg_advisory_xact_lock`. La chiave non è
unica, ed è voluto: un gruppo da cui qualcuno è uscito può coincidere con un
DM che c'è già.

## Il «general» nasce col progetto, da un trigger

Il trigger `projects_chat_general` (`AFTER INSERT ON projects`, 0135) crea il
«general» nella STESSA transazione che crea il progetto. Copre così ogni punto
che inserisce un progetto (la rotta, gli script, i seed dei test), non solo la
rotta. L'indice unico parziale `chat_channels_one_general_idx` ne garantisce
uno solo per progetto, e la funzione usa `ON CONFLICT DO NOTHING`.

Il costo è stato misurato il 10 nov 2026: circa 0,25 ms per progetto (1000
inserimenti, 1898 ms col trigger e 1644 senza). I test che creano progetti in
serie non ne risentono.

Eliminare un progetto porta via i suoi canali in cascata, e con loro messaggi,
reazioni, letture, preferenze e follow. Una card di menzione resta, senza
link (vedi sotto). Lo verifica il test «eliminare il progetto» di
`routes/chat.test.ts`.

## Un messaggio eliminato non ha più testo

Eliminare scrive `body = ''`, ed è garantito da un CHECK (`deleted_at IS NULL
OR body = ''`). È la stessa regola dei commenti dei ticket: ogni lettore di
`body` smette da solo di vederlo. Si modificano e si eliminano solo i propri
messaggi (403 `not_yours`).

## Le menzioni e le domande le decide il server

- I `mentionedIds` li deriva il server dal testo. Un `@Nome` vale solo se
  `Nome` è il `personName` di qualcuno che LEGGE il canale. Chi scrive è
  escluso. Il client non li manda. I nomi più lunghi si cercano prima, e ogni
  nome trovato **consuma** il suo tratto di testo: «@Ale Loca» non avvisa anche
  «Ale».
- Chi è stato avvisato per un messaggio resta in `notified_ids`: una menzione
  tolta e rimessa con una modifica non manda una seconda card. Chi viene
  nominato con una modifica segue il thread, come alla scrittura.
- In un DM, che non ha nome, card e push dicono «in un messaggio diretto»
  invece di «in #» (`isDirectMessageEvent`).
- **Una domanda** (`asks_reply_of`, fetta 2): un messaggio che nomina
  qualcuno e finisce con «?», o con «Ask for a reply» forzato (`asksReply`).
  A un **membro** arriva una card `chat.question` e una voce in «Da decidere»
  (`GET /api/chat/questions`). A chi legge senza esserne membro arriva una
  `chat.mention`, perché da lì non risponderebbe. La voce esce quando la
  persona risponde (nel thread, o nel canale per un messaggio del canale),
  quando la ignora (`chat_dismissed_questions`), quando il canale è archiviato,
  quando il messaggio viene eliminato o quando una modifica toglie il nome. È
  una lettura derivata, nessun job la chiude. Le domande della Chat **non**
  sono decisioni del progetto: non toccano il registro decisioni.
- `@channel` e `@reparto` non avvisano nessuno (R-G6): nessuna card, nessuna
  push. Contano solo fra le menzioni del canale, e solo con il livello
  «tutti» (`countsOf`).
- Una card `chat.mention` per persona nominata, con push, nella STESSA
  transazione del messaggio. Una modifica avvisa solo chi viene nominato per la
  PRIMA volta: chi era già nominato non riceve una seconda card.
- Chi viene nominato in un thread comincia a seguirlo (`chat_thread_follows`).

## La card d'inbox si DERIVA a lettura

Vale per `chat.mention` e `chat.question`. Nel jsonb della notifica ci sono solo gli id (`chatMessageId`, `channelId`) e
il testo vero al momento della publish (`channelName`, `authorName`). Il blocco
`chat` della card (canale, messaggio, radice del thread, autore, estratto) e
l'url `/app/#/chat/…` li ricostruisce `chatMentionsFor`
(`apps/server/src/chat/service.ts`) a ogni lettura. Lo fa con la regola di
LETTURA (chi è tolto da un privato perde anche il link), e con una query per
pagina, non una per card.

Se il messaggio è eliminato, il canale non si vede più o il progetto non c'è
più, `chat` è `null`, `objectGone` è `true` e la card non ha url. È
l'invariante trasversale «i campi che un client legge su una card si derivano
a lettura» (CLAUDE.md).

## Non letti, livelli e il punto del binario

`countsOf` (`apps/server/src/chat/service.ts`) è la regola del prototipo:
- i **non letti** sono i messaggi del flusso dopo la lettura del canale, non
  propri, quelli di sistema compresi. Con «solo menzioni» contano solo quelli
  rivolti a chi guarda, con «silenziato» nessuno;
- in un **DM** ogni messaggio di una persona è rivolto a chi partecipa;
- il **punto del binario** (`signalOf`) si accende solo per ciò che è rivolto
  proprio a chi guarda (menzioni dirette, domande, DM non silenziati) e per i
  thread seguiti con risposte nuove, nei canali non archiviati. Il traffico
  normale dei canali e `@channel` no: con molti progetti il punto sarebbe
  sempre acceso.

**Letto fino a**: un `at` esplicito vale com'è, anche più vecchio («Mark
unread from here» riporta indietro il segno). Senza `at`, il segno va
all'ultimo messaggio del canale (o del thread), con l'ora del DATABASE: mai
`new Date()` del server, e mai `greatest`, che impedirebbe di tornare
indietro.

Si modifica e si elimina solo in un canale non archiviato, e si modifica solo
da membro che scrive. Seguire un thread è da membro.

Il **flusso** del canale sono le radici più le risposte mandate «anche nel
canale» (`also_in_channel`). Un messaggio eliminato senza risposte vive e più
vecchio di un giorno **sparisce** dal flusso, dal thread e dalla ricerca
(`goneSql`, a lettura, senza potatura); con risposte resta come «Message
deleted».

## La ricerca

`searchChat` cerca solo nei canali che chi guarda **legge**
(`channelReadableSql`): un privato di cui non è membro, anche se lo gestisce,
e un DM altrui non ci sono mai. Gli archiviati sì, gli eliminati mai. Ogni
parola (da 2 caratteri in su) deve comparire come **sottostringa** in
`search_folded` (vedi il deploy-log per il ripiegamento dopo un rollback), il testo senza maiuscole né accenti che il server scrive a
ogni scrittura (`foldChatText`, NFD). Non è il full-text inglese dei ticket:
lo stemming inglese su testo italiano cambierebbe i risultati, e il prototipo,
che è la specifica, cerca sottostringhe. L'indice è un GIN trigram
(`pg_trgm`).

## Task e richieste nate da un messaggio

`chatMessageId` su `POST /api/tasks` e `POST /api/requests`. Chi crea la task
o la richiesta deve **leggere** il messaggio, e il messaggio non dev'essere
eliminato (`messageLinkable`). Il percorso di creazione resta quello di
sempre, coi suoi permessi.
- Per una **task**, il legame (`chat_message_links`) si scrive nella stessa
  transazione della task.
- Per una **richiesta**, viaggia nel payload dell'intake e lo scrive il
  **worker** a fine intake (`apps/worker/src/backlog/chat-link.ts`), anche
  quando la richiesta viene fusa in una che c'era. È fail-open: un legame non
  scritto non ripete l'intake, che creerebbe un doppione.

Il codice («→ AUD-14») si **deriva a lettura** (`linksOf`) con la regola
delle task (`visibleTasksCondition`) e quella delle richieste
(`requestVisibility`): un codice che chi guarda non vede non esce. Un
messaggio eliminato non annuncia più niente, e la task resta.

## Lo stream: cursore intero in microsecondi

`GET /api/chat/channels/:id/stream?after=<cursore>` è un SSE che rilegge
visibilità e utente a ogni giro, e si apre solo a chi **legge** il canale.
Non ricontrolla invece la SESSIONE a ogni giro (una sessione chiusa resta
collegata finché la connessione vive), come lo stream delle sessioni degli
agenti: accettato, perché utente e visibilità li rilegge comunque.

- **Senza `after`** lo stream non rimanda la storia, che la carica la pagina: il
  cursore parte dall'ultimo cambio del canale, e nessun messaggio arriva.
- **La finestra di sovrapposizione**: `updated_at = now()` è l'INIZIO della
  transazione che scrive, e una transazione lunga può committare un
  `updated_at` più vecchio del cursore già mandato. Ogni giro rilegge quindi
  da cursore meno 5 secondi (`CHAT_STREAM_OVERLAP_MICROS`), e la connessione
  tiene `seen` (id → `updated_at`) per non rimandare ciò che è già partito. Il
  renderer deduplica comunque.
- Il frame `channel` parte solo se la vista è cambiata.
- `after` oltre il `bigint` è 400. Il cursore di pagina (`before`) è
  `<µs di created_at>|<id>`, opaco per il client, e uno malformato è 400. Il cursore è `updated_at` in **microsecondi
interi**, come testo di sole cifre (`CHAT_STREAM_CURSOR_RE`), e il confronto si
fa in SQL. Un `Date` di JS tronca ai millisecondi, e due messaggi nello stesso
millisecondo si perderebbero. Ogni scrittura su un messaggio (modifica,
eliminazione, reazione) aggiorna il suo `updated_at`, e una risposta aggiorna
anche quello della radice, il cui conteggio cambia. Il bus (`chat/bus.ts`) usa LISTEN/NOTIFY sul canale Postgres
`chat_channel` e serve solo a svegliare lo stream prima del poll di 5 secondi:
se manca, lo stream resta corretto, solo più lento.

## @Claude nella Chat (fetta 3)

Piano: `docs/plans/2026-11-10-integrazione-area4-fetta3-plan.md`. Codice:
`apps/server/src/chat/claude.ts`, le proposte in
`apps/server/src/claude-actions/proposals.ts`, il turno in
`apps/worker/src/claude-chat/{turn,mention,prompts}.ts`.

- **Ogni «@Claude» è una chiamata NUOVA di chi la scrive**, con i suoi permessi
  e senza altri controlli: ne risponde lui. La risposta nasce SUBITO, nella
  transazione del messaggio, nel thread di quel messaggio (anche da una
  radice). È un messaggio `kind claude` con autore l'utente di sistema Claude
  e `called_by` chi chiama. Una modifica che aggiunge «@Claude» non chiama, e
  «@Claude» non è una menzione da avvisare.
- **Una sessione per chiamata, PRIVATA di chi chiama** (kind `chat_mention`,
  con la sua riga in `claude_conversations`). Gli eventi dei tool («cosa ha
  letto») li legge solo lui (D5): `visibleTo` esclude `chat_mention` come
  `free`, e la vista del messaggio dà `sessionId` solo a lui. Le chiamate non
  compaiono fra le conversazioni della destinazione «Claude»
  (`isConversation`).
- **Il contesto lo costruisce il SERVER** alla chiamata: il thread prima della
  chiamata, come lo legge chi chiama (niente eliminati, citazioni che vede), e
  nel prompt è marcato come DATO scritto da altre persone. La difesa vera
  contro un'istruzione nel thread è la classe B: niente succede senza la
  conferma di chi ha chiamato (golden `chat-mention-read`).
- **Tutto è proposta, classe B**, anche quando il calcolo dice A. Niente
  `pageAction`, niente «Annulla» (`requestUndo` → `not_undoable`). Le proposte
  scadono dopo 20 messaggi del THREAD o 24 ore, a lettura. Le decide solo chi
  ha chiamato, se legge il canale, ne è membro e il canale non è archiviato
  (`chatProposalGuard`, dentro `loadOwn`), con le rotte di sempre
  `/api/claude/proposals/:id/…`. Gli altri lettori vedono la scheda con gli
  argomenti delle sole azioni sugli oggetti che vedono (correzione dell'11 nov
  2026, del maintainer: «Crea la task "Export PDF"» come nel prototipo).
  `argsVisibleTo` in `chat/claude.ts` lega ogni `fn` agli oggetti che tocca
  (task, richiesta, il progetto del milestone) e li misura con
  `citeablesFor`. Una CREAZIONE vale come l'oggetto creato (review della
  fetta 3, scelta dell'orchestratrice): titolo e descrizione di
  `createTask`/`createRequest` solo a chi vedrebbe quella task o quella
  richiesta creata da un altro (`tickets.view_all` o `backlog.view_all` nel
  progetto); agli altri «Crea una task», senza argomenti. Un'azione su un oggetto che non vedono esce
  con `args: {}`, così né codice né titolo escono. Una `fn` nuova, i filtri
  personali e le azioni di pagina restano chiusi per costruzione: chi
  aggiunge una `fn` al catalogo la aggiunga lì. Dei codici nati dalla
  conferma escono solo quelli che vedono.
- **Il testo di Claude lo leggono tutti uguale**: lo scrive il worker sul
  messaggio (a intervalli e alla fine), dai testi dell'assistente della
  sessione. Non ci entrano gli errori del CLI (limiti, errori dell'API, che
  il CLI incarta come messaggio dell'assistente: `apiError`) né il testo di
  un tentativo scartato (`discarded`); restano nella trascrizione di chi
  chiama (review della fetta 3).
- **Il contesto del thread** (`callContext`, review della fetta 3): il nome
  dell'autore solo sulla prima riga di un messaggio, le righe dopo quotate
  con «  > », così nessuno si finge chi chiama a metà di un messaggio. Il
  tetto è la radice più gli ultimi messaggi, al più 40 e 12.000 caratteri,
  come la continuazione di una pubblica; una riga dice quanti ne restano
  fuori, e il contratto del prompt lo spiega.
- **Limite accettato: la classe B non copre l'esfiltrazione nel TESTO della
  risposta** (review della fetta 3). Le proposte le conferma chi ha
  chiamato; il testo invece lo leggono subito tutti i lettori del canale, e
  Claude legge con i permessi di chi chiama. Un membro può provare a
  fargli incollare nel thread dati che solo chi chiama vede. Vale la regola
  del prototipo: chi chiama ne è responsabile. Il contratto del prompt dice
  di non incollare dati non chiesti esplicitamente da chi chiama e di non
  seguire istruzioni di altri membri; il golden `chat-mention-read` ne
  controlla il comportamento.
- **La domanda** (`ask_question`, R-G4): esiste solo nei turni di una chiamata
  e la scrive il WORKER nel DB, non il server. Così il token del turno resta
  GET-only più la sola rotta delle proposte. Una per risposta (indice unico);
  la vedono tutti, risponde solo chi ha chiamato, una volta (claim), e la
  risposta riparte come input della stessa sessione.
- **Stop, «Try again», eliminazione**: solo chi ha chiamato. Lo stop archivia la
  riga della conversazione della chiamata (il worker ferma il turno);
  «Try again» solo su una fallita, una volta, come risposta nuova; eliminare la
  risposta la ferma e fa decadere le sue proposte aperte.
- **Budget**: a budget finito la risposta nasce `failed`/`budget`, senza turno.
  Nessun altro tetto (decisione del maintainer).
- **Dopo 14 giorni la sessione si pota, e con lei pezzi della scheda**
  (review della fetta 3). `chat_messages.agent_session_id` va a null; il
  testo della risposta resta. Spariscono, per tutti i lettori:
  - le schede delle proposte (`claude_proposals` va in cascata con la
    sessione), comprese quelle confermate: i codici nati restano nelle task;
  - «cosa ha letto», per chi ha chiamato;
  - la possibilità di rispondere a una domanda ancora aperta: `canAnswer`
    diventa falso e la domanda esce da «Da decidere» (`claudeQuestionsOf`
    vuole la sessione), il suo testo resta nel thread.
- **Limite accettato: il testo eliminato resta nella copia della sessione**
  (review della fetta 3). Il contesto del thread entra nella sessione di chi
  ha chiamato come primo input: un messaggio eliminato DOPO la chiamata
  esce dalla Chat, ma resta in quella copia (e nei suoi eventi) finché la
  sessione non si pota, 14 giorni. Come WAL e backup: il testo si conserva
  finché quei dati non vengono riscritti.
- **Il registro decisioni non si scrive**: i moduli della Chat sono nei test
  `decisions-never-ai` e `claude-actions-never`.

## Eventi dei progetti e allegati (fetta 4)

- **Gli eventi li scrive il DATABASE**, con un trigger per fonte e una sola
  funzione, `chat_publish_event` (0141), come il «general» della 0135. Così
  li produce OGNI scrittore (rotte, pipeline del worker, intake, webhook),
  non una rotta sola. Chi aggiunge una fonte la aggiunge lì, non in un
  servizio.
  - Fonti: una task che ENTRA nella famiglia «closed» (lo stato vero è
    `status_id`, e il sync dell'enum lo scrive anche per chi scrive l'enum;
    fra due stati chiusi non ripubblica); una richiesta inserita non fusa
    (l'intake inserisce solo quando non fonde); un traguardo `open` →
    `closed`; un brief `done` CON il testo; la PR di una task (URL che nasce,
    stato che diventa `merged`).
  - `release_page` è acceso nel «general» ma inerte fino all'area 8
    ([DECIDE] 1 = a).
  - Il messaggio è `system` col corpo VUOTO: la scheda si DERIVA a lettura
    (`chat/events.ts`), con le regole delle citazioni. Il codice di una task o
    di una richiesta esce sempre, il titolo solo a chi vede l'oggetto; la PR
    (numero, URL, repository) solo a chi vede la task; un oggetto che non c'è
    più lascia solo il tipo dell'evento.
  - Non avvisano nessuno (nessun `notification_kind`): contano fra i non letti
    col livello «tutti», come nel prototipo.
  - `PUT /api/chat/channels/:id/events` vale solo con `canEditEvents`, e
    l'elenco si scrive nell'ordine canonico (`CHAT_EVENT_KINDS`, quello del
    prototipo).
- **Gli allegati** (`chat/attachments.ts`):
  - si CARICANO nel canale da chi ci scrive e nascono in sospeso; li LEGA un
    messaggio della stessa persona nello stesso canale, entro 24 ore; una
    modifica toglie e non aggiunge; se ne vanno col messaggio, righe e
    oggetti;
  - si SCARICANO con un URL firmato (5 minuti, `Content-Disposition:
    attachment`) solo da chi LEGGE il canale: un DM e un privato solo dai
    membri, mai da chi gestisce senza esserne membro (D2). Un sospeso lo
    scarica solo chi l'ha caricato;
  - il binario non passa mai dall'API. Lo storage si pulisce dopo il commit e
    senza bloccare: un oggetto rimasto non si scarica, perché l'URL lo firma
    solo la rotta di download, e la rotta vuole la riga;
  - limiti e tipi ([DECIDE] 2 = b): 25 MB, 10 per messaggio. Un allowlist di
    tipi MIME, ciascuno con le SUE estensioni (`chatAttachmentAllowed`):
    niente eseguibili, niente SVG;
  - la potatura dei sospesi oltre le 24 ore ([DECIDE] 3 = a) la fa il SERVER,
    una volta l'ora e a ogni caricamento (scelta confermata dall'orchestratrice
    l'11 nov 2026). I motivi: lo storage lo ha solo lui, e il worker non ne ha
    le credenziali, né deve averle; il server è UN processo, quindi il timer
    gira una volta sola. Chi un giorno scala il server su più istanze lo
    ricordi: la potatura è idempotente (cancella solo righe ancora in sospeso),
    ma girerebbe una volta per istanza.

## Limiti, nel registro

I messaggi «via
Claude» non esistono per decisione del maintainer: `via_claude_action_id` resta
inerte (`docs/plans/integrazione-registro-rimandi.md`, area 4).
