import {
  departmentHomes,
  departmentMembers,
  departmentRoles,
  personalHomeSeen,
  personalHomes,
  taskFilters,
  type Db,
  type StoredHomeBlock,
} from "@stubwise/db";
import {
  departmentNovelties,
  normalizeBlocks,
  resolveHome,
  withFixed,
  type DepartmentHomeView,
  type HomeBlock,
  type MeHomeView,
} from "@stubwise/shared";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/session.js";

/**
 * La Home a blocchi lato server (integrazione area 2, fetta 3). Le regole —
 * fissi, unione dei reparti nell'ordine del primo, «è cambiata», novità —
 * sono quelle di `@stubwise/shared` (`tasks/home.ts`): qui si leggono le righe
 * e si risponde con la Home già risolta per chi guarda.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

const isFullAdmin = (viewer: Viewer) => viewer.instancePermissions.has("instance.full_admin");

/** I reparti di una persona nell'ordine in cui contano (il primo è il suo «primo reparto»). */
export async function departmentIdsOf(db: Pick<Db, "select">, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(eq(departmentMembers.userId, userId))
    .orderBy(asc(departmentMembers.position), asc(departmentMembers.departmentId));
  return rows.map((r) => r.id);
}

function departmentHomeView(row: typeof departmentHomes.$inferSelect): DepartmentHomeView {
  return {
    departmentId: row.departmentId,
    blocks: normalizeBlocks(row.blocks),
    updatedAt: row.updatedAt.toISOString(),
    updatedById: row.updatedById,
  };
}

/** La Home di un reparto; senza riga, i soli fissi e `updatedAt` null. */
export async function departmentHomeOf(db: Db, departmentId: string): Promise<DepartmentHomeView> {
  const [row] = await db.select().from(departmentHomes).where(eq(departmentHomes.departmentId, departmentId));
  return row
    ? departmentHomeView(row)
    : { departmentId, blocks: withFixed<StoredHomeBlock>([]), updatedAt: null, updatedById: null };
}

/** La Home di chi guarda, risolta: blocchi, «è cambiata», novità e ciò che serve a personalizzarla. */
export async function meHome(db: Db, viewer: Viewer): Promise<MeHomeView> {
  const departmentIds = await departmentIdsOf(db, viewer.id);
  const [homeRows, [personalRow], seenRows] = await Promise.all([
    departmentIds.length
      ? db.select().from(departmentHomes).where(inArray(departmentHomes.departmentId, departmentIds))
      : Promise.resolve([]),
    db.select().from(personalHomes).where(eq(personalHomes.userId, viewer.id)),
    db.select().from(personalHomeSeen).where(eq(personalHomeSeen.userId, viewer.id)),
  ]);
  const homes = homeRows.map(departmentHomeView).map((h) => ({ ...h, updatedAt: h.updatedAt! }));
  const personal = personalRow
    ? {
        blocks: normalizeBlocks(personalRow.blocks),
        seenDepartmentUpdates: Object.fromEntries(seenRows.map((s) => [s.departmentId, s.seenAt.toISOString()])),
      }
    : null;
  const { blocks, departmentChanged } = resolveHome({ departmentIds }, homes, personal);
  return {
    blocks,
    departmentChanged,
    newBlocks: departmentNovelties(departmentChanged, homes, blocks),
    departmentIds,
    departmentHomes: homes,
    personal,
  };
}

export type BlockError = "filter_not_visible" | "filter_not_public";

/**
 * I blocchi `filter` devono nominare un filtro che chi scrive vede; nella
 * Home di un reparto (`publicOnly`) anche pubblico. Un filtro eliminato o
 * reso privato DOPO resta nella Home come blocco «non disponibile»: il
 * controllo è solo in scrittura.
 */
export async function blockError(
  db: Db,
  viewer: Viewer,
  blocks: HomeBlock[],
  opts: { publicOnly: boolean },
): Promise<BlockError | null> {
  const ids = [...new Set(blocks.flatMap((b) => (b.kind === "filter" && b.filterId ? [b.filterId] : [])))];
  if (ids.length === 0) return null;
  if (ids.some((id) => !z.uuid().safeParse(id).success)) return "filter_not_visible";
  const rows = await db
    .select({ id: taskFilters.id, visibility: taskFilters.visibility })
    .from(taskFilters)
    .where(
      and(
        inArray(taskFilters.id, ids),
        or(eq(taskFilters.ownerId, viewer.id), eq(taskFilters.visibility, "public")),
      ),
    );
  if (rows.length !== ids.length) return "filter_not_visible";
  if (opts.publicOnly && rows.some((r) => r.visibility !== "public")) return "filter_not_public";
  return null;
}

