import { anchorText, blockChanges, isTextBlock } from "../../../domain/productDocs/blocks";
import type {
  AppNotification,
  ProductBlock,
  ProductComment,
  ProductFact,
  ProductMark,
  ProductPage,
  ProductQuestion,
  ProductRevision,
  ProductSourceRef,
} from "../../types";
import { daysFromToday } from "../dates";
import { CLAUDE_ID } from "../people";
import {
  PRODUCT_COMMENTS,
  PRODUCT_FOLLOWS,
  PRODUCT_PAGES as PAGES_11A,
  PRODUCT_REVISIONS,
} from "./acq";
import {
  ACQ_11B,
  BILLS_MEETING_FACT,
  DECISIONS_FACT,
  FAULTS_FACT,
  METER_CLOSED_TASK_FACT,
  SIGN_IN_FACT,
} from "./facts";

// Il seme del 11b per ACQ: Claude ha già lavorato nella doc di prodotto, e
// qui c'è com'è andata, scritto come stato già accaduto (revisioni, segni,
// commenti-domanda e card), nella forma che scrivono il motore
// (`applyProductSource`) e «Va bene» (Task 2–4). Le fonti sono quelle di
// `facts.ts`, e risultano già viste: un secondo arrivo non riscrive niente.
// - Sign-in: una modifica di Claude dall'email di Laura «solo Google»,
//   segnata, con la card a chi segue la pagina (Laura e Marco; Sara no);
// - Bills: una domanda nata da una riunione (un «forse»), aperta: è in
//   «Decidi» di Laura;
// - Meter reading: una divergenza da una task chiusa (ACQ-8), aperta;
// - Client decisions: una modifica da una decisione del registro (dl-acq-3),
//   già accettata da Laura («Va bene»);
// - Fault reports: un segno la cui email non c'è più («Fonte non più
//   disponibile»).
// Le due richieste nate da Phases e la task nata da una di esse stanno nei
// semi delle richieste e delle task. Le revisioni del 11a restano come sono
// (nessuna ha `via` né `source`): queste vengono dopo, con `seq` che
// partono dopo quelli del 11a e crescono con la data.

const LAURA = "p-laura";
const ACQ = "prj-acq";

const at = (days: number, time: string) => `${daysFromToday(-days)}T${time}:00Z`;

/** Il primo `seq` del 11b: dopo ogni revisione e ogni commento del 11a (P4). */
const FIRST_SEQ =
  Math.max(...PRODUCT_REVISIONS.map((r) => r.lastSeq), ...PRODUCT_COMMENTS.map((c) => c.seq)) + 1;

/** Gli id dei blocchi che Claude ha aggiunto nel seme (gli altri id li dà la scrittura). */
export const ACQ_11B_BLOCKS = {
  signInGoogleOnly: "blk-acq-signin-5",
  decisionsPhotos: "blk-acq-decisions-4",
} as const;

// --- le scritture di Claude ------------------------------------------------------

interface ClaudeEdit {
  id: string;
  pageId: string;
  at: string;
  actorId: string;
  source: ProductSourceRef;
  fact: ProductFact;
  /** Per un `insert_after`: l'id che il blocco ha preso alla scrittura. */
  newBlockId?: string;
}

const EDITS: ClaudeEdit[] = [
  {
    id: "prev-acq11b-signin",
    pageId: SIGN_IN_FACT.pageId,
    at: at(6, "10:20"),
    // Il titolare dell'email: Laura, la prima delle caselle che è membro di ACQ.
    actorId: LAURA,
    source: { kind: "email", id: ACQ_11B.signInEmailId },
    fact: SIGN_IN_FACT,
    newBlockId: ACQ_11B_BLOCKS.signInGoogleOnly,
  },
  {
    id: "prev-acq11b-decisions",
    pageId: DECISIONS_FACT.pageId,
    at: at(4, "15:05"),
    actorId: CLAUDE_ID,
    source: { kind: "decision", id: ACQ_11B.decisionId },
    fact: DECISIONS_FACT,
    newBlockId: ACQ_11B_BLOCKS.decisionsPhotos,
  },
  {
    id: "prev-acq11b-faults",
    pageId: FAULTS_FACT.pageId,
    at: at(2, "11:30"),
    // Era di Laura quando è arrivata; l'email poi è stata tolta.
    actorId: LAURA,
    source: { kind: "email", id: ACQ_11B.goneEmailId },
    fact: FAULTS_FACT,
  },
];

