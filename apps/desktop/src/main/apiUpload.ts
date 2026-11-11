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

/** Un pezzo del file per lettura dal disco (e per consegna alla rete). */
const UPLOAD_CHUNK_BYTES = 64 * 1024;

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
  | { ok: true; grant: string; name: string; sizeBytes: number }
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
        // Una volta sola, senza seguire un collegamento simbolico. `O_NONBLOCK`:
        // una FIFO o un dispositivo non tengono appeso un thread di libuv
        // aspettando chi scrive (su un file normale non cambia niente); il
        // controllo `isFile()` subito dopo li rifiuta.
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
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
      const grant = randomBytes(24).toString("base64url");
      const name = basename(path);
      entries.set(grant, {
        owner,
        handle,
        size: stat.size,
        name,
        mime: typeof mime === "string" && MIME_RE.test(mime) ? mime : "application/octet-stream",
        expiresAt: now() + ttlMs,
      });
      return { ok: true, grant, name, sizeBytes: stat.size };
    },
    /** Il file di un token, una volta sola e solo per chi l'ha chiesto; chi lo prende chiude il descrittore. */
    take(owner: number, grant: unknown): UploadEntry | null {
      sweep();
      if (typeof grant !== "string") return null;
      const e = entries.get(grant);
      if (!e || e.owner !== owner) return null;
      entries.delete(grant);
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
      /** Il codice d'errore del server, se c'era (un nome breve, mai il corpo). */
      code?: string;
    };

/**
 * Manda il file in streaming dal descrittore: il multipart con la sua
 * Content-Length esatta, il bearer solo all'istanza, nessun reindirizzamento
 * seguito. `onProgress` riceve i byte del file consegnati alla rete; `signal` annulla.
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

    // A `pull()`, un pezzo per chiamata e senza riserva (`highWaterMark: 0`):
    // si legge dal disco solo quando undici chiede il pezzo successivo, cioè
    // quando ha consegnato il precedente. Il progresso conta ciò che è stato
    // consegnato, non ciò che è stato letto.
    let position = 0;
    let headSent = false;
    let done = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            if (signal?.aborted) throw new Error("aborted");
            if (!headSent) {
              headSent = true;
              controller.enqueue(new Uint8Array(head));
              return;
            }
            if (position < entry.size) {
              const want = Math.min(UPLOAD_CHUNK_BYTES, entry.size - position);
              const buffer = Buffer.allocUnsafe(want);
              const { bytesRead } = await entry.handle.read(buffer, 0, want, position);
              // Il file si è accorciato dopo la scelta: la Content-Length mentirebbe.
              if (bytesRead === 0) throw new Error("shrunk");
              position += bytesRead;
              controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
              onProgress?.(position, entry.size);
              return;
            }
            if (!done) {
              // Il file non cresce dopo la scelta: oltre il peso letto all'apertura, ci si ferma.
              const probe = await entry.handle.read(Buffer.alloc(1), 0, 1, entry.size);
              if (probe.bytesRead > 0) throw new Error("grown");
              done = true;
              controller.enqueue(new Uint8Array(tail));
              controller.close();
            }
          } catch (error) {
            controller.error(error);
          }
        },
      },
      { highWaterMark: 0 },
    );

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
    const known = typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? { code } : {};
    if (res.status === 400 || res.status === 403 || res.status === 404) return { ok: false, reason: "invalid", status: res.status, ...known };
    return { ok: false, reason: "failed", status: res.status, ...known };
  } finally {
    await entry.handle.close().catch(() => undefined);
  }
}
