import {
  docPageCodes,
  productClaudeMarks,
  productComments,
  productPageBlockIds,
  productPageFollows,
  productPageRevisions,
  productPages,
  productSectionHolds,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import {
  anchorIdsOf,
  anchorText,
  applyBlockOps,
  blockIdsOf,
  cleanQuote,
  decideFact,
  productBlockSchema,
  productBlockWriteSchema,
  productSearchText,
  recommendedOf,
  sectionKeyOf,
  validProductBlock,
  type ProductBlock,
  type ProductBlockChange,
  type ProductBlockOp,
  type ProductFact,
  type ProductFactDecision,
  type ProductQuestion,
  type RichText,
} from "@stubwise/shared";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { projectPermissionsByProject } from "./project-access.js";
import type { ProductDocQuestionEvent, ProductDocUpdatedEvent } from "./format.js";
import { publishNotification } from "./publish.js";

/**
 * Area 11, F5 — lo SCRITTORE delle modifiche di Claude alla doc di prodotto,
 * in `@stubwise/notifications` perché lo usano il worker (il lavoro dalle
 * fonti) e il server (le risposte alle domande, F5 Task 4): una regola sola.
 *
 * Il modello propone (i fatti), la regola decide (`decideFact` di shared), lo
 * scrittore RICONTROLLA, nella transazione col lock della pagina:
 * - l'ancora c'è ancora, e il testo che il fatto si aspetta (`before`) c'è
 *   ancora; una persona che l'ha toccata dopo l'arrivo del fatto lo contraddice
 *   (`contradicts_person`);
 * - il titolare della fonte ha `docs.edit` nel progetto (senza: una domanda
 *   `no_permission`); senza titolare (una decisione, un rilascio) agisce Claude;
 * - la sezione dell'ancora non è presa da una persona (F4): se lo è, NIENTE si
 *   scrive e il lavoro aspetta (`section_busy`);
 * - la pagina è del progetto della fonte (mai una pagina fuori dal progetto).
 * Poi: `edit` → UNA revisione `claude` per fonte e pagina (`via: "claude"`,
 * `on_behalf_of` il titolare), un segno per ancora; domanda → un commento di
 * Claude con la sua parte di domanda; `none` → niente.
 *
 * Le card (F5, Task 5), nella stessa transazione: `product_doc.updated` per la
 * revisione, `product_doc.question` per ogni domanda. A chi segue la pagina
 * SEMPRE (motivo obbligatorio `follower`) e a chi ha la riga accesa (il
 * catalogo: di partenza chi ha `docs.edit`); mai Claude, mai il titolare della
 * fonte (ha agito lui, per mano di Claude). Nel jsonb solo id e codici: fonte,
 * frasi, «per conto di» e la domanda li DERIVA l'inbox a lettura.
 *
 * Questo modulo non nomina NIENTE che scriva nel registro decisioni
 * (`decisions-never-ai.test.ts` lo controlla sul sorgente).
 */

export type ProductSourceKind = "email" | "meeting" | "decision" | "task" | "release";

export interface ClaudeWriteInput {
  projectId: string;
  pageId: string;
  facts: readonly ProductFact[];
  source: { kind: ProductSourceKind; id: string };
  /** Il titolare della fonte (per conto di chi Claude agisce); null = agisce Claude. */
  ownerId: string | null;
  /** Il `rev_seq` della pagina quando il lavoro l'ha letta: il «dopo» di chi l'ha toccata. */
  arrivedSeq: number;
}

export type ClaudeFactOutcome =
  | { factId: string; kind: "edit"; anchors: string[] }
  | { factId: string; kind: "question"; reason: Extract<ProductFactDecision, { kind: "question" }>["reason"]; commentId: string }
  | { factId: string; kind: "none"; why: string };

export type ClaudeWriteResult =
  | { kind: "written"; revisionId: string | null; seq: number | null; outcomes: ClaudeFactOutcome[] }
  /** La pagina non c'è più, o non è del progetto della fonte. */
  | { kind: "page_gone" }
  /** Una sezione toccata è presa da una persona: niente scritto, il lavoro aspetta. */
  | { kind: "section_busy"; sectionId: string };

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

const sameRich = (a: RichText, b: RichText) => a.text.trim() === b.text.trim();

/** Il blocco con la frase dell'ancora (il blocco, o una sua cella) sostituita. */
export function withAnchorText(block: ProductBlock, anchorId: string, text: RichText): ProductBlock | null {
  if (block.type === "table") {
    let hit = false;
    const rows = block.rows.map((r) => ({ ...r, cells: r.cells.map((c) => (c.id === anchorId ? ((hit = true), { ...c, content: text }) : c)) }));
    return hit ? { ...block, rows } : null;
  }
  if (block.id === anchorId && "content" in block) return { ...block, content: text } as ProductBlock;
  return null;
}

/** L'agente: l'utente con `is_agent` (uno solo per istanza). */
export async function agentUserId(db: Pick<Db, "select">): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
  return row?.id ?? null;
}

