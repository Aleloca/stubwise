# Integrazione area 8: Rilasci, ambienti, avvisi, Support, Servers nell'app nuova (design)

> BOZZA di stubwise-72, 13 nov 2026, su richiesta di stubwise-46 (94 era
> sulla review della F4 dell'area 7: il lato renderer qui è preso dalle sue
> R-n, e lo rivede lui). Esecutori previsti: stubwise-72 (server e worker),
> stubwise-94 (renderer). Orchestratrice: stubwise-46. Branch del design:
> `docs/area8-inventario`.
> **Specifica**: il design del prototipo
> `docs/plans/2026-10-28-desktop-area8-releases-support-servers-design.md`
> (le decisioni *(maintainer)* lì sono prese e qui non si ridecidono), i
> piani `…-area8a-plan.md` e `…-area8b-plan.md`, le shape
> `apps/desktop/.impeccable/shape/{releases,support,alerts,servers,server-access,server-task,claude-drafts}.md`.
> **Inventario e decisioni**: `docs/plans/2026-11-13-integrazione-area8-inventario.md`
> (lato server, lato renderer, sezione «Decisioni (13 nov 2026)» con le righe
> delle due invarianti riscritte).
> **Invarianti toccate**: CLAUDE.md «Stubwise non fa deploy» e «I due divieti
> dell'operatore» (riscritte, F4), `docs/invariants/pr-corrections.md`
> («Adottare una PR aperta da altri», riscritta, F1), `permissions.md` (tre
> permessi nuovi), `mail-calendar.md` (l'email di una risposta di Support
> parte dalla casella di chi risponde), `providers.md` (la scelta
> dell'account per le analisi).
> **Rivista il 13 nov 2026** con le risposte del maintainer: M2 = a, M3 = a,
> e **M1 cambiato**: le operazioni di correzione di un server passano
> dall'AGENTE di monitoraggio, non dall'SSH (vedi «Le operazioni sui server
> attraverso l'agente»).

## Cosa c'è già e cosa no

Il dettaglio per voce è nell'inventario (lato server). In breve:

- **C'è**: la coda di rilascio e il merge (`/api/release-queue`,
  `releasePullRequest`, errori allineati al prototipo), l'adozione esplicita
  delle PR (che va RISCRITTA), gli ambienti con un server ciascuno, tutto il
  monitor (agente, metriche, controlli, soglie, avvisi `monitor.*`), i widget
  e le conversazioni leggibili per `ticketId`, i tipi di blocco della Home.
- **Non c'è**: il rilascio come oggetto e il suo stato dopo il merge, le run
  di CI, i merge esterni, le note per PR, i server per repository, le
  iscrizioni agli avvisi, la risposta di una persona al cliente, il canale
  dei comandi verso l'agente, l'analisi automatica e la correzione dei
  server, i permessi `support.reply` e `servers.operate`, le azioni di
  Claude dell'area,
  la fonte di `release_page`.

## Perimetro (dal prototipo)

| Dentro | Fuori |
|---|---|
| Releases: PR aperte (di Stubwise e dei colleghi) con l'analisi, la coda, il merge in due passi, il rilascio `<PRJ>-V<n>` e il suo stato letto dalle run di CI o dal commit in produzione, il rilascio fallito con «Spiega» e «Fai sistemare a Claude», le note per PR, gli ambienti per repository | Lanciare un rilascio: nessun Deploy, nessun «Riprova la pipeline» *(maintainer)* |
| Gli avvisi: catalogo dei tipi, iscrizioni per progetto, destinatari calcolati a lettura, Preferenze → Notifiche, la scorciatoia dal progetto | Slack *(maintainer: in dismissione)*; i webhook in uscita e le impostazioni d'istanza delle notifiche (area 9) |
| Support: conversazioni del widget e del server MCP, stati, la risposta di una persona (widget ed email), «segui», la richiesta aperta da una conversazione, «View conversation» su richieste e task, la bozza di Claude | Rispondere in automatico *(maintainer: Claude prepara solo bozze)*; chiudere, assegnare, etichettare ([A 7]) |
| Servers: il monitor nell'app, l'analisi automatica all'avviso, la correzione da task attraverso l'agente di monitoraggio | La vista complessiva dei server (area 9); l'SSH (vedi Q3) |
| Azioni di Claude: iscrizioni agli avvisi, bozza di risposta, bozza delle note della PR | Il merge (NEVER), la correzione di un server avviata da Claude (R-L9) |
| L'evento `release_page` della Chat (la pagina è il rilascio, S-6) | |

## Decisioni (13 nov 2026)

Tutte nell'inventario, sezione «Decisioni». Le portanti:

- **Le due invarianti riscritte** *(M)*: la correzione di un server da una
  task è l'unica azione sull'ambiente, con `servers.operate` e il piano
  approvato prima di ogni comando, mai per rilasciare — ed è eseguita
  dall'AGENTE di monitoraggio, non via SSH (M1 rivisto); niente adozione
  esplicita: ogni PR di un repository collegato si analizza, e la prima
  correzione parte da sola salvo «solo analisi».
- S-3 *(M)*: anche i merge esterni sono rilasci. S-5 *(M)*: la risposta
  arriva nel widget, e per email dalla casella di chi risponde. S-10 *(M)*:
  l'analisi automatica parte da sola, nel budget mensile, con un tetto di
  durata e di costo, una per episodio.
- S-1 *(O)*: quattro fette con le operazioni sui server per ultime. S-2: le run di CI con
  l'account git del repository. S-4: catalogo in shared (R-5). S-6: la
  pagina di Release è il rilascio. S-7: i preset della tabella del design.
  S-8 (chiave SSH) è superata da M1 rivisto: niente chiavi SSH; la chiave
  che firma i comandi la tiene il server (vedi sotto). S-9: «View conversation» anche sulle task. R-1…R-5 = a.

## Le due invarianti riscritte e la loro fetta

Le righe da applicare sono nell'inventario («Le righe delle due
invarianti»). Si applicano a CLAUDE.md e a `docs/invariants/` all'unione del
PRIMO piano della fetta che le tocca, prima del suo codice:

