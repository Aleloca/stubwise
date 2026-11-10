import { contextBridge, ipcRenderer } from "electron";
import type { ApiProxyRequest, ApiProxyResponse } from "../main/apiProxy";
import type { StreamPortMessage } from "../main/apiStream";
import type { SaveFileRequest, SaveFileResult } from "../main/security";
import type { SessionChange } from "../main/browserLogin";

type ResolvedTheme = "light" | "dark";
type MenuChannel = "menu:search" | "menu:preferences" | "menu:ask-claude" | "menu:undo" | "menu:redo";
const MENU_CHANNELS: readonly MenuChannel[] = [
  "menu:search",
  "menu:preferences",
  "menu:ask-claude",
  "menu:undo",
  "menu:redo",
];

// Si espone solo `window.stubwise`, con funzioni a scopo stretto: mai
// `ipcRenderer` (né un canale scelto dal renderer).
contextBridge.exposeInMainWorld("stubwise", {
  platform: process.platform,
  setTheme: (resolved: ResolvedTheme): void => {
    ipcRenderer.send("theme:changed", resolved);
  },
  onMenu: (cb: (channel: MenuChannel) => void): (() => void) => {
    const handlers = MENU_CHANNELS.map((channel) => {
      const handler = () => cb(channel);
      ipcRenderer.on(channel, handler);
      return [channel, handler] as const;
    });
    return () => {
      for (const [channel, handler] of handlers) ipcRenderer.removeListener(channel, handler);
    };
  },
  // Esportazione (area 11a): il main valida, stampa il PDF e apre la finestra
  // di salvataggio; qui torna solo l'esito, mai il percorso.
  saveFile: (req: SaveFileRequest): Promise<SaveFileResult> => ipcRenderer.invoke("file:save", req),
  // Il server vero (integrazione area 2, fetta 1). Il token resta nel main:
  // qui passano solo richieste, esiti e l'utente della sessione.
  api: {
    request: (req: ApiProxyRequest): Promise<ApiProxyResponse> => ipcRenderer.invoke("api:request", req),
  },
  /**
   * Lo stream dal vivo di una sessione (area 3, fetta 3a): il main apre
   * `path` (solo `/api/agent-sessions/:uuid/stream?after=n`) e i suoi
   * messaggi arrivano a `onMessage` — `open`, `frame` (il parse di
   * `@stubwise/shared`), `end` (con `fatal`: la ripresa da `?after=` la decide
   * chi chiama). La `MessagePort` resta QUI: `contextBridge` non la passa alla
   * pagina, e consegnargliela con un messaggio della finestra la renderebbe
   * raggiungibile da ogni script della pagina. Restituisce la funzione che chiude lo stream.
   */
  openStream: (path: string, onMessage: (message: StreamPortMessage) => void): (() => void) => {
    const id = crypto.randomUUID();
    let port: MessagePort | null = null;
    let closed = false;
    const onPort = (event: Electron.IpcRendererEvent, msg: { id?: unknown }) => {
      if (msg?.id !== id) return;
      ipcRenderer.removeListener("api:stream-port", onPort);
      port = event.ports[0] ?? null;
      if (!port) return;
      if (closed) {
        port.close();
        return;
      }
      port.onmessage = (e: MessageEvent) => {
        onMessage(e.data as StreamPortMessage);
        if ((e.data as StreamPortMessage).type === "end") port?.close();
      };
      port.start();
    };
    ipcRenderer.on("api:stream-port", onPort);
    ipcRenderer.send("api:stream-open", { id, path });
    return () => {
      closed = true;
      ipcRenderer.removeListener("api:stream-port", onPort);
      port?.close();
    };
  },
  instance: {
    get: (): Promise<string | null> => ipcRenderer.invoke("instance:get"),
    set: (url: string): Promise<{ ok: boolean; url?: string }> => ipcRenderer.invoke("instance:set", url),
  },
  session: {
    /** Apre il login nel browser di sistema; l'esito arriva con `onChanged`. */
    startBrowserLogin: (): Promise<{ ok: true } | { ok: false; code: string }> =>
      ipcRenderer.invoke("session:start-browser-login"),
    cancelBrowserLogin: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("session:cancel-browser-login"),
    /** Login riuscito o fallito, sessione scaduta: mai il token. Restituisce la funzione per disiscriversi. */
    onChanged: (cb: (change: SessionChange) => void): (() => void) => {
      const handler = (_event: unknown, change: SessionChange) => cb(change);
      ipcRenderer.on("session:changed", handler);
      return () => {
        ipcRenderer.removeListener("session:changed", handler);
      };
    },
    logout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("session:logout"),
    status: (): Promise<{ instanceUrl: string | null; signedIn: boolean }> =>
      ipcRenderer.invoke("session:status"),
  },
  openWeb: (path: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("open:web", path),
});
