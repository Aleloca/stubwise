import { anchorIdsOf, blockChanges } from "../../domain/productDocs/blocks";
import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { CLAUDE_ID } from "../seed/people";
import { gate, newId, state } from "../store";
import type {
  ProductBlock,
  ProductBlockChange,
  ProductMark,
  ProductMarkView,
  ProductPage,
  ProductRevision,
  ProductRevisionView,
  ProductUndoView,
} from "../types";
import { can, viewerFor } from "../viewer";
import { productPageById } from "./reads";
import { sourceViewOf } from "./sources";

// Il segno di Claude, «Va bene» e «Annulla» (11b, Task 3): le righe, le
// regole e le letture. I gesti stanno in `markGestures.ts` (questo modulo
// non importa `writes.ts`, che lo importa per scrivere e spostare le righe).
// Le regole:
// - il segno è una riga per ancora (`state.productMarks`) scritta quando
//   Claude cambia l'ancora (`recordProductMarks`, dentro
//   `writeProductBlocksAs`, P14): solo per le revisioni `via: "claude"` di
//   `kind: "edit"` (mai `first_version` né `answer`) e mai per una bozza di
//   schermata (P16). Un'unione la sposta sul blocco unito
//   (`moveProductMarks`, nella stessa scrittura dell'unione);
// - il segno si vede se nessuno ha detto «Va bene» e nessuno ha toccato
//   l'ancora dopo. Non «toccano» un'unione (la frase è la stessa, ora dentro
//   un altro blocco, P14) né una scrittura poi annullata col suo ⌘Z (la
//   coppia `undoOf`: il blocco cancellato e rimesso torna col suo segno).
//   Tutto in lettura: la pagina non confronta revisioni;
// - «Va bene» vale per UNA frase (maintainer, 6 nov 2026): toglie il segno di
//   quell'ancora a tutti, non quelli del gruppo, e lascia «Annulla» in
//   cronologia;
// - «Annulla» riporta l'ancora al `before` della revisione, segni compresi,
//   con una revisione `kind: "undo"` e `undoOf` = la revisione di Claude:
//   la forma che conta `undoneByOf` (card «Undone by»). È spento se una
//   scrittura ha toccato l'ancora dopo (anche un'unione), se è già annullata,
//   o senza `docs.edit`; il rifiuto lancia `refused: <ragione>`, senza
//   scrivere (doppio clic);
// - «Va bene» e «Annulla» chiedono `docs.edit` nel progetto.

/** I blocchi che non hanno mai il segno: la bozza di schermata ha la sua etichetta (P16, Task 7). */
const NO_MARK: ReadonlySet<string> = new Set(["wireframe"]);

/** Le revisioni che portano il segno e si annullano da qui. */
export const isClaudeEdit = (r: ProductRevision): boolean => r.via === "claude" && r.kind === "edit";

/**
 * Il gesto sulla bozza di schermata di una revisione (11b, Task 7): un solo
 * cambio, su un blocco `wireframe`. Claude la disegna (prima non c'era, o al
 * posto di un paragrafo) e la rifà; una persona la tiene («Tieni»: solo
 * `kept` cambia, da assente a vero). `null` per ogni altra revisione, gli
 * annullamenti compresi.
 */
export function wireframeGestureOf(r: ProductRevision): "drew" | "redrew" | "kept" | null {
  if (r.kind !== "edit" || r.changes.length !== 1) return null;
  const { before, after } = r.changes[0]!;
  if (after?.type !== "wireframe") return null;
  if (r.via === "claude") return before?.type === "wireframe" ? "redrew" : "drew";
  if (before?.type !== "wireframe" || before.kept === true || after.kept !== true) return null;
  const same = before.id === after.id && before.wireframeId === after.wireframeId && before.variant === after.variant;
  return same ? "kept" : null;
}

/**
 * Le revisioni che si annullano dalla cronologia: le modifiche di Claude e
 * «Tieni» sulla bozza di schermata (maintainer, 6 nov 2026: «si annulla
 * dalla cronologia», e «Annulla» riporta l'etichetta). Solo le prime portano
 * il segno.
 */
export const isUndoableRevision = (r: ProductRevision): boolean => isClaudeEdit(r) || wireframeGestureOf(r) === "kept";

const canEdit = (me: string, projectId: string): boolean =>
  docsAccess(me, projectId) === "read" && can(viewerFor(me), "docs.edit", projectId);

/** Le ancore che una revisione ha cambiato, nell'ordine dei cambi. */
export const anchorsOf = (r: ProductRevision): string[] => [...new Set(r.changes.flatMap((c) => c.anchors))];

/** Il cambio della revisione che contiene l'ancora. */
export const changeOf = (r: ProductRevision, anchorId: string): ProductBlockChange | undefined =>
  r.changes.find((c) => c.anchors.includes(anchorId));

