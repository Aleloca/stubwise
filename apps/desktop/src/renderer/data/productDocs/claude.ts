import { anchorIdsOf, anchorText, applyBlockOps, isTextBlock } from "../../domain/productDocs/blocks";
import { insertText } from "../../domain/productDocs/richText";
import { decideFact, recommendedOf } from "../../domain/productDocs/claudeRule";
import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { aiBlockFor } from "../instance/blocks";
import { heldJobs, holdJob } from "../instance/queue";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import {
  gate,
  newId,
  nextSeq,
  notifyInstanceChange,
  now,
  onStoreReset,
  state,
  storeGeneration,
} from "../store";
import type {
  AiBlock,
  AppNotification,
  ProductBlock,
  ProductBlockOp,
  ProductComment,
  ProductFact,
  ProductPage,
  ProductQuestionReason,
  ProductRevision,
  ProductSourceRef,
  RichText,
} from "../types";
import { can, viewerFor } from "../viewer";
import { notFound } from "../writer";
import { cleanQuote, threadLink } from "./comments";
import { emitProductPage, onProductPresence } from "./events";
import { productDocRecipients } from "./follows";
import { writersNear } from "./presence";
import { productPageById } from "./reads";
import { lastRevisionTouching, touchedAfter } from "./revisions";
import { sourceOwnerOf, sourceViewOf } from "./sources";
import { writeProductBlocksAs } from "./writes";

// Il motore degli aggiornamenti della doc di prodotto (11b, Task 2): i fatti
// di una fonte (email, riunione, decisione, task chiusa, rilascio) sulle
// pagine. Nessun modello: i fatti sono dati del seme, e cosa farne lo dice
// la regola pura (`decideFact`). Le regole del motore:
// - chi agisce è il titolare della fonte (`sourceOwnerOf`), con
//   `via: "claude"`; senza `docs.edit` nel progetto il fatto è una domanda;
// - le modifiche di una fonte su una pagina sono UNA scrittura, con un
//   `groupId` (l'«Annulla tutto» del Task 3), sulla sola strada del 11a
//   (`writeProductBlocksAs`); il testo che entra è quello del fatto, segni
//   compresi. Un blocco nuovo prende l'id alla scrittura (P46);
// - Claude aspetta chi scrive: un fatto chiaro in una sezione dove c'è
//   qualcuno (`writersNear`) va in `state.productPending` e si rivaluta su
//   `onProductPresence`. Se intanto una persona ha toccato l'ancora, il
//   fatto ora la contraddice e diventa una domanda (Review Focus 2). Le
//   domande partono subito;
// - col budget finito o la coda in pausa (`aiBlockFor`) la fonte aspetta in
//   `holdJob` (`product_doc_update`), un lavoro per pagina; al rilascio le
//   fonti si elaborano in ordine d'arrivo, e le card dello stesso giro si
//   raccolgono per pagina in un microtask (una card con più fonti). Una
//   pagina eliminata, i Docs spenti o la fonte sparita: il fatto non fa
//   niente, e non lancia (Review Focus 5);
// - la stessa fonte una seconda volta non scrive (`productSourcesSeen`, P46);
// - una card `product_doc.updated` per fonte e pagina, ai destinatari di
//   `productDocRecipients` (mai Claude); titolo e corpo si compongono a
//   lettura (`presentProductUpdate`). Una domanda è un commento di
//   `CLAUDE_ID` con la card `product_doc.question`;
// - Claude non scrive mai nel registro decisioni (`neverWritesDecisions.test.ts`).

/** Cosa ha fatto una fonte: id di revisioni, di commenti-domanda e di fatti in attesa. */
export interface ProductSourceOutcome {
  /** La fonte aspetta il budget o la ripresa della coda (`holdJob`). */
  held: boolean;
  edits: string[];
  questions: string[];
  pending: string[];
  /** I fatti che non fanno niente (ancora sparita, pagina eliminata, Docs spenti, fonte sparita). */
  none: number;
}

const empty = (): ProductSourceOutcome => ({
  held: false,
  edits: [],
  questions: [],
  pending: [],
  none: 0,
});

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

const sourceKey = (ref: ProductSourceRef, projectId: string): string =>
  `${ref.kind}:${ref.kind === "first_version" ? ref.ids.join(",") : ref.id}:${projectId}`;

const sameRef = (a: ProductSourceRef, b: ProductSourceRef): boolean =>
  sourceKey(a, "") === sourceKey(b, "");

