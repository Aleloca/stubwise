# Integrazione area 9 — Amministrazione, accessi e impostazioni: design

*16 nov 2026, 72. Dall'inventario
(`docs/plans/2026-11-16-integrazione-area9-inventario.md`) e dalle risposte
del maintainer (via 46, 16 nov). La specifica resta il prototipo col suo
design (`docs/plans/2026-10-29-desktop-area9-admin-design.md`). Dove una
risposta «b» lo cambia, il prototipo va cambiato PRIMA di integrarlo (94):
lo dice ogni sezione. Le invarianti da riscrivere sono in fondo, scritte
per esteso: le applica 46 quando approva questo design.*

## Le decisioni *(M, 16 nov 2026)*

| | Decisione |
|---|---|
| D-1 = a | I permessi di progetto dati da un reparto, in una fetta a sé, calcolati in UN posto. |
| D-2 = a | Via il bersaglio protetto (`target_above`). Il rischio accettato (azzeramento del secondo fattore e link di reset su un full admin) è scritto nell'invariante, con la traccia nel registro e `security.alert`. |
| D-3 = a | Un registro delle modifiche in una tabella tipizzata, scritta nella stessa transazione, con la frase da un template e la lettura filtrata, dal deploy in poi. |
| D-4 = a | Il registro si tiene PER SEMPRE. |
| D-5 = a | La riconferma su TUTTE le rotte di `REAUTH_REQUIRED`, anche dal web. |
| D-6 = a | Disattivare come nel prototipo. |
| D-7 = a | La pausa ferma ogni lavoro del worker del progetto, tranne la chat e «Chiedi a Claude». |
| D-8 = a | L'archivio come nel prototipo. Eliminare solo un archiviato, solo un full admin, con la riconferma; il web perde «elimina». |
| D-9 = a | Le mie sessioni (browser e desktop), col «Sign out» di una, mai di quella corrente. |
| D-10 = **b** | **Più webhook in uscita**, ciascuno con URL, formato, eventi scelti e segreto suoi, gestiti da chi gestisce le integrazioni dell'istanza; l'anteprima per formato. Si migra quello di oggi, e un webhook non riceve mai gli eventi di un altro. |
| D-11 = a | «Chi può farlo?» su una rotta del server. |
| D-12 = a | La cassaforte dal desktop FUORI dall'area 9: un design a sé, con le due strade nel registro. |
| D-13 = **b** | **Il profilo tutto ora**: nome, lingua, FOTO e il cambio dell'EMAIL di login con la verifica del nuovo indirizzo. Le regole stanno in un'invariante. |
| D-14 = a | Le azioni di Claude dell'area 9 in F7. |
| D-15 = **b** | **La web «app» usa le pagine d'ingresso del PROTOTIPO** (invito, reset, primo avvio), col secondo fattore e le invarianti di oggi. Il web vecchio resta finché non si ritira. |

## Le fette

- **F1 — accessi**:
  - via il bersaglio protetto;
  - i permessi personali sui membri;
  - disattivare e riattivare;
  - le sessioni;
  - i tentativi rimasti e la scadenza della finestra;
  - «Chi può farlo?»;
  - l'Inbox;
  - il profilo completo (foto ed email);
  - le pagine d'ingresso nella web «app».
  - Il renderer la consegna in due tempi (94): F1a le Preferenze e
    l'ingresso, F1b People, Roles, Members e «Chi può farlo?».
- **F2 — il registro delle modifiche**:
  - la tabella e il meccanismo;
  - gli scrittori di 9a, compresi quelli dei percorsi di F1 che nascono
    senza;
  - la lettura e le pagine.
- **F3 — istanza**:
  - la riconferma sulle rotte con segreti;
  - AI, account git, plugin, Google, storage, i tetti dell'analisi dei
    server;
  - i webhook in uscita (D-10 = b);
  - i repository d'istanza.
- **F4 — Stato dell'istanza**: la coda, i worker, gli errori; la pausa per
  progetto; il rilancio; il passo bloccato dal budget che riparte.
- **F5 — impostazioni del progetto**: i repository e i file d'ambiente con
  la riconferma; la rigenerazione della chiave d'ingestione e del segreto
  del webhook git; i plugin con la precondizione di versione.
- **F6 — archivio ed eliminazione**.
- **F7 — azioni di Claude dell'area 9**.
- **F8 — i permessi di progetto dei reparti** (D-1).

Ogni fetta dopo F2 scrive le sue voci nel registro.

---

## F1 — accessi

### 1.1 Via il bersaglio protetto (D-2)

- Si tolgono `assertTargetNotAbove`, `assertTargetProjectsNotAbove` e il
  confronto di `assertCanActOnUser` (`apps/server/src/services/roles.ts`),
  e con loro il codice `target_above`.
- Resta `assertNoEscalation` sul DARE: un ruolo, un permesso in più, un
  invito.
