import { decrypt } from "./secrets.js";

/**
 * La configurazione dello storage S3 dell'istanza (`instance_settings`). Sta
 * qui dall'area 5, fetta 3, perché la legge anche il worker (in SOLA LETTURA,
 * per il contenuto dei file del Drive): una sorgente, non due copie. Il server
 * la ri-esporta da `apps/server/src/storage/index.ts`.
 */

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
