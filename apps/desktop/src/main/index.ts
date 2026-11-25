import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keyFingerprint, openDeviceSeal } from "@stubwise/vault-crypto";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  powerMonitor,
  session,
  shell,
} from "electron";
import {
  createPendingDownloads,
  downloadDecision,
  resolveDownload,
  safeDownloadName,
  type DownloadResult,
} from "./apiDownload";
import { handleApiRequest, isWebPath } from "./apiProxy";
import {
  createActiveUploads,
  createUploadTokens,
  uploadFile,
  type UploadResult,
} from "./apiUpload";
import { createStreamRegistry } from "./apiStream";
import { normalizeInstanceUrl, readInstanceUrl, writeInstanceUrl } from "./instance";
import { buildMenuTemplate } from "./menu";
import { hostname as osHostname } from "node:os";
import {
  authUrlFromArgv,
  createBrowserLogin,
  deviceNameFrom,
  type SessionChange,
} from "./browserLogin";
import { createGoogleReturn } from "./googleReturn";
import {
  clearToken,
  logout,
  onSessionMismatch,
  readPatId,
  readToken,
  replaceToken,
} from "./session";
import {
  codesignVerifier,
  createKeyHelper,
  helperPath,
  helperRequirement,
  spawnRunner,
} from "./keyHelper";
import {
  deviceAgreement,
  forgetDevice,
  generateDeviceKey,
  readDevice,
  saveDevice,
  setKeyDeleter,
} from "./vaultDevice";
import { registerVaultIpc } from "./vaultIpc";
import { chooseClipboard, electronClipboard, helperClipboard } from "./vaultClipboard";
import { createVaultLock } from "./vaultLock";
import { createVaultOps } from "./vaultOps";
import { createVaultPairing } from "./vaultPairing";
import { createVaultRemote } from "./vaultRemote";
import {
  isExternalOpenAllowed,
  isNavigationAllowed,
  refusedDebugSwitch,
  rendererDevUrl,
  webPreferencesFor,
  parseSaveFileRequest,
  safeFileName,
  saveFilterFor,
  withExtension,
  type SaveFileResult,
} from "./security";
import {
  groundFor,
  isResolvedTheme,
  overlayFor,
  printOnPaper,
  themeFromDark,
  windowOptions,
} from "./window";

const here = fileURLToPath(new URL(".", import.meta.url));
// C2: nel pacchetto niente debug remoto di Chromium; si esce subito, prima di
// ogni finestra (`exit`, non `quit`: nessun evento di chiusura da aspettare).
const debugSwitch = refusedDebugSwitch({
  isPackaged: app.isPackaged,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
});
if (debugSwitch) {
  console.error(`stubwise: --${debugSwitch} non è ammesso nell'app impacchettata`);
  app.exit(1);
}

// C1: nel pacchetto nessun dev server, qualunque sia l'env.
const devUrl = rendererDevUrl({ isPackaged: app.isPackaged, env: process.env });
const packagedFile = join(here, "../renderer/index.html");

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    ...windowOptions(process.platform, themeFromDark(nativeTheme.shouldUseDarkColors)),
    webPreferences: webPreferencesFor({
      isPackaged: app.isPackaged,
      preload: join(here, "../preload/index.cjs"),
    }),
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

  // I file scelti e i caricamenti in corso di questa finestra finiscono con
  // lei, e con la pagina: un ricaricamento (non un cambio di hash) o un
  // renderer caduto non li erediterebbe mai.
  const owner = win.webContents.id;
  const dropUploads = () => {
    void uploadTokens.dropOwner(owner);
    uploads.dropOwner(owner);
  };
  win.webContents.once("destroyed", dropUploads);
  win.webContents.on("render-process-gone", dropUploads);
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropUploads();
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
        ? await printOnPaper(win, () =>
            event.sender.printToPDF({ printBackground: true, pageSize: "A4" }),
          )
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

