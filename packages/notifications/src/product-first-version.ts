import { productComments, productFirstVersions, productPageBlockIds, productPageFollows, productPageRevisions, productPages, type Db } from "@stubwise/db";
import { blockChanges, blockIdsOf, cleanQuote, productSearchText, type ProductBlock, type ProductQuestion, type RichText } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { agentUserId, freshIds } from "./product-docs-write.js";
import { projectPermissionsByProject } from "./project-access.js";

/**
 * Area 11, F6 — la scrittura di UNA pagina della prima versione di Claude, in
 * `@stubwise/notifications` perché la chiama il worker (il lavoro della coda
 * della doc) con le stesse regole dello scrittore di F5. Una transazione per
 * pagina, così chi guarda vede l'albero crescere:
 * - la riga della prima versione si blocca; se non sta più scrivendo
 *   (annullata) non si scrive niente;
 * - «Stop» (`stop_requested`) si onora QUI, prima della pagina: la prima
 *   versione finisce `interrupted`;
 * - chi l'ha chiesta deve avere ancora `docs.edit`, e il genitore della pagina
 *   (la pagina scritta prima, un livello sopra) deve esserci ancora:
 *   altrimenti si ferma `interrupted`, e le pagine scritte restano;
 * - la pagina nasce per conto di chi l'ha chiesta (che la segue): una
 *   revisione `first_version` di Claude (`via: "claude"`), senza segni; tutti
 *   gli id dei blocchi li genera il server;
 * - la stessa pagina non si scrive due volte (`written` dice fin dove è
 *   arrivata): un lavoro ripreso riparte dalla pagina dopo.
 * Il registro decisioni qui non si nomina.
 */

export interface FirstVersionDraftPage {
  title: string;
  depth: number;
  blocks: ProductBlock[];
  /**
   * I dubbi della pagina: una domanda `vague` di Claude sul blocco
   * `blockIndex` (la frase di ripiego), con «Update it» = `apply` e «Open a
   * request» = `request`. Senza card (il prototipo: `notify: false`).
   */
  questions?: { blockIndex: number; apply: RichText; request: { title: string; description: string } | null }[];
}

export type FirstVersionStep = { kind: "written"; pageId: string; last: boolean } | { kind: "stopped" } | { kind: "gone" };

const lockTree = (tx: Db, projectId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stubwise-product-tree:${projectId}`}))`);

/** Chiude la prima versione: finita, o fermata prima della fine. Il testo incollato non resta. */
const finish = (tx: Db, id: string, interrupted: boolean, error: string | null = null) =>
  tx.update(productFirstVersions).set({ status: "done", interrupted, error, pastedText: null, finishedAt: new Date() }).where(eq(productFirstVersions.id, id));

