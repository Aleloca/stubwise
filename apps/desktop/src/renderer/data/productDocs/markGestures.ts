import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { nextSeq, state } from "../store";
import type { ProductBlock, ProductBlockOp, ProductPage, ProductRevision } from "../types";
import { invalid, notFound, writer } from "../writer";
import { emitProductPage } from "./events";
import { anchorUndo, anchorsOf, changeOf, isClaudeEdit, liveMarks, revisionUndo } from "./marks";
import { productPageById } from "./reads";
import { editablePage, writeProductBlocksAs } from "./writes";

// I gesti sul segno di Claude (11b, Task 3): «Va bene» e «Annulla». Le
// regole stanno in `marks.ts`, che legge; qui si scrive, sempre dal cancello
// del 11a (`editablePage`, `writeProductBlocksAs`).

const refused = (reason: string) => new Error(`refused: ${reason}`);

// --- «Va bene» -------------------------------------------------------------------

/**
 * «Va bene» sul segno di un'ancora: lo toglie a tutti, e solo il suo (una
 * frase alla volta). Un segno già tolto non scrive (doppio clic); un'ancora
 * senza segno né «Va bene» è `not_found`.
 */
export function acceptProductMarkAs(me: string, pageId: string, anchorId: string): void {
  const page = editablePage(me, pageId);
  const live = liveMarks(page).find((x) => x.mark.anchorId === anchorId);
  if (!live) {
    const accepted = state.productMarks.some((m) => m.pageId === pageId && m.anchorId === anchorId && m.acceptedById !== null);
    if (accepted) return;
    throw notFound();
  }
  live.mark.acceptedById = me;
  live.mark.acceptedSeq = nextSeq();
  emitProductPage(page.id, "blocks");
}

export async function acceptProductMark(pageId: string, anchorId: string): Promise<void> {
  acceptProductMarkAs(await writer("productDocs.acceptProductMark"), pageId, anchorId);
}

// --- «Annulla» -------------------------------------------------------------------

/** Le operazioni che rimettono le ancore al `before` della revisione. */
function undoOps(page: ProductPage, r: ProductRevision, anchors: readonly string[]): ProductBlockOp[] {
  const ops: ProductBlockOp[] = [];
  const tables = new Map<string, ProductBlock>();
  for (const anchorId of anchors) {
    const c = changeOf(r, anchorId)!;
    const now = page.blocks.find((b) => b.id === c.blockId);
    if (!now) throw invalid("anchor");
    if (c.before === null) {
      // Un blocco aggiunto da Claude: annullarlo lo toglie (tutte le sue ancore).
      if (!ops.some((o) => o.op === "delete" && o.blockId === c.blockId))
        ops.push({ op: "delete", blockId: c.blockId });
      continue;
    }
    if (c.before.type !== "table" || now.type !== "table") {
      ops.push({ op: "set", block: structuredClone(c.before) });
      continue;
    }
    const before = c.before.rows.flatMap((row) => row.cells).find((cell) => cell.id === anchorId);
    if (!before) throw invalid("anchor");
    const table = (tables.get(now.id) ?? structuredClone(now)) as Extract<ProductBlock, { type: "table" }>;
    for (const row of table.rows) for (const cell of row.cells) if (cell.id === anchorId) cell.content = structuredClone(before.content);
    tables.set(now.id, table);
  }
  for (const table of tables.values()) ops.push({ op: "set", block: table });
  return ops;
}

/**
 * «Annulla» una modifica di Claude: un'ancora, o senza `anchorId` tutte
 * quelle non ancora annullate («Annulla tutto»). Una revisione `kind:
 * "undo"` con `undoOf` = la revisione di Claude, a nome di chi annulla. Un
 * gesto spento lancia `refused: <ragione>` e non scrive; una revisione che
 * non è una modifica di Claude è `invalid: revision`.
 */
export function undoProductChangeAs(me: string, revisionId: string, anchorId?: string): { revisionId: string } {
  const r = state.productRevisions.find((x) => x.id === revisionId);
  const page = r ? productPageById(r.pageId) : undefined;
  if (!r || !page || docsAccess(me, page.projectId) !== "read") throw notFound();
  if (!isClaudeEdit(r)) throw invalid("revision");
  const all = anchorsOf(r);
  if (anchorId !== undefined && !all.includes(anchorId)) throw invalid("anchor");
  const people = visiblePeopleFor(me);
  const views = new Map(all.map((a) => [a, anchorUndo(me, r, a, page.projectId, people)]));
  const asked = anchorId === undefined ? all : [anchorId];
  const view =
    anchorId === undefined
      ? revisionUndo([...views.values()], { enabled: false, reason: "already_undone", byId: null })
      : views.get(anchorId)!;
  if (!view.enabled) throw refused(view.reason);
  const targets = asked.filter((a) => views.get(a)!.enabled);
  const written = writeProductBlocksAs(me, page.id, undoOps(page, r, targets), { kind: "undo", undoOf: r.id });
  if (written.revisionId === null) throw refused("already_undone");
  return { revisionId: written.revisionId };
}

export async function undoProductChange(revisionId: string, anchorId?: string): Promise<{ revisionId: string }> {
  return undoProductChangeAs(await writer("productDocs.undoProductChange"), revisionId, anchorId);
}
