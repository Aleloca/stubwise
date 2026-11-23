import { milestones, projectStatuses, taskFilters, type Db } from "@stubwise/db";
import { isPersonPlaceholder, parseCriteria, type NewFilterBody, type TaskListQuery } from "@stubwise/shared";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { isAllProjects, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { peopleKnownTo } from "./people-known.js";

/**
 * Le scritture dei filtri salvati (integrazione area 2, fetta 3), estratte da
 * `routes/filters.ts` perché le usa anche l'esecutore delle azioni di Claude
 * (chat, fetta 3: un filtro PERSONALE). Regole del prototipo: si vedono i
 * propri e i pubblici; eliminare è dell'autore o di un full admin.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

export const isFullAdmin = (viewer: Viewer) => viewer.instancePermissions.has("instance.full_admin");

/** I filtri che `viewer` vede: i suoi e i pubblici. */
export const visibleTo = (viewer: Viewer) =>
  or(eq(taskFilters.ownerId, viewer.id), eq(taskFilters.visibility, "public"))!;

export async function visibleFilter(db: Db, viewer: Viewer, id: string) {
  const [row] = await db
    .select()
    .from(taskFilters)
    .where(and(eq(taskFilters.id, id), visibleTo(viewer)));
  return row ?? null;
}

/** Quanti filtri può avere una persona (fix della review della fetta 3). */
export const MAX_FILTERS_PER_PERSON = 200;

/** Un lock di transazione per persona e tabella: serializza le sue scritture concorrenti. */
export async function lockPerson(tx: Pick<Db, "execute">, scope: string, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${scope}:${userId}`}))`);
}

/** Un filtro nuovo; `null` oltre il tetto per persona (contato sotto il lock della persona). */
export async function createTaskFilter(db: Db, viewer: Viewer, body: NewFilterBody) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, "task_filters", viewer.id);
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(taskFilters)
      .where(eq(taskFilters.ownerId, viewer.id));
    if (count >= MAX_FILTERS_PER_PERSON) return null;
    const [created] = await tx
      .insert(taskFilters)
      .values({ ...body, ownerId: viewer.id })
      .returning();
    return created!;
  });
}

/** Elimina un filtro (i fissati di tutti in cascata): dell'autore o di un full admin. */
export async function deleteTaskFilter(db: Db, viewer: Viewer, id: string): Promise<"ok" | "not_found" | "forbidden"> {
  const row = await visibleFilter(db, viewer, id);
  if (!row) return "not_found";
  if (row.ownerId !== viewer.id && !isFullAdmin(viewer)) return "forbidden";
  await db.delete(taskFilters).where(eq(taskFilters.id, row.id));
  return "ok";
}

/**
 * Registro, A11 r.1414 (scelta A di 46 sui filtri salvati): i criteri di un
 * filtro portano un segnaposto `hidden-<n>` in un campo persona? Un segnaposto
 * non si salva mai (400 `invalid`): i criteri si scrivono con gli id veri.
 */
export function criteriaCarryPlaceholder(criteria: { assigneeIds?: readonly string[] } | undefined): boolean {
  return (criteria?.assigneeIds ?? []).some(isPersonPlaceholder);
}

/**
 * L'esecuzione di un filtro salvato (`GET /api/tasks?savedFilterId=`): i
 * segnaposto di `assigneeIds` diventano gli assegnatari del filtro che chi
 * guarda non conosce (tutti: i chip mascherati non si toccano, quindi sono
 * gli stessi); gli id veri mandati dal client restano. Senza `savedFilterId`,
 * o con un filtro che chi guarda non vede, un segnaposto è `invalid`.
 */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/** Gli assegnatari di un filtro salvato che chi guarda non conosce (quelli che legge come segnaposto). */
async function unknownAssigneesOf(db: Db, viewer: Viewer, filter: typeof taskFilters.$inferSelect): Promise<string[]> {
  const saved = (parseCriteria(filter.criteria)?.assigneeIds ?? []).filter((id) => id !== "none" && id !== "me");
  const known = await peopleKnownTo(db, viewer, saved);
  return known === "all" ? [] : saved.filter((id) => !known.has(id));
}

/** Al posto dei segnaposto (dove sta il primo), gli id veri; quelli mandati dal client restano, nell'ordine. */
function withReal(asked: readonly string[], unknown: readonly string[]): string[] {
  const out: string[] = [];
  let placed = false;
  for (const id of asked) {
    if (!isPersonPlaceholder(id)) out.push(id);
    else if (!placed) {
      out.push(...unknown);
      placed = true;
    }
  }
  return [...new Set(out)];
}

