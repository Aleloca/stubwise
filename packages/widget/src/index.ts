/**
 * Entry del pacchetto `@stubwise/widget`: monta il widget di assistenza clienti
 * (chat AI + segnalazioni) in uno Shadow DOM sul sito ospite.
 *
 * Uso via tag `<script>` (bundle IIFE): all'esecuzione lo script pubblica
 * `window.Stubwise = { initWidget }` e lancia l'evento `stubwise:ready`, così la
 * pagina può fare `window.addEventListener("stubwise:ready", () =>
 * Stubwise.initWidget({ dsn, user }))`. Uso via bundler: `import { initWidget }`.
 *
 * Il core resta ri-esportato (DSN/API/SSE/storage) per usi avanzati.
 */
import { parseWidgetDsn } from "./core/dsn.js";
import { fetchConfig, type WidgetUser } from "./core/api.js";
import { mountWidget } from "./ui/widget.js";

export * from "./core/dsn.js";
export * from "./core/api.js";
export * from "./core/sse.js";
export * from "./core/storage.js";

/** Opzioni di init: DSN del progetto + identità DICHIARATA dell'utente. */
export interface InitWidgetOptions {
  dsn: string;
  user: WidgetUser;
}

/**
 * Flag di init: la seconda `initWidget` è un no-op (evita host doppi). Settato
 * SUBITO all'ingresso — PRIMA del `await fetchConfig` — per chiudere la race di
 * due init concorrenti: senza questo, entrambe passerebbero la guardia durante il
 * fetch e monterebbero due host. Semantica: doppia init = no-op SEMPRE, anche se
 * la prima non ha montato (config `disabled`/errore); il reset avviene solo se il
 * mount viene rimandato per `document.body` assente (vedi sotto).
 */
let initStarted = false;

/**
 * Reset del flag di init. USO SOLO NEI TEST: isola i casi che chiamano
 * `initWidget` (la guardia è un modulo-singleton, altrimenti persisterebbe tra
 * test). Non fa teardown del DOM: quello lo fa il test.
 */
export function __resetWidgetForTests(): void {
  initStarted = false;
}

/**
 * Esegue `cb` quando `document.body` è disponibile. Se il body c'è già (script
 * con `defer` o in fondo al `<body>`) chiama subito; altrimenti (script nel
 * `<head>` senza `defer`) rimanda a `DOMContentLoaded` una sola volta. Estratta
 * per essere testabile in isolamento (simulare `document.body` null in happy-dom
 * non è praticabile).
 */
export function whenBodyReady(cb: () => void): void {
  if (typeof document === "undefined") return;
  if (document.body) {
    cb();
    return;
  }
  document.addEventListener("DOMContentLoaded", cb, { once: true });
}

/**
 * Inizializza il widget. Robusto per costruzione: NON lancia MAI (è embeddato in
 * siti terzi e non deve mai romperli). Su qualunque errore — DSN malformato,
 * fetch della config fallito, `enabled: false` — non monta nulla e al più logga
 * un `console.warn`. Doppia chiamata → no-op (guardia `initStarted`).
 */
export async function initWidget(options: InitWidgetOptions): Promise<void> {
  try {
    if (typeof document === "undefined") return;
    // Prenotiamo lo slot PRIMA del fetch: un secondo init concorrente non deve
    // superare la guardia mentre la config è in volo (altrimenti due host).
    if (initStarted) return;
    initStarted = true;

    const base = parseWidgetDsn(options.dsn);
    const config = await fetchConfig(base);
    if (!config.enabled) return;

    // Se lo script gira nel `<head>` senza `defer`, `document.body` può ancora
    // non esistere: rimandiamo il mount a DOMContentLoaded invece di far lanciare
    // `appendChild` (che perderebbe il widget lasciando `initStarted` a true).
    whenBodyReady(() => mountWidget(base, config, options.user));
  } catch (err) {
    console.warn("[stubwise] widget init non riuscito:", err);
  }
}

// Side effect dell'entry: espone l'API globale e segnala la disponibilità.
// Guardia SSR/build: `window` può non esistere in ambienti non-browser.
if (typeof window !== "undefined") {
  (window as unknown as { Stubwise?: { initWidget: typeof initWidget } }).Stubwise = {
    initWidget,
  };
  window.dispatchEvent(new Event("stubwise:ready"));
}
