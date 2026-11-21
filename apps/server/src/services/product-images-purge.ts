import { productPageImages, productPages, type Db } from "@stubwise/db";
import { PRODUCT_IMAGE_REF_PREFIX } from "@stubwise/shared";
import { and, eq, lt, sql } from "drizzle-orm";
import type { ObjectStorage } from "../storage/index.js";
import { removeOrRecordOrphan } from "../storage/orphans.js";

// Area 11, F6, Task 4: la pulizia delle immagini della doc sta qui, da sola,
// perché tocca lo storage: `product-docs-ops.ts` lo raggiunge il catalogo di
// Claude (le sue voci della doc), e lì niente deve uscire da solo
// (`claude-actions-effects.test.ts`).

/**
 * Review di F1 (I2): le immagini caricate che nessun blocco della loro pagina
 * nomina più da almeno `olderThanDays` giorni (una tolta resta qualche giorno:
 * ⌘Z e la cronologia la rimettono). Righe e oggetti vanno via insieme; uno
 * storage che rifiuta lascia la chiave in `storage_orphans`. Gira con la
 * pulizia oraria dello storage.
 */
export async function purgeUnusedProductImages(db: Db, storage: ObjectStorage | null, log: (msg: string) => void, olderThanDays = 7, limit = 200): Promise<number> {
  if (!storage) return 0;
  const rows = await db
    .select({ id: productPageImages.id, key: productPageImages.storageKey })
    .from(productPageImages)
    .innerJoin(productPages, eq(productPages.id, productPageImages.pageId))
    .where(
      and(
        lt(productPageImages.createdAt, sql`now() - make_interval(days => ${olderThanDays}::int)`),
        lt(productPages.updatedAt, sql`now() - make_interval(days => ${olderThanDays}::int)`),
        sql`position(${PRODUCT_IMAGE_REF_PREFIX} || ${productPageImages.id}::text in ${productPages.blocks}::text) = 0`,
      ),
    )
    .limit(limit);
  for (const row of rows) {
    await db.delete(productPageImages).where(eq(productPageImages.id, row.id));
    await removeOrRecordOrphan(db, storage, row.key, "product image unused");
  }
  if (rows.length > 0) log(`[product] ${rows.length} immagini non più usate tolte`);
  return rows.length;
}
