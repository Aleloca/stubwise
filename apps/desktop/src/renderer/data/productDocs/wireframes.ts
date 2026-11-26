import { anchorText, plainTextOf } from "../../domain/productDocs/blocks";
import { manualStartBlockFor } from "../instance/blocks";
import { FALLBACK_WIREFRAME, PRODUCT_WIREFRAMES } from "../seed/productDocs/wireframes";

export { wireframeKey, wireframeSvg, wireframesOf } from "../seed/productDocs/wireframes";
import type { ProductSketch, ProductWireframeFailReason } from "../model";
import { newId, onStoreReset, state, storeGeneration, streamDelay } from "../store";
import type { ProductBlock, ProductPage } from "../types";
import { invalid, notFound, writer } from "../writer";
import { emitProductPage } from "./events";
import { editablePage, writeProductBlocksAs } from "./writes";

// Le bozze di schermata di Claude (11b, Task 7; shape product-claude-backlog.md
// §3.5–3.7). Le regole:
// - disegnare e rifare sono gesti di Claude per conto di chi chiede
//   (`via: "claude"`, `kind: "edit"`, senza fonte): chiedono `docs.edit` e,
//   come la prima versione, non partono col budget del mese finito
//   (`ai_blocked`, P48: la pausa della coda non li ferma). Nessun segno a
//   margine: la bozza ha la sua etichetta (P16, `recordProductMarks`);
// - il disegno lo sceglie la pagina: le parole del blocco vicino, poi quelle
//   della pagina, contro le parole chiave del seme (`pickWireframe`); senza
//   parole, lo schizzo generico;
// - «Rifai» passa alla variante seguente sul posto e rimette l'etichetta;
// - «Tieni» (maintainer, 6 nov 2026) toglie l'etichetta: una revisione della
//   PERSONA (nessun «per conto di»), che si annulla dalla cronologia come le
//   modifiche di Claude (`isUndoableRevision`, `marks.ts`).

//
// F6 (21 nov 2026, maintainer via orchestratrice; shape «Emendamento F6»):
// il disegno è ASINCRONO come sul server. «Disegna» scrive il blocco subito
// e Claude lo disegna dopo una pausa finta (`state.productSketches`, come la
// prima versione); «Rifai» non scrive al clic: la variante nuova (e la sua
// revisione) arriva alla fine. Un disegno può non riuscire, col suo motivo:
// il budget del mese finito nel frattempo, o `failNextSketch` (test).

type Wireframe = Extract<ProductBlock, { type: "wireframe" }>;

/** I disegni che hanno ancora la pausa da fare (`whenSketchesIdle`). */
const running = new Set<Promise<void>>();
/** Il motivo per cui il prossimo disegno non riuscirà (`failNextSketch`, test). */
let nextFailure: ProductWireframeFailReason | null = null;
/** Il fermo dei test (`holdSketches`): finché c'è, i disegni restano in corso. */
let held: { promise: Promise<void>; release: () => void } | null = null;
onStoreReset(() => {
  nextFailure = null;
  held?.release();
  held = null;
});

/**
 * Tiene in corso ogni disegno finché non si chiama la funzione restituita
 * (test): lo stato «in disegno» senza contare su una pausa vera, che sotto
 * carico finisce prima che la pagina si apra.
 */
export function holdSketches(): () => void {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = { promise, release };
  held = hold;
  return () => {
    if (held === hold) held = null;
    hold.release();
  };
}

/** Il prossimo disegno (e solo quello) non riesce, con questo motivo (test). */
export function failNextSketch(reason: ProductWireframeFailReason): void {
  nextFailure = reason;
}

