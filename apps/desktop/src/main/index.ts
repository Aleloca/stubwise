import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { buildMenuTemplate } from "./menu";
import {
  isExternalOpenAllowed,
  isNavigationAllowed,
  parseSaveFileRequest,
  safeFileName,
  saveFilterFor,
  withExtension,
  type SaveFileResult,
} from "./security";
import { groundFor, isResolvedTheme, overlayFor, themeFromDark, windowOptions } from "./window";

const here = fileURLToPath(new URL(".", import.meta.url));
const devUrl = process.env["ELECTRON_RENDERER_URL"];
const packagedFile = join(here, "../renderer/index.html");

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

  // Nessuna nuova finestra: i link http(s) vanno al browser di sistema (mai
  // dentro l'app), ogni altro schema è scartato.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenAllowed(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // La finestra non esce mai dal renderer: né dal dev server né dal file impacchettato.
  win.webContents.on("will-navigate", (event, url) => {
    const packagedUrl = pathToFileURL(packagedFile).href;
    if (!isNavigationAllowed(url, { devUrl, packagedUrl })) event.preventDefault();
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(packagedFile);
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

/**
 * «Salva questo file» (area 11a, decisione 8): l'unico canale nuovo. Viene
 * solo dal renderer dell'app (stessa regola della navigazione: si guarda
 * per primo), e la richiesta si valida subito dopo (`parseSaveFileRequest`). Il PDF lo stampa la
 * finestra che chiede (la vista di stampa è montata in quel momento); il
 * Word arriva coi suoi byte. Si scrive SOLO dove la persona sceglie nella
 * finestra di salvataggio; il percorso non torna mai al renderer.
 */
ipcMain.handle("file:save", async (event, raw: unknown): Promise<SaveFileResult> => {
  // Prima chi chiede (solo il renderer dell'app), poi che cosa chiede.
  const sender = event.senderFrame?.url ?? "";
  if (!isNavigationAllowed(sender, { devUrl, packagedUrl: pathToFileURL(packagedFile).href })) {
    return { saved: false, reason: "invalid" };
  }
  const req = parseSaveFileRequest(raw);
  if (!req) return { saved: false, reason: "invalid" };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { saved: false, reason: "invalid" };
  try {
    const data =
      req.format === "pdf"
        ? await event.sender.printToPDF({ printBackground: true, pageSize: "A4" })
        : req.data;
    const choice = await dialog.showSaveDialog(win, {
      defaultPath: join(app.getPath("downloads"), safeFileName(req.name, req.format)),
      filters: [saveFilterFor(req.format)],
    });
    if (choice.canceled || !choice.filePath) return { saved: false, reason: "canceled" };
    await writeFile(withExtension(choice.filePath, req.format), data);
    return { saved: true };
  } catch {
    return { saved: false, reason: "failed" };
  }
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