// --- la cassaforte (lotto 10, `docs/plans/2026-11-24-cassaforte-desktop-design.md`) ---
//
// La chiave del dispositivo in `safeStorage` (`vaultDevice`), la privata di
// persona SOLO qui (`vaultLock`), le rotte del PAT desktop (`vaultRemote`),
// l'associazione dal browser (`vaultPairing`, ritorno `stubwise://vault`).
// Il renderer chiede per `vault:*` e riceve esiti, mai la chiave.

/** La sessione desktop di adesso: istanza e PAT (un PAT è di una persona). */
function vaultIdentity() {
  const instanceUrl = readInstanceUrl();
  const patId = readPatId();
  return instanceUrl && patId && readToken() ? { instanceUrl, patId } : null;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

const openAllowed = async (url: string) => {
  if (isExternalOpenAllowed(url)) await shell.openExternal(url);
};

const vaultRemote = createVaultRemote({ instanceUrl: readInstanceUrl, token: readToken });

// I1 (revisione di sicurezza): la chiave del Mac nel Secure Enclave, attraverso
// l'helper firmato con l'app; il Touch ID lo chiede il sistema a ogni uso.
// I2: prima di ogni uso l'helper si verifica (firma del team, sul processo
// avviato); senza Team ID al build non c'è requisito e l'helper non parte.
const helperReq = helperRequirement(__STUBWISE_TEAM_ID__);
const keyHelper = createKeyHelper({
  run: spawnRunner(helperPath(app.getPath("exe")), {
    verify: helperReq ? codesignVerifier(helperReq) : async () => false,
  }),
});
// I1: la frase del Touch ID la fissa l'helper (mai dalla richiesta); quando il
// file del Mac sparisce, si toglie anche la voce del Keychain.
setKeyDeleter((tag) => keyHelper.deleteKey(tag));

/**
 * La cassaforte dal desktop esiste solo nel pacchetto firmato
 * (`STUBWISE_VAULT_DESKTOP=on` al build) e su un Mac col Secure Enclave; senza
 * biometria si apre dal browser (D-1a). L'helper si chiede una volta.
 */
let support: Promise<{ enclave: boolean; biometry: boolean }> | null = null;
function vaultSupported(): Promise<{ enclave: boolean; biometry: boolean }> {
  if (!__STUBWISE_VAULT_DESKTOP__ || !helperReq || process.platform !== "darwin")
    return Promise.resolve({ enclave: false, biometry: false });
  support ??= keyHelper
    .available()
    .then((a) => ({ enclave: a.secureEnclave, biometry: a.biometry }));
  return support;
}

const vault = createVaultLock({
  identity: vaultIdentity,
  store: { read: readDevice, forget: forgetDevice },
  supported: vaultSupported,
  agreement: (device) => deviceAgreement(device, keyHelper),
  fetchSeal: () => vaultRemote.fetchSeal(),
  openSeal: openDeviceSeal,
  forgetRemote: () => vaultRemote.forgetRemote(),
  fingerprint: keyFingerprint,
  onChange: (status) => broadcast("vault:changed", status),
});

const vaultPairing = createVaultPairing({
  identity: vaultIdentity,
  deviceName: () => deviceNameFrom(osHostname()),
  supported: vaultSupported,
  generate: () => generateDeviceKey(keyHelper),
  agreement: (device) => deviceAgreement(device, keyHelper),
  pair: (pub, name) => vaultRemote.pair(pub, name),
  openExternal: openAllowed,
  fetchSeal: () => vaultRemote.fetchSeal(),
  openSeal: openDeviceSeal,
  save: saveDevice,
  // D-1b: la chiave già aperta (col Touch ID, per verificare il sigillo) resta nel main.
  epoch: () => vault.epoch(),
  paired: (key, personKeyId, since) => vault.adopt(key, personKeyId, since),
  fingerprint: keyFingerprint,
});

// Le operazioni con la chiave di persona (a912fbcb8): al renderer la password
// di «Show», esiti e conteggi; «Copy» scrive gli appunti da qui.
const vaultOps = createVaultOps({
  lock: vault,
  request: (method, path, body) => vaultRemote.request(method, path, body),
  // M4: i tipi Concealed/Transient dall'helper dove c'è l'enclave; altrimenti Electron.
  clipboard: chooseClipboard({
    useHelper: async () => (await vaultSupported()).enclave,
    helper: helperClipboard(keyHelper),
    electron: electronClipboard(clipboard),
  }),
});

/**
 * Il ritorno dall'associazione: la cassaforte è già aperta (l'associazione ha
 * verificato il sigillo col Touch ID e passato la chiave con `adopt`), e il
 * renderer riceve solo l'esito.
 */
async function receiveVaultUrl(url: string): Promise<void> {
  const result = await vaultPairing.handleUrl(url);
  broadcast("vault:paired", result);
}

const browserLogin = createBrowserLogin({
  instanceUrl: readInstanceUrl,
  openExternal: openAllowed,
  hostname: osHostname,
  // Il token di prima (un login già fatto) si revoca: un PAT per dispositivo.
  // Il dispositivo della cassaforte era di quel login (§4): si cancella.
  saveToken: (token, patId, instanceUrl) => {
    vault.sessionChanged();
    vaultPairing.cancel();
    void replaceToken(token, patId, { instanceUrl });
  },
  notify: notifySession,
});

// I3: un token scartato perché l'istanza non è la sua (instance.json riscritto)
// chiude la sessione come un cambio d'istanza: cassaforte, associazione, renderer.
onSessionMismatch(() => {
  vault.sessionChanged();
  vaultPairing.cancel();
  browserLogin.cancel();
  notifySession({ signedIn: false });
});

// Lotto 4, §6: il ritorno dal consenso di Google (`stubwise://google`). Al
// renderer va solo `{ state, outcome }`, che conferma `ok` rileggendo le caselle.
const googleReturn = createGoogleReturn({
  notify: (ret) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("google:returned", ret);
  },
});

