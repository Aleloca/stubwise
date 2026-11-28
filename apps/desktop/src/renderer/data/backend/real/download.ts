import type { AttachmentDownloadResult } from "../../types";

/** Quanto resta l'iframe nascosto del download sul web: il browser ha già preso il file. */
const FRAME_LIFETIME_MS = 60_000;

/**
 * Il download di un allegato dal suo percorso dell'API. Sul desktop lo fa il
 * main (`api:download`: col token, segue il 302 e chiede dove salvare): qui
 * passa solo il percorso. Sul web prima si CHIEDE se c'è — la stessa rotta con
 * `redirect: "manual"`: un 302 (opaco) vuol dire sì — e poi un iframe nascosto
 * lo fa partire: la pagina resta dov'è (un 404 aperto come link porterebbe la
 * SPA su un JSON grezzo, e le bozze andrebbero perse). Il cookie di sessione
 * basta; il file arriva con `Content-Disposition: attachment`.
 */
export async function downloadByPath(path: string): Promise<AttachmentDownloadResult> {
  const main = window.stubwise?.api?.download;
  if (main) return main(path);
  let res: Response;
  try {
    res = await globalThis.fetch(path, { credentials: "include", redirect: "manual" });
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (res.type !== "opaqueredirect" && res.status !== 302) {
    if (res.status === 401) return { ok: false, reason: "unauthenticated" };
    if (res.status === 404 || res.status === 403) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "failed" };
  }
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = path;
  document.body.appendChild(frame);
  setTimeout(() => frame.remove(), FRAME_LIFETIME_MS);
  return { ok: true };
}

/** Salva un file arrivato al renderer (un `Blob` già letto): un link `download`, poi via. */
export function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), FRAME_LIFETIME_MS);
}

/** Il nome del file dal `Content-Disposition`, se c'è. */
export function fileNameOf(res: Response, fallback: string): string {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "");
  if (!m) return fallback;
  // M2: un nome malformato (`%E0%A4%A`) non fa fallire il download.
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return fallback;
  }
}
