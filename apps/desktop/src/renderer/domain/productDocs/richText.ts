// Il testo coi segni della doc di prodotto (area 11a, Q2): testo semplice più
// segni a intervalli [start, end). Dall'integrazione dell'area 11 (F1) le
// funzioni pure stanno in `@stubwise/shared` (`product-docs/rich-text.ts`),
// i link sicuri in `isSafeWebUrl` (una regola sola per l'app): qui la
// ri-esportazione, più ciò che serve solo a incollare nel renderer.
export {
  CODE_TOKEN_RE,
  concatRich,
  deleteRange,
  insertText,
  normalize,
  plain,
  richSegments,
  safeLinkHref,
  setLink,
  splitRich,
  toggleMark,
  type RichSegment,
} from "@stubwise/shared";
import { safeLinkHref } from "@stubwise/shared";

// --- incollare (`pasteHtml.ts`) ---------------------------------------------

/** Gli elementi il cui contenuto non è testo. */
export const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "META", "TEMPLATE", "NOSCRIPT"]);

export interface Style {
  bold: boolean;
  italic: boolean;
  href: string | null;
}

/**
 * Il grassetto e il corsivo che un elemento dichiara, dal tag o dallo stile
 * in linea. Google Docs non usa `<b>`/`<i>` per i segni: li scrive negli
 * `style` degli `<span>` (`font-weight:700`, `font-style:italic`), e avvolge
 * tutto l'incollato in un `<b style="font-weight:normal" id="docs-internal-guid-…">`
 * che NON è grassetto. Lo stile in linea vince sul tag.
 */
export function styleOf(el: Element, parent: Style): Style {
  const tag = el.tagName;
  let bold = parent.bold || tag === "B" || tag === "STRONG";
  let italic = parent.italic || tag === "I" || tag === "EM";
  const css = (el.getAttribute("style") ?? "").toLowerCase();
  const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(css)?.[1];
  if (weight !== undefined) {
    const n = Number(weight);
    bold = weight === "bold" || weight === "bolder" || (Number.isFinite(n) && n >= 600);
  }
  const fontStyle = /font-style\s*:\s*([a-z]+)/.exec(css)?.[1];
  if (fontStyle !== undefined) italic = fontStyle === "italic" || fontStyle === "oblique";
  let href = parent.href;
  if (tag === "A") href = safeLinkHref(el.getAttribute("href") ?? "");
  return { bold, italic, href };
}
