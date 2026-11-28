import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrustedMailFrame } from "../../platform/trustedHtml";
import { ImageGlyph } from "./glyphs";
import { imagePositions, neutralize } from "./mailHtml";

// Le funzioni pure stanno in `mailHtml.ts` (Trusted Types, revisione I-4);
// i test le leggono anche da qui.
export { imagePositions, neutralize, scrubTree, withLoadedImages } from "./mailHtml";

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
//    `/original`), arrivano come `data:` e solo così entrano in `src`, dentro
//    il documento che compone `TrustedMailFrame` (Trusted Types). Chi rende il
//    frame dà `loadImage`; senza (le descrizioni del calendario), il bottone
//    non c'è.
//
// Sfondo chiaro deliberato in entrambi i temi: il contenuto è scritto da
// altri, quasi sempre per uno sfondo chiaro (come il web).

/** Quante immagini di un messaggio si chiedono al più, e quante insieme (design §6). */
export const MAX_FRAME_IMAGES = 50;
const IMAGE_CONCURRENCY = 4;

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
      <TrustedMailFrame
        html={html}
        loaded={loaded}
        title={title}
        sandbox=""
        referrerPolicy="no-referrer"
        style={{ height: height ?? estimatedHeight(safe.html) }}
        className="w-full rounded-md border border-rule bg-white"
      />
    </div>
  );
}
