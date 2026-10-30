import {
  ALL_PROJECT_PERMISSIONS,
  INSTANCE_SET,
  accessState,
  writeAccess,
  type AccessState,
  type RoleDef,
} from "../access/index";
import { recordChange } from "../changelog/index";
import { gate, newId, visibleProjectIds } from "../store";
import { writer } from "../writer";
import {
  canI,
  escalationRefusal,
  holdingsAnywhere,
  invariantRefusal,
  isHumanId,
  missingFor,
  reauthRefusal,
  refuse,
  roleById,
} from "./common";
import type { AdminResult, RoleView } from "./types";
import "./changeTypes";

// Roles (area 9a, «come sul web»): ruoli d'istanza e di progetto, i preset si
// modificano ma non si eliminano, un ruolo in uso non si elimina. Tutto con
// `roles.manage` e la riconferma. Il contenuto di un ruolo passa
// dall'anti-escalation con il confronto d'istanza: chi lo scrive mette solo
// permessi che ha da qualche parte (`holdingsAnywhere`). Un ruolo non arriva
// mai a Claude, che non ha ruoli.
//
// L'elenco lo legge chiunque: i menu dei ruoli di Members e degli inviti ne
// hanno bisogno. I conteggi rispettano R-G5 (solo persone e progetti che chi
// guarda vede).

const ROLES_MANAGE = "roles.manage";

/** I permessi che un ruolo di quel livello può contenere. */
const universeOf = (scope: RoleDef["scope"]): ReadonlySet<string> =>
  scope === "instance" ? INSTANCE_SET : new Set(ALL_PROJECT_PERMISSIONS);

/** Chi ha il ruolo, fra le persone e i progetti visibili a `me`. */
function holdersOf(
  me: string,
  role: RoleDef,
  s: AccessState,
): { personId: string; projectId: string | null }[] {
  if (role.scope === "instance")
    return s.people
      .filter((p) => p.instanceRoleId === role.id && isHumanId(p.personId))
      .map((p) => ({ personId: p.personId, projectId: null }));
  const visible = visibleProjectIds(me);
  return s.memberships
    .filter((m) => m.roleId === role.id && visible.has(m.projectId))
    .map((m) => ({ personId: m.personId, projectId: m.projectId }));
}

/** Tutti i ruoli, con chi li ha e ciò che manca a chi guarda per darli. */
export async function listRoles(): Promise<RoleView[]> {
  const me = await gate("admin.listRoles");
  const s = accessState();
  const mine = holdingsAnywhere(me);
  return s.roles.map((role) => {
    const holders = holdersOf(me, role, s);
    return {
      ...structuredClone(role),
      peopleCount: holders.length,
      holders,
      missing: missingFor(mine, role.permissions),
    };
  });
}

const cleanName = (name: string) => name.trim();

function nameTaken(s: AccessState, scope: RoleDef["scope"], name: string, except?: string) {
  return s.roles.some(
    (r) => r.scope === scope && r.id !== except && r.name.toLowerCase() === name.toLowerCase(),
  );
}

const roleLabel = (role: RoleDef) => ({ type: "role", id: role.id, label: role.name });

/** Il ruolo nuovo (vuoto o copia di un ruolo dello stesso livello). */
async function create(
  fn: "admin.createRole" | "admin.duplicateRole",
  me: string,
  input: { name: string; scope: RoleDef["scope"]; permissions: string[]; from: RoleDef | null },
): Promise<AdminResult<{ roleId: string }>> {
  const name = cleanName(input.name);
  if (!name) return refuse.invalid("name");
  if (nameTaken(accessState(), input.scope, name)) return refuse.invalid("name_taken");
  const escalation = escalationRefusal(holdingsAnywhere(me), input.permissions);
  if (escalation) return escalation;
  const reauth = reauthRefusal(me, fn);
  if (reauth) return reauth;
  const id = newId("role");
  writeAccess((s) => {
    s.roles.push({
      id,
      key: id,
      scope: input.scope,
      name,
      preset: false,
      permissions: [...input.permissions],
    });
  });
  recordChange({
    kind: "role.created",
    actorId: me,
    projectId: null,
    object: { type: "role", id, label: name },
    after: name,
    params: input.from ? { from: input.from.name } : {},
  });
  return { ok: true, roleId: id };
}

