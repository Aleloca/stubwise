import {
  accessState,
  effectivePermissionsIn,
  isFullAdminIn,
  roleIdOf,
  seatsIn,
  writeAccess,
  type AccessState,
  type RoleDef,
} from "../access/index";
import {
  avatarOf,
  canI,
  emailOf,
  isActive,
  isHumanId,
  nameOf,
  reauthRefusal,
  refuse,
  roleById,
  roleMissingIn,
  statusOf,
} from "../admin/common";
import { recordChange } from "../changelog/index";
import { archivedProjectIdsFor, gate, newId, now, state, visibleProjectIds } from "../store";
import { writer } from "../writer";
import "./changeTypes";
import type {
  AdminRefusal,
  AdminResult,
  PersonRef,
  WorkspaceEffect,
  WorkspaceList,
  WorkspaceMemberProject,
  WorkspaceMemberRow,
  WorkspaceMembersView,
  WorkspaceOperation,
  WorkspaceView,
} from "./types";

export type * from "./types";

// Le workspace nel prototipo (shape `workspaces.md`, decisioni del 27 nov
// 2026). Una workspace raggruppa PROGETTI per visibilità: chi ne fa parte
// vede tutti i suoi progetti col ruolo di workspace, che si somma al ruolo per
// progetto (D1). Le regole di chi vede cosa stanno in `access/seats.ts`;
// qui le letture per la UI, l'effetto prima di salvare e le scritture:
// - gestisce le workspace chi ha `workspaces.manage` (D4, il full admin);
// - mettere, togliere o spostare un progetto vuole anche
//   `project.members.manage` in quel progetto (D4), perché cambia chi lo vede;
// - invitare vale l'escalation su TUTTI i progetti della workspace;
// - ogni scrittura che apre o chiude un accesso chiede la riconferma (D11,
//   [WS 4]); rinominare no;
// - nessuna lascia un progetto senza chi ne gestisca i membri (D18,
//   `last_manager`, fuori dai full admin).
// L'effetto (`previewWorkspace`) e la scrittura applicano la STESSA funzione
// (`applyOperation`) su una copia e sullo stato: rispondono allo stesso modo.

const MANAGE = "workspaces.manage";
const MEMBERS_MANAGE = "project.members.manage";

const projectOf = (projectId: string) => state.projectsById.get(projectId);
const codeOf = (projectId: string): string => projectOf(projectId)?.code ?? "";
const ref = (personId: string): PersonRef => ({ personId, name: nameOf(personId) ?? personId });
const byName = (a: PersonRef, b: PersonRef) => a.name.localeCompare(b.name);

const workspaceById = (s: AccessState, id: string) => s.workspaces.find((w) => w.id === id);
const projectsIn = (s: AccessState, workspaceId: string): string[] =>
  s.workspaceProjects.filter((w) => w.workspaceId === workspaceId).map((w) => w.projectId);

/** I progetti che chi guarda vede, aperti E archiviati (D6: un archiviato resta nella sua workspace). */
const seenProjectIds = (me: string): Set<string> =>
  new Set([...visibleProjectIds(me), ...archivedProjectIdsFor(me)]);

/**
 * D5: chi vede una workspace. Chi ne vede almeno un progetto, o ne fa parte;
 * un full admin le vede tutte. Le altre non esistono per chi guarda.
 */
function seesWorkspace(me: string, workspaceId: string): boolean {
  const s = accessState();
  if (isFullAdminIn(s, me)) return true;
  if (s.workspaceMembers.some((m) => m.workspaceId === workspaceId && m.personId === me)) return true;
  const seen = seenProjectIds(me);
  return projectsIn(s, workspaceId).some((p) => seen.has(p));
}

/** Lo slug dal nome: minuscole senza accenti, trattini, unico. */
function slugFor(name: string, s: AccessState, exceptId?: string): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const taken = new Set(s.workspaces.filter((w) => w.id !== exceptId).map((w) => w.slug));
  if (!taken.has(base) && base !== "none") return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Un nome valido: non vuoto, al più 60 caratteri, non già usato (senza badare alle maiuscole). */
