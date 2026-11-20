import { randomUUID } from "node:crypto";
import {
  driveFiles,
  productPageBlockIds,
  productPageFollows,
  productPageImages,
  productPageRevisions,
  productPages,
  projectDecisions,
  users,
  type Db,
} from "@stubwise/db";
import {
  PRODUCT_BLOCKS_MAX,
  PRODUCT_IMAGE_REF_PREFIX,
  applyBlockOps,
  blockIdsOf,
  mergeChanges,
  productBlockSchema,
  validProductBlock,
  type ProductBlock,
  type ProductBlockChange,
  type ProductRevisionView,
  type SaveProductBlocksInput,
} from "@stubwise/shared";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { ProductDocsError } from "./product-docs.js";

/**
 * Area 11, F1 — la scrittura del corpo di una pagina di prodotto, SOLO a
 * operazioni (l'invariante del design), la regola del prototipo
 * `writeProductBlocksAs` (`data/productDocs/writes.ts`):
 * - sotto `FOR UPDATE` della pagina;
 * - un id nuovo (blocco, riga, cella) non dev'essere mai stato dato in QUESTA
 *   pagina (`product_page_block_ids`), salvo ⌘Z: con `undoOf`, la stessa
 *   persona può rimettere gli id che la sua sessione ha tolto;
 * - i segni validi (link solo http(s)); i riferimenti validati con la
 *   visibilità di chi salva (un file del Drive, una decisione, un'immagine
 *   della stessa pagina); i wireframe arrivano con F6;
 * - la revisione si unisce all'ultima della pagina se è della stessa persona
 *   e della stessa sessione (`mergeChanges`), altrimenti nasce;
 * - `baseSeq` più vecchio di una revisione di un ALTRO (persona o sessione):
 *   409 `stale` con quelle revisioni (il client le riapplica).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
const invalid = (code: string, message: string) => new ProductDocsError(422, code, message);

const IMAGE_ID = (src: string) => (src.startsWith(PRODUCT_IMAGE_REF_PREFIX) ? src.slice(PRODUCT_IMAGE_REF_PREFIX.length) : null);

export interface SaveProductBlocksResult {
  seq: number;
  revisionId: string | null;
}

export class ProductStaleError extends ProductDocsError {
  constructor(readonly revisions: ProductRevisionView[]) {
    super(409, "stale", "The page changed: apply the newer revisions and try again");
  }
}

/** Un riferimento di un blocco cambiato, con la visibilità di chi salva. */
async function checkReferences(tx: Db, viewer: Viewer, pageId: string, changes: readonly ProductBlockChange[]): Promise<void> {
  for (const change of changes) {
    const after = change.after;
    if (!after) continue;
    if (!validProductBlock(after)) throw invalid("invalid_marks", "A mark is outside the text, or a link is not http(s)");
    if (after.type === "image") {
      const imageId = IMAGE_ID(after.src);
      const [img] = imageId ? await tx.select({ id: productPageImages.id }).from(productPageImages).where(and(eq(productPageImages.id, imageId), eq(productPageImages.pageId, pageId))) : [];
      if (!img) throw invalid("invalid_image", "The image was not uploaded to this page");
    }
    if (after.type === "drive") {
      const [file] = await tx
        .select({ projectId: driveFiles.projectId, number: driveFiles.number, deletedAt: driveFiles.deletedAt })
        .from(driveFiles)
        .where(eq(driveFiles.id, after.fileId));
      const perms = file && file.deletedAt === null ? await projectPermissionsFor(tx, viewer, file.projectId) : null;
      if (!file || !perms || !after.code.endsWith(`-F${file.number}`)) throw invalid("invalid_drive", "The file is not one you can see");
    }
    if (after.type === "decision") {
      const [d] = await tx.select({ projectId: projectDecisions.projectId }).from(projectDecisions).where(eq(projectDecisions.id, after.decisionId));
      if (!d || !(await projectPermissionsFor(tx, viewer, d.projectId))) throw invalid("invalid_decision", "The decision is not one you can see");
    }
    // I wireframe li disegna Claude (F6): fino ad allora un blocco nuovo o cambiato non c'è.
    if (after.type === "wireframe") {
      const unchanged = change.before?.type === "wireframe" && change.before.wireframeId === after.wireframeId && change.before.variant === after.variant;
      if (!unchanged) throw invalid("invalid_wireframe", "Wireframes are drawn by Claude");
    }
  }
}

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

