# Workspace — piano a lotti (27 nov 2026)

> Design: `docs/plans/2026-11-27-workspace-design.md` (decisioni D1–D19 in §7).
> Shape e prototipo: 79, `apps/desktop/.impeccable/shape/workspaces.md`. Il
> prototipo resta la specifica dell'interfaccia; i nomi condivisi col livello
> dati sono `POST /api/workspaces/effect` (`workspaceAccessEffect`) e la fonte
> `{ kind: "workspace", workspaceId, workspaceName, roleId }` di
> `PermissionSource`.
> Rami: `feat/workspace` da `origin/docs/workspace-design`, un lotto alla volta,
> pull con merge prima di ogni push, mai force.

## Regole per ogni lotto

- **TDD**: il test rosso si vede prima del codice. Ogni regola di permesso ha un
  test **negativo** (403/404, DB invariato), e ogni elenco un test **a due
  utenti sugli stessi dati**: membro di workspace e non membro.
- **Mutazioni** sul cuore della regola del lotto: tolta la condizione, il test
  deve diventare rosso.
- **Giro del lotto**: i file di test toccati, interi, coi percorsi scritti.
  Dopo un cambio in `packages/db`, `packages/shared` o `packages/notifications`
  si ribuildano i `dist`. Typecheck ed eslint dei package toccati.
- **Revisione**: a fine lotto una revisione del diff (fresca, non mia) prima del
  merge sul ramo. Le correzioni Critical/Important si fanno nello stesso lotto,
  ognuna col suo test rosso.
- **Senza workspace nulla cambia**: fino al lotto 3 non esistono rotte per
  crearle, e le suite esistenti restano verdi senza toccarne le aspettative. Se
  un test esistente cambia, è un segnale da capire, non da aggiornare.
- Report all'orchestratrice con gli sha a ogni lotto.

## Lotto 1 — Modello e vista, i 9 lettori centrali

**Obiettivo**: le tabelle, la vista `project_access` e la regola dei permessi
in un pezzo solo, usata dalle funzioni centrali. Nessuna rotta.

1. **Migrazione 0238** (`packages/db/drizzle/0238_workspaces.sql` + journal), scritta a mano come le ultime:
   - `workspaces`, `workspace_projects` (pk + `unique(project_id)`, D2), `workspace_members`
     (`role_id` `on delete restrict`), `invite_workspaces`;
   - CHECK sul nome come per i reparti, colore nella palette dei reparti;
   - un trigger su `workspace_members` e `invite_workspaces` che rifiuta un
     ruolo d'istanza (`roles.scope <> 'project'`), con un messaggio che dice
     perché;
   - la **vista `project_access`** (design §1.4): una riga per fonte, `member` o `workspace`.
2. **Schema Drizzle** (`packages/db/src/schema.ts`): le tabelle e la vista
   (`pgView(...).existing()`, perché la crea la migrazione).
3. **Permesso** `workspaces.manage` nel catalogo d'istanza
   (`packages/shared/src/permissions.ts`), senza preset (D4). Etichette i18n del
   catalogo.
4. **La regola**: in `packages/db/src/member-permissions.ts`
   - `projectAccessPermissionsSql(projectId, userId)`: l'unione dei ruoli di
     tutte le righe di `project_access`, più i personali (solo se c'è la riga
     `member`), più i reparti (D10), mai a un utente di sistema; `null` senza
     righe;
   - `projectAccessSql(projectId, userId)`: l'esistenza di una riga, definita
     come `projectAccessPermissionsSql(...) is not null` per non divergere;
   - `memberPermissionsSql` resta per i chiamanti di gestione, oppure diventa
     un alias: lo decide l'inventario dei chiamanti nel lotto.
5. **I 9 lettori centrali** sulla vista:
   - `visibleProjectIds`, `projectPermissionsFor`, `projectIdsWithPermission`
     e `projectPermissionsMap` (`apps/server/src/auth/access.ts`);
   - `projectPermissionsByProject` / `projectPermissionsOfUser`,
     `projectViewerIds`, `projectViewerIdsByProject` e `userIdsWithPermission`
     (`packages/notifications/src/project-access.ts`);
   - `visiblePersonIds` (`services/people-visibility.ts`).
6. **`role_in_use`**: `projectsOfRole` e il conteggio dell'eliminazione di un
   ruolo contano anche `workspace_members` (un ruolo usato da una workspace non
   si elimina).

**Test** (in `packages/db` col Postgres di testcontainers, e nel server):
- la vista: una riga per fonte, e due righe se la persona è sia membro sia di workspace;
- l'unione:
  - Viewer di workspace + Developer esplicito + un permesso di reparto danno l'unione;
  - un override più basso non toglie niente (D1);
  - un utente di sistema in `workspace_members` non riceve niente;
