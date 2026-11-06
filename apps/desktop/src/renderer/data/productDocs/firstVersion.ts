import { buildProductTree, flattenTree } from "../../domain/productDocs/tree";
import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { canSeeDriveFile } from "../drive/visibility";
import { aiBlockFor } from "../instance/blocks";
import { canSeeMessage, canSeeTranscript } from "../mail/visibility";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { VRD_FIRST_VERSION, VRD_IDS } from "../seed/productDocs/vrdFirstVersion";
import { gate, newId, state, storeGeneration, streamDelay } from "../store";
import type {
  DriveFile,
  FirstVersionDraftPage,
  FirstVersionSource,
  FirstVersionSourceRef,
  MailMessage,
  OpenProductQuestion,
  ProductBlock,
  ProductBlockOp,
  ProductFact,
  ProductFirstVersion,
  ProductFirstVersionView,
  ProductSourceRef,
  ProductUndoView,
} from "../types";
import { can, viewerFor } from "../viewer";
import { forbidden, invalid, notFound, writer } from "../writer";
import { askProductQuestion, freshIds } from "./claude";
import { emitProductFirstVersion } from "./events";
import { productPageById, productPageRef, productPagesOf } from "./reads";
import { sourceOwnerOf, sourceViewOf } from "./sources";
import {
  createProductPageAs,
  deleteProductPageAs,
  editablePage,
  writeProductBlocksAs,
} from "./writes";

// La prima versione di Claude in uno spazio Prodotto vuoto (11b, Task 6,
// spec «Prima versione da Claude»). Le regole:
// - la chiede chi ha `docs.edit`, scegliendo fra le fonti del progetto che
//   VEDE (`firstVersionSourcesFor`): una fonte che non vede non esiste per
//   lui (`invalid: source`, come una che non c'è, R-G5). Il testo incollato
//   non resta nello stato: la fonte lo nomina senza corpo (P31);
// - è un gesto, non un lavoro della coda: col budget del mese finito non
//   parte (`ai_blocked`), la pausa della coda non la ferma (P48);
// - Claude scrive l'albero pagina per pagina, un passo ogni `streamDelay()`,
//   per conto di chi l'ha chiesta: `createProductPageAs` (chi crea segue) e
//   una `writeProductBlocksAs` con `kind: "first_version"`, `via: "claude"`
//   e il `groupId` della prima versione. Le revisioni `first_version` non
//   hanno segno (Task 3, `recordProductMarks`). Ogni dubbio è una domanda
//   sulla frase (`askProductQuestion`), senza card: è un gesto A di chi l'ha
//   chiesta, che segue già le pagine;
// - il copione si ferma senza eccezioni se la generazione dello store cambia
//   (nello stato nuovo non scrive niente), se è stata annullata, se una
//   pagina già scritta non c'è più, o se una scrittura non riesce (`docs.edit`
//   perso, Docs spenti): le pagine scritte restano, `interrupted`;
// - «Annulla la prima versione» toglie tutte le sue pagine (dalle foglie
//   alla radice, `deleteProductPageAs`), con commenti e domande, finché
//   nessuno ha toccato una pagina: una revisione dopo quella di Claude, o una
//   pagina nuova nello spazio. Dopo è spento col primo che ha toccato. I
//   codici non si riusano (`docCodeSeq` non torna indietro);
// - la bozza: quella preparata del seme per il progetto (VRD), altrimenti la
//   generica, che cita le fonti scelte per titolare e data — mai l'oggetto
//   di un'email: la pagina la legge tutto il progetto.

/** Le bozze preparate del seme, per progetto. */
const PREPARED: Record<string, FirstVersionDraftPage[]> = {
  [VRD_IDS.projectId]: VRD_FIRST_VERSION,
};

/** I copioni che hanno ancora passi da fare (`whenFirstVersionIdle`). */
const running = new Set<Promise<void>>();

