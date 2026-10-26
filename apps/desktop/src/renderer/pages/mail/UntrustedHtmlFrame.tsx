import { useMemo, useState } from "react";
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
// 3. Le immagini remote non caricano: il loro `src` diventa `data-src`
//    finché chi legge non preme «Show images» — per quel messaggio, quella
//    volta (lo stato non si ricorda). La CSP le blocca anche se un `src`
//    sfuggisse alla riscrittura.
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
const countCss = (css: string) =>
  (css.match(CSS_REMOTE_URL) ?? []).length + (css.match(CSS_REMOTE_IMPORT) ?? []).length;

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

/** «Show images»: gli indirizzi parcheggiati tornano ai loro attributi (gli stessi, nient'altro). */
export function revealImages(html: string): string {
  const body = bodyOf(html);
  for (const el of Array.from(body.querySelectorAll("*"))) {
    for (const rule of PARKED) {
      if (!rule.match(el)) continue;
      const value = el.getAttribute(rule.parked);
      if (value !== null) el.setAttribute(rule.attr, value);
    }
  }
  return body.innerHTML;
}

function documentFor(body: string, images: boolean): string {
  // «Show images» apre le immagini remote e, con loro, i fogli `@import` (contati nella stessa fascia).
  const remote = images ? " https: http:" : "";
  const csp = `default-src 'none'; style-src 'unsafe-inline'${remote}; img-src data:${remote}; font-src data:`;
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

export function UntrustedHtmlFrame({ html, title }: { html: string; title: string }) {
  const { t } = useTranslation();
  const [images, setImages] = useState(false);
  const safe = useMemo(() => neutralize(html), [html]);
  const srcDoc = useMemo(
    () => documentFor(images ? revealImages(safe.html) : safe.html, images),
    [safe, images],
  );
  return (
    <div className="flex flex-col gap-2">
      {safe.blockedImages > 0 && !images && (
        <div className="flex h-8 items-center gap-2 text-sm text-ink-muted">
          <ImageGlyph />
          <span className="min-w-0 flex-1 truncate">{t("mail.message.imagesBlocked")}</span>
          <button
            type="button"
            onClick={() => setImages(true)}
            className="inline-flex h-7 shrink-0 items-center rounded-md border border-rule-strong px-2.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
          >
            {t("mail.message.showImages")}
          </button>
        </div>
      )}
      <iframe
        title={title}
        srcDoc={srcDoc}
        sandbox=""
        referrerPolicy="no-referrer"
        style={{ height: estimatedHeight(safe.html) }}
        className="w-full rounded-md border border-rule bg-white"
      />
    </div>
  );
}