- il trigger rifiuta un ruolo d'istanza;
- l'indice unico rifiuta un progetto in due workspace (D2);
- le funzioni centrali, a due utenti sugli stessi dati: membro di workspace e non membro. Per ciascuno:
  - `visibleProjectIds` lo include (o no);
  - `projectPermissionsFor` dà Viewer (o null), un archiviato resta fuori;
  - `/api/auth/me` porta i permessi del progetto;
  - `projectViewerIds` lo conta;
- un progetto di workspace è 404 per il non membro, 200 per il membro (una rotta qualunque col resolver del progetto);
- **revoca a lettura**: cancellata la riga di `workspace_members`, tutto sparisce senza altre scritture;
- `role_in_use` con un ruolo usato solo da una workspace;
- le suite esistenti di `access`, `roles`, `project-access`, `departments` e `inbox` restano verdi senza modifiche.

**Mutazioni**:
- tolta la riga `workspace` dalla vista;
- personali applicati anche alla riga `workspace`;
- tolto `not is_agent`;
- tolta la parte `archived_at` da `visibleProjectIds`.

## Lotto 2 — Le 28 query a mano sulla vista

**Obiettivo**: nessuna query decide visibilità, permessi o destinatari con
`project_members` da solo. L'elenco è l'inventario del design. Per gruppi, un
commit per gruppo:

1. **Card e inbox** (`packages/notifications`, condiviso col worker):
   - `notificationVisibleToRecipient`;
   - `catalogPermissionVisible`;
   - `folderLinkExpiredSql`;
   - `loadPlanWorld` e la sua copia `contextParts` (`automations/examples.ts`);
   - `withoutStrangers` e `automationCardsFor` (`services/inbox.ts`).
2. **Persone e destinatari**:
   - `canReceive` e `openTasksOf`;
   - `managedProjectIds`;
   - `peopleKnownTo`, l'elenco utenti di `routes/users.ts` e `suggestRecipients`;
   - `effectiveMemberIds`.

   In più, D5: un membro di una workspace senza progetti conosce le altre
   persone della workspace (`peopleKnownTo`).
