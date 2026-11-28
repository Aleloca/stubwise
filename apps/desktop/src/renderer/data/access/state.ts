import { seatsIn } from "./seats";
import { seedAccessState } from "./seed";

// Gli accessi come stato del livello dati (area 9a): ruoli, appartenenze ai
// progetti, concessioni personali, reparti coi loro permessi, persone con
// stato e secondo fattore. Lo legge UNA funzione, `effectivePermissions`
// (`effective.ts`); `viewerFor` e `can()` (`viewer.ts`) la leggono a loro
// volta. Ogni scrittura passa da `writeAccess`, che cambia la versione: è la
// versione che invalida i `Viewer` già calcolati.

export interface RoleDef {
  id: string;
  /** I preset hanno la chiave del web (`project_lead`, `admin`…); i ruoli fatti a mano una propria (`rm-1`). */
  key: string;
  scope: "instance" | "project";
  name: string;
  preset: boolean;
  permissions: string[];
}

export interface Membership {
  personId: string;
  projectId: string;
  roleId: string;
}

export interface PersonalGrant {
  personId: string;
  /** `null` = d'istanza. */
  projectId: string | null;
  permission: string;
  /** `null` = dal seme o da una funzione senza attore (i `grant*` dei test). */
  grantedById: string | null;
  at: string;
}

export interface DepartmentAccess {
  departmentId: string;
  memberIds: string[];
  /** Chi ha `department.home.manage` su questo reparto. */
  homeManagerIds: string[];
  /** Permessi di progetto che il reparto dà ai suoi membri, nei soli progetti di cui sono già membri. */
  projectPermissions: string[];
}

export interface PersonAccess {
  personId: string;
  instanceRoleId: string;
  status: "active" | "deactivated";
  deactivatedAt: string | null;
  /** `null` = nessun secondo fattore attivo. */
  secondFactor: { totp: boolean; passkeys: number; backupCodesLeft: number } | null;
}

/**
 * Un permesso di base (del ruolo o del reparto) tolto a una persona. Solo
 * prototipo: lo scrivono le `revoke*` di `viewer.ts`, con cui i test delle
 * aree 2–8 tolgono un permesso «anche di base». Una concessione personale
 * invece si toglie cancellandone la riga. Non tocca il full admin.
 */
export interface PersonalRevocation {
  personId: string;
  /** `null` = d'istanza. */
  projectId: string | null;
  permission: string;
}

/**
 * Chi è uscito da un progetto (registro, A11 r.1414): lo scrive `writeAccess`
 * a ogni uscita, in UN posto. Serve a `peopleKnownTo`: un ex membro di un
 * progetto visibile resta una persona che chi guarda conosce.
 */
export interface FormerMembership {
  projectId: string;
  personId: string;
}

/**
 * Una workspace (shape `workspaces.md`, decisioni del 27 nov 2026): un
 * raggruppamento di PROGETTI per visibilità. Chi ne è membro vede tutti i
 * suoi progetti col ruolo di workspace (un ruolo di progetto); non dà
 * permessi d'istanza. Un progetto sta in al più una workspace (D2).
 */
export interface WorkspaceDef {
  id: string;
  /** Lo slug dell'indirizzo (`?workspace=`), nato dal nome. */
  slug: string;
  name: string;
  createdAt: string;
}

/** Un progetto dentro una workspace (al più una riga per progetto, D2). */
export interface WorkspaceProject {
  workspaceId: string;
  projectId: string;
}

/**
 * Una persona in una workspace, col suo ruolo di workspace: un ruolo di
 * PROGETTO, che vale in ogni progetto della workspace. Il ruolo per progetto
 * resta un `Membership` normale, e i due si sommano (D1).
 */
export interface WorkspaceMember {
  workspaceId: string;
  personId: string;
  roleId: string;
}