// --- le righe del segno --------------------------------------------------------

/**
 * Le righe del segno di una revisione appena scritta: una per ancora
 * cambiata che c'è ancora, se la revisione è una modifica di Claude e il
 * blocco non è una bozza di schermata. La chiama `writeProductBlocksAs`.
 */
export function recordProductMarks(revisionId: string): void {
  const r = state.productRevisions.find((x) => x.id === revisionId);
  if (!r || !isClaudeEdit(r)) return;
  for (const c of r.changes) {
    if (c.after === null || NO_MARK.has(c.after.type)) continue;
    const live = new Set(anchorIdsOf(c.after));
    for (const anchorId of c.anchors) {
      if (!live.has(anchorId)) continue;
      state.productMarks.push({
        id: newId("pmark"),
        pageId: r.pageId,
        anchorId,
        revisionId: r.id,
        acceptedById: null,
        acceptedSeq: null,
      });
    }
  }
}

/**
 * Un'unione ha assorbito `from` in `to`: i segni di `from` passano a `to`
 * (P14) e ricordano l'ancora di partenza. La chiama `writeProductBlocksAs`
 * nella stessa scrittura dell'unione, accanto a `recordProductMarks`: vale
 * per ogni scrittura, qualunque modulo sia stato caricato.
 */
export function moveProductMarks(pageId: string, from: string, to: string): void {
  for (const m of state.productMarks)
    if (m.pageId === pageId && m.anchorId === from) {
      m.fromAnchorId ??= from;
      m.anchorId = to;
    }
}

// --- «toccata dopo» ----------------------------------------------------------

/** Il cambio tocca l'ancora; un'unione la tocca solo se `merges` (vedi sopra). */
const touchesAnchor = (c: ProductBlockChange, anchorId: string, merges: boolean): boolean => {
  if (c.mergedFrom) return merges && (c.blockId === anchorId || c.mergedFrom.anchorId === anchorId || c.anchors.includes(anchorId));
  return c.blockId === anchorId || c.anchors.includes(anchorId);
};

/**
 * Le revisioni dopo `r` che hanno toccato l'ancora, in ordine. Una
 * scrittura poi annullata dal suo ⌘Z (una revisione dopo `r` con `undoOf`
 * su di lei) esce, insieme al suo annullamento: il blocco è tornato com'era.
 * Gli annullamenti di `r` stesso (`kind: "undo"`) restano: contano come
 * «già annullata» per chi li cerca, e come tocco per il segno.
 */
function touchesAfter(r: ProductRevision, anchorId: string, merges: boolean): ProductRevision[] {
  const later = state.productRevisions
    .filter(
      (x) =>
        x.pageId === r.pageId &&
        x.id !== r.id &&
        x.lastSeq > r.lastSeq &&
        x.changes.some((c) => touchesAnchor(c, anchorId, merges)),
    )
    .sort((a, b) => a.lastSeq - b.lastSeq);
  const out = [...later];
  for (const u of later) {
    if (u.undoOf === undefined || u.undoOf === r.id) continue;
    const i = out.findIndex((x) => x.id === u.undoOf);
    if (i < 0 || !out.includes(u)) continue;
    out.splice(i, 1);
    out.splice(out.indexOf(u), 1);
  }
  return out;
}

/** Gli annullamenti di `r` che hanno rimesso l'ancora. */
const undosOf = (r: ProductRevision, anchorId: string): ProductRevision[] =>
  state.productRevisions
    .filter((u) => u.kind === "undo" && u.undoOf === r.id && u.changes.some((c) => c.anchors.includes(anchorId)))
    .sort((a, b) => a.lastSeq - b.lastSeq);

/** Il blocco della pagina che contiene l'ancora. */
const blockWith = (blocks: readonly ProductBlock[], anchorId: string): ProductBlock | undefined =>
  blocks.find((b) => anchorIdsOf(b).includes(anchorId));

/** L'ancora dice adesso quello che Claude ha scritto. */
function stillClaudes(page: ProductPage, change: ProductBlockChange, anchorId: string): boolean {
  const now = blockWith(page.blocks, anchorId);
  if (!now || !change.after || now.id !== change.after.id) return false;
  return blockChanges([change.after], [now]).every((c) => !c.anchors.includes(anchorId));
}

// --- «Annulla»: lo stato -----------------------------------------------------

/** L'ultima revisione dopo `r` che ha toccato l'ancora, coppie ⌘Z comprese. */
const lastTouchOf = (r: ProductRevision, anchorId: string): ProductRevision | undefined =>
  state.productRevisions
    .filter(
      (x) =>
        x.pageId === r.pageId &&
        x.lastSeq > r.lastSeq &&
        x.changes.some((c) => touchesAnchor(c, anchorId, true)),
    )
    .sort((a, b) => a.lastSeq - b.lastSeq)
    .at(-1);

