import { ApiError } from "@stubwise/api-client";
import {
  DRIVE_CODE_RE,
  DRIVE_FILE_TYPES,
  driveUploadResultSchema,
  DRIVE_FILE_MAX_BYTES,
  type DriveFileRow as ServerDriveFileRow,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  ContentState,
  DriveFileDetail,
  DriveFileRow,
  DriveFilters,
  DriveSearchScope,
  DriveUploadInput,
  DriveUploadOptions,
  DriveUploadResult,
} from "../../types";
import { appClient } from "./client";
import { downloadByPath } from "./download";
import { partialNamespace } from "./notIntegrated";

// Il Drive nella build app (area 5, fette 2 e 3): i file CARICATI «come oggi»,
// col loro contenuto (stato, riassunto, OCR, passaggio della ricerca: F3).
// Google (account, cartelle, riferimenti, file fuori dai progetti) è
// dell'area 6: qui non c'è. Le aperture le conta il server quando si apre davvero
// (`/download`, `/preview`, una per persona ogni 30′): `recordOpen` È il gesto.

type Drive = typeof Fake.drive;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La ricerca parte da 2 caratteri, come nel prototipo. */
const MIN_QUERY = 2;

/** I codici dei progetti di chi guarda, per una riga senza `projectCode` (un server più vecchio). */
async function projectCodes(): Promise<Map<string, string>> {
  const rows = (await appClient().projects.list()) as unknown as { id: string; slug: string; code?: string }[];
  return new Map(rows.map((p) => [p.id, p.code ?? p.slug.toUpperCase()]));
}

/**
 * Lo stato del contenuto (F3) nei nomi del prototipo: in coda o in lettura è
 * «processing» (la lista si rilegge da sola finché ce n'è uno); uno stato che
 * questa app non conosce (lettore: `UNKNOWN`) è «no_text», trovabile per nome;
 * `null` è un server senza la F3: pronto, senza riassunto, come prima.
 */
function contentOf(status: ServerDriveFileRow["contentStatus"] | string | null): ContentState {
  switch (status) {
    case null:
    case "ready":
      return "ready";
    case "pending":
    case "processing":
      return "processing";
    case "no_text":
    case "unsupported":
    case "error":
      return status;
    default:
      return "no_text";
  }
}

/** Una riga del server nella forma del prototipo: un caricato, col suo contenuto (F3). */
function rowOf(r: ServerDriveFileRow, codes: Map<string, string> | null): DriveFileRow {
  return {
    id: r.id,
    code: r.code,
    projectId: r.projectId,
    projectCode: r.projectCode ?? codes?.get(r.projectId) ?? "",
    source: "upload",
    name: r.name,
    // Un tipo che questa app non conosce (lettore: `UNKNOWN`) si mostra come «altro».
    type: (DRIVE_FILE_TYPES as readonly string[]).includes(r.type) ? r.type : "other",
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    addedById: r.addedById ?? "",
    addedAt: r.addedAt,
    modifiedAt: r.addedAt,
    folderLinkId: null,
    googleFileId: null,
    googleOwner: null,
    hidden: false,
    unavailable: null,
    content: contentOf(r.contentStatus),
    // Nell'elenco il server dà solo la prima frase; il riassunto intero sta nel dettaglio.
    summary: r.summaryLine,
    ocr: r.contentOcr === "full" || r.contentOcr === "partial",
    ocrPartial: r.contentOcr === "partial",
    opens90d: r.opens90d,
    lastOpenedAt: r.lastOpenedAt,
    summaryLine: r.summaryLine,
    folder: null,
    hiddenBy: null,
    // `retry` lo calcola il server (`drive.manage` su `no_text` o `error`);
    // la pagina offre «Retry» solo su `error`, come il prototipo (decisione C(a)).
    permissions: r.permissions,
  };
}

