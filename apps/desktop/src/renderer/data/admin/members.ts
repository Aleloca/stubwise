import {
  ALL_PROJECT_PERMISSIONS,
  accessState,
  effectivePermissions,
  effectivePermissionsIn,
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
  escalationIn,
  invariantRefusal,
  isActive,
  isHumanId,
  missingIn,
  nameOf,
  roleMissingIn,
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
  MemberDraft,
  MemberPreview,
  MemberRow,
  ProjectMembersView,
  RoleChoice,
  SourceView,
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
// il ruolo assegnato (quello che aggiunge rispetto al ruolo di prima), il
// permesso concesso e, per chi entra, i permessi dei suoi reparti. Togliere — un permesso, un membro, un ruolo verso uno
// più piccolo — non passa da lì: niente gerarchia (maintainer, 30 ott).
//
// Le revoche (`revocations`, solo prototipo per i test delle aree 2–8) qui
// non si scrivono né si mostrano; si azzerano quando il ruolo cambia o la
// persona esce dal progetto, insieme alle sue concessioni di progetto.

const MEMBERS_MANAGE = "project.members.manage";

/**
 * Il nome del ruolo del membro lì, per la voce del registro: il prima/dopo
 * di un permesso dato a mano si legge «Developer → Developer + …».
 */
const memberRoleName = (personId: string, projectId: string): string | undefined => {
  const m = accessState().memberships.find(
    (x) => x.personId === personId && x.projectId === projectId,
  );
  return m ? roleById(m.roleId)?.name : undefined;
};

/** I valori della voce di un permesso dato o tolto a mano. */
const permissionParams = (
  permission: string,
  projectId: string,
  role: string | undefined,
): Record<string, string> => ({
  permission,
  project: projectLabel(projectId),
  ...(role ? { role } : {}),
});

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
  return accessState()
    .roles.filter((r) => r.scope === "project")
    .map((r) => ({
      roleId: r.id,
      name: r.name,
      permissionCount: r.permissions.length,
      missing: roleMissingIn(me, [projectId], r),
    }));
}

/** I permessi di progetto che i reparti di una persona le danno, in ogni progetto di cui è membro. */
export const departmentPermissionsOf = (personId: string): string[] => [
  ...new Set(
    accessState()
      .departments.filter((d) => d.memberIds.includes(personId))
      .flatMap((d) => d.projectPermissions),
  ),
];

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
    granted: grantedIn(accessState(), personId, projectId),
  };
}

/** I permessi dati a mano a una persona in un progetto (le concessioni). */
const grantedIn = (s: AccessState, personId: string, projectId: string): string[] =>
  s.grants
    .filter((g) => g.personId === personId && g.projectId === projectId)
    .map((g) => g.permission);

/** Chi può entrare in un progetto: attivo, non full admin (può già tutto), non ancora membro. */
export const canJoin = (personId: string, projectId: string): boolean =>
  isHumanId(personId) &&
  isActive(personId) &&
  !isFullAdmin(personId) &&
  !membershipOf(accessState(), personId, projectId);

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

  const canManage = canI(me, MEMBERS_MANAGE, projectId);
  const addable = s.people
    .map((p) => p.personId)
    .filter((id) => canJoin(id, projectId))
    .sort((a, b) => (nameOf(a) ?? a).localeCompare(nameOf(b) ?? b));
  return {
    projectId,
    members,
    fullAdminNote: true,
    canManage,
    roleChoices: projectRoleChoices(me, projectId),
    // Si dà solo gestendo i membri, e solo ciò che si ha.
    grantable: ALL_PROJECT_PERMISSIONS.map((permission) => ({
      permission,
      allowed: canManage && missingIn(me, [projectId], [permission]).length === 0,
    })),
    addable,
    addableMissing: Object.fromEntries(
      addable.map((id) => [id, missingIn(me, [projectId], departmentPermissionsOf(id))]),
    ),
  };
}