/** Lo stato di «Annulla» di una sola ancora (il permesso lo guarda chi chiama). */
function oneAnchorUndo(r: ProductRevision, anchorId: string, seen: (id: string) => string | null): ProductUndoView {
  const undone = undosOf(r, anchorId);
  if (undone.length > 0) return { enabled: false, reason: "already_undone", byId: seen(undone.at(-1)!.actorId) };
  const touched = touchesAfter(r, anchorId, true);
  if (touched.length > 0) return { enabled: false, reason: "changed_after", byId: seen(touched[0]!.actorId) };
  // Una coppia ⌘Z che non ha rimesso la frase di Claude (la scrittura annullata
  // conteneva anche altro): l'ancora dice altro, e «Annulla» la cancellerebbe.
  const page = productPageById(r.pageId);
  const change = changeOf(r, anchorId);
  if (page && change && !stillClaudes(page, change, anchorId)) {
    const last = lastTouchOf(r, anchorId);
    return { enabled: false, reason: "changed_after", byId: last ? seen(last.actorId) : null };
  }
  return { enabled: true };
}

/**
 * Lo stato di «Annulla» di un'ancora di una modifica di Claude, per `me`.
 * Un blocco AGGIUNTO da Claude si annulla togliendolo tutto (il suo `before`
 * è «nessun blocco»): allora si giudicano tutte le sue ancore, e una cella
 * toccata da una persona spegne «Annulla» di ogni cella, col suo nome;
 * altrimenti l'«Annulla» di una cella cancellerebbe il testo di un'altra.
 */
export function anchorUndo(me: string, r: ProductRevision, anchorId: string, projectId: string, people: Set<string>): ProductUndoView {
  if (!canEdit(me, projectId)) return { enabled: false, reason: "no_permission", byId: null };
  // Claude si nomina sempre (il «Who?» di una sua revisione arrivata dopo).
  const seen = (id: string) => (id === CLAUDE_ID || people.has(id) ? id : null);
  const own = oneAnchorUndo(r, anchorId, seen);
  const change = changeOf(r, anchorId);
  if (!own.enabled || !change || change.before !== null) return own;
  for (const other of change.anchors) {
    if (other === anchorId) continue;
    const view = oneAnchorUndo(r, other, seen);
    if (!view.enabled && view.reason === "changed_after") return view;
  }
  return own;
}

/**
 * «Annulla tutto»: spento senza permesso; già annullata se lo sono tutte le
 * ancore; spento col primo che ha toccato un'ancora (Review Focus 4: si
 * annullano le altre una per una); acceso altrimenti (anche in parte
 * annullata: annulla il resto).
 */
export function revisionUndo(views: readonly ProductUndoView[], fallback: ProductUndoView): ProductUndoView {
  const off = views.filter((v): v is Extract<ProductUndoView, { enabled: false }> => !v.enabled);
  const permission = off.find((v) => v.reason === "no_permission");
  if (permission) return permission;
  const changed = off.find((v) => v.reason === "changed_after");
  if (changed) return changed;
  if (views.length > 0 && off.length === views.length) return fallback;
  return { enabled: true };
}

/** L'ultimo che ha annullato una parte della revisione. */
const lastUndoerOf = (r: ProductRevision): ProductRevision | undefined =>
  state.productRevisions
    .filter((u) => u.kind === "undo" && u.undoOf === r.id)
    .sort((a, b) => a.lastSeq - b.lastSeq)
    .at(-1);

/**
 * I campi del 11b di una riga di cronologia (P2, P19): «per conto di», la
 * fonte vista da chi guarda, «Annulla» / «Annulla tutto» e quanto è già
 * annullato, e il filo della domanda per una risposta.
 */
export function claudeRevisionFields(me: string, r: ProductRevision, projectId: string): Partial<ProductRevisionView> {
  const out: Partial<ProductRevisionView> = {};
  if (r.via === "claude" && r.actorId !== CLAUDE_ID) out.onBehalfOfId = r.actorId;
  if (r.source) out.sourceView = sourceViewOf(me, r.source, projectId);
  const answered = state.productComments.find(
    (c) => c.pageId === r.pageId && c.question?.answer?.revisionId === r.id,
  );
  if (answered) out.answerOf = answered.id;
  const wireframe = wireframeGestureOf(r);
  if (wireframe) out.wireframe = wireframe;
  if (!isUndoableRevision(r)) return out;

  const people = visiblePeopleFor(me);
  const anchors = anchorsOf(r);
  const byAnchor = Object.fromEntries(anchors.map((a) => [a, anchorUndo(me, r, a, projectId, people)]));
  const views = Object.values(byAnchor);
  const last = lastUndoerOf(r);
  const lastBy = last && people.has(last.actorId) ? last.actorId : null;
  out.undoByAnchor = byAnchor;
  out.undo = revisionUndo(views, { enabled: false, reason: "already_undone", byId: lastBy });
  out.undoneCount = {
    done: anchors.filter((a) => undosOf(r, a).length > 0).length,
    count: anchors.length,
  };
  if (lastBy) out.undoneById = lastBy;
  return out;
}