async function rowsOf(items: ServerDriveFileRow[]): Promise<DriveFileRow[]> {
  const codes = items.some((r) => r.projectCode === null) ? await projectCodes() : null;
  return items.map((r) => rowOf(r, codes));
}

/** Una lettura che per «non si vede» (403/404) dà `fallback`. */
async function orNone<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return fallback;
    throw error;
  }
}

/** Gli errori di una scrittura con i nomi del prototipo. */
async function write<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) throw new Error("not_found");
      if (error.status === 403) throw new Error("forbidden");
      if (error.status === 400) throw new Error("invalid: input");
    }
    throw error;
  }
}

type ListFilters = Omit<DriveFilters, "sort" | "hidden"> & { sort?: DriveFilters["sort"]; q?: string };

/** Le righe, e per ognuna il passaggio trovato per contenuto (testo puro, al più 300 caratteri; `null` per nome o codice). */
async function listFilesWithSnippets(filters: ListFilters) {
  const opts = { type: filters.type, addedById: filters.addedById, q: filters.q, sort: filters.sort };
  const page = await orNone(
    () => (filters.projectId ? appClient().drive.list(filters.projectId, opts) : appClient().drive.listAll(opts)),
    { items: [] },
  );
  const items = page.items as ServerDriveFileRow[];
  return { rows: await rowsOf(items), snippets: items.map((r) => r.snippet ?? null) };
}

async function listFiles(filters: ListFilters) {
  return (await listFilesWithSnippets(filters)).rows;
}

/** L'elenco: di un progetto o di tutti quelli di cui si è membri. Nascosti e Google non esistono qui. */
const listDriveFiles: Drive["listDriveFiles"] = async (filters) => {
  if (filters.hidden === true || filters.source === "google") return [];
  return listFiles(filters);
};

/** Il dettaglio, per id o per codice (`?file=AUD-F3`); `null` se non si vede. */
const getDriveFile: Drive["getDriveFile"] = async (ref) => {
  let id = ref;
  if (!UUID.test(ref)) {
    if (!DRIVE_CODE_RE.test(ref.toUpperCase())) return null;
    const where = await orNone(() => appClient().drive.resolveCode(ref), null);
    if (!where) return null;
    id = where.fileId;
  }
  const d = await orNone(() => appClient().drive.get(id), null);
  if (!d) return null;
  const [row] = await rowsOf([d as unknown as ServerDriveFileRow]);
  const detail: DriveFileDetail = {
    ...row!,
    summary: d.summary ?? row!.summaryLine,
    opensTotal: d.opensTotal,
    history:
      d.history?.map((h) => ({
        fileId: d.id,
        personId: h.personId,
        at: h.at,
        via: h.via === "preview" ? "preview" : "download",
      })) ?? null,
  };
  return detail;
};

/** La ricerca: per nome, codice e contenuto (F3, col passaggio del server); nessun file fuori dai progetti. */
const searchDrive: Drive["searchDrive"] = async (q, scope: DriveSearchScope = {}) => {
  const query = q.trim();
  if (query.length < MIN_QUERY || scope.source === "google") return { files: [], outside: [] };
  const { rows, snippets } = await listFilesWithSnippets({ ...scope, q: query });
  return { files: rows.map((file, i) => ({ file, passage: snippets[i] ?? null })), outside: [] };
};

const deleteDriveFile: Drive["deleteDriveFile"] = async (id) => {
  await write(() => appClient().drive.remove(id));
};

/**
 * Aprire un file, che il server conta. Sul desktop anteprima e download sono
 * un salvataggio dal main (`api:download`, sul solo percorso del download:
 * niente URL firmato aperto fuori); sul web l'anteprima è la rotta `preview`
 * in una scheda nuova (inline per pdf, immagini e testo), il download un
 * iframe. `counted` non si sa (lo decide il server): vero se si è aperto.
 */
