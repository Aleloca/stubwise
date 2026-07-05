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

/** Flag di montaggio: la seconda `initWidget` è un no-op (evita host doppi). */
let mounted = false;

/**
 * Reset del flag di montaggio. USO SOLO NEI TEST: isola i casi che chiamano
 * `initWidget` (la guardia è un modulo-singleton, altrimenti persisterebbe tra
 * test). Non fa teardown del DOM: quello lo fa il test.
 */
export function __resetWidgetForTests(): void {
  mounted = false;
}

/**
 * Inizializza il widget. Robusto per costruzione: NON lancia MAI (è embeddato in
 * siti terzi e non deve mai romperli). Su qualunque errore — DSN malformato,
 * fetch della config fallito, `enabled: false` — non monta nulla e al più logga
 * un `console.warn`. Doppia chiamata → no-op (guardia `mounted`).
 */
export async function initWidget(options: InitWidgetOptions): Promise<void> {
  try {
    if (mounted) return;
    if (typeof document === "undefined") return;

    const base = parseWidgetDsn(options.dsn);
    const config = await fetchConfig(base);
    if (!config.enabled) return;

    // Prenotiamo lo slot PRIMA del mount: un secondo init concorrente non deve
    // creare un secondo host neppure in caso di race sul fetch.
    mounted = true;
    mountWidget(base, config, options.user);
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
