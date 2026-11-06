import type { ProductBlock, ProductBlockChange, ProductBlockOp, RichText } from "../../data/model";
import { concatRich, splitRich } from "./richText";

/**
 * Il documento a blocchi della doc di prodotto (area 11a, decisione 4): le
 * operazioni sui blocchi, le ancore dei commenti e il testo per ricerca e
 * chat. Funzioni pure: nessuna modifica sul posto degli array in ingresso.
 */

export { CODE_TOKEN_RE } from "./richText";

/** Un id di blocco nuovo. Un id non si riusa mai: chi scrive tiene l'insieme di quelli dati. */
export function makeBlockId(): string {
  return `blk-${crypto.randomUUID()}`;
}

type TextBlock = Extract<ProductBlock, { content: RichText }>;

/** Il blocco ha una frase (titolo, paragrafo, citazione, voce, to-do). */
export function isTextBlock(block: ProductBlock): block is TextBlock {
  return "content" in block;
}

/**
 * Le ancore di un blocco, cioè dove si appoggia un commento: l'id del blocco
 * per i testi, le immagini, i file, le decisioni e il separatore; gli id
 * delle celle, riga per riga, per una tabella (la tabella intera non è
 * un'ancora).
 */
export function anchorIdsOf(block: ProductBlock): string[] {
  if (block.type === "table") return block.rows.flatMap((r) => r.cells.map((c) => c.id));
  return [block.id];
}

/** Il contenuto di ogni ancora del blocco: la frase, o la didascalia di un'immagine; `null` = nessun testo. */
function anchorContents(block: ProductBlock): Map<string, RichText | string | null> {
  const out = new Map<string, RichText | string | null>();
  if (block.type === "table") {
    for (const row of block.rows) for (const cell of row.cells) out.set(cell.id, cell.content);
  } else if (isTextBlock(block)) {
    out.set(block.id, block.content);
  } else if (block.type === "image") {
    out.set(block.id, block.caption);
  } else {
    out.set(block.id, null);
  }
  return out;
}

/**
 * Il solo testo di un'ancora (senza segni, mai un href): la frase, la cella o
 * la didascalia; `""` per un separatore, un file o una decisione. `null` =
 * l'ancora non c'è più (anche l'id di una tabella, che non è un'ancora).
 */
export function anchorText(blocks: readonly ProductBlock[], anchorId: string): string | null {
  for (const block of blocks) {
    const contents = anchorContents(block);
    if (!contents.has(anchorId)) continue;
    const c = contents.get(anchorId);
    return c === null || c === undefined ? "" : typeof c === "string" ? c : c.text;
  }
  return null;
}

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

/** Le ancore il cui testo, i cui segni o la cui presenza cambiano da `before` ad `after`. */
function changedAnchors(before: ProductBlock | null, after: ProductBlock | null): string[] {
  const a = before ? anchorContents(before) : new Map<string, RichText | string | null>();
  const b = after ? anchorContents(after) : new Map<string, RichText | string | null>();
  const out: string[] = [];
  for (const [id, content] of a) if (!b.has(id) || !same(content, b.get(id))) out.push(id);
  for (const id of b.keys()) if (!a.has(id)) out.push(id);
  // Una bozza di schermata non ha testo: rifatta (variante) o tenuta («Tieni»)
  // cambia lo stesso la sua ancora, così «Annulla» e «toccata dopo» la vedono.
  if (before?.type === "wireframe" && after?.type === "wireframe" && !same(before, after) && !out.includes(after.id))
    out.push(after.id);
  return out;
}

/**
 * I cambi fra due versioni di una pagina, uno per blocco toccato: prima i
 * blocchi della versione nuova nel loro ordine, poi quelli tolti. Un blocco
 * solo spostato non è un cambio; un segno in più sì. Da due elenchi non si
 * riconosce un'unione (`mergedFrom`): quella la dà `applyBlockOps`, che
 * vede le operazioni.
 */
export function blockChanges(before: readonly ProductBlock[], after: readonly ProductBlock[]): ProductBlockChange[] {
  const old = new Map(before.map((b) => [b.id, b]));
  const now = new Set(after.map((b) => b.id));
  const out: ProductBlockChange[] = [];
  for (const block of after) {
    const prev = old.get(block.id) ?? null;
    if (prev !== null && same(prev, block)) continue;
    out.push({ blockId: block.id, before: prev, after: block, anchors: changedAnchors(prev, block) });
  }
  for (const block of before) {
    if (now.has(block.id)) continue;
    out.push({ blockId: block.id, before: block, after: null, anchors: changedAnchors(block, null) });
  }
  return out;
}

const invalidOp = (): never => {
  throw new Error("invalid: op");
};