/**
 * La regola UNICA di ogni appartenenza nuova data da qualcuno (Members, una
 * proposta della posta che aggiunge un incaricato): `null` se `me` può far
 * entrare `personId` in `projectId` col ruolo `roleId`, altrimenti il
 * rifiuto. Senza cancello e senza riconferma: li mette il chiamante.
 * Entrando, la persona riceve il ruolo E i permessi di progetto dei suoi
 * reparti: si danno entrambi (design, Members, «Regole»), misurati lì.
 */
export function judgeJoin(
  me: string,
  projectId: string,
  personId: string,
  roleId: string,
): AdminRefusal | null {
  if (!isHumanId(personId)) return refuse.notFound();
  if (!isActive(personId)) return refuse.invalid("deactivated");
  if (isFullAdmin(personId)) return refuse.invalid("full_admin");
  if (membershipOf(accessState(), personId, projectId)) return refuse.invalid("already_member");
  const role = roleById(roleId);
  if (!role || role.scope !== "project") return refuse.invalid("role");
  const departments = departmentPermissionsOf(personId);
  const missing = roleMissingIn(me, [projectId], role, undefined, departments);
  return missing.length === 0 ? null : { ok: false, error: "escalation", missing };
}

/**
 * L'unico scrittore di un'appartenenza nuova fuori dai test: la scrive e ne
 * lascia la voce `member.added` nel registro. Chi la chiama ha già giudicato
 * (`judgeJoin`); chi crea un progetto non ha niente da giudicare, ne diventa
 * il Project Lead come sul web, ma la voce c'è lo stesso.
 */
export function writeJoin(
  actorId: string,
  projectId: string,
  personId: string,
  roleId: string,
): void {
  const role = roleById(roleId)!;
  writeAccess((s) => {
    s.memberships.push({ personId, projectId, roleId });
  });
  recordChange({
    kind: "member.added",
    actorId,
    projectId,
    object: { type: "person", id: personId, label: nameOf(personId) ?? personId },
    after: role.name,
    params: { role: role.name, project: projectLabel(projectId) },
  });
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
  const refusal = judgeJoin(me, projectId, personId, roleId);
  if (refusal) return refusal;
  const reauth = reauthRefusal(me, "admin.addMember");
  if (reauth) return reauth;
  writeJoin(me, projectId, personId, roleId);
  return { ok: true };
}

/** L'uscita da un progetto: l'appartenenza, e con lei le concessioni e le revoche lì. */
const removeMutation = (projectId: string, personId: string) => (s: AccessState) => {
  s.memberships = s.memberships.filter(
    (m) => !(m.personId === personId && m.projectId === projectId),
  );
  s.grants = s.grants.filter((g) => !(g.personId === personId && g.projectId === projectId));
  s.revocations = s.revocations.filter(
    (r) => !(r.personId === personId && r.projectId === projectId),
  );
};

/** Toglie una persona dal progetto: con lei le sue concessioni e revoche lì (+R). */
export async function removeMember(projectId: string, personId: string): Promise<AdminResult> {
  const me = await writer("admin.removeMember");
  const blocked = managed(me, projectId);
  if (blocked) return blocked;
  if (!isHumanId(personId)) return refuse.notFound();
  const membership = membershipOf(accessState(), personId, projectId);
  if (!membership) return refuse.invalid("not_member");
  const mutate = removeMutation(projectId, personId);
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
  const missing = roleMissingIn(me, [projectId], role, before);
  if (missing.length > 0) return { ok: false, error: "escalation", missing };
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
  const escalation = escalationIn(me, [projectId], [permission]);
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
    params: permissionParams(permission, projectId, memberRoleName(personId, projectId)),
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
    params: permissionParams(permission, projectId, memberRoleName(personId, projectId)),
  });
  return { ok: true };
}