const recordOpen: Drive["recordOpen"] = async (fileId, via) => {
  if (via === "google") throw new Error("invalid: google");
  const client = appClient();
  if (via === "preview" && !window.stubwise?.api?.download) {
    // Con `noopener` `window.open` dà sempre null: non dice se s'è aperta.
    window.open(client.drive.previewPath(fileId), "_blank", "noopener");
    return { counted: true };
  }
  const result = await downloadByPath(client.drive.downloadPath(fileId));
  if (result.ok) return { counted: true };
  if (result.reason === "canceled") return { counted: false };
  throw new Error(result.reason === "not_found" ? "not_found" : result.reason);
};

// --- caricare ---------------------------------------------------------------------

/** L'esito di un caricamento, prima di leggerne la riga. */
type Sent =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "canceled" | "storage_off" | "failed" };

/**
 * Sul desktop il main apre il file scelto (`files.register`: un token, mai il
 * percorso nel renderer) e lo manda in streaming col bearer (`api.upload`);
 * l'avanzamento arriva da `files.onProgress`, l'annullamento è `files.cancel`.
 */
async function sendFromMain(path: string, file: File, options: DriveUploadOptions): Promise<Sent> {
  const bridge = window.stubwise!;
  const registered = await bridge.files!.register(file);
  if (!registered.ok) return { ok: false, reason: registered.reason === "too_large" ? "too_large" : "failed" };
  // Annullato mentre il main apriva il file: non si parte (il token scade da solo).
  if (options.signal?.aborted) return { ok: false, reason: "canceled" };
  const uploadId = crypto.randomUUID();
  const stop = bridge.files!.onProgress((p) => {
    if (p.uploadId === uploadId) options.onProgress?.(p.sent);
  });
  const abort = () => void bridge.files!.cancel(uploadId);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const out = await bridge.api!.upload!({ grant: registered.grant, path, uploadId });
    if (out.ok) return { ok: true, body: out.body };
    if (out.reason === "too_large") return { ok: false, reason: "too_large" };
    if (out.reason === "canceled") return { ok: false, reason: "canceled" };
    if (out.code === "storage_not_configured") return { ok: false, reason: "storage_off" };
    return { ok: false, reason: "failed" };
  } finally {
    stop();
    options.signal?.removeEventListener("abort", abort);
  }
}