/** L'indirizzo della pagina. */
const pageHref = (page: ProductPage): string =>
  `#/p/${state.projectsById.get(page.projectId)?.code ?? ""}/docs/product/${page.code}`;

const docsOn = (projectId: string): boolean =>
  state.projectsById.get(projectId)?.modules.includes("docs") ?? false;

/** Una revisione di una persona: niente `via`, e non di Claude. */
const byPerson = (r: ProductRevision | null): boolean =>
  r !== null && r.via === undefined && r.actorId !== CLAUDE_ID;

/** Una persona ha toccato l'ancora dopo `seq` (le revisioni di Claude non contano). */
function personTouchedAfter(pageId: string, anchorId: string, seq: number): boolean {
  let r = touchedAfter(pageId, anchorId, seq);
  while (r !== null) {
    if (byPerson(r)) return true;
    r = touchedAfter(pageId, anchorId, r.lastSeq);
  }
  return false;
}

/** Il titolare ha `docs.edit` nel progetto e ne legge i Docs (la porta di `writeProductBlocksAs`). */
const canEdit = (personId: string, projectId: string): boolean =>
  docsAccess(personId, projectId) === "read" && can(viewerFor(personId), "docs.edit", projectId);

/** L'ancora su cui si aspetta e si chiede: quella del fatto, o la prima della pagina. */
const anchorOf = (page: ProductPage, anchorId: string | null): string | null =>
  anchorId ?? page.blocks.flatMap(anchorIdsOf)[0] ?? null;

/** Qualcuno scrive nella sezione del fatto (`writersNear`). */
function sectionBusy(page: ProductPage, fact: ProductFact): boolean {
  const anchor = anchorOf(page, fact.anchorId);
  return anchor !== null && writersNear(page.id, anchor).length > 0;
}

// --- la domanda ----------------------------------------------------------------

/** La frase che la domanda propone: quella del fatto, parola per parola. */
function applyOf(fact: ProductFact): RichText | null {
  if (fact.options?.apply) return fact.options.apply;
  const { change } = fact;
  if (change.kind === "replace") return change.text;
  if (change.kind === "insert_after" && isTextBlock(change.block)) return change.block.content;
  return null;
}

/**
 * Chiede su un'ancora: un commento di `CLAUDE_ID` con la domanda (il testo
 * lo compone chi la mostra, dalla ragione), e la card
 * `product_doc.question` ai destinatari della pagina. Senza ancora, la
 * prima della pagina. Restituisce l'id del commento.
 */
export function askProductQuestion(
  pageId: string,
  anchorId: string | null,
  fact: ProductFact,
  ref: ProductSourceRef,
  reason: ProductQuestionReason,
): string {
  const page = productPageById(pageId);
  const anchor = page ? anchorOf(page, anchorId) : null;
  if (!page || anchor === null) throw notFound();
  const owner = sourceOwnerOf(ref, page.projectId);
  const last = lastRevisionTouching(page.id, anchor);
  const forId =
    reason === "contradicts_person"
      ? last && byPerson(last)
        ? last.actorId
        : null
      : reason === "no_permission"
        ? owner
        : null;
  const comment: ProductComment = {
    id: newId("pc"),
    pageId: page.id,
    anchorId: anchor,
    quote: cleanQuote(anchorText(page.blocks, anchor) ?? ""),
    authorId: CLAUDE_ID,
    body: "",
    createdAt: now(),
    seq: nextSeq(),
    replyToId: null,
    resolved: null,
    mentionIds: [],
    question: {
      sourceRef: ref,
      factId: fact.id,
      reason,
      forId,
      apply: applyOf(fact),
      built: fact.change.kind === "diverges" ? fact.change.built : null,
      request: fact.options?.request ?? null,
      recommended: recommendedOf(fact, { kind: "question", reason }),
      answer: null,
    },
  };
  state.productComments.push(comment);
  const recipientIds = productDocRecipients(page.id);
  if (recipientIds.length > 0)
    state.notifications.push({
      ...cardBase(page, recipientIds),
      kind: "product_doc.question",
      link: threadLink(page, comment.id),
      productQuestion: { pageId: page.id, commentId: comment.id },
    });
  emitProductPage(page.id, "comments");
  return comment.id;
}

// --- la scrittura ---------------------------------------------------------------

