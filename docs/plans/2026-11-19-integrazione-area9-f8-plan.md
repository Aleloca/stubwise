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

*(72)*
