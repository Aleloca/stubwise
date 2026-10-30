import {
  ALL_PROJECT_PERMISSIONS,
  accessState,
  effectivePermissions,
  isFullAdmin,
  writeAccess,
  type AccessState,
  type RoleDef,
} from "../access/index";
import { recordChange } from "../changelog/index";
import { gate, now, state, visibleProjectIds } from "../store";
import { writer } from "../writer";
import {
  avatarOf,
  canI,
  emailOf,
  escalationRefusal,
  invariantRefusal,
  isActive,
  isHumanId,
  missingFor,
  nameOf,
  reauthRefusal,
  refuse,
  roleById,
  sourceView,
  statusOf,
} from "./common";
import type {
  AdminRefusal,
  AdminResult,
  ExtraPermission,
  MemberRow,
  ProjectMembersView,
  RoleChoice,
} from "./types";
import "./changeTypes";

// Members del progetto (area 9a, Progetto → Settings → Members). Chi vede il
// progetto legge l'elenco; chi ha `project.members.manage` lì aggiunge,
// toglie, cambia ruolo, dà e toglie permessi in più — ogni scrittura con la
// riconferma. Né Claude né i full admin sono righe: i full admin possono
// tutto ovunque (la riga sotto l'elenco lo dice), Claude non ha appartenenze.
//
// L'anti-escalation vale su ciò che si DÀ, coi permessi effettivi di chi
// agisce in QUEL progetto (ruolo, concessioni, reparto, permessi locali):
// il ruolo assegnato (quello che aggiunge rispetto al ruolo di prima) e il
// permesso concesso. Togliere — un permesso, un membro, un ruolo verso uno
// più piccolo — non passa da lì: niente gerarchia (maintainer, 30 ott).
//
// Le revoche (`revocations`, solo prototipo per i test delle aree 2–8) qui
// non si scrivono né si mostrano; si azzerano quando il ruolo cambia o la
// persona esce dal progetto, insieme alle sue concessioni di progetto.

const MEMBERS_MANAGE = "project.members.manage";

/**
 * I permessi in più del ruolo di una persona in un progetto — quelli che il
 * ruolo non le dà — con le fonti: concessione personale o reparto. Le
 * revoche non si mostrano (le applica già il calcolo).
 */
export function extraPermissionsOf(personId: string, projectId: string): ExtraPermission[] {
  const out: ExtraPermission[] = [];
  for (const [permission, sources] of effectivePermissions(personId, projectId)) {
    if (sources.some((s) => s.kind === "role")) continue;
    const extra = sources.filter((s) => s.kind === "grant" || s.kind === "department");
    if (extra.length === 0) continue;
    out.push({
      permission,
      sources: extra.map(sourceView),
      granted: extra.some((s) => s.kind === "grant"),
    });
  }
  return out.sort((a, b) => a.permission.localeCompare(b.permission));
}

/** I ruoli di progetto con ciò che manca a `me` per darli in `projectId`. */
export function projectRoleChoices(me: string, projectId: string): RoleChoice[] {
  const mine = effectivePermissions(me, projectId);
  return accessState()
    .roles.filter((r) => r.scope === "project")
    .map((r) => ({
      roleId: r.id,
      name: r.name,
      permissionCount: r.permissions.length,
      missing: missingFor(mine, r.permissions),
    }));
}

const membershipOf = (s: AccessState, personId: string, projectId: string) =>
  s.memberships.find((m) => m.personId === personId && m.projectId === projectId);

function memberRow(personId: string, projectId: string, role: RoleDef): MemberRow {
  return {
    personId,
    name: nameOf(personId) ?? personId,
    email: emailOf(personId),
    avatar: avatarOf(personId),
    status: statusOf(personId) ?? "active",
    role: structuredClone(role),
    extra: extraPermissionsOf(personId, projectId),
  };
}

/** Il progetto su cui agire: visibile (o `not_found`), e chi agisce ne gestisce i membri (o `forbidden`). */
function managed(me: string, projectId: string): AdminRefusal | null {
  if (!visibleProjectIds(me).has(projectId)) return refuse.notFound();
  if (!canI(me, MEMBERS_MANAGE, projectId)) return refuse.forbidden();
  return null;
}

const projectLabel = (projectId: string): string => state.projectsById.get(projectId)?.code ?? "";

