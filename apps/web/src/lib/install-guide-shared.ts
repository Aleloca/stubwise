/**
 * Utility condivise dalle guide di installazione (widget e SDK): costruzione del
 * DSN, slug filesystem-safe per il nome file e download di un testo come file.
 * Il DSN di widget e SDK ha lo stesso formato `<protocol>//<key>@<host>/p/<slug>`
 * e cambia solo la CHIAVE (chiave del widget vs ingestion key del progetto):
 * `buildDsn` è generica su key/slug/origin ed è l'unica sorgente di verità.
 */

/**
 * Costruisce un DSN nel formato `<protocol>//<key>@<host>/p/<slug>`. Il
 * protocol/host derivano dall'origin (così http locale resta http).
 */
export function buildDsn(key: string, slug: string, origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${key}@${url.host}/p/${slug}`;
}

/** Slug filesystem-safe per il nome file di una guida scaricata. */
export function toFileSlug(value: string, fallback: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

/**
 * Scarica `content` come file `filename` (markdown) nel browser. Effetto DOM:
 * usato dai bottoni "Scarica .md", non dai generatori PURI di markdown.
 */
export function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
