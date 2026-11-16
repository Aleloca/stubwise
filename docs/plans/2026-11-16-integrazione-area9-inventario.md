# Area 9 — Amministrazione, accessi e impostazioni: inventario

> Inventario per l'integrazione dell'area 9 nell'app nuova (`apps/desktop`),
> 16 nov 2026, su richiesta di stubwise-46. Lato server: stubwise-72. Lato
> renderer: stubwise-94. È solo un documento: qui non si prende nessuna
> decisione, e le domande stanno in fondo (D-n).
>
> Fonti:
> - il design `docs/plans/2026-10-29-desktop-area9-admin-design.md`, coi
>   piani `…-area9a-plan.md`, `…-area9b-plan.md` e `…-area9c-plan.md`;
> - nel prototipo: `apps/desktop/docs/area9-inventory.md` (il perimetro del
>   web del 29 ott), `area9-parity.md` (una riga per voce del web, con file e
>   test del prototipo), `ossatura-follow-ups.md` (§6–§11 le invarianti da
>   riscrivere; «Area 9a/9b/9c — minori aperti» i ruling che divergono dal
>   web) e le shape `apps/desktop/.impeccable/shape/{admin-*,instance-effects,preferences-account,entry,project-*}.md`;
> - il registro dei rimandi (`docs/plans/integrazione-registro-rimandi.md`,
>   «Area 9», più le voci che vi rimandano dalle aree 4, 7 e 8);
> - il server (`apps/server`, `apps/worker`, `packages/*`).
>
> Il principio del design *(maintainer)* è: **l'app fa tutto quello che fa il
> sito, e di più**. Il «di più» sono il registro delle modifiche, «Chi può
> farlo?» e lo Stato dell'istanza. Restano fuori per decisione del maintainer
> (29 ott): Slack (DM, identità, «Invita da Slack», Slack d'istanza), la posta
> ammessa, le regole della posta del progetto e «Rigenera il brief».

## Le voci

Gli stessi titoli nei due lati:

1. Ingresso: login, invito, reset, primo avvio
2. Preferenze: account e profilo, lingua e tema
3. Preferenze: sicurezza (secondo fattore, passkey, codici, sessioni, registro personale)
4. Preferenze: token e Claude Code
5. Persone e inviti
6. Ruoli
7. Members del progetto
8. Reparti
9. «Chi può farlo?»
10. Registro delle modifiche
11. La riconferma
12. AI dell'istanza
13. Integrazioni: account git, plugin, Google Workspace, storage, webhook in uscita
14. Viste d'istanza: server e repository
15. Stato dell'istanza: la coda, la pausa, il rilancio
16. Progetto → Settings: generali, AI, automazioni
17. Progetto → Settings: repository e file d'ambiente
18. Progetto → Settings: Integrazione, plugin, consumi
19. Archivio ed eliminazione del progetto
20. Inbox: «Restore», «Move to New», «non letta»
21. Azioni di Claude dell'area 9 (la classe C)
22. La cassaforte dal desktop

## Lato server

> Di stubwise-72. Per ogni voce: cosa fa il prototipo, cosa ha già il server
> (rotte, tabelle) e le lacune. Notazione: `user` = chiunque abbia una
> sessione; `inst:X` / `proj:X` = permesso d'istanza / di progetto; `reauth`
> = `config.reauth`; `browserOnly` = `config.browserOnly`. Stato:
> **c'è**, **in parte**, **manca**.

### ⚠️ Prima del codice: le invarianti da riscrivere

Il design le cambia deliberatamente (`ossatura-follow-ups.md` §6–§11). Il
server oggi applica la versione di prima:

1. **«Nessuna escalation, e il BERSAGLIO è protetto»**
   (`docs/invariants/permissions.md`). Il maintainer (30 ott) toglie il
   bersaglio protetto: chi ha il permesso di gestione modifica chiunque.
   - Resta l'`escalation` sul DARE (si danno solo permessi che si hanno).
   - Restano il rifiuto su sé stessi e «resta sempre un full admin».
   - Il server applica ancora `target_above` in `assertTargetNotAbove`
     (`apps/server/src/services/roles.ts:94`, usato a :283 e :464) e in
     `assertCanActOnUser`.
   - Rischio accettato dal maintainer (§6, «Va bene così»): chi ha
     `users.manage` può azzerare il secondo fattore e mandare il link di
     reset a un full admin, e prenderne il posto.
2. **I permessi di progetto dati da un reparto** (§7): non esistono
   (`department_roles` porta solo `department.home.manage`). D-1.
3. **I permessi personali in più su un membro** (§8): non esistono
   (`project_members` ha solo `role_id`).
4. **La pausa della coda e lo Stato dell'istanza** (§9): la pausa è nuova e
   va scritta accanto a «Stubwise non fa deploy». Una coda in pausa non
   prende lavoro nuovo, e il lavoro già partito finisce. Agisce solo sulla
   coda di Stubwise, mai su un ambiente.
5. **Il passo bloccato dal budget che riparte da solo** (§10): oggi
   `budget_held` non riparte.
6. **Archivio, eliminazione, repository staccati** (§11): l'archivio non
   esiste (D-8).

### 1. Ingresso: login, invito, reset, primo avvio — c'è

- **Prototipo** (`pages/entry/`): login col secondo fattore (codice, passkey,
  backup; blocco dopo 5), registrazione su invito, reset, primo avvio,
  istanza vuota.
- **Server**:
  - `POST /api/auth/login`, `GET /api/auth/second-factor`, `…/verify`,
    `…/passkey/*`, `…/enroll*`;
  - `POST /api/auth/register` (`public`), `POST /api/auth/setup`, il reset
    con token;
  - desktop: `POST /api/auth/desktop-handoff` (`reauth`),
    `/desktop-exchange` (`public`), `/desktop-reauth`.
- **Lacune**: nessuna per il desktop, dove il login passa già dal browser
  (PKCE). D-15 dice cosa ne fa la web «app».

### 2. Preferenze: account e profilo, lingua e tema — in parte

- **Prototipo** (`AccountSection.tsx`):
  - nome, email di login, foto;
  - cambio password, che chiude le altre sessioni;
  - progetti seguiti;
  - caselle Google (collega, ricollega, scollega; «Proposals» per casella).
- **Server**:
  - `PATCH /api/auth/me`: solo `displayName` e `language`;
  - `POST /api/auth/me/password` (`reauth`, browser o desktop confermato);
  - `/api/me/follows`;
  - `/api/me/google/*` (tutte `user`).
- **Lacune**:
  - **la foto** (c'è solo quella di Slack, `users.slack_avatar_url`);
  - **cambiare la propria email**;
  - il fuso orario. Il tema è solo del client. D-13.

### 3. Preferenze: sicurezza — in parte

- **Prototipo** (`SecuritySection.tsx`): TOTP con QR, passkey (aggiungi,
  rinomina, rimuovi; l'ultimo metodo non si toglie), codici di backup
  (rigenera e mostra 10), **sessioni con «Sign out» di un'altra**, registro
  personale.
- **Server** (`apps/server/src/routes/me-security.ts`):
  - `GET /api/me/security`: stato TOTP, passkey, `backupCodesRemaining`, gli
    ultimi 50 `security_events`;
  - `POST /totp/setup*` (`setup_allowed`);
  - `POST /backup-codes` (`reauth`);
  - `POST /passkeys*` (`reauth`, `browserOnly`);
  - `PATCH /passkeys/:id`;
  - `DELETE /passkeys/:id` (`reauth`).
- **Lacune**:
  - **le sessioni del browser: manca**. Non c'è un elenco né il «Sign out» di
    una sessione sola. Si chiude solo la propria (`POST /api/auth/logout`),
    e un cambio password chiude le altre. Le sessioni desktop sono PAT
    `kind='desktop'` e si vedono in `/api/pats`. D-9.
  - **I tentativi rimasti del secondo fattore** (registro): manca. Si
    espone solo `lockedUntil` (`423 second_factor_locked`); il conteggio
    sta in `users.second_factor_failures` ma nessuna rotta lo dà.
  - Nessuna rotta dice quando scade la finestra della riconferma.
  - Dal desktop non ci sono passkey (D1 della riconferma): Security
    nell'app desktop rimanda al browser per quelle.

### 4. Preferenze: token e Claude Code — c'è

- **Prototipo**: PAT con nome e scadenza, visto una volta, revoca; il
  comando monouso di Claude Code, con un token nuovo.
- **Server**:
  - `GET /api/pats`;
  - `POST /api/pats` (`reauth`);
  - `DELETE /api/pats/:id` (senza `reauth`; spegne anche i `device_tokens`).
  - Claude Code non ha una rotta: il web crea un PAT e compone il comando
    nel client (`apps/web/src/lib/install-guide-shared.ts`). Il desktop farà
    lo stesso.
- **Lacune**: nessuna.

### 5. Persone e inviti — in parte

- **Prototipo** (`pages/admin/People*`):
  - elenco con gli inviti come righe;
  - ruolo d'istanza, link di reset, azzeramento del secondo fattore,
    registro di sicurezza della persona;
  - identità git e Bitbucket;
  - **disattiva e riattiva**: con la riassegnazione delle task, la revoca
    degli inviti mandati, «(deactivated)» sulle task tenute; mai l'ultimo
    full admin, mai sé stessi;
  - gli inviti: crea con progetti e ruolo, link visto una volta, revoca.
- **Server**:
  - `GET /api/users`, `GET /api/people`;
  - `PATCH /api/users/:id/instance-role` (`reauth`);
  - `POST /:id/password-reset` (`reauth`);
  - `DELETE /:id/second-factor` (`reauth`);
  - `GET /:id/security-events`;
  - identità git: `POST`/`DELETE /api/users/:id/git-identities*` (`reauth`),
    `PUT`/`DELETE /bitbucket`, `GET /api/git/observed-authors`;
  - inviti: `POST /api/auth/invites` (`inst:users.invite`, `reauth`, con
    progetti iniziali in `invite_projects`), `GET`, `DELETE /:token`.
- **Lacune**:
  - **disattivare e riattivare: manca** (nessuna colonna, nessuna rotta).
    D-6.
  - L'eliminazione di una persona esiste come servizio (`deleteUser`,
    `services/roles.ts:487`) ma non come rotta (ruling R27).
  - `target_above` da togliere (invariante 1).

### 6. Ruoli — c'è

- **Prototipo**: preset e ruoli a mano; crea, duplica, modifica, elimina
  (bloccata se in uso, con chi lo usa); una frase per permesso.
- **Server**:
  - `GET /api/roles`;
  - `POST /api/roles`, `POST /:id/duplicate`, `PATCH /:id`, `DELETE /:id`
    (`inst:roles.manage`, `reauth`; `409 role_in_use` con `count`);
  - il catalogo è in `packages/shared/src/permissions.ts`.
- **Lacune**:
  - i permessi locali del prototipo `changelog.view` e
    `instance.status.view` non sono nel catalogo;
  - `target_above` (invariante 1);
  - «chi lo usa» oggi è solo un conteggio.

### 7. Members del progetto — in parte

- **Prototipo** (`MembersSettings.tsx`):
  - ruolo e **permessi in più** per persona, con la **provenienza di ogni
    permesso** («dal ruolo Developer», «dato da Roberta», «dal reparto …»);
  - una bozza salvata in una scrittura sola, con la riconferma;
  - l'ultimo gestore non si toglie da solo;
  - qui si danno `servers.operate` e `servers.ssh.manage`.
- **Server**:
  - `GET /api/projects/:projectId/members`;
  - `PUT /:projectId/members/:userId` (solo `roleId`, `reauth`);
  - `DELETE` (`reauth`).
- **Lacune**:
  - **i permessi personali: manca** (nessuna tabella), e con loro la
    provenienza («dato da X il …»);
  - **`putProjectMember` non lascia traccia** (registro: «audit vera dei
    membri»), va col registro delle modifiche;
  - `target_above`.

### 8. Reparti — in parte

- **Prototipo** (già integrato, `real/departments.ts`): crea, rinomina,
  colora; membri; chi gestisce la Home; elimina spostando le task. I
  **permessi di progetto del reparto** sono nascosti nell'app
  (`department-permissions` spento).
- **Server**:
  - `/api/departments`: `GET`; `POST`, `PATCH /:id`, `DELETE /:id`
    (`inst:departments.manage`);
  - `PUT /:id/roles` (senza `reauth`, per scelta del 9 nov).
- **Lacune**: i permessi di progetto dati da un reparto non esistono (D-1).
  Se si fanno, il calcolo è in UN posto (`projectPermissionsFor`,
  `apps/server/src/auth/access.ts`), e l'`escalation` vale anche qui.

### 9. «Chi può farlo?» — manca

- **Prototipo** (`WhoCanPage.tsx`, il popover `WhoCanLink.tsx`):
  - da un'azione e un progetto, chi può e perché (ruolo, permesso in più,
    full admin, reparto);
  - da una persona, cosa può;
  - Claude con la sua riga fissa;
  - mai un progetto invisibile (R-G5).
- **Server**: nessuna rotta. I mattoni ci sono: `can`,
  `projectPermissionsFor`, `projectPermissionsOfUser`,
  `projectIdsWithPermission`, `visibleProjectIds`. D-11.

### 10. Registro delle modifiche — manca

- **Prototipo** (`ChangeLogPage.tsx`, `ProjectChangeLog.tsx`):
  - un giornale per giorni, con una frase da template i18n, prima/dopo, il
    progetto e un link;
  - filtri per persona, progetto, tipo, periodo;
  - non si modifica né si cancella;
  - i tipi li registrano 9a, 9b e 9c (`person.*`, `invite.*`, `role.*`,
    `department.*`, `member.*`, `provider.*`, `model.changed`,
    `budget.changed`, `git_account.*`, `plugin.*`, `storage.*`,
    `webhook.changed`, `queue.paused`/`resumed`, `job.retried`, `project.*`,
    `repository.*`, `env_file.*`…);
  - la lettura è filtrata per ciò che chi guarda può vedere (R-M1).
- **Server**:
  - c'è solo `security_events` (secondo fattore, reset, cassaforte; 1 anno);
  - gli altri cambi sono righe di log (i ruoli di reparto:
    `event: department.home_managers_changed`) o l'ultimo autore
    (`ai_model_settings.updated_by_user_id`);
  - `project_decisions` è un registro di DECISIONI, non di modifiche.
- **Lacune**: tutto — tabella, scrittori in ogni rotta che cambia
  qualcosa, lettura filtrata, permesso `changelog.view`. È la lacuna più
  grossa dell'area. D-3, D-4.

### 11. La riconferma — in parte

- **Prototipo**: `REAUTH_REQUIRED` (`data/auth/reauth.ts:42`), finestra di
  10 minuti per persona, un PAT non basta mai.
- **Server**: `config.reauth` (`applyReauth`, `REAUTH_WINDOW_MS` = 10'). Il
  PAT desktop passa solo nella sua finestra (`pat.second_factor_at`), dove
  `desktop-reauth` va solo con codice. Un `browserOnly` esclude anche il
  desktop.
- **Le differenze** fra le due liste (ognuna è un rifiuto inatteso nell'app,
  o una riconferma che manca):

  | Azione del prototipo con riconferma | Server |
  |---|---|
  | provider AI: crea, sostituisci la chiave, elimina | `/api/ai-providers`: **senza** `reauth` |
  | account git: crea, sostituisci il token, elimina | `/api/git-accounts`: **senza** |
  | plugin: registra, aggiorna a un ref | `/api/plugins`: **senza** |
  | app Google: crea, sostituisci il secret, elimina | `/api/settings/google-workspaces`: **senza** |
  | storage con una chiave nuova (e i segreti di Slack) | `PUT /api/settings/instance`: **senza** |
  | elimina un repository staccato | la rotta non c'è (voce 14) |
  | rigenera la chiave d'ingestione, il segreto del webhook git | le rotte non ci sono (voce 18) |
  | file d'ambiente: importa, imposta o togli una variabile, elimina | `/api/repositories/:id/env-files*`: **senza** |
  | elimina il progetto | `DELETE /api/projects/:projectId`: **senza**, e con `project.settings.manage` (voce 19) |
  | ruoli, membri, inviti, persone, PAT, passkey, codici | **con** (allineato) |
  | reparti | **senza** in entrambi (maintainer, 9 nov) |

  D-5.

### 12. AI dell'istanza — c'è

- **Prototipo** (`pages/admin/ai/`):
  - provider in catena di riserva: aggiungi, riordina, accendi, prova,
    sostituisci la chiave, elimina;
  - modelli per operazione, con la fonte del valore;
  - automazione: auto-fix, effort, approvazione del piano, costo massimo,
    tetto della review delle PR;
  - budget e lingua dei contenuti;
  - consumi a 7/30/90 giorni;
  - i tetti dell'analisi dei server (area 8).
- **Server**:
  - `/api/ai-providers*` (`inst:ai_providers.manage`);
  - `GET`/`PATCH /api/settings/models` (`inst:settings.manage`, con
    `workerDefault`);
  - `GET`/`PUT /api/settings/automation`;
  - budget e lingua in `PUT /api/settings/instance`;
  - `GET /api/ai-usage/costs`, `/breakdown` (filtrati per progetti visibili),
    `/snapshots` (`inst:usage.view`);
  - `GET`/`PUT /api/settings/server-analysis`.
- **Lacune**:
  - la riconferma (voce 11);
  - la fonte del modello oltre a `workerDefault` (env o impostazione);
  - il budget che fa ripartire i passi bloccati (invariante 5).

### 13. Integrazioni — c'è, salvo il webhook in uscita

- **Account git**: `/api/git-accounts*` (`.view`/`.manage`), revisore
  predefinito, verifica.
- **Plugin**: `/api/plugins*` (`inst:plugins.manage`), materializzazione e
  smoke veri sul worker. Il prototipo vuole «Mi fido» + riconferma su
  registra e aggiorna (maintainer, [IN 2]).
- **Google Workspace**: `/api/settings/google-workspaces*`. L'origine vera
  è `PUBLIC_URL` (registro: al posto di `INSTANCE_ORIGIN` finto, anche nel
  DSN della voce 18).
- **Storage S3**: in `PUT /api/settings/instance` (il segreto si dice solo
  «impostato»), con `attachmentsEnabled`.
- **Webhook in uscita — in parte**: `GET`/`PUT /api/settings/notifications`
  e `POST …/test` (`inst:settings.manage`), una riga sola in
  `notification_settings` con 15 `notify_*`. Il prototipo ha 21 eventi in 6
  gruppi (13 del web e 8 degli avvisi delle aree 8a/8b) e l'anteprima per
  formato. Mancano gli 8 eventi degli avvisi e l'anteprima (D-10). Il
  prototipo NON tratta l'URL come un segreto ([IN 4]).
- **Lacune**: la riconferma; gli 8 eventi; l'anteprima.

### 14. Viste d'istanza: server e repository — in parte

- **Server d'istanza**: già integrati (area 8, F4a). Il prototipo arriva a
  30d e 90d; il server ha le metriche aggregate (verificare le finestre in
  F4a).
- **Repository d'istanza**: `GET /api/repositories` c'è. Mancano:
  - il gruppo «Non in un progetto» (repository staccati);
  - «Collega a un progetto»;
  - **l'eliminazione di un repository** (nessuna `DELETE`).
  Nascono con l'eliminazione del progetto (voce 19).

### 15. Stato dell'istanza: la coda, la pausa, il rilancio — manca

- **Prototipo** (`InstanceStatusPage.tsx`):
  - le code per progetto; i lavori con tipo, età e stato; i worker; la quota
    dal vivo; gli errori legati alla task; il giro notturno;
  - **Pausa/Ripresa** della coda di un progetto (`settings.manage`): il
    lavoro nuovo aspetta, quello partito finisce; alla ripresa i tenuti
    ripartono in ordine d'arrivo; «Queue paused by …» nell'intestazione del
    progetto;
  - **Retry** di un `task_run` fallito negli ultimi 7 giorni
    (`settings.manage` + `runs.start`), a nome di chi preme, dal gate del
    piano; mai su una correzione ferma.
- **Server**:
  - c'è il rilancio PER TASK (`POST /api/tickets/:id/run-ai`, `runs.start`;
    l'azione `relaunch` dell'inbox);
  - ci sono le sessioni (`GET /api/agent-sessions`);
  - non c'è una vista della coda d'istanza, l'elenco dei worker
    (heartbeat), un feed degli errori recenti, né la pausa;
  - `queue_paused` è atteso anche dal passo di Claude delle automazioni
    (registro, area 7 F3).
- **Lacune**: tutto il lato server. D-7.
- **Riavvii**: nessuno, per costruzione (anti-obiettivo; «Stubwise non fa
  deploy»).

### 16. Progetto → Settings: generali, AI, automazioni — c'è

- **Prototipo**:
  - General: nome, descrizione, interruttore Docs; il codice in sola
    lettura;
  - AI: account preferito e «Use only this account»;
  - Automations: Docs notturni, report giornaliero, discovery, pulse (con i
    giorni), brief settimanale, giri massimi di correzione; discovery spento
    spegne anche il pulse.
- **Server**: `PATCH /api/projects/:projectId`
  (`proj:project.settings.manage`, `updateProjectSchema`) con name,
  description, aiProviderId, aiProviderExclusive, docAutoUpdate,
  dailyReportEnabled, backlogEnabled, pulseEnabled, pulseEveryDays,
  weeklyBriefEnabled, prCorrectionMaxRounds, code, clientName, modules.
- **Lacune**:
  - nessuna di forma;
  - il registro (voce 10);
  - verificare che «discovery spento spegne il pulse» sia una regola del
    server e non solo del prototipo.

### 17. Progetto → Settings: repository e file d'ambiente — in parte

- **Prototipo**:
  - creazione guidata in 4 passi (account, repository, ramo, verifica
    d'accesso, comandi);
  - modifica; revisore; rami protetti;
  - «Configure automatically» del webhook git;
  - file d'ambiente in sola scrittura, con la riconferma (solo `test`
    raggiunge Claude).
- **Server**:
  - `POST`, `GET`, `PATCH /api/repositories*` (`proj:repos.manage`);
  - `GET /api/git-accounts/:id/repositories` e `…/branches`;
  - `…/validate-repo`;
  - `GET …/webhook`, `POST …/configure-webhook`;
  - `/api/repositories/:id/env-files*`.
- **Lacune**: la riconferma sui file d'ambiente; nessuna `DELETE` di un
  repository; il registro.

### 18. Progetto → Settings: Integrazione, plugin, consumi — in parte

- **Prototipo**:
  - chiave d'ingestione mascherata, DSN, snippet, webhook in arrivo, segreto
    del webhook git, guida SDK;
  - **rigenerazione** (riconferma, vista una volta);
  - plugin del progetto per sottrazione, col preset e il conflitto di
    bozza;
  - consumi del progetto.
- **Server**:
  - plugin: `GET`/`PUT /api/projects/:projectId/plugins` (senza
    precondizione di versione: il limite noto v1 del CLAUDE.md);
  - consumi: `/api/ai-usage/*` filtrati per progetto.
- **Lacune**:
  - **rigenerare la chiave d'ingestione e il segreto del webhook git:
    manca**;
  - il conflitto di bozza del prototipo ([PG 5]) vuole una precondizione
    di versione sul `PUT`, oggi assente.

### 19. Archivio ed eliminazione del progetto — manca

- **Prototipo** (`ArchiveSettings.tsx`, `pages/projects/Archived*`):
  - archivia, rifiutato `busy` con lavoro vivo; le esecuzioni aperte delle
    automazioni si annullano;
  - l'archiviato sparisce ovunque, e lo vedono solo gli ex membri e i full
    admin, in sola lettura, a `#/archived/<CODE>`;
  - riapri;
  - **elimina solo un archiviato, solo un full admin**, scrivendo il codice
    e con la riconferma; i repository restano staccati.
- **Server**:
  - nessun archivio (`projects` non ha la colonna, e `inArchivedOnly` resta
    `false` dalla F4a);
  - `DELETE /api/projects/:projectId` c'è, con `project.settings.manage` e
    senza riconferma.
- **Lacune**:
  - tutto l'archivio;
  - il cambio di chi può eliminare, che restringe il web di oggi (D-8).

### 20. Inbox: «Restore», «Move to New», «non letta» — manca

- **Server**: `/api/inbox` ha `read`, `snooze`, `handled` e le azioni. Non
  ha il ritorno da `handled` a `open`, lo spostamento in «New», né
  `unread`.
- **Lacune**: tre rotte piccole. La card ha già `status` e `read_at`.

### 21. Azioni di Claude dell'area 9 — manca

- **Prototipo** (`data/claude/catalog.ts`):
  - sei azioni di classe C (`addMember`, `removeMember`, `setMemberRole`,
    `registerPlugin`, `updatePluginRef`, `saveStorage`), con la classe presa
    SOLO da `REAUTH_REQUIRED`;
  - una ventina di classe B dell'area 9 (archivia, riapri, impostazioni di
    progetto, modello, budget, provider on/off, pausa e rilancio…);
  - i segreti mai nel catalogo.
