import { contextBridge, ipcRenderer } from "electron";

type ResolvedTheme = "light" | "dark";
type MenuChannel = "menu:search" | "menu:preferences";
const MENU_CHANNELS: readonly MenuChannel[] = ["menu:search", "menu:preferences"];

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
});
