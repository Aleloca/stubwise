import { pipeline, Transform, type Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { instanceSettings, s3ConfigFromSettings, type Db, type S3Config } from "@stubwise/db";

/**
 * Lo storage dal WORKER (area 5, fetta 3, decisione dell'orchestratrice):
 * SOLA LETTURA, solo gli oggetti del Drive, solo per estrarne il contenuto.
 * - Le credenziali sono quelle dell'istanza, quindi la sola lettura è una
 *   regola del CODICE: questo modulo espone una funzione, `getObjectStream`, e
 *   importa dall'SDK solo `S3Client` e `GetObjectCommand`. Nessun Put, Delete,
 *   Copy o caricamento multipart è importabile dal worker
 *   (`storage-read.test.ts` lo verifica sul sorgente).
 * - La chiave deve cominciare con `drive/` e non risalire (`..`).
 * - I byte letti hanno un tetto (il peso nel DB più un margine): oltre, lo
 *   stream si ferma con un errore.
 * La potatura degli oggetti resta del server.
 */

export class DriveObjectMissing extends Error {
  constructor(readonly key: string) {
    super(`Drive object not found: ${key}`);
    this.name = "DriveObjectMissing";
  }
}

export class DriveObjectTooLarge extends Error {
  constructor(readonly key: string) {
    super(`Drive object over the expected size: ${key}`);
    this.name = "DriveObjectTooLarge";
  }
}

/** L'UNICA operazione sullo storage che il worker conosce. */
export type DriveObjectReader = { getObjectStream: (key: string, opts: { maxBytes: number }) => Promise<Readable>; close?: () => void };

/** Il tempo massimo di un download dallo storage (review della F3): richiesta e corpo. */
export const DRIVE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Una chiave del Drive: `drive/<progetto>/<file>/<nome>`, senza `..` e senza percorsi assoluti. */
export function isDriveKey(key: string): boolean {
  return key.startsWith("drive/") && !key.split("/").some((part) => part === ".." || part === ".") && !key.includes("\\") && !key.includes("\0");
}

/** Il lettore sopra una configurazione S3; `send` iniettabile nei test. */
export function createDriveObjectReader(
  config: S3Config,
  client: Pick<S3Client, "send"> & Partial<Pick<S3Client, "destroy">> = s3Client(config),
  opts: { timeoutMs?: number } = {},
): DriveObjectReader {
  const getObjectStream: DriveObjectReader["getObjectStream"] = async (key, { maxBytes }) => {
    if (!isDriveKey(key)) throw new Error(`not a Drive key: ${key}`);
    let body: Readable;
    try {
      // Il timeout copre anche il corpo: l'AbortSignal dell'SDK chiude lo stream.
      const out = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? DRIVE_DOWNLOAD_TIMEOUT_MS),
      });
      body = out.Body as Readable;
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") throw new DriveObjectMissing(key);
      throw error;
    }
    let read = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        read += chunk.length;
        if (read > maxBytes) done(new DriveObjectTooLarge(key));
        else done(null, chunk);
      },
    });
    // `pipeline`, non `.pipe()`: un errore o una chiusura da una parte ferma anche l'altra.
    return pipeline(body, cap, () => undefined);
  };
  return { getObjectStream, close: () => client.destroy?.() };
}

function s3Client(config: S3Config): S3Client {
  return new S3Client({ endpoint: config.endpoint, region: config.region, credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }, forcePathStyle: true });
}

/**
 * UN lettore (e un client S3) riusato finché la configurazione dello storage
 * non cambia (review della F3); cambiata, o tolta, il client vecchio si
 * distrugge, e `close` (all'arresto del worker) distrugge quello vivo.
 */
export function createDriveReaderCache(
  loadConfig: () => Promise<S3Config | null>,
  make: (config: S3Config) => DriveObjectReader = (config) => createDriveObjectReader(config),
): { get: () => Promise<DriveObjectReader | null>; close: () => void } {
  let cached: { key: string; reader: DriveObjectReader } | null = null;
  const drop = () => {
    cached?.reader.close?.();
    cached = null;
  };
  return {
    async get() {
      const config = await loadConfig();
      if (!config) {
        drop();
        return null;
      }
      const key = [config.endpoint, config.region, config.bucket, config.accessKey, config.secretKey].join("\u0000");
      if (cached?.key !== key) {
        drop();
        cached = { key, reader: make(config) };
      }
      return cached.reader;
    },
    close: drop,
  };
}

/** La configurazione S3 d'istanza, o null se non c'è (o la secret non si decifra). */
export async function loadDriveS3Config(db: Db, encryptionKey: Buffer): Promise<S3Config | null> {
  const [row] = await db.select().from(instanceSettings).limit(1);
  if (!row) return null;
  try {
    return s3ConfigFromSettings(row, encryptionKey);
  } catch {
    return null;
  }
}
