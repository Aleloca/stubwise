# Workspace — design (27 nov 2026)

> Design tecnico (72, server e worker). La shape e il prototipo del desktop li
> cura 79, in `apps/desktop/.impeccable/shape/workspaces.md`: **il prototipo resta
> la specifica dell'interfaccia**, questo documento dice il modello, le regole
> del server e il rilascio. Riferimenti: `docs/invariants/permissions.md` (le
> regole che il modello deve rispettare),
> `docs/plans/2026-10-22-permessi-progetto-design.md` (ruoli e membri),
> `docs/plans/2026-11-16-integrazione-area9-design.md` (reparti, F8).
> Il maintainer ha accettato tutte le raccomandazioni il 27 nov 2026: le
> decisioni sono in §7. Il piano a lotti: `docs/plans/2026-11-27-workspace-piano.md`.

## 0. Le parole del maintainer (la fonte)

- Le workspace sono raggruppamenti di **PROGETTI** per **VISIBILITÀ**. I reparti
  restano raggruppamenti di **PERSONE** per ruolo e permessi. Due concetti
  diversi che convivono.
- Si invita una persona direttamente in una workspace: l'invito le dà
  visibilità su tutti i progetti al suo interno, di default col ruolo più basso
  possibile.
- Per ogni progetto della workspace si può sovrascrivere il ruolo di quella
  persona su quel singolo progetto.
- La persona può avere anche un ruolo che viene da un reparto.
- Vince il permesso **più alto** fra tre fonti: (1) la workspace, (2) il
  progetto, (3) il reparto su quel progetto.
- Nella nuova app la colonna di sinistra della pagina Progetti («Groups of
  projects will be listed here.») è dove vivono le workspace.

## 1. Il modello

### 1.1 Tabelle (una migrazione, la prossima libera: 0238)

```
workspaces
  id            uuid pk
  name          text not null      -- CHECK length(btrim(name)) between 1 and 80
  color_token   text not null      -- stessa palette dei reparti ('--dept-1'…'--dept-8'), se la shape la vuole
  created_at    timestamptz not null default now()
  created_by_user_id uuid null references users on delete set null

workspace_projects                 -- un progetto in AL PIÙ una workspace (D2)
  workspace_id  uuid not null references workspaces on delete cascade
  project_id    uuid not null references projects on delete cascade
  position      integer not null default 0   -- l'ordine nella colonna, se la shape lo chiede
  added_at      timestamptz not null default now()
  pk (workspace_id, project_id)
  unique (project_id)              -- la regola «al più una»: un indice, non una convenzione

workspace_members
  workspace_id  uuid not null references workspaces on delete cascade
  user_id       uuid not null references users on delete cascade
  role_id       uuid not null references roles on delete restrict   -- un ruolo di PROGETTO
  added_by_user_id uuid null references users on delete set null
  added_at      timestamptz not null default now()
  pk (workspace_id, user_id)
  index (user_id)

invite_workspaces                  -- l'invito di registrazione che promette una workspace (§3)
  invite_token  text not null references invites on delete cascade
  workspace_id  uuid not null references workspaces on delete cascade
  role_id       uuid not null references roles on delete cascade
  pk (invite_token, workspace_id)
```

- **Il ruolo di workspace è un ruolo di PROGETTO** (`roles.scope = 'project'`:
  i preset Viewer, Contributor, Developer, Project Lead, Legacy Member e quelli
  creati in Amministrazione → Ruoli). Un trigger o un CHECK via funzione
  rifiuta un ruolo d'istanza, come per `project_members.role_id` oggi (stessa
  difesa: se oggi è nel servizio, sta nel servizio). `on delete restrict`
  perché un ruolo in uso non si elimina (409 `role_in_use`, che conta anche le
  righe di workspace).
- **L'override per progetto è un membro di progetto normale**
  (`project_members`, con il suo ruolo e i suoi permessi personali
  `project_member_permissions`, come oggi). Non serve una riga a sé: è la fonte
  (2) del maintainer, e tutto ciò che oggi la gestisce (Members, anteprima,
  anti-escalation, `last_manager`, `member.added`) resta valido.
- **Un progetto fuori da ogni workspace resta esattamente com'è oggi**: membri
  espliciti più i full admin impliciti.