/**
 * Un `stubwise://` arrivato all'app, e la finestra torna davanti:
 * `stubwise://auth` lo legge `handleAuthUrl`, `stubwise://google`
 * `handleGoogleUrl`. Il resto si ignora.
 */
function receiveAuthUrl(url: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  if (url.startsWith("stubwise://google")) googleReturn.handleGoogleUrl(url);
  else if (url.startsWith("stubwise://vault")) void receiveVaultUrl(url);
  else void browserLogin.handleAuthUrl(url);
}

/** Un 401 di sessione: si chiude, ma una richiesta partita col token di prima non chiude la sessione nuova. */
function onUnauthorized(used: string): void {
  if (readToken() !== used) return;
  // M3: il sigillo prima del token (best-effort: col 401 il server può già rifiutare).
  vault.sessionChanged();
  vaultPairing.cancel();
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
  const target = await resolveDownload(raw, {
    instanceUrl: readInstanceUrl,
    token: readToken,
    onUnauthorized,
  });
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

// --- il caricamento dei file del Drive (area 5, fetta 2) -----------------------------
//
// `files:register`: il preload passa il percorso di un File scelto dall'utente
// (`webUtils.getPathForFile`); il main apre il file una volta sola e restituisce
// un token monouso (mai il percorso). `api:upload`: il main manda in streaming
// quel file alla rotta del Drive (`apiUpload.ts`); il progresso va solo alla
// finestra che chiede (`files:progress`, al più 4 volte al secondo);
// `files:cancel` annulla.

const uploadTokens = createUploadTokens();
// I token scaduti chiudono il descrittore anche se nessuno chiede più niente.
uploadTokens.startSweeper();
const uploads = createActiveUploads();
const PROGRESS_EVERY_MS = 250;

ipcMain.handle("files:register", async (event, raw: unknown) => {
  if (!fromApp(event)) return { ok: false, reason: "invalid" };
  const r = raw as { path?: unknown; mime?: unknown } | null;
  return uploadTokens.register(
    event.sender.id,
    typeof r?.path === "string" ? r.path : "",
    typeof r?.mime === "string" ? r.mime : "",
  );
});

ipcMain.handle("api:upload", async (event, raw: unknown): Promise<UploadResult> => {
  if (!fromApp(event)) return { ok: false, reason: "invalid" };
  const r = raw as { grant?: unknown; path?: unknown; uploadId?: unknown } | null;
  const owner = event.sender.id;
  // Prima l'id e il tetto (il token resta valido finché non scade), poi il file.
  const begun = uploads.begin(owner, r?.uploadId);
  if (!begun.ok) return { ok: false, reason: begun.reason };
  const entry = uploadTokens.take(owner, r?.grant);
  if (!entry) {
    begun.end();
    return { ok: false, reason: "invalid" };
  }
  const uploadId = r!.uploadId as string;
  let last = 0;
  try {
    return await uploadFile(
      entry,
      typeof r?.path === "string" ? r.path : "",
      {
        instanceUrl: readInstanceUrl,
        token: readToken,
        onUnauthorized,
      },
      {
        signal: begun.signal,
        onProgress: (sent, total) => {
          const t = Date.now();
          if (t - last < PROGRESS_EVERY_MS && sent < total) return;
          last = t;
          if (!event.sender.isDestroyed())
            event.sender.send("files:progress", { uploadId, sent, total });
        },
      },
    );
  } finally {
    begun.end();
  }
});

ipcMain.handle("files:cancel", (event, raw: unknown) => {
  if (!fromApp(event)) return false;
  return uploads.cancel(event.sender.id, (raw as { uploadId?: unknown } | null)?.uploadId);
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
    const options = {
      defaultPath: join(app.getPath("downloads"), safeDownloadName(item.getFilename())),
    };
    const chosen = win
      ? dialog.showSaveDialogSync(win, options)
      : dialog.showSaveDialogSync(options);
    if (!chosen) {
      item.cancel();
      settle?.({ ok: false, reason: "canceled" });
      return;
    }
    item.setSavePath(chosen);
    item.once("done", (_e, state) =>
      settle?.(
        state === "completed"
          ? { ok: true }
          : { ok: false, reason: state === "cancelled" ? "canceled" : "failed" },
      ),
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
  // Il corpo serve solo alla bozza di Claude (area 6, F3): lo valida il registro.
  const req = raw as { path?: unknown; body?: unknown };
  streams.open(sender.id, req.path, port1, { body: req.body });
});

ipcMain.handle("instance:get", (event) => (fromApp(event) ? readInstanceUrl() : null));

ipcMain.handle("instance:set", (event, raw: unknown) => {
  if (!fromApp(event)) return { ok: false };
  const next = normalizeInstanceUrl(raw);
  if (!next) return { ok: false };
  // Un'istanza diversa è un'altra sessione: il token di prima non vale lì, e
  // un login dal browser in corso era per l'altra.
  if (next !== readInstanceUrl()) {
    // M3: il sigillo sull'istanza di prima, col suo token, poi il token.
    vault.sessionChanged();
    vaultPairing.cancel();
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

// Lotto 4, §6: il `returnState` del collegamento di una casella Google, che
// il renderer manda al server; il ritorno arriva su `google:returned`.
ipcMain.handle("google:prepare-connect", (event) => {
  if (!fromApp(event)) return { ok: false };
  return { ok: true, ...googleReturn.prepare() };
});

ipcMain.handle("google:cancel-connect", (event) => {
  if (!fromApp(event)) return { ok: false };
  googleReturn.cancel();
  return { ok: true };
});

ipcMain.handle("session:logout", async (event) => {
  if (!fromApp(event)) return { ok: false };
  // Prima il sigillo del Mac (col token ancora valido), poi il PAT (§4–§5).
  if (vaultIdentity()) await vault.forget();
  vaultPairing.cancel();
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
  const template = buildMenuTemplate(process.platform, app.name, send, {
    devTools: !app.isPackaged,
  });
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

registerVaultIpc(ipcMain, { lock: vault, pairing: vaultPairing, ops: vaultOps, fromApp });

// M4: uscendo, la password copiata non resta negli appunti; la privata si dimentica.
app.on("before-quit", () => {
  vault.lock();
  void vaultOps.clearClipboard();
});

void app.whenReady().then(() => {
  // D-2: in stop e a schermo bloccato la privata si dimentica (il dispositivo resta).
  powerMonitor.on("suspend", () => vault.lock());
  powerMonitor.on("lock-screen", () => vault.lock());
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
