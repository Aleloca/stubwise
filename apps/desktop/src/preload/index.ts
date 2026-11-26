import type { CredentialItem } from "@stubwise/shared";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DownloadResult } from "../main/apiDownload";
import type { ApiProxyRequest, ApiProxyResponse } from "../main/apiProxy";
import type { RegisterResult, UploadResult } from "../main/apiUpload";
import type { StreamPortMessage } from "../main/apiStream";
import {
  bridgeAllowed,
  DEV_ORIGIN_ARG,
  type SaveFileRequest,
  type SaveFileResult,
} from "../main/security";
import type { SessionChange } from "../main/browserLogin";
import type { UnlockResult, VaultStatus } from "../main/vaultLock";
import type { PairingCode } from "../main/vaultPairing";
import type { CredentialFields, MacEntry, PendingPersonView, ReaderTarget } from "../main/vaultOps";

type ResolvedTheme = "light" | "dark";
type MenuChannel =
  | "menu:search"
  | "menu:preferences"
  | "menu:ask-claude"
  | "menu:undo"
  | "menu:redo";
const MENU_CHANNELS: readonly MenuChannel[] = [
  "menu:search",
  "menu:preferences",
  "menu:ask-claude",
  "menu:undo",
  "menu:redo",
];

// Si espone solo `window.stubwise`, con funzioni a scopo stretto: mai
// `ipcRenderer` (né un canale scelto dal renderer). E solo alla pagina
// dell'app (`bridgeAllowed`): app://stubwise, o il dev server in sviluppo; una
// pagina file:// o qualunque altra che finisse nella finestra non lo riceve.
const devOrigin = process.argv
  .find((a) => a.startsWith(DEV_ORIGIN_ARG))
  ?.slice(DEV_ORIGIN_ARG.length);