/** Sul web un XHR col FormData (il campo `file`) e il cookie: è l'unico modo di avere l'avanzamento vero. */
function sendFromBrowser(path: string, file: File, options: DriveUploadOptions): Promise<Sent> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(Math.min(e.loaded, file.size));
    };
    const done = (sent: Sent) => {
      options.signal?.removeEventListener("abort", abort);
      resolve(sent);
    };
    const abort = () => xhr.abort();
    xhr.onabort = () => done({ ok: false, reason: "canceled" });
    xhr.onerror = () => done({ ok: false, reason: "failed" });
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      const code = (body as { code?: unknown } | null)?.code;
      if (xhr.status >= 200 && xhr.status < 300) return done({ ok: true, body });
      if (xhr.status === 413 || code === "file_too_large") return done({ ok: false, reason: "too_large" });
      if (code === "storage_not_configured") return done({ ok: false, reason: "storage_off" });
      done({ ok: false, reason: "failed" });
    };
    if (options.signal?.aborted) return done({ ok: false, reason: "canceled" });
    options.signal?.addEventListener("abort", abort, { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/** Quanti caricamenti alla volta per finestra (orchestratrice, 11 nov 2026): gli altri in coda. */
export const DRIVE_UPLOAD_CONCURRENCY = 3;

let active = 0;
const waiting: (() => void)[] = [];

/**
 * Un posto fra i caricamenti di questa finestra (un renderer = una finestra):
 * `null` se annullato mentre aspettava. Chi lo prende lo rende con `release`.
 */
function takeSlot(signal: AbortSignal | undefined): Promise<(() => void) | null> {
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  if (signal?.aborted) return Promise.resolve(null);
  if (active < DRIVE_UPLOAD_CONCURRENCY) {
    active += 1;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => {
    const go = () => {
      signal?.removeEventListener("abort", drop);
      active += 1;
      resolve(release);
    };
    const drop = () => {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
      resolve(null);
    };
    waiting.push(go);
    signal?.addEventListener("abort", drop, { once: true });
  });
}

/**
 * Carica dei file nel Drive di un progetto (al più 3 alla volta per finestra), ciascuno col suo
 * esito: oltre 100 MB `too_large` (senza partire); un nome già nel progetto lo
 * rinomina il server («(2)»). Gli errori come nel prototipo: archiviazione
 * spenta `invalid: storage_off`, annullato `canceled`, il resto `failed`.
 */
const uploadFiles: Drive["uploadFiles"] = async (projectId, files, options: DriveUploadOptions = {}) => {
  const path = `/api/projects/${encodeURIComponent(projectId)}/drive/files`; // la rotta di `client.drive.upload`
  const results: DriveUploadResult[] = [];
  for (const input of files as DriveUploadInput[]) {
    if (input.sizeBytes > DRIVE_FILE_MAX_BYTES) {
      results.push({ name: input.name, file: null, error: "too_large" });
      continue;
    }
    if (!input.file) throw new Error("failed");
    const fromMain = window.stubwise?.files && window.stubwise.api?.upload;
    // In coda finché non c'è posto: il main non apre il file prima.
    const release = await takeSlot(options.signal);
    if (!release) throw new Error("canceled");
    let sent: Sent;
    try {
      sent = fromMain ? await sendFromMain(path, input.file, options) : await sendFromBrowser(path, input.file, options);
    } finally {
      release();
    }
    if (!sent.ok) {
      if (sent.reason === "too_large") {
        results.push({ name: input.name, file: null, error: "too_large" });
        continue;
      }
      throw new Error(sent.reason === "storage_off" ? "invalid: storage_off" : sent.reason);
    }
    const parsed = driveUploadResultSchema.safeParse(sent.body);
    if (!parsed.success) throw new Error("failed");
    const [row] = await rowsOf([parsed.data.file as ServerDriveFileRow]);
    results.push({ name: input.name, file: row!, error: null });
  }
  return results;
};

/**
 * «Save to Drive» da un allegato della Chat (`POST …/save-to-drive`): la
 * copia la fa il server. In un canale di progetto il progetto non si manda
 * (è il suo: un altro sarebbe `project_mismatch`); in un DM o in un generale sì.
 */
const saveAttachmentToDrive: Drive["saveAttachmentToDrive"] = async (attachmentId, input, target) => {
  try {
    const out = await write(() =>
      appClient().drive.saveFromChat(attachmentId, target.channelProject ? {} : { projectId: target.projectId }),
    );
    const [row] = await rowsOf([out.file as ServerDriveFileRow]);
    return { name: input.name, file: row!, error: null };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 413 || error.code === "file_too_large")) {
      return { name: input.name, file: null, error: "too_large" };
    }
    throw error;
  }
};

/**
 * «Retry» l'estrazione (`drive.manage`, F3.4): il server rimette il file in
 * coda e dà la riga, già in lettura. 409 `not_retryable` (lo stato non è
 * `no_text` né `error`) ha il nome del prototipo.
 */
const retryExtraction: Drive["retryExtraction"] = async (id) => {
  const row = await write(async () => {
    try {
      return await appClient().drive.retry(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) throw new Error("invalid: content not in error");
      throw error;
    }
  });
  const [out] = await rowsOf([row as unknown as ServerDriveFileRow]);
  return out!;
};

export const driveFunctions: Partial<Drive> = {
  listDriveFiles,
  getDriveFile,
  searchDrive,
  deleteDriveFile,
  recordOpen,
  uploadFiles,
  saveAttachmentToDrive,
  retryExtraction,
};

export const drive: Drive = partialNamespace<Drive>("drive", driveFunctions);
