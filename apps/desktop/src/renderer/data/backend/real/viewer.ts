// `@backend/viewer` nella build app (integrazione area 2, fetta 1), con le
// firme che `viewing.ts` e le superfici usano di `data/viewer.ts`: nessuna
// persona del «vedi come», nessun `Viewer` del prototipo. Chi guarda lo dà
// il server (`AppViewerProvider` in `viewing.ts`, da `api.getViewer`).
import type * as Fake from "../../viewer";

export const VIEW_AS_PERSONAS: typeof Fake.VIEW_AS_PERSONAS = [];

export const DEFAULT_PERSONA_ID: typeof Fake.DEFAULT_PERSONA_ID = "";

/** Senza provider (non succede nella build app): nessuno, senza permessi. */
const NOBODY = {
  viewer: { personId: "", instancePermissions: [], projectPermissions: {}, departmentPermissions: {} },
  setPersona: () => {},
};
export const defaultViewerContext: typeof Fake.defaultViewerContext = () => NOBODY;

/** Il provider del prototipo non si monta nella build app (`ViewerProvider` sceglie `AppViewerProvider`). */
export const PrototypeViewerProvider: typeof Fake.PrototypeViewerProvider = () => {
  throw new Error("PrototypeViewerProvider is not available in the app build");
};
