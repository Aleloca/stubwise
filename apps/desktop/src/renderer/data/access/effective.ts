import { ALL_PROJECT_PERMISSIONS } from "./seed";
import { INSTANCE_SET, accessState, type AccessState, type RoleDef } from "./state";

// Il calcolo unico dei permessi (area 9a): ogni domanda («può?», «chi può?»,
// Members, anti-escalation) passa da qui o da `can()`, che legge un `Viewer`
// costruito da qui. Non c'è una seconda copia della regola.

/** Da dove viene un permesso: si mostra in Members e in «Chi può farlo?». */
export type PermissionSource =
  | { kind: "role"; roleId: string }
  | { kind: "grant"; grantedById: string | null; at: string }
  | { kind: "department"; departmentId: string }
  | { kind: "full_admin" };

/**
 * «Vedere l'attività delle persone» (R-E2) non si salva: ce l'ha chi è
 * Project Lead in almeno un progetto (e il full admin, che ha tutto).
 */
const ACTIVITY_PERMISSION = "people.activity.view";
const ACTIVITY_ROLE_KEY = "project_lead";

const roleById = (s: AccessState, id: string): RoleDef | undefined =>
  s.roles.find((r) => r.id === id);

/** Il ruolo d'istanza di una persona; `null` per chi non ha accessi (Claude, un id sconosciuto). */
export function instanceRoleOf(personId: string): RoleDef | null {
  const s = accessState();
  const person = s.people.find((p) => p.personId === personId);
  return (person && roleById(s, person.instanceRoleId)) ?? null;
}

/** Vero se la persona ha `instance.full_admin`, dal ruolo d'istanza o da una concessione. */
export function isFullAdmin(personId: string): boolean {
  const s = accessState();
  if (instanceRoleOf(personId)?.permissions.includes("instance.full_admin")) return true;
  return s.grants.some(
    (g) =>
      g.personId === personId && g.projectId === null && g.permission === "instance.full_admin",
  );
}

/**
 * Se la persona ha un'appartenenza esplicita al progetto. Claude non ne ha
 * (R-L9: è membro implicito di ogni progetto, e lo risolve `can()`).
 */
export function isMember(personId: string, projectId: string): boolean {
  return accessState().memberships.some(
    (m) => m.personId === personId && m.projectId === projectId,
  );
}

/** Il ruolo di progetto di una persona; `null` se non è membro. */
export function projectRoleOf(personId: string, projectId: string): RoleDef | null {
  const s = accessState();
  const m = s.memberships.find((x) => x.personId === personId && x.projectId === projectId);
  return (m && roleById(s, m.roleId)) ?? null;
}

/** I reparti di cui la persona gestisce la Home (`department.home.manage`). */
export function homeManagedDepartments(personId: string): string[] {
  return accessState()
    .departments.filter((d) => d.homeManagerIds.includes(personId))
    .map((d) => d.departmentId);
}

function add(map: Map<string, PermissionSource[]>, perm: string, source: PermissionSource): void {
  const sources = map.get(perm);
  if (sources) sources.push(source);
  else map.set(perm, [source]);
}

/** Toglie le revoche (solo prototipo): restano solo i permessi che il full admin tiene comunque. */
function applyRevocations(
  s: AccessState,
  map: Map<string, PermissionSource[]>,
  personId: string,
  projectId: string | null,
): void {
  for (const r of s.revocations) {
    if (r.personId !== personId || r.projectId !== projectId) continue;
    const kept = (map.get(r.permission) ?? []).filter((x) => x.kind === "full_admin");
    if (kept.length > 0) map.set(r.permission, kept);
    else map.delete(r.permission);
  }
}

function instancePermissions(s: AccessState, personId: string): Map<string, PermissionSource[]> {
  const map = new Map<string, PermissionSource[]>();
  const role = instanceRoleOf(personId);
  const fullAdmin = isFullAdmin(personId);
  if (role) {
    const fromRole = role.permissions.filter((p) => INSTANCE_SET.has(p));
    for (const p of fromRole) add(map, p, { kind: "role", roleId: role.id });
  }
  for (const g of s.grants) {
    if (g.personId === personId && g.projectId === null) {
      add(map, g.permission, { kind: "grant", grantedById: g.grantedById, at: g.at });
    }
  }
  // R-E2: dal ruolo Project Lead, in qualunque progetto.
  const lead = s.memberships
    .filter((m) => m.personId === personId)
    .map((m) => roleById(s, m.roleId))
    .find((r) => r?.key === ACTIVITY_ROLE_KEY);
  if (lead) add(map, ACTIVITY_PERMISSION, { kind: "role", roleId: lead.id });
  if (fullAdmin) {
    // Come sul server (`effectiveInstancePermissions`): `instance.full_admin`
    // vale ogni permesso d'istanza, e nel prototipo anche quelli locali.
    for (const p of INSTANCE_SET) add(map, p, { kind: "full_admin" });
  }
  applyRevocations(s, map, personId, null);
  return map;
}

function projectPermissions(
  s: AccessState,
  personId: string,
  projectId: string,
): Map<string, PermissionSource[]> {
  const map = new Map<string, PermissionSource[]>();
  const role = projectRoleOf(personId, projectId);
  if (role) {
    for (const p of role.permissions) add(map, p, { kind: "role", roleId: role.id });
    for (const g of s.grants) {
      if (g.personId === personId && g.projectId === projectId) {
        add(map, g.permission, { kind: "grant", grantedById: g.grantedById, at: g.at });
      }
    }
    // Il reparto dà permessi solo dove la persona è già membro: non la rende membro.
    for (const d of s.departments) {
      if (!d.memberIds.includes(personId)) continue;
      for (const p of d.projectPermissions) {
        add(map, p, { kind: "department", departmentId: d.departmentId });
      }
    }
  }
  if (isFullAdmin(personId)) {
    for (const p of ALL_PROJECT_PERMISSIONS) add(map, p, { kind: "full_admin" });
  }
  applyRevocations(s, map, personId, projectId);
  return map;
}

/**
 * I permessi effettivi di una persona, ognuno con le sue fonti. Con
 * `projectId`: quelli di progetto in quel progetto (ruolo, concessioni,
 * reparto; il full admin li ha tutti, membro o no). Senza: quelli d'istanza.
 * Claude non ha ruoli, appartenenze né reparti: per lui la mappa è vuota, e
 * il suo insieme fisso lo legge `can()` (R-L9, in testa).
 */
export function effectivePermissions(
  personId: string,
  projectId?: string,
): Map<string, PermissionSource[]> {
  const s = accessState();
  if (!s.people.some((p) => p.personId === personId)) return new Map();
  return projectId === undefined
    ? instancePermissions(s, personId)
    : projectPermissions(s, personId, projectId);
}
