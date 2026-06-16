import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, S3Config } from "./index.js";

/**
 * Rimuove dal filename i caratteri che romperebbero l'header
 * `Content-Disposition`: virgolette (chiudono il valore quoted) e CR/LF (header
 * injection). Il risultato finisce in `attachment; filename="..."`.
 */
function sanitizeFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, "");
}

/**
 * Backend di storage su S3-compatibile (AWS S3, Hetzner Object Storage, MinIO,
 * ...). `forcePathStyle: true` per compatibilità con gli endpoint che non
 * supportano il virtual-hosted style. La secret key arriva già in chiaro nella
 * config (decifrata a monte da {@link s3ConfigFromSettings}).
 */
export function createS3Storage(config: S3Config): ObjectStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });

  return {
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async getSignedDownloadUrl(key, filename, expiresInSeconds = 300) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${sanitizeFilename(filename)}"`,
        }),
        { expiresIn: expiresInSeconds },
      );
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
