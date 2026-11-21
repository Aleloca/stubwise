import { productDocJobs, productPageBlockIds, productPageImages, productPageRevisions, productPages, productWireframes, type Db } from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import {
  applyBlockOps,
  blockIdsOf,
  productBlockSchema,
  productSearchText,
  type DrawWireframeInput,
  type ProductBlock,
  type ProductBlockChange,
  type ProductBlockOp,
} from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { ProductDocsError } from "./product-docs.js";
import { holdTouchedSections } from "./product-docs-ops.js";
import { notifyProductRevision, notifyProductWireframe } from "./product-live-notify.js";

/**
 * Area 11, F6 — le bozze di schermata di Claude (il prototipo:
 * `data/productDocs/wireframes.ts`, shape product-claude-backlog §3.5–3.7):
 * - «Draw this screen» (dopo un blocco, o al posto di un paragrafo vuoto o col
 *   solo «/…» del menu): il blocco `wireframe` nasce SUBITO (`drawing`, con
 *   una revisione di chi chiede `via: "claude"`), il disegno lo fa il worker
 *   (un lavoro della coda della doc). Chiede `docs.edit`; col budget del mese
 *   finito non parte (409 `ai_blocked`), la pausa della coda non lo ferma;
 * - «Redraw»: una variante nuova, che il worker aggiunge e mette nel blocco
 *   (l'etichetta «Claude's sketch» torna); `fromVariant` = quella che si
 *   vedeva, così il doppio clic non ne chiede due; mentre disegna, niente;
 * - «Pick» una variante già disegnata, «Keep» (toglie l'etichetta),
 *   «Replace with an image» (un'immagine caricata nella pagina, stesso id):
 *   revisioni della PERSONA, senza `via`;
 * - le prese delle sezioni valgono come per ogni scrittura (409 `section_busy`).
 * Lo SVG arriva al client GIÀ ripulito (lo fa il worker con
 * `sanitizeWireframeSvg`, prima di salvarlo).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type Wireframe = Extract<ProductBlock, { type: "wireframe" }>;

const notFound = () => new ProductDocsError(404, "not_found", "Not found");
const invalid = (code: string, message: string) => new ProductDocsError(422, code, message);

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

async function editable(db: Db, viewer: Viewer, pageId: string) {
  const [page] = await db.select({ projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
  if (!page) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, page.projectId);
  if (!perms?.has("docs.view")) throw notFound();
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  return page.projectId;
}

/** Una scrittura del corpo per conto di chi guarda, sotto il lock della pagina e con le prese delle sezioni. */
async function writeOps(tx: Db, viewer: Viewer, pageId: string, build: (blocks: ProductBlock[]) => ProductBlockOp[] | null, opts: { via?: "claude" } = {}): Promise<{ revisionId: string | null; blocks: ProductBlock[] }> {
  const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("no key update");
  if (!page) throw notFound();
  const blocks = readBlocks(page.blocks);
  const ops = build(blocks);
  if (!ops || ops.length === 0) return { revisionId: null, blocks };
  await holdTouchedSections(tx, viewer, pageId, blocks, ops);
  let next: { blocks: ProductBlock[]; changes: ProductBlockChange[] };
  try {
    next = applyBlockOps(blocks, ops);
  } catch {
    throw invalid("invalid_op", "The block isn't on the page");
  }
  if (next.changes.length === 0) return { revisionId: null, blocks };
  const given = new Set((await tx.select({ id: productPageBlockIds.blockId }).from(productPageBlockIds).where(eq(productPageBlockIds.pageId, pageId))).map((r) => r.id));
  const fresh = next.blocks.flatMap(blockIdsOf).filter((id) => !given.has(id));
  if (fresh.length > 0) await tx.insert(productPageBlockIds).values(fresh.map((blockId) => ({ pageId, blockId }))).onConflictDoNothing();
  const [{ seq }] = (await tx
    .update(productPages)
    .set({ blocks: next.blocks, searchText: productSearchText(page.title, next.blocks), revSeq: sql`${productPages.revSeq} + 1`, updatedBy: viewer.id, updatedAt: new Date() })
    .where(eq(productPages.id, pageId))
    .returning({ seq: productPages.revSeq })) as [{ seq: number }];
  const [rev] = await tx
    .insert(productPageRevisions)
    .values({ pageId, sessionId: null, seq, lastSeq: seq, actorId: viewer.id, kind: "edit", via: opts.via ?? null, changes: next.changes as unknown[] })
    .returning({ id: productPageRevisions.id });
  await notifyProductRevision(tx, { pageId, seq, kind: "edit", actorId: viewer.id, sessionId: null });
  return { revisionId: rev!.id, blocks: next.blocks };
}

