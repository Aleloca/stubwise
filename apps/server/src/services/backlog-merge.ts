import { backlogItemRequesters, backlogItemTickets, backlogItems, type Db } from "@stubwise/db";
import { eq, sql } from "drizzle-orm";
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
 */

export class MergeAiError extends Error {
  constructor(cause?: unknown) {
    super("the AI did not produce the merged document", cause === undefined ? undefined : { cause });
    this.name = "MergeAiError";
  }
}

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

/** Applica la fusione già decisa, in UNA transazione. */
export async function applyBacklogMerge(db: Db, absorbedId: string, targetId: string, mergedDocument: string): Promise<void> {
  await db.transaction(async (tx) => {
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
