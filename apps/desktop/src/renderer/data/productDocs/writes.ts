import { applyBlockOps, blockChanges } from "../../domain/productDocs/blocks";
import { safeLinkHref } from "../../domain/productDocs/richText";
import { canMoveUnder } from "../../domain/productDocs/tree";
import { docsAccess } from "../docs/reads";
import { driveFileFor } from "../drive/visibility";
import { copy, newId, now, state, visibleProjectIds } from "../store";
import type {
  InlineMark,
  ProductBlock,
  ProductBlockOp,
  ProductPage,
  ProductRevisionKind,
  ProductSourceRef,
  RichText,
} from "../types";
import { can, viewerFor } from "../viewer";
import { forbidden, invalid, notFound, writer } from "../writer";
import { emitPresenceChanged, emitProductPage } from "./events";
import { followAs } from "./follows";
import { recordProductMarks } from "./marks";
import { childrenOf, productPageById, productPageRef, productPagesOf } from "./reads";
import { recordRevision } from "./revisions";

// Le scritture dello spazio Prodotto (area 11a). Come le altre: il cancello
// (`writer()`, ruling P24: una scrittura partita prima di un ripristino non
// scrive nello stato nuovo), poi i controlli nell'ordine dei Docs —
// `not_found` per ciò che chi agisce non vede (R-G5: invisibile, inesistente
// o col modulo spento sono identici), `forbidden` senza `docs.edit`,
// `invalid: <cosa>` per l'input — e solo dopo lo stato: dopo un rifiuto lo
// stato è intatto. Le forme `…As` sono sincrone, per chi ha già passato il
// cancello (i copioni, e nel 11b Claude «per conto di»). Ogni scrittura che
// cambia una pagina lo dice ai suoi iscritti (Task 5): `blocks` per corpo,
// titolo e posto, `gone` per l'eliminazione.