/** Un paragrafo che si può sostituire: vuoto, o col solo «/…» del menu da cui si è scelto. */
const replaceable = (block: ProductBlock | undefined): boolean => block?.type === "paragraph" && (block.content.text.trim() === "" || block.content.text.startsWith("/"));

/** Accoda il disegno (o una variante nuova) della bozza: un lavoro della coda della doc. */
async function enqueueDrawing(tx: Db, projectId: string, wireframeId: string): Promise<void> {
  await tx
    .insert(productDocJobs)
    .values({ projectId, sourceKind: "wireframe", sourceId: wireframeId })
    .onConflictDoUpdate({
      target: [productDocJobs.projectId, productDocJobs.sourceKind, productDocJobs.sourceId],
      set: { status: "queued", heldReason: null, lastHeldReason: null, attempts: 0, error: null, facts: null, pagesDone: sql`'{}'::uuid[]`, notBefore: null, finishedAt: null },
    });
}

const budgetGuard = async (db: Db, costFn?: (db: Db) => Promise<number>) => {
  if ((await aiBudgetState(db, costFn)).exhausted) throw new ProductDocsError(409, "ai_blocked", "The monthly AI budget is used up");
};

/** «Draw this screen»: il blocco nasce subito (`drawing`), il disegno arriva dal worker. */
export async function drawWireframe(db: Db, viewer: Viewer, pageId: string, at: DrawWireframeInput, budget: { monthlyCostUsdFn?: (db: Db) => Promise<number> } = {}): Promise<{ blockId: string; wireframeId: string }> {
  const projectId = await editable(db, viewer, pageId);
  await budgetGuard(db, budget.monthlyCostUsdFn);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const wireframeId = randomUUID();
    let blockId = "";
    await writeOps(
      tx,
      viewer,
      pageId,
      (blocks) => {
        if ("replaceId" in at) {
          const target = blocks.find((b) => b.id === at.replaceId);
          if (!target) throw notFound();
          if (!replaceable(target)) throw invalid("invalid_replace", "Only an empty paragraph can become a screen sketch");
          blockId = at.replaceId;
          return [{ op: "set", block: { id: blockId, type: "wireframe", wireframeId, variant: 0 } as Wireframe } as ProductBlockOp];
        }
        if (at.afterId !== null && !blocks.some((b) => b.id === at.afterId)) throw notFound();
        blockId = `blk-${randomUUID()}`;
        return [{ op: "insert", afterId: at.afterId, block: { id: blockId, type: "wireframe", wireframeId, variant: 0 } as Wireframe } as ProductBlockOp];
      },
      { via: "claude" },
    );
    await tx.insert(productWireframes).values({ id: wireframeId, pageId, projectId, blockId, requestedBy: viewer.id });
    await enqueueDrawing(tx, projectId, wireframeId);
    await notifyProductWireframe(tx, { pageId, wireframeId, status: "drawing" });
    return { blockId, wireframeId };
  });
}