- Restano il rifiuto su sé stessi (ruolo d'istanza, reset, disattivazione)
  e «resta sempre un full admin».
- **Modificare un ruolo** non chiede più che i suoi permessi attuali stiano
  nei propri (R30 cade insieme a R28). Aggiungere permessi a un ruolo resta
  `escalation`: si dà.
- **I client**: il codice `target_above` non arriverà più. È un rifiuto in
  meno, quindi i client vecchi non si rompono.
- *Test*:
  - chi ha `users.manage` cambia il ruolo d'istanza, manda il link di
    reset e azzera il secondo fattore di chi ha più permessi, anche di un
    full admin;
  - chi ha `project.members.manage` toglie un `Project Lead` (prima:
    `target_above`);
  - NEGATIVI: dare un ruolo con permessi che non si hanno resta
    `escalation`; su sé stessi resta rifiutato; l'ultimo full admin resta
    protetto.

### 1.2 I permessi personali sui membri

- **Tabella** `project_member_permissions`: (`project_id`, `user_id`,
  `permission`, `granted_by_user_id` null alla cancellazione, `granted_at`).
  - La chiave è (`project_id`, `user_id`, `permission`).
  - La FK verso `project_members` va `ON DELETE CASCADE`: togliere un
    membro toglie i suoi permessi.
  - C'è un CHECK su `permission`, la lista dei permessi di progetto, come
    gli altri CHECK di enum testuali.
- **Il calcolo**: i permessi effettivi di un membro sono quelli del ruolo
  più i suoi personali (più, con F8, quelli dei reparti). In UN posto:
  `effectiveProjectPermissions` (`packages/shared/src/permissions.ts`) e
  `projectPermissionsFor` / `projectPermissionsOfUser`
  (`apps/server/src/auth/access.ts`).
  - Il full admin resta implicito.
  - Claude non ne riceve mai: i suoi permessi sono un insieme fisso (R-L9).
  - Ogni lettura dei permessi ne tiene conto: `/api/auth/me`, la WHERE degli
    elenchi, i gate delle rotte. Un permesso personale vale esattamente come
    uno del ruolo, e la revoca si applica a lettura.
- **La rotta**: `PUT /api/projects/:projectId/members/:userId` accetta anche
  `permissions?: string[]`, l'insieme COMPLETO dei permessi personali dopo
  il salvataggio (additivo: assente = invariati). Ruolo e permessi si
  salvano nella stessa transazione, con la riconferma che c'è già.
  - Ogni permesso AGGIUNTO deve stare in quelli di chi agisce nel progetto:
    `escalation`, con `permission`.
  - Togliere non chiede niente (via il bersaglio protetto).
  - `servers.operate` e `servers.ssh.manage` passano di qui
    (`PRESETLESS_PROJECT_PERMISSIONS`).
- **La lettura**: `GET /api/projects/:projectId/members` dà per ogni membro
  (campi additivi) `permissions`, cioè l'elenco effettivo con la PROVENIENZA
  di ciascuno:
  - `{ permission, sources: [{ kind: "role", roleId }
    | { kind: "grant", byUserId, at } | { kind: "department",
    departmentId } ] }`;
  - `department` arriva con F8.
- **L'ultimo gestore**: un progetto non resta senza nessuno con
  `project.members.manage` (fuori dai full admin), né togliendo il ruolo né
  togliendo il permesso personale: `last_manager`.
- *Test*:
  - un permesso personale apre la sua rotta e compare in `/me`;
  - toglierlo la richiude subito;
  - `escalation` sul dare;
  - la provenienza giusta;
  - NEGATIVI: un permesso d'istanza nella lista → 422; Claude non ne riceve;
    l'ultimo gestore.

### 1.3 Disattivare e riattivare una persona (D-6)

- **Colonne**: `users.deactivated_at`, `users.deactivated_by_user_id`.
- **Rotte**, `inst:users.manage` con la riconferma:
  - `POST /api/users/:id/deactivate`, corpo `{ reassign?: { [taskId]: userId
    | null } }`: la riassegnazione PER TASK, come il dialogo del prototipo
    (94, review del 16 nov);
  - `POST /api/users/:id/reactivate`.
- **Disattivare**, in UNA transazione:
  - si cancellano sessioni, PAT (di ogni `kind`) e `device_tokens`;
  - si revocano gli inviti che la persona ha mandato e che sono ancora
    pendenti;
  - ogni task aperta assegnata a lei va a chi indica `reassign` per QUELLA
    task, che deve essere membro (o full admin) del progetto della task.
    `null`, o una task assente dalla mappa, = resta sua. Una riga non valida
    (task non sua o non aperta, destinatario che non vede il progetto) fa
    fallire tutto con `422 invalid_reassignment`, con l'id della task: niente
    a metà;
  - una riga in `security_events` (`deactivated`);
  - nessun `security.alert`: la persona non entra più a leggerlo.
- **I rifiuti**: su sé stessi `self`; sull'ultimo full admin `last_full_admin`;
  su Claude (`is_agent`) `not_found`.
- **Dopo**: il login risponde con lo STESSO errore di una password sbagliata,
  e ogni lettura dell'identità (sessione o PAT) la tratta come assente. Le
  sessioni e i PAT sono già cancellati, ma il controllo a lettura copre una
  corsa.
- **Riattivare** riporta la persona com'era (ruoli, progetti, reparti), senza
  le sessioni e i token di prima: rientra col suo login.
- **Le letture**: `GET /api/users` e `/api/people` danno `status: active |
  deactivated` (additivo, default `active`). Le task tenute mostrano la
  persona come disattivata (`assignee.deactivated`, additivo).
- *Test*:
  - dopo la disattivazione il login, la sessione, un PAT e il push
    falliscono;
  - ogni task passa a chi è indicato per lei, e le altre restano sue;
  - gli inviti sono revocati;
  - riattivare non riporta i token di prima;
  - NEGATIVI: sé stessi, l'ultimo full admin, Claude, un destinatario che
    non vede il progetto della SUA task (`422`, niente cambiato).

### 1.4 Le sessioni (D-9)

- **Colonne** (additive) su `sessions`:
  - `user_agent` (troncato a 300 caratteri);
  - `last_seen_at`, aggiornato al più ogni 5 minuti, perché non sia una
    scrittura per richiesta.
- **`GET /api/me/sessions`** (`user`): le mie sessioni `full` del browser,
  più i PAT `desktop` e `mobile`. Per ognuna: `{ id, kind:
  "browser" | "desktop" | "mobile", userAgent, createdAt, lastSeenAt,
  current }`. Mai un id di sessione vero: un id opaco, l'hash. Le sessioni
  parziali non compaiono.
- **`DELETE /api/me/sessions/:id`** (`user`, senza riconferma, come la
  revoca di un PAT):
  - chiude una sessione del browser, o revoca il PAT desktop o mobile, con i
    suoi `device_tokens`;
  - quella corrente: `409 current_session` (per uscire c'è il logout);
  - una sessione di un altro: `404`.
- *Test*: l'elenco; chiudere un'altra sessione la chiude davvero; NEGATIVI:
  la corrente, una di un altro, una parziale.

### 1.5 I tentativi rimasti e la scadenza della finestra

- **`GET /api/auth/second-factor`** (sessione parziale) e il `401
  invalid_second_factor` portano `attemptsLeft` (additivo: `5 −
  second_factor_failures`), accanto al `lockedUntil` di oggi. Sono i
  tentativi DELL'ACCOUNT di chi ha già dato la password, quindi non dicono
  niente a un estraneo.
- **`GET /api/me/security`** porta `reauthUntil` (additivo): la fine della
  finestra della riconferma di QUESTA sessione (o del PAT desktop), oppure
  null.
- *Test*: `attemptsLeft` scende a ogni errore e torna a 5 dopo un codice
  giusto; `reauthUntil` dopo una riconferma.

### 1.6 Il profilo completo (D-13 = b)

#### La foto

- **Tabella** `user_avatars`: (`user_id` PK, `content_type`, `bytes`
  bytea, `updated_at`), nel DB e non su S3, perché S3 può essere spento.
- **Rotte**:
  - `PUT /api/me/avatar` (`user`), corpo binario;
  - `DELETE /api/me/avatar`;
  - `GET /api/users/:id/avatar` (`user`, la stessa visibilità di
    `/api/people`; `404` per una persona invisibile).
- **Le regole**:
  - al più **512 KB**;
  - il tipo si DEDUCE dai magic bytes, PNG, JPEG o WebP soli, e il
    `Content-Type` dichiarato non conta. **Mai SVG**, mai GIF.
  - si serve col tipo dedotto e con `X-Content-Type-Options: nosniff`,
    `Content-Security-Policy: default-src 'none'; sandbox`,
    `Content-Disposition: inline`, `Cache-Control: private, max-age=300`.
- **`avatarUrl`** (additivo) in `/api/auth/me`, `/api/people` e
  `/api/users`: il percorso con `?v=<updated_at>`, oppure null.
- *Test*:
  - un PNG, un JPEG e un WebP entrano;
  - NEGATIVI: un SVG (anche dichiarato `image/png`), un HTML, un GIF, oltre
    512 KB, la foto di una persona invisibile;
  - gli header della risposta.

#### Il cambio dell'email di login

- **Tabella** `email_changes`: (`id`, `user_id`, `new_email`, `token_hash`,
  `created_at`, `expires_at`, `confirmed_at`, `cancelled_at`). Al più UNA
  pendente per persona.
- **Rotte**:
  - `POST /api/me/email-change` (`user`, **con la riconferma**: è
    l'identità), corpo `{ newEmail }`;
  - `DELETE /api/me/email-change` (annulla);
  - `POST /api/auth/email-change/confirm` (`public`, `credentialDoor`, il
    rate limit del login), corpo `{ token }`.
- **Le regole**:
  - il nuovo indirizzo è normalizzato, e non è già di un'altra persona né
    di un invito pendente (`email_taken`, lo stesso errore in ogni caso);
  - il link vale **24 ore**;
  - fino al clic la vecchia email resta quella del login;
  - al clic, nella stessa transazione: l'email cambia, la richiesta è
    `confirmed`, una riga in `security_events` (`email_changed`, con la
    vecchia e la nuova), un `security.alert` all'interessato;
  - **le sessioni, i token e il secondo fattore restano intatti**;
  - il token è monouso, ed è salvato come hash, mai in chiaro;
  - il link è legato alla persona: confermarlo da una sessione di un altro,
    o senza sessione, va bene, perché la prova è aver ricevuto il link;
  - le caselle Google collegate, le identità git e Slack NON cambiano:
    l'email di login non è un'identità esterna.
- **La consegna del link e l'avviso alla vecchia email**: Stubwise oggi non
  manda email (CLAUDE.md, `second-factor.md`: «Niente email: Stubwise non
  ne manda»), quindi serve un trasporto. **E-1** (in fondo).
- **Il cambio fatto da un admin**: `PATCH /api/users/:id/email`, corpo
  `{ email }`, `inst:users.manage` con la riconferma. Esiste sempre, con o
  senza trasporto: senza, è l'unica strada; con, resta per chi ha perso
  l'accesso alla vecchia.
  - Mai su sé stessi (`self`: la propria passa dalla verifica).
  - Stesse regole di normalizzazione e di `email_taken` della richiesta
    personale.
  - Cambia SUBITO, senza verifica: è un atto amministrativo.
  - Sessioni, token e secondo fattore intatti; annulla un'eventuale
    richiesta personale pendente.
  - `security_events` (`email_changed`, con chi ha agito), `security.alert`
    all'interessato (nominando l'admin), e con il trasporto un avviso alla
    vecchia email. Con F2, la voce `person.email_changed`.
  - Non c'è il bersaglio protetto (D-2): è il rischio accettato
    dell'invariante, come il reset.
- **Il prototipo cambia** (94): uno stato «in attesa di conferma su
  <nuova>», con la vecchia ancora valida per il login; «Annulla»; il link
  simulato nel riquadro «Prototype only»; la riconferma prima di chiedere.
- *Test*:
  - il cambio avviene solo dopo il clic;
  - dopo, il login vale con la nuova e non con la vecchia;
  - sessioni e secondo fattore intatti;
  - l'avviso e la riga nel registro di sicurezza;
  - NEGATIVI: un'email presa (anche da un invito); un link scaduto,
    annullato o già usato; due richieste (la seconda sostituisce la prima);
    senza riconferma → `reauth_required`.

### 1.7 «Chi può farlo?» (D-11)

- **`GET /api/access/who-can?permission=<p>&projectId=<id>?`** (`user`): le
  persone che hanno quel permesso, ciascuna coi motivi.
  - `projectId` è FACOLTATIVO (94, review del 16 nov). Assente, vale per un
    permesso D'ISTANZA (`users.manage`, `settings.manage`…). Un permesso di
    progetto senza `projectId`, o uno d'istanza con, dà `422`.
  - Con `projectId`, il progetto deve essere visibile a chi guarda (`404`
    altrimenti).
  - La mappa azione → permesso (il prototipo parte da un'azione) è del
    client: catalogo e testo, non calcolo.
  - I motivi: `full_admin`, `role` (con l'id), `grant` (personale), e con
    F8 `department`.
  - Le persone disattivate no.
  - Claude ha la sua riga fissa (`agent: true`) solo se il permesso è nel
    suo insieme.
- **`GET /api/access/what-can?userId=<id>&projectId=<id>?`** (`user`; la
  persona deve essere visibile come in `/api/people`): i permessi d'istanza
  e, per ogni progetto che CHI GUARDA vede, quelli della persona, coi
  motivi.
- **Lo stesso calcolo di `can()`**: le funzioni di `access.ts`, mai una
  copia. Un test d'accordo, su ogni coppia (persona, permesso) di un seme,
  prova che `who-can` ⇔ `can()`.
- *Test*: l'accordo; NEGATIVI: un progetto invisibile (`404`, e non compare
  in `what-can`), una persona invisibile, una disattivata.

### 1.8 Inbox: «Restore», «Move to New», «non letta»

Tre rotte (`user`, solo le card di chi chiama):
- `POST /api/inbox/:id/restore`: da `handled` torna a `open`;
- `POST /api/inbox/:id/move-to-new`: da `snoozed` torna a `open`, e toglie il
  rinvio;
- `POST /api/inbox/:id/unread`: `read_at = null`.

Il conteggio dei non letti segue. *Test*: i tre passaggi; NEGATIVI: la card
di un altro (`404`), uno stato da cui il passaggio non ha senso (`409
invalid_state`).

### 1.9 Le pagine d'ingresso nella web «app» (D-15 = b)

- **Le rotte ci sono già**: login, secondo fattore, iscrizione al volo,
  passkey, `register`, reset, `setup` (`apps/server/src/routes/auth.ts`,
  `docs/invariants/second-factor.md`). Il lavoro è del renderer: collegare
  `pages/entry/` alle rotte vere nella build web «app».
- **Il server**: nessuna rotta nuova. Le risposte che danno un link portano
  anche il TOKEN, così il renderer costruisce `${origin}/app/#/…` (94, review
  del 16 nov):
  - `POST /api/auth/invites` lo dà già (`token`);
  - `POST /api/users/:id/password-reset` aggiunge `token` (additivo) accanto
    a `url`, che resta quello del web vecchio.
  - Da verificare: l'`rpID` e l'`origin` delle passkey valgono per `/app`
    come per il web (stessa origine, `app.publicUrl`).
- **Le invarianti valgono identiche**: ogni porta passa dal secondo fattore,
  una sessione parziale apre solo le rotte `second_factor`, il tetto per
  account.
- **E-4** (in fondo): se anche il LOGIN della web «app» passa da lì, e dove
  vivono le pagine.

### 1.10 Cosa non cambia in F1

- **Il registro delle modifiche** arriva con F2. Le rotte di F1 nascono
  senza scriverlo, e F2 vi aggiunge gli scrittori. Fino ad allora la
  traccia è `security_events` per ciò che già la lascia.
- **I permessi dei reparti**: F8.

---

## F2 — il registro delle modifiche (D-3, D-4)

- **Tabella** `change_log`:
  - (`id`, `at`, `actor_user_id` null alla cancellazione, `actor_email` testo
    fissato al momento, `actor_kind`: `user | agent | system`, `type`,
    `project_id` null per l'istanza, `subject_kind`, `subject_id`, `data`
    jsonb);
  - indici su (`at desc`), (`project_id`, `at desc`), (`actor_user_id`,
    `at desc`), (`type`, `at desc`).
- **Solo in aggiunta**: nessuna rotta modifica o cancella, e nessun job la
  pota (D-4). Un trigger `BEFORE UPDATE OR DELETE` la rifiuta.
- **`type`** è una lista DICHIARATA in `@stubwise/shared`
  (`CHANGE_LOG_TYPES`), uno schema Zod di `data` per tipo e un template i18n
  per tipo. Un tipo nuovo è un'aggiunta in tre posti, e un test di parità li
  tiene allineati. Dai client passa per `readerSchema`: un tipo ignoto arriva
  come `UNKNOWN`.
- **`data`**: prima e dopo, i nomi fissati al momento (il nome del ruolo, del
  progetto), MAI un segreto.
  - Per un segreto si scrive solo «sostituito»: `{ secret:
    "replaced" }`.
  - Un test di sorgente vieta, nei moduli degli scrittori, di passare al
    registro un campo il cui nome contiene `secret`, `token`, `password`,
    `key` (eccetto `keyLast4`).
- **Lo scrittore** è `recordChange(tx, entry)`, sempre col `tx` della
  modifica: la voce nasce o non nasce con lei. Non lancia mai per un errore
  suo, ma è nella transazione, quindi un errore del DB fa fallire la
  modifica, ed è voluto.
- **Le voci di F2** (9a):
  - `person.instance_role_changed`, `person.password_reset_link`,
    `person.second_factor_reset`, `person.deactivated`, `person.reactivated`,
    `person.email_changed`;
  - `invite.created`, `invite.revoked`;
  - `role.created`, `role.updated` (permessi prima/dopo),
    `role.duplicated`, `role.deleted`;
  - `department.created`, `department.updated`, `department.deleted`,
    `department.members_changed`, `department.home_managers_changed`;
  - `member.added`, `member.role_changed`, `member.permissions_changed`,
    `member.removed` (anche dalla conferma di una proposta della posta,
    area 6);
  - le identità git e Bitbucket.
- **La lettura**:
  - `GET /api/change-log?person=&project=&type=&from=&to=&cursor=` (`user`);
  - `GET /api/projects/:projectId/change-log`.
  - Si legge:
    - le voci d'istanza (`project_id` null) con `changelog.view`;
    - le voci di un progetto con `changelog.view` (se il progetto è
      visibile), oppure con `project.settings.manage` o
      `project.members.manage` in quel progetto;
    - nessuna voce che nomini un progetto invisibile, anche se è di un tipo
      d'istanza (R-G5: il filtro è sulla WHERE, prima della paginazione).
- **Permesso nuovo** `changelog.view` (d'istanza), nel preset Admin. Sono
  cambi additivi al catalogo e la migrazione aggiunge il valore al CHECK.
- **La frase**: il client la compone dal template e da `data` (i nomi
  fissati). Il server non manda prosa: `type` e `data`.
- *Test*:
  - ogni scrittore di 9a lascia la sua voce NELLA STESSA transazione (un
    errore dopo la modifica non lascia la voce);
  - il trigger rifiuta UPDATE e DELETE;
  - NEGATIVI della lettura: senza `changelog.view`, un progetto
    invisibile, un tipo d'istanza che nomina un progetto invisibile;
  - il test di sorgente sui segreti.

---

## F3 — istanza

### 3.1 La riconferma sulle rotte con segreti (D-5)

`config.reauth: true` su:
- `/api/ai-providers`: `POST`, `PATCH` quando cambia la chiave, `DELETE`.
  Il `PATCH` che cambia solo l'ordine o lo stato acceso no, come nel
  prototipo.
- `/api/git-accounts`: `POST`, `PATCH` col token, `DELETE`.
- `/api/plugins`: `POST` (registra), `POST /:id/update`. Più il corpo
  `{ trust: true }` obbligatorio («Mi fido», [IN 2]): senza, `422
  trust_required`.
- `/api/settings/google-workspaces`: `POST`, `PATCH` col secret, `DELETE`.
- `PUT /api/settings/instance`: solo quando il corpo porta una chiave S3 o
  un segreto Slack nuovi.

Quando una rotta la chiede solo in una parte del corpo, la riconferma la
verifica l'handler con `applyReauth` (la funzione del registro, mai una
copia), e un test del registro elenca queste rotte «parziali». Il web la
gestisce già dal 23 ott (`reauth_required` apre il dialogo). *Test*: il
registro delle rotte con riconferma, aggiornato; NEGATIVI: ognuna senza
riconferma → `403 reauth_required` e niente scritto.

### 3.2 Più webhook in uscita (D-10 = b)

- **Tabella** `outgoing_webhooks`:
  - (`id`, `name`, `url`, `format`: `slack | discord | json`, `enabled`,
    `events` text[], `secret_encrypted`, `secret_rotated_at`, `created_at`,
    `created_by_user_id`);
  - un CHECK su `events` ⊆ il catalogo `OUTGOING_WEBHOOK_EVENTS` (in
    `@stubwise/shared`), al più 20 webhook per istanza.
- **La migrazione di quello di oggi**: se `notification_settings` ha un URL,
  diventa il primo webhook.
  - Nome «Webhook», stesso formato e stato.
  - `events` = gli eventi i cui `notify_*` erano accesi.
  - Un segreto nuovo, che nessuno ha ancora visto (si mostra solo alla
    rigenerazione).
  - `notification_settings` resta come tabella per il rollback, senza più
    letture.
  - È nella migrazione stessa, quindi idempotente: solo se
    `outgoing_webhooks` è vuota.
- **Il segreto**:
  - lo genera il server (32 byte), si mostra una volta alla creazione e
    alla rigenerazione (con la riconferma), si salva cifrato e non esce da
    nessuna lettura (`secretSet`, `secretRotatedAt`);
  - ogni invio porta `X-Stubwise-Signature: t=<unix>,v1=<hex HMAC-SHA256 di
    "<t>.<body>">`, che il destinatario JSON verifica;
  - Slack e Discord lo ignorano, ma l'header c'è lo stesso;
  - l'URL **non** è un segreto ([IN 4]): si rilegge in chiaro.
- **Rotte**, `inst:integrations.manage`:
  - `GET /api/settings/webhooks`;
  - `POST` (con riconferma: nasce un segreto);
  - `PATCH /:id` (senza riconferma: nome, URL, formato, eventi, acceso);
  - `POST /:id/secret` (rigenera, con riconferma);
  - `DELETE /:id` (con riconferma);
  - `POST /:id/test`;
  - `GET /api/settings/webhooks/preview?format=&event=`: il corpo che
    arriverebbe, da un evento d'esempio.
- **L'invio**: il canale `webhook` di `packages/notifications/src/dispatch.ts`
  passa da «un URL» a «i webhook accesi che hanno scelto QUEL tipo». Uno per
  uno, col suo formato e il suo segreto, e un errore di uno non ferma gli
  altri. **Un webhook non riceve mai un evento che non ha scelto.**
- **Gli eventi**: i 13 del web di oggi, più gli 8 degli avvisi delle aree
  8a/8b che il prototipo elenca ([IN 4], mai le risposte dei clienti). Oggi
  la regola M3 dell'area 8 (F2, `shouldSendWebhook`) li tiene FUORI dal
  webhook: **E-2**.
- **Il prototipo cambia** (94): da un webhook a un elenco (crea, modifica,
  elimina), ognuno con URL, formato, eventi, segreto visto una volta, la sua
  prova e l'anteprima per formato ed evento.
- *Test*:
  - la migrazione (uno acceso con i suoi eventi; nessuno se l'URL era
    vuoto);
  - **due webhook con eventi diversi: ognuno riceve solo i suoi**;
  - la firma verificabile;
  - il segreto mai in una lettura;
  - la riconferma su creazione, rigenerazione ed eliminazione;
  - un webhook che fallisce non ferma gli altri;
  - NEGATIVI: un evento fuori catalogo, oltre 20 webhook.

### 3.3 Il resto di 9b

- **AI** (provider, modelli, automazione, budget e lingua, consumi), **account
  git**, **Google**, **storage**, **tetti dell'analisi dei server**: le rotte
  ci sono già, si aggiungono la riconferma (3.1) e il registro.
- **La fonte del modello**: `GET /api/settings/models` aggiunge `source:
  setting | env | default` (additivo), da `ai_model_settings` →
  `worker_model_defaults` → il default di codice.
- **I repository d'istanza**: il gruppo «Non in un progetto» arriva con F6
  (i repository staccati nascono dall'eliminazione).

---

## F4 — Stato dell'istanza (D-7)

- **La pausa**: colonne `projects.queue_paused_at` e
  `queue_paused_by_user_id`.
  - `POST /api/projects/:projectId/queue/pause` e `/resume`
    (`proj:project.settings.manage`, come `settings.manage` del
    prototipo).
  - In pausa, i poller del worker NON reclamano lavoro nuovo di quel
    progetto. Il controllo sta nella WHERE del claim di ogni coda: `ai_jobs`,
    correzioni, review, `backlog_jobs`, `doc_generations`, `nightly_items`,
    `graph_jobs`, il passo di Claude delle automazioni (`queue_paused`
    dell'area 7, F3), il giudizio della posta.
  - Il lavoro già partito finisce. La chat, «Chiedi a Claude» e le sessioni
    interattive non si fermano (maintainer, 30 ott).
  - Alla ripresa, i lavori aspettano il loro turno come prima: l'ordine
    d'arrivo è quello delle code.
  - Nessun lavoro si cancella.
- **La vista**: `GET /api/instance/status` (`inst:instance.status.view`,
  permesso NUOVO nel preset Admin). Contiene:
  - per progetto visibile, i lavori in coda e in corso (tipo, età, stato,
    task);
  - i worker attivi, da un heartbeat nuovo (`worker_heartbeats`: id del
    processo, `seen_at`, la concorrenza);
  - gli errori degli ultimi 7 giorni legati alla task;
  - la quota degli account (le snapshot che ci sono);
  - lo stato del giro notturno;
  - la pausa di ogni progetto.
- **Il rilancio**: `POST /api/instance/jobs/:id/retry`
  (`proj:project.settings.manage` + `proj:runs.start` nel progetto del
  lavoro).
  - Solo un `task_run` fallito negli ultimi 7 giorni.
  - Riparte a nome di chi preme e passa dal gate del piano come
    `run_ticket`: la stessa funzione del rilancio della task, mai una copia.
  - Mai su una correzione ferma: la regola di oggi, «Il rilancio generico
    non tocca una correzione ferma».
- **Il passo bloccato dal budget che riparte** (invariante 5): quando il
  budget torna disponibile (mese nuovo o tetto alzato), i passi delle
  automazioni `held` per `budget` ripartono da soli. Lo fa il consumatore
  delle automazioni a ogni giro, non un job nuovo.
- **Riavvii, deploy, azioni sui server**: nessuno, per costruzione.

---

## F5 — impostazioni del progetto

- **La riconferma** su `/api/repositories/:id/env-files*` (import, imposta,
  togli, elimina; la lettura dei nomi no).
- **La rigenerazione**, con la riconferma, il nuovo valore visto una volta e
  il vecchio che smette subito:
  - `POST /api/projects/:projectId/ingestion-key`;
  - `POST /api/repositories/:slug/webhook-secret`.
- **I plugin del progetto**: il `PUT /api/projects/:id/plugins` accetta
  `ifMatch` (la versione letta, additivo). Diversa: `409 stale`, con la
  versione nuova (il conflitto del prototipo, [PG 5]). È il limite noto v1
  del CLAUDE.md, che si chiude qui.
- **La regola «discovery spento spegne il pulse»** (`pulseNeedsBacklogFor`
  del prototipo) diventa del server, nel `PATCH` del progetto.

---

## F6 — archivio ed eliminazione (D-8)

- **Colonne**: `projects.archived_at`, `archived_by_user_id`.
- **Rotte**:
  - `POST /api/projects/:projectId/archive` (`proj:project.settings.manage`):
    rifiutato `409 busy` con lavoro vivo (job in volo, sessioni attive,
    generazioni Docs), con le ragioni. Le esecuzioni aperte delle automazioni
    si annullano con «Project archived»;
  - `POST …/reopen`;
  - `DELETE /api/projects/:projectId`: **solo `inst:instance.full_admin`, solo
    se archiviato, con la riconferma**, e col codice del progetto nel corpo
    (`{ confirmCode }`, che deve coincidere).
- **L'archiviato sparisce ovunque**. La regola è in UN posto:
  `visibleProjectIds` e la WHERE di ogni elenco escludono gli archiviati.
  - Le eccezioni sono dichiarate: le letture `…?archived=true`, in sola
    lettura, per i membri di allora e i full admin.
  - Nessuna scrittura su un archiviato (`409 archived`), dichiarata nel
    registro delle rotte come `config.access`.
  - Le automazioni generali che agiscono su un archiviato falliscono in
    «Needs attention» ([PX 5]).
  - Il worker non reclama il suo lavoro: è la WHERE della pausa (F4),
    estesa.
- **L'eliminazione**: i repository restano, STACCATI (`repositories.project_id
  = null`), e compaiono in Amministrazione → Repositories, «Not in any
  project».
  - `POST /api/repositories/:id/link` (`inst:instance.full_admin`).
  - `DELETE /api/repositories/:id`, solo uno staccato, solo un full admin,
    con la riconferma.
- **Il web perde «elimina»** per chi ha `project.settings.manage`. È un cambio
  di regola: un client vecchio che lo prova riceve `403`.
- *Test*:
  - l'archiviato non compare in elenchi, ricerca, ⌘K, notifiche nuove,
    Home, «Chi può farlo?», Stato dell'istanza, automazioni;
  - riaprire lo riporta;
  - NEGATIVI: archiviare con lavoro vivo; scrivere su un archiviato;
    eliminare un progetto non archiviato, senza essere full admin, senza
    riconferma, col codice sbagliato.

---

## F7 — azioni di Claude dell'area 9 (D-14)

- **La classe C**: un'azione la cui rotta vuole la riconferma. Si conferma
  con la riconferma di CHI conferma (la sua finestra), mai di chi ha
  chiesto. Il catalogo dichiara la classe, e un test d'accordo la deriva da
  `config.reauth` delle rotte che l'azione chiama, così le due non
  divergono.
- **Le sei C del prototipo**: `addMember`, `removeMember`, `setMemberRole`,
  `registerPlugin` e `updatePluginRef` (con «Mi fido» nella proposta),
  `saveStorage` (solo senza segreti: una chiave non passa mai da Claude).
- **Le B dell'area 9**: archivia e riapri, impostazioni del progetto,
  modello, budget, automazione, provider acceso o spento e ordine, account
  git (senza token), revisore, app Google (senza secret), smoke, rimozione di
  un plugin, pausa e ripresa della coda, rilancio, allegati, webhook (senza
  segreto).
- **Restano vietati** (`claude-actions-never.test.ts`): PAT, inviti, segreti,
  decisioni, merge, approvazioni dei piani, il ruolo d'istanza, i reset,
  disattivare.
- Il renderer: `confirmEdited` passa da `reauth()` come Confirm (registro).

---

## F8 — i permessi di progetto dei reparti (D-1)

- **Tabella** `department_project_permissions`: (`department_id`,
  `project_id`, `permission`, `granted_by_user_id`, `granted_at`).
- **Il calcolo**, nello stesso posto di 1.2: un membro di un reparto che è
  anche membro del progetto riceve i permessi del reparto PER QUEL
  progetto. Non diventa membro di un progetto per via del reparto (il
  prototipo: «dati solo nei progetti dove la persona è già membro»).
- **`PUT /api/departments/:id/project-permissions`**
  (`inst:departments.manage`): ogni permesso dato deve stare in quelli di
  chi agisce in quel progetto (`escalation`). La riconferma resta spenta sui
  reparti per la scelta del 9 nov: **E-3**.
- **La provenienza** `department` compare nei Members e in «Chi può farlo?».
- *Test*: un permesso di reparto apre la rotta del progetto; uscire dal
  reparto la richiude; NEGATIVI: `escalation`, un non membro del progetto,
  Claude.

---

## Le invarianti, riscritte *(da applicare all'approvazione di questo design)*

### `docs/invariants/permissions.md` — sostituisce «Nessuna escalation, e il BERSAGLIO è protetto»

> - **Nessuna escalation sul DARE; nessuna gerarchia fra persone** *(maintainer,
>   30 ott 2026, confermato il 16 nov)*. In `apps/server/src/services/roles.ts`,
>   in UN posto, `assertNoEscalation` (403 **`escalation`**, con la chiave
>   mancante in `permission`): si assegna un ruolo, si rende effettivo un ruolo
>   modificandone i permessi, si dà un permesso personale a un membro (o, con
>   F8, a un reparto per un progetto), si invita, solo se ciò che si dà è
>   incluso nei propri permessi nello stesso ambito. TOGLIERE non chiede
>   niente: chi ha il permesso di gestione (`users.manage`,
>   `project.members.manage`, `roles.manage`, `departments.manage`) modifica
>   chiunque, anche chi ha più permessi di lui. Restano il rifiuto su sé stessi
>   (ruolo d'istanza, reset, disattivazione) e «resta sempre un full admin».
>   **Rischio accettato, scritto apposta**: chi ha `users.manage` può
>   azzerare il secondo fattore di un full admin e generarne il link di reset,
>   e quindi prenderne il posto. La difesa è la traccia, non il divieto:
>   entrambe le azioni chiedono la riconferma, lasciano la voce nel registro
>   delle modifiche (`person.second_factor_reset`,
>   `person.password_reset_link`) e in `security_events`, e mandano un
>   `security.alert` all'interessato. Chi dà `users.manage` a qualcuno sta
>   dando questo potere.

### `docs/invariants/permissions.md` — voce nuova

> - **I permessi effettivi in un progetto sono UNA funzione**: ruolo ∪
>   permessi personali (`project_member_permissions`) ∪ permessi del reparto
>   per quel progetto (F8), più l'implicito del full admin. La calcolano
>   `effectiveProjectPermissions` (`@stubwise/shared`) e
>   `projectPermissionsFor` (`apps/server/src/auth/access.ts`). Ogni gate, ogni
>   WHERE, `/api/auth/me` e «Chi può farlo?» passano da lì, e un test d'accordo
>   lega `who-can` a `can()`. Un permesso personale vale esattamente come uno
>   del ruolo; togliere un membro toglie i suoi permessi personali (cascade);
>   Claude non ne riceve mai (insieme fisso). Un progetto non resta senza un
>   `project.members.manage` fuori dai full admin (`last_manager`).

### `docs/invariants/permissions.md` — voce nuova

> - **Una persona disattivata non entra da nessuna porta, e non si
>   disattiva l'ultimo full admin.** Disattivare cancella nella stessa
>   transazione sessioni, PAT e `device_tokens`, e revoca gli inviti
>   pendenti che ha mandato; la lettura dell'identità la tratta come assente
>   anche se una sessione sopravvivesse a una corsa. Il login risponde come a
>   una password sbagliata. Riattivare non riporta i token di prima.

### `docs/invariants/identity.md` — file NUOVO (D-13)

> - **L'email di login cambia solo dopo il clic sul link mandato alla NUOVA.**
>   La richiesta vuole la riconferma; il link vale 24 ore, è monouso e salvato
>   come hash; fino al clic la vecchia resta quella del login. Il cambio,
>   nella stessa transazione, scrive `security_events` (`email_changed`) e la
>   voce del registro, e manda `security.alert`. Sessioni, token e secondo
>   fattore restano intatti; le caselle Google e le identità git e Slack non
>   cambiano. Un indirizzo già di un'altra persona o di un invito pendente è
>   rifiutato con lo stesso errore.
> - **La foto è un'immagine, mai un documento.** PNG, JPEG o WebP DEDOTTI dai
>   magic bytes (il tipo dichiarato non conta), al più 512 KB, mai SVG né GIF;
>   servita col tipo dedotto, `nosniff`, una CSP `default-src 'none';
>   sandbox` e la stessa visibilità delle persone.

### `docs/invariants/change-log.md` — file NUOVO (D-3, D-4)

> - **Il registro delle modifiche si scrive nella transazione della modifica,
>   e non si modifica né si cancella mai.** `recordChange(tx, …)`, un trigger
>   che rifiuta UPDATE e DELETE, nessuna potatura (D-4: per sempre). Un tipo è
>   una lista DICHIARATA (`CHANGE_LOG_TYPES`) con il suo schema e il suo
>   template: il server manda `type` e `data`, mai prosa.
> - **Un segreto non entra mai nel registro**: solo «sostituito». Un test di
>   sorgente lo verifica sugli scrittori.
> - **La lettura è filtrata nella WHERE**, prima della paginazione: le voci
>   d'istanza con `changelog.view`; quelle di un progetto con `changelog.view`
>   o con la gestione di quel progetto; mai una voce che nomini un progetto
>   invisibile.

### CLAUDE.md — «Stubwise non fa deploy: il merge è il confine» (aggiunta)

> La pausa della coda di un progetto (area 9, F4) e il rilancio di un lavoro
> fallito dallo Stato dell'istanza NON toccano un ambiente, un server o un
> processo: agiscono solo sulla coda di Stubwise. Una coda in pausa non
> reclama lavoro nuovo (la WHERE del claim di ogni coda), il lavoro già partito
> finisce, la chat e «Chiedi a Claude» non si fermano. Lo Stato dell'istanza
> non ha riavvii né azioni sui server, per costruzione.

### `docs/invariants/automations.md` (aggiunta, invariante 5)

> - **Un passo tenuto per il budget riparte da solo quando il budget torna**
>   (mese nuovo o tetto alzato), al giro del consumatore. Diverso dal
>   `budget_held` dei job delle task, che resta com'è.

### `docs/invariants/permissions.md` — voce nuova (D-8)

> - **Un progetto archiviato è come uno che non c'è, tranne che per chi lo
>   legge DI PROPOSITO.** `visibleProjectIds` e le WHERE lo escludono; lo
>   leggono in sola lettura i suoi membri e i full admin solo dalle letture
>   `archived=true`; nessuna scrittura (`409 archived`); il worker non reclama
>   il suo lavoro. Si elimina SOLO un archiviato, SOLO un full admin, con la
>   riconferma e il codice digitato; i suoi repository restano staccati.

### `second-factor.md` — aggiunta (D-13, E-1)

> - «Niente email: Stubwise non ne manda» diventa: Stubwise manda UN tipo di
>   email, il link di conferma del cambio dell'email (e l'avviso alla vecchia),
>   col trasporto di E-1; nient'altro passa di lì.

*(Solo se E-1 = a o b.)*

---

## [DECIDE]

- **E-1 — Come arriva il link del cambio d'email** (D-13 = b). Stubwise non
  manda email.
  - **a (consigliata)**: un trasporto SMTP d'istanza, facoltativo (env
    `SMTP_URL`, `MAIL_FROM`). Serve SOLO il link al nuovo indirizzo e
    l'avviso al vecchio. Senza, il cambio d'email dalle Preferenze dice «non
    disponibile su questa istanza», e resta il cambio fatto da un admin con
    `users.manage` e la riconferma, senza verifica, registrato e avvisato.
    È la prima email di Stubwise, e cambia la riga «niente email» per
    questo solo caso.
  - **b**: dalla casella Google COLLEGATA della persona (lo scope
    `gmail.modify` permette l'invio): nessun servizio nuovo, ma solo per chi
    ha una casella collegata, e l'avviso «alla vecchia» parte dalla vecchia
    stessa.
  - **c**: nessuna verifica, il cambio lo fa un admin. Contraddice D-13.
- **E-2 — Gli eventi degli avvisi sui webhook in uscita.** La regola M3
  dell'area 8 (F2) tiene i tipi del catalogo degli avvisi fuori dal
  webhook; il prototipo ne elenca 8 ([IN 4]).
  - **a (consigliata)**: con D-10 = b, ogni webhook SCEGLIE i suoi eventi,
    quindi gli 8 possono entrare, spenti di default. Sempre col testo dai
    template, mai la risposta di un cliente né il testo di una conversazione.
    M3 si riscrive così.
  - **b**: M3 resta, e gli 8 escono dal prototipo.
- **E-3 — La riconferma sui permessi dei reparti** (F8).
  - **a (consigliata)**: sì, sui soli permessi di PROGETTO dei reparti
    (danno accessi); il resto dei reparti resta senza, come deciso il 9 nov.
  - **b**: no, come il resto dei reparti.
- **E-4 — Il login nella web «app»** (D-15 = b, la domanda di 94).
  - **a (consigliata)**: anche il login della web «app» passa dalle pagine
    del prototipo (`/app/#/login`), e così invito, reset e primo avvio
    (`/app/#/register/<token>`, `/app/#/reset-password/<token>`,
    `/app/#/setup`). Gli stessi token valgono nei due; i link creati
    dall'app puntano all'app, quelli del web vecchio al web vecchio. Le
    rotte del web vecchio restano finché non si ritira.
  - **b**: solo invito, reset e primo avvio; il login resta quello del web
    vecchio.
