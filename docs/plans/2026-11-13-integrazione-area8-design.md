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

## Il lato renderer (stubwise-94)

> Di stubwise-94, sulle sue R-1…R-5 (tutte = a, *(O)* di 46) e
> sull'inventario («Lato renderer»). Percorsi da `apps/desktop/src/renderer/`.
> La specifica è il prototipo: web e mobile non sono un riferimento.

### Le regole che valgono per ogni fetta

- **Un flag per pezzo** (R-1): sotto i nomi di oggi (`releases`, `support`,
  `servers`, `alerts` in `data/integration.ts`) un pezzo si accende quando
  il suo server c'è, non quando c'è tutta la sezione. I nomi proposti stanno
  sotto, per fetta. I cancelli esistono già:
  - le funzioni in `data/queries/{releases,support,servers,alerts}.ts`;
  - le sezioni di progetto `releases`, `support`, `servers`, che restano
    «in arrivo»;
  - i blocchi Home dalla loro area (`ofArea`).
- **Un adattatore per namespace**, in `data/backend/real/`, con le firme del
  prototipo (`data/api.ts`: `releases`, `support`, `servers`, `alerts`, oggi
  stub generati). Gli errori sono nelle parole del prototipo, come
  `inPrototypeWords` delle automazioni; una lettura che un server più vecchio
  non ha (404) è «niente».
- **Le lezioni della review della F4 dell'area 7**, da tenere fin dal piano:
  - (I1) un'azione che il server non ha non si offre nella build app: niente
    bottoni che finiscono in `NotIntegratedError`, con un test di pagina che
    ne verifica l'assenza;
  - (I2) un segreto mostrato una volta (la chiave dell'agente di
    monitoraggio, e ciò che la F4b riscritta mostrerà) non passa dal
    risultato di una mutazione, perché React Query lo terrebbe per il gcTime.
    Sta in una mappa in memoria che si svuota in `forgetClientCaches` (al
    cambio di persona e all'uscita), come `data/revealedAddress.ts`;
  - (I3) `INTEGRATED_CALLS` di `pages/ComingSoon.test.tsx` cresce nello
    STESSO commit dell'accensione, con un test «aprire <pagina> legge solo
    chiamate integrate» per ogni pagina nuova.
- **«Solo prototipo» fuori dalla build app** (R-2): i pannelli e i bottoni
  di simulazione (`SimulatePanel`, `simulateRunOutcome`,
  `simulateSeenOnServer`, `simulateAuthorPush`, `advancePrWork`,
  `simulateCustomerMessage`, `simulateCustomerLeaves`,
  `simulateTriageDone`, `simulateServer*`, `simulateSsh*`,
  `simulateFixCheck`) si nascondono con `isAppBuild()`, con un test per
  pagina. `check-no-seed` guarda solo i dati del seme, non i pannelli.
- **Le card dell'inbox dei tipi nuovi**: `data/backend/real/notifications.ts`
  già non lancia su un kind ignoto (card con «Open in web»). Ogni fetta che
  porta un `notification_kind` nuovo ne aggiunge il link nell'app (il
  rilascio, la conversazione, il server) e un test che parsa la card SENZA i
  campi nuovi (regola additiva).
- **I moduli di progetto**: senza `modules` dal server la build app li dà
  tutti (`EXISTING_MODULES` in `data/backend/real/projects.ts`). Le sezioni
  si accendono quindi per tutti i progetti insieme; se il server comincia a
  mandare i moduli, valgono quelli.

### F1, i rilasci

- **Pagine**: `pages/releases/` con:
  - `ReleasesPage` (le PR aperte: `PrList`, `PrRow`, `PrPanel`,
    `PrActions`, `NeedsAttention`, `MergeConfirm`; i rilasci: `ReleaseList`);
  - `ReleaseDetail` (`/p/$code/releases/$release`), con `RunLog` solo per
    `repos.view`, `FixDialog` («Spiega», «Fai sistemare a Claude») e
    `ReleaseNotesField`;
  - `Environments` (anche in `ReleaseDetail` e in `NewServerDialog`);
  - le impostazioni di progetto «Repositories»
    (`pages/settings/RepositorySettings.tsx`: ramo di rilascio, pipeline,
    PR dei colleghi), oggi «in arrivo», che contiene solo pezzi di questa
    fetta.
