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
> **Domande al maintainer**: quattro, in «[DECIDE]» in fondo.

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
- **Gli episodi** (dall'avviso al rientro) nel dettaglio del server, se il
  maintainer dice sì ([DECIDE] F4a-3).
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

- `servers.number` (un contatore d'ISTANZA, trigger come le conversazioni
  della 0179, backfill per `created_at`) → il codice `SRV-<n>` del
  prototipo ([DECIDE] F4a-2).
- `server_episodes` (`server_id`, `kind` (`offline` | `metric` | `check`),
  `metric`/`check_id`, `started_at`, `ended_at`, `peak` jsonb): lo scrive il
  worker degli avvisi all'apertura e al rientro; la F4b ci aggiunge l'analisi
  ([DECIDE] F4a-3).
- Il preset `User` senza `monitor.view`, se il maintainer sceglie (a) in
  F4a-1 (la regola dei preset vale al contrario: si toglie dal preset, i
  ruoli personalizzati restano come sono).

## Task del SERVER (interfacce e test; l'implementazione è di 72)

S1. **La visibilità dagli ambienti** (`monitor-access.ts`, UN posto):
   un server si vede se (i) chi guarda ha `monitor.manage` o `monitor.view`,
   oppure (ii) è in un `environment_servers` di un progetto visibile, oppure
   (iii) è in `server_projects` di un progetto visibile — finché il web lo
   scrive ([DECIDE] F4a-4). Elenchi filtrati nella WHERE; un server
   invisibile risponde 404 come uno che non esiste.
   *Test*: visibile da un ambiente di un progetto visibile; non da uno di un
   progetto invisibile; da `server_projects` (se F4a-4 = a); con
   `monitor.view`/`monitor.manage` tutti; elenco e dettaglio d'accordo
   (stessa funzione); un archiviato conta come oggi conta un progetto
   archiviato per chi guarda.

S2. **Le letture nella forma del prototipo** (campi additivi con default,
   schemi in `@stubwise/shared`, `serverViewSchema` e `serverDetailSchema`
   ci passano dall'inline):
   - in ogni riga: `code` (se F4a-2 = a), `health` (`ok` | `warning` |
     `down` | `unknown`, derivata da `last_seen_at`, `active_alerts` e
     controlli giù, con UNA funzione pura in shared che usano server e
     renderer), `environments` (`{ projectCode, environmentName, kind,
     repositoryName }[]`, solo dei progetti visibili), `recentCpu` (gli ultimi
     punti, per la scintilla), `work` e `access` null (F4b);
   - nell'elenco d'istanza (`monitor.manage`): `orphan` (nessun ambiente né
     `server_projects`) e `inArchivedOnly`;
   - nel dettaglio: i controlli con l'ultimo esito, `canManage` calcolato
     dal server, gli episodi (F4a-3), `productionProjects`.
   - `GET /api/servers/by-code/:code` (se F4a-2 = a), registrata prima di
     `/:id`.
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
   nuovo: i client passano dal `readerSchema`) e `sampleCount`. Le
   percentuali (memoria, disco) le calcola il client dai byte (`memTotal`
   c'è): nessun cambio di forma.
   *Test*: 90 giorni non tronca; la media del passo largo è quella dei
   rollup dentro il passo; 24 h come oggi.

S7. **Gli episodi** (se F4a-3 = a): il worker degli avvisi
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

S9. **Il deploy-log** (0180 se c'è, il preset `User` se cambia — con cosa
   vedono gli utenti dopo —, server prima di worker e caddy) e il registro.

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
R5. I link delle card `monitor.*` alla pagina del server.

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

## [DECIDE] Le domande al maintainer

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
