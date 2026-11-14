# Area 8, fetta 4a — Servers: il monitor e gli ambienti nell'app

> BOZZA di stubwise-72 (14 nov 2026), su richiesta di stubwise-46. Il lato
> renderer è preso dal design (la sezione di 94) e lo rivede lui.
> Esecuzione prevista: `feat/area8-f4a` (server, 72; da `feat/area8-f3`),
> `feat/area8-f4a-renderer` (94).
> Design: `docs/plans/2026-11-13-integrazione-area8-design.md` (§ Fette F4,
> § Il modello dei dati F4, il lato renderer «F4, Servers»). Inventario:
> `docs/plans/2026-11-13-integrazione-area8-inventario.md` (voci 6 e 9, R-4).
> Registro: area 8, «F1, lato renderer» (gli ambienti per repository si
> accendono con la F4a). Specifica: il prototipo
> (`apps/desktop/src/renderer/data/servers/{reads,monitor,visibility}.ts`,
> `pages/servers/`, `pages/admin/instance/ServersAdminPage.tsx`,
> `pages/releases/Environments.tsx`) e la sua parità
> (`apps/desktop/docs/area8-parity.md`, «Servers»).
> **Le risposte del maintainer** (14 nov 2026, via 46): F4a-1 = a, F4a-2 = a,
> F4a-3 = a, **F4a-4 = b** (contano SOLO gli ambienti). Le domande restano in
> fondo con la risposta; le conseguenze sono nei task.

## Decisioni *(M, 14 nov 2026, via 46)*

- **F4a-1 = a**: `monitor.view` esce dal preset `User` (anche il web: un
  utente vede i server dei suoi progetti). **Solo dal preset** *(O, 46)*: i
  ruoli personalizzati non si toccano (toglierlo da un ruolo fatto a mano è
  una scelta che la migrazione non può indovinare: «contiene tutto `User`»
  non distingue una copia da una scelta). Il deploy-log elenca i ruoli
  personalizzati con `monitor.view` senza `monitor.manage`, come passo
  post-deploy («controlla questi ruoli»): decide l'admin.
- **F4a-2 = a**: `SRV-<n>`, contatore d'istanza.
- **F4a-3 = a**: gli episodi nella F4a.
- **F4a-4 = b**: un server si vede SOLO dagli ambienti dei progetti visibili
  (e con `monitor.view`/`monitor.manage`). `server_projects` smette di
  contare ovunque: visibilità, `?projectId=`, i progetti di un server
  nell'elenco, l'ancora di progetto degli avvisi `monitor.*` (S10). Il web
  (S11) e il deploy-log (S9) lo dicono.
- **I due punti di sicurezza** (non dipendono dalle risposte): (1)
  `monitor.view` nel preset `User` faceva vedere ogni server a ogni utente
  (chiuso da F4a-1); (2) il `PATCH` di un ambiente accettava qualunque
  server: con la visibilità dagli ambienti un collegamento la allargherebbe a
  tutto il progetto (S3, approvato).

## Cosa entra

- **Il monitor nell'app**: l'elenco dei server di un progetto e quello
  d'istanza (Amministrazione), il dettaglio (adesso, metriche, servizi,
  dischi, controlli, soglie, impostazioni), la chiave dell'agente mostrata
  una volta col comando d'installazione, crea / modifica / elimina, i
  controlli (http, tcp, process, postgres, mysql).
- **La visibilità dei server dagli ambienti per repository** (R-L2,
  rimandata dalla F1 S7): un server lo vede chi vede un progetto che lo usa
  in un suo ambiente.
- **Gli ambienti nell'app** (`environments`, spento nella F1): il server ha
  già i server per repository (F1, 0175); la F4a dà al form l'elenco dei
  server collegabili e chiude il buco di permesso del collegamento (sotto,
  S3).
- **Gli episodi** (dall'avviso al rientro) nel dettaglio del server.
- I link dell'app sulle card `monitor.*` (la regola della F2: ogni fetta che
  porta pagine nuove dà il link alle sue card).

## Fuori dalla F4a (F4b o oltre)