/** Un blocco del fatto con id nuovi (blocco, righe e celle): gli id si danno alla scrittura (P46). */
function freshIds(block: ProductBlock): ProductBlock {
  if (block.type !== "table") return { ...block, id: newId("blk") };
  return {
    ...block,
    id: newId("blk"),
    rows: block.rows.map((r) => ({
      id: newId("blk"),
      cells: r.cells.map((c) => ({ ...c, id: newId("blk") })),
    })),
  };
}

/** Il blocco con la frase dell'ancora (il blocco stesso o una sua cella) riscritta; `null` se non ha frase. */
function withAnchor(block: ProductBlock, anchorId: string, f: (rt: RichText) => RichText): ProductBlock | null {
  if (block.type === "table") {
    let hit = false;
    const rows = block.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => {
        if (c.id !== anchorId) return c;
        hit = true;
        return { ...c, content: f(c.content) };
      }),
    }));
    return hit ? { ...block, rows } : null;
  }
  return block.id === anchorId && isTextBlock(block) ? { ...block, content: f(block.content) } : null;
}

const hasCode = (text: string, code: string): boolean =>
  new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);

/** L'operazione di un fatto sui blocchi di adesso; `null` = niente da scrivere. */
function opOf(blocks: readonly ProductBlock[], fact: ProductFact): ProductBlockOp | null {
  const { change } = fact;
  const holder =
    fact.anchorId === null ? undefined : blocks.find((b) => anchorIdsOf(b).includes(fact.anchorId!));
  switch (change.kind) {
    case "replace": {
      const block = holder && withAnchor(holder, fact.anchorId!, () => change.text);
      return block ? { op: "set", block } : null;
    }
    case "insert_after":
      return { op: "insert", afterId: holder?.id ?? null, block: freshIds(change.block) };
    case "link_task": {
      const code = change.taskCode;
      const block =
        holder &&
        withAnchor(holder, fact.anchorId!, (rt) =>
          hasCode(rt.text, code) ? rt : insertText(rt, rt.text.length, rt.text ? ` ${code}` : code),
        );
      if (block) return JSON.stringify(block) === JSON.stringify(holder) ? null : { op: "set", block };
      // Un'ancora senza frase (o la cima della pagina): un paragrafo col solo codice.
      const content: RichText = { text: code, marks: [] };
      return {
        op: "insert",
        afterId: holder?.id ?? null,
        block: { id: newId("blk"), type: "paragraph", content },
      };
    }
    case "diverges":
      return null;
  }
}

/**
 * Scrive i fatti chiari di una fonte su una pagina, in UNA revisione con un
 * `groupId`. Restituisce l'id della revisione e quanti fatti non hanno
 * scritto niente; una scrittura rifiutata non fa niente (lo si dice in
 * console, non si tace).
 */
function writeFacts(
  page: ProductPage,
  owner: string,
  ref: ProductSourceRef,
  facts: readonly ProductFact[],
): { revisionId: string | null; none: number } {
  let work = page.blocks;
  const ops: ProductBlockOp[] = [];
  let none = 0;
  for (const fact of facts) {
    const op = opOf(work, fact);
    if (!op) {
      none += 1;
      continue;
    }
    ops.push(op);
    work = applyBlockOps(work, [op]).blocks;
  }
  if (ops.length === 0) return { revisionId: null, none };
  try {
    const { revisionId } = writeProductBlocksAs(owner, page.id, ops, {
      kind: "edit",
      via: "claude",
      source: ref,
      groupId: newId("pgrp"),
    });
    return revisionId === null ? { revisionId, none: facts.length } : { revisionId, none };
  } catch (error) {
    console.error("applyProductSource: a write was refused", error);
    return { revisionId: null, none: facts.length };
  }
}

// --- le card ------------------------------------------------------------------

function cardBase(page: ProductPage, recipientIds: string[]): Omit<AppNotification, "kind" | "link"> {
  return {
    id: newId("n"),
    projectId: page.projectId,
    objectCode: page.code,
    departmentId: null,
    recipientIds,
    title: "",
    body: "",
    createdAt: now(),
    read: false,
    archived: false,
    snoozedUntil: null,
  };
}

/** Una card `product_doc.updated` per la pagina; nessuna se non c'è chi riceverla. */
function publishUpdate(
  page: ProductPage,
  revisionIds: string[],
  sources: ProductSourceRef[],
  waited: AiBlock["reason"] | null,
): void {
  const recipientIds = productDocRecipients(page.id);
  if (recipientIds.length === 0) return;
  state.notifications.push({
    ...cardBase(page, recipientIds),
    kind: "product_doc.updated",
    link: pageHref(page),
    productUpdate: {
      pageId: page.id,
      revisionIds,
      sources,
      ...(waited === null ? {} : { waited }),
    },
  });
}