/** Si risolve quando nessun disegno ha più la pausa da fare (test). */
export async function whenSketchesIdle(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

/** Il disegno in corso o non riuscito del blocco, se c'è. */
const sketchStateOf = (blockId: string): ProductSketch | undefined =>
  state.productSketches.find((s) => s.blockId === blockId);

/** Toglie lo stato del blocco: la bozza è pronta (o non è più una bozza). */
function clearSketch(entry: ProductSketch): void {
  state.productSketches = state.productSketches.filter((s) => s !== entry);
}

/** Circa un secondo, otto pause dello stream; con latenza 0 basta un microtask. */
function sketchPause(): Promise<void> {
  const ms = streamDelay() * 8;
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Claude comincia a disegnare il blocco: lo stato `drawing`, poi la fine dopo la pausa. */
function startSketch(me: string, pageId: string, blockId: string, kind: ProductSketch["kind"]): void {
  const old = sketchStateOf(blockId);
  if (old) clearSketch(old);
  // Un «Rifai» su una bozza mai disegnata (il primo disegno non è riuscito) è ancora il primo disegno.
  const entry: ProductSketch = {
    pageId,
    blockId,
    byId: me,
    kind: old?.kind === "draw" ? "draw" : kind,
    state: { status: "drawing" },
  };
  state.productSketches = [...state.productSketches, entry];
  const failure = nextFailure;
  nextFailure = null;
  const run = finishSketch(entry, failure, storeGeneration()).finally(() => running.delete(run));
  running.add(run);
}

/**
 * La fine del disegno: un blocco che non è più una bozza (sostituito,
 * annullato, tolto) non riceve nulla; altrimenti lo schizzo arriva (per
 * «Rifai» la variante seguente, con la revisione di Claude per conto di chi
 * l'ha chiesto) o il motivo per cui non è arrivato.
 */
async function finishSketch(entry: ProductSketch, failure: ProductWireframeFailReason | null, at: number): Promise<void> {
  await sketchPause();
  if (held) await held.promise;
  if (at !== storeGeneration() || !state.productSketches.includes(entry)) return;
  const page = state.productPages.find((p) => p.id === entry.pageId);
  const current = page?.blocks.find((b) => b.id === entry.blockId);
  if (!page || current?.type !== "wireframe") {
    clearSketch(entry);
    return;
  }
  // D-7.1: il budget si legge per chi ha chiesto il disegno (chi ha `plans.approve` lo scavalca).
  const reason =
    failure ?? (manualStartBlockFor(entry.byId, page.projectId)?.reason === "monthly_budget" ? "budget" : null);
  if (reason) {
    entry.state = { status: "failed", reason, drawn: entry.kind === "redraw" };
    emitProductPage(page.id, "blocks");
    return;
  }
  clearSketch(entry);
  if (entry.kind === "draw") {
    emitProductPage(page.id, "blocks");
    return;
  }
  try {
    writeProductBlocksAs(entry.byId, page.id, [{ op: "set", block: nextVariantOf(page, current) }], { via: "claude" });
  } catch {
    // Chi l'ha chiesto non scrive più qui: la variante di prima resta.
    state.productSketches = [...state.productSketches, { ...entry, state: { status: "failed", reason: "no_answer", drawn: true } }];
    emitProductPage(page.id, "blocks");
  }
}

/**
 * La variante seguente (dopo l'ultima, la prima), senza `kept`: l'etichetta
 * torna. Un disegno che il seme non ha più riparte da quello che la pagina
 * dice, variante 0.
 */
function nextVariantOf(page: ProductPage, current: Wireframe): Wireframe {
  const known = Object.hasOwn(PRODUCT_WIREFRAMES, current.wireframeId);
  const i = page.blocks.indexOf(current);
  const wireframeId = known ? current.wireframeId : pickWireframe(page.blocks, page.blocks[i - 1]?.id ?? null, page.title);
  const count = PRODUCT_WIREFRAMES[wireframeId]!.variants.length;
  const variant = known ? (current.variant + 1) % count : 0;
  return { id: current.id, type: "wireframe", wireframeId, variant };
}

/** Quante parole chiave del disegno compaiono nel testo. */
const scoreOf = (text: string, keywords: readonly string[]): number =>
  keywords.reduce((n, k) => n + text.split(k).length - 1, 0);

/** Il disegno con più parole nel testo, senza contare lo schizzo generico; `null` se nessuno ne ha. */
function bestFor(text: string): string | null {
  let best: string | null = null;
  let top = 0;
  for (const [id, w] of Object.entries(PRODUCT_WIREFRAMES)) {
    if (id === FALLBACK_WIREFRAME) continue;
    const score = scoreOf(text, w.keywords);
    if (score > top) [best, top] = [id, score];
  }
  return best;
}

/**
 * Il disegno per una bozza: le parole del blocco vicino (`nearId`) prima, poi
 * quelle di tutta la pagina col suo titolo; senza parole, lo schizzo
 * generico. Pura sullo stato: legge solo il seme.
 */
export function pickWireframe(blocks: readonly ProductBlock[], nearId: string | null, title: string): string {
  const near = nearId === null ? "" : (anchorText(blocks, nearId) ?? "");
  return (
    bestFor(near.toLowerCase()) ??
    bestFor(`${title}\n${plainTextOf(blocks)}`.toLowerCase()) ??
    FALLBACK_WIREFRAME
  );
}

/** I gesti di Claude: chi scrive i Docs, e il budget del mese (P48). */
function claudeGesturePage(me: string, pageId: string): ProductPage {
  const page = editablePage(me, pageId);
  if (manualStartBlockFor(me, page.projectId)?.reason === "monthly_budget") throw new Error("ai_blocked");
  return page;
}

/** La bozza `blockId` della pagina: `not_found` se non c'è, `invalid: wireframe` se non è una bozza. */
function sketchOf(page: ProductPage, blockId: string): Wireframe {
  const block = page.blocks.find((b) => b.id === blockId);
  if (!block) throw notFound();
  if (block.type !== "wireframe") throw invalid("wireframe");
  return block;
}

/** Un paragrafo che si può sostituire: vuoto, o col solo «/…» del menu da cui si è scelto. */
const replaceable = (block: ProductBlock | undefined): boolean =>
  block?.type === "paragraph" && (block.content.text.trim() === "" || block.content.text.startsWith("/"));

/**
 * «Disegna questa schermata» (dopo un blocco; `afterId: null` = in cima) o
 * «/» → «Bozza di schermata» (`replaceId`: al posto del paragrafo vuoto, con
 * lo stesso id; un paragrafo con del testo è `invalid: replace`). Restituisce
 * l'id della bozza.
 */
export function drawWireframeAs(
  me: string,
  pageId: string,
  at: { afterId: string | null } | { replaceId: string },
): { blockId: string } {
  const page = claudeGesturePage(me, pageId);
  if ("replaceId" in at) {
    const i = page.blocks.findIndex((b) => b.id === at.replaceId);
    if (i < 0) throw notFound();
    if (!replaceable(page.blocks[i])) throw invalid("replace");
    const near = page.blocks[i - 1]?.id ?? null;
    const block: Wireframe = { id: at.replaceId, type: "wireframe", wireframeId: pickWireframe(page.blocks, near, page.title), variant: 0 };
    writeProductBlocksAs(me, page.id, [{ op: "set", block }], { via: "claude" });
    startSketch(me, page.id, block.id, "draw");
    return { blockId: block.id };
  }
  const block: Wireframe = {
    id: newId("blk"),
    type: "wireframe",
    wireframeId: pickWireframe(page.blocks, at.afterId, page.title),
    variant: 0,
  };
  writeProductBlocksAs(me, page.id, [{ op: "insert", afterId: at.afterId, block }], { via: "claude" });
  startSketch(me, page.id, block.id, "draw");
  return { blockId: block.id };
}

export async function drawWireframe(
  pageId: string,
  at: { afterId: string | null } | { replaceId: string },
): Promise<{ blockId: string }> {
  return drawWireframeAs(await writer("productDocs.drawWireframe"), pageId, at);
}

/**
 * «Rifai»: la variante seguente (dopo l'ultima, la prima), sul posto, e
 * l'etichetta torna (`kept` assente). Un disegno che il seme non ha più
 * riparte da quello che la pagina dice, variante 0. `fromVariant` = la
 * variante che chi preme vedeva: un doppio clic avanza di una sola. Dal F6
 * la variante arriva alla fine del disegno (`finishSketch`), non al clic.
 */
export function redrawWireframeAs(
  me: string,
  pageId: string,
  blockId: string,
  fromVariant?: number,
): { blockId: string } {
  const page = claudeGesturePage(me, pageId);
  const current = sketchOf(page, blockId);
  // La variante che chi preme vedeva: se è già cambiata (il secondo clic), niente.
  if (fromVariant !== undefined && current.variant !== fromVariant) return { blockId };
  // Un disegno già in corso (il secondo clic prima della fine): niente, come il server.
  if (sketchStateOf(blockId)?.state.status === "drawing") return { blockId };
  startSketch(me, page.id, blockId, "redraw");
  return { blockId };
}

export async function redrawWireframe(
  pageId: string,
  blockId: string,
  fromVariant?: number,
): Promise<{ blockId: string }> {
  return redrawWireframeAs(await writer("productDocs.redrawWireframe"), pageId, blockId, fromVariant);
}

/**
 * «Tieni»: toglie l'etichetta «Bozza di Claude» (`kept: true`), con una
 * revisione di chi tiene. Chiede `docs.edit` (`forbidden`), non il budget
 * (non è un gesto di Claude). Già tenuta: nessuna scrittura (`revisionId:
 * null`, il doppio clic).
 */
export function keepWireframeAs(me: string, pageId: string, blockId: string): { revisionId: string | null } {
  const page = editablePage(me, pageId);
  const current = sketchOf(page, blockId);
  if (current.kept === true) return { revisionId: null };
  const { revisionId } = writeProductBlocksAs(me, page.id, [{ op: "set", block: { ...current, kept: true } }], {});
  return { revisionId };
}

export async function keepWireframe(pageId: string, blockId: string): Promise<{ revisionId: string | null }> {
  return keepWireframeAs(await writer("productDocs.keepWireframe"), pageId, blockId);
}

/**
 * «Sostituisci con un'immagine» (shape §3.5): un blocco immagine prende il
 * posto della bozza, con lo stesso id e la didascalia vuota («Add a
 * caption»). Una revisione della persona, che si annulla dalla cronologia
 * come «Tieni» (la bozza torna com'era). Chiede `docs.edit`; l'immagine
 * passa dalla validazione di sempre (`invalid: image`). Il secondo clic con
 * la stessa immagine non scrive (`revisionId: null`).
 */
export function replaceWireframeWithImageAs(
  me: string,
  pageId: string,
  blockId: string,
  image: { src: string; alt: string },
): { revisionId: string | null } {
  const page = editablePage(me, pageId);
  const now = page.blocks.find((b) => b.id === blockId);
  if (now?.type === "image" && now.src === image.src && now.alt === image.alt) return { revisionId: null };
  const current = sketchOf(page, blockId);
  const block: ProductBlock = { id: current.id, type: "image", src: image.src, caption: "", alt: image.alt };
  const { revisionId } = writeProductBlocksAs(me, page.id, [{ op: "set", block }], {});
  return { revisionId };
}

export async function replaceWireframeWithImage(
  pageId: string,
  blockId: string,
  image: { src: string; alt: string },
): Promise<{ revisionId: string | null }> {
  return replaceWireframeWithImageAs(await writer("productDocs.replaceWireframeWithImage"), pageId, blockId, image);
}
