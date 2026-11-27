import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageGlyph } from "./glyphs";

// L'originale HTML di un'email: HTML di un estraneo (shape mail.md §3, A9;
// vincoli §9). Tre difese indipendenti, nessuna delle quali basta da sola:
//
// 1. `<iframe sandbox="">` senza NESSUN permesso — niente `allow-scripts`,
//    `allow-same-origin`, `allow-forms`, `allow-popups`,
//    `allow-top-navigation`: il contenuto non esegue codice, non ha
//    un'origine, non invia moduli, non apre finestre né porta via la pagina.
//    Un link cliccato dentro non va da nessuna parte (`<base target>`
//    verso una finestra nuova, che il sandbox non permette).
// 2. L'HTML si bonifica su un albero DOM (`neutralize`): script, frame,
//    gestori `on…`, URL `javascript:` e simili, `target` dei link non
//    restano; una CSP nel documento vieta script e connessioni.
// 3. Le immagini remote non caricano MAI dal mittente: il loro `src` diventa
//    `data-src`, e la CSP del frame ammette solo `img-src data:` (anche se un
//    `src` sfuggisse alla riscrittura). Con «Show images» — per quel
//    messaggio, quella volta (lo stato non si ricorda) — le immagini passano
//    dal NOSTRO server (design `docs/plans/2026-11-28-proxy-immagini-posta-
//    design.md`): si chiedono per POSIZIONE (`data-image="n"`, messo da
//    `/original`), arrivano come `data:` e solo così entrano in `src`. Chi
//    rende il frame dà `loadImage`; senza (le descrizioni del calendario), il
//    bottone non c'è.
//
// Sfondo chiaro deliberato in entrambi i temi: il contenuto è scritto da
// altri, quasi sempre per uno sfondo chiaro (come il web).

/** Alto quanto il contenuto, fino a questo; poi scorre dentro. */
export const FRAME_MAX = 1200;
const FRAME_MIN = 320;

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
  const doc = new DOMParser().parseFromString(html, "text/html");
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

/** Quante immagini di un messaggio si chiedono al più, e quante insieme (design §6). */
export const MAX_FRAME_IMAGES = 50;
const IMAGE_CONCURRENCY = 4;
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
 * «Show images»: ogni `<img data-image="n">` arrivata dal proxy prende il suo
 * `data:` in `src`. Nient'altro cambia: gli indirizzi del mittente restano
 * parcheggiati e la CSP non li farebbe partire comunque.
 */
export function withLoadedImages(html: string, loaded: ReadonlyMap<number, string>): string {
  const body = bodyOf(html);
  for (const el of Array.from(body.querySelectorAll("img[data-image]"))) {
    const data = loaded.get(Number(el.getAttribute("data-image")));
    if (data && RASTER_DATA_URL.test(data)) el.setAttribute("src", data);
  }
  return body.innerHTML;
}

/** Le immagini delle posizioni, al più `IMAGE_CONCURRENCY` insieme; una che non arriva resta fuori. */
async function loadAll(positions: number[], loadImage: (n: number) => Promise<string | null>): Promise<Map<number, string>> {
  const loaded = new Map<number, string>();
  const queue = [...positions];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      const data = await loadImage(n).catch(() => null);
      if (data) loaded.set(n, data);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, queue.length) }, worker));
  return loaded;
}

function documentFor(body: string): string {
  // Mai una risorsa remota, nemmeno con «Show images»: le immagini arrivano come `data:` dal nostro server.
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="light"><base target="_blank"><style>
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1a1a1a; background: #ffffff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  a { color: #1a1a1a; text-decoration: underline; }
</style></head><body>${body}</body></html>`;
}

/** Un'altezza ragionevole senza leggere dentro il frame (che non ha origine): dal testo. */
function estimatedHeight(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").length;
  const blocks = (html.match(/<(p|h\d|li|tr|div|br|img)\b/gi) ?? []).length;
  return Math.min(FRAME_MAX, Math.max(FRAME_MIN, 40 + Math.ceil(text / 80) * 22 + blocks * 18));
}

export function UntrustedHtmlFrame({
  html,
  title,
  height,
  loadImage,
}: {
  html: string;
  title: string;
  /** Un'altezza fissa (la descrizione di un evento: fino a 240 px), al posto della stima. */
  height?: number;
  /**
   * Chi porta un'immagine remota per posizione, dal proxy del server, come
   * `data:` (o `null`). Senza, «Show images» non si offre.
   */
  loadImage?: (n: number) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [images, setImages] = useState<"blocked" | "loading" | Map<number, string>>("blocked");
  const safe = useMemo(() => neutralize(html), [html]);
  const positions = useMemo(() => imagePositions(safe.html), [safe]);
  // Al cambio di messaggio le immagini tornano bloccate: lo stato non si ricorda.
  const [shownFor, setShownFor] = useState(html);
  if (shownFor !== html) {
    setShownFor(html);
    setImages("blocked");
  }
  // L'HTML di adesso: un caricamento finito per un messaggio di prima non si applica.
  const current = useRef(html);
  current.current = html;
  const loaded = images instanceof Map ? images : null;
  const srcDoc = useMemo(
    () => documentFor(loaded ? withLoadedImages(safe.html, loaded) : safe.html),
    [safe, loaded],
  );
  const show = () => {
    if (!loadImage || images !== "blocked") return;
    setImages("loading");
    // Si aspettano TUTTE prima di ridisegnare: ogni nuovo `srcdoc` ricarica il documento.
    const asked = html;
    void loadAll(positions.slice(0, MAX_FRAME_IMAGES), loadImage).then((map) => {
      if (current.current === asked) setImages(map);
    });
  };
  const offer = !!loadImage && positions.length > 0;
  return (
    <div className="flex flex-col gap-2">
      {/* L'HTML del server porta le immagini già parcheggiate (`data-src`, numerate):
          contano anche quelle, non solo ciò che `neutralize` ha spostato. */}
      {(safe.blockedImages > 0 || positions.length > 0) && !loaded && (
        <div className="flex h-8 items-center gap-2 text-sm text-ink-muted">
          <ImageGlyph />
          <span className="min-w-0 flex-1 truncate">{t("mail.message.imagesBlocked")}</span>
          {offer && (
            <button
              type="button"
              onClick={show}
              aria-disabled={images === "loading" || undefined}
              className="inline-flex h-7 shrink-0 items-center rounded-md border border-rule-strong px-2.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-disabled:cursor-progress aria-disabled:opacity-60"
            >
              {images === "loading" ? t("mail.message.loadingImages") : t("mail.message.showImages")}
            </button>
          )}
        </div>
      )}
      {loaded && positions.length > MAX_FRAME_IMAGES && (
        <p className="text-sm text-ink-muted">{t("mail.message.imagesCapped", { count: MAX_FRAME_IMAGES })}</p>
      )}
      <iframe
        title={title}
        srcDoc={srcDoc}
        sandbox=""
        referrerPolicy="no-referrer"
        style={{ height: height ?? estimatedHeight(safe.html) }}
        className="w-full rounded-md border border-rule bg-white"
      />
    </div>
  );
}