const bridge = {
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
    request: (req: ApiProxyRequest): Promise<ApiProxyResponse> =>
      ipcRenderer.invoke("api:request", req),
    /**
     * Il download di un allegato (area 4, fetta 4): il main lo chiede col
     * token, segue il 302 e apre la finestra «Salva». Qui torna solo l'esito.
     */
    download: (path: string): Promise<DownloadResult> =>
      ipcRenderer.invoke("api:download", { path }),
    /**
     * Il caricamento di un file del Drive (area 5, fetta 2): `grant` viene da
     * `files.register`, il main legge il file in streaming e lo manda alla rotta.
     */
    upload: (req: { grant: string; path: string; uploadId: string }): Promise<UploadResult> =>
      ipcRenderer.invoke("api:upload", req),
  },
  /**
   * I file scelti dall'utente (area 5, fetta 2). `register` prende il percorso
   * di un File vero (`webUtils`: vuoto per un File costruito dalla pagina) e lo
   * dà al main, che apre il file e restituisce un permesso monouso (`grant`): la pagina non vede mai
   * il percorso.
   */
  files: {
    register: (file: File): Promise<RegisterResult> =>
      ipcRenderer.invoke("files:register", {
        path: webUtils.getPathForFile(file),
        mime: file.type,
      }),
    cancel: (uploadId: string): Promise<boolean> =>
      ipcRenderer.invoke("files:cancel", { uploadId }),
    onProgress: (
      fn: (progress: { uploadId: string; sent: number; total: number }) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: { uploadId: string; sent: number; total: number },
      ) => fn(progress);
      ipcRenderer.on("files:progress", handler);
      return () => {
        ipcRenderer.removeListener("files:progress", handler);
      };
    },
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
  openStream: (
    path: string,
    onMessage: (message: StreamPortMessage) => void,
    /** Area 6, F3: il corpo del POST della bozza di Claude (lo valida il main). */
    options: { body?: unknown } = {},
  ): (() => void) => {
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
    ipcRenderer.send("api:stream-open", {
      id,
      path,
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    return () => {
      closed = true;
      ipcRenderer.removeListener("api:stream-port", onPort);
      port?.close();
    };
  },
  instance: {
    get: (): Promise<string | null> => ipcRenderer.invoke("instance:get"),
    set: (url: string): Promise<{ ok: boolean; url?: string }> =>
      ipcRenderer.invoke("instance:set", url),
  },
  session: {
    /** Apre il login nel browser di sistema; l'esito arriva con `onChanged`. */
    startBrowserLogin: (): Promise<{ ok: true } | { ok: false; code: string }> =>
      ipcRenderer.invoke("session:start-browser-login"),
    cancelBrowserLogin: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("session:cancel-browser-login"),
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
  // Lotto 10: la cassaforte del main. Esiti e stato (con l'impronta della
  // chiave del dispositivo), MAI la chiave.
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke("vault:status"),
    unlock: (): Promise<UnlockResult> => ipcRenderer.invoke("vault:unlock"),
    lock: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("vault:lock"),
    /** «Dimentica questo Mac»: `remote: false` se il server non ha risposto. */
    forget: (): Promise<{ ok: true; remote: boolean } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:forget"),
    /** Apre l'associazione nel browser; l'impronta da confrontare. L'esito arriva con `onPaired`. */
    pairStart: (): Promise<{ ok: true; fingerprint: string } | { ok: false; code: PairingCode }> =>
      ipcRenderer.invoke("vault:pair-start"),
    pairCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("vault:pair-cancel"),
    // Le operazioni con la chiave, fatte nel main: «Show» dà la password,
    // «Copy» no (scrive gli appunti il main); il resto esiti e conteggi.
    show: (
      credentialId: string,
    ): Promise<{ ok: true; password: string } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:show", credentialId),
    copy: (credentialId: string): Promise<{ ok: true } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:copy", credentialId),
    share: (
      credentialId: string,
      target: ReaderTarget,
    ): Promise<{ ok: true; waiting: string[] } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:share", credentialId, target),
    removeReader: (
      credentialId: string,
      readerId: string,
    ): Promise<{ ok: true } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:remove-reader", credentialId, readerId),
    pending: (): Promise<{ ok: true; items: PendingPersonView[] } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:pending"),
    confirm: (
      personKeyId: string,
    ): Promise<
      | { ok: true; saved: number; keyChanged: number; notAllowed: number; unopenable: number }
      | { ok: false; code: string }
    > => ipcRenderer.invoke("vault:confirm", personKeyId),
    reject: (personKeyId: string): Promise<{ ok: true } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:reject", personKeyId),
    /** I propri Mac (Preferenze → Security), con `current` e l'impronta intera. */
    macs: (): Promise<{ ok: true; items: MacEntry[] } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:macs"),
    /** Togliere un ALTRO proprio Mac: cassaforte aperta e riconferma (`reauth_required`). */
    removeMac: (macId: string): Promise<{ ok: true } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:remove-mac", macId),
    /** Una credenziale nuova: il main la cifra per i destinatari (non vuole la cassaforte aperta). */
    create: (
      projectId: string,
      fields: CredentialFields,
      password: string,
    ): Promise<{ ok: true; id: string } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:create", projectId, fields, password),
    /** Lo stato della propria chiave (`/api/vault/status`, dal main: review C1). */
    serverStatus: (): Promise<
      | {
          ok: true;
          activated: boolean;
          myKey: { id: string; status: string; createdAt: string; publicKey: string | null } | null;
        }
      | { ok: false; code: string }
    > => ipcRenderer.invoke("vault:server-status"),
    /** «Le mie» credenziali (`/api/vault/credentials`, dal main: review C1). */
    mine: (): Promise<{ ok: true; items: CredentialItem[] } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:mine"),
    /** La password nuova: con la cassaforte aperta, cifrata dal main. */
    setPassword: (
      credentialId: string,
      password: string,
    ): Promise<{ ok: true } | { ok: false; code: string }> =>
      ipcRenderer.invoke("vault:set-password", credentialId, password),
    onChanged: (cb: (status: VaultStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: VaultStatus) => cb(status);
      ipcRenderer.on("vault:changed", handler);
      return () => {
        ipcRenderer.removeListener("vault:changed", handler);
      };
    },
    onPaired: (
      cb: (result: { ok: true } | { ok: false; code: PairingCode }) => void,
    ): (() => void) => {
      const handler = (_event: unknown, result: { ok: true } | { ok: false; code: PairingCode }) =>
        cb(result);
      ipcRenderer.on("vault:paired", handler);
      return () => {
        ipcRenderer.removeListener("vault:paired", handler);
      };
    },
  },
  google: {
    /** Lotto 4, §6: lo state del ritorno dal consenso di Google (`stubwise://google`). */
    prepareConnect: (): Promise<{ ok: true; state: string } | { ok: false }> =>
      ipcRenderer.invoke("google:prepare-connect"),
    cancelConnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("google:cancel-connect"),
    /** Il ritorno: lo state e l'esito, mai altro. Restituisce la funzione per disiscriversi. */
    onReturned: (cb: (ret: { state: string; outcome: string }) => void): (() => void) => {
      const handler = (_event: unknown, ret: { state: string; outcome: string }) => cb(ret);
      ipcRenderer.on("google:returned", handler);
      return () => {
        ipcRenderer.removeListener("google:returned", handler);
      };
    },
  },
};

// Il preload non ha i tipi del DOM: `location` dalla pagina che lo carica.
const href = (globalThis as { location?: { href?: string } }).location?.href ?? "";
if (bridgeAllowed(href, devOrigin)) contextBridge.exposeInMainWorld("stubwise", bridge);
