import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeTheme, session, shell } from "electron";
import {
  createPendingDownloads,
  downloadDecision,
  resolveDownload,
  safeDownloadName,
  type DownloadResult,
} from "./apiDownload";
import { handleApiRequest, isWebPath } from "./apiProxy";
import { createStreamRegistry } from "./apiStream";
import { normalizeInstanceUrl, readInstanceUrl, writeInstanceUrl } from "./instance";
import { buildMenuTemplate } from "./menu";
import { hostname as osHostname } from "node:os";
import { authUrlFromArgv, createBrowserLogin, type SessionChange } from "./browserLogin";
import { clearToken, logout, readToken, replaceToken } from "./session";
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
  // Il token di prima (un login già fatto) si revoca: un PAT per dispositivo.
  saveToken: (token, patId) => void replaceToken(token, patId, { instanceUrl: readInstanceUrl() }),
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

/** Un 401 di sessione: si chiude, ma una richiesta partita col token di prima non chiude la sessione nuova. */
function onUnauthorized(used: string): void {
  if (readToken() !== used) return;
  clearToken();
  notifySession({ signedIn: false, error: "unauthorized" });
}

ipcMain.handle("api:request", async (event, raw: unknown) => {
  if (!fromApp(event)) {
    return { status: 400, headers: {}, body: JSON.stringify({ code: "invalid_request" }) };
  }
  return handleApiRequest(raw, { instanceUrl: readInstanceUrl, token: readToken, onUnauthorized });
});

// --- il download degli allegati (area 4, fetta 4) -----------------------------------
//
// `api:download`: il main chiede il download col bearer e pretende un 302
// (`apiDownload.ts`); l'URL firmato lo scarica Electron, senza intestazioni.
// `will-download` chiede SEMPRE dove salvare (niente salvataggio automatico),
// propone il nome del Content-Disposition ridotto al solo nome, e non apre mai
// il file. Un download che non è partito da qui si annulla.

/** I download avviati da `api:download`, in coda per URL firmato: chi aspetta l'esito. */
const pendingDownloads = createPendingDownloads<(result: DownloadResult) => void>();
/** Se Electron non fa partire il download (rete), l'attesa non resta aperta. */
const DOWNLOAD_START_TIMEOUT_MS = 60_000;

ipcMain.handle("api:download", async (event, raw: unknown): Promise<DownloadResult> => {
  if (!fromApp(event)) return { ok: false, reason: "invalid" };
  const target = await resolveDownload(raw, { instanceUrl: readInstanceUrl, token: readToken, onUnauthorized });
  if (!target.ok) return target;
  return new Promise<DownloadResult>((resolve) => {
    const settle = (result: DownloadResult) => {
      clearTimeout(timer);
      resolve(result);
    };
    const withdraw = pendingDownloads.add(target.url, settle);
    // Il timer risolve SEMPRE: se il download non è partito, si ritira e fallisce.
    const timer = setTimeout(() => {
      if (withdraw()) resolve({ ok: false, reason: "failed" });
    }, DOWNLOAD_START_TIMEOUT_MS);
    event.sender.downloadURL(target.url);
  });
});

function installDownloads(): void {
  session.defaultSession.on("will-download", (_event, item, contents) => {
    const url = item.getURLChain()[0] ?? item.getURL();
    // Dalla finestra dell'app: la stessa regola della navigazione.
    const fromAppContents = isNavigationAllowed(contents.getURL(), {
      devUrl,
      packagedUrl: pathToFileURL(packagedFile).href,
    });
    const decision = downloadDecision(url, (u) => pendingDownloads.has(u), fromAppContents);
    // Un http(s) non chiesto con `api:download`, un blob da fuori: si annulla.
    if (decision === "reject") {
      item.cancel();
      return;
    }
    // Un blob/data del renderer (codici di backup, guida SDK): nessuno aspetta l'esito.
    const settle = decision === "requested" ? pendingDownloads.take(url) : undefined;
    const win = BrowserWindow.fromWebContents(contents);
    const options = { defaultPath: join(app.getPath("downloads"), safeDownloadName(item.getFilename())) };
    const chosen = win ? dialog.showSaveDialogSync(win, options) : dialog.showSaveDialogSync(options);
    if (!chosen) {
      item.cancel();
      settle?.({ ok: false, reason: "canceled" });
      return;
    }
    item.setSavePath(chosen);
    item.once("done", (_e, state) =>
      settle?.(state === "completed" ? { ok: true } : { ok: false, reason: state === "cancelled" ? "canceled" : "failed" }),
    );
  });
}

// Lo stream dal vivo delle sessioni (integrazione area 3, fetta 3a,
// `apiStream.ts`): il preload chiede `api:stream-open` col percorso, il main
// apre la connessione col bearer e gli passa una porta di `MessageChannelMain`
// (`api:stream-port`) su cui arrivano i frame. La porta resta nel preload;
// chiuderla ferma lo stream, chiudere la finestra li ferma tutti.
const streams = createStreamRegistry({
  instanceUrl: readInstanceUrl,
  token: readToken,
  onUnauthorized: (used) => {
    if (readToken() !== used) return;
    clearToken();
    notifySession({ signedIn: false, error: "unauthorized" });
  },
});
const watchedWindows = new Set<number>();

ipcMain.on("api:stream-open", (event, raw: unknown) => {
  if (!fromApp(event)) return;
  const id = (raw as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length > 64) return;
  const sender = event.sender;
  if (!watchedWindows.has(sender.id)) {
    watchedWindows.add(sender.id);
    const windowId = sender.id;
    sender.once("destroyed", () => {
      watchedWindows.delete(windowId);
      streams.closeWindow(windowId);
    });
  }
  const { port1, port2 } = new MessageChannelMain();
  sender.postMessage("api:stream-port", { id }, [port2]);
  streams.open(sender.id, (raw as { path?: unknown }).path, port1);
});

ipcMain.handle("instance:get", (event) => (fromApp(event) ? readInstanceUrl() : null));

ipcMain.handle("instance:set", (event, raw: unknown) => {
  if (!fromApp(event)) return { ok: false };
  const next = normalizeInstanceUrl(raw);
  if (!next) return { ok: false };
  // Un'istanza diversa è un'altra sessione: il token di prima non vale lì, e
  // un login dal browser in corso era per l'altra.
  if (next !== readInstanceUrl()) {
    clearToken();
    browserLogin.cancel();
  }
  return { ok: true, url: writeInstanceUrl(next) };
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
  installDownloads();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