// --- la bozza del pannello del membro (Task 10) ---------------------------------
//
// Il pannello cambia ruolo e permessi dati a mano in una bozza, salvata in UN
// colpo con una riconferma (`saveMember`, tutto o niente). `judgeMember` è il
// giudizio unico della bozza: `previewMember` lo restituisce al pannello, che
// ne spegne scelte e Save; `saveMember` lo legge prima di scrivere. Si DÀ ciò
// che il ruolo nuovo aggiunge al ruolo salvato e ciò che la bozza concede in
// più; togliere non passa dall'anti-escalation (niente gerarchia, 30 ott).

function judgeMember(me: string, projectId: string, personId: string, draft: MemberDraft) {
  const s = accessState();
  const saved = roleById(membershipOf(s, personId, projectId)!.roleId)!;
  const role = roleById(draft.roleId)!;
  const savedGranted = grantedIn(s, personId, projectId);
  const granted = [...new Set(draft.granted)];
  const added = granted.filter((p) => !savedGranted.includes(p));
  const removed = savedGranted.filter((p) => !granted.includes(p));
  const roleChanged = role.id !== saved.id;
  const roleMissing = roleChanged ? roleMissingIn(me, [projectId], role, saved) : [];
  const at = now();
  /** La stessa funzione prova i blocchi e poi scrive (`invariantRefusal`, `writeAccess`). */
  const mutate = (st: AccessState) => {
    if (roleChanged) {
      membershipOf(st, personId, projectId)!.roleId = role.id;
      // Le revoche (solo prototipo) valevano sul ruolo di prima, come in `setMemberRole`.
      st.revocations = st.revocations.filter(
        (r) => !(r.personId === personId && r.projectId === projectId),
      );
    }
    st.grants = st.grants.filter(
      (g) =>
        !(g.personId === personId && g.projectId === projectId && removed.includes(g.permission)),
    );
    for (const permission of added)
      st.grants.push({ personId, projectId, permission, grantedById: me, at });
  };
  const invariant = invariantRefusal(mutate);
  return {
    saved,
    role,
    roleChanged,
    added,
    removed,
    missing: [...new Set([...roleMissing, ...missingIn(me, [projectId], added)])],
    block: invariant?.error === "invalid" ? invariant.reason : null,
    mutate,
  };
}

/** Le scelte di ruolo per un membro: ciò che manca a chi guarda per ciò che ognuno AGGIUNGE al ruolo salvato. */
function memberRoleChoices(me: string, projectId: string, saved: RoleDef): RoleChoice[] {
  return accessState()
    .roles.filter((r) => r.scope === "project")
    .map((r) => ({
      roleId: r.id,
      name: r.name,
      permissionCount: r.permissions.length,
      missing: roleMissingIn(me, [projectId], r, saved),
    }));
}

/** La bozza ha un ruolo di progetto esistente e soli permessi di progetto. */
function badDraft(draft: MemberDraft): AdminRefusal | null {
  const role = roleById(draft.roleId);
  if (!role || role.scope !== "project") return refuse.invalid("role");
  if (draft.granted.some((p) => !ALL_PROJECT_PERMISSIONS.includes(p)))
    return refuse.invalid("permission");
  return null;
}

/**
 * La lettura pura della bozza del pannello del membro: le fonti di ciò che la
 * persona potrebbe fare, le scelte di ruolo, l'escalation, i blocchi (della
 * bozza e di «Remove») e ciò che chi guarda perderebbe se la persona è lui.
 * Non scrive niente. Chi vede il progetto la legge (il pannello in sola
 * lettura); `not_found` per un progetto invisibile o chi non ne è membro (R-G5).
 */
