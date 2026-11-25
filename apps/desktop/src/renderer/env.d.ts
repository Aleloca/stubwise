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
type StubwiseApiResponse = {
  status: number;
  headers: Record<string, string>;
  body: string | ArrayBuffer;
};
/** L'esito di un download (`api:download`): mai il percorso scelto, mai l'URL firmato. */
/** Un file scelto dall'utente, aperto dal main: il token, mai il percorso. */
type StubwiseRegisterResult =
  | { ok: true; grant: string; name: string; sizeBytes: number }
  | { ok: false; reason: "invalid" | "too_large" | "too_many" };
type StubwiseUploadResult =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      reason:
        | "invalid"
        | "busy"
        | "unauthenticated"
        | "too_large"
        | "unsupported_type"
        | "failed"
        | "canceled";
      status?: number;
      code?: string;
    };
type StubwiseDownloadResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unauthenticated" | "not_found" | "failed" | "canceled" };
// `session:changed` (`src/main/browserLogin.ts`): l'esito del login dal browser
// o la sessione scaduta, mai il token.
type StubwiseSessionChange =
  | { signedIn: true; user: unknown }
  | { signedIn: false; error?: string };
// La cassaforte del main (`src/main/vaultLock.ts`, lotto 10): stato ed esiti,
// mai la chiave.
type StubwiseVaultStatus = {
  state: "unpaired" | "locked" | "open" | "revoked" | "disabled" | "unsupported";
  fingerprint: string | null;
  /** Il Mac ha Touch ID (D-1a). */
  touchId: boolean;
};
type StubwiseVaultUnlock = { ok: true } | { ok: false; code: string };
type StubwiseVaultFail = { ok: false; code: string };
/** Una persona da confermare (`vault:pending`): mai le copie della chiave. */
type StubwiseVaultPendingPerson = {
  userId: string;
  email: string;
  personKeyId: string;
  status: "pending" | "confirmed";
  createdAt: string;
  device: string | null;
  fingerprint: string;
  credentials: { id: string; service: string; label: string | null }[];
};
// Lo stream dal vivo di una sessione (`api:stream-open`, `src/main/apiStream.ts`,
// area 3 fetta 3a): `frame` è il risultato di `parseAgentStreamFrame` di
// `@stubwise/shared` (solo i frame veri); `end` chiude, e `fatal` dice se
// ripartire da `?after=` ha senso (401/403/404, un 3xx, percorso rifiutato, tetto di 8
// stream per finestra: no; rete, timeout dei ping, rotazione a 1 MB, 5xx: sì).
type StubwiseStreamMessage =
  | { type: "open" }
  | {
      type: "frame";
      messages: import("@stubwise/shared").AgentStreamMessage[];
      lastId: string | null;
      real: boolean;
      invalidSession: boolean;
    }
  | {
      /** Area 4: un frame dello stream di un canale della Chat. */
      type: "chatFrame";
      messages: import("@stubwise/shared").ChatStreamFrameMessage[];
      cursor: string | null;
    }
  /** Area 11, F4: un frame dello stream dal vivo di una pagina di prodotto, com'è. */
  | { type: "productFrame"; raw: string }
  /** Un frame dello stream di una pagina troppo grande, scartato: si rilegge la pagina. */
  | { type: "productFrameDropped" }
  | {
      /** Area 6, F3: un pezzo della bozza di Claude per la Posta. */
      type: "mailDraft";
      event:
        | { type: "delta"; text: string }
        | { type: "done"; text: string; projectId: string | null; used: unknown[] }
        | { type: "error"; code: string };
    }
  /** Lotto 7, §2: i frame della chat dei Docs (`parseDocsChatFrame`, letti nel main). */
  | { type: "docsChat"; events: import("@stubwise/shared").DocsChatStreamEvent[] }
  | {
      type: "end";
      reason:
        | "closed"
        | "network"
        | "timeout"
        | "rotate"
        | "http"
        | "redirect"
        | "unauthorized"
        | "rejected"
        | "limit";
      fatal: boolean;
      status?: number;
      code?: string;
    };