- **Agganci**:
  - il blocco Home `ReleasesBlock` (`listMyReleases`), con l'extra
    `["releases"]` che il server passa a `resolveHome` per chi ha
    `release.merge`;
  - il contatore e il punto «aspetta» nella colonna del progetto
    (`layout/ProjectColumn.tsx`);
  - la scheda `release_page` della Chat (`pages/chat/SystemCard.tsx`), con
    il link al rilascio (S-6);
  - la scheda «Release notes» dei Docs (`DocReleases`, già integrata, con le
    note notturne) resta com'è, e le note per PR vivono nella PR e nel
    rilascio.
- **Flag**, in quest'ordine (R-3):
  1. `releases-prs`, sulle rotte di oggi: `GET /api/release-queue` per
     `listReleaseQueue` e `listOpenPrs`, `POST …/release` per `mergePr`
     (gli errori sono già quelli di `MergeError`, più `merge_failed` da dire
     in parole), «Request changes» sulla correzione post-PR esistente;
  2. `releases`: il rilascio, il suo stato, «Spiega», «Fai sistemare a
     Claude», le note per PR, la Home intera, `release_page`;
  3. `releases-repo-settings`, quando le colonne del repository ci sono;
  4. `environments`, con i server per repository (R-4).
  - «Solo analisi» e la modalità delle PR dei colleghi arrivano con
    l'invariante 2 riscritta.
  - L'adozione esplicita di oggi (`…/adoption`) non entra mai nel renderer:
    il prototipo l'ha tolta.
- **Test**:
  - il merge negativo (403, nessuna richiesta di merge partita) per chi non
    ha `release.merge`;
  - nessun bottone di Deploy o Re-run in nessuna pagina;
  - `RunLog` assente senza `repos.view`;
  - «Fai sistemare a Claude» apre una task normale, e il merge resta fuori
    dalle azioni di Claude e dalla palette (NEVER).

### F2, gli avvisi

- **Pagine**:
  - Preferenze → Notifiche (`pages/preferences/NotificationsSection.tsx`,
    `GroupMenu.tsx`, `useAlertActions.ts`): il registro delle iscrizioni,
    coi canali «app» e «telefono», on|off|suspended|mandatory, «copia da»;
  - la scorciatoia «Mute» dalla colonna del progetto
    (`layout/ProjectAlerts.tsx`);
  - `muteFromNotification`, che oggi non ha un consumatore in pagina: si
    decide nel piano se l'inbox lo offre.
- **Il catalogo in shared** (R-5): `domain/alerts/catalog.ts` e
  `data/servers/alertTypes.ts` diventano un modulo di `@stubwise/shared`
  (tipi, gruppi, permessi, obbligatori), con un test di parità sui
  `notification_kind`. Il prototipo lo importa da lì, come `calendar-grid.ts`.
  `domain/alerts/recipients.ts` (i destinatari calcolati) resta del
  prototipo: la build app li legge dal server.
- **Flag**: `alerts`, intero, perché senza le iscrizioni del server non c'è
  una pagina parziale utile. Le preferenze per canale di oggi
  (`notification-prefs`) non hanno una pagina nel desktop, e restano al web
  finché il catalogo non le assorbe (S-4).
- **Test**:
  - un tipo obbligatorio non si spegne dalla pagina;
  - un permesso perso mostra «sospesa» senza togliere la riga;
  - «copia da» scrive solo le righe che chi copia può avere.

### F3, Support

- **Pagine**:
  - `pages/support/`: `SupportPage` (`ConversationList`,
    `ConversationDetail`, `Messages`, `CustomerPreview`), `ReplyComposer`
    con `replyStore.ts`, `RequestBlock`, i widget (`Widgets`, `WidgetPanel`,
    `widgetSnippet.ts`), la route `/p/$code/support/$conversation`;
  - l'origine di una richiesta (`RequestOrigin` in
    `pages/requests/RequestDetail.tsx`).
