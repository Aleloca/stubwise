/// <reference types="vite/client" />

// Copia dei tipi di `file:save` (`src/main/security.ts`): il tsconfig del
// renderer esclude `src/main`, come per `MenuChannel` (ruling P21).
type StubwiseSaveFileRequest =
  | { format: "pdf"; name: string }
  | { format: "docx"; name: string; data: Uint8Array };
type StubwiseSaveFileResult =
  | { saved: true }
  | { saved: false; reason: "canceled" | "invalid" | "failed" };

interface Window {
  /** Esposto dal preload; assente quando il renderer gira in un browser normale. */
  stubwise?: {
    platform: string;
    /** Comunica al main il tema risolto (sfondo finestra, overlay su Windows). */
    setTheme?: (resolved: "light" | "dark") => void;
    /** Voci di menu dell'applicazione; restituisce la funzione per disiscriversi. */
    onMenu?: (
      cb: (channel: "menu:search" | "menu:preferences" | "menu:ask-claude") => void,
    ) => () => void;
    /** Salva un PDF (stampato dal main) o un Word: la finestra di salvataggio, poi l'esito (area 11a). */
    saveFile?: (req: StubwiseSaveFileRequest) => Promise<StubwiseSaveFileResult>;
  };
}
