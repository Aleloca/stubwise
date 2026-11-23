import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { mailDraftAttachments, storageOrphans } from "./schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Gli oggetti nello storage degli allegati di una bozza che se ne va
 * (revisione del lotto 2, dopo l'I5): le righe se ne vanno in cascata con la
 * bozza, gli oggetti no. Si chiama DENTRO la transazione che la cancella,
 * subito prima della delete, e mette le chiavi in `storage_orphans` (0144):
 * la pulizia oraria del server (`purgeStorageOrphans`, che ha lo storage) le
 * toglie, e un rifiuto dello storage lascia la riga al giro dopo. Così non
 * fallisce niente per lo storage, e il worker (che lo storage non ce l'ha)
 * passa dalla stessa strada del server.
 *
 * Solo gli oggetti della bozza: un allegato del Drive (`drive_file_id`) ha
 * l'oggetto del suo file, che resta. Restituisce le chiavi messe in coda.
 */
export async function queueDraftAttachmentObjects(tx: Tx | Db, draftId: string, reason: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    insert into ${storageOrphans} (storage_key, reason)
    select a.storage_key, ${reason} from ${mailDraftAttachments} a
    where a.draft_id = ${draftId} and a.storage_key is not null and a.drive_file_id is null
    on conflict (storage_key) do nothing
    returning storage_key
  `)) as unknown as { rows?: { storage_key: string }[] } & { storage_key: string }[];
  return (rows.rows ?? rows).map((r) => r.storage_key);
}
