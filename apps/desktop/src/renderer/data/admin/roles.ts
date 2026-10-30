import {
  ALL_PROJECT_PERMISSIONS,
  INSTANCE_SET,
  accessState,
  effectivePermissionsIn,
  roleGivesActivityView,
  writeAccess,
  type AccessState,
  type RoleDef,
} from "../access/index";
import { recordChange } from "../changelog/index";
import { gate, newId, now, state, visibleProjectIds } from "../store";
import { writer } from "../writer";
import {
  canI,
  escalationIn,
  invariantRefusal,
  isHumanId,
  missingIn,
  reauthRefusal,
  refuse,
  roleById,
} from "./common";
import type { AdminResult, RoleView } from "./types";
import "./changeTypes";

// Roles (area 9a, «come sul web»): ruoli d'istanza e di progetto, i preset si
// modificano ma non si eliminano, un ruolo in uso non si elimina. Tutto con
// `roles.manage` e la riconferma. Il contenuto di un ruolo passa
// dall'anti-escalation dove il ruolo vale (ruling R-M2, come
// `heldForProjectRole` del web): un ruolo d'istanza coi soli permessi
// d'istanza di chi lo scrive; un ruolo di progetto coi suoi permessi in OGNI
// progetto dove il ruolo è assegnato o promesso da un invito in sospeso.
// Un ruolo di progetto non assegnato (nuovo, duplicato) lo scrive chi ne ha
// i permessi in almeno un progetto: assegnarlo rifà il controllo.
// Un ruolo non arriva mai a Claude, che non ha ruoli.
//
// L'elenco lo legge chiunque: i menu dei ruoli di Members e degli inviti ne
// hanno bisogno. I conteggi rispettano R-G5 (solo persone e progetti che chi
// guarda vede).

const ROLES_MANAGE = "roles.manage";
const FULL_ADMIN = "instance.full_admin";

/**
 * Dove si giudica un ruolo NUOVO (crea, duplica, «Start from»): non vale
 * ancora da nessuna parte, quindi l'istanza o almeno un progetto.
 */
const createReach = (scope: RoleDef["scope"]): "instance" | [] =>
  scope === "instance" ? "instance" : [];

/** I permessi che un ruolo di quel livello può contenere. */
const universeOf = (scope: RoleDef["scope"]): ReadonlySet<string> =>
  scope === "instance" ? INSTANCE_SET : new Set(ALL_PROJECT_PERMISSIONS);

/**
 * Dove un ruolo è effettivo: l'istanza per un ruolo d'istanza; per uno di
 * progetto, i progetti dove è assegnato o promesso da un invito in sospeso
 * (né revocato, né accettato, né scaduto). Tutti, visibili o no a chi agisce.
 */
export function whereRoleApplies(role: RoleDef): string[] | "instance" {
  if (role.scope === "instance") return "instance";
  const assigned = accessState()
    .memberships.filter((m) => m.roleId === role.id)
    .map((m) => m.projectId);
  const promised = state.invites
    .filter(
      (i) =>
        i.revokedAt === null &&
        i.acceptedAt === null &&
        Date.parse(i.expiresAt) >= Date.parse(now()),
    )
    .flatMap((i) => i.projects.filter((p) => p.roleId === role.id).map((p) => p.projectId));
  return [...new Set([...assigned, ...promised])];
}

/**
 * Chi ha il ruolo, fra le persone e i progetti visibili a `me`; con `all`,
 * anche nei progetti che `me` non vede (solo per contare chi cambia).
 */
function holdersOf(
  me: string,
  role: RoleDef,
  s: AccessState,
  opts: { all?: boolean } = {},
): { personId: string; projectId: string | null }[] {
  if (role.scope === "instance")
    return s.people
      .filter((p) => p.instanceRoleId === role.id && isHumanId(p.personId))
      .map((p) => ({ personId: p.personId, projectId: null }));
  const visible = visibleProjectIds(me);
  return s.memberships
    .filter((m) => m.roleId === role.id && (opts.all || visible.has(m.projectId)))
    .map((m) => ({ personId: m.personId, projectId: m.projectId }));
}

/** In uso da qualcuno, visibile o no a chi guarda (`deleteRole` lo rifiuta). */
const inUse = (s: AccessState, role: RoleDef): boolean =>
  s.people.some((p) => p.instanceRoleId === role.id) ||
  s.memberships.some((m) => m.roleId === role.id);

/**
 * Tutti i ruoli, con chi li ha e ciò che manca a chi guarda per darli. I
 * campi della pagina di un ruolo li calcola qui la stessa regola delle
 * scritture: `notGivable` è ciò che `updateRole` rifiuterebbe se aggiunto.
 */
export async function listRoles(): Promise<RoleView[]> {
  const me = await gate("admin.listRoles");
  const s = accessState();
  return s.roles.map((role) => {
    const holders = holdersOf(me, role, s);
    const where = whereRoleApplies(role);
    return {
      ...structuredClone(role),
      peopleCount: holders.length,
      holders,
      missing: missingIn(me, where, role.permissions),
      reach: where === "instance" ? "instance" : where.length > 0 ? "projects" : "anywhere",
      notGivable: missingIn(me, where, [...universeOf(role.scope)]),
      copyMissing: missingIn(me, createReach(role.scope), role.permissions),
      affectedCount: new Set(holdersOf(me, role, s, { all: true }).map((h) => h.personId)).size,
      fullAdminImplies:
        role.scope === "instance" ? [...INSTANCE_SET].filter((p) => p !== FULL_ADMIN) : [],
      deleteBlock: role.preset ? "preset" : inUse(s, role) ? "in_use" : null,
      givesActivityView: roleGivesActivityView(role),
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
  const escalation = escalationIn(me, createReach(input.scope), input.permissions);
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
  const escalation = escalationIn(me, whereRoleApplies(role), added);
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
  if (inUse(s, role)) return refuse.invalid("in_use", holdersOf(me, role, s));
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

/**
 * Cosa perderebbe davvero chi guarda se il ruolo avesse `nextPermissions`
 * (la barra della pagina del ruolo, [RM 3]). Lettura pura: simula la bozza
 * su una copia dello stato e confronta i permessi effettivi di chi guarda —
 * ruolo, concessioni, reparto, full admin — all'istanza e in ogni progetto
 * di cui è membro. Un permesso che resta da un'altra fonte non è perso.
 */
export async function viewerLosesIf(roleId: string, nextPermissions: string[]): Promise<string[]> {
  const me = await gate("admin.viewerLosesIf");
  if (!canI(me, ROLES_MANAGE)) throw new Error("forbidden");
  const before = accessState();
  if (!before.roles.some((r) => r.id === roleId)) throw new Error("not_found");
  const after = structuredClone(before);
  after.roles.find((r) => r.id === roleId)!.permissions = [...nextPermissions];
  const scopes: (string | undefined)[] = [
    undefined,
    ...new Set(before.memberships.filter((m) => m.personId === me).map((m) => m.projectId)),
  ];
  const lost = new Set<string>();
  for (const projectId of scopes) {
    const had = effectivePermissionsIn(before, me, projectId);
    const has = effectivePermissionsIn(after, me, projectId);
    for (const p of had.keys()) if (!has.has(p)) lost.add(p);
  }
  const removed = (before.roles.find((r) => r.id === roleId)?.permissions ?? []).filter(
    (p) => !nextPermissions.includes(p),
  );
  // Nell'ordine dei permessi tolti; prima quelli tolti, poi il resto (non dovrebbe esserci).
  return [...removed.filter((p) => lost.has(p)), ...[...lost].filter((p) => !removed.includes(p))];
}
