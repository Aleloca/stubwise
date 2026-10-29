import { INSTANCE_PERMISSIONS } from "@stubwise/shared";
import type { LocalInstancePermission } from "../types";
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

export interface AccessState {
  roles: RoleDef[];
  memberships: Membership[];
  grants: PersonalGrant[];
  departments: DepartmentAccess[];
  people: PersonAccess[];
  revocations: PersonalRevocation[];
}

/** I permessi d'istanza del prototipo, nell'ordine in cui si mostrano. */
export const LOCAL_INSTANCE_PERMISSIONS: readonly LocalInstancePermission[] = [
  "claude.public.view",
  "people.activity.view",
  "chat.general.create",
  "chat.general.manage",
  "automations.manage",
  "servers.ssh.manage",
  "departments.manage",
  "instance.status.view",
  "changelog.view",
];

/** Ogni permesso d'istanza, del registro condiviso e del prototipo. */
export const INSTANCE_SET: ReadonlySet<string> = new Set<string>([
  ...INSTANCE_PERMISSIONS,
  ...LOCAL_INSTANCE_PERMISSIONS,
]);

/**
 * Permessi che esistono con lo stesso nome a due livelli (area 7: le
 * automazioni di progetto e quelle generali). Con un progetto vale quello di
 * progetto, senza quello d'istanza.
 */
export const BOTH_LEVELS: ReadonlySet<string> = new Set<string>(["automations.manage"]);

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

const pairsOf = (s: AccessState) =>
  new Set(s.memberships.map((m) => `${m.projectId}\u0000${m.personId}`));

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

/** L'unica strada per cambiare gli accessi: la versione sale, `memberIds` segue. */
export function writeAccess(fn: (s: AccessState) => void): void {
  const before = pairsOf(current);
  fn(current);
  version += 1;
  notify(before, pairsOf(current));
}

/** Riporta gli accessi al seme, sullo stesso oggetto (così `state.access` resta valido). */
export function resetAccessState(): AccessState {
  writeAccess((s) => Object.assign(s, seedAccessState()));
  return current;
}