/** Le card dei lavori rilasciati nello stesso giro, per pagina (nell'ordine d'arrivo). */
let batch = new Map<string, { revisionIds: string[]; sources: ProductSourceRef[]; waited: AiBlock["reason"] }>();
let flushing: Promise<void> | null = null;

onStoreReset(() => batch.clear());

function collect(pageId: string, revisionId: string, ref: ProductSourceRef, waited: AiBlock["reason"]): void {
  const entry = batch.get(pageId) ?? { revisionIds: [], sources: [], waited };
  entry.revisionIds.push(revisionId);
  if (!entry.sources.some((s) => sameRef(s, ref))) entry.sources.push(ref);
  batch.set(pageId, entry);
  if (flushing) return;
  const gen = storeGeneration();
  flushing = Promise.resolve().then(() => {
    flushing = null;
    const entries = [...batch];
    batch = new Map();
    // Uno stato nuovo non è il loro: nessuna card.
    if (gen !== storeGeneration()) return;
    for (const [id, e] of entries) {
      const page = productPageById(id);
      if (page) publishUpdate(page, e.revisionIds, e.sources, e.waited);
    }
  });
}

/** Si risolve quando le card raccolte sono pubblicate (test). */
export async function whenProductClaudeIdle(): Promise<void> {
  while (flushing) await flushing;
}

// --- il motore ----------------------------------------------------------------

interface Item {
  fact: ProductFact;
  arrivedSeq: number;
  /** Un fatto che aspettava già: tiene la sua riga se aspetta ancora. */
  pendingId?: string;
}

/**
 * Decide e fa, per i fatti di UNA fonte su UNA pagina: domande subito, i
 * chiari in una sezione occupata in attesa, gli altri in una scrittura.
 * `waited`: la fonte esce dalla coda, e la card si raccoglie per pagina.
 */
function settle(
  pageId: string,
  projectId: string,
  ref: ProductSourceRef,
  items: readonly Item[],
  waited: AiBlock["reason"] | null,
  out: ProductSourceOutcome,
): void {
  const page = productPageById(pageId);
  if (
    !page ||
    page.projectId !== projectId ||
    !docsOn(projectId) ||
    sourceViewOf(CLAUDE_ID, ref, projectId).gone
  ) {
    out.none += items.length;
    return;
  }
  const owner = sourceOwnerOf(ref, projectId);
  const actorCanEdit = canEdit(owner, projectId);
  const ready: ProductFact[] = [];
  for (const { fact, arrivedSeq, pendingId } of items) {
    const anchorId = fact.anchorId;
    const decision = decideFact(fact, {
      lastWriterIsPerson: anchorId !== null && byPerson(lastRevisionTouching(page.id, anchorId)),
      actorCanEdit,
      changedByPersonSinceArrival: anchorId !== null && personTouchedAfter(page.id, anchorId, arrivedSeq),
      anchorExists: anchorId === null || anchorText(page.blocks, anchorId) !== null,
    });
    if (decision.kind === "none") {
      out.none += 1;
    } else if (decision.kind === "question") {
      out.questions.push(askProductQuestion(page.id, anchorId, fact, ref, decision.reason));
    } else if (sectionBusy(page, fact)) {
      const id = pendingId ?? newId("ppend");
      state.productPending.push({ id, pageId: page.id, projectId, ref, fact, arrivedSeq });
      out.pending.push(id);
    } else {
      ready.push(fact);
    }
  }
  if (ready.length === 0) return;
  const { revisionId, none } = writeFacts(page, owner, ref, ready);
  out.none += none;
  if (revisionId === null) return;
  out.edits.push(revisionId);
  if (waited) collect(page.id, revisionId, ref, waited);
  else publishUpdate(page, [revisionId], [ref], null);
}

/** I fatti per pagina, nell'ordine in cui le pagine compaiono. */
function byPage(facts: readonly ProductFact[]): Map<string, ProductFact[]> {
  const out = new Map<string, ProductFact[]>();
  for (const f of facts) out.set(f.pageId, [...(out.get(f.pageId) ?? []), f]);
  return out;
}

