import { departmentMembers, departmentProjectPermissions, departments, projectMembers, users, type Db } from "@stubwise/db";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
 * - chi agisce deve avere ogni permesso dato in OGNI progetto dove arriva
 *   (e, se non arriva in nessuno, in almeno un progetto).
 *   I suoi permessi sono quelli effettivi (ruolo, personali, i suoi reparti),
 *   anche negli archiviati: riaprendo, un permesso arriverebbe senza
 *   controllo. Un progetto che non vede, non ci ha niente.
 * Un full admin non ha mai niente di mancante.
 */
export async function judgeDepartmentDraft(db: Db, actor: Actor, saved: DepartmentShape, draft: DepartmentShape): Promise<DepartmentJudgement> {
  const fullAdmin = actor.instancePermissions.has("instance.full_admin");
  const held = fullAdmin ? {} : await projectPermissionsMap(db, actor, { includeArchived: true });
  const memberships = await db.select({ userId: projectMembers.userId, projectId: projectMembers.projectId }).from(projectMembers);
  // Una Map per persona (rimandi, lotto 4): prima ogni chiamata filtrava
  // tutte le appartenenze, e `missingToAdd` la chiama per ogni persona.
  const byUser = new Map<string, string[]>();
  for (const m of memberships) {
    const list = byUser.get(m.userId);
    if (list) list.push(m.projectId);
    else byUser.set(m.userId, [m.projectId]);
  }
  const projectsOf = (userId: string): readonly string[] => byUser.get(userId) ?? [];
  /** I permessi che chi agisce ha in ALMENO un progetto: il confronto per ciò che non arriva in nessuno. */
  const somewhere = new Set(Object.values(held).flat() as string[]);
  /**
   * I permessi di `perms` che chi agisce non ha in almeno uno di `projectIds`.
   * Senza progetti (F8-4 = a, il prototipo: `holdingsSomewhere`), quelli che
   * non ha in NESSUN progetto: chi non ha `plans.approve` da nessuna parte non
   * lo mette nemmeno in un reparto vuoto, dove arriverebbe appena una persona
   * entra in un progetto.
   */
  const missingIn = (projectIds: readonly string[], perms: readonly string[]) =>
    fullAdmin
      ? []
      : projectIds.length === 0
        ? perms.filter((p) => !somewhere.has(p))
        : perms.filter((p) => projectIds.some((id) => !(held[id] ?? []).includes(p as never)));
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

/** Un permesso di progetto che una persona riceve da un suo reparto. */
export interface DepartmentGrant {
  userId: string;
  departmentId: string;
  departmentName: string;
  permission: string;
}

/**
 * Area 9, F8: i permessi di progetto che le persone ricevono dai loro reparti
 * (validi in ogni progetto di cui sono membri), coi nomi dei reparti. È la
 * stessa unione di `memberPermissionsSql`, letta per le FONTI (Members, la
 * pagina della persona, «Chi può farlo?», l'anteprima del membro) e per
 * l'escalation di chi entra in un progetto. Mai a un utente di sistema.
 */
export async function departmentGrantsOf(db: Pick<Db, "select">, userIds?: readonly string[]): Promise<DepartmentGrant[]> {
  if (userIds && userIds.length === 0) return [];
  return db
    .select({
      userId: departmentMembers.userId,
      departmentId: departmentMembers.departmentId,
      departmentName: departments.name,
      permission: departmentProjectPermissions.permission,
    })
    .from(departmentMembers)
    .innerJoin(departmentProjectPermissions, eq(departmentProjectPermissions.departmentId, departmentMembers.departmentId))
    .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .innerJoin(users, eq(users.id, departmentMembers.userId))
    .where(and(eq(users.isAgent, false), ...(userIds ? [inArray(departmentMembers.userId, [...userIds])] : [])));
}

/**
 * Area 9, F8 (review, I3): i permessi dei reparti di chi ENTRA in un progetto,
 * con le righe di quei reparti bloccate in condivisione. Il `PATCH` di un
 * reparto le tiene `FOR UPDATE` mentre giudica e scrive: un'aggiunta al
 * progetto e un permesso aggiunto al reparto si mettono in fila, e nessuno dei
 * due giudica sui dati dell'altro ancora da scrivere (il write skew per cui una
 * persona riceverebbe un permesso che nessuno di chi ha agito ha lì).
 */
export async function departmentGrantsForEntering(tx: Db, userId: string): Promise<DepartmentGrant[]> {
  const mine = await tx.select({ departmentId: departmentMembers.departmentId }).from(departmentMembers).where(eq(departmentMembers.userId, userId));
  if (mine.length > 0) {
    await tx
      .select({ id: departments.id })
      .from(departments)
      .where(inArray(departments.id, mine.map((m) => m.departmentId)))
      .orderBy(departments.id)
      .for("share");
  }
  return departmentGrantsOf(tx, [userId]);
}

