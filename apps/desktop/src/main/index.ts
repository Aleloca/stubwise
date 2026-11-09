import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { handleApiRequest, isWebPath } from "./apiProxy";
import { normalizeInstanceUrl, readInstanceUrl, writeInstanceUrl } from "./instance";
import { buildMenuTemplate } from "./menu";
import { clearToken, login, logout, readToken } from "./session";
import {
  isExternalOpenAllowed,
  isNavigationAllowed,
  parseSaveFileRequest,
  safeFileName,
  saveFilterFor,
  withExtension,
  type SaveFileResult,
} from "./security";
import { groundFor, isResolvedTheme, overlayFor, printOnPaper, themeFromDark, windowOptions } from "./window";

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
/** Chi chiede è il renderer dell'app (stessa regola della navigazione), per ogni canale `handle`. */
function fromApp(event: Electron.IpcMainInvokeEvent): boolean {
  const sender = event.senderFrame?.url ?? "";
  return isNavigationAllowed(sender, { devUrl, packagedUrl: pathToFileURL(packagedFile).href });
}

ipcMain.handle("file:save", async (event, raw: unknown): Promise<SaveFileResult> => {
  // Prima chi chiede (solo il renderer dell'app), poi che cosa chiede.
  if (!fromApp(event)) return { saved: false, reason: "invalid" };
  const req = parseSaveFileRequest(raw);
  if (!req) return { saved: false, reason: "invalid" };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { saved: false, reason: "invalid" };
  try {
    const data =
      req.format === "pdf"
        ? await printOnPaper(win, () => event.sender.printToPDF({ printBackground: true, pageSize: "A4" }))
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

// --- server vero (integrazione area 2, fetta 1) ----------------------------------
//
// Il renderer non fa rete e non vede il token: l'istanza la sceglie la
// persona (`instance:set`), il login passa da `mobile-login` col secondo
// fattore (`session:login`), e ogni richiesta API passa da qui
// (`api:request`), che aggiunge il bearer. Un 401 cancella il token.

ipcMain.handle("api:request", async (event, raw: unknown) => {
  if (!fromApp(event)) {
    return { status: 400, headers: {}, body: JSON.stringify({ code: "invalid_request" }) };
  }
  return handleApiRequest(raw, {
    instanceUrl: readInstanceUrl,
    token: readToken,
    onUnauthorized: clearToken,
  });
});

ipcMain.handle("instance:get", (event) => (fromApp(event) ? readInstanceUrl() : null));

ipcMain.handle("instance:set", (event, raw: unknown) => {
  if (!fromApp(event)) return { ok: false };
  const next = normalizeInstanceUrl(raw);
  if (!next) return { ok: false };
  // Un'istanza diversa è un'altra sessione: il token di prima non vale lì.
  if (next !== readInstanceUrl()) clearToken();
  return { ok: true, url: writeInstanceUrl(next) };
});

ipcMain.handle("session:login", async (event, raw: unknown) => {
  if (!fromApp(event)) return { ok: false, code: "invalid_request" };
  return login(raw, { instanceUrl: readInstanceUrl() });
});

ipcMain.handle("session:logout", async (event) => {
  if (!fromApp(event)) return { ok: false };
  await logout({ instanceUrl: readInstanceUrl() });
  return { ok: true };
});

ipcMain.handle("session:status", (event) => {
  if (!fromApp(event)) return { instanceUrl: null, signedIn: false };
  return { instanceUrl: readInstanceUrl(), signedIn: readToken() !== null };
});

/** «Apri nel web»: una pagina dell'istanza nel browser di sistema, mai un altro host. */
ipcMain.handle("open:web", async (event, path: unknown) => {
  if (!fromApp(event) || !isWebPath(path)) return { ok: false };
  const base = readInstanceUrl();
  if (!base) return { ok: false };
  const target = `${base}${path}`;
  if (!isExternalOpenAllowed(target)) return { ok: false };
  await shell.openExternal(target);
  return { ok: true };
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
