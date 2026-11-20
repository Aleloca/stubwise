import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { productSectionHolds } from "./schema.js";

/**
 * Le prese delle sezioni di una pagina di prodotto (area 11, F4): qui, nel
 * package db, perché le usano il server (le operazioni, il battito) e il
 * worker (F5: Claude aspetta chi scrive nella stessa sezione).
 */

export type TakeSectionResult = { taken: true; expiresAt: Date } | { taken: false; by: string; expiresAt: Date };

/**
 * Prende la sezione per `userId` fino a `now + ttlMs`: se è libera, scaduta o
 * già sua (e allora la rinnova). Altrimenti dice chi la tiene. UNA scrittura
 * atomica (`INSERT … ON CONFLICT DO UPDATE … WHERE`): due persone sulla stessa
 * sezione libera non la prendono tutte e due.
 */
export async function takeSection(
  db: Pick<Db, "execute" | "select" | "insert">,
  input: { pageId: string; sectionId: string; userId: string; ttlMs: number; now?: Date },
): Promise<TakeSectionResult> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const rows = await db
    .insert(productSectionHolds)
    .values({ pageId: input.pageId, sectionId: input.sectionId, userId: input.userId, expiresAt })
    .onConflictDoUpdate({
      target: [productSectionHolds.pageId, productSectionHolds.sectionId],
      set: { userId: input.userId, expiresAt },
      where: sql`${productSectionHolds.userId} = ${input.userId} or ${productSectionHolds.expiresAt} <= ${now.toISOString()}::timestamptz`,
    })
    .returning({ userId: productSectionHolds.userId });
  if (rows.length > 0) return { taken: true, expiresAt };
  const [holder] = await db
    .select({ userId: productSectionHolds.userId, expiresAt: productSectionHolds.expiresAt })
    .from(productSectionHolds)
    .where(and(eq(productSectionHolds.pageId, input.pageId), eq(productSectionHolds.sectionId, input.sectionId)));
  // Sparita fra le due letture (una cascata): riprova una volta, ora è libera.
  if (!holder) return takeSection(db, input);
  return { taken: false, by: holder.userId, expiresAt: holder.expiresAt };
}

/** Le prese VIVE di una pagina (quelle scadute non contano, anche se la riga c'è ancora). */
export async function liveSectionHolds(db: Pick<Db, "select">, pageId: string, now: Date = new Date()) {
  return db
    .select({ sectionId: productSectionHolds.sectionId, userId: productSectionHolds.userId, expiresAt: productSectionHolds.expiresAt })
    .from(productSectionHolds)
    .where(and(eq(productSectionHolds.pageId, pageId), gt(productSectionHolds.expiresAt, now)));
}

/** Lascia le prese di `userId` nella pagina (chiudendo lo stream, o con un battito senza sezione). */
export async function releaseSections(db: Pick<Db, "delete">, pageId: string, userId: string): Promise<string[]> {
  const rows = await db
    .delete(productSectionHolds)
    .where(and(eq(productSectionHolds.pageId, pageId), eq(productSectionHolds.userId, userId)))
    .returning({ sectionId: productSectionHolds.sectionId });
  return rows.map((r) => r.sectionId);
}