/** Il progetto in cui si scrive: chi agisce ne legge i Docs e li scrive. */
function editableProject(me: string, projectId: string): void {
  const access = docsAccess(me, projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden") throw forbidden();
  if (!can(viewerFor(me), "docs.edit", projectId)) throw forbidden();
}

/** La pagina su cui si scrive (anche un commento: `comments.ts`). */
export function editablePage(me: string, pageId: string): ProductPage {
  const page = productPageById(pageId);
  if (!page) throw notFound();
  editableProject(me, page.projectId);
  return page;
}

const cleanTitle = (title: string): string => {
  const t = title.trim();
  if (!t) throw invalid("title");
  return t;
};

/** Una posizione fra i fratelli: un intero da 0; oltre la fine vale la fine. */
const checkIndex = (index: number | undefined): void => {
  if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw invalid("index");
};

/** Rimette `order` 0, 1, 2… ai fratelli, nell'ordine dato. */
const renumber = (pages: readonly ProductPage[]) => pages.forEach((p, i) => (p.order = i));

/** Mette la pagina fra i fratelli di `parentId` al posto `index` (in fondo se manca). */
function place(page: ProductPage, parentId: string | null, index: number | undefined): void {
  const siblings = childrenOf(page.projectId, parentId).filter((p) => p.id !== page.id);
  siblings.splice(Math.min(index ?? siblings.length, siblings.length), 0, page);
  page.parentId = parentId;
  renumber(siblings);
}

/** Il genitore scelto: una pagina dello stesso progetto, o la radice. */
function checkParent(projectId: string, parentId: string | null | undefined): string | null {
  if (parentId === undefined || parentId === null) return null;
  const parent = productPageById(parentId);
  if (!parent || parent.projectId !== projectId) throw notFound();
  return parent.id;
}

// --- le pagine ---------------------------------------------------------------

/**
 * Crea una pagina: codice della serie dei Docs, un paragrafo vuoto come
 * primo blocco (il suo id entra fra quelli dati), una revisione `create`, e
 * chi crea la segue. `index` è la posizione fra i fratelli (ruling P30).
 */
export function createProductPageAs(
  me: string,
  projectId: string,
  input: { title: string; parentId?: string | null; index?: number },
): ProductPage {
  editableProject(me, projectId);
  const title = cleanTitle(input.title);
  const parentId = checkParent(projectId, input.parentId);
  checkIndex(input.index);

  const project = state.projectsById.get(projectId)!;
  const n = (state.docCodeSeq.get(projectId) ?? 0) + 1;
  state.docCodeSeq.set(projectId, n);
  const first: ProductBlock = { id: newId("blk"), type: "paragraph", content: { text: "", marks: [] } };
  const at = now();
  const page: ProductPage = {
    id: newId("pdoc"),
    code: `${project.code}-D${n}`,
    projectId,
    parentId,
    order: 0,
    title,
    blocks: [first],
    createdById: me,
    createdAt: at,
    updatedById: me,
    updatedAt: at,
  };
  state.productPages.push(page);
  place(page, parentId, input.index);
  state.productBlockIds.add(first.id);
  recordRevision(me, page.id, blockChanges([], page.blocks), { kind: "create" });
  followAs(me, page.id);
  return copy(page);
}

export async function createProductPage(
  projectId: string,
  input: { title: string; parentId?: string | null; index?: number },
): Promise<ProductPage> {
  return createProductPageAs(await writer("productDocs.createProductPage"), projectId, input);
}

/** Rinomina: una revisione `rename` col titolo di prima e di dopo; lo stesso titolo non scrive nulla. */
export function renameProductPageAs(me: string, pageId: string, title: string): ProductPage {
  const page = editablePage(me, pageId);
  const after = cleanTitle(title);
  if (after === page.title) return copy(page);
  const before = page.title;
  page.title = after;
  page.updatedAt = now();
  page.updatedById = me;
  recordRevision(me, page.id, [], { kind: "rename", title: { before, after } });
  emitProductPage(page.id, "blocks");
  return copy(page);
}

export async function renameProductPage(pageId: string, title: string): Promise<ProductPage> {
  return renameProductPageAs(await writer("productDocs.renameProductPage"), pageId, title);
}

/**
 * Sposta una pagina sotto `parentId` al posto `index`. Sotto sé stessa o un
 * suo discendente: `invalid: cycle`; un genitore di un altro progetto non
 * esiste per chi sposta. Cambiare genitore scrive `move`; riordinare fra gli
 * stessi fratelli no (ruling P30: «Moved under …» detto di una pagina che
 * resta lì sarebbe falso).
 */
export async function moveProductPage(
  pageId: string,
  to: { parentId: string | null; index: number },
): Promise<ProductPage> {
  const me = await writer("productDocs.moveProductPage");
  const page = editablePage(me, pageId);
  const parentId = checkParent(page.projectId, to.parentId);
  const refs = productPagesOf(page.projectId).map(productPageRef);
  if (!canMoveUnder(refs, page.id, parentId)) throw invalid("cycle");
  checkIndex(to.index);

  const beforeId = page.parentId;
  if (beforeId !== parentId) renumber(childrenOf(page.projectId, beforeId).filter((p) => p.id !== page.id));
  place(page, parentId, to.index);
  if (beforeId !== parentId) {
    page.updatedAt = now();
    page.updatedById = me;
    recordRevision(me, page.id, [], { kind: "move", parent: { beforeId, afterId: parentId } });
  }
  emitProductPage(page.id, "blocks");
  return copy(page);
}

/**
 * Elimina una pagina senza sottopagine (`invalid: has_children`): via la
 * pagina, le sue revisioni, chi la segue, i suoi commenti e chi c'è dentro
 * (Task 5, ruling P10: gli iscritti ricevono `gone`, e un copione in corso
 * si ferma al passo dopo). Il codice non si riusa, e
 * gli id dei suoi blocchi restano dati; una citazione della pagina si legge
 * come una pagina che non c'è, e una notifica di menzione come un commento
 * che non c'è più (`objectGone`, a lettura).
 */
export async function deleteProductPage(pageId: string): Promise<void> {
  const me = await writer("productDocs.deleteProductPage");
  const page = editablePage(me, pageId);
  if (childrenOf(page.projectId, page.id).length > 0) throw invalid("has_children");
  state.productPages = state.productPages.filter((p) => p.id !== page.id);
  state.productRevisions = state.productRevisions.filter((r) => r.pageId !== page.id);
  state.productFollows = state.productFollows.filter((f) => f.pageId !== page.id);
  state.productComments = state.productComments.filter((c) => c.pageId !== page.id);
  state.productMarks = state.productMarks.filter((m) => m.pageId !== page.id);
  // I fatti di Claude che aspettavano una sezione della pagina (11b) non hanno più dove andare.
  state.productPending = state.productPending.filter((r) => r.pageId !== page.id);
  const present = state.productPresence.length;
  state.productPresence = state.productPresence.filter((p) => p.pageId !== page.id);
  renumber(childrenOf(page.projectId, page.parentId));
  emitProductPage(page.id, "gone");
  // Chi aspetta una sezione libera (`onProductPresence`, il 11b) riprova.
  if (state.productPresence.length !== present) emitPresenceChanged(page.id);
}

// --- il corpo ----------------------------------------------------------------

type AnchorsMerged = (pageId: string, from: string, to: string, offset: number) => void;
const anchorListeners = new Set<AnchorsMerged>();

/**
 * Chi tiene ancore le sposta quando un `merge` assorbe un blocco (stessa
 * scrittura, nessuna promessa): i commenti (Task 4), il segno di Claude
 * (11b). Restituisce come smettere.
 */
export function onAnchorsMerged(fn: AnchorsMerged): () => void {
  anchorListeners.add(fn);
  return () => anchorListeners.delete(fn);
}

/** Ogni id di un blocco: il blocco, e per una tabella le righe e le celle. */
const idsOf = (block: ProductBlock): string[] =>
  block.type === "table"
    ? [block.id, ...block.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)])]
    : [block.id];

