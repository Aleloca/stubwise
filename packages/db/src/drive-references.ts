import { and, inArray, isNull, sql, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { driveContentJobs, driveFileChunks, driveFiles } from "./schema.js";

/**
 * I RIFERIMENTI A GOOGLE DRIVE (area 6, F5b): l'inserimento e la lapide, in UN
 * posto, perché li scrivono sia il server (un file aggiunto a mano) sia il
 * worker (la sincronizzazione di una cartella). Il numero si prende sotto lo
 * STESSO lock del progetto dei caricati (`stubwise-drive:<progetto>`, in
 * `apps/server/src/drive/service.ts`): un codice non si ripete né si riusa.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DriveReferenceInput {
  projectId: string;
  addedBy: string | null;
  /** La casella che legge il riferimento (B3). */
  googleAccountId: string | null;
  folderLinkId: string | null;
  file: { id: string; name: string; mimeType: string; sizeBytes: number | null; owner: string | null; modifiedAt: Date | null };
  type: "document" | "sheet" | "slides" | "pdf" | "image" | "other";
  /** Il tipo si legge (testo, riassunto): nasce `pending` col suo job, altrimenti `unsupported`. */
  extractable: boolean;
}

/** Un riferimento nuovo, dentro una transazione aperta dal chiamante (o una sua). */
export async function insertDriveReference(db: Db | Tx, input: DriveReferenceInput): Promise<string> {
  const run = async (tx: Tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stubwise-drive:${input.projectId}`}))`);
    const [max] = await tx.select({ n: sql<number>`coalesce(max(${driveFiles.number}), 0)::int` }).from(driveFiles).where(eq(driveFiles.projectId, input.projectId));
    const [row] = await tx
      .insert(driveFiles)
      .values({
        projectId: input.projectId,
        number: (max?.n ?? 0) + 1,
        source: "google",
        name: input.file.name,
        mime: input.file.mimeType,
        type: input.type,
        sizeBytes: input.file.sizeBytes,
        googleFileId: input.file.id,
        googleOwner: input.file.owner,
        googleAccountId: input.googleAccountId,
        folderLinkId: input.folderLinkId,
        modifiedAt: input.file.modifiedAt,
        addedBy: input.addedBy,
        contentStatus: input.extractable ? "pending" : "unsupported",
      })
      .returning({ id: driveFiles.id });
    if (input.extractable) await tx.insert(driveContentJobs).values({ fileId: row!.id });
    return row!.id;
  };
  // Dentro una transazione aperta è un savepoint: il lock resta della transazione esterna.
  return (db as Db).transaction((tx) => run(tx));
}

/** La lapide di riferimenti: il codice resta, il CONTENUTO (testo, riassunto, frammenti) se ne va. */
export async function tombstoneDriveFiles(db: Db, ids: readonly string[], deletedBy: string | null): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction(async (tx) => {
    await tx
      .update(driveFiles)
      .set({ deletedAt: sql`now()`, deletedBy, contentText: null, summary: null })
      .where(and(inArray(driveFiles.id, [...ids]), isNull(driveFiles.deletedAt)));
    await tx.delete(driveFileChunks).where(inArray(driveFileChunks.fileId, [...ids]));
  });
}