// --- il segno, in lettura --------------------------------------------------------

/** La posizione (1, 1 = prima riga, prima colonna) di una cella in una tabella. */
function cellOf(block: ProductBlock, anchorId: string): { row: number; col: number } | undefined {
  if (block.type !== "table") return undefined;
  for (const [i, row] of block.rows.entries()) {
    const j = row.cells.findIndex((c) => c.id === anchorId);
    if (j >= 0) return { row: i + 1, col: j + 1 };
  }
  return undefined;
}

/** La riga del segno è ancora a vista (senza «Va bene»: lo guarda chi chiama). */
function visible(page: ProductPage, m: ProductMark, r: ProductRevision): boolean {
  const changed = m.fromAnchorId ?? m.anchorId;
  const change = changeOf(r, changed);
  if (!change || !change.after || NO_MARK.has(change.after.type)) return false;
  if (!blockWith(page.blocks, m.anchorId)) return false;
  // Nato qui: l'ancora dice ancora la frase di Claude. Spostato da un'unione:
  // la frase è dentro il blocco unito, e lo dicono solo le revisioni.
  if (m.fromAnchorId === undefined && !stillClaudes(page, change, m.anchorId)) return false;
  // Spostato: nemmeno la frase di partenza dev'essere stata toccata prima
  // dell'unione. Il cambio con cui l'unione toglie il blocco assorbito non
  // conta: è l'unione stessa (la revisione che porta `mergedFrom` su di lui).
  if (m.fromAnchorId !== undefined) {
    const from = m.fromAnchorId;
    const edits = touchesAfter(r, from, false).filter(
      (x) => !x.changes.some((c) => c.mergedFrom?.anchorId === from),
    );
    if (edits.length > 0) return false;
  }
  return touchesAfter(r, m.anchorId, false).length === 0;
}

/** Le righe a vista di una pagina, una per ancora (la più recente), nell'ordine della pagina. */
export function liveMarks(page: ProductPage): { mark: ProductMark; revision: ProductRevision }[] {
  const byAnchor = new Map<string, { mark: ProductMark; revision: ProductRevision }>();
  for (const mark of state.productMarks) {
    if (mark.pageId !== page.id || mark.acceptedById !== null) continue;
    const revision = state.productRevisions.find((r) => r.id === mark.revisionId);
    if (!revision || !isClaudeEdit(revision) || !revision.source || !visible(page, mark, revision)) continue;
    const prev = byAnchor.get(mark.anchorId);
    if (!prev || revision.lastSeq > prev.revision.lastSeq) byAnchor.set(mark.anchorId, { mark, revision });
  }
  const order = page.blocks.flatMap(anchorIdsOf);
  return [...byAnchor.values()].sort((a, b) => order.indexOf(a.mark.anchorId) - order.indexOf(b.mark.anchorId));
}

/**
 * I segni di Claude in una pagina, come li legge `me` (sincrona: per chi ha
 * già passato il cancello). Chi non legge i Docs del progetto: nessuno.
 */
export function listProductMarksAs(me: string, pageId: string): ProductMarkView[] {
  const page = productPageById(pageId);
  if (!page || docsAccess(me, page.projectId) !== "read") return [];
  const canAccept = canEdit(me, page.projectId);
  const people = visiblePeopleFor(me);
  return liveMarks(page).map(({ mark, revision: r }) => {
    const block = blockWith(page.blocks, mark.anchorId)!;
    const cell = cellOf(block, mark.anchorId);
    return {
      anchorId: mark.anchorId,
      blockId: block.id,
      ...(cell ? { cell } : {}),
      revisionId: r.id,
      groupId: r.groupId ?? r.id,
      actorId: r.actorId,
      onBehalfOfId: r.actorId === CLAUDE_ID ? null : r.actorId,
      at: r.at,
      groupAnchors: anchorsOf(r).length,
      source: sourceViewOf(me, r.source!, page.projectId),
      canAccept,
      undo: anchorUndo(me, r, mark.fromAnchorId ?? mark.anchorId, page.projectId, people),
    };
  });
}

/** I segni di una pagina per chi guarda; una pagina visibile senza `docs.view`: `forbidden`. */
export async function listProductMarks(pageId: string): Promise<ProductMarkView[]> {
  const me = await gate("productDocs.listProductMarks");
  const page = productPageById(pageId);
  if (page && docsAccess(me, page.projectId) === "forbidden") throw new Error("forbidden");
  return listProductMarksAs(me, pageId);
}