- Tutto ciò che agisce sul server: il canale dei comandi, l'opzione
  «operazioni», l'analisi automatica, la correzione da task
  (`servers.operate`), l'accesso SSH di sola lettura (`servers.ssh.manage`),
  il controllo «busy» di `deleteServer`, la sezione della task
  (`getServerTaskInfo`, `startServerFix`), `getInstallCommand` /
  `getRemovalCommand` (sono dell'SSH).
- Il «progetto principale» di un server (`primaryProjectId`, il progetto in
  cui l'analisi apre la task): serve all'analisi, arriva con la F4b. Nella
  build app il campo non si offre (regola I1).
- La ricerca ⌘K dei server (`searchServers`): nessun consumatore in pagina.
- La vista complessiva dei server (area 9).

## Cosa c'è oggi (server)

- `servers` (chiave `sk_…` come hash, `alert_thresholds`, `active_alerts`,
  `last_seen_at`, `agent_version`), `server_projects` (N:M col progetto,
  scritto dal web), `server_metrics` (48 h) e `server_metrics_rollup` (5 min,
  90 giorni), `service_checks`, `check_samples` e il loro rollup.
- `POST /monitor/ingest`, `GET /monitor/config` (pubbliche, chiave `sk_…`).
- `/api/servers`: elenco (`?projectId=`) e dettaglio con `visibleServerIds`
  / `canViewServer` (`apps/server/src/auth/monitor-access.ts`); crea (solo
  `name`, la chiave in chiaro una volta), `PATCH` (nome, intervallo, soglie
  intere, `projectIds` = sostituisce `server_projects`), rigenera la chiave,
  elimina (`monitor.manage`, d'istanza); i controlli (`servers-checks.ts`) e
  le metriche (`?from&to&checkId`: grezze fino a 48 h, poi rollup a 5 min,
  tetto 6000 punti per serie con `truncated`).
- Gli ambienti (`project-environments.ts`, F1): elenco con i server per
  repository (`servers[]` con nome, commit riportato, `releaseCode`),
  `canManage`, `onlyHere`; scritture con `environments.manage`.
- **La visibilità di oggi**: con `monitor.view` (d'istanza) si vede tutto, e
  **`monitor.view` è nel preset `User`** — in pratica oggi ogni utente vede
  ogni server. Senza, i server di `server_projects` dei progetti visibili.
  `environment_servers` non conta.
- `packages/api-client` `servers`: solo `list` e `get` (scelta del mobile:
  nessuna scrittura). Gli ambienti ci sono (`releases.ts`).
- Nessun comando d'installazione dal server (il web lo compone nel client,
  `dockerRunCommand`); nessun codice leggibile dei server (uuid); nessuna
  storia degli avvisi (solo `active_alerts`, non esposto, e le card).

## Il modello dei dati (migrazione 0180, se le risposte la vogliono)

- `servers.number` (un contatore d'ISTANZA in `instance_counters` o una
  sequenza, assegnato all'insert, backfill per `created_at`) → il codice
  `SRV-<n>` del prototipo (F4a-2 = a).
- `server_episodes` (`server_id`, `kind` (`offline` | `metric` | `check`),
  `metric`/`check_id`, `started_at`, `ended_at`, `peak` jsonb): lo scrive il
  worker degli avvisi all'apertura e al rientro; la F4b ci aggiunge l'analisi
  (F4a-3 = a).
- Il preset `User` senza `monitor.view`, solo il preset (Decisioni, F4a-1 = a).

## Task del SERVER (interfacce e test; l'implementazione è di 72)

S1. **La visibilità dagli ambienti** (`monitor-access.ts`, UN posto):
   un server si vede se chi guarda ha `monitor.manage` o `monitor.view`,
   oppure se è in un `environment_servers` di un progetto visibile. NIENTE
   `server_projects` (F4a-4 = b). `?projectId=` filtra dagli ambienti di quel
   progetto. Elenchi filtrati nella WHERE; un server invisibile risponde 404
   come uno che non esiste. Con la migrazione: `monitor.view` fuori dal
   preset `User`, SOLO dal preset (Decisioni).
   *Test*: visibile da un ambiente di un progetto visibile; non da uno di un
   progetto invisibile; **un server SOLO in `server_projects` è invisibile a
   chi non ha `monitor.view`** (e 404 sul dettaglio, sulle metriche, sui
   controlli); con `monitor.view`/`monitor.manage` tutti; un User (preset)
   non ha più `monitor.view`; un ruolo personalizzato che lo aveva lo tiene
   (non si tocca); elenco e dettaglio d'accordo.

S2. **Le letture nella forma del prototipo** (campi additivi con default,
   schemi in `@stubwise/shared`, `serverViewSchema` e `serverDetailSchema`
   ci passano dall'inline):
   - in ogni riga: `code` (`SRV-<n>`), `health` (`{ health: healthy |
     trouble | down | recovered | never_connected, since, reasons }`, da
     `serverHealth` di shared — la funzione del prototipo — sugli episodi e
     sull'ultimo segnale: UNA regola per server e renderer), `environments`
     (`{ projectId, projectCode, environmentId, name, kind, repositoryId,
     repositoryName }[]`, solo dei progetti visibili), `work` (`none` nella
     F4a); `recentCpu` c'era già; `access` (l'SSH) arriva con la F4b;
   - nell'elenco d'istanza (`monitor.manage`): `orphan` (nessun ambiente) e
     `inArchivedOnly`; `projects` di un server dagli ambienti;
   - nel dettaglio: i controlli con l'ultimo esito, `canManage` calcolato
     dal server, gli episodi, `productionProjects`.
   - `GET /api/servers/by-code/:code`, registrata prima di `/:id`.
   *Test*: parse di una risposta SENZA i campi nuovi; `health` per ogni
   caso (silenzio oltre 3 intervalli, un avviso attivo, un controllo giù);
   gli ambienti di un progetto invisibile non escono.

S3. **Il collegamento a un ambiente non allarga la visibilità**: oggi il
   `PATCH` di un ambiente accetta qualunque server che esiste. Con S1 un
   collegamento DÀ la visibilità del server a tutto il progetto: si collega
   solo un server che chi scrive vede già (o con `monitor.manage`). 422
   `server_not_visible` altrimenti, niente scritto. La stessa regola per
   `POST /api/servers` con un ambiente (S4).
   *Test*: un Project Lead con `environments.manage` non collega un server
   che non vede; lo collega se lo vede; il full admin sempre; mutazione sul
   controllo.

S4. **Crea con un ambiente**: `POST /api/servers` accetta, facoltativo,
   `environment: { environmentId, repositoryIds }` (`environments.manage`
   in quel progetto, oltre a `monitor.manage`): server e collegamento nella
   stessa transazione (il prototipo: `createServer({name, environmentId})`;
   due chiamate lascerebbero un server orfano a metà). La risposta porta la
   chiave una volta e `ingestUrl` (da `PUBLIC_URL`).
   *Test*: senza `environments.manage` 403 e nessun server; il collegamento
   c'è; senza `environment` come oggi.

S5. **Il comando d'installazione in un posto**: `dockerRunCommand` del web
   passa in `@stubwise/shared` (web e app lo usano uguale), con l'immagine e
   il tag; la chiave resta mostrata una volta (creazione e rigenerazione).
   *Test*: lo stesso comando sul web di prima (test di parità sul testo).

S6. **Le metriche per gli intervalli lunghi**: `?from&to` resta; per
   intervalli oltre 7 giorni il server aggrega il rollup a passo più largo
   (1 h fino a 30 giorni, 4 h fino a 90) con `date_bin`, sotto il tetto di
   6000 punti, e dice `resolution` (`raw` | `5m` | `1h` | `4h`, valore
   nuovo: i client passano dal `readerSchema`); nessun `sampleCount` (il
   passo lo dice `resolution`). Le
   percentuali (memoria, disco) le calcola il client dai byte (`memTotal`
   c'è): nessun cambio di forma.
   *Test*: 90 giorni non tronca; la media del passo largo è quella dei
   rollup dentro il passo; 24 h come oggi.

S7. **Gli episodi**: il worker degli avvisi
   (`apps/worker/src/monitor/alerts.ts`) apre un episodio quando pubblica
   `monitor.alert` e lo chiude al `monitor.recovered`, nella stessa
   transazione della pubblicazione; nel dettaglio gli ultimi 20.
   *Test*: allarme → un episodio aperto; rientro → chiuso; due allarmi della
   stessa metrica senza rientro → un episodio; un riavvio del worker non lo
   duplica.

S8. **Il client** (`packages/api-client`): `servers` cresce con crea,
   modifica, soglie, elimina, rigenera, controlli (CRUD), metriche, by-code;
   il commento «nessuna scrittura» diventa «nessuna scrittura dal mobile»
   (la scelta del mobile resta sua). Ogni campo nuovo facoltativo, con un
   test che parsa una risposta senza.

S12. **Il codice del server sulle card `monitor.*`** (per i link dell'app,
   R5): `InboxMonitor.serverCode` DERIVATO a lettura (la regola delle card:
   un campo che si deriva non si scrive nell'evento) dall'id del server
   dell'evento (`url` → `servers.number`), `null` per un server tolto; il
   `projectId` dell'ancora c'è già. Additivo, test con una card SENZA il
   campo e con una card vecchia.

S9. **Il deploy-log** (0180, il preset `User`, server prima di worker e
   caddy) con, PRIMA del deploy, le query di sola lettura: (1) i server
   collegati SOLO da `server_projects` (nessun `environment_servers`), coi
   loro progetti, da mettere in un ambiente o lasciare al monitor. DOPO, come
   passo da fare: (2) i ruoli personalizzati con `monitor.view` senza
   `monitor.manage` («controlla questi ruoli»: vedono ancora ogni server). E
   il registro.

S10. **L'ancora degli avvisi dagli ambienti**: il worker
   (`apps/worker/src/monitor/alerts.ts`, `serverRefs`) prende il progetto di
   un `monitor.*` dai progetti DISTINTI degli ambienti del server (uno solo →
   ancora, come oggi; zero o più → routing di `monitor.manage`, come oggi).
   *Test*: un server in due ambienti dello stesso progetto ha l'ancora; in
   due progetti no; uno solo in `server_projects` no.

S11. **Il web, il minimo onesto**: nella pagina d'amministrazione del
   server (`apps/web/src/routes/monitor/server-admin.tsx`) l'elenco dei
   progetti da spuntare SPARISCE e al suo posto una riga dice da dove
   vengono: «I progetti di un server sono quelli dei suoi ambienti» con i
   progetti (sola lettura) dalla risposta. Il server continua ad accettare
   `projectIds` nel `PATCH` (un web in cache non deve rompersi) ma lo ignora:
   la colonna resta inerte per il rollback e si toglie in un rilascio dopo.
   Il dettaglio di un progetto sul web (che legge `?projectId=`) mostra da
   sé i server degli ambienti.
   *Test*: il web non mostra le spunte e mostra la riga (fixture SENZA
   ambienti: la riga dice «nessun ambiente»); `PATCH` con `projectIds` → 200
   e nessun effetto sulla visibilità.

## Task del RENDERER (94; dal design, li rivede lui)

R1. I flag: `servers-monitor` (elenco, dettaglio, metriche, controlli,
   soglie, impostazioni, chiave dell'agente, Amministrazione) e
   `environments` (il form degli ambienti, con l'elenco dei server
   collegabili da S2/S3).
R2. `pages/servers/` sulle rotte: `ServersPage`, `ServerList`,
   `ServerDetail` (`NowBox`, `MetricsCharts`, `ServicesTable`, `DisksPanel`,
   `ChecksPanel`, `ThresholdsPanel`, `ServerSettings` senza il progetto
   principale, `AgentKeyPanel`, `InstallCommand`, `NewServerDialog`);
   l'Amministrazione; il punto rosso o giallo nella colonna del progetto.
R3. La chiave dell'agente mostrata una volta fuori dalla cache delle
   mutazioni (regola I2), dimenticata al cambio di persona.
R4. Nessun «Simulate», nessun SSH, nessuna correzione nella build app (I1,
   R-2), con un test per pagina; `INTEGRATED_CALLS` cresce nello stesso
   commit (I3).
R5. I link delle card `monitor.*` alla pagina del server, per codice
   (S12): con l'ancora di progetto `#/p/<CODE>/servers/SRV-<n>`, senza
   (zero o più progetti: le riceve chi ha `monitor.manage`)
   `/admin/servers/SRV-<n>`.
R6. Il form degli ambienti offre solo i server dell'elenco (quelli che chi
   scrive vede); il 422 `server_not_visible` (S3) nelle parole del
   prototipo, con un test.

*Review di 94 (14 nov 2026)*: R1 `servers-monitor` (sezione di progetto e
Amministrazione) ed `environments`; gli episodi dentro `servers-monitor`
(sono nel dettaglio). La salute del prototipo passa a `serverHealth` di
shared. Le metriche: la finestra la sceglie il client, `resolution` la legge
e la dice, le percentuali dai byte. Impostazioni senza progetto principale e
senza «progetti da spuntare» (i progetti vengono dagli ambienti, detto in
sola lettura). Il comando con `agentInstallCommand({ instanceUrl: ingestUrl
?? origine dell'istanza, key })`.

## Global Constraints

- Nascosto = inesistente: un server invisibile risponde 404; la visibilità
  si calcola in UN posto (`monitor-access.ts`), nella WHERE.
- Un collegamento non dà a nessuno ciò che chi collega non vede (S3).
- La chiave dell'agente in chiaro solo nella risposta di creazione e di
  rigenerazione, mai in un elenco, un log, una card.
- Verso i client solo campi additivi con default; un valore d'enum nuovo
  solo dove il client passa dal `readerSchema`.
- Nessuna azione sul server dalla F4a: il monitor LEGGE (la regola «Stubwise
  non fa deploy» e la F4b restano dove sono).

## Review Focus

- La visibilità: elenco, dettaglio, metriche, controlli e ambienti dicono
  la stessa cosa per la stessa persona; nessun server esce da un ambiente di
  un progetto che chi guarda non vede.
- Il collegamento a un ambiente e la creazione con un ambiente non
  allargano la visibilità oltre ciò che vede chi scrive.
- Il preset `User` (se cambia): chi perde la vista dei server, e che il web
  lo regga (pagina monitor vuota, non rotta).
- La chiave dell'agente non resta in nessuna risposta dopo la prima.

## Le domande al maintainer (risposte: 1 = a, 2 = a, 3 = a, 4 = b)

**F4a-1. Chi vede tutti i server.** Oggi `monitor.view` è nel preset `User`:
ogni utente vede ogni server dell'istanza (anche sul web). Il prototipo li
fa vedere tutti solo a chi ha `monitor.manage`; gli altri vedono quelli dei
loro progetti.
- (a) *(consigliata)* `monitor.view` esce dal preset `User`: lo hanno gli
  Admin (e chi lo riceve a mano); gli altri vedono i server dei loro
  progetti. Sul web, la pagina del monitor di un utente mostra solo quelli.
  È il modello del prototipo e quello degli altri dati (nascosto =
  inesistente).
- (b) Resta com'è: ogni utente vede ogni server, nell'app e sul web; la
  visibilità dagli ambienti conta solo per chi non ha `monitor.view`.
- (c) Resta nel preset, ma l'app mostra solo i server dei progetti (il web
  tutti): due verità sullo stesso permesso.

**F4a-2. Il codice dei server.** Il prototipo li chiama `SRV-<n>` (URL,
codici nella chat e nelle card); il server ha solo l'uuid.
- (a) *(consigliata)* Un numero d'istanza con un contatore, come le
  conversazioni (`S<n>`): `SRV-<n>`, mai riusato, i server di prima numerati
  per data di creazione.
- (b) L'app usa l'uuid negli URL e il nome nel testo.

**F4a-3. Gli episodi nel dettaglio.** Il prototipo mostra la storia degli
avvisi di un server (dall'allarme al rientro); oggi c'è solo lo stato
attuale. La F4b ha comunque bisogno degli episodi (l'analisi è «una per
episodio»).
- (a) *(consigliata)* La tabella degli episodi nasce nella F4a: il worker
  li scrive dagli avvisi che già manda, e il dettaglio li mostra; la F4b ci
  attacca l'analisi.
- (b) Nella F4a solo l'avviso attivo adesso; la storia arriva con la F4b.

**F4a-4. Il legame del web (`server_projects`).** Il web collega un server
ai progetti con `server_projects`; il prototipo solo dagli ambienti.
- (a) *(consigliata)* Per ora contano entrambi: un server si vede da un
  ambiente O da `server_projects`; l'app scrive solo gli ambienti, il web
  continua come oggi. `server_projects` si toglie col ritiro del web.
- (b) Solo gli ambienti: i legami del web smettono di contare dal deploy (un
  server collegato solo dal web sparisce per chi non ha `monitor.view`
  finché qualcuno non lo mette in un ambiente).
