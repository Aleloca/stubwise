import { endsSession } from "@stubwise/shared";
import type { ApiProxyDeps } from "./apiProxy";

// Il download di un allegato dal desktop (area 4, fetta 4; chiude anche la
// voce Trasversali del registro per gli allegati dei ticket). Il token sta nel
// main: il main chiede il download COL bearer e `redirect: "manual"`, pretende
// un 302 con `Location`, e consegna quell'URL firmato al download di Electron
// (`webContents.downloadURL`), che lo chiede SENZA intestazioni — la firma
// basta, il bearer non va mai allo storage. Né il token né l'URL firmato né i
// byte passano dal renderer. Qui solo la logica pura (testata); la colla con
// Electron (`will-download`, la finestra «Salva») sta in `index.ts`.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DOWNLOAD_PATHS = [
  new RegExp(`^/api/chat/attachments/${UUID}/download$`, "i"),
  new RegExp(`^/api/attachments/${UUID}/download$`, "i"),
  // Area 5, fetta 2: un file del Drive. Sul desktop anche l'«anteprima» è un
  // salvataggio (decisione dell'orchestratrice): la rotta `preview` non c'è.
  new RegExp(`^/api/drive/files/${UUID}/download$`, "i"),
];

/** Solo il download di un allegato della Chat o di un ticket, o di un file del Drive: nient'altro passa da `api:download`. */
export function isAllowedDownloadPath(path: unknown): path is string {
  return typeof path === "string" && DOWNLOAD_PATHS.some((re) => re.test(path));
}

/** Dove può portare il 302: https sempre; http solo se l'istanza stessa è http (sviluppo locale). */
export function isAllowedDownloadLocation(location: string, instanceUrl: string): boolean {
  let target: URL;
  let instance: URL;
  try {
    target = new URL(location);
    instance = new URL(instanceUrl);
  } catch {
    return false;
  }
  if (target.protocol === "https:") return true;
  return target.protocol === "http:" && instance.protocol === "http:";
}

/** L'esito di `api:download` per il renderer: mai un percorso, mai l'URL firmato. */
export type DownloadResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unauthenticated" | "not_found" | "failed" | "canceled" };

export type DownloadTarget =
  | { ok: true; url: string }
  | { ok: false; reason: "invalid" | "unauthenticated" | "not_found" | "failed" };

/** `api:download`: il percorso, il bearer, il 302; l'URL firmato o il perché no. */
export async function resolveDownload(raw: unknown, deps: ApiProxyDeps): Promise<DownloadTarget> {
  const path = (raw as { path?: unknown } | null)?.path;
  if (!isAllowedDownloadPath(path)) return { ok: false, reason: "invalid" };
  const base = deps.instanceUrl();
  if (!base) return { ok: false, reason: "invalid" };
  const token = deps.token();
  if (!token) return { ok: false, reason: "unauthenticated" };
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (res.status === 401) {
    const code = await res
      .json()
      .then((b: unknown) => {
        const code = (b as { code?: unknown } | null)?.code;
        return typeof code === "string" ? code : undefined;
      })
      .catch(() => undefined);
    if (endsSession(path, 401, code)) deps.onUnauthorized(token);
    return { ok: false, reason: "unauthenticated" };
  }
  if (res.status === 404 || res.status === 403) return { ok: false, reason: "not_found" };
  const location = res.headers.get("location");
  // Solo un 302, come la rotta (un altro reindirizzamento non è il download firmato).
  if (res.status !== 302 || !location) return { ok: false, reason: "failed" };
  let url: string;
  try {
    url = new URL(location, base).href;
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!isAllowedDownloadLocation(url, base)) return { ok: false, reason: "failed" };
  return { ok: true, url };
}

/** Un URL nella forma che usa Electron (`new URL().href`): la query scritta in due modi è la stessa. */
function normalizedUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * I download chiesti con `api:download` e non ancora partiti, per URL firmato
 * normalizzato: una CODA per URL (due richieste dello stesso file nello
 * stesso secondo hanno ognuna il suo esito). `add` restituisce il ritiro: il
 * timer di chi aspetta lo chiama, e sa se c'era ancora.
 */
export function createPendingDownloads<T>() {
  const queues = new Map<string, T[]>();
  return {
    add(url: string, item: T): () => boolean {
      const key = normalizedUrl(url);
      queues.set(key, [...(queues.get(key) ?? []), item]);
      return () => {
        const queue = queues.get(key) ?? [];
        const index = queue.indexOf(item);
        if (index === -1) return false;
        queue.splice(index, 1);
        if (queue.length === 0) queues.delete(key);
        return true;
      };
    },
    has(url: string): boolean {
      return (queues.get(normalizedUrl(url))?.length ?? 0) > 0;
    },
    take(url: string): T | undefined {
      const key = normalizedUrl(url);
      const queue = queues.get(key);
      const item = queue?.shift();
      if (queue && queue.length === 0) queues.delete(key);
      return item;
    },
  };
}

/**
 * Chi passa da `will-download`:
 * - `requested`: un URL firmato chiesto con `api:download` (in attesa);
 * - `local`: un `blob:` o un `data:` della finestra dell'app — i file che il
 *   renderer prepara da sé (i codici di backup del secondo fattore, la guida
 *   dell'SDK): si salvano, sempre col «Salva»;
 * - `reject`: tutto il resto (un http(s) non chiesto, un blob da fuori, altri schemi).
 */
export function downloadDecision(
  url: string,
  isPending: (url: string) => boolean,
  fromAppContents: boolean,
): "requested" | "local" | "reject" {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return "reject";
  }
  if (protocol === "blob:" || protocol === "data:") return fromAppContents ? "local" : "reject";
  if ((protocol === "https:" || protocol === "http:") && isPending(url)) return "requested";
  return "reject";
}

/**
 * Il nome con cui si propone di salvare: quello del Content-Disposition (lo
 * legge Electron), ridotto al solo nome — mai un percorso dal server — e senza
 * caratteri di controllo.
 */
export function safeDownloadName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base === "" || base === "." || base === ".." ? "download" : base;
}