function settleSource(
  ref: ProductSourceRef,
  projectId: string,
  facts: readonly ProductFact[],
  waited: AiBlock["reason"] | null,
): ProductSourceOutcome {
  const out = empty();
  for (const [pageId, list] of byPage(facts)) {
    const arrivedSeq = nextSeq();
    settle(pageId, projectId, ref, list.map((fact) => ({ fact, arrivedSeq })), waited, out);
  }
  return out;
}

/**
 * Applica i fatti di una fonte arrivata nel progetto. Col budget finito o la
 * coda in pausa aspetta (`held`), un lavoro fermo per pagina; `manual` (un
 * gesto del riquadro di Claude, P41) non passa dalla coda, perché col budget
 * finito lo spegne prima il riquadro (`BudgetBand`), e non si ferma sulla
 * fonte già vista: chi chiede, chiede di nuovo. Aspetta comunque chi scrive.
 */
export function applyProductSource(
  ref: ProductSourceRef,
  projectId: string,
  facts: readonly ProductFact[],
  opts: { manual?: boolean } = {},
): ProductSourceOutcome {
  const key = sourceKey(ref, projectId);
  if (!opts.manual && state.productSourcesSeen.has(key)) return empty();
  state.productSourcesSeen.add(key);
  if (!docsOn(projectId)) return { ...empty(), none: facts.length };
  const block = opts.manual ? null : aiBlockFor(projectId);
  if (!block) return settleSource(ref, projectId, facts, null);
  const starterId = sourceOwnerOf(ref, projectId);
  for (const [pageId, list] of byPage(facts)) {
    // L'arrivo è ADESSO, non al rilascio: chi riscrive il blocco mentre la
    // fonte aspetta il budget viene «dopo», e il fatto diventa una domanda.
    const arrivedSeq = nextSeq();
    holdJob({
      projectId,
      kind: "product_doc_update",
      taskId: null,
      conversationId: null,
      automationRunId: null,
      starterId,
      productPageId: pageId,
      block,
      // Chi riprende la coda (`releasedBy`) la rilascia dalla pausa; `null` = è tornato il budget.
      start: async (releasedBy) => {
        settle(
          pageId,
          projectId,
          ref,
          list.map((fact) => ({ fact, arrivedSeq })),
          releasedBy === null ? "monthly_budget" : "queue_paused",
          empty(),
        );
      },
    });
  }
  notifyInstanceChange();
  return { ...empty(), held: true };
}

/** Una sezione si è liberata (forse): i fatti che aspettavano su quella pagina si rivalutano. */
function retryPending(pageId: string): void {
  const rows = state.productPending.filter((r) => r.pageId === pageId);
  if (rows.length === 0) return;
  state.productPending = state.productPending.filter((r) => r.pageId !== pageId);
  // Per fonte, nell'ordine d'arrivo: una scrittura (e una card) per fonte.
  const groups: { ref: ProductSourceRef; projectId: string; items: Item[] }[] = [];
  for (const r of rows) {
    const group = groups.find((g) => sameRef(g.ref, r.ref) && g.projectId === r.projectId);
    const item = { fact: r.fact, arrivedSeq: r.arrivedSeq, pendingId: r.id };
    if (group) group.items.push(item);
    else groups.push({ ref: r.ref, projectId: r.projectId, items: [item] });
  }
  for (const g of groups) settle(pageId, g.projectId, g.ref, g.items, null, empty());
}

// Registrato una volta, al caricamento del modulo (l'insieme non si svuota a un ripristino).
onProductPresence(retryPending);

// --- le letture -----------------------------------------------------------------

/**
 * Quante fonti aspettano il budget o la ripresa della coda nel progetto, e
 * il blocco che vale per la prima (la riga dell'attesa in cima allo spazio,
 * P11). Si contano soltanto: nessuna fonte è nominata. `null` per chi non
 * legge i Docs del progetto (R-G5) o senza attese.
 */
export async function productUpdatesWaiting(
  projectId: string,
): Promise<{ count: number; block: AiBlock } | null> {
  const me = await gate("productDocs.productUpdatesWaiting");
  if (docsAccess(me, projectId) !== "read") return null;
  const jobs = heldJobs().filter(
    (j) =>
      j.kind === "product_doc_update" &&
      j.projectId === projectId &&
      j.productPageId !== undefined &&
      productPageById(j.productPageId) !== undefined,
  );
  return jobs.length === 0 ? null : { count: jobs.length, block: jobs[0]!.block };
}