/** La Home personale, normalizzata. La prima volta le Home dei miei reparti diventano «viste». */
export async function setPersonalHome(db: Db, viewer: Viewer, blocks: HomeBlock[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: personalHomes.userId })
      .from(personalHomes)
      .where(eq(personalHomes.userId, viewer.id));
    const normalized = normalizeBlocks(blocks.map(stored));
    await tx
      .insert(personalHomes)
      .values({ userId: viewer.id, blocks: normalized })
      .onConflictDoUpdate({ target: personalHomes.userId, set: { blocks: normalized, updatedAt: new Date() } });
    if (existing) return;
    // Chi personalizza parte da ciò che vede ora: nessun «è cambiata» per una
    // modifica che c'era già prima di personalizzare.
    const departmentIds = await departmentIdsOf(tx, viewer.id);
    if (departmentIds.length === 0) return;
    const homes = await tx
      .select({ departmentId: departmentHomes.departmentId, updatedAt: departmentHomes.updatedAt })
      .from(departmentHomes)
      .where(inArray(departmentHomes.departmentId, departmentIds));
    if (homes.length === 0) return;
    await tx
      .insert(personalHomeSeen)
      .values(homes.map((h) => ({ userId: viewer.id, departmentId: h.departmentId, seenAt: h.updatedAt })))
      .onConflictDoNothing();
  });
}

/** Ripristina: torna all'unione dei reparti (e dimentica le viste). */
export async function resetPersonalHome(db: Db, viewer: Viewer): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(personalHomeSeen).where(eq(personalHomeSeen.userId, viewer.id));
    await tx.delete(personalHomes).where(eq(personalHomes.userId, viewer.id));
  });
}

/** «Vedi le novità»: chi ha la Home personale ha visto l'ultima modifica di quella del reparto. */
export async function markDepartmentHomeSeen(db: Db, viewer: Viewer, departmentId: string): Promise<void> {
  const [[personal], [home]] = await Promise.all([
    db.select({ userId: personalHomes.userId }).from(personalHomes).where(eq(personalHomes.userId, viewer.id)),
    db
      .select({ updatedAt: departmentHomes.updatedAt })
      .from(departmentHomes)
      .where(eq(departmentHomes.departmentId, departmentId)),
  ]);
  if (!personal || !home) return;
  await db
    .insert(personalHomeSeen)
    .values({ userId: viewer.id, departmentId, seenAt: home.updatedAt })
    .onConflictDoUpdate({
      target: [personalHomeSeen.userId, personalHomeSeen.departmentId],
      set: { seenAt: home.updatedAt },
    });
}

/** Un full admin sempre; altrimenti `department.home.manage` nel reparto (`department_roles`). */
export async function canManageDepartmentHome(db: Db, viewer: Viewer, departmentId: string): Promise<boolean> {
  if (isFullAdmin(viewer)) return true;
  const [row] = await db
    .select({ permissions: departmentRoles.permissions })
    .from(departmentRoles)
    .where(and(eq(departmentRoles.departmentId, departmentId), eq(departmentRoles.userId, viewer.id)));
  return row?.permissions.includes("department.home.manage") ?? false;
}

export async function setDepartmentHome(
  db: Db,
  viewer: Viewer,
  departmentId: string,
  blocks: HomeBlock[],
): Promise<DepartmentHomeView> {
  const normalized = normalizeBlocks(blocks.map(stored));
  const now = new Date();
  const [row] = await db
    .insert(departmentHomes)
    .values({ departmentId, blocks: normalized, updatedAt: now, updatedById: viewer.id })
    .onConflictDoUpdate({
      target: departmentHomes.departmentId,
      set: { blocks: normalized, updatedAt: now, updatedById: viewer.id },
    })
    .returning();
  return departmentHomeView(row!);
}

/** I permessi di reparto di una persona, per reparto (`/api/auth/me`). */
export async function departmentPermissionsMap(db: Db, userId: string): Promise<Record<string, string[]>> {
  const rows = await db
    .select({ departmentId: departmentRoles.departmentId, permissions: departmentRoles.permissions })
    .from(departmentRoles)
    .where(eq(departmentRoles.userId, userId));
  return Object.fromEntries(rows.filter((r) => r.permissions.length > 0).map((r) => [r.departmentId, r.permissions]));
}

/** Solo `kind` e `filterId`: niente campi in più nel jsonb. */
function stored(b: HomeBlock): StoredHomeBlock {
  return b.filterId !== undefined ? { kind: b.kind, filterId: b.filterId } : { kind: b.kind };
}