/** Un segno è dentro il testo, non vuoto, e un link ha un indirizzo http(s) (`safeLinkHref`). */
const validMark = (m: InlineMark, length: number): boolean =>
  Number.isInteger(m.start) &&
  Number.isInteger(m.end) &&
  m.start >= 0 &&
  m.start < m.end &&
  m.end <= length &&
  (m.type === "bold" ||
    m.type === "italic" ||
    (m.type === "link" && typeof m.href === "string" && safeLinkHref(m.href) === m.href));

const validRich = (rt: RichText): boolean =>
  typeof rt.text === "string" &&
  Array.isArray(rt.marks) &&
  rt.marks.every((m) => validMark(m, rt.text.length));

/**
 * L'immagine di un blocco (Task 9, shape product-editor.md §9): sempre un
 * `data:` URL in base64 di PNG, JPEG, GIF o WebP (niente SVG, niente
 * indirizzi da caricare), di al più 5 MB — la misura del file, in base64.
 */
const IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_MAX_BASE64 = Math.ceil((5 * 1024 * 1024) / 3) * 4;
const validImageSrc = (src: string): boolean =>
  typeof src === "string" &&
  src.length - src.indexOf(",") - 1 <= IMAGE_MAX_BASE64 &&
  IMAGE_SRC.test(src);

/** Le frasi di un blocco: la sua, o quelle delle celle. */
const richOf = (block: ProductBlock): RichText[] =>
  block.type === "table"
    ? block.rows.flatMap((r) => r.cells.map((c) => c.content))
    : "content" in block
      ? [block.content]
      : [];

/**
 * L'unica strada del corpo: la usano la pagina, i copioni e (11b) Claude.
 * Sincrona. Gli id nuovi (di blocco, riga o cella) non devono essere mai
 * stati dati (`invalid: block_id_taken`); i segni di ogni blocco scritto
 * sono validi (`invalid: marks`), qualunque strada abbia preso la
 * scrittura. Ogni `mergedFrom` sposta le ancore registrate dentro la stessa
 * scrittura. Una scrittura che non cambia niente non scrive nulla.
 *
 * L'unica eccezione agli id già dati è ⌘Z dell'editor (ruling del
 * controller, 5 nov 2026): una scrittura con `undoOf` e `sessionId` può
 * rimettere, con lo STESSO id, un blocco (o una riga, una cella) che quella
 * sessione ha tolto da questa pagina, se a scrivere è la stessa persona. È
 * lo stesso blocco che torna, coi suoi commenti: gli id restano unici fra
 * blocchi diversi. Ogni scrittura con `sessionId` ricorda gli id che toglie
 * (`state.productSessionDeletes`).
 *
 * Restituisce la pagina e l'id della revisione in cui è finita la scrittura
 * (`recordRevision`; `null` se non c'era niente da scrivere).
 */
