import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { endsSession } from "@stubwise/shared";
import type { ApiProxyDeps } from "./apiProxy";

// Il caricamento di un file del Drive dal desktop (area 5, fetta 2; proposta
// approvata dall'orchestratrice). Il renderer non manda mai i byte né un
// percorso: il preload prende il percorso di un File scelto dall'utente
// (`webUtils.getPathForFile`, vuoto per un File costruito dalla pagina) e il
// main lo APRE una volta sola (`O_NOFOLLOW`, `fstat` sul descrittore: niente
// riverifica per percorso fra controllo e lettura), dietro un token monouso,
// legato alla finestra, che scade. Al caricamento il main legge in streaming
// da quel descrittore e manda il multipart col bearer, con Content-Length
// esatta, solo alla rotta del Drive. Qui la logica pura (testata); la colla con
// Electron sta in `index.ts`.

/** Il tetto del Drive (D4 del maintainer): 100 MB per file. */
export const DRIVE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UPLOAD_PATH = new RegExp(`^/api/projects/${UUID}/drive/files$`, "i");

/** Solo il caricamento del Drive di un progetto, esatto. */
export function isAllowedUploadPath(path: unknown): path is string {
  return typeof path === "string" && UPLOAD_PATH.test(path);
}

/** Un tipo MIME come lo scrive un File (`tipo/sottotipo`), o niente. */
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export interface UploadEntry {
  handle: FileHandle;
  size: number;
  name: string;
  mime: string;
}

export type RegisterResult =
  | { ok: true; token: string; name: string; sizeBytes: number }
  | { ok: false; reason: "invalid" | "too_large" | "too_many" };

/**
 * I file scelti in attesa di caricamento, per finestra (`owner`): ognuno col
 * suo descrittore aperto. Un token vale una volta, solo per la finestra che
 * l'ha chiesto, e scade; un tetto ai token aperti per finestra, e la chiusura
 * della finestra li chiude tutti.
 */
