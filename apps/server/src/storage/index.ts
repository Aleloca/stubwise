import { instanceSettings, s3ConfigFromSettings, type S3Config } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { Readable } from "node:stream";
import { createS3Storage } from "./s3.js";
export { StorageObjectNotFound } from "./errors.js";

export { createS3Storage };

/**
 * Firma di una funzione che, dati DB e chiave di cifratura, ricava lo storage
 * attivo a runtime (o `null` se non configurato). È il punto di iniezione per i
 * test: in produzione si usa {@link getActiveStorage}, nei test un fake
 * in-memory. Vedi BuildAppOptions.storageFactory in app.ts.
 */
export type StorageFactory = (db: Db, encryptionKey: Buffer) => Promise<ObjectStorage | null>;

/**
 * Ricava l'{@link ObjectStorage} attivo dalle instance settings. Legge la riga
 * singleton, deriva la config S3 (la decifratura della secret può LANCIARE se
 * corrotta: il try/catch la tratta come "non configurato") e, se valida,
 * costruisce il client S3. Ritorna `null` se lo storage non è configurato.
 *
 * Scelta v1: il client viene istanziato per-richiesta. Le credenziali possono
 * cambiare da Settings in qualsiasi momento e l'overhead di costruire un
 * S3Client (nessuna connessione aperta finché non si invia un comando) è
 * trascurabile; un eventuale caching va invalidato sui cambi di config, che non
 * vale la complessità per la v1.
 */
export async function getActiveStorage(
  db: Db,
  encryptionKey: Buffer,
): Promise<ObjectStorage | null> {
  const [row] = await db.select().from(instanceSettings).limit(1);
  if (!row) return null;
  let config: S3Config | null;
  try {
    config = s3ConfigFromSettings(row, encryptionKey);
  } catch {
    // Secret corrotta o chiave errata: trattata come storage non configurato.
    return null;
  }
  return config ? createS3Storage(config) : null;
}

/**
 * Astrazione minimale sullo storage degli oggetti (allegati). Implementata sopra
 * un backend S3-compatibile, ma il resto del server dipende solo da questa
 * interfaccia.
 */
export interface ObjectStorage {
  /** Carica `body` con il `contentType` dato sotto la chiave `key`. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * Carica uno STREAM (area 5, fetta 2: il Drive, fino a 100 MB) col caricamento
   * multipart: il file non sta mai tutto in memoria. Chi chiama conta i byte e
   * tronca lo stream oltre il tetto; un errore annulla il multipart.
   */
  putObjectStream(key: string, body: Readable, contentType: string): Promise<void>;
  /** Copia `fromKey` in `toKey` (Save to Drive: due oggetti indipendenti); `StorageObjectNotFound` se `fromKey` non c'è. */
  copyObject(fromKey: string, toKey: string): Promise<void>;
  /**
   * URL firmato per il download diretto di `key`, valido `expiresInSeconds`
   * (default 300s). `filename` finisce nel Content-Disposition `attachment`;
   * con `inlineContentType` (l'anteprima di un tipo sicuro) `inline`, col
   * Content-Type forzato a quello.
   */
  getSignedDownloadUrl(key: string, filename: string, expiresInSeconds?: number, opts?: { inlineContentType?: string }): Promise<string>;
  /** Elimina l'oggetto `key` (no-op lato S3 se non esiste). */
  deleteObject(key: string): Promise<void>;
  /**
   * Legge `key` per intero, al più `maxBytes` (area 6, F3: gli allegati di una
   * bozza vanno nel messaggio MIME). Oltre il tetto lancia: un oggetto più
   * grande di quanto si aspetta chi legge non si carica in memoria.
   * `StorageObjectNotFound` se `key` non c'è.
   */
  getObjectBytes(key: string, maxBytes: number): Promise<Buffer>;
  /** L'origine degli URL firmati (`https://host`): un'anteprima inline vuole un'origine diversa dall'istanza. */
  readonly origin?: string;
}

// La configurazione S3 dell'istanza sta in `@stubwise/db` (area 5, fetta 3):
// la legge anche il worker, in sola lettura, per il contenuto del Drive.
export { s3ConfigFromSettings, type S3Config, type S3SettingsLike } from "@stubwise/db";
