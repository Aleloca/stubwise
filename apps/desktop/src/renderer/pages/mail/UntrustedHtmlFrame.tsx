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
// 2. Gli script e i gestori `on…` si tolgono comunque dal testo, e una CSP
//    nel documento vieta script e connessioni.
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
/** Un attributo con o senza virgolette: `src="…"`, `src='…'`, `src=…`. */
const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi");
const unquote = (value: string) => value.replace(/^["']|["']$/g, "");

/**
 * Toglie script, gestori `on…`, URL `javascript:`, `<base>`, `<meta>` (un
 * refresh porterebbe via il frame) e ogni `target` dei link (nessun link
 * naviga il frame stesso: resta la `<base target="_blank">` del documento,
 * che il sandbox non apre). Sposta `src` e `srcset` remoti delle immagini e
 * delle sorgenti in `data-src`/`data-srcset`. Conta le immagini remote,
 * comprese quelle dei CSS (`url(…)`), che blocca la CSP.
 */
export function neutralize(html: string): { html: string; blockedImages: number } {
  let blockedImages = 0;
  const out = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/<(base|meta)\b[^>]*>/gi, "")
    .replace(attr("on[a-z]+"), "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"')
    .replace(/<a\b[^>]*>/gi, (tag) => tag.replace(attr("target"), ""))
    .replace(/<(img|source)\b[^>]*>/gi, (tag) =>
      tag
        .replace(attr("src"), (whole, value: string) => {
          if (!REMOTE.test(unquote(value))) return whole;
          blockedImages += 1;
          return ` data-src="${unquote(value)}"`;
        })
        .replace(attr("srcset"), (whole, value: string) => {
          if (!/(https?:)?\/\//i.test(value)) return whole;
          blockedImages += 1;
          return ` data-srcset="${unquote(value)}"`;
        }),
    );
  blockedImages += (out.match(/url\(\s*["']?\s*(https?:)?\/\//gi) ?? []).length;
  return { html: out, blockedImages };
}

/** «Show images»: `data-src`/`data-srcset` tornano `src`/`srcset` (gli stessi indirizzi, nient'altro). */
export function revealImages(html: string): string {
  return html.replace(/<(img|source)\b[^>]*>/gi, (tag) =>
    tag
      .replace(/\sdata-src\s*=\s*"([^"]*)"/i, (_m, url: string) => ` src="${url}"`)
      .replace(/\sdata-srcset\s*=\s*"([^"]*)"/i, (_m, set: string) => ` srcset="${set}"`),
  );
}

function documentFor(body: string, images: boolean): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " https: http:" : ""}; font-src data:`;
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