- **«Annulla» è della UI**: nel prototipo la finestra di 5 s la tiene
  `replyStore.ts`, e `replyToCustomer` parte solo allo scadere, quindi
  «Annulla» non lascia traccia sul server. Non serve una rotta di
  annullamento (a differenza della Posta, dove l'invio è differito sul
  server). Il Review Focus della F3 «l'Undo funziona davvero» si verifica
  nel renderer: nessuna richiesta prima dello scadere, nessuna dopo un
  «Annulla». Cambiare persona nella finestra NON annulla, come nella Posta
  e come dice `replyStore.ts`.
- **«View conversation» su una task del widget** (S-9): lo stesso blocco
  di `RequestOrigin`, in sola lettura, nel dettaglio della task di un ticket
  `source: "widget"`, sopra `?ticketId=`. Il prototipo non lo ha sulle task:
  è un'aggiunta della build app, da mettere anche nel prototipo perché
  resti la specifica.
- **«Scrivigli anche per email»** (`emailDraftFor`): apre la composizione
  della Posta (area 6, integrata) dalla casella di chi risponde (S-5), con
  le regole d'invio della Posta.
- **Flag**:
  1. `support-widgets`, sulle rotte di oggi (`/api/projects/:projectId/widgets`,
     `widget.manage`; lo snippet con l'origine vera dell'istanza);
  2. `support-read`: le conversazioni in sola lettura, `RequestOrigin` e
     «View conversation», sulle rotte di oggi;
  3. `support`: la risposta, gli stati, «segui», la richiesta da una
     conversazione, la Home «Clienti in attesa», la bozza di Claude, il
     canale `mcp`.
- **Test**:
  - nessuna risposta senza «Send to customer»;
  - l'Undo non manda niente;
  - una conversazione di un progetto invisibile risponde come inesistente;
  - la bozza di Claude non parte da sola.

### F4, Servers

- **Pagine (F4a, sulle rotte di oggi)**:
  - `pages/servers/`: `ServersPage`, `ServerList`, `ServerDetail` con
    `NowBox`, `MetricsCharts`/`Chart`, `ServicesTable`, `DisksPanel`,
    `ChecksPanel`, `ThresholdsPanel`, `ServerSettings`, `AgentKeyPanel`,
    `InstallCommand` e `NewServerDialog`;
  - l'Amministrazione (`pages/admin/instance/ServersAdminPage.tsx`,
    `/admin/servers/$server`);
  - il punto rosso o giallo nella colonna del progetto.
- **La chiave dell'agente** (`regenerateAgentKey`, in chiaro una volta):
  regola I2 qui sopra.
- **La visibilità**: dagli ambienti per repository quando ci sono (F1, R-4).
  Fino ad allora quella di `server_projects`, detta nella parità.
- **F4b**: la correzione da task (`pages/task/ServerSection.tsx`:
  `getServerTaskInfo`, `startServerFix`), l'analisi all'avviso e gli accessi
  (`SshAccessPanel` e compagni) seguono la F4b riscritta da 72 (il
  maintainer: la correzione passa dall'agente di monitoraggio, non
  dall'SSH). Questa parte del lato renderer si completa dopo quella
  riscrittura: se gli accessi SSH escono dal perimetro, i loro componenti
  restano nel prototipo e la build app non li mostra (I1).
- **Flag**: `servers-monitor` (F4a), poi quelli della F4b.
- **Test**:
  - un server di un progetto invisibile risponde come inesistente;
  - la chiave dell'agente non è nella cache delle mutazioni e si dimentica
    al cambio di persona;
  - nessun «Simulate» nella build app.

### Azioni di Claude e palette

Ogni azione arriva con la sua fetta e col suo adattatore nel catalogo
condiviso: le note della PR (`releaseNotesDraft`) con la F1,
`setSubscription` con la F2, la bozza di risposta (`supportReplyDraft`,
`useSupportClaudeDraft`) con la F3. Il merge e la correzione di un server
restano fuori dal catalogo e dalla palette (`palette/commands.ts`) anche
come suggerimento. I gruppi di ricerca dell'area (`searchReleases`,
`searchSupport`, `searchServers`) non hanno oggi un consumatore in pagina:
non si integrano finché una pagina non li usa.

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