/** L'elenco dei membri. `not_found` per un progetto che chi guarda non vede (R-G5). */
export async function listProjectMembers(projectId: string): Promise<ProjectMembersView> {
  const me = await gate("admin.listProjectMembers");
  if (!visibleProjectIds(me).has(projectId)) throw new Error("not_found");
  const s = accessState();
  const members = s.memberships
    .filter((m) => m.projectId === projectId && isHumanId(m.personId) && !isFullAdmin(m.personId))
    .map((m) => memberRow(m.personId, projectId, roleById(m.roleId)!))
    // Le persone attive per nome; i disattivati in fondo.
    .sort(
      (a, b) =>
        Number(a.status === "deactivated") - Number(b.status === "deactivated") ||
        a.name.localeCompare(b.name),
    );
  const mine = effectivePermissions(me, projectId);
  const canManage = canI(me, MEMBERS_MANAGE, projectId);
  return {
    projectId,
    members,
    fullAdminNote: true,
    canManage,
    roleChoices: projectRoleChoices(me, projectId),
    // Si dà solo gestendo i membri, e solo ciò che si ha.
    grantable: ALL_PROJECT_PERMISSIONS.map((permission) => ({
      permission,
      allowed: canManage && missingFor(mine, [permission]).length === 0,
    })),
    addable: s.people
      .filter(
        (p) =>
          p.status === "active" &&
          !isFullAdmin(p.personId) &&
          !membershipOf(s, p.personId, projectId),
      )
      .map((p) => p.personId)
      .sort((a, b) => (nameOf(a) ?? a).localeCompare(nameOf(b) ?? b)),
  };
}

/** Aggiunge una persona attiva al progetto con un ruolo (`project.members.manage`, +R). */
export async function addMember(
  projectId: string,
  personId: string,
  roleId: string,
): Promise<AdminResult> {
  const me = await writer("admin.addMember");
  const blocked = managed(me, projectId);
  if (blocked) return blocked;
  if (!isHumanId(personId)) return refuse.notFound();
  if (!isActive(personId)) return refuse.invalid("deactivated");
  if (isFullAdmin(personId)) return refuse.invalid("full_admin");
  if (membershipOf(accessState(), personId, projectId)) return refuse.invalid("already_member");
  const role = roleById(roleId);
  if (!role || role.scope !== "project") return refuse.invalid("role");
  const escalation = escalationRefusal(effectivePermissions(me, projectId), role.permissions);
  if (escalation) return escalation;
  const reauth = reauthRefusal(me, "admin.addMember");
  if (reauth) return reauth;
  writeAccess((s) => {
    s.memberships.push({ personId, projectId, roleId });
  });
  recordChange({
    kind: "member.added",
    actorId: me,
    projectId,
    object: { type: "person", id: personId, label: nameOf(personId) ?? personId },
    after: role.name,
    params: { role: role.name, project: projectLabel(projectId) },
  });
  return { ok: true };
}