- **Niente gerarchia di workspace** (una workspace non ne contiene un'altra).

### 1.2 Chi «è membro» di un progetto

Oggi «membro» = una riga `project_members`. Con le workspace l'appartenenza
diventa **derivata**:

> una persona è membro (vede il progetto) se ha una riga `project_members`
> **oppure** è in `workspace_members` di una workspace che contiene il progetto
> (`workspace_projects`); i full admin restano membri impliciti di ogni progetto.

Un **reparto continua a non rendere membri** (F8-1 = a resta vero): dà permessi
solo dove la persona è già membro, e da ora «membro» include l'appartenenza
derivata dalla workspace. È ciò che il maintainer chiama «(3) il reparto su
quel progetto».

### 1.3 Il permesso effettivo: l'UNIONE delle tre fonti

«Vince il più alto» si realizza come **unione dei permessi**, non come scelta di
un ruolo: i preset **non sono in ordine totale** (Contributor crea ticket e voci
ma non vede tutto; Viewer vede tutto ma non crea niente), quindi «il ruolo più
alto» non è definito, mentre l'unione dà per ogni singolo permesso il valore
più alto fra le fonti. È anche la forma di oggi (ruolo ∪ personali ∪ reparti).

```
permessi(persona, progetto) =
     ruolo di workspace          (se il progetto è in una workspace della persona)
   ∪ ruolo di progetto ∪ permessi personali   (se ha una riga project_members)
   ∪ permessi di progetto dei suoi reparti    (se è membro per una delle due vie sopra)
   ∪ tutto                                    (se full admin, implicito)
   — null se nessuna delle due vie di appartenenza e non full admin (404)
   — mai a un utente di sistema (Claude: insieme fisso, come oggi)
```

Conseguenza voluta: un override **non può togliere** ciò che la workspace dà
(l'unione non sottrae). Sovrascrivere serve ad ALZARE il ruolo su un progetto.
Chi vuole che una persona abbia meno su un progetto la toglie dalla workspace
e la aggiunge ai progetti uno per uno. È la lettura letterale di «vince il più
alto», confermata dal maintainer (D1).

### 1.4 Dove vive la regola: UN pezzo SQL, come oggi

La regola «I permessi effettivi in un progetto sono UNA funzione» resta vera:
cambia il pezzo SQL, non il numero dei posti.

- **`memberPermissionsSql`** (`packages/db/src/member-permissions.ts`) oggi
  riceve il ruolo dalla riga `project_members` già unita dal chiamante. Diventa
  **`projectAccessPermissionsSql(projectId, userId)`**, una sottoquery
  autonoma sulla vista `project_access` (sotto) che calcola l'unione sopra
  (`null` = non membro), più una
  **`projectAccessSql(projectId, userId)`** booleana («è membro per una delle
  due vie») per le WHERE di visibilità. Le due stanno nello stesso file e la
  seconda è definita dalla prima (`is not null`), così non divergono.
- **`visibleProjectIds`**, **`projectPermissionsFor`**,
  **`projectPermissionsByProject`** / **`projectPermissionsOfUser`**
  (`packages/notifications/src/project-access.ts`, condivisa col worker),
  **`projectViewerIds`** e **`projectPermissionsMap`** (`/api/auth/me`)
  passano tutte dal nuovo pezzo. Il full admin implicito resta a
  `effectiveProjectPermissions`, come oggi.
- **Una vista del DB, `project_access`.** L'inventario (in fondo) trova 9
  funzioni centrali e **28 query** che uniscono `project_members` a mano per
  decidere visibilità, permessi o destinatari, alcune nel worker. Riscriverle
  una per una sopra due funzioni TS è il modo in cui se ne dimentica una. La
  raccomandazione è quindi una **`VIEW`** con una riga per FONTE:
  ```sql
  create view project_access as
    select pm.project_id, pm.user_id, pm.role_id, 'member'::text as source, null::uuid as workspace_id
    from project_members pm
    union all
    select wp.project_id, wm.user_id, wm.role_id, 'workspace', wm.workspace_id
    from workspace_members wm join workspace_projects wp on wp.workspace_id = wm.workspace_id;
  ```
  - Una persona può avere **due righe** per lo stesso progetto (membro
    esplicito e workspace).
  - Le query di **esistenza** («è membro», «chi vede») passano da
    `project_members` a `project_access` con un cambio meccanico.
  - Le query che leggono il **ruolo** aggregano: `memberPermissionsSql` fa
    l'unione dei `roles.permissions` di tutte le righe, più i personali (solo
    della riga `member`) e i reparti.
  - Le scritture e la sezione Members restano su `project_members`.
  - Il costo è ricreare la vista nelle migrazioni che toccano le tabelle sotto:
    poche, e il test di registro (§6.4) lo ricorda.
- **Le query che uniscono `project_members` a mano per decidere visibilità o
  destinatari** sono il rischio vero del rilascio: ognuna dimenticata è una
  persona di workspace che non vede, o non riceve, ciò che dovrebbe. Prima di
  scrivere codice si fa l'inventario completo (§5.1) e ogni sito diventa una
  chiamata al pezzo condiviso. Il test di registro alla fine (§6.4) impedisce
  che ne nascano di nuove.

### 1.5 «Il ruolo più basso possibile»

Il default dell'invito in una workspace è il preset **Viewer**
(`VIEW_PROJECT_PERMISSIONS`: tutti i `*.view` e `*.view_all`, nessuna
scrittura). La ragione: la workspace dà VISIBILITÀ, e Viewer è il preset che
vede senza fare. L'alternativa è **Contributor** (`docs.view`, crea ticket e
voci, commenta, carica file): fa più cose ma vede meno (nessun `tickets.view_all`).
I due non sono confrontabili; il maintainer ha scelto Viewer (D3). Il default si risolve **per
chiave di preset** (`viewer`), non per nome, nella transazione dell'invito.
Se il preset è stato eliminato, si chiede un ruolo esplicito (400
`role_required`), mai un ripiego silenzioso su un altro ruolo (stessa
dottrina di R51: «nessun ruolo» non è una scorciatoia).