/** Il blocco come l'ha scritto il fatto, sulla pagina del 11a. */
function written(
  blocks: ProductBlock[],
  edit: ClaudeEdit,
): { before: ProductBlock[]; after: ProductBlock[] } {
  const { change, anchorId } = edit.fact;
  const i = blocks.findIndex((b) => b.id === anchorId);
  if (i === -1) throw new Error(`acq11b: anchor ${anchorId} not found`);
  if (change.kind === "replace") {
    const old = blocks[i]!;
    if (!isTextBlock(old)) throw new Error(`acq11b: ${anchorId} has no text`);
    const next = { ...old, content: change.text } as ProductBlock;
    blocks.splice(i, 1, next);
    return { before: [old], after: [next] };
  }
  if (change.kind === "insert_after") {
    const next = { ...change.block, id: edit.newBlockId! } as ProductBlock;
    blocks.splice(i + 1, 0, next);
    return { before: [], after: [next] };
  }
  throw new Error(`acq11b: ${change.kind} is not written`);
}

interface Built {
  pages: ProductPage[];
  revisions: ProductRevision[];
}

function build(): Built {
  const pages = PAGES_11A.map((p) => ({ ...p, blocks: [...p.blocks] }));
  const revisions = EDITS.map((edit): ProductRevision => {
    const page = pages.find((p) => p.id === edit.pageId)!;
    const { before, after } = written(page.blocks, edit);
    page.updatedAt = edit.at;
    page.updatedById = edit.actorId;
    return {
      id: edit.id,
      pageId: edit.pageId,
      seq: 0,
      lastSeq: 0,
      at: edit.at,
      actorId: edit.actorId,
      via: "claude",
      source: edit.source,
      groupId: `pgrp-${edit.id.slice("prev-".length)}`,
      kind: "edit",
      changes: blockChanges(before, after),
    };
  });
  return { pages, revisions };
}

const BUILT = build();

/** Le pagine di ACQ con le scritture di Claude del 11b. */
export const PRODUCT_PAGES_11B: ProductPage[] = BUILT.pages;

const pageById = (id: string) => PRODUCT_PAGES_11B.find((p) => p.id === id)!;

// --- le domande ------------------------------------------------------------------

interface Asked {
  id: string;
  at: string;
  source: ProductSourceRef;
  fact: ProductFact;
  question: Omit<ProductQuestion, "sourceRef" | "factId" | "answer">;
}

const textOf = (fact: ProductFact) => {
  const { change } = fact;
  if (fact.options?.apply) return fact.options.apply;
  if (change.kind === "insert_after" && isTextBlock(change.block)) return change.block.content;
  return null;
};

const ASKED: Asked[] = [
  {
    id: "pc-acq11b-bills-q",
    at: at(3, "15:15"),
    source: { kind: "meeting", id: ACQ_11B.meetingId },
    fact: BILLS_MEETING_FACT,
    question: {
      reason: "vague",
      forId: null,
      apply: textOf(BILLS_MEETING_FACT),
      built: null,
      request: BILLS_MEETING_FACT.options!.request!,
      insert: {
        block: (BILLS_MEETING_FACT.change as { block: ProductBlock }).block,
        afterId: BILLS_MEETING_FACT.anchorId,
      },
      recommended: "keep",
    },
  },
  {
    id: "pc-acq11b-meter-q",
    at: at(2, "11:05"),
    source: { kind: "task", id: ACQ_11B.closedTaskId },
    fact: METER_CLOSED_TASK_FACT,
    question: {
      reason: "diverges",
      forId: null,
      apply: textOf(METER_CLOSED_TASK_FACT),
      built: (METER_CLOSED_TASK_FACT.change as { built: string }).built,
      request: null,
      recommended: "apply",
    },
  },
];

const quoteOf = (pageId: string, anchorId: string): string =>
  (anchorText(pageById(pageId).blocks, anchorId) ?? "").trim();

// --- i `seq`, in ordine di tempo ---------------------------------------------------

/** «Va bene» di Laura sulla decisione portata in Client decisions. */
const ACCEPTED_AT = at(3, "09:00");

const timeline = [
  ...EDITS.map((e) => ({ key: e.id, at: e.at })),
  ...ASKED.map((q) => ({ key: q.id, at: q.at })),
  { key: "accept", at: ACCEPTED_AT },
].sort((a, b) => a.at.localeCompare(b.at));

const seqOf = (key: string): number => FIRST_SEQ + timeline.findIndex((t) => t.key === key);

/** Le revisioni di Claude del 11b (via `"claude"`, con la fonte e il gruppo). */
export const PRODUCT_REVISIONS_11B: ProductRevision[] = BUILT.revisions.map((r) => ({
  ...r,
  seq: seqOf(r.id),
  lastSeq: seqOf(r.id),
}));

