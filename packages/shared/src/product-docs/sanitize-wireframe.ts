/**
 * Area 11, F6: lo SVG di una bozza di schermata (`product_wireframes`) lo
 * disegna il modello, da fonti NON fidate. Prima di salvarlo il server lo
 * passa da qui: un'allowlist CHIUSA di elementi e attributi, e lo SVG si
 * RICOSTRUISCE da zero dai pezzi letti (mai una copia del testo d'ingresso).
 *
 * - Elementi: solo forme e testo (`svg`, `g`, `rect`, `circle`, `ellipse`,
 *   `line`, `polyline`, `polygon`, `path`, `text`, `tspan`, `title`, `desc`).
 *   Un elemento fuori elenco si toglie CON tutto ciò che contiene (`script`,
 *   `foreignObject`, `style`, `use`, `image`, `a`, …).
 * - Attributi: solo geometria e aspetto; gli altri si tolgono (`on*`,
 *   `style`, `href`, `xlink:*`, `class`, `id`…). Un valore con `url(`,
 *   `javascript:`, `data:`, `expression`, `@import`, `<` o `>` si toglie.
 * - Si SCARTA (null) ciò che non è una struttura semplice: commenti,
 *   DOCTYPE, CDATA, istruzioni, entità diverse dalle cinque di XML, tag non
 *   chiusi o incrociati, una radice che non è `svg` (o più di una), un
 *   namespace diverso da quello SVG, più di {@link WIREFRAME_SVG_MAX}
 *   caratteri.
 * - Il testo si riscrive escapato.
 * Pura, senza DOM: la usano server e worker.
 */

export const WIREFRAME_SVG_MAX = 200_000;
const SVG_NS = "http://www.w3.org/2000/svg";

const ELEMENTS = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title", "desc"]);
const ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "preserveAspectRatio",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "points",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "transform",
]);
const BAD_VALUE = /url\s*\(|javascript:|vbscript:|data:|expression|@import|[<>]/i;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

/** Decodifica le cinque entità di XML (e i riferimenti numerici); null per ogni altra. */
function decode(s: string): string | null {
  let ok = true;
  const out = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    const v = ENTITIES[e];
    if (v === undefined) ok = false;
    return v ?? "";
  });
  // Un `&` che non apre un'entità valida: non è XML.
  if (!ok || /&(?!(#x[0-9a-f]+|#\d+|[a-z]+);)/i.test(s)) return null;
  return out;
}

const TAG = /^<(\/?)([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function sanitizeWireframeSvg(input: string): string | null {
  if (typeof input !== "string" || input.length > WIREFRAME_SVG_MAX) return null;
  const src = input.trim();
  const out: string[] = [];
  const stack: { name: string; keep: boolean }[] = [];
  let roots = 0;
  let i = 0;
  // Dentro un elemento tolto (con il suo contenuto): la profondità di quel ramo.
  const dropping = () => stack.some((e) => !e.keep);
  while (i < src.length) {
    if (src[i] === "<") {
      // Commenti, DOCTYPE, CDATA, istruzioni: si scarta tutto.
      if (src.startsWith("<!", i) || src.startsWith("<?", i)) return null;
      const m = TAG.exec(src.slice(i));
      if (!m) return null;
      const [whole, closing, name, attrs, selfClosing] = m as unknown as [string, string, string, string, string];
      i += whole.length;
      if (closing) {
        if (selfClosing || attrs.trim() !== "") return null;
        const top = stack.pop();
        if (!top || top.name !== name) return null;
        if (top.keep && !dropping()) out.push(`</${name}>`);
        continue;
      }
      if (stack.length === 0) {
        roots += 1;
        if (roots > 1 || name !== "svg") return null;
      }
      const keep = ELEMENTS.has(name) && !dropping();
      if (keep) {
        const parts: string[] = [];
        for (const a of attrs.matchAll(ATTR)) {
          const attr = a[1]!;
          const value = decode(a[2] ?? a[3] ?? "");
          if (value === null) return null;
          if (attr === "xmlns") {
            if (value !== SVG_NS) return null;
            parts.push(`xmlns="${SVG_NS}"`);
            continue;
          }
          if (!ATTRIBUTES.has(attr) || BAD_VALUE.test(value)) continue;
          parts.push(`${attr}="${escapeAttr(value)}"`);
        }
        out.push(`<${name}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}${selfClosing ? "/" : ""}>`);
      }
      if (!selfClosing) stack.push({ name, keep });
      continue;
    }
    const next = src.indexOf("<", i);
    const raw = next < 0 ? src.slice(i) : src.slice(i, next);
    i = next < 0 ? src.length : next;
    if (stack.length === 0) {
      if (raw.trim() !== "") return null;
      continue;
    }
    const text = decode(raw);
    if (text === null) return null;
    if (!dropping()) out.push(escapeText(text));
  }
  if (stack.length > 0 || roots !== 1) return null;
  return out.join("");
}
