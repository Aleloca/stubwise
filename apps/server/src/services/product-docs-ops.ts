import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  driveFiles,
  productPageBlockIds,
  productPageFollows,
  productPageImages,
  productPageRevisions,
  productPages,
  projectDecisions,
  projects,
  users,
  takeSection,
  type Db,
} from "@stubwise/db";
import {
  PRODUCT_BLOCKS_MAX,
  PRODUCT_PAGE_BYTES_MAX,
  PRODUCT_IMAGE_REF_PREFIX,
  applyBlockOps,
  blockIdsOf,
  mergeChanges,
  productBlockSchema,
  productBlockWriteSchema,
  productSearchText,
  PRODUCT_TOP_SECTION,
  sectionKeyOf,
  validProductBlock,
  type ProductBlock,
  type ProductBlockChange,
  type ProductBlockOp,
  type ProductRevisionView,
  type SaveProductBlocksInput,
} from "@stubwise/shared";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { moveMergedAnchors, restoreMergedAnchors } from "./product-comments.js";
import { PRODUCT_HOLD_TTL_MS, notifyProductRevision } from "./product-live-notify.js";
import { ProductDocsError } from "./product-docs.js";

/**
 * Area 11, F1 — la scrittura del corpo di una pagina di prodotto, SOLO a
 * operazioni (l'invariante del design), la regola del prototipo
 * `writeProductBlocksAs` (`data/productDocs/writes.ts`):
 * - sotto `FOR UPDATE` della pagina;
 * - un id nuovo (blocco, riga, cella) non dev'essere mai stato dato in QUESTA
 *   pagina (`product_page_block_ids`), salvo ⌘Z: con `undoOf` (una revisione
 *   di questa pagina, di chi chiede e della sua sessione) si rimettono SOLO i
 *   blocchi che quella revisione ha tolto, uguali a com'erano;
 * - i segni validi (link solo http(s)); i riferimenti validati con la
 *   visibilità di chi salva (un file del Drive, una decisione, un'immagine
 *   della stessa pagina); i wireframe arrivano con F6;
 * - la revisione si unisce all'ultima della pagina se è della stessa persona
 *   e della stessa sessione (`mergeChanges`), altrimenti nasce;
 * - `baseSeq` più vecchio di una revisione di un ALTRO (persona o sessione):
 *   409 `stale` con quelle revisioni (il client le riapplica).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
/** I campi di Claude di una revisione che non è sua (F5): tutti vuoti. */
const NO_CLAUDE_FIELDS = { via: null, onBehalfOfId: null, onBehalfOfName: null, source: null, undo: null, undoByAnchor: {}, markIdByAnchor: {}, undoneCount: null, undoneById: null, undoneByName: null, undoOf: null, answerOf: null, wireframe: null } as const;
const invalid = (code: string, message: string) => new ProductDocsError(422, code, message);

const productBlocksWriteSchema = z.array(productBlockWriteSchema);
const IMAGE_ID = (src: string) => (src.startsWith(PRODUCT_IMAGE_REF_PREFIX) ? src.slice(PRODUCT_IMAGE_REF_PREFIX.length) : null);

export interface SaveProductBlocksResult {
  seq: number;
  revisionId: string | null;
}

/**
 * Area 11, F4: un'operazione tocca una sezione presa da un ALTRO. La
 * transazione si annulla: niente cambiato, nemmeno le prese chieste prima.
 */
export class ProductSectionBusyError extends ProductDocsError {
  constructor(
    readonly sectionId: string,
    readonly by: { id: string; name: string | null },
  ) {
    super(409, "section_busy", "Someone else is writing in this section");
  }
}

export { PRODUCT_HOLD_TTL_MS };

/**
 * Le sezioni che le operazioni toccano, sui blocchi di PRIMA (review di F4: dopo,
 * un blocco tolto o spostato non direbbe più dov'era): `set` e `delete` la
 * sezione del blocco; `insert` quella del blocco dopo cui entra (in cima senza);
 * `move` e `merge` le due sezioni.
 */