/** La card non apre più niente: nessun codice, titolo, fonte né link (R-G5). */
function gone(out: AppNotification): void {
  out.objectGone = true;
  out.objectCode = "";
  out.title = "";
  out.body = "";
  out.link = "";
  delete out.actorName;
  delete out.productPageTitle;
  delete out.productCard;
}

/**
 * Chi ha annullato tutte le revisioni della card («↺ Undone by …»): ogni
 * ancora di ognuna è tornata indietro con una revisione `undo` che la
 * nomina (`undoOf`). L'ultimo che ha annullato, se chi guarda lo vede.
 */
function undoneByOf(revisions: readonly ProductRevision[], people: Set<string>): string | null {
  if (revisions.length === 0) return null;
  let last: ProductRevision | null = null;
  for (const r of revisions) {
    const undos = state.productRevisions.filter((u) => u.kind === "undo" && u.undoOf === r.id);
    const back = new Set(undos.flatMap((u) => u.changes.flatMap((c) => c.anchors)));
    if (!r.changes.every((c) => c.anchors.every((a) => back.has(a)))) return null;
    for (const u of undos) if (!last || u.lastSeq > last.lastSeq) last = u;
  }
  return last && people.has(last.actorId) ? nameOf(last.actorId) : null;
}

/**
 * Una `product_doc.updated` come la legge `me` (dentro `listNotifications`,
 * su una copia): il codice e il titolo di adesso della pagina, le fonti
 * nella forma di chi riceve (§21), quante frasi, «per conto di» e chi ha
 * annullato. Pagina che non c'è più, o che `me` non legge, o una riga senza
 * `productUpdate`: `objectGone` e nient'altro.
 */
export function presentProductUpdate(me: string, out: AppNotification): void {
  if (out.kind !== "product_doc.updated") return;
  const ref = out.productUpdate;
  delete out.productUpdate;
  const page = ref ? productPageById(ref.pageId) : undefined;
  if (!ref || !page || docsAccess(me, page.projectId) !== "read") return gone(out);
  out.objectCode = page.code;
  out.link = pageHref(page);
  out.productPageTitle = page.title;
  const revisions = ref.revisionIds.flatMap((id) => state.productRevisions.filter((r) => r.id === id));
  const people = visiblePeopleFor(me);
  const persons = [...new Set(revisions.map((r) => r.actorId))].filter((id) => id !== CLAUDE_ID);
  const onBehalf = ref.sources.length === 1 && persons.length === 1 ? persons[0]! : null;
  out.undoneByName = undoneByOf(revisions, people);
  out.productCard = {
    sources: ref.sources.map((s) => sourceViewOf(me, s, page.projectId)),
    changes: new Set(revisions.flatMap((r) => r.changes.flatMap((c) => c.anchors))).size,
    onBehalfOfName: onBehalf && people.has(onBehalf) ? nameOf(onBehalf) : null,
    waited: ref.waited ?? null,
  };
}

/**
 * Una `product_doc.question` come la legge `me`: la pagina e il filo di
 * adesso, la ragione, la persona nominata e chi ha risposto (se li vede), la
 * fonte nella forma di chi riceve. Senza pagina, filo o lettura:
 * `objectGone`.
 */
export function presentProductQuestion(me: string, out: AppNotification): void {
  if (out.kind !== "product_doc.question") return;
  const ref = out.productQuestion;
  delete out.productQuestion;
  const page = ref ? productPageById(ref.pageId) : undefined;
  const comment = ref ? state.productComments.find((c) => c.id === ref.commentId) : undefined;
  const q = comment?.question;
  if (!page || !comment || !q || comment.pageId !== page.id || docsAccess(me, page.projectId) !== "read")
    return gone(out);
  out.objectCode = page.code;
  out.link = threadLink(page, comment.id);
  out.productPageTitle = page.title;
  const people = visiblePeopleFor(me);
  const seen = (id: string | null | undefined) => (id && people.has(id) ? nameOf(id) : null);
  out.productCard = {
    sources: [sourceViewOf(me, q.sourceRef, page.projectId)],
    changes: 0,
    onBehalfOfName: null,
    waited: null,
    question: {
      reason: q.reason,
      forName: seen(q.forId),
      taskCode:
        q.reason === "diverges" && q.sourceRef.kind === "task"
          ? (state.tasksById.get(q.sourceRef.id)?.code ?? null)
          : null,
      answer: q.answer?.option ?? null,
      answeredByName: seen(q.answer?.byId),
    },
  };
}
