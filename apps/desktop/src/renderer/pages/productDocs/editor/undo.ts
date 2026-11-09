import type { ProductBlock, ProductBlockOp } from "../../../data/model";
import { applyBlockOps } from "../../../domain/productDocs/blocks";

/**
 * ⌘Z / ⇧⌘Z dell'editor (shape product-editor.md [PE 21], maintainer 5 nov
 * 2026): una pila per pagina e per sessione dell'editor, fatta delle stesse
 * `ProductBlockOp` che la sessione ha salvato. Pura.
 */
export interface UndoEntry {
  forward: ProductBlockOp[];
  backward: ProductBlockOp[];
  /** I blocchi toccati prima e dopo (`null` = non c'era / non c'è). */
  before: Record<string, ProductBlock | null>;
  after: Record<string, ProductBlock | null>;
}

export interface UndoStack {
  undo: UndoEntry[];
  redo: UndoEntry[];
}

/** Le voci che la pila tiene: oltre, la più vecchia esce. */
export const UNDO_LIMIT = 100;

/** Uguaglianza strutturale, indipendente dall'ordine delle chiavi. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Le operazioni che portano `from` a `to`: prima i blocchi che in `to` non
 * ci sono, poi i blocchi cambiati, poi (nell'ordine di `to`) quelli da
 * rimettere o da spostare. Un blocco che torna ha il SUO id (ruling del
 * controller, 5 nov 2026: è lo stesso blocco, e i suoi commenti tornano con
 * lui).
 */
function opsBetween(from: readonly ProductBlock[], to: readonly ProductBlock[]): ProductBlockOp[] {
  const target = new Map(to.map((b) => [b.id, b]));
  const ops: ProductBlockOp[] = [];
  const list = from.filter((b) => {
    if (target.has(b.id)) return true;
    ops.push({ op: "delete", blockId: b.id });
    return false;
  });
  for (const b of list) {
    const want = target.get(b.id)!;
    if (!same(b, want)) ops.push({ op: "set", block: want });
  }
  const ids = list.map((b) => b.id);
  to.forEach((block, i) => {
    const afterId = i === 0 ? null : to[i - 1]!.id;
    const at = ids.indexOf(block.id);
    const prevNow = at <= 0 ? null : ids[at - 1]!;
    if (at >= 0 && prevNow === afterId) return;
    if (at >= 0) ids.splice(at, 1);
    ids.splice(afterId === null ? 0 : ids.indexOf(afterId) + 1, 0, block.id);
    ops.push(at < 0 ? { op: "insert", afterId, block } : { op: "move", blockId: block.id, afterId });
  });
  return ops;
}

/**
 * La voce di una scrittura della sessione; `null` se non cambia niente.
 * `backward` riporta la pagina a com'era; un blocco eliminato (anche
 * assorbito da un `merge`) torna con il suo stesso id: la scrittura di
 * `backward` dichiara `undoOf` e il livello dati lo accetta solo per un id
 * che quella sessione ha tolto (`writeProductBlocksAs`). Gli id non si
 * riusano fra blocchi diversi; lo stesso blocco ripristinato non è un riuso.
 */
export function undoEntryOf(blocks: readonly ProductBlock[], ops: readonly ProductBlockOp[]): UndoEntry | null {
  const after = applyBlockOps(blocks, ops).blocks;
  if (same(blocks, after)) return null;
  const old = new Map(blocks.map((b) => [b.id, b]));
  const now = new Map(after.map((b) => [b.id, b]));
  const touched = new Set<string>();
  for (const id of new Set([...old.keys(), ...now.keys()])) {
    if (!same(old.get(id) ?? null, now.get(id) ?? null)) touched.add(id);
  }
  for (const op of ops) if (op.op === "move" && now.has(op.blockId)) touched.add(op.blockId);
  const before: Record<string, ProductBlock | null> = {};
  const afterRec: Record<string, ProductBlock | null> = {};
  for (const id of touched) {
    before[id] = old.get(id) ?? null;
    afterRec[id] = now.get(id) ?? null;
  }
  return { forward: [...ops], backward: opsBetween(after, blocks), before, after: afterRec };
}

/** Si può annullare (o rifare) solo se i blocchi toccati sono ancora com'erano dopo (o prima). */
export function stillAsLeft(
  blocks: readonly ProductBlock[],
  expected: Record<string, ProductBlock | null>,
): boolean {
  const now = new Map(blocks.map((b) => [b.id, b]));
  return Object.entries(expected).every(([id, block]) => same(now.get(id) ?? null, block));
}

/** Una voce nuova: in cima, `redo` si svuota, al più `UNDO_LIMIT` voci. */
export function pushEntry(stack: UndoStack, entry: UndoEntry): UndoStack {
  return { undo: [...stack.undo, entry].slice(-UNDO_LIMIT), redo: [] };
}