export interface AccessState {
  roles: RoleDef[];
  memberships: Membership[];
  workspaces: WorkspaceDef[];
  workspaceProjects: WorkspaceProject[];
  workspaceMembers: WorkspaceMember[];
  formerMemberships: FormerMembership[];
  grants: PersonalGrant[];
  departments: DepartmentAccess[];
  people: PersonAccess[];
  revocations: PersonalRevocation[];
}

export { INSTANCE_SET, LOCAL_INSTANCE_PERMISSIONS } from "./catalog";

// --- lo stato e la sua versione ----------------------------------------------

const current: AccessState = seedAccessState();
let version = 0;

/** Lo stato degli accessi di adesso (lo stesso oggetto di `state.access` nello store). */
export const accessState = (): AccessState => current;

/** Cambia a ogni scrittura e a ogni ripristino: invalida i `Viewer` calcolati. */
export const accessVersion = (): number => version;

/**
 * Chi tiene `project.memberIds` allineato alle appartenenze: lo registra lo
 * store, unico proprietario dei progetti. È l'unico scrittore di quel campo
 * per chi entra o esce da un progetto.
 */
export interface MembershipSync {
  changed(projectId: string, personId: string, isMember: boolean): void;
}
let sync: MembershipSync | null = null;
export function registerMembershipSync(next: MembershipSync): void {
  sync = next;
}

/**
 * Chi vede ogni progetto da membro: le appartenenze esplicite E le persone
 * delle workspace (shape `workspaces.md`). `project.memberIds` segue questo
 * insieme, così ogni regola di visibilità che lo legge conta anche la
 * workspace (D10, D17), e chi ne esce resta un ex membro (D19).
 */
const pairsOf = (s: AccessState) =>
  new Set(seatsIn(s).map((m) => `${m.projectId}\u0000${m.personId}`));

/** Chi è uscito da un progetto fra due fotografie resta un ex membro (r.1414). */
function rememberLeavers(before: Set<string>, after: Set<string>): void {
  const known = new Set(current.formerMemberships.map((m) => `${m.projectId}\u0000${m.personId}`));
  for (const key of before) {
    if (after.has(key) || known.has(key)) continue;
    const [projectId, personId] = key.split("\u0000") as [string, string];
    current.formerMemberships.push({ projectId, personId });
  }
}

/** Avvisa lo store di chi è entrato o uscito da un progetto, fra due fotografie. */
function notify(before: Set<string>, after: Set<string>): void {
  if (!sync) return;
  for (const key of before) {
    if (!after.has(key)) {
      const [projectId, personId] = key.split("\u0000") as [string, string];
      sync.changed(projectId, personId, false);
    }
  }
  for (const key of after) {
    if (!before.has(key)) {
      const [projectId, personId] = key.split("\u0000") as [string, string];
      sync.changed(projectId, personId, true);
    }
  }
}

/**
 * Chi ascolta ogni scrittura degli accessi, dopo che è avvenuta: i campi
 * allineati allo stato (`Person.departmentIds`, le persone del «vedi come»)
 * e il `ViewerProvider`, che così ri-renderizza chi legge i permessi.
 */
const listeners = new Set<() => void>();

/** Iscrive `fn` alle scritture degli accessi; restituisce come smettere. */
export function subscribeAccess(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** L'unica strada per cambiare gli accessi: la versione sale, `memberIds` segue. */
export function writeAccess(fn: (s: AccessState) => void): void {
  const before = pairsOf(current);
  fn(current);
  version += 1;
  const after = pairsOf(current);
  rememberLeavers(before, after);
  notify(before, after);
  for (const listener of listeners) listener();
}

/** Riporta gli accessi al seme, sullo stesso oggetto (così `state.access` resta valido). */
export function resetAccessState(): AccessState {
  writeAccess((s) => Object.assign(s, seedAccessState()));
  // Il ripristino non è un'uscita: gli ex membri tornano quelli del seme.
  current.formerMemberships = seedAccessState().formerMemberships;
  return current;
}
