import { decrypt } from "@stubwise/db";
import { createS3Storage } from "./s3.js";

export { createS3Storage };

/**
 * Astrazione minimale sullo storage degli oggetti (allegati). Implementata sopra
 * un backend S3-compatibile, ma il resto del server dipende solo da questa
 * interfaccia.
 */
export interface ObjectStorage {
  /** Carica `body` con il `contentType` dato sotto la chiave `key`. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * URL firmato per il download diretto di `key`, valido `expiresInSeconds`
   * (default 300s). `filename` finisce nel Content-Disposition `attachment`.
   */
  getSignedDownloadUrl(key: string, filename: string, expiresInSeconds?: number): Promise<string>;
  /** Elimina l'oggetto `key` (no-op lato S3 se non esiste). */
  deleteObject(key: string): Promise<void>;
}

/** Configurazione di un backend S3-compatibile, con secret key in chiaro. */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

/**
 * Sottoinsieme della riga `instance_settings` che descrive lo storage. Tutte le
 * colonne sono nullable: lo storage è opzionale.
 */
export interface S3SettingsLike {
  s3Endpoint?: string | null;
  s3Region?: string | null;
  s3Bucket?: string | null;
  s3AccessKey?: string | null;
  s3SecretKeyEncrypted?: string | null;
}

/**
 * Deriva una {@link S3Config} dai settings dell'istanza, decifrando la secret
 * key con `encryptionKey`. È l'UNICO punto che stabilisce se lo storage è
 * attivo: ritorna `null` se manca uno qualsiasi tra endpoint, bucket, accessKey
 * o secret cifrato. La region è opzionale e default a `"auto"` (S3-compatibili
 * come Hetzner/MinIO ignorano spesso la region, ma l'SDK la richiede).
 */
export function s3ConfigFromSettings(
  settings: S3SettingsLike,
  encryptionKey: Buffer,
): S3Config | null {
  const { s3Endpoint, s3Bucket, s3AccessKey, s3SecretKeyEncrypted } = settings;
  if (!s3Endpoint || !s3Bucket || !s3AccessKey || !s3SecretKeyEncrypted) {
    return null;
  }
  return {
    endpoint: s3Endpoint,
    region: settings.s3Region ?? "auto",
    bucket: s3Bucket,
    accessKey: s3AccessKey,
    secretKey: decrypt(s3SecretKeyEncrypted, encryptionKey),
  };
}
