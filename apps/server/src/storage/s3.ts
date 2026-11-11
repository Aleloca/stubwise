import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, S3Config } from "./index.js";

/**
 * Rimuove dal filename i caratteri che romperebbero l'header
 * `Content-Disposition`: virgolette (chiudono il valore quoted) e CR/LF (header
 * injection). Il risultato finisce in `attachment; filename="..."`.
 */
function sanitizeFilename(filename: string): string {
  // Tutti i caratteri di controllo (non solo CR/LF), virgolette e backslash
  // (review della fetta 4 della Chat): niente che chiuda il valore quoted o
  // spezzi l'header.
  return filename.replace(/[\u0000-\u001f\u007f"\\]/g, "");
}

/** RFC 5987: `encodeURIComponent` più i caratteri che lì restano letterali. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Il `Content-Disposition` di un download (allegati dei ticket e della Chat):
 * sempre `attachment`. Un nome ASCII va in `filename="…"`; uno con caratteri
 * non ASCII ha un ripiego ASCII (`_` al posto di quei caratteri) e il nome vero
 * in `filename*=UTF-8''…` (RFC 6266), che i browser preferiscono.
 */
export function contentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  const clean = sanitizeFilename(filename);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return ascii === clean ? `${disposition}; filename="${clean}"` : `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(clean)}`;
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

    async putObjectStream(key, body, contentType) {
      // Il multipart (parti da 5 MB, una alla volta): il file non sta mai tutto
      // in memoria. Un errore dello stream annulla il caricamento.
      const upload = new Upload({
        client,
        params: { Bucket: config.bucket, Key: key, Body: body, ContentType: contentType },
        queueSize: 1,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await upload.done();
    },

    async copyObject(fromKey, toKey) {
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: toKey,
          // `CopySource` è «bucket/chiave» con la chiave codificata come in un URL.
          CopySource: `${config.bucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
        }),
      );
    },

    async getSignedDownloadUrl(key, filename, expiresInSeconds = 300, opts = {}) {
      const inline = opts.inlineContentType !== undefined;
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ResponseContentDisposition: contentDisposition(filename, inline ? "inline" : "attachment"),
          ...(inline ? { ResponseContentType: opts.inlineContentType } : {}),
        }),
        { expiresIn: expiresInSeconds },
      );
    },

    origin: (() => {
      try {
        return new URL(config.endpoint).origin;
      } catch {
        return undefined;
      }
    })(),

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
