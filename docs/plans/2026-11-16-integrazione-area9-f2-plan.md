# Integrazione area 9, F2 — il registro delle modifiche: piano

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md`, «F2 — il
> registro delle modifiche» (D-3 = a, D-4 = a). Invariante:
> `docs/invariants/change-log.md`. Specifica dell'app: il prototipo,
> `apps/desktop/src/renderer/data/changelog/` (tipi, letture, visibilità) e
> `apps/desktop/src/renderer/data/admin/changeTypes.ts` (i tipi della 9a).
> Branch: `feat/area9-f2` da `feat/integrazione-area9` (dopo F1, 083fa85a9).

## Prima del codice

- Le **[DECIDE] G-1…G-4** in fondo: il design e il prototipo non dicono la
  stessa cosa su nomi dei tipi, forma di una voce e chi legge. Il piano è
  scritto con le opzioni consigliate; una risposta diversa cambia i Task 2,
  5–8 e 9.
- Il prototipo è la specifica dell'app (CLAUDE.md): dove il design tace o è
  più povero, il piano segue il prototipo e lo dice.
- **Una correzione al design**: «la migrazione aggiunge il valore al CHECK»
  non vale, perché `roles.permissions` non ha un CHECK. Un permesso nuovo si
  dà al preset con un `UPDATE "roles"` nella migrazione, come la 0179 con
  `support.manage` (e ai ruoli personalizzati che contengono il preset).

## Regole di lavoro (le solite)

- TDD: il test prima, visto rosso; le mutazioni con `mut.py`, che girano e
  danno l'esito sbagliato (non che esplodono). Se una mutazione resta verde,
  si guarda PERCHÉ.
- I file di test toccati si lanciano INTERI, uno alla volta; dopo un cambio
  fra pacchetti si ribuildano le dipendenze (`pnpm --filter
  "@stubwise/<pkg>^..." build`).
- Commit su percorsi espliciti, mai `-a`, mai `graphify-out/`. Lint, test,
  commit e push in UNA catena `&&`, con l'output su file letto dopo.
- Campi dei client solo additivi, coi default, e un test di parse senza.
- I container dei test: annotati prima, tolti per id dopo, mai per etichetta.
- Nessun giro completo del monorepo (lo fa 46).

## Task

### Task 1 — La migrazione (primo numero libero: oggi 0187)

- Tabella `change_log`:
  - colonne: `id`, `at` (default `now()`), `actor_user_id` (FK `ON DELETE
    SET NULL`), `actor_email` (testo fissato al momento), `actor_kind`
    (`user | agent | system`, CHECK), `type` (testo; l'elenco chiuso vive in
    shared, come `security_events.kind`), `project_id` (null = istanza; FK
    `ON DELETE SET NULL`, perché la voce resta anche quando il progetto
    sparisce, D-4), `subject_kind`, `subject_id`, `data` jsonb;
  - indici su (`at desc`, `id desc`), (`project_id`, `at desc`),
    (`actor_user_id`, `at desc`), (`type`, `at desc`).
- Il trigger `change_log_append_only`, `BEFORE UPDATE OR DELETE`, che
  rifiuta con un errore. Attenzione alle FK `SET NULL`: anche quelle sono
  UPDATE, quindi il trigger le lascia passare solo se cambiano SOLTANTO
  `actor_user_id` o `project_id` a null (il test lo prova eliminando un
  utente e un progetto).
- `changelog.view` al preset Admin e ai ruoli personalizzati d'istanza che
  contengono il preset (la regola della 0135). Il full admin l'ha implicito.
- Schema Drizzle e `migration-0187.test.ts`: colonne, CHECK, indici,
  trigger (UPDATE e DELETE rifiutati, le due `SET NULL` ammesse),
  `changelog.view` sul preset Admin.
- **Commit**: `feat(db): il registro delle modifiche (area 9, F2)`.

### Task 2 — Il catalogo in shared

- `packages/shared/src/change-log.ts`:
  - `CHANGE_LOG_TYPES`: per ogni tipo `{ kind, scope, group, readPermission
    }`, come `ChangeType` del prototipo (senza `templateKey`, che è dei
    client);
  - uno schema Zod di `data` per tipo (`changeDataSchemas`), e lo schema
    della voce letta (`changeEntrySchema`) con `type` aperto da
    `readerSchema` (un tipo ignoto arriva come `__unknown__`).
- La forma di `data` (G-2 = a): `{ object: { type, id, label }, before,
  after, params }`, la stessa del prototipo. `label` e i nomi di `params`
  sono FISSATI al momento: la voce resta leggibile anche quando l'oggetto
  sparisce.
- `INSTANCE_PERMISSIONS` riceve `changelog.view`.
- **Parità**: un test in shared verifica che ogni tipo abbia lo schema; uno
  nel renderer (lo scrive 94, è suo) che ogni tipo abbia
  `changelog.kinds.<kind>` nelle due lingue. Così i «tre posti» del design
  (lista, schema, template) restano allineati.
- **Commit**: `feat(shared): i tipi del registro delle modifiche (area 9, F2)`.

### Task 3 — Lo scrittore

- `apps/server/src/services/change-log.ts`: `recordChange(tx, entry)`.
  - Valida `data` con lo schema del tipo: un tipo sconosciuto o un `data`
    sbagliato sono un errore di programmazione, quindi lancia (in sviluppo e
    nei test lo si vede subito).
  - `actor_email` e i nomi si fissano qui. Claude scrive `actor_kind =
    'agent'` (lo userà F7); il sistema `system`.
  - Nessun `try/catch`: è nella transazione della modifica, quindi un errore
    del DB fa fallire la modifica, ed è voluto.
- **Il test di sorgente sui segreti** (`change-log-secrets.test.ts`): nei
  moduli che chiamano `recordChange`, nessuna chiave di `data` o `params` il
  cui nome contenga `secret`, `token`, `password`, `key` (eccetto
  `keyLast4`). I moduli si trovano cercando `recordChange(`, così uno
  scrittore nuovo è coperto senza toccare il test. Più un caso negativo:
  una chiave proibita in un file finto fa fallire la funzione del test.
- **Commit**: `feat(server): lo scrittore del registro delle modifiche (area
  9, F2)`.

### Task 4 — Gli scrittori: persone

I tipi sono i nomi del prototipo (G-1 = a). Ognuno si scrive col `tx` della
modifica, accanto alla riga di `security_events` dove c'è già.

- `person.instance_role_changed`: `PATCH /api/users/:id/instance-role`
  (prima/dopo: i nomi dei ruoli).
- `person.password_reset_link_created`: `POST /api/users/:id/password-reset`.
- `person.second_factor_reset`: `DELETE /api/users/:id/second-factor`.
- `person.deactivated`, `person.reactivated`: `services/user-deactivation.ts`
  (in `params` quante task sono state riassegnate, mai i titoli).
- `person.email_changed`: il cambio dell'email (F1), sia quello confermato
  dal link sia quello fatto da un admin (prima/dopo: le due email). Non è
  nel prototipo: lo aggiunge la F1 del server (G-1).
- `person.git_identity_linked`, `person.git_identity_unlinked`,
  `person.bitbucket_username_set`: `routes/git-identity-routes.ts`.
- **Test** (`change-log.people.test.ts`): ogni percorso lascia la sua voce;
  e un percorso che fallisce DOPO la modifica non la lascia (per esempio la
  disattivazione dell'ultimo full admin: 409, nessuna voce).
- **Commit**: `feat(server): il registro, le persone (area 9, F2)`.

### Task 5 — Gli scrittori: inviti e primo avvio

- `invite.created`, `invite.revoked` (`routes/auth.ts`, `/invites`);
  `invite.accepted` (`POST /api/auth/register`, attore = chi entra);
  `instance.first_admin_created` (`POST /api/auth/setup`).
- `data` dell'invito: l'email invitata, i progetti col ruolo (i nomi), mai
  il token.
- **Test**: le quattro voci; il token non compare in nessuna voce.
- **Commit**: `feat(server): il registro, gli inviti (area 9, F2)`.

### Task 6 — Gli scrittori: ruoli e reparti

- `role.created` (anche da «Duplicate», con `params.from` = il nome
  d'origine), `role.updated` (permessi prima/dopo, e il nome se cambia),
  `role.deleted` (`services/roles.ts`).
- `department.created`, `department.updated`, `department.deleted`,
  `department.members_changed`, `department.home_managers_changed`
  (`routes/departments.ts`). Le persone in `params` sono ID con il nome
  fissato: alla LETTURA quelle che chi guarda non vede si tolgono (Task 8).
- `department.permissions_changed` è di F8: il tipo si dichiara ora, lo
  scrittore no.
- **Test**: le voci; il prima/dopo dei permessi di un ruolo.
- **Commit**: `feat(server): il registro, ruoli e reparti (area 9, F2)`.

### Task 7 — Gli scrittori: membri dei progetti

- `member.added`, `member.role_changed`, `member.removed`,
  `member.permission_granted`, `member.permission_revoked` (una voce per
  permesso, come il prototipo): `putProjectMember` e `removeProjectMember`
  in `services/roles.ts`.
- Anche dalla conferma di una proposta della posta (area 6,
  `services/mail-proposals-decide.ts`), che passa da `putProjectMember`
  per aggiungere e toglie i Contributor con un `delete` suo: anche quel
  `delete` scrive `member.removed`. Chiude la voce del registro dei rimandi
  «Audit vera dei membri di progetto».
- **Test**: le voci; una proposta confermata aggiunge e poi toglie un
  Contributor, e lascia le due voci.
- **Commit**: `feat(server): il registro, i membri (area 9, F2)`.

### Task 8 — La lettura

- `GET /api/change-log?person=&project=&type=&group=&from=&to=&cursor=`
  (`user`) e `GET /api/projects/:projectId/change-log` (stessi filtri senza
  `project`); paginazione keyset su (`at`, `id`), 50 per pagina.
- **Chi legge cosa, in UN posto** (`services/change-log-read.ts`), sempre
  nella WHERE e prima della paginazione (G-3 = a, la regola del prototipo):
  - una voce d'istanza: `changelog.view`, oppure il `readPermission` del suo
    tipo (chi gestisce l'oggetto: `users.manage` per le persone,
    `roles.manage` per i ruoli…);
  - una voce di progetto: il progetto dev'essere visibile, E chi guarda ha
    `changelog.view`, oppure gestisce il progetto
    (`project.settings.manage` o `project.members.manage`), oppure ha lì il
    `readPermission` del tipo;
  - mai una voce che nomini un progetto invisibile, anche se è d'istanza (in
    `params`).
- `GET /api/projects/:projectId/change-log`: progetto invisibile → 404 come
  uno che non esiste; visibile senza gestione → 403.
- `GET /api/change-log/filters` (`user`): le persone e i progetti che chi
  guarda vede, i gruppi di voci che legge, `everything` = ha
  `changelog.view`. È `listChangeFilterChoices` del prototipo.
- **La voce letta** porta `type`, `at`, l'attore (`{ id, name, kind }`, col
  nome di allora), `projectId` e `projectCode`, `data`, più
  `objectDeleted` (l'oggetto non c'è più). Il server non manda prosa: la
  frase, il link all'oggetto e il prima/dopo da leggere li compone il client
  (G-4 = a).
- **Le persone invisibili** non escono, né per nome né contate: dai
  `params` delle voci che elencano persone si tolgono quelle che chi guarda
  non vede (`visiblePersonIds`, F1).
- **Test** (`change-log-read.test.ts`):
  - il test d'accordo: per un seme con tutti i tipi e cinque persone, ogni
    voce letta ⇔ la regola scritta nel test;
  - NEGATIVI: senza `changelog.view` né la gestione; un progetto invisibile
    (404, e le sue voci assenti dal registro d'istanza); una voce d'istanza
    che nomina un progetto invisibile; un membro di reparto invisibile tolto
    dai `params`; la paginazione non cambia con i filtri di visibilità
    (nessuna pagina corta perché il filtro è a valle);
  - il trigger: un UPDATE e un DELETE diretti falliscono.
- **Commit**: `feat(server): leggere il registro delle modifiche (area 9, F2)`.

### Task 9 — Il client

- `packages/api-client`: `changeLog.list(filter)`,
  `changeLog.listProject(projectId, filter)`, `changeLog.filters(projectId?)`.
- Un test di parse per ogni risposta senza i campi facoltativi; `__unknown__`
  per un `type`, un `actor.kind` o un `object.type` ignoti.
- **Commit**: `feat(api-client): il registro delle modifiche (area 9, F2)`.

### Task 10 — Deploy-log, build e review

- **La voce del deploy-log**:
  - l'ordine: server (0187), poi caddy;
  - il registro parte dal deploy: niente prima (D-3), e le voci di prima
    non si ricostruiscono;
  - il rollback: 0187 additiva. Un server vecchio non scrive voci, quindi il
    registro ha un buco per il tempo del rollback, e lo si scrive. La
    tabella non si svuota (D-4).
- `pnpm build` completo e `check:dist`.
- **La review finale** con un revisore a contesto fresco. Il Review Focus:
  - una voce che sopravvive a una modifica annullata (fuori transazione);
  - un segreto o un token dentro una voce;
  - una voce di un progetto invisibile che esce, anche dai `params` o dai
    conteggi;
  - un UPDATE o DELETE che passa il trigger;
  - un percorso di 9a o di F1 che modifica senza voce (cercare gli UPDATE su
    `users`, `roles`, `project_members`, `project_member_permissions`,
    `departments`, `invites`).

## Cosa F2 non fa

- Le voci di 9b e 9c (impostazioni d'istanza, di progetto, archivio): le
  scrivono F3–F6, ognuna coi suoi tipi.
- `via: "claude"` e «Annulla» (area 10a del prototipo): F7.
- I permessi dei reparti: F8 (il tipo c'è, lo scrittore no).
- Le pagine: sono del renderer (94), sopra il client del Task 9.

## Stima

Dieci task. I Task 4–7 sono ripetitivi ma toccano molti file; il Task 8 è il
più delicato (WHERE, keyset, persone invisibili).

## [DECIDE]

- **G-1 — I nomi dei tipi.** Il design elenca `person.password_reset_link`,
  `member.permissions_changed`, `role.duplicated`, «le identità git e
  Bitbucket»; il prototipo ha `person.password_reset_link_created`,
  `member.permission_granted`/`_revoked` (una voce per permesso), nessun
  `role.duplicated` (è un `role.created`), `person.git_identity_linked`/
  `_unlinked`, `person.bitbucket_username_set`, e in più `invite.accepted`,
  `instance.first_admin_created`, `department.permissions_changed`.
  - **a (consigliata)**: i nomi del prototipo, più `person.email_changed`
    (il cambio d'email nato in F1, che il prototipo non ha: lo aggiunge 94).
  - **b**: i nomi del design, e il prototipo si adegua.
- **G-2 — La forma di una voce.** Il design dice `subject_kind`,
  `subject_id` e `data` (prima e dopo, i nomi); il prototipo ha `object {
  type, id, label }`, `before`, `after`, `params`.
  - **a (consigliata)**: le colonne del design (servono agli indici e ai
    filtri) e, dentro `data`, la forma del prototipo. Una voce si legge
    allo stesso modo nei due mondi.
  - **b**: solo la forma del design, e il renderer la traduce.
- **G-3 — Chi legge.** Il design: le voci d'istanza solo con
  `changelog.view`. Il prototipo: anche chi ha il `readPermission` del tipo
  (chi gestisce l'oggetto: `users.manage` legge le voci delle persone,
  `roles.manage` quelle dei ruoli…).
  - **a (consigliata)**: la regola del prototipo. Chi può già cambiare un
    ruolo vede chi l'ha cambiato prima; `changelog.view` resta il «vedere
    tutto».
  - **b**: la regola del design, e il prototipo la restringe.
- **G-4 — Chi compone la riga.** Il prototipo dà al client una voce già
  pronta (link all'oggetto, prima/dopo da leggere, «(deleted)»); il design
  dice che il server manda `type` e `data` e il client compone.
  - **a (consigliata)**: il server manda `type`, `data`, l'attore col nome,
    il codice del progetto e `objectDeleted`; il link e il prima/dopo da
    leggere li calcola il client (sono presentazione, e il client ha già le
    rotte). Le persone invisibili le toglie il SERVER (è sicurezza, non
    presentazione).
  - **b**: il server manda la voce già pronta, come il livello dati del
    prototipo.
