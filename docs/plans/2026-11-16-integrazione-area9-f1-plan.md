# Integrazione area 9, F1 — accessi: piano

*16 nov 2026, 72. Design: `docs/plans/2026-11-16-integrazione-area9-design.md`
(§ F1, «Le invarianti, riscritte», le [DECIDE] E-1 ed E-4). Branch
`feat/area9-f1` da `feat/area8-site-api` (o dall'unione dell'area 8, quando
c'è). Lato server: 72. Renderer: 94, in due consegne (F1a Preferenze e
ingresso, F1b People, Roles, Members e «Chi può farlo?») sullo stesso
backend.*

## Prima del codice

- **Le invarianti** del design («Nessuna escalation sul DARE; nessuna
  gerarchia fra persone», «I permessi effettivi in un progetto sono UNA
  funzione», «Una persona disattivata non entra da nessuna porta»,
  `identity.md`) le applica 46 all'approvazione del design. F1 parte dopo.
- **E-1** (il trasporto del link del cambio d'email) decide il task 8, ed
  **E-4** (il login della web «app») il lato renderer di 1.9. Gli altri task
  non dipendono da loro.

## Regole di lavoro (le solite)

- **TDD**: il test prima, visto ROSSO; le mutazioni via python, verificando
  che si applichino e che diano codice che gira; davanti a una mutazione
  verde si guarda PERCHÉ è verde.
- **I test**: i file di test toccati si lanciano INTERI, uno alla volta. Dopo
  un cambio fra package si ribuildano le dipendenze (`pnpm --filter
  "@stubwise/<pkg>^..." build`). Prima del commit, il test del registro delle
  rotte (`route-access.test.ts`, `instance-routes-access.test.ts`) e
  `load-isolated` quando cambia `shared`.
- **I commit**: percorsi espliciti, `-F msgfile`; lint + test + commit + push
  in UNA catena `&&`, con l'output su file letto DOPO.
- **I container**: si annotano gli id prima di ogni giro, alla fine si
  tolgono per id quelli nuovi rimasti, mai per etichetta globale.
- **I client**: ogni campo nuovo di una risposta è additivo, con un default e
  un test di parse senza il campo; il web fa un cast, quindi difesa nel punto
  di lettura.
- Nessun golden: in F1 non c'è un modello nel percorso.

## Task

### Task 1 — La migrazione (primo numero libero: oggi 0185)

- **`project_member_permissions`**:
  - colonne (`project_id`, `user_id`, `permission`, `granted_by_user_id`
    `ON DELETE SET NULL`, `granted_at`);
  - PK (`project_id`, `user_id`, `permission`);
  - FK composta verso `project_members` (`project_id`, `user_id`) `ON DELETE
    CASCADE`;
  - CHECK su `permission` uguale a `PROJECT_PERMISSIONS`.
- **`users`**: `deactivated_at`, `deactivated_by_user_id` `ON DELETE SET
  NULL`.
- **`sessions`**: `user_agent` (text), `last_seen_at` (timestamptz).
- **`user_avatars`**: `user_id` PK `ON DELETE CASCADE`, `content_type` con
  CHECK in (`image/png`, `image/jpeg`, `image/webp`), `bytes` bytea con CHECK
  `octet_length(bytes) <= 524288`, `updated_at`.
- **`email_changes`**:
  - colonne (`id`, `user_id` `ON DELETE CASCADE`, `new_email`, `token_hash`
    unique, `created_at`, `expires_at`, `confirmed_at`, `cancelled_at`);
  - un indice unico parziale su `user_id` dove `confirmed_at is null and
    cancelled_at is null`: al più una pendente.
- **Test** (`migration-0185.test.ts`):
  - i default;
  - il cascade dei permessi personali quando si toglie il membro;
  - i CHECK: un permesso d'istanza, un tipo di foto, 512 KB + 1;
  - due cambi d'email pendenti rifiutati.
- **Commit**: `feat(db): permessi personali, disattivazione, sessioni, foto,
  cambio d'email (0185, area 9, F1)`.

### Task 2 — Via il bersaglio protetto (design 1.1)

- **Servizio** (`apps/server/src/services/roles.ts`): via
  `assertTargetNotAbove`, `assertTargetProjectsNotAbove` e il confronto in
  `assertCanActOnUser`, con i chiamanti a :283 e :464 e i loro equivalenti
  nei progetti. Restano `assertNoEscalation`, `self` e
  `last_full_admin`. La modifica di un ruolo (R30) controlla solo ciò che
  AGGIUNGE.
- **I test esistenti che pretendono `target_above` (14, in
  `routes/users.test.ts`, `routes/roles.test.ts`, `services/roles.test.ts`)
  si ROVESCIANO**: ognuno diventa la prova che ora l'azione passa. Si
  aggiungono:
  - chi ha `users.manage` azzera il secondo fattore di un full admin (con
    la riconferma), e il `security.alert` arriva;
  - chi ha `project.members.manage` toglie un Project Lead;
  - NEGATIVI: dare un ruolo con permessi che non si hanno (`escalation`),
    sé stessi, l'ultimo full admin.
- **Il web**: `role-errors.ts` e la chiave i18n `target_above` restano
  (sono innocui, perché il codice non arriva più); il renderer di 94 non lo
  conosce.
- **Mutazione**: rimettere il confronto in `assertCanActOnUser` fa tornare
  rossi i test rovesciati.
- **Commit**: `feat(server): via il bersaglio protetto, l'escalation resta
  sul dare (area 9, F1)`.

### Task 3 — I permessi personali sui membri (design 1.2)

- **Il calcolo**: `effectiveProjectPermissions` (shared) e
  `projectPermissionsFor` / `projectPermissionsOfUser` / la mappa di `/me`
  (`apps/server/src/auth/access.ts`, `services/home.ts`) uniscono i personali.
  Una query sola per pagina, non una per progetto.
  Va verificato ogni lettore dei permessi di progetto, perché nessuno ricalcoli
  dal solo ruolo: `grep` su `roleId`/`role_id` dentro `auth/` e `services/`.
- **`PUT /api/projects/:projectId/members/:userId`** accetta anche
  `permissions?: string[]` (l'insieme dopo il salvataggio), nella stessa
  transazione del ruolo:
  - ogni permesso AGGIUNTO passa da `assertNoEscalation` nel progetto;
  - `last_manager` sia per il ruolo sia per i personali.
- **`GET …/members`** porta per membro `permissions: [{ permission, sources }]`
  (additivo, default `[]`); lo schema è in `@stubwise/shared`.
- **Test** (`routes/project-members.permissions.test.ts`):
  - un personale apre la rotta (`servers.operate` su
    `/api/servers/:id/fixes…`, o `release.merge` sulla coda di rilascio);
  - toglierlo la richiude;
  - `/me` lo mostra;
  - la provenienza;
  - NEGATIVI: `escalation`, un permesso d'istanza (422), Claude,
    `last_manager`, il body senza `permissions` che lascia i personali com'erano;
  - un test d'ACCORDO: per ogni (persona, progetto, permesso) del seme,
    `projectPermissionsFor` ⇔ la lista di `GET …/members`.
- **Mutazioni**:
  - togliere i personali da `projectPermissionsFor`: rosso;
  - togliere `assertNoEscalation` sui personali: rosso;
  - togliere il cascade: rosso, nel test di migrazione.
- **Commit**: `feat: i permessi personali dei membri, con la provenienza
  (area 9, F1)`.

### Task 4 — Disattivare e riattivare (design 1.3)

- **Rotte**: `POST /api/users/:id/deactivate` (`{ reassign?: { [taskId]:
  userId | null } }`, la riassegnazione PER TASK) e `/reactivate`,
  `inst:users.manage` + `reauth`, nel registro.
- **La transazione**:
  - cancella sessioni, PAT e `device_tokens`;
  - revoca gli inviti pendenti mandati da lei (`invites.invited_by_user_id`);
  - riassegna ogni task aperta come dice la sua riga di `reassign`. Il
    destinatario deve vedere il progetto di QUELLA task; una riga non valida
    dà `422 invalid_reassignment` con l'id della task, e non cambia niente;
  - scrive `security_events.kind = "deactivated"`, e alla riattivazione
    `"reactivated"`.
- **La lettura dell'identità**: login, sessione e PAT rifiutano una persona
  con `deactivated_at`. Il login con lo STESSO errore di una password
  sbagliata, gli altri come una sessione assente (401). In UN posto:
  `auth/session.ts` per la sessione, e la verifica dei PAT.
- **Letture**: `status` in `GET /api/users` e `/api/people`;
  `assignee.deactivated` (additivo) dove una task mostra l'assegnatario.
- **Test** (`routes/users.deactivate.test.ts`):
  - dopo: login rifiutato come una password sbagliata (stesso codice e
    corpo), la sessione vecchia 401, il PAT 401, i `device_tokens` spenti;
  - le task riassegnate per riga (due task di progetti diversi a due persone
    diverse; una senza riga resta sua); gli inviti revocati;
  - riattivare non riporta né i token né le sessioni;
  - NEGATIVI: sé stessi, l'ultimo full admin, Claude, un destinatario che
    non vede il progetto della sua task (422, NIENTE cambiato), una task non
    sua, senza riconferma, senza `users.manage`.
- **Mutazione**: togliere il controllo a lettura e lasciare la
  cancellazione. Il test della «corsa» (una sessione re-inserita dopo la
  disattivazione) diventa rosso.
- **Commit**: `feat(server): disattivare e riattivare una persona (area 9,
  F1)`.

### Task 5 — Le sessioni (design 1.4)

- **`last_seen_at` e `user_agent`**: si aggiornano dove la sessione si
  legge, al più ogni 5 minuti (una `update … where last_seen_at < now() -
  interval '5 minutes'`), mai una scrittura per richiesta.
- **`GET /api/me/sessions`** e **`DELETE /api/me/sessions/:id`** (`user`, nel
  registro). Gli id sono opachi: per il browser un HMAC dell'id di sessione
  con la chiave d'istanza; per desktop e mobile l'id del PAT con un prefisso.
- **Test** (`routes/me-sessions.test.ts`):
  - l'elenco (browser corrente, browser altro, desktop, mobile; mai una
    parziale);
  - chiudere l'altra; revocare il desktop con i suoi `device_tokens`;
  - `last_seen_at` non si riscrive entro 5 minuti;
  - NEGATIVI: la corrente (409 `current_session`), una di un altro (404),
    un id inventato (404), un id di sessione VERO al posto dell'opaco (404).
- **Commit**: `feat(server): le mie sessioni, con «Sign out» di una (area 9,
  F1)`.

### Task 6 — Tentativi rimasti e scadenza della finestra (design 1.5)

- **`attemptsLeft`** in `GET /api/auth/second-factor` e nel corpo di `401
  invalid_second_factor` (lo schema in `packages/shared/src/schemas/second-factor.ts`,
  additivo), calcolato da `users.second_factor_failures` in
  `attemptSecondFactor`: in UN posto, l'helper unico delle verifiche
  (invariante «Ogni verifica passa da attemptSecondFactor»).
- **`reauthUntil`** in `GET /api/me/security`: dalla sessione, o dal PAT
  desktop.
- **Test**:
  - 5 → 4 → … → bloccato (423 con `lockedUntil`), poi un codice giusto
    riporta a 5;
  - `reauthUntil` null, poi la riconferma, poi l'ora giusta;
  - il parse senza i campi.
- **Commit**: `feat(server): i tentativi rimasti e la scadenza della
  riconferma (area 9, F1)`.

### Task 7 — La foto (design 1.6)

- **Rotte**: `PUT /api/me/avatar` (corpo binario, `bodyLimit` 512 KB, il tipo
  dai magic bytes), `DELETE /api/me/avatar`, `GET /api/users/:id/avatar`
  (visibilità di `/api/people`) con gli header del design.
- **`avatarUrl`** (additivo) in `/api/auth/me`, `/api/people`, `/api/users`.
- **Test** (`routes/me-avatar.test.ts`):
  - PNG, JPEG e WebP veri (fixture di pochi byte);
  - gli header della risposta (`nosniff`, la CSP, il tipo dedotto);
  - `avatarUrl` cambia `v` dopo il caricamento;
  - NEGATIVI:
    - un SVG, anche dichiarato `image/png`;
    - un HTML con l'estensione giusta;
    - un GIF;
    - 512 KB + 1;
    - la foto di una persona invisibile (404);
    - senza sessione.
- **Mutazione**: dedurre il tipo dal `Content-Type` invece che dai byte fa
  entrare l'SVG: rosso.
- **Commit**: `feat(server): la foto del profilo (area 9, F1)`.

### Task 8 — Il cambio dell'email di login (design 1.6; dipende da E-1)

- **Se E-1 = a** (SMTP facoltativo):
  - il modulo `apps/server/src/mail/transport.ts`, con `SMTP_URL` e
    `MAIL_FROM` dalla config, nodemailer o il client SMTP più piccolo che
    regge TLS; da decidere al task, senza una dipendenza in più se basta il
    `net` di node;
  - fuori dai test, un'assenza di configurazione dà `isConfigured() ===
    false`;
  - nei test, un trasporto finto iniettato (nessuna rete: la guardia di rete
    dei test del server).
- **Rotte**: `POST /api/me/email-change` (`reauth`), `DELETE
  /api/me/email-change`, `POST /api/auth/email-change/confirm` (`public`,
  `credentialDoor`, il rate limit del login).
  - Senza trasporto: `409 email_transport_unavailable`.
  - Il cambio fatto da un admin, `PATCH /api/users/:id/email` (`{ email }`,
    `inst:users.manage` + `reauth`), c'è SEMPRE:
    - mai su sé stessi;
    - `email_taken` come la richiesta personale;
    - cambia subito; sessioni e 2FA intatti; annulla una richiesta
      personale pendente;
    - `email_changed` in `security_events` con chi ha agito, e il
      `security.alert` che lo nomina.
- **Le regole del design**: 24 ore, monouso, hash, la vecchia fino al clic,
  sessioni e secondo fattore intatti, `email_changed` in `security_events`,
  `security.alert`, un'email presa (anche da un invito) con lo stesso errore.
- **Test** (`routes/me-email-change.test.ts`):
  - il trasporto finto riceve il link alla nuova e l'avviso alla vecchia;
  - il cambio solo al clic; il login con la nuova;
  - sessioni e secondo fattore intatti;
  - NEGATIVI: scaduto, annullato, già usato, la seconda richiesta che
    sostituisce la prima, un'email presa, senza riconferma, senza trasporto
    (409), il token sbagliato (lo stesso 400 degli altri casi);
  - il ramo admin: cambia subito, annulla la pendente, l'avviso nomina
    l'admin; NEGATIVI: su sé stessi, senza `users.manage`, senza riconferma,
    un'email presa.
- **Commit**: `feat(server): il cambio dell'email di login con la verifica
  (area 9, F1)`.

### Task 9 — «Chi può farlo?» (design 1.7)

- **Rotte**: `GET /api/access/who-can` (`projectId` facoltativo: assente =
  un permesso d'istanza; uno di progetto senza, o uno d'istanza con, `422`) e
  `GET /api/access/what-can` (`user`),
  sopra le funzioni di `access.ts`. Lo schema della risposta è in shared, coi
  motivi `full_admin | role | grant` (`department` con F8, già nell'enum
  tramite `readerSchema`).
- **Test** (`routes/access-who-can.test.ts`):
  - il test d'ACCORDO su un seme con ruoli, personali e full admin: per ogni
    coppia, `who-can` ⇔ `can()`;
  - i motivi;
  - Claude con la sua riga solo per i permessi del suo insieme;
  - i permessi d'istanza senza `projectId` (chi ha `users.manage`);
  - NEGATIVI: un progetto invisibile (404, e assente da `what-can`), una
    persona invisibile, una disattivata (assente), il 422 di un ambito
    sbagliato.
- **Mutazione**: dimenticare i personali in `who-can` fa rompere
  l'accordo.
- **Commit**: `feat(server): «Chi può farlo?» (area 9, F1)`.

### Task 10 — Inbox: «Restore», «Move to New», «non letta» (design 1.8)

- Tre rotte in `apps/server/src/routes/inbox.ts`; il conteggio dei non
  letti segue.
- **Test**: i tre passaggi; NEGATIVI: la card di un altro (404), uno stato
  sbagliato (409 `invalid_state`).
- **Commit**: `feat(server): Inbox, ripristinare, rimettere fra le nuove,
  segnare non letta (area 9, F1)`.

### Task 10b — Il token nelle risposte che danno un link (design 1.9)

- `POST /api/users/:id/password-reset` aggiunge `token` (additivo) accanto a
  `url`; l'invito lo dà già. Così il renderer della web «app» costruisce
  `${origin}/app/#/reset-password/<token>` e `…/register/<token>`.
- **Test**: il `token` è quello che `url` contiene, e funziona sulla rotta di
  reset; il parse senza il campo.
- **Commit**: insieme al Task 10.

### Task 11 — Il client

- `packages/api-client`:
  - `me.sessions` / `endSession`, `me.avatar` (put, delete),
    `me.emailChange` (start, cancel), `auth.confirmEmailChange`;
  - `users.deactivate` / `reactivate`;
  - `projects.members` con `permissions`;
  - `access.whoCan` / `whatCan`;
  - `inbox.restore` / `moveToNew` / `unread`.
- Un test di parse per ogni risposta nuova senza i campi facoltativi;
  `UNKNOWN` per un `kind` o un motivo ignoti.
- **Commit**: `feat(api-client): gli accessi dell'area 9 (F1)`.

### Task 12 — Deploy-log e review

- **La voce di deploy-log**:
  - l'ordine: prima il server (0185), poi caddy (il renderer);
  - la nota che `target_above` non esiste più, e che un client vecchio non
    se ne accorge;
  - se E-1 = a, le env SMTP facoltative;
  - il rollback (0185 additiva; un server vecchio ignora i personali, e
    quindi chi li aveva li PERDE finché non si torna avanti).
- **`pnpm build`** completo + `check:dist`.
- **La review finale** con un revisore a contesto fresco, avversariale. Il
  Review Focus:
  - un'escalation per una strada laterale (personali, invito, ruolo
    modificato);
  - una persona disattivata che rientra da una porta qualunque;
  - un id di sessione vero che esce;
  - un SVG che passa;
  - il link dell'email riusabile;
  - `who-can` che diverge da `can()`.

## Cosa F1 non fa

- Il registro delle modifiche: F2. Gli scrittori dei percorsi di F1 li
  aggiunge F2.
- I permessi dei reparti: F8.
- La cassaforte dal desktop: design a sé.
- La riconferma sulle rotte con segreti: F3.

## Stima

Server: 4–5 giorni coi test (il Task 8 è il più incerto, per E-1). Renderer
(94): F1a e F1b, in parallelo dal Task 3 in poi.
