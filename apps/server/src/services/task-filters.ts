import { taskFilters, type Db } from "@stubwise/db";
import type { NewFilterBody } from "@stubwise/shared";
import { and, eq, or, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";

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