function touchedSections(blocks: readonly ProductBlock[], ops: readonly ProductBlockOp[]): string[] {
  const out = new Set<string>();
  const ids = new Set(blocks.flatMap(blockIdsOf));
  // Review di F4 (M7): un id che non è nella pagina non prende niente (le operazioni
  // daranno il loro 422, non un 409 sulla sezione in cima).
  const at = (anchorId: string | null) => {
    if (anchorId === null) out.add(PRODUCT_TOP_SECTION);
    else if (ids.has(anchorId)) out.add(sectionKeyOf(blocks, anchorId));
  };
  // Togliere (o spostare) un TITOLO fa confluire il suo contenuto nella sezione di sopra: anche quella.
  const above = (blockId: string) => {
    const i = blocks.findIndex((b) => b.id === blockId);
    if (i >= 0 && blocks[i]!.type === "heading") out.add(i === 0 ? PRODUCT_TOP_SECTION : sectionKeyOf(blocks, blocks[i - 1]!.id));
  };
  for (const op of ops) {
    if (op.op === "set") at(op.block.id);
    else if (op.op === "delete") {
      at(op.blockId);
      above(op.blockId);
    } else if (op.op === "insert") at(op.afterId);
    else if (op.op === "move") {
      at(op.blockId);
      above(op.blockId);
      at(op.afterId);
    } else {
      at(op.firstId);
      at(op.secondId);
      above(op.secondId);
    }
  }
  return [...out].sort();
}

/** Prende per chi scrive le sezioni che tocca; la prima presa da un altro è un 409 (nella stessa transazione). */
export async function holdTouchedSections(tx: Db, viewer: Viewer, pageId: string, blocks: readonly ProductBlock[], ops: readonly ProductBlockOp[]): Promise<void> {
  for (const sectionId of touchedSections(blocks, ops)) {
    const got = await takeSection(tx, { pageId, sectionId, userId: viewer.id, ttlMs: PRODUCT_HOLD_TTL_MS });
    if (got.taken) continue;
    const people = await visiblePersonIds(tx, viewer);
    const [u] = await tx.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, got.by));
    const sees = people === "all" || people.includes(got.by);
    throw new ProductSectionBusyError(sectionId, { id: got.by, name: sees && u ? personName(u) : null });
  }
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
        .select({ projectId: driveFiles.projectId, number: driveFiles.number, deletedAt: driveFiles.deletedAt, projectCode: projects.code })
        .from(driveFiles)
        .innerJoin(projects, eq(projects.id, driveFiles.projectId))
        .where(eq(driveFiles.id, after.fileId));
      const perms = file && file.deletedAt === null ? await projectPermissionsFor(tx, viewer, file.projectId) : null;
      // Il codice ESATTO del file (review di F1, M5), non solo il numero.
      if (!file || !perms || after.code !== `${file.projectCode}-F${file.number}`) throw invalid("invalid_drive", "The file is not one you can see");
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

/**
 * Il lock della riga di una pagina per scriverne il corpo. Review di F4 (I1): NO
 * KEY UPDATE, non UPDATE. Una presa nuova (il battito, in un'altra transazione)
 * controlla la sua FK su questa riga con FOR KEY SHARE, che un FOR UPDATE
 * bloccherebbe: le due si aspetterebbero a vicenda sulla stessa presa (40P01).
 * NO KEY UPDATE serializza le scritture della pagina lo stesso.
 */
export async function lockPageForWrite(tx: Db, pageId: string) {
  const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("no key update");
  return page;
}

