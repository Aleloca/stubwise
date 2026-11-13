import type { Db } from "./client.js";
import { backlogItemRequesters, backlogItems, backlogJobs } from "./schema.js";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CreateRequestItemInput {
  projectId: string;
  title: string;
  /** Il testo della richiesta (il design, la descrizione). */
  document: string;
  /** Chi la chiede: diventa un richiedente della voce. */
  requesterId: string;
  /** Area 7: l'esecuzione che la crea. */
  automationRunId?: string | null;
}

/**
 * Una richiesta di backlog NUOVA, come la crea una persona da `POST
 * /api/backlog/from-design`: la voce, il job di stima, il richiedente. Sta in
 * `@stubwise/db` perché la usa anche l'esecutore delle automazioni (area 7):
 * uno scrittore solo, così le due strade non divergono. Il trigger della 0169
 * pubblica `request_created` nella stessa transazione.
 */
export async function createRequestItem(db: DbOrTx, input: CreateRequestItemInput): Promise<string> {
  return (db as Db).transaction(async (tx) => {
    const [item] = await tx
      .insert(backlogItems)
      .values({
        projectId: input.projectId,
        title: input.title,
        document: input.document,
        source: "manual",
        ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}),
      })
      .returning({ id: backlogItems.id });
    await tx.insert(backlogJobs).values({ projectId: input.projectId, kind: "estimate", payload: { itemId: item!.id } });
    await tx.insert(backlogItemRequesters).values({ itemId: item!.id, userId: input.requesterId }).onConflictDoNothing();
    return item!.id;
  });
}