/** Le righe del segno: una per ancora cambiata; quella di Client decisions ha il «Va bene» di Laura. */
export const PRODUCT_MARKS_11B: ProductMark[] = PRODUCT_REVISIONS_11B.flatMap((r) =>
  r.changes.flatMap((c) =>
    c.anchors.map(
      (anchorId): ProductMark => ({
        id: `pmark-acq11b-${anchorId}`,
        pageId: r.pageId,
        anchorId,
        revisionId: r.id,
        acceptedById: r.id === "prev-acq11b-decisions" ? LAURA : null,
        acceptedSeq: r.id === "prev-acq11b-decisions" ? seqOf("accept") : null,
      }),
    ),
  ),
);

/** Le due domande aperte di Claude: radici di `CLAUDE_ID`, corpo vuoto (il testo si compone a lettura). */
export const PRODUCT_COMMENTS_11B: ProductComment[] = ASKED.map((q) => ({
  id: q.id,
  pageId: q.fact.pageId,
  anchorId: q.fact.anchorId!,
  quote: quoteOf(q.fact.pageId, q.fact.anchorId!),
  authorId: CLAUDE_ID,
  body: "",
  createdAt: q.at,
  seq: seqOf(q.id),
  replyToId: null,
  resolved: null,
  mentionIds: [],
  question: { sourceRef: q.source, factId: q.fact.id, ...q.question, answer: null },
}));

// --- le card -----------------------------------------------------------------------

/**
 * Chi riceve gli avvisi della pagina, come `productDocRecipients`: chi la
 * segue nel seme (Laura tutte, Marco anche Sign-in), mai Claude. Ogni pagina
 * del seme ha chi la segue, quindi il ripiego su chi ha `docs.edit` non serve
 * (e qui, senza lo stato degli accessi, non si potrebbe calcolare): se una
 * pagina restasse senza, il seme lo dice invece di inventare.
 */
function recipientsOf(pageId: string): string[] {
  const ids = PRODUCT_FOLLOWS.filter((f) => f.pageId === pageId && f.personId !== CLAUDE_ID).map(
    (f) => f.personId,
  );
  if (ids.length === 0) throw new Error(`acq11b: nobody follows ${pageId}`);
  return ids;
}

const pageLink = (pageId: string) => `#/p/ACQ/docs/product/${pageById(pageId).code}`;

function card(
  id: string,
  pageId: string,
  createdAt: string,
  read: boolean,
): Omit<AppNotification, "kind" | "link"> {
  return {
    id,
    projectId: ACQ,
    objectCode: pageById(pageId).code,
    departmentId: null,
    recipientIds: recipientsOf(pageId),
    // Vuoti: la card compone titolo e corpo a lettura (`presentProductUpdate`/`Question`).
    title: "",
    body: "",
    createdAt,
    read,
    archived: false,
    snoozedUntil: null,
  };
}

/**
 * Le card del 11b: un `product_doc.updated` per ogni modifica di Claude
 * (quelle di Client decisions e Fault reports già lette) e un
 * `product_doc.question` per ogni domanda aperta.
 */
export const PRODUCT_NOTIFICATIONS_11B: AppNotification[] = [
  ...PRODUCT_REVISIONS_11B.map(
    (r): AppNotification => ({
      ...card(`n-${r.id.slice("prev-".length)}`, r.pageId, r.at, r.id !== "prev-acq11b-signin"),
      kind: "product_doc.updated",
      link: pageLink(r.pageId),
      productUpdate: { pageId: r.pageId, revisionIds: [r.id], sources: [r.source!] },
    }),
  ),
  ...PRODUCT_COMMENTS_11B.map(
    (c): AppNotification => ({
      ...card(`n-${c.id.slice("pc-".length)}`, c.pageId, c.createdAt, false),
      kind: "product_doc.question",
      link: `${pageLink(c.pageId)}?comment=${c.id}`,
      productQuestion: { pageId: c.pageId, commentId: c.id },
    }),
  ),
];

/** Le fonti già passate dal motore (chiave `<kind>:<id>:<progetto>`, come `productSourcesSeen`). */
export const PRODUCT_SOURCES_SEEN_11B: string[] = [
  ...EDITS.map((e) => e.source),
  ...ASKED.map((q) => q.source),
].map((ref) => `${ref.kind}:${ref.kind === "first_version" ? ref.ids.join(",") : ref.id}:${ACQ}`);
