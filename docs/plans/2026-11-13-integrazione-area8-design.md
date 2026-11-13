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
> dell'account per le analisi), `vault.md` (le chiavi SSH NON ci vanno).

## Cosa c'è già e cosa no

Il dettaglio per voce è nell'inventario (lato server). In breve:

- **C'è**: la coda di rilascio e il merge (`/api/release-queue`,
  `releasePullRequest`, errori allineati al prototipo), l'adozione esplicita
  delle PR (che va RISCRITTA), gli ambienti con un server ciascuno, tutto il
  monitor (agente, metriche, controlli, soglie, avvisi `monitor.*`), i widget
  e le conversazioni leggibili per `ticketId`, i tipi di blocco della Home.
- **Non c'è**: il rilascio come oggetto e il suo stato dopo il merge, le run
  di CI, i merge esterni, le note per PR, i server per repository, le
  iscrizioni agli avvisi, la risposta di una persona al cliente, l'SSH,
  l'analisi automatica e la correzione dei server, i permessi `support.reply`,
  `servers.operate`, `servers.ssh.manage`, le azioni di Claude dell'area,
  la fonte di `release_page`.

## Perimetro (dal prototipo)

| Dentro | Fuori |
|---|---|
| Releases: PR aperte (di Stubwise e dei colleghi) con l'analisi, la coda, il merge in due passi, il rilascio `<PRJ>-V<n>` e il suo stato letto dalle run di CI o dal commit in produzione, il rilascio fallito con «Spiega» e «Fai sistemare a Claude», le note per PR, gli ambienti per repository | Lanciare un rilascio: nessun Deploy, nessun «Riprova la pipeline» *(maintainer)* |
| Gli avvisi: catalogo dei tipi, iscrizioni per progetto, destinatari calcolati a lettura, Preferenze → Notifiche, la scorciatoia dal progetto | Slack *(maintainer: in dismissione)*; i webhook in uscita e le impostazioni d'istanza delle notifiche (area 9) |
| Support: conversazioni del widget e del server MCP, stati, la risposta di una persona (widget ed email), «segui», la richiesta aperta da una conversazione, «View conversation» su richieste e task, la bozza di Claude | Rispondere in automatico *(maintainer: Claude prepara solo bozze)*; chiudere, assegnare, etichettare ([A 7]) |
| Servers: il monitor nell'app, gli accessi SSH in tre passi, l'analisi automatica all'avviso, la correzione da task | La vista complessiva dei server (area 9) |
| Azioni di Claude: iscrizioni agli avvisi, bozza di risposta, bozza delle note della PR | Il merge (NEVER), la correzione di un server avviata da Claude (R-L9) |
| L'evento `release_page` della Chat (la pagina è il rilascio, S-6) | |

## Decisioni (13 nov 2026)

Tutte nell'inventario, sezione «Decisioni». Le portanti:

- **Le due invarianti riscritte** *(M)*: la correzione di un server da una
  task via SSH è l'unica azione sull'ambiente, con `servers.operate` e il
  piano approvato prima di ogni comando, mai per rilasciare; niente adozione
  esplicita: ogni PR di un repository collegato si analizza, e la prima
  correzione parte da sola salvo «solo analisi».
- S-3 *(M)*: anche i merge esterni sono rilasci. S-5 *(M)*: la risposta
  arriva nel widget, e per email dalla casella di chi risponde. S-10 *(M)*:
  l'analisi automatica parte da sola, nel budget mensile, con un tetto di
  durata e di costo, una per episodio.
- S-1 *(O)*: quattro fette con l'SSH per ultimo. S-2: le run di CI con
  l'account git del repository. S-4: catalogo in shared (R-5). S-6: la
  pagina di Release è il rilascio. S-7: i preset della tabella del design.
  S-8: chiave SSH generata dal server, cifrata a riposo, usata solo dal
  worker. S-9: «View conversation» anche sulle task. R-1…R-5 = a.

## Le due invarianti riscritte e la loro fetta

Le righe da applicare sono nell'inventario («Le righe delle due
invarianti»). Si applicano a CLAUDE.md e a `docs/invariants/` all'unione del
PRIMO piano della fetta che le tocca, prima del suo codice:

1. **«Stubwise non fa deploy» → «il merge è il confine dei RILASCI; una
   sola azione sull'ambiente, la correzione di un server»**: fetta **F4**
   (Servers), nel piano della F4b (SSH). Fino ad allora vale il testo di
   oggi alla lettera: nessun codice dell'area esegue niente su un server.
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
  riscrittura dell'invariante 1): gli accessi SSH (lettura e correzione, in
  tre passi, `servers.ssh.manage`), l'analisi automatica all'avviso in sola
  lettura (S-10), la correzione da task con `servers.operate` e il piano
  sempre approvato.

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
- F4b: `server_ssh_access` (`server_id`, `kind` `read` | `fix`, `public_key`,
  `private_key_encrypted` — mai in una risposta, la decifra solo il worker —,
  `status`, `verified_at`, `last_used_at`, `revoked_at`); `server_episodes`
  (l'episodio dall'allarme al rientro, con la sua analisi); la sessione
  dell'analisi e quella della correzione come `agent_sessions` (kind nuovi),
  coi comandi e le uscite nel loro registro.

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
  agente in sola lettura via SSH, un'analisi per episodio, con un tetto di
  durata e di costo, nel budget mensile (il controllo prima di ogni run, come
  i passi di Claude delle automazioni); apre una task `bug` con sorgente
  `server`. Account e modello passano dalla scelta degli account
  (`providers/select.ts`), classe di lavoro di sfondo.