export function createUploadTokens({
  max = 50,
  ttlMs = 10 * 60_000,
  now = () => Date.now(),
}: { max?: number; ttlMs?: number; now?: () => number } = {}) {
  const entries = new Map<string, UploadEntry & { owner: number; expiresAt: number }>();

  const closeQuietly = (handle: FileHandle) => handle.close().catch(() => undefined);

  /** Via i token scaduti (e i loro descrittori). */
  function sweep(): void {
    const t = now();
    for (const [token, e] of entries) {
      if (e.expiresAt <= t) {
        entries.delete(token);
        void closeQuietly(e.handle);
      }
    }
  }

  const openOf = (owner: number) => [...entries.values()].filter((e) => e.owner === owner).length;

  return {
    async register(owner: number, path: string, mime: string): Promise<RegisterResult> {
      sweep();
      if (typeof path !== "string" || path === "") return { ok: false, reason: "invalid" };
      if (openOf(owner) >= max) return { ok: false, reason: "too_many" };
      let handle: FileHandle;
      try {
        // Una volta sola, senza seguire un collegamento simbolico.
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch {
        return { ok: false, reason: "invalid" };
      }
      const stat = await handle.stat().catch(() => null);
      if (!stat || !stat.isFile()) {
        await closeQuietly(handle);
        return { ok: false, reason: "invalid" };
      }
      if (stat.size > DRIVE_UPLOAD_MAX_BYTES) {
        await closeQuietly(handle);
        return { ok: false, reason: "too_large" };
      }
      const token = randomBytes(24).toString("base64url");
      const name = basename(path);
      entries.set(token, {
        owner,
        handle,
        size: stat.size,
        name,
        mime: typeof mime === "string" && MIME_RE.test(mime) ? mime : "application/octet-stream",
        expiresAt: now() + ttlMs,
      });
      return { ok: true, token, name, sizeBytes: stat.size };
    },
    /** Il file di un token, una volta sola e solo per chi l'ha chiesto; chi lo prende chiude il descrittore. */
    take(owner: number, token: unknown): UploadEntry | null {
      sweep();
      if (typeof token !== "string") return null;
      const e = entries.get(token);
      if (!e || e.owner !== owner) return null;
      entries.delete(token);
      return { handle: e.handle, size: e.size, name: e.name, mime: e.mime };
    },
    /** Quanti token ha aperti una finestra. */
    open(owner: number): number {
      sweep();
      return openOf(owner);
    },
    /** La finestra si chiude (o cambia persona): via tutti i suoi token. */
    async dropOwner(owner: number): Promise<void> {
      const mine = [...entries].filter(([, e]) => e.owner === owner);
      for (const [token] of mine) entries.delete(token);
      await Promise.all(mine.map(([, e]) => closeQuietly(e.handle)));
    },
  };
}

// --- il multipart --------------------------------------------------------------------

/** Un valore fra virgolette in un'intestazione: niente CR, LF, virgolette né barre inverse. */
const quoted = (value: string) => value.replace(/["\\\r\n]/g, "_");

/**
 * L'intestazione della parte del file, come il `contentDisposition` del server:
 * il nome ASCII fra virgolette e, se il nome non lo è, anche `filename*` UTF-8.
 * Il nome del campo è sempre `file` (la rotta del Drive).
 */
export function formDataHeader(_field: string, filename: string, mime: string): string {
  const clean = quoted(filename);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const star = ascii === clean ? "" : `; filename*=UTF-8''${encodeURIComponent(clean)}`;
  const type = MIME_RE.test(mime) ? mime : "application/octet-stream";
  return `Content-Disposition: form-data; name="file"; filename="${ascii}"${star}\r\nContent-Type: ${type}\r\n\r\n`;
}

export type UploadResult =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      reason: "invalid" | "unauthenticated" | "too_large" | "unsupported_type" | "failed" | "canceled";
      status?: number;
    };

/**
 * Manda il file in streaming dal descrittore: il multipart con la sua
 * Content-Length esatta, il bearer solo all'istanza, nessun reindirizzamento
 * seguito. `onProgress` riceve i byte del file letti; `signal` annulla.
 * Il descrittore si chiude sempre.
 */
export async function uploadFile(
  entry: UploadEntry,
  path: string,
  deps: ApiProxyDeps,
  { onProgress, signal }: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<UploadResult> {
  try {
    if (!isAllowedUploadPath(path)) return { ok: false, reason: "invalid" };
    const base = deps.instanceUrl();
    if (!base) return { ok: false, reason: "invalid" };
    const token = deps.token();
    if (!token) return { ok: false, reason: "unauthenticated" };
    if (entry.size > DRIVE_UPLOAD_MAX_BYTES) return { ok: false, reason: "too_large" };

    const boundary = `----stubwise-${randomUUID()}`;
    const head = Buffer.from(`--${boundary}\r\n${formDataHeader("file", entry.name, entry.mime)}`, "utf8");
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const length = head.byteLength + entry.size + tail.byteLength;

    const source = entry.handle.createReadStream({ start: 0, autoClose: false });
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(head));
        try {
          for await (const chunk of source) {
            if (signal?.aborted) throw new Error("aborted");
            const bytes = chunk as Buffer;
            sent += bytes.byteLength;
            // Il file non cresce dopo la scelta: oltre il peso letto all'apertura, ci si ferma.
            if (sent > entry.size) throw new Error("grown");
            controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            onProgress?.(sent, entry.size);
          }
          controller.enqueue(new Uint8Array(tail));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        source.destroy();
      },
    });

    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(length),
        },
        body,
        redirect: "manual",
        signal: signal ?? null,
        duplex: "half",
      } as RequestInit);
    } catch {
      source.destroy();
      return signal?.aborted ? { ok: false, reason: "canceled" } : { ok: false, reason: "failed" };
    }
    const json = await res.json().catch(() => null);
    const code = (json as { code?: unknown } | null)?.code;
    if (res.ok) return { ok: true, status: res.status, body: json };
    if (res.status === 401) {
      if (endsSession(path, 401, typeof code === "string" ? code : undefined)) deps.onUnauthorized(token);
      return { ok: false, reason: "unauthenticated", status: 401 };
    }
    if (res.status === 413 || code === "file_too_large") return { ok: false, reason: "too_large", status: res.status };
    if (code === "unsupported_type") return { ok: false, reason: "unsupported_type", status: res.status };
    if (res.status === 400 || res.status === 403 || res.status === 404) return { ok: false, reason: "invalid", status: res.status };
    return { ok: false, reason: "failed", status: res.status };
  } finally {
    await entry.handle.close().catch(() => undefined);
  }
}
