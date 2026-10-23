import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import { buildMenuTemplate } from "./menu";
import { groundFor, isResolvedTheme, overlayFor, themeFromDark, windowOptions } from "./window";

const here = fileURLToPath(new URL(".", import.meta.url));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    ...windowOptions(process.platform, themeFromDark(nativeTheme.shouldUseDarkColors)),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, "../renderer/index.html"));
  return win;
}

/** Il renderer comunica il tema risolto: sfondo e (su Windows) overlay lo seguono. */
ipcMain.on("theme:changed", (event, theme: unknown) => {
  if (!isResolvedTheme(theme)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setBackgroundColor(groundFor(theme));
  if (process.platform === "win32") win.setTitleBarOverlay(overlayFor(theme));
});

function installMenu(): void {
  const send = (channel: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.webContents.send(channel);
  };
  const template = buildMenuTemplate(process.platform, app.name, send);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

void app.whenReady().then(() => {
  installMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