/**
 * Applica le operazioni in ordine e restituisce la pagina nuova coi suoi
 * cambi. Lancia `invalid: op` per un id che manca, un `insert` di un id già
 * presente (anche come cella: le ancore di una pagina sono uniche) o di
 * un id che un `merge` ha assorbito nella stessa scrittura, un
 * `move` dopo sé stesso, un `merge` di un blocco senza testo, o un `merge`
 * che tocca un blocco già unito nella stessa scrittura (le ancore assorbite
 * due volte non avrebbero un solo punto d'arrivo).
 *
 * `mergedFrom` nasce SOLO da un'operazione `merge` (ruling P6): l'offset è la
 * lunghezza del primo al momento dell'unione.
 */
export function applyBlockOps(
  blocks: readonly ProductBlock[],
  ops: readonly ProductBlockOp[],
): { blocks: ProductBlock[]; changes: ProductBlockChange[] } {
  let list = [...blocks];
  const merged = new Map<string, { anchorId: string; offset: number }>();
  const inMerge = new Set<string>();
  const indexOf = (id: string) => {
    const i = list.findIndex((b) => b.id === id);
    return i < 0 ? invalidOp() : i;
  };
  const insertAfter = (afterId: string | null, block: ProductBlock) => {
    const at = afterId === null ? 0 : indexOf(afterId) + 1;
    list.splice(at, 0, block);
  };

  for (const op of ops) {
    switch (op.op) {
      case "set":
        list[indexOf(op.block.id)] = op.block;
        break;
      case "insert":
        // Un id assorbito da un merge della stessa scrittura non rientra:
        // `mergedFrom` lo dà per unito, e le sue ancore sono già sul primo.
        if (list.some((b) => b.id === op.block.id) || inMerge.has(op.block.id)) invalidOp();
        insertAfter(op.afterId, op.block);
        break;
      case "delete":
        list.splice(indexOf(op.blockId), 1);
        break;
      case "move": {
        if (op.afterId === op.blockId) invalidOp();
        const [block] = list.splice(indexOf(op.blockId), 1);
        insertAfter(op.afterId, block!);
        break;
      }
      case "merge": {
        if (op.firstId === op.secondId || inMerge.has(op.firstId) || inMerge.has(op.secondId)) invalidOp();
        const i = indexOf(op.firstId);
        const j = indexOf(op.secondId);
        const first = list[i]!;
        const second = list[j]!;
        if (!isTextBlock(first) || !isTextBlock(second)) invalidOp();
        merged.set(first.id, { anchorId: second.id, offset: (first as TextBlock).content.text.length });
        inMerge.add(first.id).add(second.id);
        list[i] = mergeBlocks(first, second);
        list = list.filter((b) => b.id !== second.id);
        break;
      }
    }
    const anchors = list.flatMap(anchorIdsOf);
    if (new Set(anchors).size !== anchors.length) invalidOp();
  }

  const changes = blockChanges(blocks, list).map((c) => {
    const from = merged.get(c.blockId);
    return from !== undefined && c.after !== null ? { ...c, mergedFrom: from } : c;
  });
  return { blocks: list, changes };
}

/**
 * Divide un blocco di testo in `offset`: il primo tiene id, tipo e la testa
 * del testo (i commenti restano lì); il secondo prende `newId` e lo stesso
 * tipo, tranne un titolo, che dopo il taglio continua come paragrafo, e un
 * to-do, che riparte non spuntato. Un segno a cavallo del taglio resta su
 * entrambe le parti. Lancia `invalid: split` su un blocco senza testo.
 */
export function splitBlock(block: ProductBlock, offset: number, newId: string): [ProductBlock, ProductBlock] {
  if (!isTextBlock(block)) throw new Error("invalid: split");
  const [head, tail] = splitRich(block.content, offset);
  const first = { ...block, content: head } as ProductBlock;
  let second: ProductBlock;
  if (block.type === "heading") second = { id: newId, type: "paragraph", content: tail };
  else if (block.type === "todo") second = { ...block, id: newId, checked: false, content: tail };
  else second = { ...block, id: newId, content: tail } as ProductBlock;
  return [first, second];
}

/** Unisce due blocchi di testo: id, tipo e campi del primo, le frasi in fila. Lancia `invalid: merge` su un blocco senza testo. */
export function mergeBlocks(first: ProductBlock, second: ProductBlock): ProductBlock {
  if (!isTextBlock(first) || !isTextBlock(second)) throw new Error("invalid: merge");
  return { ...first, content: concatRich(first.content, second.content) } as ProductBlock;
}

/**
 * Il testo della pagina per ricerca e chat: una riga per ancora con testo
 * (frasi, celle, didascalie), nell'ordine della pagina. Mai un href né un
 * segno: solo le lettere.
 */
export function plainTextOf(blocks: readonly ProductBlock[]): string {
  return blocks
    .flatMap((b) => anchorIdsOf(b).map((id) => anchorText([b], id) ?? ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** L'estratto di una pagina: il primo paragrafo non vuoto, al più 200 caratteri; `""` se non c'è. */
export function excerptOfBlocks(blocks: readonly ProductBlock[]): string {
  for (const b of blocks) {
    if (b.type === "paragraph" && b.content.text.trim() !== "") return b.content.text.trim().slice(0, 200);
  }
  return "";
}
