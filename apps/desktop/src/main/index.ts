import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { handleApiRequest, isWebPath } from "./apiProxy";
import { normalizeInstanceUrl, readInstanceUrl, writeInstanceUrl } from "./instance";
import { buildMenuTemplate } from "./menu";
import { hostname as osHostname } from "node:os";
import { authUrlFromArgv, createBrowserLogin, type SessionChange } from "./browserLogin";
import { clearToken, logout, readToken, saveToken } from "./session";
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
// persona (`instance:set`), il login passa dal browser di sistema
// (`session:start-browser-login`, PKCE e `stubwise://`, `browserLogin.ts`), e
// ogni richiesta API passa da qui (`api:request`), che aggiunge il bearer. Un
// 401 cancella il token e lo dice al renderer (`session:changed`).

/** Avvisa ogni finestra del renderer: mai il token, solo l'esito. */
function notifySession(change: SessionChange): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("session:changed", change);
}

const browserLogin = createBrowserLogin({
  instanceUrl: readInstanceUrl,
  openExternal: async (url) => {
    if (isExternalOpenAllowed(url)) await shell.openExternal(url);
  },
  hostname: osHostname,
  saveToken,
  notify: notifySession,
});

/** Un `stubwise://` arrivato all'app: solo `handleAuthUrl` lo legge, e la finestra torna davanti. */
function receiveAuthUrl(url: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  void browserLogin.handleAuthUrl(url);
}

ipcMain.handle("api:request", async (event, raw: unknown) => {
  if (!fromApp(event)) {
    return { status: 400, headers: {}, body: JSON.stringify({ code: "invalid_request" }) };
  }
  return handleApiRequest(raw, {
    instanceUrl: readInstanceUrl,
    token: readToken,
    onUnauthorized: () => {
      clearToken();
      notifySession({ signedIn: false, error: "unauthorized" });
    },
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

// DEPRECATO (9 nov 2026): il login con password dal desktop non esiste più.
// Il canale resta finché la pagina d'ingresso del renderer non passa al
// browser (Task 21), e risponde sempre di usare il browser.
ipcMain.handle("session:login", (event) => {
  if (!fromApp(event)) return { ok: false, code: "invalid_request" };
  return { ok: false, code: "use_browser_login" };
});

ipcMain.handle("session:start-browser-login", async (event) => {
  if (!fromApp(event)) return { ok: false, code: "invalid_request" };
  const started = await browserLogin.start();
  // Lo state resta nel main: al renderer basta sapere che il browser è aperto.
  return started.ok ? { ok: true } : started;
});

ipcMain.handle("session:cancel-browser-login", (event) => {
  if (!fromApp(event)) return { ok: false };
  browserLogin.cancel();
  return { ok: true };
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

// Il protocollo `stubwise://` (login dal browser). In sviluppo l'eseguibile è
// Electron stesso, e lo script va ripassato.
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient("stubwise", process.execPath, [process.argv[1]]);
} else {
  app.setAsDefaultProtocolClient("stubwise");
}

// Una sola istanza: su Windows e Linux l'URL arriva a una SECONDA istanza, che
// lo passa a questa e si chiude.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = authUrlFromArgv(argv);
    if (url) receiveAuthUrl(url);
    else BrowserWindow.getAllWindows()[0]?.focus();
  });
}

// macOS consegna l'URL con `open-url` (anche ad app appena avviata).
app.on("open-url", (event, url) => {
  event.preventDefault();
  void app.whenReady().then(() => receiveAuthUrl(url));
});

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