### 1.6 Le invarianti di `permissions.md`, una per una

- **Nessuna escalation sul DARE** (`assertNoEscalation`). Dare a qualcuno un
  ruolo di workspace è dargli quel ruolo in **ogni** progetto della workspace:
  chi agisce deve avere i permessi del ruolo **in ognuno** di quei progetti,
  archiviati compresi (la stessa forma di `judgeDepartmentDraft` per i
  reparti). Lo stesso vale nel verso dei progetti: **mettere un progetto in una
  workspace** dà a tutte le sue persone il loro ruolo di workspace in quel
  progetto, quindi chi lo fa deve poter dare, in quel progetto, ognuno dei
  ruoli di workspace presenti, e quindi averne i permessi lì. Le persone che
  entrano in un progetto ci portano anche i permessi dei loro reparti: si
  controllano anche quelli, come fa `putProjectMember` (F8-4 = a). Un full
  admin passa sempre. UNA funzione, `judgeWorkspaceGrant`, usata dalle
  anteprime e dalle scritture.
- **Togliere non chiede niente** (togliere un progetto, una persona, cambiare
  il ruolo verso il basso), salvo i due vincoli che restano: il rifiuto su sé
  stessi dove c'è oggi, e **`last_manager`**. Un progetto non resta senza un
  `project.members.manage` fuori dai full admin, anche quando a toglierlo è la
  workspace: togliere il progetto dalla workspace, togliere una persona,
  abbassarne il ruolo, eliminare la workspace. Il controllo gira DOPO la
  modifica nella stessa transazione (come `last_full_admin`), per tutti i
  progetti toccati, e il 409 dice quali.
- **La revoca si applica a LETTURA.** Togliere una persona o un progetto
  cancella SOLO le righe `workspace_members` / `workspace_projects`. Card,
  domande, proposte, sessioni e ticket smettono di esserle visibili perché
  `notificationVisibleToRecipient` e le WHERE leggono l'appartenenza derivata,
  senza riscrivere niente. I ticket restano assegnati («assegnatario senza
  accesso», come oggi).
- **I full admin sono membri impliciti**: non compaiono in `workspace_members`
  e non serve metterceli. L'elenco delle persone di una workspace lo dice, come
  la sezione Membri.
- **Gli elenchi filtrano nella WHERE**: `visibleProjectIds` e
  `projectIdsWithPermission` danno già l'insieme giusto. L'elenco delle
  workspace stesse si filtra come i progetti (§2.3).
- **Il progetto invisibile è 404**, compreso dentro una workspace: chi vede la
  workspace ma non un suo progetto non ne riceve né id né nome (r.1414, §5.6).
- **Archiviati**: un progetto archiviato in una workspace resta legato, e si
  comporta come oggi (escluso da `visibleProjectIds`, letture `archived=true`
  ai suoi membri, ora anche per via di workspace). Riaprirlo lo ritrova nella
  sua workspace.
- **Il client non deduce**: `/api/auth/me` e `myPermissions` restano la sola
  fonte dei permessi. Per mostrare DA DOVE viene un permesso, le fonti (§5.2)
  si estendono con `workspace`, accanto a `role`, `grant` e `department`.
- **Claude** (utente di sistema): non entra in una workspace (400
  `system_user`), e anche se una riga ci fosse il pezzo SQL lo esclude, come
  per i reparti.
- **Persona disattivata**: le sue righe di workspace restano, e non entra da
  nessuna porta come oggi. Riattivarla le restituisce le workspace (coerente
  con i `project_members`, che oggi restano).

## 2. Chi crea e gestisce, chi invita

### 2.1 Permessi nuovi

| Permesso | Livello | Cosa apre | Preset |
|---|---|---|---|
| `workspaces.manage` | istanza | creare, rinominare, eliminare una workspace; vederle tutte in Amministrazione | nessuno (full admin implicito) |
| — | progetto | mettere, togliere o spostare un progetto in una workspace | `project.members.manage` **nel progetto** (nei due, per uno spostamento) + `workspaces.manage` |
| — | progetto, su ogni progetto | invitare una persona in una workspace, cambiarne il ruolo di workspace, toglierla | `project.members.manage` **in ogni progetto** della workspace (+ anti-escalation) |