- **Server**: il catalogo (`packages/shared/src/schemas/claude-actions.ts`,
  `apps/server/src/claude-actions/`) ha solo le classi A e B delle aree 2–8.
  La classe C è «la fetta 4», vuota. `claude-actions-never.test.ts` vieta
  PAT, inviti, segreti, decisioni, merge e approvazioni.
- **Lacune**:
  - la classe C con la riconferma di chi conferma;
  - le azioni B e C dell'area 9;
  - nel renderer, `confirmEdited` che salta `reauth()` (registro).

### 22. La cassaforte dal desktop — bloccata

- **Server**: `vaultRoutes` forza `browserOnly` su ogni rotta (`vault.ts:91`)
  e `credentials.ts` tiene i suoi `session_required`.
  `docs/invariants/vault.md`: la chiave di una persona si apre solo col
  segreto PRF di una passkey, e dal desktop le passkey non ci sono.
- **Registro**: il maintainer la vuole dal desktop (10 nov), con due strade
  (la passkey nel browser consegnata all'app, o un secondo modo di
  sbloccare). Entrambe sono un lavoro a sé, e la seconda cambia
  un'invariante. D-12.

## Lato renderer

> Di stubwise-94. Il dettaglio schermata per schermata c'è già e non si
> ricopia:
> - `apps/desktop/docs/area9-parity.md`: una riga per voce del web, con file
>   e test del prototipo;
> - `apps/desktop/docs/area9-inventory.md`: l'inventario del web del 29 ott;
> - `apps/desktop/docs/ossatura-follow-ups.md`, «Area 9a/9b/9c — minori
>   aperti»: i ruling che divergono dal web.

