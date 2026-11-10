import { backlogItemRequesters, backlogItemTickets, backlogItems, type Db } from "@stubwise/db";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildMergeDocumentPrompt, type BacklogItemContext } from "../routes/backlog-rag.js";
import { closeRefineSessionForItem } from "./backlog-refine.js";

/**
 * La fusione di due voci del backlog («Fondi in…», web vecchio e app nuova):
 * la destinazione viene riscritta dal modello (decisione del maintainer, fetta
 * 4), FUORI dalla transazione; poi tutto il resto è atomico — link alle task,
 * richiedenti (l'unione: una voce fusa ricorda tutti), conteggio, documento
 * fuso, l'assorbita archiviata con `merged_into_id` e la sua sessione di
 * refinement chiusa. Se il modello non risponde (o risponde vuoto) non si
 * scrive NIENTE.
 *
 * Fra la lettura e la scrittura passa il tempo del modello: dentro la
 * transazione le due voci si bloccano (`FOR UPDATE`, in ordine di id, così due
 * fusioni incrociate A→B e B→A non si incastrano) e si riconfrontano con la
 * fotografia presa PRIMA dell'AI. Se una delle due è cambiata — stato,
 * documento, progetto, già fusa — la fusione non si applica
 * (`MergeChangedError`, 409 `request_changed`): il documento del modello
 * nasceva da testi che non ci sono più.
 */

export class MergeAiError extends Error {
  constructor(cause?: unknown) {
    super("the AI did not produce the merged document", cause === undefined ? undefined : { cause });
    this.name = "MergeAiError";
  }
}

export class MergeChangedError extends Error {
  constructor() {
    super("one of the two requests changed while the AI was merging them");
    this.name = "MergeChangedError";
  }
}

/** Le due voci come erano prima dell'AI: ciò che la transazione riconfronta. */
export interface MergeSnapshot {
  id: string;
  projectId: string;
  title: string;
  status: string;
  document: string;
  originContent: string | null;
  mergedIntoId: string | null;
}

const snapshotColumns = {
  id: backlogItems.id,
  projectId: backlogItems.projectId,
  title: backlogItems.title,
  status: backlogItems.status,
  document: backlogItems.document,
  originContent: backlogItems.originContent,
  mergedIntoId: backlogItems.mergedIntoId,
};

/** La fotografia delle due voci, da prendere PRIMA della chiamata al modello. */
export async function readMergeSnapshot(
  db: Db,
  absorbedId: string,
  targetId: string,
): Promise<{ absorbed: MergeSnapshot; target: MergeSnapshot } | null> {
  const rows = await db.select(snapshotColumns).from(backlogItems).where(inArray(backlogItems.id, [absorbedId, targetId]));
  const absorbed = rows.find((r) => r.id === absorbedId);
  const target = rows.find((r) => r.id === targetId);
  return absorbed && target ? { absorbed, target } : null;
}

const same = (a: MergeSnapshot, b: MergeSnapshot) =>
  a.projectId === b.projectId &&
  a.status === b.status &&
  a.document === b.document &&
  a.originContent === b.originContent &&
  a.mergedIntoId === b.mergedIntoId;

/** Il documento fuso dal modello. Lancia `MergeAiError` se la chiamata fallisce o non dice niente. */
export async function mergedDocumentOf(
  chatLlm: FastifyInstance["chatLlm"],
  target: BacklogItemContext,
  absorbed: BacklogItemContext,
  projectId: string,
): Promise<string> {
  let text = "";
  try {
    for await (const delta of chatLlm.stream({
      system: buildMergeDocumentPrompt(target, absorbed),
      messages: [{ role: "user", content: "Fondi i due documenti e restituisci il Markdown del documento risultante." }],
      usage: { operation: "backlog_merge", projectId },
    })) {
      text += delta;
    }
  } catch (error) {
    throw new MergeAiError(error);
  }
  if (!text.trim()) throw new MergeAiError();
  return text;
}

/**
 * Applica la fusione già decisa, in UNA transazione, se le due voci sono
 * ancora quelle della fotografia; altrimenti lancia `MergeChangedError` e non
 * scrive niente.
 */
export async function applyBacklogMerge(
  db: Db,
  before: { absorbed: MergeSnapshot; target: MergeSnapshot },
  mergedDocument: string,
): Promise<void> {
  const absorbedId = before.absorbed.id;
  const targetId = before.target.id;
  await db.transaction(async (tx) => {
    const locked = await tx
      .select(snapshotColumns)
      .from(backlogItems)
      .where(inArray(backlogItems.id, [absorbedId, targetId]))
      .orderBy(asc(backlogItems.id))
      .for("update");
    const absorbed = locked.find((r) => r.id === absorbedId);
    const target = locked.find((r) => r.id === targetId);
    if (
      !absorbed ||
      !target ||
      !same(absorbed, before.absorbed) ||
      !same(target, before.target) ||
      absorbed.projectId !== target.projectId ||
      absorbed.status === "archived" ||
      absorbed.status === "converted" ||
      absorbed.mergedIntoId !== null ||
      target.status === "archived" ||
      target.status === "converted" ||
      target.mergedIntoId !== null
    ) {
      throw new MergeChangedError();
    }
    // Sposta i link ticket dall'assorbita al target: upsert per non violare la
    // PK se un ticket è già linkato a entrambe; role invariato.
    const links = await tx
      .select({ ticketId: backlogItemTickets.ticketId, role: backlogItemTickets.role })
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, absorbedId));
    if (links.length > 0) {
      await tx
        .insert(backlogItemTickets)
        .values(links.map((l) => ({ itemId: targetId, ticketId: l.ticketId, role: l.role })))
        .onConflictDoNothing({ target: [backlogItemTickets.itemId, backlogItemTickets.ticketId] });
      await tx.delete(backlogItemTickets).where(eq(backlogItemTickets.itemId, absorbedId));
    }
    // I richiedenti dell'assorbita passano alla destinazione, con la loro data.
    const requesters = await tx
      .select({ userId: backlogItemRequesters.userId, requestedAt: backlogItemRequesters.requestedAt })
      .from(backlogItemRequesters)
      .where(eq(backlogItemRequesters.itemId, absorbedId));
    if (requesters.length > 0) {
      await tx
        .insert(backlogItemRequesters)
        .values(requesters.map((r) => ({ itemId: targetId, userId: r.userId, requestedAt: r.requestedAt })))
        .onConflictDoNothing();
    }
    // requestCount letto con una subquery DENTRO la transazione (non il valore
    // di prima della chiamata AI: un intake concorrente può averlo cambiato).
    await tx
      .update(backlogItems)
      .set({
        requestCount: sql`${backlogItems.requestCount} + (select bi.request_count from backlog_items bi where bi.id = ${absorbedId})`,
        document: mergedDocument,
      })
      .where(eq(backlogItems.id, targetId));
    await tx
      .update(backlogItems)
      .set({ status: "archived", mergedIntoId: targetId })
      .where(eq(backlogItems.id, absorbedId));
    await closeRefineSessionForItem(tx, absorbedId);
  });
}