export async function saveProductBlocks(db: Db, viewer: Viewer, pageId: string, input: SaveProductBlocksInput): Promise<SaveProductBlocksResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const page = await lockPageForWrite(tx, pageId);
    if (!page) throw new ProductDocsError(404, "not_found", "Not found");

    // Review di F1 (M8): un `baseSeq` che la pagina non ha ancora raggiunto è un client sbagliato.
    if (input.baseSeq > page.revSeq) throw invalid("invalid_base_seq", "baseSeq is ahead of the page");
    // Le revisioni che il client non ha visto e che non sono sue: della stessa
    // persona contano come sue quelle della stessa sessione e quelle senza
    // sessione (crea, rinomina, sposta).
    const newer = await tx
      .select()
      .from(productPageRevisions)
      .where(and(eq(productPageRevisions.pageId, pageId), gt(productPageRevisions.lastSeq, input.baseSeq)));
    const others = newer.filter((r) => !(r.actorId === viewer.id && (r.sessionId === input.sessionId || r.sessionId === null)));
    if (others.length > 0) throw new ProductStaleError(await revisionViews(tx, viewer, others));

    const blocks = readBlocks(page.blocks);
    // Review di F4 (M7): un blocco nuovo non si chiama come la sezione in cima.
    if (input.ops.some((op) => (op.op === "insert" || op.op === "set") && blockIdsOf(op.block as ProductBlock).includes(PRODUCT_TOP_SECTION))) {
      throw invalid("invalid_block_id", `"${PRODUCT_TOP_SECTION}" is not a block id`);
    }
    // F4: le sezioni che le operazioni toccano, prese PRIMA di applicarle (un 409 non lascia niente a metà).
    await holdTouchedSections(tx, viewer, pageId, blocks, input.ops as ProductBlockOp[]);
    const onPage = new Set(blocks.flatMap(blockIdsOf));
    const given = new Set((await tx.select({ id: productPageBlockIds.blockId }).from(productPageBlockIds).where(eq(productPageBlockIds.pageId, pageId))).map((r) => r.id));
    // Review di F1 (I4): ⌘Z rimette SOLO i blocchi che la revisione annullata ha
    // tolto, uguali a com'erano. La revisione dev'essere di questa pagina, di chi
    // chiede e della sua sessione; un `undoOf` inventato è 422.
    const restorable = new Map<string, ProductBlock>();
    if (input.undoOf) {
      const [undone] = await tx
        .select({ changes: productPageRevisions.changes })
        .from(productPageRevisions)
        .where(and(eq(productPageRevisions.id, input.undoOf), eq(productPageRevisions.pageId, pageId), eq(productPageRevisions.actorId, viewer.id), eq(productPageRevisions.sessionId, input.sessionId)));
      if (!undone) throw invalid("invalid_undo", "undoOf is not a revision of this session on this page");
      for (const c of undone.changes as ProductBlockChange[]) if (c.after === null && c.before !== null) restorable.set(c.blockId, c.before);
    }
    const sameBlock = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const op of input.ops) {
      if (op.op !== "insert" && op.op !== "set") continue;
      const block = op.block as ProductBlock;
      const fresh = blockIdsOf(block).filter((id) => op.op === "insert" || !onPage.has(id));
      if (!fresh.some((id) => given.has(id))) continue;
      const before = restorable.get(block.id);
      if (op.op !== "insert" || !before || !sameBlock(before, block)) throw invalid("block_id_taken", "A block id was already used on this page");
    }

    let next: { blocks: ProductBlock[]; changes: ProductBlockChange[] };
    try {
      next = applyBlockOps(blocks, input.ops as never);
    } catch {
      throw invalid("invalid_op", "An operation names a block that isn't there, or repeats an id");
    }
    if (next.blocks.length > PRODUCT_BLOCKS_MAX) throw invalid("too_many_blocks", `A page has at most ${PRODUCT_BLOCKS_MAX} blocks`);
    // Review di F1 (I3): il risultato si rivalida intero (un `merge` unisce due
    // testi e scavalcherebbe il tetto di un blocco) e il corpo ha un tetto in byte.
    if (!productBlocksWriteSchema.safeParse(next.blocks).success) throw invalid("invalid_block", "A block is not valid (or too long) after the operations");
    if (Buffer.byteLength(JSON.stringify(next.blocks)) > PRODUCT_PAGE_BYTES_MAX) throw invalid("page_too_large", "The page is too large");
    await checkReferences(tx, viewer, pageId, next.changes);
    if (next.changes.length === 0) return { seq: page.revSeq, revisionId: null };

    const fresh = next.blocks.flatMap(blockIdsOf).filter((id) => !given.has(id));
    if (fresh.length > 0) await tx.insert(productPageBlockIds).values(fresh.map((blockId) => ({ pageId, blockId }))).onConflictDoNothing();
    const [{ seq }] = (await tx
      .update(productPages)
      .set({ blocks: next.blocks, searchText: productSearchText(page.title, next.blocks), revSeq: sql`${productPages.revSeq} + 1`, updatedBy: viewer.id, updatedAt: new Date() })
      .where(eq(productPages.id, pageId))
      .returning({ seq: productPages.revSeq })) as [{ seq: number }];
    // F4: il canale dal vivo, al commit (un rollback la toglie). Gli stream dello stesso processo
    // ricevono le operazioni dalla rotta; questa NOTIFY serve agli altri (il worker, F5).
    await notifyProductRevision(tx, { pageId, seq, kind: "edit", actorId: viewer.id, sessionId: input.sessionId });
    // F2: i fili del blocco assorbito da un `merge` passano sul blocco unito, nella stessa scrittura;
    // un ⌘Z che rimette un blocco ci riporta i fili che il merge gli aveva tolto (review di F2, M4).
    await moveMergedAnchors(tx, pageId, input.ops as ProductBlockOp[]);
    if (input.undoOf) {
      const back = input.ops.flatMap((op) => (op.op === "insert" && restorable.has(op.block.id) ? [op.block.id] : []));
      await restoreMergedAnchors(tx, pageId, back);
    }

    // L'unione: all'ultima revisione della pagina, se è un `edit` della stessa persona e sessione (e non un ⌘Z).
    const [last] = await tx.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, pageId)).orderBy(desc(productPageRevisions.lastSeq)).limit(1);
    if (!input.undoOf && last && last.kind === "edit" && last.actorId === viewer.id && last.sessionId === input.sessionId) {
      const merged = mergeChanges(last.changes as ProductBlockChange[], next.changes);
      if (merged.length === 0) {
        // Tornato tutto com'era (review di F1, M11): la revisione non dice più niente, e non c'è.
        await tx.delete(productPageRevisions).where(eq(productPageRevisions.id, last.id));
        return { seq, revisionId: null };
      } else {
        await tx.update(productPageRevisions).set({ changes: merged as unknown[], lastSeq: seq, updatedAt: new Date() }).where(eq(productPageRevisions.id, last.id));
      }
      return { seq, revisionId: last.id };
    }
    const [rev] = await tx
      .insert(productPageRevisions)
      .values({ pageId, sessionId: input.sessionId, seq, lastSeq: seq, actorId: viewer.id, kind: "edit", undoOf: input.undoOf ?? null, changes: next.changes as unknown[] })
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
      // F5: i campi di Claude li aggiunge `withClaudeFields` (product-claude.ts) sulla lettura della cronologia.
      ...NO_CLAUDE_FIELDS,
    }));
}