export async function previewMember(
  projectId: string,
  personId: string,
  draft: MemberDraft,
): Promise<MemberPreview> {
  const me = await gate("admin.previewMember");
  if (!visibleProjectIds(me).has(projectId)) throw new Error("not_found");
  if (!isHumanId(personId) || !membershipOf(accessState(), personId, projectId))
    throw new Error("not_found");
  const bad = badDraft(draft);
  if (bad?.error === "invalid") throw new Error(`invalid: ${bad.reason}`);
  const j = judgeMember(me, projectId, personId, draft);
  const before = accessState();
  const after = structuredClone(before);
  j.mutate(after);
  // Un disattivato non ha permessi effettivi: qui si leggono quelli che il
  // ruolo, il reparto e le concessioni gli darebbero riattivandolo.
  const asActive = structuredClone(after);
  asActive.people.find((p) => p.personId === personId)!.status = "active";
  const permissions = [...effectivePermissionsIn(asActive, personId, projectId)]
    .map(([permission, sources]) => ({
      permission,
      sources: sources.map((source): SourceView => {
        const view = sourceView(source);
        return view.kind === "grant" && j.added.includes(permission)
          ? { ...view, origin: "draft" }
          : view;
      }),
    }))
    .sort((a, b) => a.permission.localeCompare(b.permission));
  const viewerLoses: string[] = [];
  if (personId === me) {
    const has = effectivePermissionsIn(after, me, projectId);
    for (const p of effectivePermissionsIn(before, me, projectId).keys())
      if (!has.has(p)) viewerLoses.push(p);
  }
  const removal = invariantRefusal(removeMutation(projectId, personId));
  // Le concessioni salvate che la bozza toglie, con chi le aveva date: la
  // riga resta modificabile e rimetterle non è un «dare» (`added` le esclude).
  const removing = j.removed.map((permission) => {
    const g = before.grants.find(
      (x) => x.personId === personId && x.projectId === projectId && x.permission === permission,
    )!;
    return {
      permission,
      source: sourceView({ kind: "grant", grantedById: g.grantedById, at: g.at }),
    };
  });
  return {
    permissions,
    removing,
    roleChoices: memberRoleChoices(me, projectId, j.saved),
    missing: j.missing,
    block: j.block,
    removeBlock: removal?.error === "invalid" ? removal.reason : null,
    viewerLoses: viewerLoses.sort(),
  };
}

/**
 * Salva la bozza del membro in un colpo (+R): ruolo e permessi dati a mano.
 * Si giudica la bozza intera (`judgeMember`, lo stesso giudizio della
 * preview) prima di scrivere: un rifiuto non lascia né scritture né voci.
 * Passata, una sola `writeAccess` e una voce del registro per ciò che cambia.
 */
export async function saveMember(
  projectId: string,
  personId: string,
  draft: MemberDraft,
): Promise<AdminResult> {
  const me = await writer("admin.saveMember");
  const blocked = managed(me, projectId);
  if (blocked) return blocked;
  if (!isHumanId(personId)) return refuse.notFound();
  if (!membershipOf(accessState(), personId, projectId)) return refuse.invalid("not_member");
  const bad = badDraft(draft);
  if (bad) return bad;
  const j = judgeMember(me, projectId, personId, draft);
  if (j.missing.length > 0) return { ok: false, error: "escalation", missing: j.missing };
  if (!j.roleChanged && j.added.length === 0 && j.removed.length === 0)
    return refuse.invalid("unchanged");
  if (j.block) return refuse.invalid(j.block);
  const reauth = reauthRefusal(me, "admin.saveMember");
  if (reauth) return reauth;
  writeAccess(j.mutate);
  const object = { type: "person" as const, id: personId, label: nameOf(personId) ?? personId };
  const project = projectLabel(projectId);
  if (j.roleChanged)
    recordChange({
      kind: "member.role_changed",
      actorId: me,
      projectId,
      object,
      before: j.saved.name,
      after: j.role.name,
      params: { project },
    });
  for (const permission of j.added)
    recordChange({
      kind: "member.permission_granted",
      actorId: me,
      projectId,
      object,
      after: permission,
      params: permissionParams(permission, projectId, j.role.name),
    });
  for (const permission of j.removed)
    recordChange({
      kind: "member.permission_revoked",
      actorId: me,
      projectId,
      object,
      before: permission,
      params: permissionParams(permission, projectId, j.role.name),
    });
  return { ok: true };
}