1. **«Stubwise non fa deploy» → «il merge è il confine dei RILASCI; una
   sola azione sull'ambiente, la correzione di un server»**: fetta **F4**
   (Servers), nel piano della F4b (le operazioni attraverso l'agente). Fino
   ad allora vale il testo di oggi alla lettera: nessun codice dell'area
   esegue niente su un server. Nella riga dell'inventario, «con l'accesso
   SSH di correzione» diventa «attraverso l'agente di monitoraggio, con un
   comando firmato dal server per ogni passo approvato».
2. **«Adottare una PR aperta da altri» → «Le PR dei colleghi»**: fetta
   **F1** (Rilasci). Fino ad allora l'adozione esplicita resta com'è, e il
   renderer non la mostra (R-3).

## Fette

Ogni fetta si usa da sola, ha il suo piano, la sua review, la sua parità.

- **F1, i rilasci.** Il rilascio come oggetto (`<PRJ>-V<n>`, un merge sul
  ramo di rilascio, anche esterno, S-3), il suo stato DERIVATO (run di CI con
  l'account git del repository, S-2; senza pipeline, il commit che l'agente
  riporta in produzione), il rilascio fallito con «Spiega» e «Fai sistemare a
  Claude» (una task normale col rilascio collegato), le impostazioni del
  repository (ramo di rilascio, pipeline, provider di CI, PR dei colleghi), le
  PR dei colleghi senza adozione (invariante 2), le note per PR con la bozza
  di Claude, gli ambienti per repository (R-L2: prerequisito anche della F4),
  la Home «Rilasci» con l'extra di `release.merge`, `release_page` nella
  Chat. Gli avvisi dei rilasci nascono col routing di oggi (audience
  `release.merge` del progetto) e passano alle iscrizioni con la F2.
- **F2, gli avvisi.** Il catalogo dei tipi in `@stubwise/shared` (R-5, con
  un test di parità sui `notification_kind`), le iscrizioni per persona e
  progetto (on, off, sospesa, obbligatoria), i destinatari calcolati a
  lettura (iscrizioni × permessi), Preferenze → Notifiche e la scorciatoia
  dal progetto, l'azione di Claude `setSubscription`. Il catalogo copre i
  tipi nuovi dell'area e i `monitor.*`; gli altri `notification_kind`
  restano sul routing di oggi (S-4) finché un'area non li porta.
- **F3, Support.** La risposta di una persona (`support.reply`) nel widget e,
  se il cliente ha lasciato l'email, per email dalla casella di chi risponde
  (S-5); gli stati della conversazione ([A 2]); «segui» ([A 14]); la
  richiesta aperta da una conversazione e la sua origine; «View conversation»
  su richieste e task (S-9); le conversazioni del server MCP in modalità
  collaboratore; la Home «Clienti in attesa»; gli avvisi `support.*` (nel
  catalogo della F2); la bozza di risposta di Claude.
- **F4, Servers.** **F4a**: il monitor nell'app (elenco, dettaglio, metriche,
  controlli, soglie, chiave dell'agente, Amministrazione), la visibilità dei
  server dagli ambienti per repository (F1). **F4b** (per ultima, dopo la
  riscrittura dell'invariante 1): il canale dei comandi verso l'agente
  (pull sulla chiave `sk_…`, comandi firmati), l'opzione «operazioni»
  dell'installazione, l'analisi automatica all'avviso (S-10), la correzione
  da task con `servers.operate` e il piano sempre approvato.

## Il modello dei dati (proposta, da rifinire nei piani)

**F1**
- `releases`: `id`, `code` (`<PRJ>-V<n>`, una sequenza per progetto, mai
  riusata), `project_id`, `repository_id`, `pr_number`, `pr_url`, `title`,
  `merge_sha`, `merged_at`, `merged_by` (persona collegata, se nota),
  `merged_git_name`, `via_stubwise`, `release_notes` (fermate al merge),
  `seen_in_production_at`, `fix_ticket_id`. Lo STATO non si salva: si deriva
  dalle run e dal commit in produzione (come il prototipo).
- `release_ci_runs`: le run lette dal provider (`release_id`, `provider_run_id`,
  `name`, `status`, `url`, `failed_step`, `started_at`, `ended_at`); il log si
  legge dal provider su richiesta (`repos.view`), non si copia.
- `repositories`: `release_branch`, `release_pipeline` (jsonb: `auto` o
  nomi), `ci_provider`, `colleague_prs` (`analyze_and_fix` | `analyze_only` |
  `off`).
- Una PR in «Solo analisi»: una colonna su `pr_reviews` (o sulla riga della
  PR), scritta da chi ha `prs.adopt`.
- Le note della PR: `pr_release_notes` (repository, numero di PR, testo, chi
  e quando), fermate in `releases.release_notes` al merge.
- `environment_servers` (R-L2): `environment_id`, `repository_id`,
  `server_id`; sostituisce `project_environments.server_id` (migrazione dei
  dati: il server di oggi vale per tutte le repository del progetto).
  «Una sola produzione per progetto» ([R 12]) diventa un vincolo.

**F2**
- `alert_subscriptions`: `user_id`, `project_id`, `alert_type`, `state`
  (`on` | `off`), `muted_until`; «sospesa» e «obbligatoria» si DERIVANO
  (permessi e catalogo), non si salvano.
- Nessuna tabella per il catalogo: è codice in `@stubwise/shared`.

**F3**
- `widget_messages.role`: in più `human` (testo libero oggi, nessuna
  migrazione d'enum), `author_id`, `delivered_by_email_at`.
- `widget_conversations`: `channel` (`widget` | `mcp`), `state`, il cliente
  che aspetta noi da quando (`waiting_since`).
- `support_followers`: chi segue una conversazione.
- La richiesta aperta da una conversazione: `backlog_items.support_conversation_id`.

**F4**
- F4a: nessuna tabella nuova (il monitor c'è); la visibilità passa da
  `environment_servers`.
- F4b: `server_commands` (un comando per passo approvato: `server_id`,
  `session_id`, `action`, `params` jsonb, `approval_id`, `nonce`,
  `issued_at`, `expires_at`, `signature`, `status` `pending` | `delivered` |
  `done` | `failed` | `expired`, `output` (non fidato, troncato), `exit_code`,
  `finished_at`); `servers.agent_capabilities` (ciò che l'agente dichiara
  nell'ingest: versione, `operations` accese o no); `server_episodes`
  (l'episodio dall'allarme al rientro, con la sua analisi); la sessione
  dell'analisi e quella della correzione come `agent_sessions` (kind nuovi),
  coi comandi e le uscite nel loro registro, letti da chi vede la task e ha
  `servers.operate` più chi ha `monitor.manage`, tenuti 90 giorni (M2 = a).
  La chiave che firma i comandi: Ed25519 d'istanza, generata dal server al
  primo bisogno, la privata cifrata a riposo (come le credenziali), la
  pubblica mostrata nel comando d'installazione.

## Il motore nel worker

- **Le run di CI (F1)**: un poller legge le run del commit di merge col
  token dell'account git del repository (GitHub Actions, Bitbucket
  Pipelines), finché il rilascio non è concluso o scade; «Validate»
  dell'account controlla anche lo scope di lettura delle run.
- **I merge esterni (F1, S-3)**: il webhook push riconosce un push sul ramo
  di rilascio che chiude una PR (o un merge commit) e crea il rilascio con
  `via_stubwise` falso. Il merge da Stubwise crea il rilascio nella stessa
  transazione di `releasePullRequest`.
- **Le PR dei colleghi (F1)**: l'analisi gira sul ciclo di review di oggi
  (`pr_reviews`), per ogni PR del repository secondo `colleague_prs`; la
  prima correzione parte da sola salvo «Solo analisi», con le regole di
  sicurezza dell'adozione (invariante 2) e il ciclo, il tetto e il budget di
  oggi.
- **La risposta al cliente (F3)**: il widget legge i messaggi nuovi della
  conversazione (polling leggero sul suo endpoint pubblico, stessa chiave);
  l'email parte dalla casella di chi risponde, con le regole d'invio della
  Posta (area 6).
- **L'analisi automatica (F4b, S-10)**: all'avviso (`monitor.alert`), un
  agente Claude che legge ciò che l'agente di monitoraggio riporta (metriche,
  servizi, controlli; e, se le letture sono accese, le azioni di lettura
  della sezione dedicata), un'analisi per episodio, con un tetto di
  durata e di costo, nel budget mensile (il controllo prima di ogni run, come
  i passi di Claude delle automazioni); apre una task `bug` con sorgente
  `server`. Account e modello passano dalla scelta degli account
  (`providers/select.ts`), classe di lavoro di sfondo.
- **La correzione (F4b)**: da una task legata al server, avviata da chi ha
  `servers.operate`; il piano (una sequenza di AZIONI dell'insieme chiuso,
  vedi la sezione dedicata), approvato da chi ha `plans.approve` (sempre,
  anche il proprio); poi un comando FIRMATO alla volta, emesso solo per il
  passo approvato e dopo i ricontrolli (il server è ancora in un ambiente del
  progetto, l'agente ha le operazioni accese, nessuno l'ha fermata), il
  controllo finale dalle metriche, la sessione chiusa sempre.

## Le operazioni sui server attraverso l'agente (F4b, M1 rivisto)

Il maintainer *(M)*: le operazioni di correzione passano dall'AGENTE di
monitoraggio (`packages/agent`), che è già sull'host, non dall'SSH.

**Com'è oggi l'agente** (`packages/agent`, `apps/web/src/routes/monitor/server-admin.tsx`):
un container `docker run --user 0` con `/proc`, `/sys`, `/` e il socket di
Docker montati `:ro`; spinge i campioni (`POST /monitor/ingest`) e rilegge la
configurazione ogni N campioni (`GET /monitor/config`), entrambi sulla
chiave `sk_…` (header `X-Stubwise-Server-Key`, salvata come hash). ⚠️ **Un
socket Unix montato `:ro` NON rende di sola lettura l'API di Docker**: `:ro`
impedisce di modificare il file, non di connettersi e mandare richieste.
L'agente di oggi può quindi già chiamare tutta l'API di Docker (avviare,
fermare, creare container): il testo della UI («i mount sono tutti in sola
lettura — l'agente si limita a osservare») promette più di quanto il mount
garantisca. È il punto da cui parte la domanda Q4.

1. **Il canale** (consigliato): **pull** dei comandi dall'agente, sulla stessa
   chiave `sk_…` — `GET /monitor/commands` (o dentro `/monitor/config`),
   interrogato a un intervallo breve SOLO se l'opzione «operazioni» è accesa;
   nessuna porta aperta sull'host. Ogni comando è **firmato dal server**
   (Ed25519, chiave d'istanza) su: id del server, id del comando (nonce),
   azione, parametri, id dell'approvazione, emesso, scadenza (breve, es. 10
   minuti). L'agente verifica la firma con la **chiave pubblica fissata
   all'installazione** (una variabile del comando d'installazione, MAI
   scaricata dal server: altrimenti chi controlla la risposta la
   sostituirebbe), rifiuta un comando scaduto, di un altro server o con un
   nonce già visto, esegue, e manda l'esito (`POST /monitor/commands/:id/result`).
   Il server consegna un comando una volta sola e lo marca.
2. **Cosa può fare** (consigliato: un **insieme chiuso** di azioni
   dichiarate, eseguite dall'agente sull'API di Docker, ognuna coi suoi
   parametri validati): riavviare un container; fermarlo o avviarlo; liberare
   spazio (immagini non usate, cache di build, container fermi); per le
   letture, le ultime N righe del log di un container e lo stato di un
   container. **Fuori per costruzione**: `exec` dentro un container (è un
   comando libero), pull di un'immagine, ricreazione con un'immagine nuova,
   `compose up`, qualunque cosa sull'host fuori da Docker. Una sola
   esecuzione per comando approvato; l'uscita (troncata, con il codice) torna
   come contenuto NON fidato. L'alternativa, i comandi liberi, è la domanda
   Q1.
3. **L'installazione**: un'opzione esplicita, **spenta di default**, per le
   operazioni (`-e STUBWISE_OPERATIONS=1` e
   `-e STUBWISE_COMMAND_PUBLIC_KEY=<…>` nel comando); senza, l'agente non
   interroga i comandi e ignora qualunque risposta. L'agente dichiara
   nell'ingest versione e opzione accesa, e la sezione Servers lo mostra. Il
   comando lo mostra Impostazioni → Servers (oggi `dockerRunCommand` del web,
   nell'app la sezione Servers), con l'interruttore «operazioni». Come
   ottenere un socket «in scrittura solo se l'opzione è accesa», visto che
   `:ro` non basta, è la domanda Q4.
4. **Le invarianti**: il piano sempre approvato prima di ogni comando (il
   server firma solo per un passo approvato); niente deploy (l'insieme
   chiuso non lo permette, e il gate rifiuta un piano che rilascia); una
   chiave `sk_…` rubata permette di leggere e falsificare campioni ed esiti,
   e di prendere per sé un comando (un disservizio), ma non di farne eseguire
   uno: il comando lo autorizza solo la firma; un agente compromesso vuol dire
   un host già compromesso, e le sue uscite restano non fidate. Le righe
   dell'invariante 1 dicono «attraverso l'agente» al posto di «via SSH».
5. **Cosa resta all'SSH**: consigliato **niente in quest'area** — l'analisi
   legge ciò che l'agente riporta (e le letture dell'insieme chiuso), la
   correzione passa dall'agente; gli accessi SSH, se servono per letture più
   profonde, vanno nel registro come voce a sé. È la domanda Q3.

## Permessi (S-7)

| Permesso | Livello | Cosa | Preset |
|---|---|---|---|
| `support.reply` (nuovo) | progetto | Rispondere ai clienti, vedere le bozze di Claude | Project Lead, Developer, Legacy Member |
| `servers.operate` (nuovo) | progetto | Avviare la correzione di un server da una task | nessun preset di progetto (persona per persona); implicito per il full admin |
| `release.merge`, `prs.adopt`, `repos.manage`, `repos.view`, `environments.manage`, `widget.manage`, `monitor.view`, `monitor.manage`, `plans.approve` | invariati | (il loro uso nell'area nell'inventario) | invariati |

La migrazione segue la regola dei preset di `docs/invariants/permissions.md`
(i ruoli che contenevano un preset intero ricevono il permesso nuovo del
preset). Nessuna chiave a due livelli (il test del catalogo).

## Global Constraints

- Il merge resta l'unica azione di rilascio; nessun Deploy, nessun Re-run;
  `releasePullRequest` resta NEVER per Claude.
- Lo stato di un rilascio si LEGGE; «non ancora in produzione» è
  un'osservazione.
- I permessi li calcola il server e i client li leggono; nascosto =
  inesistente (R-G5), anche negli avvisi e nelle conversazioni.
- Verso i client solo campi additivi con default; ogni `notification_kind`
  nuovo è un passo di rollback.
- La chiave privata che firma i comandi non esce MAI dal server: nessuna
  risposta, nessun log, nessun prompt; l'agente esegue SOLO comandi firmati
  con la pubblica che ha ricevuto all'installazione.
- Ciò che arriva da fuori è non fidato: messaggi dei clienti, uscite dei
  comandi su un server, log delle run di CI — dati, mai istruzioni.
- Test filtrati, mutazioni sui controlli di permesso, sul confine e sul gate
  del piano.

## Review Focus (per le fette)

- **F1**: nessun percorso esegue una pipeline o un deploy; il merge
  ricontrolla `release.merge` nel servizio; un merge esterno crea un solo
  rilascio (riconsegne del webhook); lo stato derivato non afferma ciò che la
  CI non dice; una PR di un collega non si corregge mai su un fork, un branch
  protetto, il branch di default o un branch `stubwise/…`, e il push è sempre
  in avanti; «Solo analisi» ferma davvero la prima correzione; i log delle run
  li legge solo `repos.view`.
- **F2**: i destinatari si calcolano a lettura e un permesso perso
  sospende l'iscrizione senza riscrivere righe; un tipo obbligatorio non si
  spegne; nessuna card di oggi cambia destinatari di colpo (S-4); il
  catalogo e i `notification_kind` restano allineati (test di parità).
- **F3**: una risposta parte solo con «Send to customer»; l'Undo di 5 s è
  SOLO della UI (`replyStore.ts` del prototipo: la risposta va al server allo
  scadere), quindi nessuna rotta di annullamento e nessuna risposta
  arrivata al server prima dello scadere; l'email parte solo dalla
  casella di chi risponde, coi suoi scope; il testo del cliente è non fidato
  nella bozza di Claude; una conversazione la vede solo chi vede il progetto;
  il widget riceve solo i messaggi della sua conversazione.
- **F4** (le operazioni attraverso l'agente soprattutto):
  - **niente deploy**: l'insieme delle azioni non contiene pull, ricreazione
    di un container con un'immagine nuova, `compose up`, `exec`; un piano che
    rilascia si rifiuta — il prompt lo dice, il gate lo controlla, un test lo
    prova;
  - **il piano è SEMPRE approvato prima di ogni comando**: il server firma un
    comando solo per un passo di un piano approvato da chi ha `plans.approve`
    (mai Claude, mai in anticipo), nemmeno dopo un riavvio del worker; lo Stop
    e la revoca fermano anche un comando già firmato e non ancora consegnato;
  - **una sola esecuzione per comando**: nonce, scadenza breve, consegna una
    volta sola, l'agente rifiuta un nonce già visto o un comando scaduto;
  - **un agente compromesso o una chiave `sk_…` rubata non fanno eseguire
    niente di non approvato**: la `sk_…` autentica l'agente verso il server,
    non autorizza un comando; l'agente esegue solo comandi firmati dalla
    chiave d'istanza, verificati con la pubblica fissata all'installazione
    (mai scaricata dal server); un'uscita falsificata da un agente
    compromesso resta contenuto non fidato;
  - **la chiave che firma solo nel server**: la privata non è in nessuna
    risposta, log, prompt o sessione;
  - **comandi e uscite come contenuto non fidato**: l'uscita entra nel
    prompt delimitata (come gli input dei passi di Claude), può contenere
    istruzioni ostili o segreti del server, e non decide da sola il comando
    successivo senza passare dal piano approvato;
  - **le operazioni spente di default**: un agente senza l'opzione ignora
    ogni comando (e lo dice nell'ingest); un'analisi per episodio, nel tetto e
    nel budget; la visibilità dei server passa dagli ambienti (R-L2, R-G5).

## Il lato renderer (dalle R-n di 94, che lo rivede)

- **R-1 = a**: dentro ogni fetta si accendono prima le pagine che stanno
  sulle rotte di oggi (monitor dei server, widget di Support, PR aperte e
  merge), poi si allargano col loro pezzo di server; un flag per pezzo sotto
  `releases`/`support`/`servers` (es. `servers-monitor`, `servers-operations`).
- **R-2 = a**: i pannelli «solo prototipo» (`SimulatePanel`, «Simulate run
  outcome», «Simulate a customer message», gli esiti simulati dei comandi) non ci sono
  nella build app, e un test per pagina lo fissa.
- **R-3 = a**: prima del rilascio come oggetto si accendono le PR aperte con
  il merge in due passi e «Request changes»; elenco e dettaglio dei rilasci
  restano «in arrivo», la Home «Rilasci» mostra solo le PR pronte; l'adozione
  esplicita del server non entra nel renderer.
- **R-4 = a**: gli ambienti e la visibilità dei server si integrano coi
  server per repository (F1); fino ad allora la visibilità resta quella di
  `server_projects`, detta nella parità.
- **R-5 = a**: il catalogo dei tipi di avviso in `@stubwise/shared`, letto
  da renderer e server.

## Domande del maintainer

### Le risposte (13 nov 2026)

- **M2 = a** *(M)*: le sessioni dell'analisi e della correzione le leggono
  chi vede la task e ha `servers.operate`, più chi ha `monitor.manage`; si
  tengono 90 giorni.
- **M3 = a** *(M)*: i tipi nuovi non vanno su Slack; i `monitor.*` smettono
  quando passano al catalogo.
- **M1 rivisto** *(M)*: le operazioni passano dall'agente di monitoraggio,
  non dall'SSH (la sezione dedicata). Ne vengono le domande qui sotto.

### Le domande che restano

Q1. **Cosa può fare l'agente su un comando approvato.**
- (a) *(consigliata)* Un insieme CHIUSO di azioni dichiarate sull'API di
  Docker (riavvia, ferma, avvia un container; libera spazio: immagini non
  usate, cache di build, container fermi; le letture: righe del log, stato
  di un container), coi parametri validati; niente `exec`, niente pull o
  ricreazione d'immagine.
- (b) Comandi liberi (via `exec` in un container o un container d'aiuto
  privilegiato): copre ogni caso, ma un comando libero approvato può fare
  qualunque cosa sull'host, deploy compreso.
- (c) L'insieme chiuso, più i comandi liberi solo per chi ha anche
  `monitor.manage`.

Q2. **Le letture per l'analisi automatica** (righe del log, stato di un
container): l'analisi parte da sola (S-10) e non ha un piano approvato.
- (a) *(consigliata)* Con l'opzione «operazioni» accesa, l'analisi può
  chiedere le sole azioni di LETTURA senza approvazione (firmate, una volta
  sola, registrate nella sessione); le azioni che cambiano qualcosa vogliono
  sempre il piano approvato. Senza l'opzione, l'analisi legge solo metriche,
  servizi e controlli.
- (b) Anche le letture vogliono un piano approvato: l'analisi automatica usa
  solo metriche, servizi e controlli.
- (c) Le letture con un'opzione d'installazione a sé, separata dalle
  operazioni.

Q3. **L'SSH.**
- (a) *(consigliata)* Niente SSH in quest'area: niente accessi, niente
  `servers.ssh.manage`; l'SSH per letture più profonde va nel registro.
- (b) Un accesso SSH di sola lettura per l'analisi, separato dall'agente
  (con `servers.ssh.manage` d'istanza all'Admin).

Q4. **Il socket di Docker**, che montato `:ro` dà comunque l'API completa
(anche all'agente di oggi).
- (a) *(consigliata)* L'agente resta un solo container: con le operazioni
  spente il suo codice usa solo le letture (come oggi), con l'opzione accesa
  esegue solo comandi firmati; si corregge SUBITO il testo della UI che dice
  «sola lettura» per il socket, e la nota di rilascio lo spiega.
- (b) Un proxy del socket accanto all'agente (un container che lascia
  passare solo le chiamate di lettura, e quelle dell'insieme chiuso solo con
  l'opzione accesa): una garanzia anche se l'agente avesse un difetto, al
  costo di due container da installare.