/** La pagina `index` della bozza (`draft`), o lo stop. */
export async function writeFirstVersionPage(db: Db, firstVersionId: string, index: number): Promise<FirstVersionStep> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [fv] = await tx.select().from(productFirstVersions).where(eq(productFirstVersions.id, firstVersionId)).for("update");
    if (!fv || fv.status !== "writing") return { kind: "gone" } as const;
    const draft = (fv.draft ?? []) as FirstVersionDraftPage[];
    const written = fv.written;
    // Già scritta (un lavoro ripreso): si riparte dalla dopo.
    if (index < written.length) return { kind: "written", pageId: written[index]!.pageId, last: index === draft.length - 1 } as const;
    if (fv.stopRequested) {
      await finish(tx, fv.id, true);
      return { kind: "stopped" } as const;
    }
    const page = draft[index];
    if (!page) {
      await finish(tx, fv.id, false);
      return { kind: "stopped" } as const;
    }
    const canEdit = fv.startedBy !== null && (await projectPermissionsByProject(tx, fv.startedBy, [fv.projectId])).get(fv.projectId)?.has("docs.edit") === true;
    if (!canEdit) {
      await finish(tx, fv.id, true, "no_permission");
      return { kind: "stopped" } as const;
    }
    await lockTree(tx, fv.projectId);
    // Il genitore: l'ultima pagina scritta un livello sopra. Se non c'è più, la prima versione si ferma.
    let parentId: string | null = null;
    if (page.depth > 0) {
      for (let i = index - 1; i >= 0; i--) {
        if (draft[i]!.depth === page.depth - 1) {
          parentId = written[i]?.pageId ?? null;
          break;
        }
      }
      const [parent] = parentId ? await tx.select({ id: productPages.id }).from(productPages).where(and(eq(productPages.id, parentId), eq(productPages.projectId, fv.projectId))) : [];
      if (!parent) {
        await finish(tx, fv.id, true, "parent_gone");
        return { kind: "stopped" } as const;
      }
    }
    const agentId = await agentUserId(tx);
    const blocks = page.blocks.map(freshIds);
    const [siblings] = (await tx.execute(
      parentId === null
        ? sql`select count(*)::int as n from product_pages where project_id = ${fv.projectId} and parent_id is null`
        : sql`select count(*)::int as n from product_pages where project_id = ${fv.projectId} and parent_id = ${parentId}`,
    )) as unknown as { n: number }[];
    const [created] = await tx
      .insert(productPages)
      .values({ projectId: fv.projectId, parentId, order: siblings?.n ?? 0, title: page.title, blocks, searchText: productSearchText(page.title, blocks), createdBy: fv.startedBy, updatedBy: agentId, revSeq: 1 })
      .returning({ id: productPages.id });
    const ids = blocks.flatMap(blockIdsOf);
    if (ids.length > 0) await tx.insert(productPageBlockIds).values(ids.map((blockId) => ({ pageId: created!.id, blockId }))).onConflictDoNothing();
    const [rev] = await tx
      .insert(productPageRevisions)
      .values({ pageId: created!.id, seq: 1, lastSeq: 1, actorId: agentId, kind: "first_version", via: "claude", onBehalfOf: fv.startedBy, changes: blockChanges([], blocks) as unknown[] })
      .returning({ id: productPageRevisions.id });
    // Chi l'ha chiesta segue le pagine (come chi crea una pagina).
    if (fv.startedBy) await tx.insert(productPageFollows).values({ pageId: created!.id, userId: fv.startedBy }).onConflictDoNothing();
    // I dubbi: una domanda di Claude sulla frase di ripiego, nella stessa scrittura. Senza card.
    const sourceIds = (fv.sources as { kind: string; id?: string; fileId?: string }[]).flatMap((s) => (s.id ? [s.id] : s.fileId ? [s.fileId] : []));
    for (const [i, q] of (page.questions ?? []).entries()) {
      const anchor = blocks[q.blockIndex];
      if (!anchor || !("content" in anchor)) continue;
      const question: ProductQuestion = {
        sourceRef: { kind: "first_version", ids: sourceIds.slice(0, 50) },
        factId: `fv-${index}-${i}`,
        reason: "vague",
        forId: null,
        apply: q.apply,
        built: null,
        request: q.request,
        recommended: "keep",
        seq: 1,
      };
      await tx.insert(productComments).values({ pageId: created!.id, anchorId: anchor.id, quote: cleanQuote(anchor.content.text), body: "", authorId: agentId, question: question as unknown as Record<string, unknown> });
    }
    const last = index === draft.length - 1;
    await tx
      .update(productFirstVersions)
      .set({ written: [...written, { pageId: created!.id, revisionId: rev!.id }] })
      .where(eq(productFirstVersions.id, fv.id));
    if (last) await finish(tx, fv.id, false);
    // Il codice della pagina (`<PRJ>-D<n>`) lo dà il trigger della 0202.
    return { kind: "written", pageId: created!.id, last } as const;
  });
}

/** Una prima versione che non si può scrivere (il modello non ha risposto): finita e fermata, col motivo. */
export async function failFirstVersion(db: Db, firstVersionId: string, error: string): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [fv] = await tx.select({ status: productFirstVersions.status }).from(productFirstVersions).where(eq(productFirstVersions.id, firstVersionId)).for("update");
    if (fv?.status === "writing") await finish(tx, firstVersionId, true, error);
  });
}