3. **Ruoli e permessi**:
   - `actorProjectPermissions` (l'anti-escalation legge i permessi effettivi);
   - `managerCount` e `lastManagerProjectOf`: D18, un gestore di workspace conta;
   - `memberships` e `viewerLosesIf` (`access-query.ts`, «Chi può farlo?»);
   - `judgeDepartmentDraft`;
   - le due query «chi resta gestore» di `routes/departments.ts`;
   - `previewMember`.
4. **Cassaforte** (D16): `effectiveReaderCondition` (`vault/readers.ts`),
   `readersView` e `targetPeople` (`vault/sharing.ts`). Il ruolo di workspace
   vale come ruolo di progetto; la vista della condivisione dice quante persone
   raggiunge per via di workspace (campo additivo).
5. **Worker, Google** (D17):
   - `loadCandidateProjects` (`classify-v2.ts`);
   - `attendeeProjects` (`calendar-guess.ts`);
   - `inviteesOfAny` (`calendar-shared.ts`).

   Le persone di workspace contano come membri, e gli admin impliciti restano
   esclusi dove lo sono oggi.
6. **Il test di registro** (sul sorgente, come `vault-isolation.test.ts`): ogni
   file di `apps/server/src`, `apps/worker/src` e `packages/*/src` che nomina
   `projectMembers` o `project_members` sta in un elenco CHIUSO di siti di
   gestione o di sola visualizzazione (le categorie C e D dell'inventario). Un
   file nuovo fa fallire il test, e il messaggio dice di usare `project_access`.

**Test**:
- **Ogni gruppo** ha il suo test a due utenti: membro di workspace e non membro.
- **Card**: la card del progetto arriva e si vede al membro di workspace e sparisce togliendolo.
- **Persone**: le persone della stessa workspace si conoscono; quelle di un progetto invisibile restano segnaposto.
- **`last_manager`**: il gestore di workspace conta (D18).
- **Cassaforte**: una credenziale condivisa al ruolo Viewer la legge il Viewer di workspace.
- **Worker**: il membro di workspace è fra i destinatari della proposta condivisa del calendario, e un admin non invitato resta fuori (i test negativi di `calendar-shared.test.ts` restano veri).
- Il test di registro, rosso con un sito fuori elenco.

**Invarianti** nello stesso lotto:
- `docs/invariants/permissions.md`: la funzione unica ora legge `project_access`, e F8-1 vale anche per i membri di workspace (D10);
- `docs/invariants/mail-calendar.md`: chi conta come membro nella posta e nel calendario (D17).

## Lotto 3 — Il servizio e le rotte delle workspace

**Obiettivo**: creare, gestire e popolare le workspace, con tutte le regole del
design §1.6 e §2.

1. **`services/workspaces.ts`**:
   - creare, rinominare ed eliminare;
   - mettere, togliere e spostare un progetto (una riga, un `upsert` sull'indice unico);
   - aggiungere una persona, cambiarne il ruolo, toglierla, con la casella «togli anche dagli override» (D12);
   - `judgeWorkspaceGrant`: l'anti-escalation su ogni progetto, archiviati compresi, reparti di chi entra compresi; usata da anteprime e scritture;
   - `last_manager` dopo la modifica, nella stessa transazione, per tutti i progetti toccati (409 con l'elenco);
   - Claude rifiutato (400 `system_user`);
   - un preset Viewer mancante dà 400 `role_required` (D3).
2. **Rotte** (`routes/workspaces.ts`), tutte con `config.access` e `config.mcp`
   (tabella del design §2.2):
   - le letture: `GET /api/workspaces` e `GET /api/workspaces/:id`, con i soli
     progetti visibili, le persone (D5) e 404 per chi non vede la workspace;
   - `POST /api/workspaces/effect` (`workspaceAccessEffect`): `startSeeing`,
     `stopSeeing`, `lastManager`, `escalation`;
   - `POST /:id/members/preview`;
   - la riconferma su aggiungere una persona, alzarne il ruolo, mettere un
     progetto, creare con progetti se ci sono persone (D11). Queste rotte sono
     esclusioni `reauth` dell'MCP.
3. **Registro delle modifiche**:
   - gli 8 tipi `workspace.*`, coi loro `readPermission`;
   - le voci di progetto anche nel registro del progetto;
   - i segnaposto r.1414 per le persone che chi legge non conosce.
4. **Notifiche**: `member.added` con `workspaceId` additivo (nullable, default
   null), i progetti derivati a lettura. Alla persona e a chi gestisce i membri,
   mai a chi ha agito. Nessuna card per un progetto aggiunto (D13). Nessun
   `notification_kind` nuovo.
5. **«Annulla» di Claude** (D14): entrare in una workspace e mettere un
   progetto, nel catalogo delle azioni di Claude, coi test degli effetti
   (`claude-actions-effects.test.ts`).
6. **MCP**: il test di parità sulle rotte nuove, e le note «cambia chi vede i
   progetti».

**Test negativi** (DB invariato in ognuno):
- escalation su uno dei tre progetti;
- senza `workspaces.manage`;
- senza `project.members.manage` nel progetto da mettere, e in uno dei due per uno spostamento;
- `last_manager` togliendo un progetto, togliendo una persona, abbassandone il ruolo, eliminando la workspace;
- un progetto invisibile dentro una workspace visibile: né id né nome, nemmeno in `effect`;
- una workspace invisibile: 404;
- la riconferma mancante;
- un PAT sulle rotte con la riconferma.

**Positivi**:
- spostare fra due workspace in una scrittura;
- `effect` coincide con ciò che la scrittura poi fa: stessa persona, stessi progetti.

## Lotto 4 — Invito, persone, fonti

1. **Invito di registrazione** (D9): `invite_workspaces` nel body di
   `POST /api/invites`; `assertInviteGrants` e `applyInviteGrants` con la
   riverifica R51 all'accettazione (una workspace non più concedibile si scarta
   con una riga di log). Revoca degli inviti pendenti di chi viene disattivato,
   come oggi.
2. **Fonti di un permesso**: `departmentGrantsOf`, «Chi può farlo?», la pagina
   della persona, la sezione Members e l'anteprima del membro mostrano la fonte
   `workspace`. Il test d'accordo `who-can` ↔ `can()` si estende al caso workspace.
3. **People**: le workspace della persona, col ruolo.
4. **Progetto eliminato** (D19): `deleteArchivedProject` copia in
   `deleted_project_members` anche chi lo vedeva per workspace.
5. **Disattivazione e riattivazione**: le righe di workspace restano; test che
   la persona disattivata non vede niente e quella riattivata ritrova tutto.

**Test**:
- **Invito**: l'invitante perde il permesso prima dell'accettazione, e la workspace si scarta; l'invito senza ruolo prende Viewer; l'escalation all'invito dà 403.
- **Fonti**: la fonte `workspace` coincide con `can()`.
- **Progetto eliminato**: dopo l'eliminazione, l'ex membro di workspace legge l'etichetta `CODICE · Nome`.

## Lotto 5 — L'adattatore vero del desktop

Con 79, sopra il prototipo. L'adattatore (`data/backend/real/`) legge le rotte
del lotto 3 e 4, la fonte `workspace` e `workspaceAccessEffect`. I test
`ComingSoon`, `integration` e il seme stanno nel giro filtrato del desktop. Le
difese del web (`?? []`) servono solo se il web vecchio legge i campi nuovi:
non li legge.

## Lotto 6 — Rilascio

- **Voce del deploy-log** «Workspace»:
  - l'ordine: server (0238), poi worker, poi caddy;
  - il rollback, sicuro per i dati ma con l'accesso tolto a chi vede solo per
    workspace, e la query che li conta;
  - nessun `notification_kind` nuovo.
- **CLAUDE.md**: la riga d'indice la aggiunge l'orchestratrice (io non lo tocco).
- **Changeset MCP**: solo se un tool curato cambia; il catalogo si aggiorna da solo.
- **Giro completo**: lo fa l'orchestratrice dopo l'unione.
