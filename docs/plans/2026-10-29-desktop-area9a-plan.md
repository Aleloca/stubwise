# App desktop, area 9a: persone e accessi — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la prima parte dell'area 9.
- Ingresso simulato: login col secondo fattore, invito, primo avvio.
- Preferenze personali: account, sicurezza, token, Claude Code, lingua e
  tema.
- La riconferma col secondo fattore.
- In Amministrazione: People con gli inviti, Departments, Roles, Change log,
  Who can?.
- La sezione Members del progetto.
- Ruoli, appartenenze, concessioni e reparti diventano **stato del livello
  dati**, letto da un calcolo unico dei permessi.

**Architecture:**
- **Il calcolo dei permessi.** Oggi vive in `data/viewer.ts` su costanti
  del seme e su una pila di `undo`. Diventa uno stato dello store,
  `access`: ruoli, appartenenze, concessioni personali, reparti con i loro
  permessi, persone con stato e secondo fattore. A leggerlo è una sola
  funzione, `effectivePermissions(personId, projectId?)`, che restituisce
  anche le **fonti** di ogni permesso. `viewerFor` e `can()` la leggono, e
  il ramo di Claude (R-L9) resta in testa con un insieme fisso.
- **Le regole pure** stanno in `domain/access/`: anti-escalation,
  l'ultimo full admin, «Chi può farlo?».
- **Il livello dati** sta in `data/admin/*`, `data/me/*` e `data/auth/*`,
  con `gate()`, `storeGeneration`, `failNext` e `resetApi` come nelle aree
  5–8.
- **Tre meccanismi trasversali** che 9b e 9c riusano:
  - il registro delle modifiche (`data/changelog/`, con
    `registerChangeTypes`);
  - la riconferma (`data/auth/reauth.ts`, dichiarata per azione);
  - i segreti mostrati una volta (`data/admin/secrets.ts`, che nessuna
    lettura raggiunge).
- Le pagine leggono solo da `data/queries.ts`.

**Tech Stack:** quello delle aree 1–8, senza dipendenze nuove. Il QR del
TOTP è un SVG generato da una funzione pura del prototipo, finto e
dichiarato tale.

**Spec:** `docs/plans/2026-10-29-desktop-area9-admin-design.md` (approvato
il 29 ott 2026). Di quel documento valgono:
- tutto ciò che «Tre piani» assegna a 9a;
- «Il principio»;
- «Anti-obiettivi»;
- «Invarianti del CLAUDE.md che quest'area tocca»;
- «Ingresso», «Preferenze personali», «Persone e accessi», «Il registro
  delle modifiche», «Permessi»;
- «Quanto è vero nel prototipo», limitatamente agli accessi;
- «Dati finti» per persone, ruoli e inviti;
- «Review Focus» 1–3 e 5.

Contesto da leggere:
- `apps/desktop/docs/area9-inventory.md`, sezioni A e B: è il perimetro;
- `docs/invariants/permissions.md` e `docs/invariants/second-factor.md`;
- sul web, `apps/web/src/routes/{team.tsx,settings/roles.tsx,settings/security.tsx,settings/access-tokens.tsx,settings/claude-code.tsx,settings/account.tsx}`,
  `apps/web/src/components/project-members-section.tsx` e
  `apps/web/src/lib/permission-groups.ts`;
- `apps/desktop/DESIGN.md`.

## Global Constraints

- **Valgono tutte le Global Constraints delle aree 2–8:**
  - nessuna rete;
  - en/it con parità;
  - temi;
  - niente monospace, salvo logo, codice, log, comandi, script, token e
    chiavi;
  - colore mai unico segnale;
  - movimento 150–250 ms, con reduced-motion;
  - pagine solo via `data/queries.ts`;
  - stati completi: caricamento, vuoto, errore con «Riprova», pieno, senza
    permessi;
  - orologio `now()` di `data/store.ts`;
  - Impeccable obbligatorio, con gli shape approvati vincolanti;
  - R-G5: nascosto e inesistente sono identici;
  - commenti in italiano.
- **Un calcolo solo.** Ogni domanda sui permessi passa da
  `effectivePermissions` / `can()`. «Chi può farlo?», Members, le regole
  anti-escalation e le pagine non hanno una seconda copia della regola.
- **Anti-escalation.** Valgono queste regole:
  - `escalation`: chi agisce non dà un ruolo, una concessione o un permesso
    di reparto che non sia nei **propri permessi effettivi** nel progetto.
    Per i ruoli d'istanza e per il contenuto di un ruolo il confronto è
    d'istanza. Contano tutti i permessi, compresi quelli locali del
    prototipo.
  - **Niente `target_above`** (maintainer, 30 ott): chi ha il permesso di
    gestione modifica chiunque, anche chi ha più permessi. Togliere un
    permesso non passa da `escalation`.
  - Il full admin contiene tutto, e conta sempre come gestore dei membri di
    ogni progetto, perché ne è membro implicito.
  - Si rifiuta anche chi modifica sé stesso (ruolo d'istanza, reset,
    disattivazione), come sul web.
- **Restano sempre** un full admin attivo e, in ogni progetto, una persona
  con `project.members.manage` oppure un full admin. Altrimenti la scrittura
  è `invalid` con un motivo in parole.
