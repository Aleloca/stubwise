# Integrazione area 9, F3 — istanza: piano

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md`, «F3 —
> istanza» (D-5 = a, D-10 = b, E-2 = a). Specifica dell'app: il prototipo,
> `apps/desktop/src/renderer/data/instance/` (provider, modelli, automazione,
> budget, git, plugin, Google, storage, webhook, analisi dei server) e i suoi
> tipi del registro (`instance/changeTypes.ts`). Invarianti:
> `docs/invariants/second-factor.md` (la riconferma), `change-log.md` (le voci
> nuove), `automations.md`. Branch: `feat/area9-f3` da `feat/integrazione-area9`
> (0714ef8c1, con F1 e F2).

## Prima del codice

- Le **[DECIDE] H-1…H-4** in fondo. Il piano è scritto con le (a).
- **E-2 = a** (maintainer, 16 nov): gli 8 tipi d'avviso delle aree 8a/8b
  entrano nei webhook, spenti di default, sempre dai template. La regola M3
  dell'area 8 (`shouldSendWebhook` li teneva fuori) si riscrive qui.
- **Fatti del codice che il design non dice**:
  - il webhook di oggi è `notification_settings` (una riga, `webhook_url`,
    `format` ∈ `slack | discord | generic`, `enabled` e 18 interruttori
    `notify_*`), letto dal poller delle consegne del WORKER via
    `sendWebhookEvent` (`packages/notifications/src/dispatch.ts`), su una
    consegna per EVENTO (`notification_deliveries`, `channel = webhook`,
    senza notifica dietro): il worker va ribuildato;
  - le rotte di oggi stanno sotto `settings.manage` (`/api/settings/notifications`);
  - `applyReauth` (`auth/access.ts`) non è esportata: la riconferma
    «parziale» (Task 3) la esporta come `requireReauth(request, reply)`, la
    stessa funzione, mai una copia.
- **Primo numero libero**: 0188.

## Regole di lavoro (le solite)

- TDD con le mutazioni (`mut.py`), che girano e danno l'esito sbagliato; un
  verde sospetto si guarda.
- I file di test toccati si lanciano INTERI, uno alla volta; ribuild delle
  dipendenze dopo un cambio di branch o fra pacchetti.
- Commit su percorsi espliciti, lint + test + commit + push in una catena.
- Campi dei client solo additivi; un campo NUOVO obbligatorio in un corpo
  rompe i client vecchi: si dice e si aggiorna il web nello stesso task.
- Container dei test tolti per id; un rosso con CONNECTION_CLOSED/409 si
  rilancia da solo prima di crederci.
- Ogni scrittura nuova lascia la sua voce nel registro (F2), nella sua
  transazione, e mai un segreto (solo «sostituito»).

## Task

### Task 1 — La migrazione 0188: i webhook in uscita

- `outgoing_webhooks`:
  - `id`, `name`, `url`, `format` (l'enum `notification_format` di oggi:
    `slack | discord | generic`, H-2), `enabled`, `events text[]`,
    `secret_encrypted`, `secret_rotated_at`, `created_at`, `created_by_user_id`
    (FK `SET NULL`);
  - CHECK `events <@ ARRAY[…]` col catalogo (Task 2) e `cardinality(events)`
    ≥ 0; il tetto di 20 per istanza lo tiene il servizio (Task 4), sotto un
    lock advisory.
- `notification_deliveries.webhook_id` (FK `ON DELETE CASCADE`, nullable): una
  consegna PER WEBHOOK, così ognuno ha i suoi tentativi e un guasto non
  ferma gli altri.
- **La migrazione dei dati**, solo se `outgoing_webhooks` è vuota e
  `notification_settings.webhook_url` non è nullo: nasce «Webhook» con lo
  stesso URL, formato e `enabled`, gli eventi dei `notify_*` accesi (la mappa
  del Task 2, scritta nella migrazione). Il segreto nasce NULLO
  (`secretSet: false`): la migrazione non ha `ENCRYPTION_KEY` per cifrarlo.
  Finché chi gestisce non lo rigenera gli invii di quel webhook partono senza
  firma, come oggi; lo dice il deploy-log. `notification_settings` resta,
  senza più letture.
- `migration-0188.test.ts`: la migrazione dei dati (acceso coi suoi eventi;
  niente con l'URL vuoto; idempotente), il CHECK sugli eventi, la cascata
  delle consegne.

### Task 2 — Il catalogo in shared

- `OUTGOING_WEBHOOK_EVENTS`: i 21 eventi del prototipo
  (`instance/constants.ts`: 13 «web» e 8 «catalog»), con gruppo e
  `defaultOn` (gli 8 d'avviso spenti, E-2 = a), più la mappa
  evento → `notification_kind` (es. `monitor` → `monitor.alert` e
  `monitor.recovered`; `ticket.created` → anche `request.created`, come
  l'interruttore di oggi).
- Gli schemi delle viste (`outgoingWebhookViewSchema`: niente segreto, solo
  `secretSet` e `secretRotatedAt`; l'URL in chiaro, [IN 4]) e dei corpi.
- I tipi del registro della 9b in `CHANGE_LOG_TYPES` (quelli di
  `instance/changeTypes.ts` per F3: `provider.*`, `model.changed`,
  `automation.changed`, `budget.changed`, `content_language.changed`,
  `server_analysis.changed`, `git_account.*`, `plugin.*`, `google_app.*`,
  `storage.*`) e, per i webhook, quelli di H-3. I `server.*` e `queue.*`
  sono di altre fette.
- Parità: catalogo ⇔ schemi (shared); i template nel renderer (94).

### Task 3 — La riconferma sulle rotte con segreti

- `config.reauth: true` su:
  - `POST` e `DELETE /api/ai-providers`, e `/api/git-accounts`;
  - `POST /api/plugins` e `POST /api/plugins/:id/update`;
  - `POST` e `DELETE /api/settings/google-workspaces`.
- **Parziali** (la riconferma solo quando il corpo porta un segreto), con
  `requireReauth` nell'handler:
  - `PATCH /api/ai-providers/:id` con una chiave nuova;
  - `PATCH /api/git-accounts/:id` col token;
  - `PATCH /api/settings/google-workspaces/:id` col secret;
  - `PUT /api/settings/instance` con una chiave S3 o un segreto Slack nuovi.
  Un test del registro elenca le rotte parziali (dichiarate in
  `config.partialReauth: true`, così l'elenco è chiuso come gli altri).
- **Il plugin «Mi fido»**: `POST /api/plugins` e `/:id/update` vogliono
  `trust: true`, senza `422 trust_required`. Il web vecchio registra plugin:
  il suo dialogo manda `trust: true` dopo la conferma, nello stesso task.
- *Test*: il registro aggiornato; NEGATIVI, per ognuna, senza riconferma →
  `403 reauth_required` e niente scritto (le parziali: senza segreto passa,
  col segreto no).

### Task 4 — I webhook: servizio e rotte

- Sotto `/api/settings/webhooks`, col permesso di H-1:
  - `GET` (l'elenco, senza segreto);
  - `POST` (riconferma; nasce il segreto, che la risposta mostra UNA volta);
  - `PATCH /:id` (nome, URL, formato, eventi, acceso; senza riconferma);
  - `POST /:id/secret` (rigenera; riconferma; mostrato una volta);
  - `DELETE /:id` (riconferma);
  - `POST /:id/test` (l'invio di prova, coi suoi esiti);
  - `GET /preview?format=&event=` (il corpo che arriverebbe, da un evento
    d'esempio, coi template veri).
- Il segreto: 32 byte dal server, cifrato con `ENCRYPTION_KEY`, mai in una
  lettura né in un log né in una voce del registro.
- NEGATIVI: un evento fuori catalogo (400), il 21° webhook (409
  `webhook_limit`), un URL non https (400, come oggi).

### Task 5 — L'invio: uno per webhook, firmato

- `publishNotification` accoda una consegna `webhook` per OGNI webhook acceso
  che ha scelto quel tipo (`webhook_id`), al posto di quella sola di oggi.
- `shouldSendWebhook` diventa «quali webhook»: le audience personali restano
  fuori (mai un evento personale in un webhook); gli 8 d'avviso entrano solo
  dove scelti (E-2 = a, riscrive M3).
- Il poller del worker invia col formato e il segreto di QUEL webhook, con
  `X-Stubwise-Signature: t=<unix>,v1=<hex HMAC-SHA256 di "<t>.<body>">`; un
  webhook spento o cancellato nel frattempo: la consegna si chiude senza invio.
- *Test*: **due webhook con eventi diversi: ognuno riceve solo i suoi**; la
  firma verificabile; uno che fallisce non ferma l'altro (tentativi
  separati); un evento personale mai; un avviso solo se scelto.
- Il golden e i test del worker sul poller delle consegne vanno nel giro.

### Task 6 — Il registro della 9b

- Le voci nelle scritture di provider (creato, aggiornato, riordinato,
  credenziale sostituita, eliminato), modelli, automazione, budget e lingua,
  tetti dell'analisi dei server, account git (creato, aggiornato, token
  sostituito, eliminato, revisore predefinito), plugin (registrato, ref
  aggiornato, smoke rilanciato, rimosso), app Google (creata, aggiornata,
  secret sostituito, eliminata), storage (cambiato, secret sostituito),
  webhook (H-3).
- I valori stabili del prototipo (Ruling T3, `settingValues.ts`): `on/off`,
  `default:sonnet`, l'importo come numero, il locale; mai una parola tradotta.
- *Test*: ogni scrittura lascia la sua voce nella transazione; il test di
  sorgente sui segreti morde i nuovi scrittori (e i loro helper).

### Task 7 — La fonte del modello

- `GET /api/settings/models` aggiunge `source: setting | env | default`
  (additivo, col default nello schema), da `ai_model_settings` →
  `instance_settings.worker_model_defaults` → il default di codice, con la
  STESSA funzione che risolve il modello nel worker (mai una copia).
- *Test*: le tre fonti; il parse senza il campo.

### Task 8 — Il client e il web vecchio

- `packages/api-client`: `webhooks.*` (list, create, update, rotateSecret,
  remove, test, preview), `settings.models` con `source`, il `trust` dei
  plugin; parse senza i facoltativi.
- Il web vecchio: la pagina Notifiche di oggi (H-4) e il `trust` dei plugin.

### Task 8b — Le pagine d'istanza della 9b nel client

*(Aggiunto il 18 nov 2026 su richiesta di 46: l'app fa tutto ciò che fa il
sito, quindi le pagine 9b del prototipo devono potersi collegare in F3. I gesti
li ha elencati 94; quelli che il server non ha li dichiara la parità.)*

- `packages/api-client`, coi gesti che il server ha già:
  - `aiProviders`: list, create, update (anche il nome), reorder, test, remove;
  - `gitAccounts`: list, create, update, validate, setDefaultReviewer,
    unsetDefaultReviewer, remove;
  - `plugins`: list, get, register e updateRef con `trust: true`, rerunSmoke,
    remove;
  - `googleApps`: list (con `accountCount`), create, update, remove;
  - `instanceSettings`: get, save (lingua, budget, archiviazione), automation,
    saveAutomation.
- Le forme passano dalle rotte del server a `@stubwise/shared`
  (`instance-admin.ts`), e il server le importa: una sola copia.
- I segreti si mandano e non tornano mai: le risposte portano solo i flag.
- Non c'è nel server, e la parità lo dichiara: la prova dell'archiviazione,
  l'interruttore degli allegati (derivato dalla config).
- *Test*: url, verbo e corpo di ogni metodo; il parse SENZA i facoltativi
  (`readerSchema`).

### Task 9 — Deploy-log, build e review

- **La voce di deploy-log**: ordine **server** (0188) → **worker** (il poller
  nuovo) → **caddy**; il segreto del webhook migrato è vuoto finché non si
  rigenera (i destinatari JSON che verificano la firma vanno avvisati); il
  rollback (un server o worker vecchio legge `notification_settings`, ferma
  all'ultimo stato prima del deploy: le modifiche fatte dopo si perdono, e le
  consegne con `webhook_id` non le capisce).
- `pnpm build` + `check:dist`; review con un revisore fresco. Review Focus:
  - una rotta con un segreto senza riconferma (anche una parziale);
  - un webhook che riceve un evento che non ha scelto, o un evento personale;
  - il segreto in una lettura, un log, una voce, un errore;
  - una consegna persa o doppia nel passaggio da una a N.

## Cosa F3 non fa

- Stato dell'istanza, pausa della coda, `queue.*`: F4.
- I server e il loro registro (`server.*`): fuori dal 9b di F3.
- I repository d'istanza «Non in un progetto»: F6.

## Stima

Nove task. Il 5 è il più delicato (outbox, worker, firma); il 3 tocca molte
rotte ma è meccanico, col registro che chiude l'elenco.

## [DECIDE]

- **H-1 — Chi gestisce i webhook.** Il design (D-10 = b: «gestiti da chi
  gestisce le integrazioni dell'istanza») dice `integrations.manage`; il
  prototipo e le rotte di oggi dicono `settings.manage`.
  - **a (consigliata)**: `integrations.manage`, come le parole del
    maintainer; il prototipo si adegua, e chi oggi ha solo `settings.manage`
    non vede più il webhook (lo dice il deploy-log).
  - **b**: `settings.manage`, come oggi e come il prototipo.
- **H-2 — Il formato «json».** Il design lo chiama `json`; l'enum di oggi è
  `generic`.
  - **a (consigliata)**: il valore resta `generic` (niente migrazione di un
    enum), e i client lo chiamano «JSON».
  - **b**: rinominare l'enum in `json`.
- **H-3 — Le voci del registro sui webhook.** Il prototipo ha una voce sola,
  `webhook.changed`, per l'unico webhook.
  - **a (consigliata)**: `webhook.created`, `webhook.updated`,
    `webhook.secret_replaced`, `webhook.deleted` (un oggetto per webhook,
    come gli account git); il prototipo si adegua.
  - **b**: `webhook.changed` per tutto, con l'id del webhook nell'oggetto.
- **H-4 — La pagina Notifiche del web vecchio.** Scrive su
  `notification_settings`, che dopo la migrazione nessuno legge più.
  - **a (consigliata)**: le rotte di oggi (`GET`/`PUT
    /api/settings/notifications`, `/test`) diventano una vista di
    compatibilità sul webhook PIÙ VECCHIO (la stessa forma), finché il web
    vecchio non si ritira; se non ce n'è nessuno, il `PUT` lo crea.
  - **b**: la pagina del web vecchio dice «si gestisce nell'app nuova», e le
    rotte vecchie rispondono `410`.