/** La bozza `blockId` della pagina, con la sua riga: 404 se non c'è, 422 se il blocco non è una bozza. */
async function sketchOf(tx: Db, pageId: string, blockId: string) {
  const [page] = await tx.select({ blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, pageId));
  const block = readBlocks(page?.blocks).find((b) => b.id === blockId);
  if (!block) throw notFound();
  if (block.type !== "wireframe") throw invalid("invalid_wireframe", "The block is not a screen sketch");
  const [row] = await tx.select().from(productWireframes).where(and(eq(productWireframes.id, block.wireframeId), eq(productWireframes.pageId, pageId)));
  if (!row) throw invalid("invalid_wireframe", "The block is not a screen sketch");
  return { block, row };
}

/** «Redraw»: una variante nuova (la mette nel blocco il worker, quando l'ha disegnata). */
export async function redrawWireframe(db: Db, viewer: Viewer, pageId: string, blockId: string, fromVariant: number | undefined, budget: { monthlyCostUsdFn?: (db: Db) => Promise<number> } = {}): Promise<{ blockId: string }> {
  const projectId = await editable(db, viewer, pageId);
  await budgetGuard(db, budget.monthlyCostUsdFn);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const { block, row } = await sketchOf(tx, pageId, blockId);
    // Il doppio clic (la variante che si vedeva è già cambiata), o un disegno già in corso: niente.
    if ((fromVariant !== undefined && block.variant !== fromVariant) || row.status === "drawing") return { blockId };
    await tx.update(productWireframes).set({ status: "drawing", error: null, requestedBy: viewer.id, updatedAt: new Date() }).where(eq(productWireframes.id, row.id));
    await enqueueDrawing(tx, projectId, row.id);
    await notifyProductWireframe(tx, { pageId, wireframeId: row.id, status: "drawing" });
    return { blockId };
  });
}

/** «Pick»: una variante già disegnata, con una revisione di chi sceglie. */
export async function pickWireframe(db: Db, viewer: Viewer, pageId: string, blockId: string, variant: number): Promise<{ revisionId: string | null }> {
  await editable(db, viewer, pageId);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const { block, row } = await sketchOf(tx, pageId, blockId);
    if (variant >= row.variants.length) throw invalid("invalid_variant", "That variant hasn't been drawn");
    if (block.variant === variant) return { revisionId: null };
    const { revisionId } = await writeOps(tx, viewer, pageId, () => [{ op: "set", block: { ...block, variant } } as ProductBlockOp]);
    return { revisionId };
  });
}

/** «Keep»: toglie l'etichetta «Claude's sketch». Già tenuta: nessuna scrittura. */
export async function keepWireframe(db: Db, viewer: Viewer, pageId: string, blockId: string): Promise<{ revisionId: string | null }> {
  await editable(db, viewer, pageId);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const { block } = await sketchOf(tx, pageId, blockId);
    if (block.kept === true) return { revisionId: null };
    const { revisionId } = await writeOps(tx, viewer, pageId, () => [{ op: "set", block: { ...block, kept: true } } as ProductBlockOp]);
    return { revisionId };
  });
}

/** «Replace with an image»: un'immagine caricata in QUESTA pagina al posto della bozza, con lo stesso id. */
export async function replaceWireframeWithImage(db: Db, viewer: Viewer, pageId: string, blockId: string, image: { src: string; alt: string }): Promise<{ revisionId: string | null }> {
  await editable(db, viewer, pageId);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [page] = await tx.select({ blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, pageId));
    const now = readBlocks(page?.blocks).find((b) => b.id === blockId);
    // Il secondo clic con la stessa immagine non scrive.
    if (now?.type === "image" && now.src === image.src && now.alt === image.alt) return { revisionId: null };
    const { block } = await sketchOf(tx, pageId, blockId);
    const imageId = image.src.slice("product-image:".length);
    const [img] = await tx.select({ id: productPageImages.id }).from(productPageImages).where(and(eq(productPageImages.id, imageId), eq(productPageImages.pageId, pageId)));
    if (!img) throw invalid("invalid_image", "The image was not uploaded to this page");
    const { revisionId } = await writeOps(tx, viewer, pageId, () => [{ op: "set", block: { id: block.id, type: "image", src: image.src, caption: "", alt: image.alt } as ProductBlock } as ProductBlockOp]);
    return { revisionId };
  });
}