/** Si risolve quando nessuna prima versione ha più pagine da scrivere (test). */
export async function whenFirstVersionIdle(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

const canEdit = (me: string, projectId: string): boolean =>
  docsAccess(me, projectId) === "read" && can(viewerFor(me), "docs.edit", projectId);

// --- le fonti -------------------------------------------------------------------

/** Le fonti fra cui chi chiede sceglie: solo ciò che vede nel progetto. */
export interface FirstVersionSources {
  emails: { id: string; fromName: string; subject: string; at: string }[];
  meetings: { id: string; title: string; at: string; transcript: boolean }[];
  files: { id: string; code: string; name: string; type: DriveFile["type"] }[];
}

const inProject = (m: MailMessage, projectId: string): boolean =>
  m.classification.state === "done" && m.classification.projectIds.includes(projectId);

/** Le riunioni del progetto che chi chiede apre: la trascrizione, la sua email di Gemini e l'evento. */
function projectMeetings(me: string, projectId: string) {
  return state.meetingTranscripts.flatMap((t) => {
    const m = state.mailMessages.find((x) => x.id === t.messageId);
    if (!m) return [];
    const event =
      t.eventId === null ? undefined : state.calendarEvents.find((e) => e.id === t.eventId);
    if (!inProject(m, projectId) && event?.projectId !== projectId) return [];
    if (!canSeeTranscript(me, t)) return [];
    return [
      {
        id: m.id,
        title: event?.title ?? t.docTitle,
        at: event?.startsAt ?? m.at,
        transcript: t.doc === "ready",
      },
    ];
  });
}

/** Le email del progetto che chi chiede apre (non quelle di Gemini: sono riunioni). */
function projectEmails(me: string, projectId: string): MailMessage[] {
  const gemini = new Set(state.meetingTranscripts.map((t) => t.messageId));
  return state.mailMessages.filter(
    (m) => !gemini.has(m.id) && inProject(m, projectId) && canSeeMessage(me, m),
  );
}

/** I file del Drive del progetto che chi chiede vede (niente nascosti né file tolti). */
const projectFiles = (me: string, projectId: string): DriveFile[] =>
  state.driveFiles.filter(
    (f) => f.projectId === projectId && f.unavailable === null && canSeeDriveFile(me, f),
  );

const byRecent = <T extends { at: string }>(a: T, b: T) => b.at.localeCompare(a.at);

/** Le fonti possibili per la prima versione; vuote per chi non legge i Docs del progetto. */
export function firstVersionSourcesFor(me: string, projectId: string): FirstVersionSources {
  if (docsAccess(me, projectId) !== "read") return { emails: [], meetings: [], files: [] };
  return {
    emails: projectEmails(me, projectId)
      .map((m) => ({ id: m.id, fromName: m.from.name, subject: m.subject, at: m.at }))
      .sort(byRecent),
    meetings: projectMeetings(me, projectId).sort(byRecent),
    files: projectFiles(me, projectId).map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      type: f.type,
    })),
  };
}

export async function listFirstVersionSources(projectId: string): Promise<FirstVersionSources> {
  return firstVersionSourcesFor(await gate("productDocs.listFirstVersionSources"), projectId);
}

/** La chiave stabile di una fonte: `email:<id>`, `meeting:<id>`, `text`, `drive:<fileId>`. */
const keyOf = (ref: FirstVersionSourceRef): string =>
  ref.kind === "text"
    ? "text"
    : ref.kind === "drive"
      ? `drive:${ref.fileId}`
      : `${ref.kind}:${ref.id}`;

/** Le fonti scelte come restano: ognuna vista da chi chiede, una volta, il testo senza corpo. */
function resolveSources(
  me: string,
  projectId: string,
  sources: readonly FirstVersionSource[],
): FirstVersionSourceRef[] {
  const out = new Map<string, FirstVersionSourceRef>();
  for (const s of sources) {
    let ref: FirstVersionSourceRef | null;
    switch (s.kind) {
      case "email":
        ref = projectEmails(me, projectId).some((m) => m.id === s.id)
          ? { kind: "email", id: s.id }
          : null;
        break;
      case "meeting":
        ref = projectMeetings(me, projectId).some((m) => m.id === s.id)
          ? { kind: "meeting", id: s.id }
          : null;
        break;
      case "drive":
        ref = projectFiles(me, projectId).some((f) => f.id === s.fileId)
          ? { kind: "drive", fileId: s.fileId }
          : null;
        break;
      case "text":
        if (typeof s.text !== "string") throw invalid("source");
        if (s.text.trim() === "") continue;
        ref = { kind: "text" };
        break;
      default:
        ref = null;
    }
    if (ref === null) throw invalid("source");
    out.set(keyOf(ref), ref);
  }
  return [...out.values()];
}

