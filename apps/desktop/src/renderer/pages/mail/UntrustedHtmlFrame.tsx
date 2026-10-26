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

/** Toglie script, gestori d'evento e URL `javascript:`; sposta i `src` remoti delle immagini in `data-src`. */
export function neutralize(html: string): { html: string; blockedImages: number } {
  let blockedImages = 0;
  const out = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2")
    .replace(/<img\b[^>]*>/gi, (tag) =>
      tag.replace(/\ssrc\s*=\s*(["'])([^"']*)\1/i, (attr, quote: string, url: string) => {
        if (!REMOTE.test(url)) return attr;
        blockedImages += 1;
        return ` data-src=${quote}${url}${quote}`;
      }),
    );
  return { html: out, blockedImages };
}

/** «Show images»: i `data-src` delle immagini tornano `src` (gli stessi indirizzi, nient'altro). */
export function revealImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(/\sdata-src\s*=\s*(["'])([^"']*)\1/i, (_attr, quote: string, url: string) =>
      ` src=${quote}${url}${quote}`,
    ),
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
