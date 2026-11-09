import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import "../i18n";
import { clearToasts } from "../tasks-ui/Toast";

// `findBy*`/`waitFor` aspettano 1 s di default: basta su una macchina scarica,
// non quando la suite intera gira con altro carico (montare l'app intera
// arrivava a 2–3 s, e il test cadeva su «Unable to find role…» ogni volta in
// un punto diverso). È solo un tetto: un'attesa che riesce prima non cambia.
configure({ asyncUtilTimeout: 5_000 });

// Senza i globals di vitest l'auto-cleanup di testing-library non si
// registra da solo: lo si fa qui per ogni test.
afterEach(cleanup);

// I messaggi (toast) sono un archivio di modulo con un timer ciascuno (5–8 s):
// uno lasciato da un test scattava dopo lo smontaggio dell'ambiente, sotto
// carico, con «window is not defined» (successo con OverviewPage.test). Si
// svuotano a ogni test, timer compresi.
afterEach(() => {
  if (typeof window !== "undefined") clearToasts();
});

// --- matchMedia mock controllabile ---------------------------------------
// happy-dom espone `matchMedia`, ma il valore di `matches` deriva dal viewport
// interno e non si può pilotare comodamente da un test (né emette `change` su
// richiesta). I primitivi mobile (`useMediaQuery`, `Drawer`) hanno bisogno di
// un mock deterministico: di default tutte le query NON matchano (viewport
// "mobile"), e i test possono cambiare lo stato con `setMatchMedia(query, bool)`
// per verificare la reattività ai cambi di viewport.
type MockMql = MediaQueryList & {
  matches: boolean;
  _listeners: Set<(e: MediaQueryListEvent) => void>;
};

const mediaState = new Map<string, boolean>();
const mediaLists = new Map<string, MockMql>();

function createMql(query: string): MockMql {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    media: query,
    get matches() {
      return mediaState.get(query) ?? false;
    },
    onchange: null,
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    },
    // API legacy, mantenuta per compatibilità con eventuali consumatori.
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => true,
    _listeners: listeners,
  } as unknown as MockMql;
  return mql;
}

/** Imposta `matches` per una query e notifica i listener registrati. */
export function setMatchMedia(query: string, value: boolean): void {
  mediaState.set(query, value);
  const mql = mediaLists.get(query);
  if (!mql) return;
  const event = { matches: value, media: query } as MediaQueryListEvent;
  for (const cb of mql._listeners) cb(event);
}

beforeEach(() => {
  // I test di `src/main` girano in node (`@vitest-environment node`): niente window.
  if (typeof window === "undefined") return;
  mediaState.clear();
  mediaLists.clear();
  window.matchMedia = ((query: string) => {
    let mql = mediaLists.get(query);
    if (!mql) {
      mql = createMql(query);
      mediaLists.set(query, mql);
    }
    return mql;
  }) as typeof window.matchMedia;
});
