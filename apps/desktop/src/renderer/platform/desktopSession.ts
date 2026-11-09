import { isAppBuild } from "../data/build";

// Il ponte del desktop per l'ingresso (integrazione area 2, «Aggiunta del 9
// nov 2026: il login»): l'indirizzo dell'istanza e il login dal browser di
// sistema. Il token non passa mai di qui: il processo main lo tiene, e al
// renderer arrivano solo esiti (`session:changed`).

export type DesktopSessionChange = { signedIn: true; user: unknown } | { signedIn: false; error?: string };

/** La build app dentro Electron (c'è il ponte del login dal browser). */
export function isDesktopApp(): boolean {
  return isAppBuild() && typeof window.stubwise?.session?.startBrowserLogin === "function";
}

export async function readInstanceUrl(): Promise<string | null> {
  return (await window.stubwise?.instance?.get()) ?? null;
}

export async function writeInstanceUrl(url: string): Promise<{ ok: boolean; url?: string }> {
  const bridge = window.stubwise?.instance;
  if (!bridge) return { ok: false };
  return bridge.set(url);
}

export async function startBrowserLogin(): Promise<{ ok: true } | { ok: false; code: string }> {
  const bridge = window.stubwise?.session;
  if (!bridge?.startBrowserLogin) return { ok: false, code: "unavailable" };
  try {
    return await bridge.startBrowserLogin();
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export async function cancelBrowserLogin(): Promise<void> {
  await window.stubwise?.session?.cancelBrowserLogin?.();
}

/** Login riuscito o fallito, sessione scaduta: restituisce la funzione per disiscriversi. */
export function onDesktopSessionChanged(cb: (change: DesktopSessionChange) => void): () => void {
  return window.stubwise?.session?.onChanged?.(cb) ?? (() => {});
}