function nameRefusal(name: string, s: AccessState, exceptId?: string): AdminRefusal | null {
  const trimmed = name.trim();
  if (trimmed === "") return refuse.invalid("name_required");
  if (trimmed.length > 60) return refuse.invalid("name_too_long");
  const clash = s.workspaces.some(
    (w) => w.id !== exceptId && w.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? refuse.invalid("name_taken") : null;
}

// --- le letture -------------------------------------------------------------

/** La colonna di All projects: le workspace che chi guarda vede, e quanti progetti fuori. */
export async function listWorkspaces(): Promise<WorkspaceList> {
  const me = await gate("workspaces.list");
  const s = accessState();
  const open = visibleProjectIds(me);
  const inSome = new Set(s.workspaceProjects.map((w) => w.projectId));
  return {
    workspaces: s.workspaces
      .filter((w) => seesWorkspace(me, w.id))
      .map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        projectCount: projectsIn(s, w.id).filter((p) => open.has(p)).length,
        isMember: s.workspaceMembers.some((m) => m.workspaceId === w.id && m.personId === me),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    noWorkspaceCount: [...open].filter((p) => !inSome.has(p)).length,
    workspaceOfProject: Object.fromEntries(
      s.workspaceProjects
        .filter((w) => seenProjectIds(me).has(w.projectId))
        .map((w) => [w.projectId, w.workspaceId]),
    ),
    canManage: canI(me, MANAGE),
  };
}

/** Una workspace per slug; `not_found` se chi guarda non la vede (R-G5). */
export async function getWorkspace(slug: string): Promise<WorkspaceView> {
  const me = await gate("workspaces.get");
  const s = accessState();
  const ws = s.workspaces.find((w) => w.slug === slug);
  if (!ws || !seesWorkspace(me, ws.id)) throw new Error("not_found");
  const seen = seenProjectIds(me);
  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    projectIds: projectsIn(s, ws.id).filter((p) => seen.has(p)),
    peopleCount: s.workspaceMembers.filter((m) => m.workspaceId === ws.id).length,
    canManage: canI(me, MANAGE),
  };
}

/**
 * La workspace di un progetto (Settings → General), o `null`, e se chi guarda
 * può cambiarla: `workspaces.manage` E la gestione dei membri del progetto
 * (D4). La pagina lo legge da qui, non lo deduce.
 */
export async function workspaceOfProject(
  projectId: string,
): Promise<{ workspace: { id: string; slug: string; name: string } | null; canChange: boolean }> {
  const me = await gate("workspaces.ofProject");
  if (!seenProjectIds(me).has(projectId)) throw new Error("not_found");
  const s = accessState();
  const row = s.workspaceProjects.find((w) => w.projectId === projectId);
  const ws = row && workspaceById(s, row.workspaceId);
  return {
    workspace: ws ? { id: ws.id, slug: ws.slug, name: ws.name } : null,
    canChange: canI(me, MANAGE) && canI(me, MEMBERS_MANAGE, projectId),
  };
}