- **Struttura** (creare, rinominare, eliminare, spostare progetti) =
  `workspaces.manage`, un permesso d'istanza nuovo, dato a nessun preset (la
  regola: un permesso nuovo non è dato a nessun ruolo esistente salvo che la
  migrazione lo dica). Mettere, togliere o spostare un progetto chiede
  **anche** `project.members.manage` in quel progetto (D4): cambia chi lo vede,
  e chi gestisce la struttura non deve poter tirare dentro un progetto di cui
  non gestisce i membri. Uno spostamento è UNA scrittura (la riga cambia
  workspace, l'indice unico lo garantisce) e chiede il permesso in entrambi i
  lati.
- **Persone** (invitare, cambiare ruolo, togliere) = `project.members.manage`
  **in ogni progetto** della workspace, più l'anti-escalation (§1.6). Non serve
  un permesso «gestore di workspace» nuovo: entrare in una workspace È entrare
  nei suoi progetti, e chi gestisce i membri di tutti quei progetti può già
  oggi aggiungere la persona uno per uno. Il permesso nuovo darebbe un
  potere che oggi non esiste (D4: niente gestori per workspace).
- Una workspace **vuota** (senza progetti) la gestisce solo chi ha
  `workspaces.manage`: «in ogni progetto» su un insieme vuoto sarebbe vero per
  chiunque.

### 2.2 Le azioni (rotte nuove, tutte con `config.access` e `config.mcp`)

| Rotta | Access | Riconferma | MCP |
|---|---|---|---|
| `GET /api/workspaces` | `user` | — | `workspaces.list`, read |
| `GET /api/workspaces/:id` | `user` (404 se non la vede) | — | `workspaces.get`, read |
| `POST /api/workspaces` | `instance: workspaces.manage` | — | `workspaces.create`, write |
| `PATCH /api/workspaces/:id` | `instance: workspaces.manage` | — | `workspaces.update`, write |
| `DELETE /api/workspaces/:id` | `instance: workspaces.manage` | — | `workspaces.delete`, destructive |
| `PUT /api/workspaces/:id/projects/:projectId` | `instance` + controllo nel servizio | — | `workspaces.addProject`, write, nota «cambia chi vede il progetto» |
| `DELETE /api/workspaces/:id/projects/:projectId` | idem | — | `workspaces.removeProject`, destructive |
| `POST /api/workspaces/:id/members/preview` | `user` | — | `workspaces.memberPreview`, write (non scrive) |
| `PUT /api/workspaces/:id/members/:userId` | `user` + controllo nel servizio | **sì** (dà permessi) | escluso: `reauth` |
| `DELETE /api/workspaces/:id/members/:userId` | idem | — | `workspaces.removeMember`, destructive |
| `POST /api/invites` (esistente) | invariato | invariato | invariato, con `workspaces` nel body |

- La riconferma segue la regola F8-3 dei reparti: la chiede **solo** una
  scrittura che fa arrivare permessi a qualcuno, cioè aggiungere una persona o
  alzarne il ruolo. Togliere, spostare la struttura e abbassare non la chiedono.
  Mettere un progetto in una workspace dà permessi alle sue persone, quindi la
  chiede per la stessa regola (D11): anche `workspaces.addProject` è
  un'esclusione `reauth` dell'MCP, come la creazione di una workspace con dei
  progetti quando ha già persone.
- L'anteprima (`/members/preview`) dice, per ogni progetto della workspace,
  cosa la persona guadagnerebbe e da quale fonte. È la stessa forma di
  `projects.memberPreview` e serve al prototipo per il foglio dell'invito.
- **L'effetto di un cambio di struttura** (il nome lo sceglie la shape di 79,
  `workspaceAccessEffect`): `POST /api/workspaces/effect`, che non scrive niente
  (`effect: "write"` nell'MCP come le altre anteprime). Per un'operazione
  (`add` / `remove` / `move` di un progetto, `delete` di una workspace,
  `removeMember`) restituisce, per progetto, **chi comincia a vederlo** e **chi
  smette**, calcolati con la stessa vista `project_access` prima e dopo:
  ```
  { projects: [{ projectId, startSeeing: PersonRef[], stopSeeing: PersonRef[] }],
    lastManager: projectId[],    -- dove la scrittura darebbe 409 last_manager
    escalation: { projectId, permission }[] }   -- dove darebbe 403 escalation
  ```
  - chi è membro esplicito o full admin non compare in `stopSeeing`, perché
    continua a vedere;
  - le persone sono quelle che chi agisce conosce (i segnaposto r.1414 non
    servono: chi gestisce i membri di un progetto conosce chi lo vede);
  - la scrittura RIFÀ gli stessi controlli: l'anteprima informa, non autorizza.
- **La fonte di un permesso**: nelle fonti che il server già espone (l'unione
  `role` / `grant` / `department` di `departmentGrantsOf`, «Chi può farlo?»,
  la pagina della persona) si aggiunge `{ kind: "workspace", workspaceId,
  workspaceName, roleId }`. È il `PermissionSource` del renderer: un valore in
  più di un'unione, additivo.

### 2.3 Chi vede una workspace

- Chi ha `workspaces.manage` (e il full admin): tutte.
- Gli altri: le workspace in cui è membro **più** quelle che contengono almeno
  un progetto che vede (D5). Una workspace che non vede non compare, nemmeno nel
  numero.
- Di una workspace vista, la persona vede il nome, **solo i progetti che vede**
  (mai l'id né il nome degli altri, r.1414) e le sue persone. Queste sono già
  «conosciute», perché vedono tutti i progetti della workspace, quindi anche
  quello che vede chi guarda (§5.6).
- Un membro di una workspace **senza progetti** ne vede le persone, che non
  conosce per via di un progetto condiviso. È l'unica fonte nuova di «chi si
  conosce» (`peopleKnownTo` la aggiunge), ed è limitata a chi la workspace
  l'ha ricevuta da chi la gestisce.

## 3. L'invito

Due strade, la stessa regola:

1. **Persona già nell'istanza**: `PUT /api/workspaces/:id/members/:userId`, con
   la riconferma, l'anti-escalation su ogni progetto e la card `member.added`
   (§5.4). Nessun invito di registrazione.
2. **Esterno**: passa dall'**invito di registrazione esistente**
   (`POST /api/invites`), che oggi promette dei progetti (`invite_projects`).
   Si aggiunge `invite_workspaces` (workspace + ruolo). All'accettazione la
   promessa **si riverifica coi permessi ATTUALI dell'invitante** (R51,
   `applyInviteGrants`): una workspace in cui non potrebbe più dare quel ruolo
   in ogni progetto si scarta con una riga di log, e l'utente nasce lo stesso.
   Il ruolo d'istanza resta quello dell'invito (`User` se assente). Invitare
   chiede già `users.invite`; in più servono i permessi di §2.1 sulla workspace.

Un invito a una workspace dà la visibilità sui progetti che la workspace
contiene **al momento della lettura**, non a quello dell'invito: un progetto
aggiunto dopo arriva da solo, uno tolto sparisce (§4). È il senso di «raggruppare
per visibilità».

## 4. La revoca

- **Togliere un progetto dalla workspace** (o eliminare la workspace):
  - le persone che lo vedevano SOLO per la workspace lo perdono, a lettura;
  - chi ne è membro esplicito (override) resta membro, col suo ruolo di progetto;
  - i permessi dei reparti seguono l'appartenenza: chi non è più membro non li ha più lì;
  - `last_manager` blocca se il progetto resterebbe senza
    `project.members.manage` fuori dai full admin (409, con l'elenco);
  - i ticket restano assegnati («assegnatario senza accesso»), le card restano in tabella e non si vedono più.
- **Togliere una persona dalla workspace**: perde tutti i progetti della
  workspace in cui non è membro esplicito. **Gli override restano**: sono
  appartenenze esplicite, date per un progetto. Il foglio della rimozione li
  elenca e propone di toglierli insieme, con la casella «togli anche dai
  progetti» spenta per default (D12): un override può essere stato dato prima
  della workspace, per un motivo suo.
- **Eliminare una workspace**: i progetti restano, senza workspace; le persone
  perdono l'appartenenza derivata; le righe di invito pendenti (`invite_workspaces`)
  cadono in cascata. Il server non la rifiuta se ha progetti (la shape chiederà
  conferma), ma `last_manager` vale su tutti i progetti toccati.
- **Eliminare un ruolo usato da una workspace**: 409 `role_in_use`, che conta
  anche `workspace_members`.
- **Una revoca non scrive niente fuori dalle tabelle di workspace**: nessuna
  riscrittura di `notifications`, follow o assegnazioni.

## 5. Le superfici che cambiano

### 5.1 Inventario dei lettori di `project_members` (prima del codice)

Da completare con l'elenco dei siti (§ in fondo, «Inventario»): ogni query che
decide visibilità, permessi o destinatari unendo `project_members` a mano
passa dal pezzo condiviso. I siti di sola gestione (la sezione Members, le
scritture di `putProjectMember`) restano su `project_members`, perché lì
«membro» vuol dire «membro esplicito».

### 5.2 Progetti, People, Amministrazione

- **Progetti** (colonna di sinistra): `GET /api/workspaces` dà l'elenco visto
  da chi guarda, con i soli progetti che vede (gli id, che il client unisce a
  `GET /api/projects`). Un gruppo «Senza workspace» lo calcola il client dai
  progetti che non stanno in nessuna workspace vista.
- **Members di un progetto**: le persone che vedono il progetto per via di
  workspace compaiono con la fonte `workspace` (nome della workspace, ruolo di
  workspace), separate dai membri espliciti. Non si tolgono da lì: si tolgono
  dalla workspace, o si aggiunge un override.
- **«Chi può farlo?»** e le fonti di un permesso (`departmentGrantsOf`, la
  pagina della persona, l'anteprima del membro): fonte nuova `workspace`,
  accanto a `role`, `grant` e `department`. Il test d'accordo `who-can` ↔ `can()`
  si estende al caso workspace.
- **People → persona**: le sue workspace, col ruolo.
- **Amministrazione → Workspace** (con `workspaces.manage`), o una sezione
  della pagina Progetti: lo decide la shape di 79.

### 5.3 Registro delle modifiche

Tipi nuovi, con `readPermission` come gli altri: `workspace.created`,
`workspace.renamed`, `workspace.deleted`, `workspace.project_added`,
`workspace.project_removed`, `workspace.member_added`,
`workspace.member_role_changed`, `workspace.member_removed`.

- Le voci di **progetto** (`project_added` / `project_removed`) si scrivono
  anche nel registro del progetto toccato: chi legge il registro del progetto
  vede perché sono comparse o sparite delle persone.
- Le voci di **persona** si scrivono nel registro d'istanza e si leggono con
  `workspaces.manage` o `users.manage`. La persona che non si conosce resta un
  segnaposto (r.1414).
- **«Annulla» di Claude**: `workspace.member_added` e `workspace.project_added`
  si annullano come `member.added` (togliere ciò che si è aggiunto), nella
  stessa fetta (D14).
- `scrubLogData` non ha niente da mascherare (nessun segreto).

### 5.4 Notifiche

- **Si riusa `member.added`**, senza un `notification_kind` nuovo: un kind
  nuovo rende NON sicuro scendere d'immagine sul server finché ne esistono righe
  (500 su `/api/inbox`, CLAUDE.md). La card dice «sei entrato nella workspace
  X», con un campo additivo `workspaceId` nell'evento (nullable, default null)
  e i progetti **derivati a lettura**, non scritti nel jsonb (la regola delle
  card). Alla persona (obbligatoria) e a chi gestisce i membri, mai a chi ha
  agito, come oggi.
- **Un progetto aggiunto a una workspace** non manda card alle persone (una
  workspace con 30 persone farebbe 30 card per uno spostamento): lo dice il
  registro del progetto (D13).

### 5.5 MCP (parità)

Ogni rotta nuova nasce con `config.mcp` (tabella §2.2), e il test di parità lo
pretende. `workspaces.list`/`get` portano la nota r.1414 (nessun progetto
invisibile). Le rotte con la riconferma sono esclusioni `reauth`, come oggi.
Le descrizioni dicono che aggiungere una persona o un progetto **cambia chi
vede i progetti**, e che l'MCP lo annuncia all'utente nella riga dell'azione
(come «Cambia cosa possono fare altre persone»). Un changeset per
`@stubwise/mcp` se cambiano tool curati (no, se tutto passa dal catalogo).

### 5.6 La visibilità r.1414

- Una workspace vista per un solo progetto non rivela gli altri progetti né le
  persone (§2.3).
- `GET /api/workspaces/:id` per chi non la vede: 404, come un progetto.
- Le persone di una workspace sono «conosciute» da chi ne è membro? Oggi
  «chi si conosce» passa dai progetti condivisi (`projectViewerIds`): con
  l'appartenenza derivata due persone della stessa workspace condividono i suoi
  progetti, quindi si conoscono **per costruzione**, senza una regola nuova. Una
  workspace senza progetti non fa conoscere nessuno.

### 5.7 Il worker

Il worker legge la visibilità da `packages/notifications` (destinatari delle
card, `notificationVisibleToRecipient`, `projectViewerIds`): si aggiorna
insieme al server, nello stesso rilascio, perché la regola è condivisa. Nessun
job nuovo.

## 6. Migrazione, rilascio, rollback

### 6.1 La migrazione (0238)

- Crea le tre tabelle più `invite_workspaces`, il permesso `workspaces.manage`
  (nel catalogo, nel codice: nessun dato) e **nessuna** riga di dati: nessuna
  workspace nasce da sola (D15).
- Nessun `ALTER TYPE ... ADD VALUE` (i tipi del registro sono testo).
- Tutto additivo: nessuna colonna rinominata o tolta.

### 6.2 L'ordine del rilascio

1. `server`: applica la 0238; healthy.
2. `worker`: la regola condivisa (`packages/notifications`) lo vuole aggiornato
   insieme, prima che esista una workspace con persone. Finché non ce n'è
   nessuna il comportamento è identico.
3. `caddy`: il renderer di `/app` con la colonna delle workspace.
4. `@stubwise/mcp`: solo se cambiano tool curati.

### 6.3 Rollback

- **Prima che esista una workspace**: sicuro scendere tutto. Le tabelle vuote
  restano e il codice vecchio non le nomina.
- **Con workspace in uso**: scendere il server è **sicuro per i dati** ma
  **toglie l'accesso**. Il codice vecchio non conosce l'appartenenza derivata,
  quindi chi vedeva un progetto solo per la workspace smette di vederlo, e
  tornano visibili solo i membri espliciti. Nessuna riga si perde: risalendo
  torna tutto. Va scritto nella voce del deploy-log, insieme alla query che
  conta chi resterebbe senza accesso:
  ```sql
  select count(distinct (wm.user_id, wp.project_id)) from workspace_members wm
  join workspace_projects wp on wp.workspace_id = wm.workspace_id
  left join project_members pm on pm.project_id = wp.project_id and pm.user_id = wm.user_id
  where pm.user_id is null;
  ```
- Il caddy scende insieme al server (la regola ricorrente). Il worker scende
  insieme al server: un worker vecchio con un server nuovo consegnerebbe meno
  card di quante l'inbox ne mostri.
- Nessun `notification_kind` nuovo (§5.4): la discesa non rompe `/api/inbox`.

### 6.4 I test che reggono il modello

- **A due utenti sugli stessi dati**, per ogni elenco toccato: membro di
  workspace e non membro (la regola degli elenchi).
- **Unione delle fonti**: Viewer di workspace + Developer di progetto + un
  permesso di reparto dà l'unione; un override più basso non toglie niente.
- **Negativi**: escalation su un progetto su tre (403 `escalation`, DB
  invariato); `last_manager` togliendo progetto, persona, ruolo o workspace;
  progetto invisibile dentro una workspace visibile (né id né nome); Claude
  rifiutato; invito riverificato all'accettazione.
- **Revoca a lettura**: card, ticket e sessioni spariscono togliendo la riga, e
  nessun'altra tabella cambia.
- **Registro dei lettori**: un test che fallisce se una query nuova unisce
  `project_members` per decidere visibilità fuori dal modulo condiviso (sul
  sorgente, con un elenco chiuso dei siti di sola gestione), come
  `vault-isolation.test.ts`.

## 7. Decisioni (27 nov 2026)

Il maintainer ha accettato tutte le raccomandazioni. Numeri come nella shape di
79 (`apps/desktop/.impeccable/shape/workspaces.md`): D1–D10 sono comuni, D11–D19
vengono dal lato server.

- **D1.** L'override per progetto **aggiunge soltanto**: il permesso effettivo è
  l'unione delle fonti. Per far vedere meno si toglie il progetto dalla
  workspace o si abbassa il ruolo di workspace.
- **D2.** Un progetto sta in **al più una** workspace (indice unico su
  `workspace_projects.project_id`).
- **D3.** Il ruolo di base di un invito in workspace è **Viewer**, risolto per
  chiave di preset.
- **D4.** La struttura richiede **`workspaces.manage`** (permesso d'istanza nuovo,
  implicito nel full admin, in nessun altro preset). Mettere, togliere o spostare
  un progetto richiede anche `project.members.manage` in quel progetto (nei due,
  per uno spostamento). Invitare richiede `project.members.manage` e
  l'anti-escalation in ogni progetto della workspace. Niente gestori per
  workspace.
- **D5.** Una workspace la vede chi ne vede almeno un progetto (con il conteggio
  dei soli visibili) o ne è membro; le sue persone sono «conosciute» da chi la
  vede.
- **D6.** Un progetto archiviato **resta** nella sua workspace, e riaprendolo
  torna dov'era.
- **D7.** «No workspace» è un posto legittimo: nessun progetto deve stare in una
  workspace.
- **D8.** Le workspace come filtro fuori da All projects sono **rimandate** (nel
  registro dei rimandi).
- **D9.** Un esterno si invita in una workspace dall'invito di registrazione
  esistente (`invite_workspaces`), con la riverifica R51.
- **D10.** I permessi in più di un reparto valgono anche nei progetti visti dalla
  workspace. Si aggiorna F8-1 in `permissions.md`.
- **D11.** Mettere un progetto in una workspace, o creare una workspace con dei
  progetti quando ha già persone, **chiede la riconferma**.
- **D12.** Togliendo una persona dalla workspace i suoi override **restano**; il
  foglio propone di toglierli con una casella spenta per default.
- **D13.** Un progetto aggiunto a una workspace **non** manda card: lo dice il
  registro del progetto.
- **D14.** «Annulla» di Claude vale per entrare in una workspace e per mettere un
  progetto, nella stessa fetta.
- **D15.** **Nessuna** workspace iniziale.
- **D16.** La cassaforte conta il ruolo di workspace come ruolo di progetto, e la
  condivisione a un ruolo dice quante persone raggiunge per via di workspace.
- **D17.** Posta e calendario contano le persone di workspace come membri; gli
  admin impliciti restano esclusi dove lo sono oggi. Si aggiorna
  `mail-calendar.md`.
- **D18.** Chi ha `project.members.manage` per via di workspace **conta** come
  gestore per `last_manager`.
- **D19.** Un progetto eliminato ricorda anche chi lo vedeva per workspace
  (`deleted_project_members`).

## Inventario dei lettori di `project_members` (27 nov 2026, su origin/main)

Categorie: (A) funzioni centrali; (B) query che uniscono `project_members` a
mano per decidere visibilità, permessi o destinatari; (C) scritture e gestione;
(D) solo visualizzazione. Con la vista `project_access`, (A) e (B) passano alla
vista, mentre (C) e (D) restano su `project_members` («membro esplicito»).

**(A) 9 funzioni centrali**:
- `memberPermissionsSql` (`packages/db/src/member-permissions.ts`);
- in `apps/server/src/auth/access.ts`: `projectPermissionsFor`,
  `projectIdsWithPermission`, `visibleProjectIds`, `projectPermissionsMap`;
- in `packages/notifications/src/project-access.ts`:
  `projectPermissionsByProject` (dietro `projectPermissionsOfUser`,
  `cardPermissions`, `automationOwnerInScope`), `projectViewerIds`,
  `projectViewerIdsByProject`, `userIdsWithPermission`;
- `visiblePersonIds` (`services/people-visibility.ts`).

**(B) 28 query a mano** (le insidiose):
- Visibilità delle card: `notificationVisibleToRecipient` e
  `catalogPermissionVisible` (`packages/notifications/src/inbox-visibility.ts`),
  `folderLinkExpiredSql` (`drive-folder-link.ts`).
- Automazioni: `loadPlanWorld` (`automation-world.ts`) e la sua copia
  `contextParts` (`automations/examples.ts`).
- Inbox: `withoutStrangers` e `automationCardsFor` (`services/inbox.ts`).
- Persone e destinatari:
  - `canReceive` (`user-deactivation.ts`);
  - `managedProjectIds` e `openTasksOf` (`admin-people.ts`);
  - `peopleKnownTo` (`people-known.ts`, due punti);
  - l'elenco utenti (`routes/users.ts`);
  - `suggestRecipients` (`mail-recipients.ts`);
  - `effectiveMemberIds` (`routes/projects.ts`).
- Cassaforte: `effectiveReaderCondition` (`vault/readers.ts`), `readersView`
  e `targetPeople` (`vault/sharing.ts`). Vedi D16.
- Ruoli e permessi:
  - `actorProjectPermissions`, `managerCount` e `lastManagerProjectOf`
    (`services/roles.ts`);
  - `memberships` e `viewerLosesIf` (`access-query.ts`);
  - `judgeDepartmentDraft` (`department-access.ts`);
  - le due query «chi resta gestore» di `routes/departments.ts` (modifica ed
    eliminazione);
  - `previewMember` (`admin-roles.ts`).
- Worker, Google: `loadCandidateProjects` (`classify-v2.ts`, due punti),
  `attendeeProjects` (`calendar-guess.ts`), `inviteesOfAny`
  (`calendar-shared.ts`). Vedi D17.

**(C) 11 scritture e gestione**:
- in `roles.ts`: `putProjectMember`, `removeProjectMember`, `lockedMember`,
  `applyInviteGrants`, `deleteUser`, `projectsOfRole` (deve contare anche
  `workspace_members` per `role_in_use`), `isLastActiveFullAdmin`;
- altrove:
  - la creazione del progetto, che inserisce il creatore come lead;
  - `confirmMailProposalWithMembers`;
  - `lockLoggedSubjects` dell'«Annulla» di Claude;
  - `deleteArchivedProject`, che deve copiare in `deleted_project_members`
    anche chi lo vedeva per workspace (D19), così la memoria «chi lo
    conosceva» resta vera.

**(D) 7 solo visualizzazione**:
- `membersWithPermissions` e `listProjectMembers` (`roles.ts`);
- `adminRoleViews` e `membersOf` (`admin-roles.ts`);
- `listPeopleRows` e `personDetail` (`admin-people.ts`);
- `archivedProjectView`;
- `actionLabels`.

Queste aggiungono la fonte `workspace` dove mostrano chi vede un progetto
(§5.2).

**Copie della stessa regola da riunire nello stesso lavoro**:
- «membro o full admin» compare tre volte: `notificationVisibleToRecipient`,
  `projectViewerIds` e `canReceive`;
- `userIdsWithPermission` è riscritta come EXISTS due volte:
  `catalogPermissionVisible` e `folderLinkExpiredSql`;
- `loadPlanWorld` è copiata in `examples.ts`.

Con la vista diventano un cambio meccanico. Unificarle è un'occasione, non un
requisito.