### Cosa resta «Coming soon» nell'app

- **Admin**: people, roles, changelog, who-can, ai, git-accounts, plugins,
  google, storage, webhooks, repositories, status. Accese oggi: departments
  e servers.
- **Preferenze**: account, security, tokens, claude-code, look. Accesa:
  notifications.
- **Progetto → Settings**: general, members, ai, automations, integration,
  plugins, usage, changelog, archive. Accese: statuses, e repositories
  ridotta a Releases.
- **Funzioni**:
  - `servers-analysis-limits`;
  - `department-permissions`;
  - l'archivio (`#/archived/<CODE>` e la scheda Archived);
  - gli interruttori di brief e report, la pausa della coda e il lavoro
    fermo.
- **Dal registro**:
  - audit dei membri e registro dell'istanza;
  - Inbox (Restore, Move to New, non letta);
  - tentativi rimasti del secondo fattore;
  - la classe C con `confirmEdited`;
  - `queue_paused` nelle automazioni;
  - la cassaforte dal desktop;
  - l'origine vera dell'istanza.
- `view-as` resta solo del prototipo.

### Le differenze di parità attese (dove il prototipo ha più del server, o diverso)

1. Registro delle modifiche: il gap più grosso (voce 10).
2. Stato dell'istanza, pausa e Retry: non esistono né sul web né sul server
   (voce 15).
