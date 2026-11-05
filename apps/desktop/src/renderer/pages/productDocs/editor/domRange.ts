/**
 * Fra il DOM disegnato da `RichView` / `paintRich` (uno span per pezzo di
 * `richSegments`) e gli scarti del testo. Conta solo i nodi di testo, in
 * ordine di documento: un `<br>` di coda (`data-rich-trail`, l'a capo finale
 * reso visibile) non è una lettera.
 */

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Il nodo `t` sta prima del punto (`node`, `offset`) di un intervallo. */
function before(t: Text, node: Node, offset: number): boolean {
  if (node.nodeType === Node.TEXT_NODE) return t !== node && !!(node.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING);
  const child = node.childNodes[offset];
  if (!child) return node.contains(t) || !!(node.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING);
  return child !== t && !child.contains(t) && !!(child.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING);
}

/** Lo scarto nel testo del punto (`node`, `offset`) di una selezione dentro `root`; fuori da `root`, la fine. */
export function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const texts = textNodes(root);
  const total = texts.reduce((n, t) => n + t.data.length, 0);
  if (node !== root && !root.contains(node)) return total;
  let at = 0;
  for (const t of texts) {
    if (t === node) return at + Math.min(offset, t.data.length);
    if (before(t, node, offset)) at += t.data.length;
  }
  return Math.min(at, total);
}

/** Il punto del DOM per lo scarto `n`: al confine fra due pezzi, la fine del primo. */
function locate(root: HTMLElement, n: number): { node: Node; offset: number } {
  const texts = textNodes(root);
  let at = 0;
  for (const t of texts) {
    if (n <= at + t.data.length) return { node: t, offset: Math.max(0, n - at) };
    at += t.data.length;
  }
  const last = texts.at(-1);
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 };
}

/** L'intervallo del DOM fra gli scarti `start` e `end` dentro `root` (i cursori degli altri, Task 11). */
export function rangeIn(root: HTMLElement, start: number, end: number = start): Range {
  const a = locate(root, Math.min(start, end));
  const b = locate(root, Math.max(start, end));
  const range = root.ownerDocument.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Mette il cursore (o la selezione `start`–`end`) dentro `root`. */
export function placeCaret(root: HTMLElement, start: number, end: number = start): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const a = locate(root, Math.min(start, end));
  const b = locate(root, Math.max(start, end));
  const range = root.ownerDocument.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** La selezione dentro `root` come scarti; `null` se non c'è o esce da `root`. */
export function selectionIn(root: HTMLElement): { start: number; end: number } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const inside = (n: Node) => n === root || root.contains(n);
  if (!inside(range.startContainer) || !inside(range.endContainer)) return null;
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = offsetOf(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}
