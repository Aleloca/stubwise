/**
 * Coordinate del backend del widget, estratte dal DSN. Il widget è standalone:
 * questa logica è adattata da `packages/sdk/src/core/transport.ts` (parseDsn) ma
 * non importa nulla dall'SDK.
 */
export interface WidgetDsn {
  /** Origine completa del backend (`https://host[:port][/prefix]`), senza `/p/slug`. */
  origin: string;
  /** Slug del progetto/widget. */
  slug: string;
  /** Chiave da inviare nell'header `X-Stubwise-Key`. */
  key: string;
}

/** `[/prefix]/p/<slug>[/]` — cattura prefisso di path e slug (adattato dall'SDK). */
const DSN_PATH = /^(?<prefix>(?:\/[^/]+)*)\/p\/(?<slug>[^/]+)\/?$/;

/**
 * Estrae origine, slug e chiave da un DSN nel formato `https://KEY@host/p/slug`.
 * Porta ed eventuale prefisso di path vengono preservati nell'`origin` (le route
 * pubbliche vivono su `<origin>/widget/<slug>/...`).
 *
 * Unico punto del widget autorizzato a lanciare: un DSN malformato è un errore di
 * configurazione e deve fallire forte all'init, non in silenzio a runtime. Il DSN
 * grezzo non finisce mai nei messaggi (può contenere la chiave).
 */
export function parseWidgetDsn(dsn: string): WidgetDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(
      "[stubwise] DSN malformato: la stringa fornita non è un URL valido (atteso https://KEY@host/p/slug)",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`[stubwise] DSN malformato: protocollo "${url.protocol}" non supportato`);
  }
  const key = decodeURIComponent(url.username);
  if (!key) {
    throw new Error(
      "[stubwise] DSN malformato: chiave mancante (atteso https://KEY@host/p/slug)",
    );
  }
  const match = DSN_PATH.exec(url.pathname);
  const slug = match?.groups?.["slug"];
  if (!slug) {
    throw new Error(`[stubwise] DSN malformato: path "${url.pathname}" non corrisponde a /p/<slug>`);
  }
  const prefix = match?.groups?.["prefix"] ?? "";
  return { origin: `${url.protocol}//${url.host}${prefix}`, slug, key };
}