/** Crea un ruolo, vuoto o partendo da un altro dello stesso livello (`roles.manage`, +R). */
export async function createRole(input: {
  name: string;
  scope: RoleDef["scope"];
  from?: string;
}): Promise<AdminResult<{ roleId: string }>> {
  const me = await writer("admin.createRole");
  if (!canI(me, ROLES_MANAGE)) return refuse.forbidden();
  const from = input.from ? roleById(input.from) : null;
  if (input.from && !from) return refuse.notFound();
  if (from && from.scope !== input.scope) return refuse.invalid("scope");
  return create("admin.createRole", me, {
    name: input.name,
    scope: input.scope,
    permissions: from?.permissions ?? [],
    from: from ?? null,
  });
}

/** «Copy of Developer» (`roles.manage`, +R): stessa regola di escalation di chi lo crea. */
export async function duplicateRole(roleId: string): Promise<AdminResult<{ roleId: string }>> {
  const me = await writer("admin.duplicateRole");
  if (!canI(me, ROLES_MANAGE)) return refuse.forbidden();
  const from = roleById(roleId);
  if (!from) return refuse.notFound();
  let name = `Copy of ${from.name}`;
  for (let n = 2; nameTaken(accessState(), from.scope, name); n++)
    name = `Copy of ${from.name} (${n})`;
  return create("admin.duplicateRole", me, {
    name,
    scope: from.scope,
    permissions: from.permissions,
    from,
  });
}

/**
 * Rinomina un ruolo o ne cambia i permessi (`roles.manage`, +R). Si
 * controlla ciò che si AGGIUNGE; togliere vale subito per chi ha il ruolo,
 * anche per chi salva, salvo lasciare l'istanza senza full admin o un
 * progetto senza chi gestisce i membri.
 */
export async function updateRole(
  roleId: string,
  patch: { name?: string; permissions?: string[] },
): Promise<AdminResult> {
  const me = await writer("admin.updateRole");
  if (!canI(me, ROLES_MANAGE)) return refuse.forbidden();
  const role = roleById(roleId);
  if (!role) return refuse.notFound();
  const name = patch.name === undefined ? role.name : cleanName(patch.name);
  if (!name) return refuse.invalid("name");
  if (nameTaken(accessState(), role.scope, name, role.id)) return refuse.invalid("name_taken");
  const permissions = patch.permissions ? [...new Set(patch.permissions)] : role.permissions;
  const universe = universeOf(role.scope);
  if (permissions.some((p) => !universe.has(p))) return refuse.invalid("permission");
  const added = permissions.filter((p) => !role.permissions.includes(p));
  const escalation = escalationRefusal(holdingsAnywhere(me), added);
  if (escalation) return escalation;
  const removed = role.permissions.filter((p) => !permissions.includes(p));
  if (name === role.name && added.length === 0 && removed.length === 0)
    return refuse.invalid("unchanged");
  const mutate = (s: AccessState) => {
    const r = s.roles.find((x) => x.id === roleId)!;
    r.name = name;
    r.permissions = [...permissions];
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.updateRole");
  if (reauth) return reauth;
  const beforeName = role.name;
  writeAccess(mutate);
  recordChange({
    kind: "role.updated",
    actorId: me,
    projectId: null,
    object: { type: "role", id: roleId, label: name },
    before: beforeName,
    after: name,
    params: { added: added.join(","), removed: removed.join(",") },
  });
  return { ok: true };
}

/**
 * Elimina un ruolo fatto a mano e libero (`roles.manage`, +R). Un preset →
 * `invalid: preset`; un ruolo in uso → `invalid: in_use` con chi lo ha (fra
 * le persone e i progetti che chi guarda vede).
 */
export async function deleteRole(roleId: string): Promise<AdminResult> {
  const me = await writer("admin.deleteRole");
  if (!canI(me, ROLES_MANAGE)) return refuse.forbidden();
  const role = roleById(roleId);
  if (!role) return refuse.notFound();
  if (role.preset) return refuse.invalid("preset");
  const s = accessState();
  const inUse =
    s.people.some((p) => p.instanceRoleId === role.id) ||
    s.memberships.some((m) => m.roleId === role.id);
  if (inUse) return refuse.invalid("in_use", holdersOf(me, role, s));
  const reauth = reauthRefusal(me, "admin.deleteRole");
  if (reauth) return reauth;
  const label = roleLabel(role);
  writeAccess((x) => {
    x.roles = x.roles.filter((r) => r.id !== roleId);
  });
  recordChange({
    kind: "role.deleted",
    actorId: me,
    projectId: null,
    object: label,
    before: role.name,
  });
  return { ok: true };
}