interface Window {
  /** Esposto dal preload; assente quando il renderer gira in un browser normale. */
  stubwise?: {
    platform: string;
    /** Comunica al main il tema risolto (sfondo finestra, overlay su Windows). */
    setTheme?: (resolved: "light" | "dark") => void;
    /** Voci di menu dell'applicazione; restituisce la funzione per disiscriversi. */
    onMenu?: (
      cb: (
        channel: "menu:search" | "menu:preferences" | "menu:ask-claude" | "menu:undo" | "menu:redo",
      ) => void,
    ) => () => void;
    /** Salva un PDF (stampato dal main) o un Word: la finestra di salvataggio, poi l'esito (area 11a). */
    saveFile?: (req: StubwiseSaveFileRequest) => Promise<StubwiseSaveFileResult>;
    /** I file scelti dall'utente (fetta 2 dell'area 5): il main li apre e dà un token monouso. */
    files?: {
      register: (file: File) => Promise<StubwiseRegisterResult>;
      cancel: (uploadId: string) => Promise<boolean>;
      onProgress: (
        fn: (progress: { uploadId: string; sent: number; total: number }) => void,
      ) => () => void;
    };
    /** Le richieste API verso l'istanza, col token aggiunto dal main (build app, integrazione area 2). */
    api?: {
      request: (req: StubwiseApiRequest) => Promise<StubwiseApiResponse>;
      /** Il download di un allegato (fetta 4 della Chat): il main lo scarica e chiede dove salvarlo. */
      download?: (path: string) => Promise<StubwiseDownloadResult>;
      /** Il caricamento di un file del Drive (fetta 2 dell'area 5): il main legge il file in streaming. */
      upload?: (req: {
        grant: string;
        path: string;
        uploadId: string;
      }) => Promise<StubwiseUploadResult>;
    };
    /**
     * Lo stream di una sessione (`/api/agent-sessions/:uuid/stream?after=n`),
     * col token aggiunto dal main; restituisce la funzione che lo chiude.
     */
    openStream?: (
      path: string,
      onMessage: (message: StubwiseStreamMessage) => void,
      /** Il corpo di un POST (la bozza di Claude, la chat dei Docs): lo valida il main. */
      options?: { body?: unknown },
    ) => () => void;
    /** L'indirizzo dell'istanza scelto al primo avvio. */
    instance?: {
      get: () => Promise<string | null>;
      set: (url: string) => Promise<{ ok: boolean; url?: string }>;
    };
    /** Login dal browser di sistema, logout, stato: mai il token. */
    session?: {
      startBrowserLogin: () => Promise<{ ok: true } | { ok: false; code: string }>;
      cancelBrowserLogin: () => Promise<{ ok: boolean }>;
      onChanged: (cb: (change: StubwiseSessionChange) => void) => () => void;
      logout: () => Promise<{ ok: boolean }>;
      status: () => Promise<{ instanceUrl: string | null; signedIn: boolean }>;
    };
    /** Apre una pagina del web vecchio dell'istanza nel browser di sistema. */
    openWeb?: (path: string) => Promise<{ ok: boolean }>;
    vault?: {
      status: () => Promise<StubwiseVaultStatus>;
      unlock: () => Promise<StubwiseVaultUnlock>;
      lock: () => Promise<{ ok: boolean }>;
      forget: () => Promise<{ ok: true; remote: boolean } | { ok: false; code: string }>;
      pairStart: () => Promise<{ ok: true; fingerprint: string } | { ok: false; code: string }>;
      pairCancel: () => Promise<{ ok: boolean }>;
      onChanged: (cb: (status: StubwiseVaultStatus) => void) => () => void;
      onPaired: (cb: (result: StubwiseVaultUnlock) => void) => () => void;
      show: (credentialId: string) => Promise<{ ok: true; password: string } | StubwiseVaultFail>;
      copy: (credentialId: string) => Promise<{ ok: true } | StubwiseVaultFail>;
      share: (
        credentialId: string,
        target: { userId: string } | { roleId: string },
      ) => Promise<{ ok: true; waiting: string[] } | StubwiseVaultFail>;
      removeReader: (
        credentialId: string,
        readerId: string,
      ) => Promise<{ ok: true } | StubwiseVaultFail>;
      pending: () => Promise<{ ok: true; items: StubwiseVaultPendingPerson[] } | StubwiseVaultFail>;
      confirm: (
        personKeyId: string,
      ) => Promise<
        | { ok: true; saved: number; keyChanged: number; notAllowed: number; unopenable: number }
        | StubwiseVaultFail
      >;
      reject: (personKeyId: string) => Promise<{ ok: true } | StubwiseVaultFail>;
      macs: () => Promise<
        | {
            ok: true;
            items: {
              id: string;
              name: string;
              pairedAt: string;
              lastUsedAt: string | null;
              current: boolean;
              fingerprint: string;
            }[];
          }
        | StubwiseVaultFail
      >;
      removeMac: (macId: string) => Promise<{ ok: true } | StubwiseVaultFail>;
      create: (
        projectId: string,
        fields: {
          service: string;
          label: string | null;
          url: string | null;
          username: string | null;
          notes: string | null;
        },
        password: string,
      ) => Promise<{ ok: true; id: string } | StubwiseVaultFail>;
      setPassword: (
        credentialId: string,
        password: string,
      ) => Promise<{ ok: true } | StubwiseVaultFail>;
      serverStatus: () => Promise<
        | {
            ok: true;
            activated: boolean;
            myKey: {
              id: string;
              status: string;
              createdAt: string;
              publicKey: string | null;
            } | null;
          }
        | StubwiseVaultFail
      >;
      mine: () => Promise<
        { ok: true; items: import("@stubwise/shared").CredentialItem[] } | StubwiseVaultFail
      >;
    };
  };
}

interface ImportMetaEnv {
  /** Il modo della build (`vite.backend.ts`): `prototype` o `app`. */
  readonly VITE_STUBWISE_BUILD?: "prototype" | "app";
}
