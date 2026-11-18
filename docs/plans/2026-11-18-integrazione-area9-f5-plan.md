# Integrazione area 9, F5 — impostazioni del progetto: piano

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md`, «F5 —
> impostazioni del progetto». Specifica dell'app: il prototipo,
> `apps/desktop/src/renderer/data/projectSettings/` (general, ai, automations,
> repositories, envFiles, plugins, integration, widgetIdentity) e i suoi tipi
> del registro (`projectSettings/changeTypes.ts`, i valori stabili in
> `changelog/settingValues.ts`, «Le forme dell'area 9c»). Invarianti:
> `docs/invariants/second-factor.md` (la riconferma), `change-log.md`,
> `permissions.md`, CLAUDE.md («File `.env` per progetto», «Plugin — limite
> noto v1: una sola persona per volta sulla sezione Plugin del progetto»).
> Branch: `feat/area9-f5` da `feat/integrazione-area9` (con F1–F4).

## Prima del codice

- Le **[DECIDE] K-1…K-5** in fondo. Il piano è scritto con le (a).
- **Fatti del codice che il design non dice**:
  - le rotte dei file d'ambiente sono sotto `/api/repositories/:id/env-files`
    (`routes/project-env-files.ts`): elenco, crea, importa, imposta e togli una
    variabile, elimina;
  - la rigenerazione della chiave d'ingestione e del segreto del webhook git
    NON esistono: le colonne sì (`projects.ingestion_key`,
    `repositories.webhook_secret`);
  - il `PUT /api/projects/:id/plugins` sostituisce l'insieme intero senza
    precondizione (il limite noto v1 del CLAUDE.md);
  - il registro (F2) non ha ancora nessun tipo dell'area 9c: il prototipo ne ha
    una trentina (`PROJECT_CHANGE_TYPES`). Archivio, riapertura ed
    eliminazione (`project.archived`, `project.reopened`, `project.deleted`,
    `repository.linked`) sono di F6; `task.deleted` dell'area 10a;
  - il nome del parametro `key` di `env_var.set`/`env_var.removed` (il NOME
    della variabile, non il valore) farebbe scattare il test di sorgente sui
    segreti (F2): vedi K-3;
  - il web vecchio apre già il dialogo di riconferma su un 403
    `reauth_required` (`apps/web/src/lib/api.ts`): le riconferme nuove non gli
    chiedono codice nuovo.
- **Primo numero libero**: 0192 (se serve: K-4 (a) non ne chiede).

## Regole di lavoro (le solite)

- TDD con le mutazioni (`mut.py`), che girano e danno l'esito sbagliato; un
  verde sospetto si guarda.
- I file di test toccati si lanciano INTERI, uno alla volta (anche quelli dei
  moduli che chiamano ciò che si cambia); ribuild delle dipendenze dopo un
  cambio di branch o fra pacchetti.
- Commit su percorsi espliciti, lint + test + commit + push in una catena.
- Campi dei client solo additivi, coi default; un corpo che cresce è una patch.
- Container dei test tolti per id; un rosso con CONNECTION_CLOSED/409 si
  rilancia da solo prima di crederci.
- Ogni scrittura lascia la sua voce nel registro, nella SUA transazione, mai un
  segreto.

## Task

### Task 1 — Il catalogo del registro della 9c

- I tipi di progetto del prototipo, con il loro gruppo e `readPermission`
  (`project.settings.manage`, `repos.manage`, `environments.manage`,
  `widget.manage`), tranne quelli di F6 e dell'area 10a:
  - `project.renamed`, `description_changed`, `docs_toggled`,
    `ai_account_changed`, `switch_changed`, `pulse_interval_changed`,
    `correction_cap_changed`, `statuses_changed`, `stall_thresholds_changed`,
    `plugins_changed`, `ingestion_key_regenerated`;
  - `repository.created`, `updated`, `pr_mode_changed`,
    `release_pipeline_changed`, `webhook_configured`,
    `webhook_secret_regenerated`, `deleted` (di progetto: l'oggetto resta nel
    registro del progetto);
  - `env_file.created`, `deleted`, `imported`; `env_var.set`, `removed`;
  - `environment.created`, `updated`, `deleted`; `widget.created`, `updated`,
    `deleted`.
- I `params` obbligatori del prototipo (`ProjectChangeParams`): `switch`,
  `field`, `environment`/`repository`, `count`, il nome della variabile (K-3).
- *Test*: il catalogo (gruppi, permessi veri del loro livello, schemi con i
  `params`); la parità coi tipi del prototipo (un test che legge
  `changeTypes.ts` come testo ed elenca i tipi, esclusi quelli dichiarati di F6
  e 10a).

### Task 2 — I file d'ambiente: la riconferma e il registro

- `config.reauth: true` su crea, importa, imposta, togli ed elimina
  (`/api/repositories/:id/env-files*`); la lettura dei nomi no. Il registro
  delle rotte con riconferma si aggiorna.
- Le voci `env_file.created`/`imported`/`deleted` e `env_var.set`/`removed`,
  con l'ambiente e il repository, il nome della variabile, MAI il valore (il
  test di sorgente lo verifica, con l'eccezione di K-3).
- *Test*: ogni scrittura senza riconferma → 403 `reauth_required` e niente
  cambia; con la riconferma, la voce; nessun valore in nessuna voce.

### Task 3 — Le rigenerazioni

- `POST /api/projects/:projectId/ingestion-key` (`project.settings.manage`,
  riconferma): una chiave nuova, mostrata UNA volta; la vecchia smette SUBITO
  (l'ingestion la rifiuta al prossimo invio). Voce
  `project.ingestion_key_regenerated`, mai la chiave.
- `POST /api/repositories/:slug/webhook-secret` (`repos.manage` nel progetto,
  riconferma): un segreto nuovo (32 hex), mostrato una volta; il vecchio smette
  subito (la verifica HMAC del webhook git lo rifiuta). K-5 decide se si
  aggiorna anche il webhook sulla piattaforma. Voce
  `repository.webhook_secret_regenerated`.
- *Test*: la riconferma (negativi), il nuovo valore una volta, la vecchia
  chiave o firma rifiutata subito, la nuova accettata, la voce senza segreti.

### Task 4 — I plugin del progetto con la precondizione

- `PUT /api/projects/:id/plugins` accetta `ifMatch` (additivo): la versione
  letta (K-4). Diversa: `409 stale` con la versione nuova e lo stato attuale.
  Assente: si comporta come oggi (il web vecchio). Il `GET` dice la versione.
- Voce `project.plugins_changed` coi soli campi cambiati (`disabledSkills`,
  `disabledHooks`, liste ordinate: `changedFields`).
- Il CLAUDE.md «limite noto v1» si chiude: la voce del registro dei rimandi va
  segnata chiusa (la applica 46).
- *Test*: due salvataggi dalla stessa lettura → il secondo 409, e la skill
  spenta dal primo resta spenta; senza `ifMatch` come oggi; la voce.

### Task 5 — Il progetto: la regola del pulse e il registro

- La regola del prototipo diventa del server, nel `PATCH /api/projects/:id`
  (K-2): il pulse acceso senza la discovery del backlog → `400
  pulse_needs_backlog`; spegnere la discovery spegne anche il pulse nello
  stesso salvataggio (due voci).
- Le voci delle scritture del progetto: `renamed`, `description_changed`,
  `docs_toggled`, `ai_account_changed` (valore stabile `auto` /
  `account:<id>[:exclusive]`, coi nomi di allora in `params`),
  `switch_changed` (`params.switch`, `on`/`off`), `pulse_interval_changed`,
  `correction_cap_changed` (numeri in stringa), `stall_thresholds_changed` e
  `statuses_changed` (`changedFields`).
- *Test*: la regola (negativo e spegnimento insieme); ogni voce coi suoi valori
  stabili; un salvataggio uguale non scrive.

### Task 6 — Repository, ambienti, widget: il registro

- Le voci delle scritture che esistono: repository creato, aggiornato
  (`params.field`, i soli campi), eliminato, webhook configurato (lo stato
  `configured`/`failed`), modo PR e pipeline di rilascio se il server li ha
  (altrimenti restano tipi senza scrittore, dichiarati); ambienti e widget
  creati, aggiornati, eliminati.
- *Test*: una voce per scrittura, nella sua transazione (una scrittura
  rifiutata dopo la voce non la lascia).

### Task 7 — Il client, il deploy-log, la review

- **Client**: `projects.regenerateIngestionKey`,
  `repositories.regenerateWebhookSecret`, `projects.plugins`/`setPlugins` con
  `ifMatch`, i file d'ambiente se il desktop li chiede (con 94).
- **Deploy-log**: solo server (e caddy se il web vecchio cambia); la chiave
  d'ingestione e il segreto del webhook rigenerati smettono subito (chi li usa
  va avvisato); i file d'ambiente chiedono la riconferma; il limite v1 dei
  plugin chiuso; il rollback (le rotte nuove spariscono, i valori rigenerati
  restano validi).
- `pnpm build` + `check:dist`; review con un revisore fresco. Review Focus:
  - una scrittura di un segreto o di un file d'ambiente senza riconferma;
  - un valore (variabile, chiave, segreto) in una voce, un log, un errore;
  - un valore vecchio che resta valido dopo la rigenerazione;
  - un salvataggio dei plugin che scavalca una modifica altrui;
  - una voce scritta fuori dalla transazione della sua scrittura.

## [DECIDE]

- **K-1 — Il registro della 9c in F5.**
  - **(a) consigliata**: sì, tutti i tipi della 9c tranne F6 e 10a, coi loro
    scrittori (Task 1, 2, 5, 6): F5 è la fetta delle impostazioni del progetto,
    e il registro di F2 vale per ogni scrittura.
  - (b) solo i tipi delle scritture nuove di F5 (rigenerazioni, plugin, file
    d'ambiente); gli altri in una fetta a sé.
- **K-2 — La regola del pulse.**
  - **(a) consigliata**: come il prototipo — pulse acceso senza discovery
    rifiutato (`pulse_needs_backlog`), e spegnere la discovery spegne il pulse
    nello stesso salvataggio.
  - (b) solo il rifiuto; spegnere la discovery con il pulse acceso è un 400.
- **K-3 — Il nome della variabile nelle voci `env_var.*`.**
  - **(a) consigliata**: il parametro si chiama `variable` (non `key`): il test
    di sorgente sui segreti resta senza eccezioni, e il renderer legge
    `params.variable` (lo dico a 94).
  - (b) `key` come il prototipo, con un'eccezione dichiarata nel test di
    sorgente (come `accessKeyId`).
- **K-4 — La versione dei plugin del progetto.**
  - **(a) consigliata**: un digest dello stato delle abilitazioni (come
    `planDigest`), calcolato a lettura: nessuna migrazione, e due stati uguali
    hanno la stessa versione.
  - (b) una colonna `version` incrementata a ogni salvataggio (migrazione).
- **K-5 — Il segreto del webhook git rigenerato e la piattaforma.**
  - **(a) consigliata**: si rigenera e, se il webhook l'ha configurato
    Stubwise (lo stato `configured`), si aggiorna anche sulla piattaforma con
    lo stesso giro della configurazione; se l'aggiornamento fallisce, la
    risposta lo dice (`platformUpdated: false`) e il segreto nuovo è da
    copiare a mano.
  - (b) si rigenera soltanto: il segreto si copia a mano sulla piattaforma.

## Cosa F5 non fa

- Archivio, riapertura ed eliminazione del progetto (F6).
- Le azioni di Claude dell'area 9 (F7).

## Stima

Sette task. Il 5 e il 6 sono i più larghi (molti scrittori, ciascuno con la
sua voce nella sua transazione); il 3 il più delicato (un valore vecchio che
deve smettere subito).