export async function resolveSavedFilterPlaceholders(db: Db, viewer: Viewer, query0: TaskListQuery): Promise<TaskListQuery | "invalid"> {
  const filter = query0.savedFilterId ? await visibleFilter(db, viewer, query0.savedFilterId) : null;
  // M-1: le restrizioni del filtro su ciò che chi guarda non vede tornano (le
  // ha lette senza): un filtro solo su un progetto invisibile non trova niente.
  let query = query0;
  if (filter) {
    const criteria = parseCriteria(filter.criteria) ?? {};
    query = withHiddenScope(query, (await hiddenScopes(db, viewer, [criteria]))(criteria));
  }
  const asked = query.assigneeIds ?? [];
  if (!asked.some(isPersonPlaceholder)) return query;
  if (!filter) return "invalid";
  const resolved = withReal(asked, await unknownAssigneesOf(db, viewer, filter));
  // Un elenco vuoto vorrebbe dire «nessun filtro» (tutte le task): qui vuol dire
  // «nessuno», quindi un id che non è di nessuno.
  return { ...query, assigneeIds: resolved.length > 0 ? resolved : [NOBODY] };
}

/**
 * Revisione 3bbe2ddc6..444b8b773, I-6: i criteri di un salvataggio coi
 * segnaposto. Diventano gli assegnatari del filtro d'origine (`source`: in
 * PATCH il filtro stesso, in POST il `savedFilterId` del corpo, se chi salva lo
 * vede) che chi salva non conosce. Senza origine, o se l'origine non ne ha,
 * `invalid`: un segnaposto non si salva mai.
 */
export async function resolveCriteriaPlaceholders<C extends { assigneeIds?: string[] }>(
  db: Db,
  viewer: Viewer,
  criteria: C,
  source: typeof taskFilters.$inferSelect | null,
): Promise<C | "invalid"> {
  if (!criteriaCarryPlaceholder(criteria)) return criteria;
  if (!source) return "invalid";
  const unknown = await unknownAssigneesOf(db, viewer, source);
  if (unknown.length === 0) return "invalid";
  return { ...criteria, assigneeIds: withReal(criteria.assigneeIds ?? [], unknown) };
}

/** Le restrizioni dei criteri su ciò che chi guarda non vede (M-1): un progetto, e gli stati e i traguardi di un progetto. */
export interface HiddenScope {
  projectIds: string[];
  statusIds: string[];
  milestoneIds: string[];
}
type ScopeCriteria = { projectIds?: string[]; statusIds?: string[]; milestoneIds?: string[] };
const SCOPE_KEYS = ["projectIds", "statusIds", "milestoneIds"] as const;

/**
 * Revisione 3bbe2ddc6..444b8b773, M-1: per un elenco di criteri (una pagina di
 * filtri), quali restrizioni nominano un progetto che chi guarda non vede. Tre
 * query in tutto: i progetti visibili, il progetto degli stati e dei traguardi
 * nominati. Un id che non esiste più non nomina niente e resta.
 */
export async function hiddenScopes(db: Db, viewer: Viewer, list: readonly ScopeCriteria[]): Promise<(c: ScopeCriteria) => HiddenScope> {
  const visible = await visibleProjectIds(db, viewer);
  const sees = (projectId: string) => (isAllProjects(visible) ? !visible.archived.includes(projectId) : visible.includes(projectId));
  const statusIds = [...new Set(list.flatMap((c) => c.statusIds ?? []))].filter(isUuid);
  const milestoneIds = [...new Set(list.flatMap((c) => c.milestoneIds ?? []))].filter(isUuid);
  const statusProject = new Map(
    statusIds.length ? (await db.select({ id: projectStatuses.id, projectId: projectStatuses.projectId }).from(projectStatuses).where(inArray(projectStatuses.id, statusIds))).map((r) => [r.id, r.projectId]) : [],
  );
  const milestoneProject = new Map(
    milestoneIds.length ? (await db.select({ id: milestones.id, projectId: milestones.projectId }).from(milestones).where(inArray(milestones.id, milestoneIds))).map((r) => [r.id, r.projectId]) : [],
  );
  const hiddenBy = (owner: Map<string, string>) => (id: string) => {
    const projectId = owner.get(id);
    return projectId !== undefined && !sees(projectId);
  };
  return (c) => ({
    projectIds: (c.projectIds ?? []).filter((id) => isUuid(id) && !sees(id)),
    statusIds: (c.statusIds ?? []).filter(hiddenBy(statusProject)),
    milestoneIds: (c.milestoneIds ?? []).filter(hiddenBy(milestoneProject)),
  });
}

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** I criteri senza le restrizioni nascoste; un elenco rimasto vuoto si toglie. */
export function withoutHiddenScope<C extends ScopeCriteria>(c: C, hidden: HiddenScope): C {
  const out: Record<string, unknown> = { ...c };
  for (const key of SCOPE_KEYS) {
    const list = c[key];
    if (!list) continue;
    const kept = list.filter((id) => !hidden[key].includes(id));
    if (kept.length) out[key] = kept;
    else delete out[key];
  }
  return out as C;
}

/** I criteri con le restrizioni nascoste rimesse (in coda): chi salva o esegue non le ha viste, quindi non le ha tolte. */
export function withHiddenScope<C extends ScopeCriteria>(c: C, hidden: HiddenScope): C {
  const out: Record<string, unknown> = { ...c };
  for (const key of SCOPE_KEYS) {
    if (hidden[key].length === 0) continue;
    out[key] = [...new Set([...(c[key] ?? []), ...hidden[key]])];
  }
  return out as C;
}
