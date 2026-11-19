# Integrazione area 9, F8 — i permessi di progetto dei reparti: piano

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md`, «F8 — i
> permessi di progetto dei reparti (D-1)» e la [DECIDE] **E-3**. Specifica
> dell'app: il prototipo, `apps/desktop/src/renderer/data/admin/departments.ts`
> (le scritture e `judgeDraft`, l'unica regola dell'escalation), `data/access/`
> (`effectiveCore.ts`: la fonte `department`), `pages/admin/DepartmentsPage.tsx`
> e `DepartmentPanel.tsx`. Invarianti: `docs/invariants/permissions.md`
> («nessuna escalation sul DARE», «I permessi effettivi in un progetto sono UNA
> funzione», «il client legge i permessi calcolati dal server»).
> Registro dei rimandi: «Permessi di progetto dati da un reparto
> (`department-permissions`)». Branch: renderer `feat/area9-f8-renderer`, server
> `feat/area9-f8`, entrambi da `feat/integrazione-area9`.
>
> **Questo file ha la parte del RENDERER (94).** La parte del server la scrive
> 72 sotto, nella sezione «Lato server».

## Cosa c'è già nell'app

- Amministrazione → Departments è accesa da F1 (nome, colore, persone, chi
  gestisce la Home del reparto). L'adattatore (`data/backend/real/departments.ts`)
  manda `projectPermissions: []`, `notGivable: []`, `missingToAdd: {}`, `reach:
  "projects"`, e `previewDepartment` risponde vuoto.
- La parte «Permessi di progetto» del pannello del reparto e la frase «gives …»
  della riga dell'elenco sono dietro la funzione **`department-permissions`**,
  spenta (`DepartmentPanel.tsx:306`, `DepartmentsPage.tsx:162`).
- Le fonti `department` sono già nei tipi e negli adattatori che le leggerebbero:
  `adminPeople.ts` (le fonti dei permessi di un membro, Members e la pagina della
  persona) e `whoCan.ts` («Chi può farlo?», `{ kind: "department",
  departmentName }`). Oggi il server non le manda mai.

## Le schermate (cosa si accende con F8)

1. **Amministrazione → Departments, l'elenco**: la riga di un reparto dice
   «gives <permessi>» (`admin.departments.gives`), coi nomi dei permessi.
2. **Il pannello del reparto**, parte «Permessi di progetto»: la tabella dei
   permessi di progetto (`PermissionTable scope="project"`), una casella per
   permesso.
   - Un permesso che chi agisce non può dare è spento col motivo
     (`giveBlock(reach, "department")`): «nei progetti dove arriva» o «in
     nessun progetto» (`reach`).
   - Il salvataggio è della bozza intera (nome, colore, persone, permessi:
     `saveDepartment`), con la riconferma (vedi E-3).
   - Il rifiuto che arriva dopo (un altro ha cambiato qualcosa) è in parole:
     `escalation` coi permessi mancanti, `last_members_manager`.
3. **Il pannello del reparto**, «Add people»: chi riceverebbe, entrando, un
   permesso che chi agisce non ha nei progetti di quella persona è spento col
   motivo (`missingToAdd[personId]`).
4. **Progetto → Settings → Members** e **la pagina della persona**: la fonte
   «from <reparto>» accanto al permesso (`sources: [{ kind: "department",
   departmentId }]`), come «from role» e «given by».
5. **«Chi può farlo?»**: il motivo «via <reparto>».
6. **Registro delle modifiche**: `department.permissions_changed`, col prima e
   dopo (l'insieme dei permessi), nel gruppo `departments`.

Nessuna schermata nuova: tutte ci sono nel prototipo e nell'app, e F8 le
accende.

## La funzione da accendere

- **`department-permissions`** (feature), nello stesso commit dell'adattatore
  vero, con `INTEGRATED_CALLS` in `ComingSoon.test.tsx` e l'elenco atteso di
  `data/integration.test.ts`. Nessun'altra sezione: Departments, Members,
  «Chi può farlo?» e il registro sono già accesi.
- Cosa NON si accende senza la sua rotta (I1): se il server non dà l'anteprima
  dell'escalation (vedi R-2), la tabella resta spenta, perché il client non
  deduce i permessi.

## Le forme che servono dal server

- **R-1 — La lettura del reparto** (`GET /api/departments`, campi additivi):
  `projectPermissions: string[]`, come lo vuole la [DECIDE] **F8-1** (una
  lista per reparto); con l'(b) di F8-1, `projectPermissions: { projectId,
  permissions[] }[]`.
- **R-2 — L'anteprima dell'escalation, calcolata dal server per chi guarda**
  (il client non deduce, invariante): per reparto, e per una BOZZA (persone e
  permessi non ancora salvati), le stesse tre cose di `judgeDraft`:
  - `notGivable: string[]`: i permessi di progetto che chi guarda non può
    mettere nel reparto (perché non li ha in tutti i progetti dove arrivano);
  - `reach: "projects" | "anywhere"`: se il reparto arriva ad almeno un
    progetto (altrimenti il motivo è «in nessun progetto»);
  - `missingToAdd: Record<userId, string[]>`: per ogni persona attiva fuori
    dal reparto, cosa riceverebbe entrando che chi guarda non ha;
  - `missing: string[]`: ciò che la bozza così com'è darebbe senza averlo
    (vuoto = si può salvare).
  Proposta: `POST /api/departments/:id/preview` con la bozza `{ memberIds,
  projectPermissions }` → quelle quattro. Un `GET` col reparto salvato non
  basta: la tabella si spegne e si accende mentre si modifica la bozza.
- **R-3 — La scrittura**: `PUT /api/departments/:id/project-permissions`
  `{ permissions }` (il design), oppure un campo `projectPermissions` nel
  salvataggio della bozza intera se il server ne ha uno. Rifiuti:
  - 403 `escalation` con `missing: string[]` (i permessi), come i ruoli;
  - 409 `last_members_manager` (togliere un permesso o una persona lascerebbe
    un progetto senza `project.members.manage` fuori dai full admin), con il
    progetto se si può dire (`projectCode`, solo se chi guarda lo vede);
  - 403 `reauth_required` (E-3);
  - 400 `invalid` con `permission` per un permesso che non è di progetto.
- **R-4 — Le persone**: aggiungere una persona a un reparto le dà i permessi
  del reparto nei suoi progetti. La rotta delle persone del reparto (già usata
  da F1) deve rifiutare con `escalation` (+ `missing`) chi riceverebbe un
  permesso che chi agisce non ha, e con `last_members_manager` chi esce
  lasciando un progetto senza gestore.
- **R-5 — Le fonti**: `sources[].kind: "department"` con `departmentId` nei
  Members e nella pagina della persona (già nello schema, F1); `department`
  con il NOME del reparto in «Chi può farlo?» (`departmentName`).
- **R-6 — Il registro**: `department.permissions_changed` con `before` e
  `after` (le liste), come il prototipo
  (`admin.test.ts`, «setDepartmentPermissions: before è l'insieme di prima,
  after quello salvato»).
- **R-7 — `/api/auth/me`**: i permessi del reparto entrano in
  `projectPermissions` (UNA funzione); il client non fa niente di nuovo.

## Le differenze di parità che mi aspetto

- **Il modello**: nel prototipo un reparto dà UNA lista di permessi di
  progetto, valida in ogni progetto di cui la persona è già membro
  (`DepartmentAccess.projectPermissions`). Il design ha una tabella per
  progetto (`department_project_permissions`, con `project_id`). Se il server
  va per progetto, il pannello del prototipo (una tabella sola) non basta: è la
  [DECIDE] F8-1.
- **La riconferma**: nel prototipo chiedono il codice tutte e tre le scritture
  dei reparti (`saveDepartment`, `setDepartmentMembers`,
  `setDepartmentPermissions` sono in `REAUTH_REQUIRED`); la E-3 (a) del design
  la chiede sui soli permessi di progetto. Se si sceglie la E-3 (a), il
  prototipo va allineato: le persone del reparto senza riconferma, salvo che
  diano permessi (F8-3).
- **Claude**: non riceve mai permessi da un reparto (R-L9, insieme fisso). Nel
  prototipo Claude non è fra le persone dei reparti; nessuna differenza attesa.
- **Un permesso dato solo dal reparto conta per chi agisce** nel prototipo
  («un permesso che Laura ha solo dal suo reparto conta, nei progetti dove
  arriva»): il server lo deve dare nello stesso calcolo dell'escalation (UNA
  funzione).
- **I nomi**: la riga «gives …» elenca i permessi coi nomi del catalogo
  condiviso; nessuna differenza attesa.

## Le fette del renderer

- **R8-1**: l'adattatore di lettura (R-1, R-5, R-6) e l'anteprima (R-2), coi
  test e i rifiuti in parole; la tabella e «Add people» sui dati veri.
- **R8-2**: le scritture (R-3, R-4) con la riconferma (E-3), e l'accensione di
  `department-permissions` con `ComingSoon` e `integration.test`.
- **R8-3**: se F8-3 è (a), il prototipo allineato (le persone del reparto
  senza riconferma, salvo i permessi); la parità in `area9-parity.md`.

## [DECIDE]

- **F8-1 — Il permesso di un reparto vale in tutti i progetti della persona, o
  per progetto?**
  - **(a) consigliata**: in tutti i progetti di cui la persona è già membro,
    come il prototipo (la specifica): una lista per reparto, una tabella nel
    pannello. Il server tiene `department_project_permissions` senza
    `project_id` (o con `project_id` null = tutti).
  - (b) per progetto, come scritto nel design: serve una UI nuova nel
    prototipo (progetti × permessi nel pannello del reparto) e il calcolo
    dell'escalation per progetto; F8 si allunga di una fetta.
- **F8-2 — Chi calcola l'anteprima dell'escalation?**
  - **(a) consigliata**: il server, con una rotta di anteprima sulla bozza
    (R-2), come i ruoli: il client legge i permessi calcolati, non li deduce.
  - (b) il client da `/api/auth/me` e dai membri dei progetti: no, rompe
    l'invariante e non vede i progetti che chi guarda non vede.
- **F8-3 — La riconferma sui reparti** (la E-3 del design).
  - **(a) consigliata**: sui permessi di progetto, e su ogni scrittura che li
    fa arrivare a qualcuno (aggiungere una persona a un reparto che ne dà);
    il resto dei reparti (nome, colore, chi gestisce la Home, togliere) senza.
  - (b) solo sui permessi di progetto (la E-3 (a) alla lettera): aggiungere
    una persona darebbe accessi senza riconferma.
  - (c) su tutte le scritture dei reparti, come il prototipo di oggi.
- **F8-4 — Un reparto che non arriva a nessun progetto.**
  - **(a) consigliata**: la tabella resta modificabile, e il motivo di un
    permesso spento è «in nessun progetto» (`reach: "anywhere"`, come il
    prototipo): i permessi arriveranno quando una persona entra in un progetto,
    e lì l'escalation la controlla l'aggiunta al progetto.
  - (b) la tabella spenta finché il reparto non ha persone in un progetto.
- **F8-5 — L'ultimo gestore del progetto via reparto.**
  - **(a) consigliata**: `last_members_manager` anche per i reparti (togliere
    un permesso o una persona), come il prototipo (`invariantRefusal`), col
    codice del progetto solo se chi guarda lo vede.
  - (b) il controllo solo sui membri del progetto: un reparto potrebbe
    lasciare un progetto senza gestore.

## Cosa F8 non fa

- I permessi d'ISTANZA dei reparti (un reparto dà solo permessi di progetto).
- Un reparto che rende membri di un progetto (mai: «non rende membri di
  niente»).
- Le azioni di Claude sui reparti (nessuna voce nel catalogo).

## Lato server

*(72, 19 nov 2026.)*

### Le decisioni prese

- **Maintainer**:
  - **F8-1 = a**: UNA lista per reparto, valida in tutti i progetti di cui
    la persona è già membro, come il prototipo;
  - **F8-3 = a**: la riconferma sui permessi del reparto E su ogni
    scrittura che li fa arrivare a qualcuno (aggiungere una persona a un
    reparto che ne dà). Rinominare, cambiare colore, la Home e togliere
    persone non la chiedono.
- **Orchestratrice (46)**: **F8-2 = a** (l'anteprima la calcola il server),
  **F8-4 = a**, **F8-5 = a**.
- Il design (`F8`, una tabella per progetto con `project_id`) è superato
  dalla F8-1: la tabella è SENZA `project_id`.

### Fatti del codice che il design non dice

- **Il calcolo dei permessi effettivi ha UN punto SQL**:
  `memberPermissionsSql` (`packages/db/src/member-permissions.ts`): ruolo ∪
  permessi personali, per un membro. Lo usano 11 punti di server,
  `@stubwise/notifications` e worker, fra cui `projectPermissionsFor`, il
  conteggio dei gestori (`managerCount`, quindi `last_manager`),
  `/api/auth/me`, «Chi può farlo?» e il routing delle notifiche. Il reparto
  entra LÌ, e tutti lo seguono senza essere toccati. È l'invariante «I
  permessi effettivi in un progetto sono UNA funzione».
- **Chi agisce vede già i suoi permessi di reparto**: `held` (i permessi
  di chi agisce nel progetto) passa da lì, quindi «un permesso che ha solo
  dal suo reparto conta» (il prototipo) è vero senza codice nuovo.
- **Le FONTI non passano da lì**: le leggono a parte
  - `admin-roles.ts` (Members),
  - `admin-people.ts` (la pagina della persona),
  - `access-query.ts` («Chi può farlo?»),
  - `roles.ts` (le bozze di un membro).
  Ognuna aggiunge la fonte `department`. `sourceViewSchema` ha già
  `departmentId`/`departmentName` (F1).
- **Il salvataggio della bozza del reparto c'è già**: `PATCH
  /api/departments/:id` scrive nome, colore e l'insieme INTERO delle persone,
  in una transazione, senza riconferma.
- **`last_manager`** si chiama così sul server (non `last_members_manager`),
  col `projectId` (`keepingManagersIn` di `roles.ts`, per più progetti
  insieme).
- Il tipo `department.permissions_changed` è già nel catalogo del registro
  (dichiarato in F2, senza scrittore).
- **Primo numero libero: 0196** (la 0195 è di F7).

### Le forme (le R-1…R-7 del renderer)

- **R-1 — `GET /api/departments`**: in più `projectPermissions: string[]`
  (default `[]`).
  - [Ruling] La lista la riceve SOLO chi ha `departments.manage`; agli
    altri arriva `[]`. L'elenco lo legge ogni persona (le task, i
    selettori), e i permessi che un reparto dà sono amministrazione.
  - `reach`/`notGivable`/`missingToAdd` NON sono nell'elenco (calcolarli
    per ogni reparto × ogni persona è caro): li dà l'anteprima (R-2),
    anche per la forma salvata.
- **R-2 — `POST /api/departments/:id/preview`** (`departments.manage`), con
  la bozza `{ memberIds, projectPermissions }`, restituisce `{ reach,
  notGivable, missingToAdd, missing }`. È `judgeDraft` del prototipo, in UN
  posto del server (`services/department-access.ts`, `judgeDepartmentDraft`),
  che la scrittura (R-3, R-4) usa tale e quale:
  - `notGivable`: i permessi di progetto che chi guarda non ha in TUTTI i
    progetti dove la bozza arriva (i progetti delle persone della bozza);
  - `reach`: `"projects"` se arriva ad almeno un progetto, altrimenti
    `"anywhere"` (F8-4 = a: la tabella resta modificabile);
  - `missingToAdd[userId]`: per ogni persona attiva e umana fuori dalla
    bozza, cosa riceverebbe entrando (o, se era fra i salvati, i soli
    permessi aggiunti) senza che chi guarda lo abbia nei SUOI progetti;
  - `missing`: ciò che la bozza così com'è darebbe senza averlo (vuoto = si
    può salvare).
  Un full admin non ha mai niente di mancante. I progetti che chi guarda non
  vede contano nel calcolo (non li ha), ma non escono per nome.
- **R-3 — La scrittura**: [Ruling] un campo `projectPermissions` facoltativo
  nel `PATCH /api/departments/:id` (la bozza intera, UNA transazione, UNA
  riconferma), non una rotta `PUT …/project-permissions` a parte (il design).
  Due strade per la stessa scrittura sono due posti da tenere d'accordo.
  - **La riconferma** (F8-3 = a): `partialReauth` sulla rotta, chiesta
    quando il corpo AGGIUNGE un permesso di progetto, oppure aggiunge una
    persona e il reparto, dopo la scrittura, dà almeno un permesso. Togliere
    permessi o persone, il nome, il colore no.
  - **I rifiuti**, prima di scrivere:
    - 403 `escalation` con `permission` (il primo) e `missing: string[]`,
      come i ruoli: è `missing` dell'anteprima;
    - 400 `invalid_permission` con `permission` (non è un permesso di
      progetto);
    - 400 `not_a_person` (Claude, o un utente di sistema, fra le persone:
      R-L9, Claude non riceve mai permessi);
    - 403 `reauth_required`;
    - 409 `last_manager` con `projectId` (e `projectCode` solo se chi guarda
      lo vede) se togliere un permesso o una persona lascia un progetto senza
      `project.members.manage` fuori dai full admin. È F8-5 = a, con
      `keepingManagersIn` sui progetti toccati, nella stessa transazione.
- **R-4 — Le persone**: le stesse regole sul `memberIds` dello stesso `PATCH`:
  - chi ENTRA passa dall'escalation (i permessi del reparto nei suoi
    progetti);
  - chi ESCE passa da `last_manager`;
  - l'eliminazione del reparto (`DELETE /api/departments/:id`) passa da
    `last_manager` sui progetti a cui arrivava.
- **R-5 — Le fonti**: `{ kind: "department", departmentId, departmentName }`
  accanto a `role` e `grant` nelle tre letture qui sopra. `departmentName`
  c'è anche in «Chi può farlo?».
- **R-6 — Il registro**: `department.permissions_changed` con `params.added`,
  `params.removed`, e `before`/`after` (l'insieme di prima e di dopo, ordinati,
  separati da virgola), come il prototipo. Lo scrive la stessa transazione.
- **R-7 — `/api/auth/me`**: niente di nuovo, i permessi del reparto entrano
  da `memberPermissionsSql`.

### Task

#### Task 1 — La tabella e il calcolo (0196)

- **0196**: `department_project_permissions` (`department_id` FK `ON DELETE
  CASCADE`, `permission` text, `granted_by_user_id` FK `SET NULL`,
  `granted_at`; PK `(department_id, permission)`). L'indice lo dà la PK. La
  CHECK sui soli permessi di progetto no: la validazione sta nel servizio (il
  catalogo cresce nel codice, non nel DB).
- `memberPermissionsSql` aggiunge `∪` i permessi dei reparti dell'utente,
  SOLO se è membro (il `case` sul ruolo resta: un non membro ha `null`), e mai
  per un utente `is_agent`.
- *Test*:
  - un permesso di reparto apre la rotta di un progetto di cui la persona è
    membro (`plans.approve`, per esempio), e uscire dal reparto la richiude;
  - in un progetto di cui NON è membro non vede niente (il reparto non rende
    membri);
  - entra in `/api/auth/me`, in `who-can` (l'accordo con `can()`) e nel
    conteggio dei gestori;
  - NEGATIVO Claude: un `is_agent` messo a mano nel reparto non riceve
    niente.
  Le suite che chiamano `memberPermissionsSql` girano tutte (la lista dei
  file nel commit).

#### Task 2 — L'anteprima (F8-2 = a)

- `judgeDepartmentDraft(db, actor, departmentId, draft)` in
  `services/department-access.ts`, sulla regola di `missingToGrant` (UN
  posto), coi permessi di chi agisce per progetto (`projectPermissionsMap`).
- `POST /api/departments/:id/preview` (registrata prima delle altre `/:id`
  con suffisso, la trappola di routing).
- *Test*: gli stessi casi di `judgeDraft` del prototipo, cioè:
  - una persona salvata tolta e rimessa;
  - un permesso che chi agisce ha solo in uno dei progetti;
  - un reparto senza progetti (`anywhere`);
  - il full admin;
  - un permesso che chi agisce ha solo dal suo reparto, che conta.

#### Task 3 — Le scritture (F8-3, F8-5)

- Il `PATCH` con `projectPermissions` e le regole sulle persone (R-3, R-4).
- `partialReauth` con la regola di F8-3, come gli altri `partialReauth`, e
  l'elenco chiuso di `route-access.test.ts`.
- `DELETE` con `last_manager`.
- La voce `department.permissions_changed`.
- *Test*:
  - per la riconferma, le quattro combinazioni: aggiungere un permesso;
    aggiungere una persona a un reparto che ne dà; aggiungere una persona a
    un reparto che non ne dà (non la chiede); togliere (non la chiede);
  - i NEGATIVI: `escalation` coi `missing`, `last_manager` per permesso,
    persona ed eliminazione, `not_a_person` per Claude, `invalid_permission`;
  - lo stato invariato dopo ogni rifiuto, e la voce del registro col prima
    e dopo.

#### Task 4 — Le fonti e l'elenco

- La fonte `department` nelle tre letture (R-5); `projectPermissions`
  nell'elenco, solo a chi gestisce (R-1).
- *Test*:
  - la fonte in Members, nella pagina della persona e in «Chi può farlo?»;
  - un permesso dato sia dal ruolo sia dal reparto ha due fonti;
  - chi non gestisce i reparti riceve `[]`;
  - il parse di una risposta di prima (senza i campi nuovi).

#### Task 5 — Invarianti, deploy-log, review

- `docs/invariants/permissions.md`: la voce «UNA funzione» col reparto, e
  «nessuna escalation sul DARE» col reparto.
- Deploy-log:
  - **server → caddy**, il worker NON va ribuildato (legge
    `memberPermissionsSql` da `@stubwise/db` buildato nella sua immagine: si
    ribuilda solo se si vuole che le sue notifiche contino i reparti; a
    decidere al rollout);
  - **rollback**: il server vecchio ignora la tabella, quindi chi aveva un
    permesso solo dal reparto lo PERDE. Va nel verso sicuro, ma un progetto
    gestito solo via reparto resta senza gestore fuori dai full admin. La
    query per trovarli va nella voce.
- Review con un revisore fresco.

### Review Focus

- Un permesso di reparto che arriva in un progetto di cui la persona NON è
  membro, o a Claude.
- Un'aggiunta di persona, o di permesso, senza la riconferma; una
  rimozione che la chiede.
- Un'escalation che passa perché chi agisce non vede un progetto della
  persona.
- Una lettura delle fonti, o di `who-can`, che non vede il reparto mentre il
  gate sì (o viceversa).
- Un progetto lasciato senza gestore da un reparto (permesso, persona,
  eliminazione).

### Cosa il server di F8 non fa

- I permessi d'istanza dei reparti, un reparto che rende membri, le azioni
  di Claude sui reparti (come sopra).
- La riconferma sul resto dei reparti (F8-3 = a).