export function writeProductBlocksAs(
  me: string,
  pageId: string,
  ops: readonly ProductBlockOp[],
  meta: {
    sessionId?: string;
    kind?: ProductRevisionKind;
    via?: "claude";
    source?: ProductSourceRef;
    groupId?: string;
    undoOf?: string;
  },
): ProductPage & { revisionId: string | null } {
  const page = editablePage(me, pageId);
  const onPage = new Set(page.blocks.flatMap(idsOf));
  const session = meta.sessionId === undefined ? undefined : state.productSessionDeletes.get(meta.sessionId);
  const restorable = (id: string) =>
    meta.undoOf !== undefined &&
    session !== undefined &&
    session.actorId === me &&
    session.pageId === page.id &&
    session.ids.has(id);
  for (const op of ops) {
    if (op.op !== "insert" && op.op !== "set") continue;
    const fresh = idsOf(op.block).filter((id) => op.op === "insert" || !onPage.has(id));
    if (fresh.some((id) => state.productBlockIds.has(id) && !restorable(id))) throw invalid("block_id_taken");
  }
  const { blocks, changes } = applyBlockOps(page.blocks, ops);
  for (const change of changes) {
    if (change.after && !richOf(change.after).every(validRich)) throw invalid("marks");
    if (change.after?.type === "image" && !validImageSrc(change.after.src)) throw invalid("image");
    // I riferimenti si controllano qui, non nel selettore della UI (nel 11b
    // scrive anche Claude): il file c'è, chi scrive lo vede e il codice è il
    // suo; la decisione c'è e il suo progetto chi scrive lo vede. Solo i
    // blocchi cambiati: un file nascosto dopo non blocca gli altri blocchi.
    if (change.after?.type === "drive") {
      const file = driveFileFor(me, change.after.fileId);
      if (!file || file.code !== change.after.code) throw invalid("drive");
    }
    if (change.after?.type === "decision") {
      const { decisionId } = change.after;
      const decision = state.decisionLog.find((d) => d.id === decisionId);
      if (!decision || !visibleProjectIds(me).has(decision.projectId)) throw invalid("decision");
    }
  }
  if (JSON.stringify(blocks) === JSON.stringify(page.blocks)) return { ...copy(page), revisionId: null };

  page.blocks = blocks;
  page.updatedAt = now();
  page.updatedById = me;
  const kept = new Set(blocks.flatMap(idsOf));
  for (const id of kept) state.productBlockIds.add(id);
  if (meta.sessionId !== undefined) {
    const gone = [...onPage].filter((id) => !kept.has(id));
    if (gone.length > 0) {
      const memory =
        session && session.actorId === me && session.pageId === page.id
          ? session
          : { actorId: me, pageId: page.id, ids: new Set<string>() };
      for (const id of gone) memory.ids.add(id);
      state.productSessionDeletes.set(meta.sessionId, memory);
    }
  }
  const revisionId = recordRevision(me, page.id, changes, {
    kind: meta.kind ?? "edit",
    via: meta.via,
    source: meta.source,
    groupId: meta.groupId,
    undoOf: meta.undoOf,
    sessionId: meta.sessionId,
  });
  // Il segno di Claude (11b, P14): una riga per ancora che Claude ha cambiato.
  if (revisionId !== null && meta.via === "claude") recordProductMarks(revisionId);
  // La scrittura è già fatta: un ascoltatore che lancia non la fa fallire né
  // toglie la sua parte agli altri (lo si dice in console, non si tace).
  for (const change of changes)
    if (change.mergedFrom)
      for (const fn of anchorListeners) {
        try {
          fn(page.id, change.mergedFrom.anchorId, change.blockId, change.mergedFrom.offset);
        } catch (error) {
          console.error("onAnchorsMerged: a listener failed", error);
        }
      }
  emitProductPage(page.id, "blocks");
  return { ...copy(page), revisionId };
}

/**
 * La scrittura del corpo dalla pagina (l'editor). `undoOf` = ⌘Z / ⇧⌘Z
 * dell'editor: la revisione che si annulla, e il permesso di rimettere gli
 * id che questa sessione ha tolto (vedi `writeProductBlocksAs`).
 */
export async function saveProductBlocks(
  pageId: string,
  ops: ProductBlockOp[],
  opts: { sessionId: string; undoOf?: string },
): Promise<ProductPage & { revisionId: string | null }> {
  return writeProductBlocksAs(await writer("productDocs.saveProductBlocks"), pageId, ops, {
    sessionId: opts.sessionId,
    undoOf: opts.undoOf,
  });
}