/** Le revisioni di una pagina, dalla più recente (la rotta ha chiesto `docs.view`). */
export const PRODUCT_REVISIONS_PAGE = 100;

/** Le revisioni di una pagina, dalla più recente, a pagine di 100 (`before` = il `lastSeq` più vecchio già letto; review di F1, M10). */
export async function listProductRevisions(db: Db, viewer: Viewer, pageId: string, before?: number): Promise<ProductRevisionView[]> {
  const rows = await db
    .select()
    .from(productPageRevisions)
    .where(and(eq(productPageRevisions.pageId, pageId), before === undefined ? undefined : lt(productPageRevisions.lastSeq, before)))
    .orderBy(desc(productPageRevisions.lastSeq))
    .limit(PRODUCT_REVISIONS_PAGE);
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

export async function productImageOf(db: Db, pageId: string, imageId: string): Promise<{ id: string; storageKey: string; mime: string } | null> {
  const [row] = await db
    .select({ id: productPageImages.id, storageKey: productPageImages.storageKey, mime: productPageImages.mime })
    .from(productPageImages)
    .where(and(eq(productPageImages.id, imageId), eq(productPageImages.pageId, pageId)));
  return row ?? null;
}

export async function productPageProject(db: Db, pageId: string): Promise<{ id: string; projectId: string } | null> {
  const [row] = await db.select({ id: productPages.id, projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
  return row ?? null;
}