- **Claude.** I permessi di Claude sono un insieme fisso
  (`CLAUDE_PROJECT_PERMISSIONS` e `CLAUDE_INSTANCE_PERMISSIONS` costanti),
  confrontato in un test con i permessi di lavoro di R-L9. Inoltre:
  - non ha ruoli, appartenenze o reparti, e non compare in Members, People
    o inviti;
  - `departments.manage`, `instance.status.view` e `changelog.view` sono
    fra i suoi negati.
- **Permessi nuovi** (`LocalInstancePermission`, di base al preset Admin):
  - `departments.manage`;
  - `instance.status.view` (lo usa 9b);
  - `changelog.view`.

  I permessi locali oggi cablati su `key === "admin"` in `instancePermsOf`
  diventano permessi del ruolo Admin nello stato, modificabili.
- **Riconferma.**
  - Ogni funzione delicata dell'API si dichiara in
    `REAUTH_REQUIRED: ReadonlySet<ApiFnName>`.
  - Un test del registro confronta l'insieme con l'elenco delle azioni
    delicate di questo piano.
  - La finestra di grazia è `REAUTH_GRACE_MINUTES = 10`, per persona.
  - Senza riconferma valida la funzione risponde `{ ok: false, error:
    "reauth_required" }` e non cambia nulla.
  - Un PAT non la soddisfa mai (nel prototipo non esistono chiamate via
    PAT; il test lo dichiara).
- **Segreti mostrati una volta:** token, link di reset password, segreto
  TOTP e codici di backup.
  - Escono solo nel risultato della funzione che li crea.
  - Nessuna lettura, nessuna voce del registro e nessuna notifica li
    contiene.
  - Il test usa `__secretValuesForTest()` e serializza tutte le letture.
- **Registro delle modifiche:**
  - le voci sono da template i18n, con chi, quando, oggetto, prima e dopo;
  - una voce non si modifica né si cancella;
  - mai un segreto dentro, solo «sostituito»;
  - chi legge cosa: `changelog.view`, oppure il permesso che gestisce il
    tipo di voce; le voci di progetto solo per progetti visibili.
- **Prototipo.**
  - La password del seme è `stubwise` per tutti.
  - Il codice TOTP che passa è `123456`, e c'è «Simulate passkey».
  - Tutto sta nel riquadro «Prototype only» dell'8a, insieme a «Reset to
    empty instance».
  - Il «vedi come» resta. Le persone disattivate non vi compaiono.
- **Comandi.**
  - Un singolo file di test: `pnpm --filter @stubwise/desktop test --
    <file>`.
  - Prima di ogni commit: la suite desktop, `pnpm --filter
    @stubwise/desktop typecheck` e `pnpm lint` dalla radice.
  - Trailer dei commit: `Co-Authored-By: Claude Opus 5.5
    <noreply@anthropic.com>` e `Claude-Session:
    https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm`.
  - Verifica UI: `pnpm --filter @stubwise/desktop preview:web` +
    `apps/desktop/scripts/capture.mjs`, a 1440 e 1024, chiaro e scuro, en e
    it, scatti `a9a-*`.
  - Uccidere vite alla fine. Mai `pkill` su vitest.

## Review Focus

1. **Escalation per una strada laterale.** Test da fare:
   - Laura (Project Lead di ACQ) dà `release.merge` a Marco su ACQ →
     `escalation` se Laura non lo ha.
   - Laura duplica un ruolo e ci aggiunge un permesso che non ha →
     `escalation`.
   - Un admin non full mette `instance.full_admin` in un reparto o in un
     invito → `escalation`.
   - Laura aggiunge Marco al reparto Development, che porta `support.reply`:
     è ammesso solo se Laura ha `departments.manage` e quel permesso.
   - Una scrittura fatta dopo aver cambiato persona nel «vedi come» usa la
     persona nuova.

   In ogni caso si controllano lo stato invariato e la voce del registro
   assente. → Task 2, 4.
2. **Un segreto che ricompare.** Dopo ogni creazione (token, link di reset,
   TOTP, codici di backup, invito), la serializzazione di ogni lettura, del
   registro e delle notifiche non contiene il valore. → Task 3, 4, 5.
3. **L'ultimo full admin e l'ultimo gestore dei membri.** Queste azioni
   sono rifiutate con una frase:
   - disattivare l'ultimo full admin;
   - togliergli il ruolo d'istanza;
   - togliere a Laura `project.members.manage` su ACQ quando è l'unica (e
     Roberta è full admin, quindi conta);
   - lo stesso su un progetto senza full admin membri.

   → Task 2, 4.
4. **Persona disattivata con task aperte.**
   - Il dialogo elenca le task e propone il riassegnatario.
   - La persona sparisce da chi si può assegnare, dal «vedi come» e dal
     login.
   - Le sue task dicono «(deactivated)».
   - Riattivarla la rimette com'era.

   → Task 4, 9.
