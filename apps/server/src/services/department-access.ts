import { departmentMembers, departmentProjectPermissions, projectMembers, users, type Db } from "@stubwise/db";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { and, eq, isNull } from "drizzle-orm";
import { projectPermissionsMap } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

type Actor = Pick<SessionUser, "id" | "instancePermissions">;

/** La bozza del pannello del reparto che conta per i permessi: persone e permessi di progetto. */
export interface DepartmentShape {
  memberIds: readonly string[];
  projectPermissions: readonly string[];
}

export interface DepartmentJudgement {
  /** `"anywhere"`: la bozza non arriva a nessun progetto (nessuna persona è membro di un progetto). */
  reach: "projects" | "anywhere";
  /** I permessi di progetto che chi agisce non può mettere nel reparto: non li ha in TUTTI i progetti dove arrivano. */
  notGivable: string[];
  /** Per ogni persona attiva e umana FUORI dalla bozza: cosa riceverebbe entrando senza che chi agisce lo abbia. */
  missingToAdd: Record<string, string[]>;
  /** Ciò che la bozza così com'è darebbe senza averlo: vuoto = si può salvare (quanto all'escalation). */
  missing: string[];
}

/**
 * Area 9, F8 (F8-2 = a): IL giudizio di una bozza di reparto rispetto al
 * salvato, in UN posto. Lo leggono l'anteprima (`POST
 * /api/departments/:id/preview`) e la scrittura (il rifiuto `escalation`).
 * È `judgeDraft` del prototipo (`data/admin/departments.ts`):
 * - un permesso AGGIUNTO arriva nei progetti di tutte le persone della bozza;
 * - chi ENTRA riceve tutti i permessi della bozza nei suoi progetti, mentre un
 *   membro salvato tolto e rimesso porta solo quelli aggiunti;
 * - chi agisce deve avere ogni permesso dato in OGNI progetto dove arriva.
 *   I suoi permessi sono quelli effettivi (ruolo, personali, i suoi reparti),
 *   anche negli archiviati: riaprendo, un permesso arriverebbe senza
 *   controllo. Un progetto che non vede, non ci ha niente.
 * Un full admin non ha mai niente di mancante.
 */
export async function judgeDepartmentDraft(db: Db, actor: Actor, saved: DepartmentShape, draft: DepartmentShape): Promise<DepartmentJudgement> {
  const fullAdmin = actor.instancePermissions.has("instance.full_admin");
  const held = fullAdmin ? {} : await projectPermissionsMap(db, actor, { includeArchived: true });
  const memberships = await db.select({ userId: projectMembers.userId, projectId: projectMembers.projectId }).from(projectMembers);
  const projectsOf = (userId: string) => memberships.filter((m) => m.userId === userId).map((m) => m.projectId);
  /** I permessi di `perms` che chi agisce non ha in almeno uno di `projectIds`. */
  const missingIn = (projectIds: readonly string[], perms: readonly string[]) =>
    fullAdmin ? [] : perms.filter((p) => projectIds.some((id) => !(held[id] ?? []).includes(p as never)));
  const reached = [...new Set(draft.memberIds.flatMap(projectsOf))];
  const notGivable = missingIn(reached, PROJECT_PERMISSIONS);
  const addedPerms = draft.projectPermissions.filter((p) => !saved.projectPermissions.includes(p));
  const missingFor = (userId: string) => missingIn(projectsOf(userId), saved.memberIds.includes(userId) ? addedPerms : draft.projectPermissions);
  const candidates = await db
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.deactivatedAt), eq(users.isAgent, false)));
  const entering = draft.memberIds.filter((u) => !saved.memberIds.includes(u));
  const missing = new Set([...addedPerms.filter((p) => notGivable.includes(p)), ...entering.flatMap(missingFor)]);
  return {
    reach: reached.length > 0 ? "projects" : "anywhere",
    notGivable,
    missingToAdd: Object.fromEntries(candidates.filter((p) => !draft.memberIds.includes(p.id)).map((p) => [p.id, missingFor(p.id)])),
    missing: draft.projectPermissions.filter((p) => missing.has(p)),
  };
}

/** Il reparto salvato: le sue persone e i suoi permessi di progetto. */
export async function savedDepartmentShape(db: Pick<Db, "select">, departmentId: string): Promise<DepartmentShape> {
  const members = await db.select({ userId: departmentMembers.userId }).from(departmentMembers).where(eq(departmentMembers.departmentId, departmentId));
  const perms = await db.select({ permission: departmentProjectPermissions.permission }).from(departmentProjectPermissions).where(eq(departmentProjectPermissions.departmentId, departmentId));
  return { memberIds: members.map((m) => m.userId), projectPermissions: perms.map((p) => p.permission).sort() };
}
