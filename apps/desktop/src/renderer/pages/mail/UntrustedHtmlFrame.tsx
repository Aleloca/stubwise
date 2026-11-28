import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrustedMailFrame } from "../../platform/trustedHtml";
import { ImageGlyph } from "./glyphs";
import { neutralize } from "./mailHtml";

// Le funzioni pure stanno in `mailHtml.ts` (Trusted Types, revisione I-4);
// i test le leggono anche da qui.
export { neutralize, revealImages, scrubTree } from "./mailHtml";

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
}: {
  html: string;
  title: string;
  /** Un'altezza fissa (la descrizione di un evento: fino a 240 px), al posto della stima. */
  height?: number;
}) {
  const { t } = useTranslation();
  const [images, setImages] = useState(false);
  const safe = useMemo(() => neutralize(html), [html]);
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
      <TrustedMailFrame
        html={html}
        images={images}
        title={title}
        sandbox=""
        referrerPolicy="no-referrer"
        style={{ height: height ?? estimatedHeight(safe.html) }}
        className="w-full rounded-md border border-rule bg-white"
      />
    </div>
  );
}
