import { and, inArray, isNull, sql, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { driveContentJobs, driveFileChunks, driveFiles, driveFolderLinks } from "./schema.js";

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

/** La cartella del riferimento è stata scollegata mentre lo si inseriva: niente riferimento. */
export class DriveFolderLinkGone extends Error {
  constructor(readonly folderLinkId: string) {
    super(`cartella collegata ${folderLinkId} scollegata`);
  }
}

/**
 * Un riferimento nuovo, dentro una transazione aperta dal chiamante (o una
 * sua). Un file di CARTELLA prende un lock condiviso sulla riga della cartella
 * (review della F5b, minore): lo scollegamento la prende in esclusiva prima di
 * togliere i file, quindi un riferimento o entra prima e se ne va con lei, o
 * trova la cartella sparita ({@link DriveFolderLinkGone}) — mai un «manuale»
 * orfano letto con la casella di chi aveva collegato.
 */
export async function insertDriveReference(db: Db | Tx, input: DriveReferenceInput): Promise<string> {
  const run = async (tx: Tx) => {
    if (input.folderLinkId) {
      const [link] = await tx.select({ id: driveFolderLinks.id }).from(driveFolderLinks).where(eq(driveFolderLinks.id, input.folderLinkId)).for("share");
      if (!link) throw new DriveFolderLinkGone(input.folderLinkId);
    }
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

/**
 * La lapide di riferimenti: il codice resta, il CONTENUTO (testo, riassunto,
 * frammenti) se ne va. Un riferimento non ha byte in archiviazione: nasce già
 * `storage_purged` (review della F5b, minore), così il timer della pulizia
 * non lo guarda mai.
 */
export async function tombstoneDriveFiles(db: Db | Tx, ids: readonly string[], deletedBy: string | null): Promise<void> {
  if (ids.length === 0) return;
  await (db as Db).transaction(async (tx) => {
    await tx
      .update(driveFiles)
      .set({ deletedAt: sql`now()`, deletedBy, contentText: null, summary: null, storagePurged: sql`${driveFiles.storageKey} is null or ${driveFiles.storagePurged}` })
      .where(and(inArray(driveFiles.id, [...ids]), isNull(driveFiles.deletedAt)));
    await tx.delete(driveFileChunks).where(inArray(driveFileChunks.fileId, [...ids]));
  });
}

/**
 * La RICOLLEGAZIONE (review della F5b, punto 5): scollegare Google cancella la
 * riga della casella e la FK mette a NULL gli id; quando la STESSA persona
 * ricollega lo STESSO indirizzo, le sue cartelle e i suoi riferimenti tornano
 * alla riga nuova (l'indirizzo lo ricorda la 0168). Solo i suoi: `linked_by`
 * per le cartelle, `added_by` per i file (un file di cartella è aggiunto da
 * chi l'ha collegata). Le cartelle riagganciate chiedono una sincronizzazione.
 * Ritorna quante cartelle e quanti file.
 */
export async function reattachDriveReferences(db: Db | Tx, account: { id: string; userId: string; email: string }): Promise<{ links: number; files: number }> {
  return (db as Db).transaction(async (tx) => {
    const links = await tx
      .update(driveFolderLinks)
      .set({ accountId: account.id, syncRequestedAt: sql`now()` })
      .where(and(isNull(driveFolderLinks.accountId), eq(driveFolderLinks.linkedBy, account.userId), sql`lower(${driveFolderLinks.accountEmail}) = lower(${account.email})`))
      .returning({ id: driveFolderLinks.id });
    const files = await tx
      .update(driveFiles)
      .set({ googleAccountId: account.id })
      .where(and(eq(driveFiles.source, "google"), isNull(driveFiles.googleAccountId), isNull(driveFiles.deletedAt), eq(driveFiles.addedBy, account.userId), sql`lower(${driveFiles.googleAccountEmail}) = lower(${account.email})`))
      .returning({ id: driveFiles.id });
    return { links: links.length, files: files.length };
  });
}