3. L'archivio del progetto (voce 19).
4. I permessi di reparto (voce 8, D-1).
5. «Who can?»: serve una rotta (voce 9, D-11).
6. Passkey e cassaforte dal desktop. Security nell'app desktop rimanda al
   browser per le passkey; TOTP e codici sì.
7. Webhook in uscita: 21 eventi contro i 15 del server (voce 13, D-10).
8. Plugin: «Mi fido» e la riconferma (voce 11).
9. Riconferma: `REAUTH_REQUIRED` contro `config.reauth` (la tabella della
   voce 11).
10. Identità git/Bitbucket, account AI preferito ed esclusività: da
    verificare contro le colonne vere.
11. I segreti visti una volta (PAT, comando di Claude Code, chiave
    d'ingestione, token git, client secret, chiave S3) devono uscire una
    volta sola anche dal server. Nell'app hanno `secret: true` e stanno
    fuori dalla cache.
12. Fuori per decisione del maintainer (29 ott): Slack in ogni forma, la
    posta ammessa, le regole della posta del progetto, «Rigenera il brief».

### Cosa cambiano nel renderer le risposte del lato server

Il prototipo ha più del server in questi punti, e nell'app ognuno resta
spento (I1) finché la sua decisione non lo copre:
- **Account** (D-13 = a): nell'app restano nome e lingua; la foto e il
  cambio dell'email si nascondono, non si mostrano «in arrivo».
- **Security**: l'elenco delle sessioni c'è solo con D-9 = a. Senza, la
  sezione mostra TOTP, codici e passkey, e la riga «registro e sessioni»
  perde le sessioni. Le passkey dal desktop rimandano al browser (D1). I
  «tentativi rimasti» restano fuori finché il server non li manda, e
  l'errore dice solo «codice sbagliato».
- **Look**: lingua e tema sono locali, salvo la lingua del profilo. È
  accendibile subito, senza aspettare il resto di F1.
- **Webhook in uscita** (D-10 = a): il prototipo passa dai 21 eventi ai 15
  del server più gli 8 degli avvisi; i gruppi e l'anteprima seguono
  l'elenco vero.
- **Riconferma** (D-5): con a il renderer non cambia (`REAUTH_REQUIRED` è
  già la lista). Con b l'app chiederebbe la riconferma dove il server non la
  vuole, e il web no: due regole diverse per la stessa rotta. Per questo
  consiglio a anch'io.
- **«Who can?»** (D-11 = a): il prototipo calcola in locale, e nell'app
  legge la rotta. Il calcolo non si duplica nel client.
- **Archivio** (D-8): finché manca, `#/archived/<CODE>` e la scheda Archived
  restano «in arrivo», e «Elimina il progetto» non si mostra.

### Le fette viste dal renderer

- **F1 è grande per il renderer**: cinque sezioni di Preferenze più People,
  Roles, Members e Who can. Propongo di farla in due consegne sullo stesso
  backend: **F1a**, le Preferenze, e **F1b**, People, Roles, Members e Who
  can. Look può uscire anche prima, da sola.
- **F2 prima di F3–F6** va bene: il registro del prototipo ha già il punto
  d'estensione (`changelog/record.ts` più i tipi di ciascuna area), quindi
  ogni fetta dopo ci aggiunge i suoi tipi senza toccare la pagina.
- **F4 (Stato dell'istanza)** sblocca anche `queue_paused` nelle automazioni
  (area 7, F3), lato renderer.
- **I tetti dell'analisi dei server** (`servers-analysis-limits`, area 8)
  entrano con F3, insieme ad Amministrazione → AI.

### L'ingresso nella web «app»

Nel desktop il login passa dal browser, quindi le pagine d'ingresso del
prototipo lì non servono. La web «app» (`/app`) usa il cookie del web.
Invito e reset sono rotte pubbliche del web vecchio (D-15).

## Proposta di fette

L'ordine segue le dipendenze: 9b e 9c usano il registro e la riconferma di
9a, e la classe C usa le azioni delle fette prima.

- **F1 — accessi** (server + renderer):
  - le invarianti 1 e 3 riscritte prima del codice;
  - `target_above` tolto;
  - i permessi personali sui membri, con la provenienza (tabella nuova);
  - disattiva e riattiva (D-6);
  - le sessioni del browser (D-9);
  - i tentativi rimasti e la scadenza della finestra;
  - «Chi può farlo?» (D-11);
  - Inbox Restore, Move to New, non letta.
  - Renderer: Preferenze (account, security, tokens, claude-code, look),
    People, Roles, Members, Who can.
- **F2 — il registro delle modifiche** (D-3, D-4):
  - la tabella e il meccanismo d'estensione;
  - gli scrittori di 9a (persone, inviti, ruoli, reparti, membri);
  - la lettura filtrata (R-M1), con `changelog.view`;
  - la pagina d'istanza e quella del progetto.
  - Le fette dopo vi aggiungono i loro tipi.
- **F3 — istanza** (9b):
  - la riconferma sulle rotte con segreti (D-5);
  - AI, account git, plugin («Mi fido»), Google, storage;
  - il webhook in uscita con gli eventi degli avvisi (D-10);
  - la vista dei repository d'istanza;
  - i loro tipi nel registro.
- **F4 — Stato dell'istanza** (D-7):
  - l'invariante 4 prima del codice;
  - la vista della coda, i worker, gli errori;
  - pausa e ripresa per progetto (il worker la rispetta; `queue_paused`
    anche nelle automazioni);
  - il Retry dalla pagina;
  - l'invariante 5 (il budget che fa ripartire i tenuti), se il maintainer
    la conferma.
- **F5 — impostazioni del progetto** (9c):
  - generali, AI e automazioni, che ci sono già;
  - repository, con la riconferma sui file d'ambiente;
  - la rigenerazione della chiave d'ingestione e del segreto del webhook
    git;
  - plugin con la precondizione di versione;
  - consumi; il change log del progetto.
- **F6 — archivio ed eliminazione** (D-8):
  - l'invariante 6;
  - l'archivio con le sue sparizioni (⌘K, notifiche, Home, automazioni,
    Stato dell'istanza, «Chi può farlo?»);
  - riapri;
  - l'eliminazione al solo full admin, con la riconferma; i repository
    staccati, con la loro `DELETE`.
- **F7 — azioni di Claude dell'area 9** (D-14): la classe C con la
  riconferma di chi conferma, e le B dell'area 9.
- **A parte, se D-1 = a**: i permessi di progetto dei reparti. E la
  cassaforte dal desktop (D-12).

## Le risposte del maintainer *(via 46, 16 nov 2026)*

D-1 = a, D-2 = a, D-3 = a, D-4 = a, D-5 = a, D-6 = a, D-7 = a, D-8 = a,
D-9 = a, **D-10 = b** (più webhook in uscita, ciascuno con URL, formato,
eventi e segreto suoi), D-11 = a, D-12 = a (la cassaforte dal desktop in un
design a sé, voce nel registro), **D-13 = b** (il profilo tutto ora: foto e
cambio dell'email con la verifica), D-14 = a, **D-15 = b** (la web «app» usa
le pagine d'ingresso del prototipo). Il seguito, con le fette riviste, le
invarianti riscritte e le domande nuove (E-n), è nel design:
`docs/plans/2026-11-16-integrazione-area9-design.md`.

## [DECIDE]

La prima opzione è la consigliata.

- **D-1 — I permessi di progetto dati da un reparto.**
  - Il design li dà per decisi *(maintainer, 29 ott: «un reparto dà
    permessi di progetto»)*; il registro li dice «da decidere se servono».
  - **a (consigliata)**: sì, in una fetta a sé dopo F1. Il calcolo resta in
    UN posto (`projectPermissionsFor`), l'`escalation` vale anche lì, e si
    danno solo nei progetti dove la persona è già membro.
  - **b**: no, il flag resta spento e il prototipo li perde.
- **D-2 — Togliere il «bersaglio protetto».**
  - **a (consigliata)**: confermato com'è nel design (30 ott). Si riscrive
    l'invariante in F1, col rischio accettato scritto lì: chi ha
    `users.manage` può prendere il posto di un full admin col reset del
    secondo fattore e il link di reset. Il secondo diventa visibile nel
    registro e con `security.alert`.
  - **b**: resta, e il prototipo si adegua al web.
- **D-3 — Il registro delle modifiche.**
  - **a (consigliata)**: una tabella sola (`change_log`), con voci TIPIZZATE
    scritte nella stessa transazione della modifica, la frase da un template
    i18n e prima/dopo senza mai un segreto. La lettura è filtrata per ciò
    che chi guarda vede. Nessun recupero del passato: comincia dal deploy.
  - **b**: allargare `security_events`.
  - **c**: solo un log strutturato.
- **D-4 — Quanto resta il registro.**
  - **a (consigliata)**: per sempre, come vuole il design («non si modifica
    né si cancella»).
  - **b**: 1 anno, come `security_events`.
- **D-5 — La riconferma sulle rotte con segreti** (tabella della voce 11).
  - **a (consigliata)**: `config.reauth` su TUTTE le rotte che il prototipo
    elenca in `REAUTH_REQUIRED`. Anche il web chiede la riconferma lì: la
    gestisce già dal 23 ott.
  - **b**: solo nell'app.
- **D-6 — Disattivare una persona.**
  - **a (consigliata)**: come il prototipo.
    - Una colonna `users.deactivated_at`.
    - Il login è rifiutato con lo stesso errore di una password sbagliata;
      le sessioni e i PAT si chiudono.
    - Gli inviti che ha mandato si revocano, e le task si possono
      riassegnare.
    - Mai l'ultimo full admin, mai sé stessi; si riattiva.
  - **b**: la rotta di eliminazione che c'è già come servizio.
- **D-7 — La pausa della coda: cosa ferma.**
  - **a (consigliata)**: per progetto, ogni lavoro del worker di quel
    progetto (fix, correzioni, review, refinement, Docs notturni, passo di
    Claude delle automazioni). Il lavoro già partito finisce; «Chiedi a
    Claude» e la chat no (maintainer, 30 ott).
  - **b**: solo i run delle task.
- **D-8 — L'archivio e chi elimina.**
  - **a (consigliata)**: come il prototipo.
    - `projects.archived_at`; l'archiviato sparisce ovunque.
    - Lo vedono in sola lettura gli ex membri e i full admin.
    - Si elimina SOLO un archiviato, SOLO un full admin, con la riconferma,
      e i repository restano staccati.
    - Il web perde «elimina» per chi ha `project.settings.manage`.
  - **b**: l'archivio sì, ma l'eliminazione resta com'è oggi.
- **D-9 — Le sessioni del browser.**
  - **a (consigliata)**: l'elenco delle mie sessioni (browser e desktop) col
    «Sign out» di una, mai quella corrente.
  - **b**: no, restano il cambio password e la revoca dei PAT.
- **D-10 — Il webhook in uscita.**
  - **a (consigliata)**: uno solo, come oggi, più gli 8 eventi degli avvisi
    e l'anteprima per formato.
  - **b**: più webhook.
- **D-11 — «Chi può farlo?».**
  - **a (consigliata)**: una rotta del server, che calcola con le stesse
    funzioni di `can()` e filtra i progetti visibili.
  - **b**: calcolato nel client da persone e ruoli, ma divergerebbe.
- **D-12 — La cassaforte dal desktop.**
  - **a (consigliata)**: fuori dall'area 9. Il desktop dice «nel browser», e
    la strada (la passkey consegnata all'app, o un secondo sblocco) si
    decide in un design a sé.
  - **b**: dentro l'area 9, con la passkey nel browser consegnata all'app.
- **D-13 — Il profilo.**
  - **a (consigliata)**: nome e lingua ora. La foto e il cambio dell'email
    di login dopo: l'email è l'identità, e cambiarla chiede una verifica.
  - **b**: anche foto ed email.
- **D-14 — Le azioni di Claude dell'area 9.**
  - **a (consigliata)**: una fetta a sé (F7), dopo le azioni vere: la classe
    C (le sei del prototipo) con la riconferma di chi conferma, e le B.
  - **b**: all'area 10.
- **D-15 — Le pagine d'ingresso nella web «app».**
  - **a (consigliata)**: restano quelle del web vecchio (invito, reset,
    primo avvio), e l'app non le integra.
  - **b**: la web «app» usa quelle del prototipo.
