import "@testing-library/jest-dom/vitest";
// Inizializza i18next (side-effect) prima dei test: i componenti che usano
// `useTranslation`/`t()` risolvono le chiavi sulla lingua di default (en),
// niente warning NO_I18NEXT_INSTANCE.
import "../i18n";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// Senza i globals di vitest l'auto-cleanup di testing-library non si
// registra da solo: lo si fa qui per ogni test.
afterEach(cleanup);

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
