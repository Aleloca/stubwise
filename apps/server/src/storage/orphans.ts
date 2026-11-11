import { asc, inArray } from "drizzle-orm";
import { storageOrphans, type Db } from "@stubwise/db";
import type { ObjectStorage } from "./index.js";

/**
 * Gli oggetti rimasti SENZA riga (review della fetta 2): un caricamento
 * interrotto o troppo grande, un insert fallito, una copia a metà. Si prova a
 * toglierli subito; se lo storage rifiuta, la chiave va in `storage_orphans`
 * (0144) invece di perdersi, e la pulizia oraria la ritenta.
 */
export async function removeOrRecordOrphan(db: Db, storage: ObjectStorage, storageKey: string, reason: string): Promise<void> {
  try {
    await storage.deleteObject(storageKey);
  } catch {
    // Con storage E database giù non resta dove scriverlo: il caso doppio è accettato.
    await db
      .insert(storageOrphans)
      .values({ storageKey, reason })
      .onConflictDoNothing()
      .catch(() => undefined);
  }
}

/** Ritenta gli orfani, dal più vecchio; un rifiuto lascia la riga al giro dopo. Senza storage non tocca niente. */
export async function purgeStorageOrphans(db: Db, storage: ObjectStorage | null, log: (msg: string) => void, limit = 200): Promise<number> {
  if (!storage) return 0;
  const rows = await db.select({ storageKey: storageOrphans.storageKey }).from(storageOrphans).orderBy(asc(storageOrphans.createdAt)).limit(limit);
  const done: string[] = [];
  for (const row of rows) {
    try {
      await storage.deleteObject(row.storageKey);
      done.push(row.storageKey);
    } catch (error) {
      log(`[storage] orfano ${row.storageKey} non tolto, riprovo al giro dopo: ${String(error)}`);
    }
  }
  if (done.length > 0) await db.delete(storageOrphans).where(inArray(storageOrphans.storageKey, done));
  return done.length;
}