function memberProjects(
  s: AccessState,
  personId: string,
  workspaceRole: RoleDef,
  projectIds: readonly string[],
): WorkspaceMemberProject[] {
  return projectIds
    .map((projectId) => {
      const m = s.memberships.find((x) => x.personId === personId && x.projectId === projectId);
      const own = m && roleById(m.roleId);
      return {
        projectId,
        code: codeOf(projectId),
        name: projectOf(projectId)?.name ?? "",
        roles: [
          ...(own ? [{ roleName: own.name, source: "member" as const }] : []),
          { roleName: workspaceRole.name, source: "workspace" as const },
        ],
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** La scheda People di una workspace: chi c'è, coi ruoli per progetto in più. */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembersView> {
  const me = await gate("workspaces.listMembers");
  if (!seesWorkspace(me, workspaceId)) throw new Error("not_found");
  const s = accessState();
  const seen = seenProjectIds(me);
  const projectIds = projectsIn(s, workspaceId).filter((p) => seen.has(p));
  const canManage = canI(me, MANAGE);
  const members: WorkspaceMemberRow[] = s.workspaceMembers
    .filter((m) => m.workspaceId === workspaceId && isHumanId(m.personId))
    .map((m) => {
      const role = roleById(m.roleId)!;
      const projects = memberProjects(s, m.personId, role, projectIds);
      return {
        personId: m.personId,
        name: nameOf(m.personId) ?? m.personId,
        email: emailOf(m.personId),
        avatar: avatarOf(m.personId),
        status: statusOf(m.personId) ?? "active",
        roleId: role.id,
        roleName: role.name,
        projectRoles: projects.flatMap((p) =>
          p.roles
            .filter((r) => r.source === "member")
            .map((r) => ({ projectId: p.projectId, code: p.code, roleName: r.roleName })),
        ),
        projects,
      };
    })
    .sort(
      (a, b) =>
        Number(a.status === "deactivated") - Number(b.status === "deactivated") ||
        a.name.localeCompare(b.name),
    );
  const inside = new Set(members.map((m) => m.personId));
  const humans = s.people.map((p) => p.personId).filter((id) => isHumanId(id) && isActive(id));
  const allProjects = projectsIn(s, workspaceId);
  return {
    workspaceId,
    members,
    canManage,
    roleChoices: s.roles
      .filter((r) => r.scope === "project")
      .map((r) => {
        const missingIn = allProjects.filter((p) => roleMissingIn(me, [p], r).length > 0);
        return {
          roleId: r.id,
          name: r.name,
          permissionCount: r.permissions.length,
          missing: allProjects.length === 0 ? [] : roleMissingIn(me, allProjects, r),
          missingIn: missingIn.map(codeOf),
        };
      }),
    defaultRoleId: roleIdOf("viewer"),
    addable: humans
      .filter((id) => !inside.has(id) && !isFullAdminIn(s, id))
      .map(ref)
      .sort(byName),
    fullAdmins: humans.filter((id) => isFullAdminIn(s, id)).map(ref).sort(byName),
  };
}

// --- l'effetto di un'operazione ---------------------------------------------

/** Applica l'operazione a uno stato (la copia dell'anteprima o quello vero). */
function applyOperation(s: AccessState, op: WorkspaceOperation, newId?: string): void {
  switch (op.kind) {
    case "create": {
      const id = newId ?? "ws-preview";
      for (const projectId of op.projectIds) {
        s.workspaceProjects = s.workspaceProjects.filter((w) => w.projectId !== projectId);
        s.workspaceProjects.push({ workspaceId: id, projectId });
      }
      return;
    }
    case "addProject":
      s.workspaceProjects = s.workspaceProjects.filter((w) => w.projectId !== op.projectId);
      s.workspaceProjects.push({ workspaceId: op.workspaceId, projectId: op.projectId });
      return;
    case "addProjects":
      for (const projectId of op.projectIds) {
        s.workspaceProjects = s.workspaceProjects.filter((w) => w.projectId !== projectId);
        s.workspaceProjects.push({ workspaceId: op.workspaceId, projectId });
      }
      return;
    case "removeProject":
      s.workspaceProjects = s.workspaceProjects.filter((w) => w.projectId !== op.projectId);
      return;
    case "delete":
      s.workspaceProjects = s.workspaceProjects.filter((w) => w.workspaceId !== op.workspaceId);
      s.workspaceMembers = s.workspaceMembers.filter((m) => m.workspaceId !== op.workspaceId);
      s.workspaces = s.workspaces.filter((w) => w.id !== op.workspaceId);
      return;
    case "addMember":
      s.workspaceMembers.push({ workspaceId: op.workspaceId, personId: op.personId, roleId: op.roleId });
      return;
    case "setMemberRole": {
      const m = s.workspaceMembers.find(
        (x) => x.workspaceId === op.workspaceId && x.personId === op.personId,
      );
      if (m) m.roleId = op.roleId;
      return;
    }
    case "removeMember": {
      const projects = new Set(projectsIn(s, op.workspaceId));
      s.workspaceMembers = s.workspaceMembers.filter(
        (m) => !(m.workspaceId === op.workspaceId && m.personId === op.personId),
      );
      // D12: i ruoli per progetto restano, salvo la casella (spenta di base).
      if (op.alsoFromProjects) {
        const out = (x: { personId: string; projectId: string | null }) =>
          x.personId === op.personId && x.projectId !== null && projects.has(x.projectId);
        s.memberships = s.memberships.filter((m) => !out(m));
        s.grants = s.grants.filter((g) => !out(g));
        s.revocations = s.revocations.filter((r) => !out(r));
      }
      return;
    }
  }
}

/** I progetti che l'operazione tocca. */
function touchedProjects(s: AccessState, op: WorkspaceOperation): string[] {
  switch (op.kind) {
    case "create":
    case "addProjects":
      return op.projectIds;
    case "addProject":
    case "removeProject":
      return [op.projectId];
    case "delete":
    case "addMember":
    case "setMemberRole":
    case "removeMember":
      return projectsIn(s, op.workspaceId);
  }
}

/** Chi vede un progetto da membro, fuori dai full admin (che lo vedono comunque) e da chi non è attivo. */
function seers(s: AccessState, projectId: string): Set<string> {
  return new Set(
    seatsIn(s)
      .filter((x) => x.projectId === projectId)
      .map((x) => x.personId)
      .filter((id) => isHumanId(id) && isActive(id) && !isFullAdminIn(s, id)),
  );
}

/** Chi gestisce i membri, fuori dai full admin (D18 del design). */
function managers(s: AccessState, projectId: string): string[] {
  return [...seers(s, projectId)].filter((id) =>
    effectivePermissionsIn(s, id, projectId).has(MEMBERS_MANAGE),
  );
}

/** I ruoli che l'operazione DÀ nei progetti che tocca, per l'escalation. */
function givenRoles(s: AccessState, op: WorkspaceOperation): RoleDef[] {
  const membersOf = (workspaceId: string) =>
    s.workspaceMembers.filter((m) => m.workspaceId === workspaceId).map((m) => roleById(m.roleId)!);
  switch (op.kind) {
    case "addProject":
    case "addProjects":
      return membersOf(op.workspaceId);
    case "addMember":
    case "setMemberRole":
      return [roleById(op.roleId)!];
    default:
      return [];
  }
}

function effectOf(me: string, op: WorkspaceOperation): WorkspaceEffect {
  const before = accessState();
  const after = structuredClone(before);
  applyOperation(after, op);
  // Per codice: le frasi elencano i progetti in ordine.
  const projects = [...touchedProjects(before, op)].sort((a, b) => codeOf(a).localeCompare(codeOf(b)));
  const effect: WorkspaceEffect = { projects: [], lastManager: [], escalation: [], notManaged: [] };
  for (const projectId of projects) {
    const was = seers(before, projectId);
    const now = seers(after, projectId);
    effect.projects.push({
      projectId,
      code: codeOf(projectId),
      startSeeing: [...now].filter((id) => !was.has(id)).map(ref).sort(byName),
      stopSeeing: [...was].filter((id) => !now.has(id)).map(ref).sort(byName),
    });
    if (managers(before, projectId).length > 0 && managers(after, projectId).length === 0) {
      effect.lastManager.push(codeOf(projectId));
    }
    const missing = [
      ...new Set(givenRoles(before, op).flatMap((r) => roleMissingIn(me, [projectId], r))),
    ];
    if (missing.length > 0) effect.escalation.push({ code: codeOf(projectId), missing });
  }
  // D4: mettere, togliere o spostare un progetto vuole chi ne gestisce i membri.
  if (op.kind === "create" || op.kind === "addProject" || op.kind === "addProjects" || op.kind === "removeProject") {
    effect.notManaged = projects.filter((p) => !canI(me, MEMBERS_MANAGE, p)).map(codeOf);
  }
  return effect;
}

/** Il rifiuto di un'operazione, dal suo effetto: lo stesso controllo dell'anteprima e della scrittura. */
function refusalOf(effect: WorkspaceEffect): AdminRefusal | null {
  if (effect.notManaged.length > 0) return refuse.forbidden();
  if (effect.escalation.length > 0) {
    return { ok: false, error: "escalation", missing: [...new Set(effect.escalation.flatMap((e) => e.missing))] };
  }
  if (effect.lastManager.length > 0) return refuse.invalid("last_manager");
  return null;
}

/**
 * Prima di salvare: chi comincia e chi smette di vedere ogni progetto toccato,
 * e cosa lo bloccherebbe (design §2.2, `POST /api/workspaces/effect`). Non scrive.
 */
export async function previewWorkspace(op: WorkspaceOperation): Promise<WorkspaceEffect> {
  const me = await gate("workspaces.preview");
  if (!canI(me, MANAGE)) throw new Error("forbidden");
  const blocked = targetRefusal(me, op);
  if (blocked) throw new Error(blocked.error === "invalid" ? blocked.reason : blocked.error);
  return effectOf(me, op);
}

/** La workspace e il progetto o la persona dell'operazione esistono e si vedono. */
function targetRefusal(me: string, op: WorkspaceOperation): AdminRefusal | null {
  const s = accessState();
  const seen = seenProjectIds(me);
  if ("workspaceId" in op && !workspaceById(s, op.workspaceId)) return refuse.notFound();
  if ("projectId" in op && !seen.has(op.projectId)) return refuse.notFound();
  if ((op.kind === "create" || op.kind === "addProjects") && op.projectIds.some((p) => !seen.has(p)))
    return refuse.notFound();
  if (op.kind === "addMember") {
    if (!isHumanId(op.personId)) return refuse.notFound();
    if (!isActive(op.personId)) return refuse.invalid("deactivated");
    if (isFullAdminIn(s, op.personId)) return refuse.invalid("full_admin");
    if (s.workspaceMembers.some((m) => m.workspaceId === op.workspaceId && m.personId === op.personId))
      return refuse.invalid("already_member");
  }
  if (op.kind === "setMemberRole" || op.kind === "removeMember") {
    if (!s.workspaceMembers.some((m) => m.workspaceId === op.workspaceId && m.personId === op.personId))
      return refuse.invalid("not_member");
  }
  if (op.kind === "addMember" || op.kind === "setMemberRole") {
    const role = roleById(op.roleId);
    if (!role || role.scope !== "project") return refuse.invalid("role");
  }
  return null;
}

// --- le scritture -----------------------------------------------------------

type Fn =
  | "workspaces.create"
  | "workspaces.delete"
  | "workspaces.setProjectWorkspace"
  | "workspaces.addMember"
  | "workspaces.setMemberRole"
  | "workspaces.removeMember";

/**
 * Il percorso comune: permesso, bersaglio, effetto, riconferma, scrittura.
 * Un rifiuto non lascia né scritture né voci.
 */
function judgeAndWrite(
  me: string,
  fn: Fn,
  op: WorkspaceOperation,
  write: (s: AccessState) => void,
): AdminResult {
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const target = targetRefusal(me, op);
  if (target) return target;
  const refusal = refusalOf(effectOf(me, op));
  if (refusal) return refusal;
  const reauth = reauthRefusal(me, fn);
  if (reauth) return reauth;
  writeAccess(write);
  return { ok: true };
}

const workspaceLabel = (id: string) => ({
  type: "workspace",
  id,
  label: workspaceById(accessState(), id)?.name ?? "",
});

/** Crea una workspace, anche con dei progetti (D11: con progetti, la riconferma). */
export async function createWorkspace(
  name: string,
  projectIds: readonly string[] = [],
): Promise<{ ok: true; slug: string } | AdminRefusal> {
  const me = await writer("workspaces.create");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const s = accessState();
  const bad = nameRefusal(name, s);
  if (bad) return bad;
  const op: WorkspaceOperation = { kind: "create", projectIds: [...projectIds] };
  const target = targetRefusal(me, op);
  if (target) return target;
  const refusal = refusalOf(effectOf(me, op));
  if (refusal) return refusal;
  // Una workspace vuota non apre accessi a nessuno: niente riconferma.
  if (projectIds.length > 0) {
    const reauth = reauthRefusal(me, "workspaces.create");
    if (reauth) return reauth;
  }
  const id = newId("ws");
  const slug = slugFor(name, s);
  writeAccess((a) => {
    a.workspaces.push({ id, slug, name: name.trim(), createdAt: now() });
    applyOperation(a, op, id);
  });
  recordChange({ kind: "workspace.created", actorId: me, projectId: null, object: workspaceLabel(id) });
  for (const projectId of projectIds) recordProject(me, id, projectId, "workspace.project_added");
  return { ok: true, slug };
}

/** Rinomina: non cambia nessun accesso, quindi niente riconferma. Lo slug segue il nome. */
export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<{ ok: true; slug: string } | AdminRefusal> {
  const me = await writer("workspaces.rename");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const s = accessState();
  const ws = workspaceById(s, workspaceId);
  if (!ws) return refuse.notFound();
  const bad = nameRefusal(name, s, workspaceId);
  if (bad) return bad;
  if (ws.name === name.trim()) return { ok: true, slug: ws.slug };
  const before = ws.name;
  const slug = slugFor(name, s, workspaceId);
  writeAccess((a) => {
    const w = workspaceById(a, workspaceId)!;
    w.name = name.trim();
    w.slug = slug;
  });
  recordChange({
    kind: "workspace.updated",
    actorId: me,
    projectId: null,
    object: workspaceLabel(workspaceId),
    before,
    after: name.trim(),
  });
  return { ok: true, slug };
}

/** Elimina: i progetti restano, in «No workspace»; le persone perdono l'accesso derivato. */
export async function deleteWorkspace(workspaceId: string): Promise<AdminResult> {
  const me = await writer("workspaces.delete");
  const object = workspaceLabel(workspaceId);
  const op: WorkspaceOperation = { kind: "delete", workspaceId };
  const result = judgeAndWrite(me, "workspaces.delete", op, (a) => applyOperation(a, op));
  if (result.ok) recordChange({ kind: "workspace.deleted", actorId: me, projectId: null, object });
  return result;
}

/** La voce sul progetto messo in una workspace o tolto (scope di progetto, come `member.*`). */
function recordProject(me: string, workspaceId: string, projectId: string, kind: string) {
  const ws = workspaceLabel(workspaceId);
  recordChange({
    kind,
    actorId: me,
    projectId,
    object: ws,
    params: { workspaceName: ws.label, project: codeOf(projectId) },
  });
}

/**
 * Mette un progetto in una workspace (anche spostandolo da un'altra), o lo
 * toglie con `null`. D4: serve anche chi gestisce i membri del progetto.
 */
export async function setProjectWorkspace(
  projectId: string,
  workspaceId: string | null,
): Promise<AdminResult> {
  const me = await writer("workspaces.setProjectWorkspace");
  const s = accessState();
  const current = s.workspaceProjects.find((w) => w.projectId === projectId)?.workspaceId ?? null;
  if (current === workspaceId) return refuse.invalid("unchanged");
  const op: WorkspaceOperation =
    workspaceId === null ? { kind: "removeProject", projectId } : { kind: "addProject", workspaceId, projectId };
  const result = judgeAndWrite(me, "workspaces.setProjectWorkspace", op, (a) => applyOperation(a, op));
  if (result.ok) {
    if (current) recordProject(me, current, projectId, "workspace.project_removed");
    if (workspaceId) recordProject(me, workspaceId, projectId, "workspace.project_added");
  }
  return result;
}

/** Le voci dei membri: l'oggetto è la persona, la workspace nei valori. */
const personObject = (personId: string) => ({
  type: "person",
  id: personId,
  label: nameOf(personId) ?? personId,
});
const memberParams = (workspaceId: string, roleId: string) => ({
  workspaceName: workspaceLabel(workspaceId).label,
  roleName: roleById(roleId)?.name ?? "",
});

/** Invita una persona che ha già un account (D9), col ruolo di workspace (D3: di base Viewer). */
export async function addWorkspaceMember(
  workspaceId: string,
  personId: string,
  roleId: string = roleIdOf("viewer"),
): Promise<AdminResult> {
  const me = await writer("workspaces.addMember");
  const op: WorkspaceOperation = { kind: "addMember", workspaceId, personId, roleId };
  const result = judgeAndWrite(me, "workspaces.addMember", op, (a) => applyOperation(a, op));
  if (result.ok) {
    recordChange({
      kind: "workspace.member_added",
      actorId: me,
      projectId: null,
      object: personObject(personId),
      params: { ...memberParams(workspaceId, roleId), roleId },
    });
  }
  return result;
}

/** Cambia il ruolo di workspace: vale in ogni progetto della workspace. */
export async function setWorkspaceMemberRole(
  workspaceId: string,
  personId: string,
  roleId: string,
): Promise<AdminResult> {
  const me = await writer("workspaces.setMemberRole");
  const before = accessState().workspaceMembers.find(
    (m) => m.workspaceId === workspaceId && m.personId === personId,
  );
  if (before?.roleId === roleId) return refuse.invalid("unchanged");
  const beforeName = before ? roleById(before.roleId)?.name : undefined;
  const op: WorkspaceOperation = { kind: "setMemberRole", workspaceId, personId, roleId };
  const result = judgeAndWrite(me, "workspaces.setMemberRole", op, (a) => applyOperation(a, op));
  if (result.ok) {
    recordChange({
      kind: "workspace.member_role_changed",
      actorId: me,
      projectId: null,
      object: personObject(personId),
      before: beforeName ?? null,
      after: roleById(roleId)?.name ?? null,
      params: memberParams(workspaceId, roleId),
    });
  }
  return result;
}

/** Toglie una persona: i suoi ruoli per progetto restano, salvo `alsoFromProjects` (D12). */
export async function removeWorkspaceMember(
  workspaceId: string,
  personId: string,
  alsoFromProjects = false,
): Promise<AdminResult> {
  const me = await writer("workspaces.removeMember");
  const s = accessState();
  const m = s.workspaceMembers.find((x) => x.workspaceId === workspaceId && x.personId === personId);
  // D12 con la casella: le appartenenze per progetto che se ne vanno, coi loro ruoli (per `member.removed`).
  const leaving = alsoFromProjects
    ? s.memberships
        .filter((x) => x.personId === personId && projectsIn(s, workspaceId).includes(x.projectId))
        .map((x) => ({ projectId: x.projectId, roleName: roleById(x.roleId)?.name ?? "" }))
        .sort((a, b) => codeOf(a.projectId).localeCompare(codeOf(b.projectId)))
    : [];
  const op: WorkspaceOperation = { kind: "removeMember", workspaceId, personId, alsoFromProjects };
  const result = judgeAndWrite(me, "workspaces.removeMember", op, (a) => applyOperation(a, op));
  if (result.ok && m) {
    recordChange({
      kind: "workspace.member_removed",
      actorId: me,
      projectId: null,
      object: personObject(personId),
      params: { ...memberParams(workspaceId, m.roleId), alsoProjects: String(alsoFromProjects) },
    });
    // La `member.removed` di sempre, come sul server: la memoria «chi lo conosceva».
    for (const l of leaving) {
      recordChange({
        kind: "member.removed",
        actorId: me,
        projectId: l.projectId,
        object: personObject(personId),
        before: l.roleName,
        params: { project: codeOf(l.projectId) },
      });
    }
  }
  return result;
}
