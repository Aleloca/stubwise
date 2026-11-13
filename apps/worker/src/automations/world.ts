import { departmentMembers, milestones, projectMembers, projects, roles, users, type Db } from "@stubwise/db";
import { projectPermissionsByProject, userIsFullAdmin } from "@stubwise/notifications";
import type { PlanPerson, PlanWorld } from "@stubwise/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * IL MONDO DEI PIANI letto dal DB (area 7, fetta 1): i piani delle azioni
 * (`plans.ts` di `@stubwise/shared`, gli stessi della prova e del prototipo)
 * leggono un `PlanWorld` SINCRONO; qui se ne carica un'istantanea prima di
 * ogni effetto, per i progetti e le persone che l'effetto nomina. Le regole
 * sono quelle del prototipo (`data/automations/visibility.ts`):
 *
 * - vede un progetto chi ne è membro, o un full admin;
 * - il RUOLO nel progetto è la chiave del preset (`project_lead`…) o, per un
 *   ruolo fatto a mano, il suo id; chi lo ha, in ordine alfabetico di nome,
 *   esclusi gli agenti (Claude);
 * - i destinatari di un reparto sono i suoi membri che vedono il progetto;
 * - i controlli delle scritture sono coi permessi del PROPRIETARIO nel
 *   progetto (`tickets.create`, `tickets.edit` per i traguardi,
 *   `backlog.create`): lanciano `forbidden` (→ `permission_lost`) o un dato
 *   non valido (→ `invalid_input`).
 *
 * Non c'è la disattivazione delle persone (area 9a, non integrata): nessuno è
 * disattivato. Un progetto «non c'è più» quando la riga non esiste.
 */
export interface WorldScope {
  ownerId: string;
  projectIds: readonly string[];
  /** Persone nominate dai passi (incaricati, destinatari, approvatori). */
  personIds?: readonly string[];
  /** Reparti nominati dai passi. */
  departmentIds?: readonly string[];
}

export async function loadPlanWorld(db: Db | Tx, scope: WorldScope): Promise<PlanWorld> {
  const projectIds = [...new Set(scope.projectIds.filter(Boolean))];
  const existing = new Set(
    projectIds.length === 0
      ? []
      : (await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds))).map((p) => p.id),
  );

  // I membri dei progetti, col ruolo (chiave del preset o id del ruolo).
  const memberRows =
    existing.size === 0
      ? []
      : await db
          .select({ projectId: projectMembers.projectId, userId: projectMembers.userId, presetKey: roles.presetKey, roleId: roles.id })
          .from(projectMembers)
          .innerJoin(roles, eq(roles.id, projectMembers.roleId))
          .where(inArray(projectMembers.projectId, [...existing]));
  const membersOf = new Map<string, Map<string, string>>();
  for (const r of memberRows) {
    const m = membersOf.get(r.projectId) ?? new Map<string, string>();
    m.set(r.userId, r.presetKey ?? r.roleId);
    membersOf.set(r.projectId, m);
  }

  // I reparti nominati: i loro membri, in ordine.
  const departmentIds = [...new Set(scope.departmentIds ?? [])];
  const deptRows =
    departmentIds.length === 0
      ? []
      : await db
          .select({ departmentId: departmentMembers.departmentId, userId: departmentMembers.userId })
          .from(departmentMembers)
          .where(inArray(departmentMembers.departmentId, departmentIds))
          .orderBy(asc(departmentMembers.position));

  // Le persone: membri, nominati, membri dei reparti, il proprietario.
  const personIds = [
    ...new Set([scope.ownerId, ...(scope.personIds ?? []), ...memberRows.map((r) => r.userId), ...deptRows.map((r) => r.userId)]),
  ].filter(Boolean);
  const peopleRows =
    personIds.length === 0
      ? []
      : await db
          .select({
            id: users.id,
            name: sql<string>`coalesce(nullif(${users.displayName}, ''), ${users.email})`,
            isAgent: users.isAgent,
            fullAdmin: sql<boolean>`${userIsFullAdmin(users.id)}`,
          })
          .from(users)
          .where(inArray(users.id, personIds));
  const homeRows =
    personIds.length === 0
      ? []
      : await db
          .select({ userId: departmentMembers.userId, departmentId: departmentMembers.departmentId })
          .from(departmentMembers)
          .where(inArray(departmentMembers.userId, personIds))
          .orderBy(asc(departmentMembers.position));
  const departmentsOf = new Map<string, string[]>();
  for (const r of homeRows) departmentsOf.set(r.userId, [...(departmentsOf.get(r.userId) ?? []), r.departmentId]);
  const people = new Map<string, PlanPerson & { fullAdmin: boolean }>();
  for (const p of peopleRows) {
    people.set(p.id, { id: p.id, name: p.name, departmentIds: departmentsOf.get(p.id) ?? [], isClaude: p.isAgent, fullAdmin: p.fullAdmin === true });
  }

  const ownerPerms = await projectPermissionsByProject(db, scope.ownerId, [...existing]);
  const byName = (a: string, b: string) => (people.get(a)?.name ?? a).localeCompare(people.get(b)?.name ?? b);
  const canSee = (personId: string, projectId: string) =>
    existing.has(projectId) && (people.get(personId)?.fullAdmin === true || membersOf.get(projectId)?.has(personId) === true);
  const need = (owner: string, projectId: string, permission: string) => {
    if (owner !== scope.ownerId) throw new Error("forbidden");
    if (!existing.has(projectId)) throw new Error("not_found");
    if (!ownerPerms.get(projectId)?.has(permission as never)) throw new Error("forbidden");
  };
  const notBlank = (what: string, value: string) => {
    if (value.trim() === "") throw new Error(`${what} vuoto`);
  };

  return {
    person: (id) => people.get(id),
    isDeactivated: () => false,
    holdersOfRole: (projectId, role) =>
      [...(membersOf.get(projectId) ?? new Map<string, string>()).entries()]
        .filter(([id, key]) => key === role && !people.get(id)?.isClaude)
        .map(([id]) => id)
        .sort(byName),
    departmentRecipients: (departmentId, projectId) =>
      [...new Set(deptRows.filter((r) => r.departmentId === departmentId).map((r) => r.userId))]
        .filter((id) => people.has(id) && !people.get(id)!.isClaude)
        .filter((id) => projectId === null || canSee(id, projectId))
        .sort(byName),
    canSeeProject: canSee,
    projectGone: (projectId) => !existing.has(projectId),
    checkNewTask: (owner, input) => {
      need(owner, input.projectId, "tickets.create");
      notBlank("titolo", input.title);
    },
    checkNewMilestone: (owner, projectId, input) => {
      need(owner, projectId, "tickets.edit");
      notBlank("nome", input.name);
    },
    checkNewRequest: (owner, input) => {
      need(owner, input.projectId, "backlog.create");
      notBlank("titolo", input.title);
    },
    defaultDepartmentOf: (personId) => people.get(personId)?.departmentIds[0] ?? null,
  };
}

/** Un traguardo del progetto con quel nome esiste già (il nome è unico per progetto). */
export async function milestoneNameTaken(db: Db | Tx, projectId: string, name: string): Promise<boolean> {
  const [m] = await db.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.projectId, projectId), eq(milestones.name, name)));
  return m !== undefined;
}
