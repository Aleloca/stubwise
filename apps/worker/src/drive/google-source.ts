import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { googleAccounts, type Db } from "@stubwise/db";
import { GoogleApiError, openDriveFileStream, refreshAccessToken, type FetchImpl } from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import { DRIVE_FILE_MAX_BYTES } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { DriveObjectTooLarge } from "./storage-read.js";

/**
 * IL CONTENUTO DI UN RIFERIMENTO GOOGLE (area 6, F5b, B2/B3): lo stesso
 * estrattore dei caricati, con la sorgente che legge da Google con la casella
 * del riferimento (`drive_files.google_account_id`: chi l'ha aggiunto, o chi
 * ha collegato la sua cartella) — mai con un'altra. Una casella che non c'è
 * più, disattivata o senza `drive.readonly` non legge: `access_lost`. Il file
 * non visibile (404 di Drive) vale lo stesso, fail-closed: «cancellato» lo
 * dice solo la sincronizzazione della cartella.
 */

export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export type GoogleDriveOpen = { stream: Readable; mime: string } | { gone: "access_lost" };
export type GoogleDriveSource = (file: { googleFileId: string; mime: string; googleAccountId: string | null }) => Promise<GoogleDriveOpen>;

export function createGoogleDriveSource(deps: { db: Db; encryptionKey: Buffer; fetchImpl?: FetchImpl; refresh?: typeof refreshAccessToken }): GoogleDriveSource {
  const options = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  return async (file) => {
    if (!file.googleAccountId) return { gone: "access_lost" };
    const [account] = await deps.db
      .select({ disabledAt: googleAccounts.disabledAt, scopes: googleAccounts.scopes })
      .from(googleAccounts)
      .where(eq(googleAccounts.id, file.googleAccountId));
    if (!account || account.disabledAt || !account.scopes.includes(DRIVE_READONLY_SCOPE)) return { gone: "access_lost" };
    const credentials = await loadGoogleAccountCredentials(deps.db, deps.encryptionKey, file.googleAccountId);
    if (!credentials) return { gone: "access_lost" };
    let opened: { body: ReadableStream<Uint8Array>; mime: string };
    try {
      const tokens = await (deps.refresh ?? refreshAccessToken)({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, refreshToken: credentials.refreshToken }, options);
      opened = await openDriveFileStream({ accessToken: tokens.accessToken, fileId: file.googleFileId, mimeType: file.mime }, options);
    } catch (err) {
      if (err instanceof GoogleApiError && (err.code === "file_not_found" || err.code === "insufficient_scope" || err.code === "invalid_grant")) return { gone: "access_lost" };
      throw err;
    }
    let read = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        read += chunk.length;
        if (read > DRIVE_FILE_MAX_BYTES) done(new DriveObjectTooLarge(file.googleFileId));
        else done(null, chunk);
      },
    });
    const source = Readable.fromWeb(opened.body as unknown as NodeReadableStream<Uint8Array>);
    return { stream: pipeline(source, cap, () => undefined), mime: opened.mime };
  };
}
