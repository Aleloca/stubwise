import { backlogItems, type Db } from "@stubwise/db";
import { and, eq, inArray } from "drizzle-orm";
import { closeRefineSessionForItem } from "./backlog-refine.js";

/**
 * Archiviare e riaprire una richiesta (integrazione area 2, fetta 4), estratti
 * da `routes/project-requests.ts` perché li usa anche l'esecutore delle azioni
 * di Claude (chat, fetta 3). Il permesso (`backlog.edit`) e la visibilità li
 * controlla il chiamante, come la rotta.
 */

const OPEN = ["new", "refining", "ready"] as const;

/** Archivia una richiesta aperta; la sua sessione di refinement si chiude. `false`: non era aperta. */
export async function archiveRequest(db: Db, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(backlogItems)
      .set({ status: "archived" })
      .where(and(eq(backlogItems.id, id), inArray(backlogItems.status, [...OPEN])))
      .returning({ id: backlogItems.id });
    if (row) await closeRefineSessionForItem(tx, id);
    return row !== undefined;
  });
}

/** Riapre un'archiviata (anche fusa): torna «nuova», e non è più fusa in niente. `null`: non era archiviata. */
export async function reopenRequest(db: Db, id: string): Promise<{ id: string } | null> {
  const [row] = await db
    .update(backlogItems)
    .set({ status: "new", mergedIntoId: null })
    .where(and(eq(backlogItems.id, id), eq(backlogItems.status, "archived")))
    .returning({ id: backlogItems.id });
  return row ?? null;
}
