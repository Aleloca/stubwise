import { ApiError } from "@stubwise/api-client";
import {
  DRIVE_CODE_RE,
  DRIVE_FILE_TYPES,
  driveCodeResolutionSchema,
  driveFileDetailSchema,
  driveFileListSchema,
  driveUploadResultSchema,
  DRIVE_FILE_MAX_BYTES,
  type DriveFileRow as ServerDriveFileRow,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
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

// Il Drive nella build app (area 5, fetta 2): i file CARICATI «come oggi».
// Google (account, cartelle, riferimenti, file fuori dai progetti) è
// dell'area 6, il contenuto (testo, riassunto, OCR, «Riprova») della F3:
// qui non ci sono. Le aperture le conta il server quando si apre davvero
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

/** Una riga del server nella forma del prototipo: un caricato, pronto, senza riassunto finché non c'è la F3. */
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
    content: "ready",
    summary: r.summaryLine,
    ocr: false,
    opens90d: r.opens90d,
    lastOpenedAt: r.lastOpenedAt,
    summaryLine: r.summaryLine,
    folder: null,
    hiddenBy: null,
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

async function listFiles(filters: Omit<DriveFilters, "sort" | "hidden"> & { sort?: DriveFilters["sort"]; q?: string }) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.addedById) params.set("addedById", filters.addedById);
  if (filters.q) params.set("q", filters.q);
  if (filters.sort) params.set("sort", filters.sort);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const path = filters.projectId
    ? `/api/projects/${encodeURIComponent(filters.projectId)}/drive/files${qs}`
    : `/api/drive/files${qs}`;
  const page = await orNone(() => appClient().request("GET", path, undefined, driveFileListSchema), { items: [] });
  return rowsOf(page.items as ServerDriveFileRow[]);
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
    const where = await orNone(
      () => appClient().request("GET", `/api/drive/codes/${encodeURIComponent(ref)}`, undefined, driveCodeResolutionSchema),
      null,
    );
    if (!where) return null;
    id = where.fileId;
  }
  const d = await orNone(
    () => appClient().request("GET", `/api/drive/files/${encodeURIComponent(id)}`, undefined, driveFileDetailSchema),
    null,
  );
  if (!d) return null;
  const [row] = await rowsOf([d as ServerDriveFileRow]);
  const detail: DriveFileDetail = {
    ...row!,
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

/** La ricerca: per nome e codice (il contenuto arriva con la F3), senza passaggi né file fuori dai progetti. */
const searchDrive: Drive["searchDrive"] = async (q, scope: DriveSearchScope = {}) => {
  const query = q.trim();
  if (query.length < MIN_QUERY || scope.source === "google") return { files: [], outside: [] };
  const rows = await listFiles({ ...scope, q: query });
  return { files: rows.map((file) => ({ file, passage: null })), outside: [] };
};

const deleteDriveFile: Drive["deleteDriveFile"] = async (id) => {
  await write(() => appClient().request("DELETE", `/api/drive/files/${encodeURIComponent(id)}`));
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
  const base = `/api/drive/files/${encodeURIComponent(fileId)}`;
  if (via === "preview" && !window.stubwise?.api?.download) {
    // Con `noopener` `window.open` dà sempre null: non dice se s'è aperta.
    window.open(`${base}/preview`, "_blank", "noopener");
    return { counted: true };
  }
  const result = await downloadByPath(`${base}/download`);
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

/**
 * Carica dei file nel Drive di un progetto, uno alla volta, ciascuno col suo
 * esito: oltre 100 MB `too_large` (senza partire); un nome già nel progetto lo
 * rinomina il server («(2)»). Gli errori come nel prototipo: archiviazione
 * spenta `invalid: storage_off`, annullato `canceled`, il resto `failed`.
 */
const uploadFiles: Drive["uploadFiles"] = async (projectId, files, options: DriveUploadOptions = {}) => {
  const path = `/api/projects/${encodeURIComponent(projectId)}/drive/files`;
  const results: DriveUploadResult[] = [];
  for (const input of files as DriveUploadInput[]) {
    if (input.sizeBytes > DRIVE_FILE_MAX_BYTES) {
      results.push({ name: input.name, file: null, error: "too_large" });
      continue;
    }
    if (!input.file) throw new Error("failed");
    const fromMain = window.stubwise?.files && window.stubwise.api?.upload;
    const sent = fromMain ? await sendFromMain(path, input.file, options) : await sendFromBrowser(path, input.file, options);
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

export const driveFunctions: Partial<Drive> = {
  listDriveFiles,
  getDriveFile,
  searchDrive,
  deleteDriveFile,
  recordOpen,
  uploadFiles,
};

export const drive: Drive = partialNamespace<Drive>("drive", driveFunctions);