/** Toglie una persona dal progetto: con lei le sue concessioni e revoche lì (+R). */
export async function removeMember(projectId: string, personId: string): Promise<AdminResult> {
  const me = await writer("admin.removeMember");
  const blocked = managed(me, projectId);
  if (blocked) return blocked;
  if (!isHumanId(personId)) return refuse.notFound();
  const membership = membershipOf(accessState(), personId, projectId);
  if (!membership) return refuse.invalid("not_member");
  const mutate = (s: AccessState) => {
    s.memberships = s.memberships.filter(
      (m) => !(m.personId === personId && m.projectId === projectId),
    );
    s.grants = s.grants.filter((g) => !(g.personId === personId && g.projectId === projectId));
    s.revocations = s.revocations.filter(
      (r) => !(r.personId === personId && r.projectId === projectId),
    );
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.removeMember");
  if (reauth) return reauth;
  const roleName = roleById(membership.roleId)?.name ?? "";
  writeAccess(mutate);
  recordChange({
    kind: "member.removed",
    actorId: me,
    projectId,
    object: { type: "person", id: personId, label: nameOf(personId) ?? personId },
    before: roleName,
    params: { project: projectLabel(projectId) },
  });
  return { ok: true };
}

/**
 * Cambia il ruolo di un membro (+R). Si dà ciò che il ruolo nuovo aggiunge a
 * quello di prima: un ruolo più piccolo non passa dall'anti-escalation. Le
 * revoche della persona nel progetto si azzerano: valevano sul ruolo di prima.
 */
export async function setMemberRole(
  projectId: string,
  personId: string,
  roleId: string,
): Promise<AdminResult> {
  const me = await writer("admin.setMemberRole");
  const blocked = managed(me, projectId);
  if (blocked) return blocked;
  if (!isHumanId(personId)) return refuse.notFound();
  const membership = membershipOf(accessState(), personId, projectId);
  if (!membership) return refuse.invalid("not_member");
  const role = roleById(roleId);
  if (!role || role.scope !== "project") return refuse.invalid("role");
  const before = roleById(membership.roleId);
  if (role.id === before?.id) return refuse.invalid("unchanged");
  const added = role.permissions.filter((p) => !before?.permissions.includes(p));
  const escalation = escalationRefusal(effectivePermissions(me, projectId), added);
  if (escalation) return escalation;
  const mutate = (s: AccessState) => {
    membershipOf(s, personId, projectId)!.roleId = role.id;
    s.revocations = s.revocations.filter(
      (r) => !(r.personId === personId && r.projectId === projectId),
    );
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.setMemberRole");
  if (reauth) return reauth;
  writeAccess(mutate);
  recordChange({
    kind: "member.role_changed",
    actorId: me,
    projectId,
    object: { type: "person", id: personId, label: nameOf(personId) ?? personId },
    before: before?.name ?? null,
    after: role.name,
    params: { project: projectLabel(projectId) },
  });
  return { ok: true };
}

/** Dà a un membro un permesso di progetto in più, purché chi lo dà lo abbia lì (+R). */
export async function grantMemberPermission(
  projectId: string,
  personId: string,
  permission: string,
): Promise<AdminResult> {
  const me = await writer("admin.grantMemberPermission");
  const blocked = managed(me, projectId);
  if (blocked) return blocked;
  if (!isHumanId(personId)) return refuse.notFound();
  if (!membershipOf(accessState(), personId, projectId)) return refuse.invalid("not_member");
  if (!ALL_PROJECT_PERMISSIONS.includes(permission)) return refuse.invalid("permission");
  const escalation = escalationRefusal(effectivePermissions(me, projectId), [permission]);
  if (escalation) return escalation;
  const exists = accessState().grants.some(
    (g) => g.personId === personId && g.projectId === projectId && g.permission === permission,
  );
  if (exists) return refuse.invalid("already_granted");
  const reauth = reauthRefusal(me, "admin.grantMemberPermission");
  if (reauth) return reauth;
  writeAccess((s) => {
    s.grants.push({ personId, projectId, permission, grantedById: me, at: now() });
  });
  recordChange({
    kind: "member.permission_granted",
    actorId: me,
    projectId,
    object: { type: "person", id: personId, label: nameOf(personId) ?? personId },
    after: permission,
    params: { permission, project: projectLabel(projectId) },
  });
  return { ok: true };
}

/**
 * Toglie un permesso dato a mano (+R). Solo le concessioni personali: ciò che
 * viene dal ruolo o dal reparto si cambia lì. Togliere non passa
 * dall'anti-escalation (niente gerarchia), ma dai blocchi sì.
 */
export async function revokeMemberPermission(
  projectId: string,
  personId: string,
  permission: string,
): Promise<AdminResult> {
  const me = await writer("admin.revokeMemberPermission");
  const blocked = managed(me, projectId);
  if (blocked) return blocked;
  if (!isHumanId(personId)) return refuse.notFound();
  const matches = (g: { personId: string; projectId: string | null; permission: string }) =>
    g.personId === personId && g.projectId === projectId && g.permission === permission;
  if (!accessState().grants.some(matches)) return refuse.invalid("not_granted");
  const mutate = (s: AccessState) => {
    s.grants = s.grants.filter((g) => !matches(g));
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.revokeMemberPermission");
  if (reauth) return reauth;
  writeAccess(mutate);
  recordChange({
    kind: "member.permission_revoked",
    actorId: me,
    projectId,
    object: { type: "person", id: personId, label: nameOf(personId) ?? personId },
    before: permission,
    params: { permission, project: projectLabel(projectId) },
  });
  return { ok: true };
}
