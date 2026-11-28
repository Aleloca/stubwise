import { parseInertHtml } from "../../platform/trustedHtml";

// Le funzioni PURE dell'originale HTML di un'email (le difese 2 e 3 di
// `UntrustedHtmlFrame.tsx`): bonificare l'albero, parcheggiare le immagini
// remote, comporre il documento della cornice. Il parsing passa da
// `parseInertHtml` (Trusted Types, revisione I-4): un documento inerte, che
// non esegue niente e non entra mai nella pagina.

const REMOTE = /^\s*(https?:)?\/\//i;
/** Gli schemi che eseguono o incapsulano contenuto: un link o una sorgente con questi non va da nessuna parte. */
const DANGEROUS_URL = /^(javascript|vbscript|data):/i;
const DATA_IMAGE = /^data:image\//i;
const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href"];
const DROPPED = "script, iframe, frame, frameset, object, embed, base, meta, link";
const CSS_REMOTE_URL = /url\(\s*["']?\s*(https?:)?\/\//gi;
/** `@import "https://…"` senza `url(…)` (quello con `url(` lo conta già `CSS_REMOTE_URL`). */
const CSS_REMOTE_IMPORT = /@import\s+["']\s*(https?:)?\/\//gi;
/** Una stringa remota fra virgolette: dentro `image-set()` è un'immagine anche senza `url(…)`. */
const QUOTED_REMOTE = /["']\s*(https?:)?\/\//gi;

/**
 * Le stringhe remote fra virgolette dentro `image-set()` (e
 * `-webkit-image-set()`): fino alla sua parentesi di chiusura, saltando
 * quelle degli `url(…)` dentro (già contati da `CSS_REMOTE_URL`).
 */
function countImageSets(css: string): number {
  let count = 0;
  for (const m of css.matchAll(/image-set\(/gi)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let inner = "";
    while (i < css.length && depth > 0) {
      const c = css[i]!;
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      if (depth > 0) inner += depth === 1 ? c : " ";
      i += 1;
    }
    count += (inner.match(QUOTED_REMOTE) ?? []).length;
  }
  return count;
}

const countCss = (css: string) =>
  (css.match(CSS_REMOTE_URL) ?? []).length +
  (css.match(CSS_REMOTE_IMPORT) ?? []).length +
  countImageSets(css);

/** Il testo di un URL come lo legge il browser: senza spazi e caratteri di controllo. */
const normalizedUrl = (value: string) => value.replace(/[\u0000-\u0020\u007f]+/g, "");

/**
 * Le risorse remote che aspettano «Show images»: per elemento, l'attributo
 * vero e quello in cui si parcheggia l'indirizzo finché non si preme.
 */
const PARKED: { match: (el: Element) => boolean; attr: string; parked: string }[] = [
  { match: (el) => /^(img|source)$/i.test(el.tagName), attr: "src", parked: "data-src" },
  { match: (el) => /^(img|source)$/i.test(el.tagName), attr: "srcset", parked: "data-srcset" },
  // `background=` di body, table, td…: un'immagine di fondo vecchio stile.
  { match: () => true, attr: "background", parked: "data-background" },
  // Un'immagine SVG.
  { match: (el) => el.tagName.toLowerCase() === "image", attr: "href", parked: "data-href" },
  { match: (el) => el.tagName.toLowerCase() === "image", attr: "xlink:href", parked: "data-xlink-href" },
];
const isRemote = (attr: string, value: string) =>
  attr === "srcset" ? /(https?:)?\/\//i.test(value) : REMOTE.test(value);

/**
 * Il corpo dell'email come albero. Gli `<style>` che il parser mette nella
 * `<head>` (dichiarati lì, o in testa al documento) passano in cima al corpo:
 * senza, il loro aspetto si perderebbe e i loro `url()` non si conterebbero.
 */
function bodyOf(html: string): HTMLElement {
  const doc = parseInertHtml(html);
  const styles = Array.from(doc.head.querySelectorAll("style"));
  for (const style of styles.reverse()) doc.body.prepend(style);
  return doc.body;
}

/**
 * Bonifica l'HTML di un'email su un albero DOM (`DOMParser`, che non esegue
 * nulla): toglie script, frame, oggetti, `base`, `meta`, `link`; ogni
 * attributo `on…`; gli URL `javascript:`/`vbscript:`/`data:` (salvo le
 * immagini `data:image`) in `href`, `src`, `action`, `formaction`,
 * `xlink:href`; il `target` di link, aree e moduli (nessuno naviga il frame).
 * Parcheggia le risorse remote (`src`, `srcset`, `background`, immagini
 * SVG) in attributi `data-…` e le conta, comprese quelle dei CSS (`url(…)`
 * e `@import` in `style` e `<style>`), che blocca la CSP finché non si preme
 * «Show images».
 */
export function neutralize(html: string): { html: string; blockedImages: number } {
  const body = bodyOf(html);
  const blockedImages = scrubTree(body);
  return { html: body.innerHTML, blockedImages };
}

/**
 * Il passo di `neutralize` su un albero già costruito (anche SVG, con i suoi
 * namespace): lo bonifica sul posto e dice quante risorse remote ha
 * parcheggiato o trovato nei CSS.
 */
export function scrubTree(root: Element): number {
  let blockedImages = 0;
  root.querySelectorAll(DROPPED).forEach((el) => el.remove());
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const { name, value } of Array.from(el.attributes)) {
      const key = name.toLowerCase();
      if (key.startsWith("on")) {
        el.removeAttribute(name);
        continue;
      }
      if (URL_ATTRS.includes(key)) {
        const url = normalizedUrl(value);
        if (DANGEROUS_URL.test(url) && !(key === "src" && DATA_IMAGE.test(url))) {
          if (key === "href") el.setAttribute(name, "#");
          else el.removeAttribute(name);
          continue;
        }
      }
      if (key === "target" && /^(a|area|form)$/i.test(el.tagName)) {
        el.removeAttribute(name);
        continue;
      }
      if (key === "style") blockedImages += countCss(value);
    }
    if (el.tagName.toLowerCase() === "style") blockedImages += countCss(el.textContent ?? "");
    for (const rule of PARKED) {
      if (!rule.match(el)) continue;
      const value = el.getAttribute(rule.attr);
      if (value === null || !isRemote(rule.attr, value)) continue;
      el.setAttribute(rule.parked, value);
      el.removeAttribute(rule.attr);
      blockedImages += 1;
    }
  }
  return blockedImages;
}

/** Solo i raster che il proxy dà: un `data:` d'altro tipo (un SVG) non entra in `src`. */
const RASTER_DATA_URL = /^data:image\/(png|jpeg|gif|webp|avif);base64,/;

/** Le posizioni delle immagini remote numerate dal server (`data-image`), in ordine, senza doppioni. */
export function imagePositions(html: string): number[] {
  const seen = new Set<number>();
  for (const el of Array.from(bodyOf(html).querySelectorAll("img[data-image]"))) {
    const n = Number(el.getAttribute("data-image"));
    if (Number.isInteger(n) && n >= 0) seen.add(n);
  }
  return [...seen];
}

/**
 * «Show images»: ogni `<img data-image="n">` arrivata dal proxy del server
 * prende il suo `data:` raster in `src`. Nient'altro cambia: gli indirizzi
 * del mittente restano parcheggiati e la CSP non li farebbe partire comunque.
 */
export function withLoadedImages(html: string, loaded: ReadonlyMap<number, string>): string {
  const body = bodyOf(html);
  for (const el of Array.from(body.querySelectorAll("img[data-image]"))) {
    const data = loaded.get(Number(el.getAttribute("data-image")));
    if (data && RASTER_DATA_URL.test(data)) el.setAttribute("src", data);
  }
  return body.innerHTML;
}

export function documentFor(body: string): string {
  // Mai una risorsa remota, nemmeno con «Show images»: le immagini arrivano
  // come `data:` dal nostro server (design `docs/plans/2026-11-28-proxy-
  // immagini-posta-design.md`).
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="light"><base target="_blank"><style>
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1a1a1a; background: #ffffff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  a { color: #1a1a1a; text-decoration: underline; }
</style></head><body>${body}</body></html>`;
}

/**
 * Il documento della cornice per l'HTML GREZZO di un'email: bonificato, con
 * le immagini che il proxy ha portato (solo se chi legge l'ha chiesto). L'unica
 * stringa che `TrustedMailFrame` rende fidata.
 */
export function mailDocument(html: string, loaded: ReadonlyMap<number, string> | null): string {
  const safe = neutralize(html).html;
  return documentFor(loaded ? withLoadedImages(safe, loaded) : safe);
}