5. **«Chi può farlo?» diverge da `can()` o rivela.**
   - Per ogni persona, azione del catalogo e progetto del seme, la risposta
     coincide con `can()`.
   - Sara non vede progetti né persone fuori dai suoi.
   - Claude compare solo con la frase fissa.

   → Task 2, 11.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`.
Nessun codice.

- **`entry.md`:**
  - login, secondo fattore (codice, passkey, codice di backup), errori in
    parole, blocco;
  - registrazione da invito (chi invita, progetti offerti, scaduto o
    revocato);
  - primo avvio;
  - il dialogo di riconferma con l'iscrizione al volo.
- **`preferences-account.md`:** le sezioni Account (nome, email, foto,
  password, progetti seguiti, caselle Google personali), Security (app,
  passkey, codici di backup, sessioni, registro), Tokens, Claude Code,
  Language & theme.
- **`admin-people.md`:**
  - l'intelaiatura di Amministrazione, con le voci filtrate per permesso;
  - People: elenco con filtri e dettaglio della persona (ruolo d'istanza,
    progetti, reparti, identità, reset, registro della sicurezza,
    disattiva/riattiva con riassegnazione);
  - Invites;
  - Departments (nome, colore, persone, Home, permessi del reparto,
    eliminazione con spostamento).
- **`admin-roles-members.md`:**
  - Roles (istanza e progetto, preset e a mano, tabella dei permessi a
    gruppi con le frasi, duplica, elimina, chi lo ha);
  - Members del progetto (elenco con ruolo e permessi in più, la fonte di
    ogni permesso, aggiungi, togli, cambia, riga sui full admin);
  - il messaggio di ogni rifiuto (`escalation`, ultimo
    gestore).
- **`admin-audit.md`:**
  - Change log (Amministrazione e Progetto → Settings, filtri, voce con
    prima e dopo);
  - Who can? (da azione e da persona, il perché, Claude, il link «Who can?»
    accanto ai bottoni spenti, ⌘K).

### Task 1: Accessi come stato del livello dati

**Files:**
- Create:
  - `data/access/{state.ts,effective.ts,seed.ts,index.ts}`, con il test
    `data/access/effective.test.ts`;
  - `data/access/parity.fixture.ts`: generato **prima** del cambio da uno
    script di test che esegue la `can()` di oggi su ogni persona del seme ×
    ogni permesso × ogni progetto, ed è committato.
- Modify:
  - `data/viewer.ts`: `projectPermsWithGrants` :171, `buildViewer`, le
    funzioni `grant*`/`revoke*`/`resetViewerGrants` :350-425, `can()` :434,
    `canInDepartment` :454, `CLAUDE_*` :148-160, `instancePermsOf`;
  - `data/types.ts`: `LocalInstancePermission`, `Person`;
  - `data/store.ts`: `State`, `freshState`;
  - `data/seed/{grants.ts,departmentRoles.ts,people.ts}`, che diventano
    dati di `access/seed.ts`.

**Interfaces, prodotte:**

```ts
// data/access/state.ts
export interface RoleDef { id: string; key: string /* project_lead, admin, rm-1… */; scope: "instance" | "project"; name: string; preset: boolean; permissions: string[] }
export interface Membership { personId: string; projectId: string; roleId: string }
export interface PersonalGrant { personId: string; projectId: string | null /* null = istanza */; permission: string; grantedById: string | null; at: string }
export interface DepartmentAccess { departmentId: string; memberIds: string[]; homeManagerIds: string[]; projectPermissions: string[] }
export interface PersonAccess { personId: string; instanceRoleId: string; status: "active" | "deactivated"; deactivatedAt: string | null; secondFactor: { totp: boolean; passkeys: number; backupCodesLeft: number } | null }
export interface AccessState { roles: RoleDef[]; memberships: Membership[]; grants: PersonalGrant[]; departments: DepartmentAccess[]; people: PersonAccess[] }
// data/access/effective.ts
export type PermissionSource = { kind: "role"; roleId: string } | { kind: "grant"; grantedById: string | null; at: string } | { kind: "department"; departmentId: string } | { kind: "full_admin" };
export function effectivePermissions(personId: string, projectId?: string): Map<string, PermissionSource[]>;
export function isMember(personId: string, projectId: string): boolean;
export function projectRoleOf(personId: string, projectId: string): RoleDef | null;
```

Comportamento:
- `viewerFor(personId)` costruisce il `Viewer` da `effectivePermissions` a
  ogni lettura dello stato, con una cache invalidata da `storeGeneration`.
- Le firme pubbliche di oggi restano, riscritte sullo stato: `can`,
  `canInDepartment`, `projectRoleOf`, `grantProjectRole`,
  `grantProjectPermission`, `revokeProjectPermission`,
  `grantInstancePermission`, `revokeInstancePermission`, `resetViewerGrants`
  (che ora riporta lo stato al seme). Così nessun test delle aree 2–8
  cambia.
- `project.memberIds` resta il campo che le aree 2–8 leggono. Lo
  sincronizza lo stato `memberships`, con un solo scrittore.
- I permessi di reparto entrano in `effectivePermissions` solo sui progetti
  di cui la persona è già membro.
- `department.home.manage` si legge da `homeManagerIds`.

Seme:
- i preset del web, più «Release manager» (progetto: Developer +
  `release.merge`) e «Auditor» (istanza: `usage.view` + `changelog.view`);
- le concessioni di oggi (`p-matteo` `automations.manage`, `p-marco` ACQ
  `servers.operate`);
- i reparti di `departments.ts`, con le appartenenze di `people.ts` e le
  Home di `departmentRoles.ts`. Development porta `support.reply` (esempio
  del design), che nessun membro attuale perde né guadagna nei progetti
  dove già lo aveva;
- tutti con il secondo fattore, tranne Sara;
- `p-simone` disattivato da 10 giorni, con due task aperte (lo stato vive
  qui; le task restano dove sono).

Test:
- [ ] Prima di cambiare `viewer.ts`, genera `parity.fixture.ts` dalla
  `can()` di oggi e committa il generatore insieme al fixture.
- [ ] Parità: `can()` nuova = fixture per ogni persona × permesso ×
  progetto. Le uniche differenze ammesse sono elencate nel test, con il
  motivo: `support.reply` dal reparto Development, se ne aggiunge. Dove
  sono ammesse, la fonte è `department`.
- [ ] Fonti: Marco su ACQ ha `servers.operate` con fonte `grant`; Roberta
  ha `full_admin` su tutto.
- [ ] Claude, insieme fisso:
  - cambiare i permessi del preset Developer nello stato non cambia
    `can(claude, …)`;
  - Claude non ha `departments.manage`, `instance.status.view` né
    `changelog.view`.
- [ ] Permesso di reparto:
  - aggiungere Marco a Sales, con un permesso di reparto, non lo rende
    membro di nessun progetto nuovo;
  - toglierlo dal reparto toglie il permesso a lettura.
- [ ] `resetApi` riporta il seme.
- [ ] La suite intera delle aree 2–8 è verde.
- [ ] Commit `feat(desktop): accessi come stato del livello dati`.

### Task 2: Regole pure degli accessi

**Files:** Create `domain/access/{escalation.ts,guards.ts,whoCan.ts,actions.ts}`, con i test `domain/access/access.test.ts` e `whoCan.test.ts`.

**Interfaces, prodotte:**
- `checkEscalation(actor: Map<string, PermissionSource[]>, wanted: readonly string[]): { ok: true } | { ok: false; error: "escalation"; missing: string[] }`
- `lastFullAdminBlock(state: AccessState, change: { personId: string; losesFullAdmin: boolean }): null | "last_full_admin"`
- `lastMembersManagerBlock(state, projectId, change): null | "last_members_manager"`. Conta chi ha `project.members.manage` nel progetto da qualunque fonte, full admin compresi.
- `ACTIONS: readonly { id: string; permission: string; scope: "project" | "instance"; labelKey: string }[]`, il catalogo in parole di «Chi può farlo?». Contiene almeno: approvare un piano, mandare in produzione, avviare la correzione di un server, gestire gli accessi SSH, gestire i membri, rispondere ai clienti, pianificare le task altrui, gestire le automazioni.
- `whoCan(viewerId: string, actionId: string, projectId: string | null): { visible: false } | { visible: true; people: { personId: string; sources: PermissionSource[] }[]; claude: { allowed: boolean } }`
  - Usa `can()` e `effectivePermissions`.
  - Elenca solo le persone attive che chi guarda vede: chi condivide con
    lui almeno un progetto visibile, più i full admin.
  - Un progetto invisibile restituisce `{ visible: false }`.
- `whatCan(viewerId, personId, projectId): { visible: false } | { visible: true; groups: { groupKey: string; permissions: { permission: string; sources: PermissionSource[] }[] }[] }`

Test:
- [ ] `checkEscalation`:
  - Laura → `release.merge` su ACQ: `missing: ["release.merge"]`;
  - Roberta → qualunque permesso: `ok`;
  - un permesso locale (`drive.manage`) conta come gli altri.
- [ ] Senza gerarchia: Laura toglie `servers.operate` a Marco su ACQ → ok;
  dà `servers.operate` a Federico → `escalation`.
- [ ] Ultimo full admin e ultimo gestore:
  - con Roberta sola full admin, togliere il ruolo o disattivarla →
    `last_full_admin`;
  - con due full admin → `null`;
  - `lastMembersManagerBlock` sul progetto di Laura senza full admin membri
    → blocco.
- [ ] RF 5, parità: per ogni persona del seme × `ACTIONS` × progetto,
  l'insieme di `whoCan(roberta, …).people` è uguale alle persone attive per
  cui `can()` è vero.
- [ ] Sara: `whoCan("p-sara", …, progettoNonSuo)` → `{ visible: false }`.
  Su un suo progetto non compaiono persone che Sara non vede.
- [ ] Claude: `claude.allowed` falso per «approvare un piano» e vero per
  «avviare un run».
- [ ] Commit `feat(desktop): regole pure degli accessi`.

### Task 3: Registro delle modifiche, riconferma, segreti

**Files:**
- Create:
  - `data/changelog/{types.ts,record.ts,reads.ts,index.ts}`;
  - `data/auth/reauth.ts`;
  - `data/admin/secrets.ts`;
  - i test `data/changelog/changelog.test.ts` e `data/auth/reauth.test.ts`.
- Modify: `data/store.ts` (`State.changelog`, `reauth: Map<personId, string /* ISO */>`, `ApiFnName`), `data/api.ts`, `data/queries.ts`. Create `data/queries/admin.ts`.

**Interfaces, prodotte:**
- `registerChangeTypes(types: readonly { kind: string; templateKey: string; readPermission: string /* chi legge la voce oltre a changelog.view */; scope: "instance" | "project" }[]): void`. È il punto d'estensione per 9b e 9c.
- `recordChange(entry: { kind: string; actorId: string; projectId: string | null; object: { type: string; id: string; label: string }; before?: string | null; after?: string | null; params?: Record<string, string> }): void`. Si chiama **dentro** la scrittura, solo a scrittura riuscita.
- `listChanges(filter: { personId?: string; projectId?: string; kind?: string; from?: string; to?: string }): ChangeEntryView[]`. Restituisce le voci leggibili da chi guarda, più recenti prima.
- `listProjectChanges(projectId, filter)`: per `project.settings.manage` o `project.members.manage`; per gli altri, `not_found`/`forbidden` secondo R-G5.
- `REAUTH_REQUIRED: ReadonlySet<ApiFnName>`.
- `requireReauth(me: string, fn: ApiFnName): null | "reauth_required"`.
- `reauthenticate(input: { method: "totp"; code: string } | { method: "passkey" } | { method: "backup_code"; code: string }): { ok: true } | { ok: false; error: "invalid_code" | "locked" | "no_second_factor" }`.
- `enrollDuringReauth()`: per chi non ha un secondo fattore. Restituisce il setup TOTP del Task 5.
- `secrets.ts`:
  - `storeSecret(kind: "pat" | "reset_link" | "totp_seed" | "backup_codes" | "invite_link", ownerId: string): { id: string; value: string }`;
  - `revealOnce(id)`;
  - `forgetSecret(id)`;
  - `__secretValuesForTest()`.
  - Lo importano solo `data/admin/*`, `data/me/*` e `data/auth/*` (test architetturale come `architecture.servers.test.ts`).

Test:
- [ ] Una voce di 9a passa da un tipo registrato. Un tipo non registrato
  lancia un errore.
- [ ] Chi legge cosa:
  - l'Auditor (persona di test con quel ruolo) legge tutte le voci
    d'istanza;
  - Laura legge solo le voci dei progetti dove ha
    `project.settings.manage` o `project.members.manage`;
  - Sara non legge niente;
  - una voce di AUD non compare a chi non vede AUD.
- [ ] Una voce non ha API per modificarla o cancellarla: test sui nomi
  esportati.
- [ ] Riconferma:
  - una funzione in `REAUTH_REQUIRED` senza riconferma →
    `reauth_required` e stato invariato;
  - con il codice `123456` → passa;
  - dopo 10 minuti esatti di `now()` passa ancora, dopo 10:01 no;
  - cambiare persona e tornare la ritrova; per l'altra persona non vale;
  - 5 codici sbagliati → `locked`, come `second-factor.md`.
- [ ] Registro: l'insieme `REAUTH_REQUIRED` è uguale all'elenco scritto nel
  test, cioè le funzioni marcate «+ riconferma» nei Task 4–5.
- [ ] Architettura: `secrets.ts` non è importato da `data/queries/*` né da
  `pages/*`.
- [ ] Commit `feat(desktop): registro delle modifiche, riconferma e segreti`.

### Task 4: Amministrazione — livello dati

**Files:**
- Create: `data/admin/{people.ts,invites.ts,roles.ts,departments.ts,members.ts,changeTypes.ts,index.ts}`, con i test `data/admin/admin.test.ts` e `members.test.ts`.
- Modify: `data/api.ts`, `data/queries/admin.ts`, `data/store.ts` (`ApiFnName`, `State.invites`), `data/seed/notifications.ts` (`security.alert`, kind già del web).

**Regole valide per tutte le scritture:**
- passano da `checkEscalation`, `checkTarget` e i blocchi del Task 2;
- scrivono la voce del registro;
- quelle marcate **+R** sono in `REAUTH_REQUIRED`.

**Interfaces, prodotte:**
- **People:**
  - `listPeople(filter)`, letto da tutti: `{ personId; name; email; avatar; instanceRole; departments; projects: { code; role }[]; status: "active" | "invited" | "deactivated" }[]`. I progetti sono filtrati su quelli visibili a chi guarda.
  - `getPerson(id)`
  - `setInstanceRole(personId, roleId)` (`users.manage`, **+R**, mai su sé)
  - `createPasswordResetLink(personId)` (**+R**): `{ link }` una volta
  - `resetSecondFactor(personId)` (**+R**): pubblica `security.alert` all'interessato
  - `listSecurityEvents(personId)` (`users.manage`)
  - `linkGitIdentity` / `unlinkGitIdentity` (**+R** per scollegare un'email), `setBitbucketUsername`. Riusano gli autori osservati di Activity (area 3).
  - `deactivatePerson(personId, reassignTo: Record<taskId, personId | null>)` (**+R**)
  - `reactivatePerson(personId)`
- **Invites:**
  - `listInvites()` (`users.invite`)
  - `createInvite({ email; instanceRoleId; projects: { projectId; roleId }[] })` (**+R**): `{ link }` una volta. I progetti ammessi sono quelli dove chi invita ha `project.members.manage`.
  - `revokeInvite(id)`
  - Il seme ha 2 inviti, uno scaduto.
- **Roles:**
  - `listRoles()`: ogni ruolo con il numero di persone.
  - `createRole`, `updateRole`, `duplicateRole`, `deleteRole` (`roles.manage`, **+R**).
  - `deleteRole` su un preset → `invalid: "preset"`; su un ruolo in uso → `invalid: "in_use"` con l'elenco.
  - Il contenuto passa da `checkEscalation`.
- **Departments:**
  - `createDepartment`, `updateDepartment` (nome, `colorToken` della palette)
  - `setDepartmentMembers`, `setHomeManagers`, `setDepartmentPermissions` (**+R**)
  - `deleteDepartment(id, moveTasksTo: string | null)`
  - Tutto con `departments.manage`.
- **Members:**
  - `listProjectMembers(projectId)`, per i membri: `{ personId; role: RoleDef; extra: { permission; sources }[] }[]`, più `fullAdminNote: true`. Né Claude né i full admin compaiono fra le righe.
  - `addMember`, `removeMember`, `setMemberRole`, `grantMemberPermission`, `revokeMemberPermission` (`project.members.manage`, **+R**).
  - Qualunque permesso di progetto si può dare, purché chi lo dà lo abbia.
- `changeTypes.ts` registra i tipi di voce di 9a.

Test:
- [ ] Ogni funzione senza permesso → `forbidden`, stato invariato, nessuna
  voce.
- [ ] RF 1 e RF 3: ogni caso della Review Focus.
- [ ] Disattivazione:
  - le task riassegnate cambiano incaricato; quelle lasciate dicono
    «(deactivated)» (`assigneeStatus` nella vista della task);
  - `VIEW_AS_PERSONAS` non contiene la persona;
  - l'elenco delle persone assegnabili non la contiene;
  - riattivare la rimette.
- [ ] RF 2 su link di reset e invito.
- [ ] `security.alert` arriva solo all'interessato.
- [ ] Members: Marco su ACQ mostra `servers.operate` con la fonte «given by
  …», mentre il seme ha `grantedById: null` e la vista dice «from the seed».
- [ ] Dare `plans.approve` a Marco da Laura: va a buon fine solo se Laura
  lo ha.
- [ ] R-G5 su un progetto invisibile; `failNext`; `resetApi`.
- [ ] Commit `feat(desktop): amministrazione delle persone e degli accessi`.

### Task 5: Preferenze personali e ingresso — livello dati

**Files:**
- Create: `data/me/{account.ts,security.ts,tokens.ts,claudeCode.ts,google.ts,index.ts}`, `data/auth/{login.ts,register.ts,setup.ts,emptyInstance.ts}`, con i test `data/me/me.test.ts` e `data/auth/auth.test.ts`.
- Modify: `data/session.ts`, `data/viewer.ts` (`VIEW_AS_PERSONAS` senza i disattivati), `data/store.ts`.

**Interfaces, prodotte:**
- **Account:**
  - `updateProfile({ name?; email?; avatar? })`
  - `changePassword({ current; next })`: la password del seme è `stubwise`; il cambio chiude le altre sessioni, cioè la lista sessioni torna a 1.
- **Google personale:** `listMyMailboxes()`, `connectMailbox(workspaceId)` (con esito simulato), `reconnectMailbox(id)`, `disconnectMailbox(id)`, `setProposals(id, on)`.
  - Leggono le caselle esistenti dell'area 6: lo stato di Mail e Calendar cambia insieme.
- **Security:**
  - `getMySecurity()`: TOTP sì/no, passkey, codici di backup rimasti, sessioni, eventi
  - `startTotpSetup()` (**+R**): segreto e QR, una volta
  - `confirmTotp(code)`
  - `addPasskey(name)` (**+R**), `renamePasskey`, `removePasskey` (**+R**)
  - `regenerateBackupCodes()` (**+R**): 10 codici, una volta
  - `endSession(id)`
- **Tokens:**
  - `listTokens()`: nome, creato, scadenza, ultimo uso, mai il valore
  - `createToken({ name; expiresAt: string | null })` (**+R**): `{ token }` una volta, `stw_pat_…`
  - `revokeToken(id)`
- **Claude Code:** `createClaudeCodeCommand()` (**+R**, maintainer 29 ott: crea un token) crea un token e restituisce il comando con il token dentro, una volta. Il comando ha la stessa forma di `lib/sdk-install-guide.ts` del web.
- **Ingresso:**
  - `login({ email; password })`: `{ stage: "second_factor" }` oppure `{ stage: "in" }`. L'errore è sempre `invalid_credentials`, anche per un'email inesistente o una persona disattivata.
  - `loginSecondFactor(input)`: `{ stage: "in" } | error`
  - `getInvite(token)`: `valid` / `expired` / `revoked`, con chi invita e i progetti
  - `register(token, { name; password })`
  - `isInstanceEmpty()`, `createFirstAdmin({ name; email; password })`
  - `resetToEmptyInstance()`: tiene solo Claude
  - `logout()`

Test:
- [ ] Ogni funzione **+R** senza riconferma → `reauth_required`.
- [ ] RF 2 su token, comando di Claude Code, segreto TOTP e codici di
  backup.
- [ ] Login:
  - credenziali sbagliate e utente inesistente danno lo stesso errore;
  - Sara (senza secondo fattore) entra senza secondo passo;
  - la sua prima azione **+R** chiede l'iscrizione (`no_second_factor`, poi
    `enrollDuringReauth`).
- [ ] Inviti: uno scaduto non registra; uno valido crea la persona coi
  progetti e ruoli dell'invito.
- [ ] Istanza vuota: dopo `resetToEmptyInstance`, `isInstanceEmpty()` è
  vero e restano solo Claude e le tabelle vuote. Dopo `createFirstAdmin`
  c'è un full admin. `resetApi` torna al seme.
- [ ] Caselle Google: scollegare una casella cambia lo stato che legge la
  pagina Mail.
- [ ] Commit `feat(desktop): preferenze personali e ingresso nel livello dati`.

### Task 6: Ingresso e riconferma — UI

**Files:**
- Create `pages/entry/{LoginPage.tsx,SecondFactorStep.tsx,RegisterPage.tsx,SetupPage.tsx}` e `layout/ReauthDialog.tsx`, con il test `pages/entry/Entry.test.tsx`.
- Modify:
  - `router.tsx` (rotte fuori dall'intelaiatura: `/login`, `/register/$token`, `/setup`; reindirizzamento a `/setup` con l'istanza vuota, a `/login` dopo «Esci»);
  - `layout/ProfileMenu.tsx` («Sign out»; «Reset to empty instance» nel riquadro «Prototype only»);
  - un hook `useReauth()` che apre il dialogo su `reauth_required` e ripete l'azione;
  - i18n.

Segue lo shape `entry.md`.

Test:
- [ ] Login di Laura con secondo fattore e codice `123456` → Home.
- [ ] Codice sbagliato → errore in parole. Al quinto → bloccato.
- [ ] Sara entra senza secondo passo.
- [ ] Un invito valido registra e porta dentro; uno scaduto lo dice.
- [ ] Istanza vuota → setup → Home vuota.
- [ ] Il dialogo di riconferma ripete l'azione dopo il codice; chiuso, non
  cambia nulla.
- [ ] Commit `feat(desktop): ingresso e riconferma`.

### Task 7: Preferenze — UI

**Files:**
- Create: `pages/preferences/{AccountSection.tsx,SecuritySection.tsx,TokensSection.tsx,ClaudeCodeSection.tsx,LookSection.tsx,SecretOnce.tsx}`, con il test `pages/preferences/Personal.test.tsx`.
- Modify: `pages/preferences/PreferencesPage.tsx` (`PREFERENCE_SECTIONS` :11 diventa `["notifications", "account", "security", "tokens", "claude-code", "look"]`; via il `Placeholder`), `data/routes.ts`, i18n.

Segue lo shape `preferences-account.md`.

`SecretOnce` è il componente riusabile del valore mostrato una volta:
- monospace;
- «Copy»;
- la frase «shown only now»;
- sparisce a ogni altra visita.

9b e 9c lo riusano.

Test:
- [ ] Cambio password, con errore se la password corrente è sbagliata.
- [ ] TOTP: QR, poi conferma, poi «On».
- [ ] Passkey: aggiungi (con riconferma), rinomina, rimuovi.
- [ ] Codici di backup: visibili una volta. Dopo la navigazione il DOM non
  li contiene.
- [ ] Token: creato e copiato; alla riapertura c'è solo il nome; revoca.
- [ ] Claude Code: comando con il token, una volta.
- [ ] Caselle Google: collega, scollega, «Proposals».
- [ ] Lingua e tema cambiano davvero.
- [ ] Commit `feat(desktop): preferenze personali`.

### Task 8: Amministrazione — intelaiatura, People e inviti

**Files:**
- Create: `pages/admin/{AdminLayout.tsx,PeoplePage.tsx,PersonDetail.tsx,DeactivateDialog.tsx,InviteDialog.tsx}`, con il test `pages/admin/People.test.tsx`.
- Decisioni del maintainer (29 ott, shape `admin-people.md`):
  - la persona si apre in una pagina intera;
  - gli inviti in attesa sono righe dell'elenco People, con stato «Invited» e scadenza; non c'è una pagina Invites;
  - chi non amministra niente vede nel profilo la voce «People» e non «Administration». Apre People e Who can? in sola lettura.
- Modify: `router.tsx` (`AdminPage` :322 diventa la sezione `/admin/$section`; `canSeeAdmin` :480 allargata alle voci di 9a), `layout/ProfileMenu.tsx`, `palette/CommandPalette.tsx` (persone, «Invite someone»), i18n.

Segue lo shape `admin-people.md`.

Test:
- [ ] Ogni voce compare solo col suo permesso.
- [ ] Senza voci, Amministrazione non c'è nel profilo.
- [ ] Elenco con filtri; RF 4 (disattiva con riassegnazione, poi riattiva).
- [ ] Ruolo d'istanza con riconferma; su sé stessi spento, col motivo.
- [ ] Reset password: il link si vede una volta.
- [ ] Reset 2FA: l'interessato riceve l'avviso.
- [ ] Inviti: crea (progetti offerti solo dove si gestiscono i membri),
  copia, revoca.
- [ ] Identità git: collega e scollega.
- [ ] Commit `feat(desktop): amministrazione delle persone`.

### Task 9: Departments e Roles — UI

**Files:**
- Create: `pages/admin/{DepartmentsPage.tsx,DepartmentPanel.tsx,RolesPage.tsx,RoleEditor.tsx,PermissionTable.tsx}`, con il test `pages/admin/RolesDepartments.test.tsx`.
- Modify: i18n, con una frase per ogni permesso (`permissions.<key>.label|hint`; quelle del web dove esistono).

Segue gli shape `admin-people.md` (reparti) e `admin-roles-members.md`
(ruoli).

`PermissionTable` è condivisa con Members: 11 gruppi del web più un gruppo
«Prototype» per i permessi locali.

Test:
- [ ] Crea, rinomina e colora un reparto.
- [ ] Persone del reparto; Home del reparto.
- [ ] Permessi del reparto, con `escalation` mostrato in parole.
- [ ] Elimina un reparto con le task da spostare.
- [ ] Ruoli:
  - crea, duplica, modifica, elimina;
  - un preset non si elimina, con la frase;
  - un ruolo in uso mostra chi lo ha;
  - un permesso che chi modifica non ha è spento, col motivo.
- [ ] Il cambio vale subito: dato `release.merge` a «Release manager», una
  persona con quel ruolo vede «Merge» in Releases.
- [ ] Commit `feat(desktop): reparti e ruoli`.

### Task 10: Members del progetto — UI

**Files:**
- Create: `pages/settings/{MembersSettings.tsx,AddMemberDialog.tsx}`, con il test `MembersSettings.test.tsx`.
- Modify:
  - `pages/settings/ProjectSettingsPage.tsx` e `layout/Column.tsx`. Decisione del maintainer: le sezioni di Settings diventano voci rientrate sotto «Settings» nella colonna del progetto, una pagina ciascuna. Rotta `/p/$code/settings/$section`; le sezioni di oggi (Statuses, Repositories) si spostano lì;
  - i18n.
- Il membro si modifica nel pannello laterale (maintainer), che si apre in sola lettura per chi non gestisce i membri.

Segue lo shape `admin-roles-members.md`.

Test:
- [ ] Laura su ACQ:
  - aggiunge Federico come Developer;
  - dà `servers.operate` a Federico; Federico vede «Start the fix» su SRV-1
    (8b);
  - toglie il permesso.
- [ ] Ogni permesso mostra la sua fonte.
- [ ] Marco vede l'elenco senza azioni.
- [ ] Né Claude né Roberta compaiono fra le righe; c'è la riga sui full
  admin.
- [ ] Laura toglie a Marco `servers.operate`, che lei non ha (nessuna gerarchia); dare un permesso che non ha è spento, col motivo.
- [ ] Ultimo gestore in parole.
- [ ] Commit `feat(desktop): membri del progetto`.

### Task 11: Change log e «Chi può farlo?» — UI

**Files:**
- Create: `pages/admin/{ChangeLogPage.tsx,ChangeEntry.tsx,WhoCanPage.tsx}`, `pages/settings/ProjectChangeLog.tsx` e `components/WhoCanLink.tsx`, con il test `pages/admin/Audit.test.tsx`.
- Modify:
  - `palette/CommandPalette.tsx` («Who can …»);
  - i bottoni spenti per permesso che oggi mostrano chi può farlo in
    grigio: la task dell'8b «Start the fix», l'approvazione del piano,
    Merge in Releases, la risposta in Support e gli altri che lo shape
    elenca. Diventano un `WhoCanLink`;
  - i18n.

Segue lo shape `admin-audit.md`. Il link «Who?» apre un riquadro sul posto, con le persone e il perché, più «Open in Who can?» (maintainer).

Test:
- [ ] Il registro filtra per persona, progetto, tipo e periodo.
- [ ] Una voce con prima e dopo; nessun segreto (RF 2).
- [ ] La parte di progetto in Settings.
- [ ] «Who can?» da azione e da persona, col perché.
- [ ] Sara dal bottone spento di ACQ vede solo persone di ACQ che vede.
- [ ] Claude con la frase fissa.
- [ ] ⌘K «Who can approve plans in ACQ».
- [ ] Commit `feat(desktop): registro delle modifiche e chi può farlo`.

### Task 12: L'istanza vuota, pagina per pagina

**Files:** Modify le pagine delle aree 2–8 che non reggono l'istanza vuota. Create `apps/desktop/src/renderer/emptyInstance.test.tsx`.

Il test fa due passi:
- dopo `resetToEmptyInstance()` + `createFirstAdmin`, rende ogni rotta di
  `data/routes.ts` raggiungibile senza progetto (Home, Week, Chat, Docs,
  Drive, Mail, Calendar, Automations, All projects, Preferences,
  Admin/*);
- asserisce che non lancia e che mostra lo stato vuoto dello shape della
  sua area (testo «no projects yet» / «nothing here» delle chiavi i18n
  esistenti).

Le correzioni restano minime: si aggiunge lo stato vuoto mancante, mai una
pagina nuova.

- [ ] Commit `fix(desktop): ogni pagina regge l'istanza vuota`.

### Task 13: Documenti, screenshot, follow-up

- `apps/desktop/docs/area9-parity.md`, nuovo:
  - righe per tutte le voci A e B di `area9-inventory.md` (voce, parte,
    dove vive, test fra virgolette);
  - le voci «fuori» col motivo;
  - le voci C, D, E come «9b» / «9c».
- `capture.mjs`, scatti `a9a-*`:
  - login e secondo fattore;
  - Preferences Security e Tokens, con il valore mostrato una volta;
  - Admin People con il dettaglio;
  - Departments; Roles con l'editor;
  - Members di ACQ;
  - Change log; Who can?.

  Tutto in chiaro e scuro, en e it, a 1440, più uno a 1024. Vite ucciso.
- `ossatura-follow-ups.md`:
  - «Area 9a — minori aperti», con le scelte del controller del design da
    confermare;
  - sotto «Invarianti del CLAUDE.md da riscrivere prima del motore»:
    permessi di reparto, concessioni personali e anti-escalation sui
    permessi effettivi, marcati «costruiti nel prototipo (9a), da
    riscrivere prima del motore».
- Suite, typecheck, lint e build verdi.
- Commit `docs(desktop): note dell'area 9a`.

Dopo il Task 13: revisione finale del branch (area 9a) e revisione visiva
di Impeccable.