export async function saveProductBlocks(db: Db, viewer: Viewer, pageId: string, input: SaveProductBlocksInput): Promise<SaveProductBlocksResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("update");
    if (!page) throw new ProductDocsError(404, "not_found", "Not found");

    // Le revisioni che il client non ha visto e che non sono sue (persona e sessione).
    const newer = await tx
      .select()
      .from(productPageRevisions)
      .where(and(eq(productPageRevisions.pageId, pageId), gt(productPageRevisions.lastSeq, input.baseSeq)));
    const others = newer.filter((r) => !(r.actorId === viewer.id && r.sessionId === input.sessionId));
    if (others.length > 0) throw new ProductStaleError(await revisionViews(tx, viewer, others));

    const blocks = readBlocks(page.blocks);
    const onPage = new Set(blocks.flatMap(blockIdsOf));
    const registry = await tx
      .select({ id: productPageBlockIds.blockId, removedBy: productPageBlockIds.removedBy, removedSession: productPageBlockIds.removedSession })
      .from(productPageBlockIds)
      .where(eq(productPageBlockIds.pageId, pageId));
    const given = new Set(registry.map((r) => r.id));
    // ⌘Z (`undoOf`): la stessa persona rimette gli id che la SUA sessione ha tolto da questa pagina.
    const restorable = new Set(input.undoOf ? registry.filter((r) => r.removedBy === viewer.id && r.removedSession === input.sessionId).map((r) => r.id) : []);
    for (const op of input.ops) {
      if (op.op !== "insert" && op.op !== "set") continue;
      const fresh = blockIdsOf(op.block as ProductBlock).filter((id) => op.op === "insert" || !onPage.has(id));
      if (fresh.some((id) => given.has(id) && !restorable.has(id))) throw invalid("block_id_taken", "A block id was already used on this page");
    }

    let next: { blocks: ProductBlock[]; changes: ProductBlockChange[] };
    try {
      next = applyBlockOps(blocks, input.ops as never);
    } catch {
      throw invalid("invalid_op", "An operation names a block that isn't there, or repeats an id");
    }
    if (next.blocks.length > PRODUCT_BLOCKS_MAX) throw invalid("too_many_blocks", `A page has at most ${PRODUCT_BLOCKS_MAX} blocks`);
    await checkReferences(tx, viewer, pageId, next.changes);
    if (next.changes.length === 0) return { seq: page.revSeq, revisionId: null };

    const keptIds = new Set(next.blocks.flatMap(blockIdsOf));
    const fresh = [...keptIds].filter((id) => !given.has(id));
    if (fresh.length > 0) await tx.insert(productPageBlockIds).values(fresh.map((blockId) => ({ pageId, blockId }))).onConflictDoNothing();
    const gone = [...onPage].filter((id) => !keptIds.has(id));
    if (gone.length > 0) {
      await tx
        .update(productPageBlockIds)
        .set({ removedBy: viewer.id, removedSession: input.sessionId })
        .where(and(eq(productPageBlockIds.pageId, pageId), inArray(productPageBlockIds.blockId, gone)));
    }
    // Una revisione annullata può non esserci più (unita e tornata com'era): `undoOf` resta solo se c'è.
    const [undone] = input.undoOf ? await tx.select({ id: productPageRevisions.id }).from(productPageRevisions).where(and(eq(productPageRevisions.id, input.undoOf), eq(productPageRevisions.pageId, pageId))) : [];
    const [{ seq }] = (await tx
      .update(productPages)
      .set({ blocks: next.blocks, revSeq: sql`${productPages.revSeq} + 1`, updatedBy: viewer.id, updatedAt: new Date() })
      .where(eq(productPages.id, pageId))
      .returning({ seq: productPages.revSeq })) as [{ seq: number }];

    // L'unione: all'ultima revisione della pagina, se è un `edit` della stessa persona e sessione (e non un ⌘Z).
    const [last] = await tx.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, pageId)).orderBy(desc(productPageRevisions.lastSeq)).limit(1);
    if (!input.undoOf && last && last.kind === "edit" && last.actorId === viewer.id && last.sessionId === input.sessionId) {
      const merged = mergeChanges(last.changes as ProductBlockChange[], next.changes);
      if (merged.length === 0) {
        await tx.delete(productPageRevisions).where(eq(productPageRevisions.id, last.id));
      } else {
        await tx.update(productPageRevisions).set({ changes: merged as unknown[], lastSeq: seq, updatedAt: new Date() }).where(eq(productPageRevisions.id, last.id));
      }
      return { seq, revisionId: last.id };
    }
    const [rev] = await tx
      .insert(productPageRevisions)
      .values({ pageId, sessionId: input.sessionId, seq, lastSeq: seq, actorId: viewer.id, kind: "edit", undoOf: undone?.id ?? null, changes: next.changes as unknown[] })
      .returning({ id: productPageRevisions.id });
    return { seq, revisionId: rev!.id };
  });
}