/**
 * I fatti di UNA fonte su UNA pagina, nella transazione col lock della pagina.
 * Un fatto che non si può applicare (ancora sparita, operazione non valida) è
 * `none` col motivo: lo scrive nel log chi chiama, mai in silenzio.
 */
export async function writeClaudeFacts(db: Db, input: ClaudeWriteInput): Promise<ClaudeWriteResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Lo stesso lock delle scritture del server (F4, review I1): NO KEY UPDATE.
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, input.pageId)).for("no key update");
    if (!page || page.projectId !== input.projectId) return { kind: "page_gone" } as const;
    const agentId = await agentUserId(tx);
    let blocks = readBlocks(page.blocks);
    const anchorIds = new Set(blocks.flatMap(anchorIdsOf));

    // Il titolare può scrivere la doc? Senza titolare agisce Claude.
    const ownerCanEdit = input.ownerId === null ? true : (await projectPermissionsByProject(tx, input.ownerId, [input.projectId])).get(input.projectId)?.has("docs.edit") === true;

    // Chi ha toccato per ultimo ogni ancora, e chi l'ha toccata dopo l'arrivo del fatto.
    const revisions = await tx
      .select({ actorId: productPageRevisions.actorId, kind: productPageRevisions.kind, lastSeq: productPageRevisions.lastSeq, changes: productPageRevisions.changes })
      .from(productPageRevisions)
      .where(eq(productPageRevisions.pageId, page.id))
      .orderBy(desc(productPageRevisions.lastSeq))
      .limit(500);
    const isPerson = (r: (typeof revisions)[number]) => r.kind !== "claude" && r.actorId !== null && r.actorId !== agentId;
    const touches = (r: (typeof revisions)[number], anchorId: string) => (r.changes as ProductBlockChange[]).some((c) => c.anchors?.includes(anchorId) || c.blockId === anchorId);

    // Le sezioni prese da una PERSONA (Claude non ne prende).
    const held = new Map(
      (
        await tx
          .select({ sectionId: productSectionHolds.sectionId, userId: productSectionHolds.userId })
          .from(productSectionHolds)
          .where(and(eq(productSectionHolds.pageId, page.id), gt(productSectionHolds.expiresAt, sql`now()`)))
      )
        .filter((h) => h.userId !== agentId)
        .map((h) => [h.sectionId, h.userId] as const),
    );

    const ops: ProductBlockOp[] = [];
    const outcomes: ClaudeFactOutcome[] = [];
    const questions: { fact: ProductFact; reason: Extract<ProductFactDecision, { kind: "question" }>["reason"]; forId: string | null; current: string }[] = [];

    for (const fact of input.facts) {
      if (fact.pageId !== page.id) continue;
      const anchorExists = fact.anchorId === null ? true : anchorIds.has(fact.anchorId);
      const current = fact.anchorId !== null ? anchorText(blocks, fact.anchorId) : null;
      const last = fact.anchorId !== null ? revisions.find((r) => touches(r, fact.anchorId!)) : undefined;
      const lastWriterIsPerson = last !== undefined && isPerson(last);
      const lastPerson = last && isPerson(last) ? last.actorId : null;
      // Il testo atteso non c'è più: chi l'ha cambiato lo contraddice (una persona → contradicts_person).
      const beforeGone = fact.before !== undefined && current !== null && !sameRich(fact.before, { text: current, marks: [] });
      const personSince = fact.anchorId !== null && revisions.some((r) => r.lastSeq > input.arrivedSeq && isPerson(r) && touches(r, fact.anchorId!));
      const decision = decideFact(beforeGone && !lastWriterIsPerson ? { ...fact, contradicts: true } : fact, {
        lastWriterIsPerson,
        actorCanEdit: ownerCanEdit,
        changedByPersonSinceArrival: personSince || (beforeGone && lastWriterIsPerson),
        anchorExists,
      });
      if (decision.kind === "none") {
        outcomes.push({ factId: fact.id, kind: "none", why: "anchor_gone" });
        continue;
      }
      if (decision.kind === "question") {
        questions.push({ fact, reason: decision.reason, forId: decision.reason === "contradicts_person" ? lastPerson : decision.reason === "no_permission" ? input.ownerId : null, current: current ?? "" });
        continue;
      }
      // Una modifica: la sezione dell'ancora non dev'essere presa da una persona.
      const sectionId = fact.anchorId === null ? "top" : sectionKeyOf(blocks, fact.anchorId);
      if (held.has(sectionId)) return { kind: "section_busy", sectionId } as const;
      const change = fact.change;
      if (change.kind === "insert_after") {
        // Id nuovi (mai quelli del modello): un id non si riusa.
        const block = { ...change.block, id: `blk-${randomUUID()}` } as ProductBlock;
        const afterId = fact.anchorId === null ? null : (blocks.find((b) => anchorIdsOf(b).includes(fact.anchorId!))?.id ?? null);
        ops.push({ op: "insert", afterId, block } as ProductBlockOp);
      } else if (change.kind === "replace" || change.kind === "link_task") {
        const holder = blocks.find((b) => anchorIdsOf(b).includes(fact.anchorId!))!;
        const text: RichText = change.kind === "replace" ? change.text : { text: `${(current ?? "").trimEnd()} ${change.taskCode}`, marks: "content" in holder ? holder.content.marks : [] };
        const next = withAnchorText(holder, fact.anchorId!, text);
        if (!next) {
          outcomes.push({ factId: fact.id, kind: "none", why: "not_text" });
          continue;
        }
        ops.push({ op: "set", block: next } as ProductBlockOp);
        // Le operazioni successive leggono il blocco cambiato.
        blocks = blocks.map((b) => (b.id === holder.id ? next : b));
      }
      outcomes.push({ factId: fact.id, kind: "edit", anchors: fact.anchorId ? [fact.anchorId] : [] });
    }

    let revisionId: string | null = null;
    let seq: number | null = null;
    if (ops.length > 0) {
      const before = readBlocks(page.blocks);
      let next: { blocks: ProductBlock[]; changes: ProductBlockChange[] };
      try {
        next = applyBlockOps(before, ops);
      } catch {
        for (const o of outcomes) if (o.kind === "edit") Object.assign(o, { kind: "none", why: "invalid_op" });
        next = { blocks: before, changes: [] };
      }
      const valid = next.blocks.every((b) => productBlockWriteSchema.safeParse(b).success && validProductBlock(b));
      if (!valid) {
        for (const o of outcomes) if (o.kind === "edit") Object.assign(o, { kind: "none", why: "invalid_block" });
      } else if (next.changes.length > 0) {
        const given = new Set((await tx.select({ id: productPageBlockIds.blockId }).from(productPageBlockIds).where(eq(productPageBlockIds.pageId, page.id))).map((r) => r.id));
        const fresh = next.blocks.flatMap(blockIdsOf).filter((id) => !given.has(id));
        if (fresh.length > 0) await tx.insert(productPageBlockIds).values(fresh.map((blockId) => ({ pageId: page.id, blockId }))).onConflictDoNothing();
        const [updated] = (await tx
          .update(productPages)
          .set({ blocks: next.blocks, searchText: productSearchText(page.title, next.blocks), revSeq: sql`${productPages.revSeq} + 1`, updatedBy: agentId, updatedAt: new Date() })
          .where(eq(productPages.id, page.id))
          .returning({ seq: productPages.revSeq })) as [{ seq: number }];
        seq = updated.seq;
        const [rev] = await tx
          .insert(productPageRevisions)
          .values({ pageId: page.id, seq, lastSeq: seq, actorId: agentId, kind: "claude", changes: next.changes as unknown[], sourceKind: input.source.kind, sourceId: input.source.id, via: "claude", onBehalfOf: input.ownerId })
          .returning({ id: productPageRevisions.id });
        revisionId = rev!.id;
        // Un segno per ancora cambiata.
        const anchors = [...new Set(next.changes.flatMap((c) => (c.after ? (c.anchors.length > 0 ? c.anchors : [c.blockId]) : [])))];
        if (anchors.length > 0) {
          await tx.insert(productClaudeMarks).values(anchors.map((anchorId) => ({ revisionId: rev!.id, pageId: page.id, anchorId, sourceKind: input.source.kind, sourceId: input.source.id })));
        }
        await tx.execute(sql`select pg_notify('product_page_events', ${JSON.stringify({ type: "revision", pageId: page.id, seq, kind: "claude", actorId: agentId, sessionId: null })})`);
      }
    }
    const card = await cardContext(tx, page.id, page.projectId, [agentId, input.ownerId]);
    if (revisionId) await card.updated(revisionId);

    // Le domande: un commento di Claude con la sua parte di domanda (il corpo resta vuoto).
    const after = ops.length > 0 && revisionId ? readBlocks((await tx.select({ blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, page.id)))[0]?.blocks) : readBlocks(page.blocks);
    for (const q of questions) {
      const anchorId = q.fact.anchorId ?? after[0]?.id ?? "top";
      const decision = { kind: "question", reason: q.reason } as const;
      const change = q.fact.change;
      const question: ProductQuestion = {
        sourceRef: input.source,
        factId: q.fact.id,
        reason: q.reason,
        forId: q.forId,
        apply: q.fact.options?.apply ?? (change.kind === "replace" ? change.text : change.kind === "insert_after" && "content" in change.block ? (change.block as { content: RichText }).content : null),
        built: change.kind === "diverges" ? change.built : null,
        request: q.fact.options?.request ?? null,
        ...(change.kind === "insert_after" && !q.fact.options?.apply ? { insert: { block: change.block, afterId: q.fact.anchorId } } : {}),
        recommended: recommendedOf(q.fact, decision),
        // Il «dopo» di «Update it»: le revisioni successive che toccano l'ancora la spengono.
        seq: seq ?? page.revSeq,
      };
      const [c] = await tx
        .insert(productComments)
        .values({ pageId: page.id, anchorId, quote: cleanQuote(q.current), body: "", authorId: agentId, question: question as unknown as Record<string, unknown> })
        .returning({ id: productComments.id });
      outcomes.push({ factId: q.fact.id, kind: "question", reason: q.reason, commentId: c!.id });
      await card.question(c!.id);
    }
    return { kind: "written", revisionId, seq, outcomes } as const;
  });
}

