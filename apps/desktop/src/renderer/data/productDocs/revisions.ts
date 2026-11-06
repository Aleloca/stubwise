import { blockChanges } from "../../domain/productDocs/blocks";
import { docsAccess } from "../docs/reads";
import { PEOPLE } from "../seed/people";
import { copy, gate, newId, nextSeq, now, state } from "../store";
import type {
  ProductBlock,
  ProductBlockChange,
  ProductRevision,
  ProductRevisionView,
} from "../types";
import { productPageById } from "./reads";

// Le revisioni della doc di prodotto (area 11a). Ognuna nasce con
// `nextSeq()` (`seq`), e ogni scrittura che le si unisce le dà un
// `nextSeq()` nuovo (`lastSeq`, ruling P12): «prima» e «dopo» si leggono
// da `lastSeq`, mai da `at` (l'orologio è fermo).
//
// L'unione: una scrittura di blocchi si aggiunge all'ultima revisione della
// pagina se quella ha la stessa `sessionId`, lo stesso `actorId`, nessun
// `via` e `kind: "edit"` (e la scrittura nuova è anch'essa un `edit` senza
// `via`, `source`, `groupId` né `undoOf`). Per blocco resta il primo `before` e l'ultimo `after`; un blocco
// tornato com'era esce dai cambi. Le ancore toccate si ricalcolano fra quei
// due estremi.

/** Ciò che una scrittura dice di sé, oltre ai cambi. */
export type RevisionMeta = Pick<
  ProductRevision,
  "kind" | "via" | "source" | "groupId" | "undoOf" | "sessionId" | "title" | "parent"
>;

const lastOf = (pageId: string): ProductRevision | undefined =>
  state.productRevisions
    .filter((r) => r.pageId === pageId)
    .reduce<ProductRevision | undefined>((a, r) => (!a || r.lastSeq > a.lastSeq ? r : a), undefined);

/** Il cambio di un blocco fra due estremi (`null` = non c'era / non c'è più); `null` se è com'era. */
function between(before: ProductBlock | null, after: ProductBlock | null, blockId: string) {
  const change = blockChanges(before ? [before] : [], after ? [after] : []).find(
    (c) => c.blockId === blockId,
  );
  return change ?? null;
}

/** Unisce i cambi nuovi a quelli di una revisione: primo `before`, ultimo `after`. */
function mergeChanges(
  old: readonly ProductBlockChange[],
  next: readonly ProductBlockChange[],
): ProductBlockChange[] {
  const out = old.map((c) => ({ ...c }));
  for (const change of next) {
    const i = out.findIndex((c) => c.blockId === change.blockId);
    if (i < 0) {
      out.push(change);
      continue;
    }
    const prev = out[i]!;
    const merged = between(prev.before, change.after, change.blockId);
    if (merged === null) {
      out.splice(i, 1);
      continue;
    }
    // Un'unione (`mergedFrom`) resta detta: la prima, se ce n'è più d'una.
    const mergedFrom = prev.mergedFrom ?? change.mergedFrom;
    out[i] = mergedFrom && merged.after !== null ? { ...merged, mergedFrom } : merged;
  }
  return out;
}

/**
 * Scrive la revisione di una scrittura (o la unisce all'ultima) e dice l'id
 * della revisione in cui è finita: anche quando l'unione, tornata tutta
 * com'era, la toglie (la scrittura c'è stata, e ⌘Z dell'editor la nomina
 * con `undoOf`). `null` solo per una scrittura di blocchi che non cambia
 * niente.
 */
export function recordRevision(
  me: string,
  pageId: string,
  changes: readonly ProductBlockChange[],
  meta: RevisionMeta,
): string | null {
  const fields = Object.fromEntries(
    Object.entries(meta).filter(([, v]) => v !== undefined),
  ) as RevisionMeta;
  if (fields.kind === "edit" && changes.length === 0) return null;
  const last = lastOf(pageId);
  const joins =
    fields.kind === "edit" &&
    fields.via === undefined &&
    // Una fonte, un gruppo o un annullamento sono della SINGOLA scrittura: unita, li perderebbe.
    fields.source === undefined &&
    fields.groupId === undefined &&
    fields.undoOf === undefined &&
    fields.sessionId !== undefined &&
    last !== undefined &&
    last.kind === "edit" &&
    last.via === undefined &&
    last.actorId === me &&
    last.sessionId === fields.sessionId;
  if (joins) {
    last.changes = mergeChanges(last.changes, changes);
    last.lastSeq = nextSeq();
    last.at = now();
    // Tornato tutto com'era: la revisione non dice più niente.
    if (last.changes.length === 0)
      state.productRevisions = state.productRevisions.filter((r) => r !== last);
    return last.id;
  }
  const seq = nextSeq();
  const id = newId("prev");
  state.productRevisions.push({
    id,
    pageId,
    seq,
    lastSeq: seq,
    at: now(),
    actorId: me,
    ...fields,
    changes: [...changes],
  });
  return id;
}

/** Le revisioni di una pagina, dalla più recente (`lastSeq`). */
export async function listProductRevisions(pageId: string): Promise<ProductRevisionView[]> {
  const me = await gate("productDocs.listProductRevisions");
  const page = productPageById(pageId);
  if (!page) return [];
  const access = docsAccess(me, page.projectId);
  if (access === "forbidden") throw new Error("forbidden");
  if (access === "none") return [];
  return state.productRevisions
    .filter((r) => r.pageId === pageId)
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .map((r) => ({
      ...copy(r),
      actorName: PEOPLE.find((p) => p.id === r.actorId)?.name ?? r.actorId,
    }));
}

/** La revisione ha toccato l'ancora (un blocco, una cella, o un blocco assorbito da un `merge`). */
const touches = (r: ProductRevision, anchorId: string) =>
  r.changes.some(
    (c) =>
      c.blockId === anchorId ||
      c.anchors.includes(anchorId) ||
      c.mergedFrom?.anchorId === anchorId,
  );

/**
 * L'ultima revisione (per `lastSeq`) che ha toccato l'ancora, letta in modo
 * SINCRONO dallo stato: il motore del 11b non può passare da
 * `listProductRevisions`, che è asincrona, passa dal cancello e legge come
 * chi guarda (preflight P7).
 */
export function lastRevisionTouching(pageId: string, anchorId: string): ProductRevision | null {
  const found = state.productRevisions
    .filter((r) => r.pageId === pageId && touches(r, anchorId))
    .sort((a, b) => b.lastSeq - a.lastSeq)[0];
  return found ? copy(found) : null;
}

/** La prima revisione dopo `seq` che ha toccato l'ancora (il «toccata da altri» del 11b). */
export function touchedAfter(pageId: string, anchorId: string, seq: number): ProductRevision | null {
  const found = state.productRevisions
    .filter((r) => r.pageId === pageId && r.lastSeq > seq && touches(r, anchorId))
    .sort((a, b) => a.lastSeq - b.lastSeq)[0];
  return found ? copy(found) : null;
}