// --- la bozza generica -----------------------------------------------------------

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Come la pagina cita una fonte. La legge tutto il progetto, quindi un'email
 * o una riunione si citano per titolare e data, mai con l'oggetto (§21).
 */
function citation(ref: FirstVersionSourceRef, projectId: string): string {
  switch (ref.kind) {
    case "text":
      return "the pasted notes";
    case "drive": {
      const file = state.driveFiles.find((f) => f.id === ref.fileId)!;
      return `the file ${file.code} ${file.name}`;
    }
    case "email":
    case "meeting": {
      const owner = sourceOwnerOf(ref, projectId);
      const view = sourceViewOf(owner, ref, projectId);
      const what = ref.kind === "email" ? "an email" : "a meeting";
      const of = owner === CLAUDE_ID ? "" : ` of ${nameOf(owner)}`;
      const day = view.at ? ` (${DAY.format(new Date(view.at))})` : "";
      return `${what}${of}${day}`;
    }
  }
}

const listOf = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const para = (id: string, text: string): ProductBlock => ({
  id,
  type: "paragraph",
  content: { text, marks: [] },
});

/** La bozza di un progetto senza bozza preparata: cinque pagine, e le fonti citate. */
function genericDraft(
  projectId: string,
  refs: readonly FirstVersionSourceRef[],
): FirstVersionDraftPage[] {
  const files = refs.flatMap((r) =>
    r.kind === "drive" ? [state.driveFiles.find((f) => f.id === r.fileId)!] : [],
  );
  const page = (key: string, title: string, blocks: ProductBlock[]): FirstVersionDraftPage => ({
    key,
    parentKey: null,
    title,
    blocks,
  });
  return [
    page("overview", "Overview", [
      para(
        "g-ov-1",
        `Claude drafted this first version from ${listOf(refs.map((r) => citation(r, projectId)))}.`,
      ),
      para(
        "g-ov-2",
        "What the sources don't say clearly isn't written here: add it, or answer Claude's questions on the sentences.",
      ),
      ...files.map(
        (f, i): ProductBlock => ({ id: `g-ov-f${i}`, type: "drive", fileId: f.id, code: f.code }),
      ),
    ]),
    page("features", "Features", [
      para(
        "g-ft-1",
        "The sources don't list the features one by one yet: add one line per feature.",
      ),
    ]),
    page("screens", "Screens", [para("g-sc-1", "No screen is described in the sources yet.")]),
    page("decisions", "Client decisions", [
      para("g-cd-1", "No decision of the client is confirmed in the sources yet."),
    ]),
    page("phases", "Phases", [para("g-ph-1", "No phase or date is set in the sources yet.")]),
  ];
}

// --- l'avvio e il copione --------------------------------------------------------

const latestOf = (projectId: string): ProductFirstVersion | undefined =>
  state.productFirstVersions.filter((f) => f.projectId === projectId).at(-1);

/** La profondità di ogni pagina della bozza, dalla catena dei genitori. */
function planOf(draft: readonly FirstVersionDraftPage[]): ProductFirstVersion["plan"] {
  const depth = new Map<string, number>();
  return draft.map((p) => {
    const d = p.parentKey === null ? 0 : (depth.get(p.parentKey) ?? 0) + 1;
    depth.set(p.key, d);
    return { title: p.title, depth: d };
  });
}

/**
 * Avvia la prima versione e restituisce il suo gruppo; le pagine arrivano
 * una per passo. Rifiuti, nell'ordine: `not_found` (progetto che chi chiede
 * non vede, o Docs spenti), `forbidden` (senza `docs.edit`), `invalid:
 * source`, `no_sources`, `space_not_empty` (una pagina c'è già, o una prima
 * versione sta scrivendo), `ai_blocked` (solo il budget del mese, P48).
 * Dopo un rifiuto lo stato è intatto.
 */