/**
 * Le card di una pagina: i codici di adesso (per le frasi fuori dall'app), chi
 * la segue (obbligatori `follower`), chi non la riceve mai.
 */
async function cardContext(tx: Db, pageId: string, projectId: string, never: readonly (string | null)[]) {
  const [code] = await tx
    .select({ number: docPageCodes.number, projectCode: projects.code })
    .from(docPageCodes)
    .innerJoin(projects, eq(projects.id, docPageCodes.projectId))
    .where(eq(docPageCodes.productPageId, pageId));
  const followers = (await tx.select({ userId: productPageFollows.userId }).from(productPageFollows).where(eq(productPageFollows.pageId, pageId))).map((r) => r.userId);
  const base = { pageId, pageCode: code ? `${code.projectCode}-D${code.number}` : "", projectId, projectCode: code?.projectCode ?? "" };
  const opts = {
    projectId,
    mandatory: followers.map((userId) => ({ userId, reason: "follower" as const })),
    exclude: never.filter((id): id is string => id !== null),
  };
  return {
    updated: (revisionId: string) => publishNotification(tx, { kind: "product_doc.updated", ...base, revisionId } satisfies ProductDocUpdatedEvent, opts),
    question: (questionId: string) => publishNotification(tx, { kind: "product_doc.question", ...base, questionId } satisfies ProductDocQuestionEvent, opts),
  };
}
