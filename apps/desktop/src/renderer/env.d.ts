/// <reference types="vite/client" />

// Copia dei tipi di `file:save` (`src/main/security.ts`): il tsconfig del
// renderer esclude `src/main`, come per `MenuChannel` (ruling P21).
type StubwiseSaveFileRequest =
  | { format: "pdf"; name: string }
  | { format: "docx"; name: string; data: Uint8Array };
type StubwiseSaveFileResult =
  | { saved: true }
  | { saved: false; reason: "canceled" | "invalid" | "failed" };

// Copia dei tipi di `api:request`, `session:*`, `instance:*` (`src/main/apiProxy.ts`,
// `src/main/session.ts`), per la stessa ragione.
type StubwiseApiRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
};
type StubwiseApiResponse = { status: number; headers: Record<string, string>; body: string | ArrayBuffer };
type StubwiseLoginResult = { ok: true; user: unknown } | { ok: false; code: string };
// `session:changed` (`src/main/browserLogin.ts`): l'esito del login dal browser
// o la sessione scaduta, mai il token.
type StubwiseSessionChange = { signedIn: true; user: unknown } | { signedIn: false; error?: string };

interface Window {
  /** Esposto dal preload; assente quando il renderer gira in un browser normale. */
  stubwise?: {
    platform: string;
    /** Comunica al main il tema risolto (sfondo finestra, overlay su Windows). */
    setTheme?: (resolved: "light" | "dark") => void;
    /** Voci di menu dell'applicazione; restituisce la funzione per disiscriversi. */
    onMenu?: (
      cb: (channel: "menu:search" | "menu:preferences" | "menu:ask-claude" | "menu:undo" | "menu:redo") => void,
    ) => () => void;
    /** Salva un PDF (stampato dal main) o un Word: la finestra di salvataggio, poi l'esito (area 11a). */
    saveFile?: (req: StubwiseSaveFileRequest) => Promise<StubwiseSaveFileResult>;
    /** Le richieste API verso l'istanza, col token aggiunto dal main (build app, integrazione area 2). */
    api?: { request: (req: StubwiseApiRequest) => Promise<StubwiseApiResponse> };
    /** L'indirizzo dell'istanza scelto al primo avvio. */
    instance?: {
      get: () => Promise<string | null>;
      set: (url: string) => Promise<{ ok: boolean; url?: string }>;
    };
    /** Login dal browser di sistema, logout, stato: mai il token. */
    session?: {
      /** @deprecated Il desktop entra dal browser (`startBrowserLogin`): risponde sempre `use_browser_login`. */
      login: (input: { email: string; password: string; code?: string }) => Promise<StubwiseLoginResult>;
      startBrowserLogin: () => Promise<{ ok: true } | { ok: false; code: string }>;
      cancelBrowserLogin: () => Promise<{ ok: boolean }>;
      onChanged: (cb: (change: StubwiseSessionChange) => void) => () => void;
      logout: () => Promise<{ ok: boolean }>;
      status: () => Promise<{ instanceUrl: string | null; signedIn: boolean }>;
    };
    /** Apre una pagina del web vecchio dell'istanza nel browser di sistema. */
    openWeb?: (path: string) => Promise<{ ok: boolean }>;
  };
}

interface ImportMetaEnv {
  /** Il modo della build (`vite.backend.ts`): `prototype` o `app`. */
  readonly VITE_STUBWISE_BUILD?: "prototype" | "app";
}