export function startFirstVersionAs(
  me: string,
  projectId: string,
  sources: readonly FirstVersionSource[],
): { groupId: string } {
  const access = docsAccess(me, projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden" || !can(viewerFor(me), "docs.edit", projectId)) throw forbidden();
  const refs = resolveSources(me, projectId, sources);
  if (refs.length === 0) throw new Error("no_sources");
  if (productPagesOf(projectId).length > 0 || latestOf(projectId)?.status === "writing")
    throw new Error("space_not_empty");
  if (aiBlockFor(projectId)?.reason === "monthly_budget") throw new Error("ai_blocked");

  const keys = new Set(refs.map(keyOf));
  const draft = (PREPARED[projectId] ?? genericDraft(projectId, refs)).map((p) => ({
    ...p,
    blocks: p.blocks.filter((b) => b.onlyWith === undefined || keys.has(b.onlyWith)),
  }));
  const fv: ProductFirstVersion = {
    projectId,
    groupId: newId("pfv"),
    byId: me,
    status: "writing",
    pagesDone: 0,
    pagesTotal: draft.length,
    sources: refs,
    acceptedPageIds: [],
    plan: planOf(draft),
    written: [],
    undoneById: null,
    interrupted: false,
  };
  state.productFirstVersions.push(fv);
  emitProductFirstVersion(projectId);
  const source: ProductSourceRef = { kind: "first_version", ids: [...keys] };
  const run = play(fv, draft, source, storeGeneration()).finally(() => running.delete(run));
  running.add(run);
  return { groupId: fv.groupId };
}

export async function startFirstVersion(
  projectId: string,
  sources: readonly FirstVersionSource[],
): Promise<{ groupId: string }> {
  return startFirstVersionAs(await writer("productDocs.startFirstVersion"), projectId, sources);
}

/** L'attesa fra due pagine; con latenza 0 basta un microtask. */
function pause(): Promise<void> {
  const ms = streamDelay();
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Toglie l'id della bozza: il blocco come si scrive, con id nuovi. */
function blockOf(draftBlock: FirstVersionDraftPage["blocks"][number]): ProductBlock {
  const block = { ...draftBlock };
  delete block.onlyWith;
  return freshIds(block);
}

/** Scrive una pagina della bozza; lancia se non si può (genitore tolto, permesso perso…). */
function writePage(
  fv: ProductFirstVersion,
  draft: FirstVersionDraftPage,
  pageOfKey: Map<string, string>,
  source: ProductSourceRef,
): void {
  const parentId = draft.parentKey === null ? null : pageOfKey.get(draft.parentKey);
  if (parentId === undefined) throw invalid("parent");
  const page = createProductPageAs(fv.byId, fv.projectId, { title: draft.title, parentId });
  pageOfKey.set(draft.key, page.id);
  const created = state.productRevisions.find((r) => r.pageId === page.id && r.kind === "create")!;
  const entry = { pageId: page.id, revisionId: created.id };
  fv.written.push(entry);

  const idOf = new Map<string, string>();
  const blocks = draft.blocks.map((b) => {
    const block = blockOf(b);
    idOf.set(b.id, block.id);
    return block;
  });
  const empty = page.blocks[0]!.id;
  const ops: ProductBlockOp[] = [
    ...blocks.map(
      (block, i): ProductBlockOp => ({
        op: "insert",
        afterId: i === 0 ? empty : blocks[i - 1]!.id,
        block,
      }),
    ),
    { op: "delete", blockId: empty },
  ];
  const out = writeProductBlocksAs(fv.byId, page.id, ops, {
    kind: "first_version",
    via: "claude",
    source,
    groupId: fv.groupId,
  });
  if (out.revisionId) entry.revisionId = out.revisionId;

  for (const q of draft.questions ?? []) {
    const anchorId = idOf.get(q.anchorKey);
    if (anchorId === undefined) continue;
    const fact: ProductFact = { ...q.fact, pageId: page.id, anchorId, clarity: "vague" };
    askProductQuestion(page.id, anchorId, fact, source, "vague", { notify: false });
  }
}

/** Il copione si ferma: le pagine scritte restano, con la riga in cima. */
function interrupt(fv: ProductFirstVersion): void {
  fv.status = "done";
  fv.interrupted = true;
  emitProductFirstVersion(fv.projectId);
}

async function play(
  fv: ProductFirstVersion,
  draft: readonly FirstVersionDraftPage[],
  source: ProductSourceRef,
  at: number,
): Promise<void> {
  const pageOfKey = new Map<string, string>();
  for (const [i, page] of draft.entries()) {
    await pause();
    // Uno stato nuovo non è il suo; una prima versione annullata non scrive più.
    if (at !== storeGeneration() || fv.status !== "writing") return;
    if (fv.written.some((w) => !productPageById(w.pageId))) return interrupt(fv);
    try {
      writePage(fv, page, pageOfKey, source);
    } catch {
      return interrupt(fv);
    }
    fv.pagesDone = i + 1;
    emitProductFirstVersion(fv.projectId);
  }
  fv.status = "done";
  emitProductFirstVersion(fv.projectId);
}

// --- «Annulla» e «Accetta» ---------------------------------------------------------

/**
 * Il primo tocco dopo la prima versione: una revisione di una sua pagina
 * dopo quella di Claude (di chiunque, chi l'ha chiesta compresa), una pagina
 * nuova nello spazio, o una sua pagina che non c'è più (chi l'ha tolta non
 * si sa più: `byId: null`).
 */
function firstTouch(
  fv: ProductFirstVersion,
): { byId: string | null; pageId?: string; seq: number } | null {
  const touches: { byId: string | null; pageId?: string; seq: number }[] = [];
  const ours = new Set(fv.written.map((w) => w.pageId));
  for (const w of fv.written) {
    if (!productPageById(w.pageId)) {
      touches.push({ byId: null, seq: Number.MAX_SAFE_INTEGER });
      continue;
    }
    const base = state.productRevisions.find((r) => r.id === w.revisionId);
    const after = state.productRevisions
      .filter(
        (r) => r.pageId === w.pageId && r.id !== w.revisionId && base && r.lastSeq > base.lastSeq,
      )
      .sort((a, b) => a.lastSeq - b.lastSeq)[0];
    if (after) touches.push({ byId: after.actorId, pageId: w.pageId, seq: after.lastSeq });
  }
  for (const page of productPagesOf(fv.projectId)) {
    if (ours.has(page.id)) continue;
    const created = state.productRevisions.find((r) => r.pageId === page.id && r.kind === "create");
    touches.push({ byId: page.createdById, pageId: page.id, seq: created?.lastSeq ?? 0 });
  }
  return touches.sort((a, b) => a.seq - b.seq)[0] ?? null;
}

function undoViewOf(me: string, fv: ProductFirstVersion): ProductUndoView {
  if (!canEdit(me, fv.projectId)) return { enabled: false, reason: "no_permission", byId: null };
  const people = visiblePeopleFor(me);
  const seen = (id: string | null) =>
    id !== null && (id === CLAUDE_ID || people.has(id)) ? id : null;
  if (fv.status === "undone")
    return { enabled: false, reason: "already_undone", byId: seen(fv.undoneById) };
  const touch = firstTouch(fv);
  if (!touch) return { enabled: true };
  const page = touch.pageId ? productPageById(touch.pageId) : undefined;
  return {
    enabled: false,
    reason: "changed_after",
    byId: seen(touch.byId),
    ...(page ? { pageId: page.id, pageTitle: page.title } : {}),
  };
}

/**
 * «Annulla la prima versione»: toglie tutte le sue pagine, dalle foglie
 * alla radice, con i commenti e le domande. Spento (`refused: <ragione>`,
 * nessuna scrittura) dopo un tocco o se è già annullata; vale anche mentre
 * scrive (il copione si ferma al passo dopo).
 */
export function undoFirstVersionAs(me: string, projectId: string): void {
  const access = docsAccess(me, projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden" || !can(viewerFor(me), "docs.edit", projectId)) throw forbidden();
  const fv = latestOf(projectId);
  if (!fv) throw notFound();
  const undo = undoViewOf(me, fv);
  if (!undo.enabled) throw new Error(`refused: ${undo.reason}`);
  for (const w of [...fv.written].reverse())
    if (productPageById(w.pageId)) deleteProductPageAs(me, w.pageId);
  fv.status = "undone";
  fv.undoneById = me;
  emitProductFirstVersion(projectId);
}

export async function undoFirstVersion(projectId: string): Promise<void> {
  undoFirstVersionAs(await writer("productDocs.undoFirstVersion"), projectId);
}

/**
 * «Accetta» su una pagina: la riga in cima sparisce da quella pagina per
 * tutti. Chiede `docs.edit`; una pagina che non è di una prima versione
 * viva è `invalid: page`; un secondo clic non scrive niente.
 */
export function acceptFirstVersionPageAs(me: string, pageId: string): void {
  editablePage(me, pageId);
  const fv = state.productFirstVersions.find(
    (f) => f.status !== "undone" && f.written.some((w) => w.pageId === pageId),
  );
  if (!fv) throw invalid("page");
  if (fv.acceptedPageIds.includes(pageId)) return;
  fv.acceptedPageIds.push(pageId);
  emitProductFirstVersion(fv.projectId);
}

export async function acceptFirstVersionPage(pageId: string): Promise<void> {
  acceptFirstVersionPageAs(await writer("productDocs.acceptFirstVersionPage"), pageId);
}

// --- le letture ---------------------------------------------------------------------

/**
 * L'ultima prima versione dello spazio, come la legge chi guarda; `null`
 * senza, o per chi non legge i Docs del progetto.
 */
export function productFirstVersionOf(
  me: string,
  projectId: string,
): ProductFirstVersionView | null {
  if (docsAccess(me, projectId) !== "read") return null;
  const fv = latestOf(projectId);
  if (!fv) return null;
  const alive = fv.written.flatMap((w) => {
    const page = productPageById(w.pageId);
    return page ? [page] : [];
  });
  return {
    projectId,
    groupId: fv.groupId,
    byId: fv.byId,
    byName: nameOf(fv.byId),
    status: fv.status,
    pagesDone: fv.pagesDone,
    pagesTotal: fv.pagesTotal,
    interrupted: fv.interrupted,
    sources: fv.sources.map((s) => sourceViewOf(me, s, projectId)),
    pages: fv.plan.map((p, i) => {
      const page = fv.written[i] ? productPageById(fv.written[i]!.pageId) : undefined;
      return {
        title: p.title,
        depth: p.depth,
        pageId: page?.id ?? null,
        code: page?.code ?? null,
        state:
          i < fv.pagesDone
            ? "written"
            : fv.status === "writing" && i === fv.pagesDone
              ? "writing"
              : "waiting",
      };
    }),
    acceptedPageIds: [...fv.acceptedPageIds],
    bannerPageIds:
      fv.status === "undone"
        ? []
        : alive.filter((p) => !fv.acceptedPageIds.includes(p.id)).map((p) => p.id),
    undo: undoViewOf(me, fv),
    permissions: { edit: canEdit(me, projectId) },
  };
}

export async function getProductFirstVersion(
  projectId: string,
): Promise<ProductFirstVersionView | null> {
  const me = await gate("productDocs.getProductFirstVersion");
  if (docsAccess(me, projectId) === "forbidden") throw forbidden();
  return productFirstVersionOf(me, projectId);
}

/**
 * Le domande di Claude ancora aperte nello spazio, nell'ordine dell'albero
 * («N questions to close»). Chi non può chiuderle (senza `docs.edit`) ne
 * ha zero (P34).
 */
export function openProductQuestions(
  me: string,
  projectId: string,
): { count: number; items: OpenProductQuestion[] } {
  if (!canEdit(me, projectId)) return { count: 0, items: [] };
  const pages = flattenTree(buildProductTree(productPagesOf(projectId).map(productPageRef)));
  const items = pages.flatMap(({ page }) =>
    state.productComments
      .filter(
        (c) =>
          c.pageId === page.id && c.question && c.question.answer === null && c.resolved === null,
      )
      .sort((a, b) => a.seq - b.seq)
      .map((c) => ({
        commentId: c.id,
        pageId: page.id,
        pageCode: page.code,
        pageTitle: page.title,
        quote: c.quote,
      })),
  );
  return { count: items.length, items };
}

export async function listOpenProductQuestions(
  projectId: string,
): Promise<{ count: number; items: OpenProductQuestion[] }> {
  return openProductQuestions(await gate("productDocs.listOpenProductQuestions"), projectId);
}
