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
export type DriveObjectReader = { getObjectStream: (key: string, opts: { maxBytes: number }) => Promise<Readable> };

/** Una chiave del Drive: `drive/<progetto>/<file>/<nome>`, senza `..` e senza percorsi assoluti. */
export function isDriveKey(key: string): boolean {
  return key.startsWith("drive/") && !key.split("/").some((part) => part === ".." || part === ".") && !key.includes("\\") && !key.includes("\0");
}

/** Il lettore sopra una configurazione S3; `send` iniettabile nei test. */
export function createDriveObjectReader(config: S3Config, client: Pick<S3Client, "send"> = s3Client(config)): DriveObjectReader {
  const getObjectStream: DriveObjectReader["getObjectStream"] = async (key, { maxBytes }) => {
    if (!isDriveKey(key)) throw new Error(`not a Drive key: ${key}`);
    let body: Readable;
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
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
  return { getObjectStream };
}

function s3Client(config: S3Config): S3Client {
  return new S3Client({ endpoint: config.endpoint, region: config.region, credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }, forcePathStyle: true });
}

/** Il lettore dalla configurazione d'istanza, o null se lo storage non è configurato (o la secret non si decifra). */
export async function activeDriveObjectReader(db: Db, encryptionKey: Buffer): Promise<DriveObjectReader | null> {
  const [row] = await db.select().from(instanceSettings).limit(1);
  if (!row) return null;
  try {
    const config = s3ConfigFromSettings(row, encryptionKey);
    return config ? createDriveObjectReader(config) : null;
  } catch {
    return null;
  }
}
