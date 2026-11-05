import { contextBridge, ipcRenderer } from "electron";
import type { SaveFileRequest, SaveFileResult } from "../main/security";

type ResolvedTheme = "light" | "dark";
type MenuChannel = "menu:search" | "menu:preferences" | "menu:ask-claude";
const MENU_CHANNELS: readonly MenuChannel[] = [
  "menu:search",
  "menu:preferences",
  "menu:ask-claude",
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
});