- **La correzione (F4b)**: da una task legata al server, avviata da chi ha
  `servers.operate`; il piano letto in sola lettura, approvato da chi ha
  `plans.approve` (sempre, anche il proprio); poi un comando alla volta, con
  i ricontrolli prima di ognuno (il server è ancora in un ambiente del
  progetto, l'accesso è usabile, nessuno l'ha fermata), il controllo finale
  in sola lettura, la sessione chiusa sempre.

## Permessi (S-7)

| Permesso | Livello | Cosa | Preset |
|---|---|---|---|
| `support.reply` (nuovo) | progetto | Rispondere ai clienti, vedere le bozze di Claude | Project Lead, Developer, Legacy Member |
| `servers.operate` (nuovo) | progetto | Avviare la correzione di un server da una task | nessun preset di progetto (persona per persona); implicito per il full admin |
| `servers.ssh.manage` (nuovo) | istanza | Collegare, verificare, rigenerare, revocare gli accessi SSH | Admin (implicito per il full admin) |
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
- Le chiavi SSH private non escono MAI dal server: nessuna risposta, nessun
  log, nessun prompt; le usa solo il worker.
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
- **F3**: una risposta parte solo con «Send to customer» e l'Undo funziona
  davvero (nessun invio prima dello scadere); l'email parte solo dalla
  casella di chi risponde, coi suoi scope; il testo del cliente è non fidato
  nella bozza di Claude; una conversazione la vede solo chi vede il progetto;
  il widget riceve solo i messaggi della sua conversazione.
- **F4** (per l'SSH soprattutto):
  - **niente deploy**: un piano che rilascia (pull, aggiornamento d'immagine,
    riavvio come passo di un rilascio) si rifiuta — il prompt lo dice, il gate
    lo controlla, e un test lo prova;
  - **il piano è SEMPRE approvato prima di ogni comando**: da chi ha
    `plans.approve`, mai Claude, mai in anticipo, anche se chi avvia può
    approvare; nessun comando di correzione prima dell'approvazione, nemmeno
    dopo un riavvio del worker; lo Stop e la revoca fermano anche un comando
    già deciso;
  - **le chiavi solo nel worker**: la privata si genera e si cifra nel
    server, non è in nessuna risposta, log, prompt o sessione; il client vede
    la pubblica e il comando d'installazione;
  - **comandi e uscite come contenuto non fidato**: l'uscita di un comando
    entra nel prompt delimitata (come gli input dei passi di Claude), può
    contenere istruzioni ostili o segreti del server, e non decide da sola
    il comando successivo senza passare dal piano approvato;
  - l'analisi in sola lettura non scrive (verificato, [SA 2]); un'analisi
    per episodio, nel tetto e nel budget; la visibilità dei server passa dagli
    ambienti (R-L2, R-G5).

## Il lato renderer (dalle R-n di 94, che lo rivede)

- **R-1 = a**: dentro ogni fetta si accendono prima le pagine che stanno
  sulle rotte di oggi (monitor dei server, widget di Support, PR aperte e
  merge), poi si allargano col loro pezzo di server; un flag per pezzo sotto
  `releases`/`support`/`servers` (es. `servers-monitor`, `servers-ssh`).
- **R-2 = a**: i pannelli «solo prototipo» (`SimulatePanel`, «Simulate run
  outcome», «Simulate a customer message», «Simulate SSH outcome») non ci sono
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

Restano solo queste: il resto è deciso (inventario, «Decisioni»).

M1. **L'accesso «di sola lettura» e i container.** L'analisi automatica
legge «log, processi, disco, memoria, container» *(maintainer, decisione
10)*. Ma leggere i log o lo stato dei container Docker vuol dire usare il
socket di Docker (o il gruppo `docker`), che su un host vale root: un utente
«di lettura» col socket non è più di sola lettura.
- (a) *(consigliata)* L'utente di lettura NON ha il socket: legge ciò che
  un utente senza privilegi legge (processi, disco, memoria, log di sistema
  accessibili), e lo stato dei servizi dall'ultimo campione dell'agente di
  monitoraggio (che c'è già e li conosce). I log dei container si leggono
  solo nella correzione, dopo l'approvazione.
- (b) L'utente di lettura ha il socket di Docker: l'analisi vede tutto, ma
  l'accesso «di lettura» è di fatto root.
- (c) Un comando apposito installato col comando di collegamento (es. un
  wrapper che espone solo `docker logs` e `docker ps`, via sudo limitato), più
  lavoro di installazione.

M2. **Chi legge le sessioni dell'analisi e della correzione** (comandi e
uscite di un server di produzione, che possono contenere segreti e dati di
clienti), e per quanto.
- (a) *(consigliata)* Chi vede la task del server e ha `servers.operate`
  nel progetto, più chi ha `monitor.manage`; le uscite si tengono 90 giorni,
  poi resta il riassunto della task.
- (b) Chiunque veda la task, senza scadenza (come le sessioni degli agenti
  di oggi).

M3. **I DM Slack per i tipi che entrano nel catalogo** (Slack è in
dismissione, *(maintainer)*). Oggi il DM Slack è un interruttore per
PERSONA (`users.notify_slack_dm`), non per tipo d'avviso.
- (a) *(consigliata)* I tipi nuovi dell'area 8 non vanno su Slack; quelli
  di oggi che passano al catalogo (`monitor.*`) smettono di andarci quando
  passano, e la nota di rilascio lo dice.
- (b) Il catalogo manda su Slack anche lui, finché Slack non si spegne del
  tutto.