/** Le revisioni come le legge chi guarda: il nome di chi ha scritto solo se lo vede (R-G5). */
async function revisionViews(db: Db, viewer: Viewer, rows: (typeof productPageRevisions.$inferSelect)[]): Promise<ProductRevisionView[]> {
  const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
  const people = await visiblePersonIds(db, viewer);
  const names = new Map(
    actorIds.length > 0 ? (await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, actorIds))).map((u) => [u.id, personName(u)]) : [],
  );
  return [...rows]
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .map((r) => ({
      id: r.id,
      pageId: r.pageId,
      sessionId: r.sessionId,
      seq: r.seq,
      lastSeq: r.lastSeq,
      kind: r.kind,
      actorId: r.actorId,
      actorName: r.actorId && (people === "all" || people.includes(r.actorId)) ? (names.get(r.actorId) ?? null) : null,
      changes: r.changes as Record<string, unknown>[],
      title: r.title ?? null,
      parent: r.parent ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
}

/** Le revisioni di una pagina, dalla più recente (la rotta ha chiesto `docs.view`). */
export async function listProductRevisions(db: Db, viewer: Viewer, pageId: string): Promise<ProductRevisionView[]> {
  const rows = await db.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, pageId)).orderBy(desc(productPageRevisions.lastSeq)).limit(500);
  return revisionViews(db, viewer, rows);
}

export async function followProductPage(db: Db, viewer: Viewer, pageId: string, on: boolean): Promise<void> {
  if (on) await db.insert(productPageFollows).values({ pageId, userId: viewer.id }).onConflictDoNothing();
  else await db.delete(productPageFollows).where(and(eq(productPageFollows.pageId, pageId), eq(productPageFollows.userId, viewer.id)));
}

/** I tipi d'immagine ammessi, riconosciuti dai BYTE (mai dal nome né dal tipo dichiarato); niente SVG. */
export function imageMimeOf(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Registra un'immagine caricata (la rotta l'ha già messa nello storage). */
export async function recordProductImage(
  db: Db,
  viewer: Viewer,
  page: { id: string; projectId: string },
  input: { storageKey: string; mime: string; sizeBytes: number },
): Promise<{ id: string; ref: string }> {
  const [row] = await db
    .insert(productPageImages)
    .values({ pageId: page.id, projectId: page.projectId, storageKey: input.storageKey, mime: input.mime, sizeBytes: input.sizeBytes, uploadedBy: viewer.id })
    .returning({ id: productPageImages.id });
  return { id: row!.id, ref: `${PRODUCT_IMAGE_REF_PREFIX}${row!.id}` };
}

export const productImageKey = (projectId: string, pageId: string) => `product/${projectId}/${pageId}/${randomUUID()}`;

export async function productImageOf(db: Db, pageId: string, imageId: string): Promise<{ storageKey: string; mime: string } | null> {
  const [row] = await db
    .select({ storageKey: productPageImages.storageKey, mime: productPageImages.mime })
    .from(productPageImages)
    .where(and(eq(productPageImages.id, imageId), eq(productPageImages.pageId, pageId)));
  return row ?? null;
}

export async function productPageProject(db: Db, pageId: string): Promise<{ id: string; projectId: string } | null> {
  const [row] = await db.select({ id: productPages.id, projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
  return row ?? null;
}
