import type { InlineMark, RichText } from "../../data/model";

/**
 * Il testo coi segni della doc di prodotto (area 11a, Q2): testo semplice più
 * segni a intervalli [start, end). Funzioni pure: ognuna restituisce una
 * frase nuova coi segni normalizzati, mai una modifica sul posto.
 */

/**
 * I codici citabili nel testo: task («ACQ-14»), richiesta («-R»), pagina dei
 * Docs («-D»), file del Drive («-F»), conversazione di supporto («-S»).
 * È LA regex dei codici di tutta l'app: `CODE_IN_TEXT` della Chat e di Claude
 * (`pages/claude/conversation/flow.ts`) è questa stessa costante. Globale:
 * chi la usa ne fa una copia (`new RegExp(CODE_TOKEN_RE.source, "g")`) per
 * non condividere `lastIndex`. «ISO-8601» e simili corrispondono: un codice
 * che non esiste si mostra tenue come uno invisibile (R-G5, ruling P7).
 */
export const CODE_TOKEN_RE = /\b[A-Z]{2,4}-(?:[DFRS])?\d+\b/g;

/** Una frase senza segni. */
export function plain(text: string): RichText {
  return { text, marks: [] };
}

/**
 * L'indirizzo di un link, se è `http:` o `https:`; altrimenti `null`
 * (`javascript:`, `file:`, `data:`, relativi, testo qualunque). È la stessa
 * regola di `isExternalOpenAllowed` in `src/main/security.ts`, che resta
 * l'ultima difesa all'apertura: le due stanno ai due lati del confine di
 * processo (tsconfig separati), e i loro test usano la stessa tabella di casi.
 */
export function safeLinkHref(href: string): string | null {
  const trimmed = href.trim();
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

const TYPE_ORDER: Record<InlineMark["type"], number> = { bold: 0, italic: 1, link: 2 };

/**
 * I segni nella forma canonica: dentro il testo, mai vuoti, ordinati; due
 * segni dello stesso tipo che si toccano o si sovrappongono diventano uno
 * (per i link solo con lo stesso indirizzo; con indirizzi diversi vince il
 * più recente nell'elenco, che taglia il precedente).
 */
export function normalize(marks: readonly InlineMark[], length: number): InlineMark[] {
  const clamped = marks
    .map((m) => ({ ...m, start: Math.max(0, Math.min(m.start, length)), end: Math.max(0, Math.min(m.end, length)) }))
    .filter((m) => m.start < m.end);

  // I link: ognuno taglia i precedenti che sovrappone.
  let links: Extract<InlineMark, { type: "link" }>[] = [];
  for (const m of clamped) {
    if (m.type !== "link") continue;
    links = links.flatMap((l) => subtractOne(l, m.start, m.end));
    links.push(m);
  }

  const out: InlineMark[] = [];
  for (const type of ["bold", "italic"] as const) {
    out.push(...mergeRuns(clamped.filter((m) => m.type === type)));
  }
  out.push(...mergeRuns(links));
  return out.sort((a, b) => a.start - b.start || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.end - b.end);
}

/** Fonde i segni di un tipo che si toccano o si sovrappongono (i link solo con lo stesso indirizzo). */
function mergeRuns<M extends InlineMark>(marks: readonly M[]): M[] {
  const sorted = [...marks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: M[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start <= last.end && hrefOf(last) === hrefOf(m)) {
      last.end = Math.max(last.end, m.end);
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

const hrefOf = (m: InlineMark) => (m.type === "link" ? m.href : null);

/** Ciò che resta di un segno tolto l'intervallo [start, end): zero, uno o due pezzi. */
function subtractOne<M extends InlineMark>(m: M, start: number, end: number): M[] {
  if (end <= m.start || start >= m.end) return [m];
  const out: M[] = [];
  if (m.start < start) out.push({ ...m, end: start });
  if (end < m.end) out.push({ ...m, start: end });
  return out;
}

/**
 * Inserisce `text` in `at`. Un grassetto o un corsivo che copre `at` si
 * allarga, anche alla sua fine (si continua a scrivere in grassetto) e in
 * testa alla frase; un link si allarga solo se `at` sta strettamente dentro:
 * scrivendo dopo un link, il testo nuovo non è link. Un segno dopo `at` si
 * sposta.
 */
export function insertText(rt: RichText, at: number, text: string): RichText {
  const pos = Math.max(0, Math.min(at, rt.text.length));
  const n = text.length;
  if (n === 0) return { text: rt.text, marks: normalize(rt.marks, rt.text.length) };
  const marks = rt.marks.map((m): InlineMark => {
    const grows =
      m.type === "link" ? m.start < pos && pos < m.end : (m.start < pos && pos <= m.end) || (m.start === 0 && pos === 0);
    if (grows) return { ...m, end: m.end + n };
    if (pos <= m.start) return { ...m, start: m.start + n, end: m.end + n };
    return m;
  });
  const next = rt.text.slice(0, pos) + text + rt.text.slice(pos);
  return { text: next, marks: normalize(marks, next.length) };
}

/** Toglie il testo in [start, end): i segni si accorciano, quelli tutti dentro spariscono. */
export function deleteRange(rt: RichText, start: number, end: number): RichText {
  const a = Math.max(0, Math.min(start, rt.text.length));
  const b = Math.max(a, Math.min(end, rt.text.length));
  const n = b - a;
  const map = (p: number) => (p <= a ? p : p >= b ? p - n : a);
  const marks = rt.marks.map((m) => ({ ...m, start: map(m.start), end: map(m.end) }));
  const next = rt.text.slice(0, a) + rt.text.slice(b);
  return { text: next, marks: normalize(marks, next.length) };
}

/** [start, end) è tutto coperto da segni di quel tipo. */
function covered(marks: readonly InlineMark[], start: number, end: number, type: InlineMark["type"]): boolean {
  let at = start;
  for (const m of [...marks].filter((x) => x.type === type).sort((x, y) => x.start - y.start)) {
    if (m.start > at) break;
    at = Math.max(at, m.end);
    if (at >= end) return true;
  }
  return at >= end;
}

/** Grassetto o corsivo su [start, end): se è già tutto segnato lo toglie, altrimenti lo mette. */
export function toggleMark(rt: RichText, start: number, end: number, type: "bold" | "italic"): RichText {
  if (start >= end) return { text: rt.text, marks: normalize(rt.marks, rt.text.length) };
  const marks = covered(rt.marks, start, end, type)
    ? rt.marks.flatMap((m): InlineMark[] => (m.type === type ? subtractOne(m, start, end) : [m]))
    : [...rt.marks, { type, start, end }];
  return { text: rt.text, marks: normalize(marks, rt.text.length) };
}

/**
 * Il link su [start, end): `null` lo toglie, un indirizzo lo mette al posto di
 * quello che c'era. Un indirizzo non http(s) lancia `invalid: href`.
 */
export function setLink(rt: RichText, start: number, end: number, href: string | null): RichText {
  let safe: string | null = null;
  if (href !== null) {
    safe = safeLinkHref(href);
    if (safe === null) throw new Error("invalid: href");
  }
  const marks = rt.marks.flatMap((m): InlineMark[] => (m.type === "link" ? subtractOne(m, start, end) : [m]));
  if (safe !== null && start < end) marks.push({ type: "link", start, end, href: safe });
  return { text: rt.text, marks: normalize(marks, rt.text.length) };
}

/** Divide la frase in `at`: un segno a cavallo del taglio resta su entrambe le parti. */
export function splitRich(rt: RichText, at: number): [RichText, RichText] {
  const pos = Math.max(0, Math.min(at, rt.text.length));
  const left = rt.marks.map((m) => ({ ...m, end: Math.min(m.end, pos) }));
  const right = rt.marks.map((m) => ({ ...m, start: Math.max(m.start, pos) - pos, end: m.end - pos }));
  const a = rt.text.slice(0, pos);
  const b = rt.text.slice(pos);
  return [
    { text: a, marks: normalize(left, a.length) },
    { text: b, marks: normalize(right, b.length) },
  ];
}

/** Unisce due frasi: i segni di `b` scalati di `a.text.length`. */
export function concatRich(a: RichText, b: RichText): RichText {
  const shift = a.text.length;
  const text = a.text + b.text;
  const marks = [...a.marks, ...b.marks.map((m) => ({ ...m, start: m.start + shift, end: m.end + shift }))];
  return { text, marks: normalize(marks, text.length) };
}

export interface RichSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  href: string | null;
  /** Il codice citato, se il pezzo è un codice (`CODE_TOKEN_RE`); `null` per il testo. */
  code: string | null;
}

/**
 * I pezzi da disegnare o esportare. Un codice è un pezzo intero, coi segni
 * della sua prima lettera (un segno che comincia a metà di un codice non lo
 * spezza); il resto si taglia a ogni inizio e fine di segno.
 */
export function richSegments(rt: RichText): RichSegment[] {
  const { text } = rt;
  if (text === "") return [];
  const codes: { start: number; end: number }[] = [];
  for (const m of text.matchAll(new RegExp(CODE_TOKEN_RE.source, "g"))) {
    codes.push({ start: m.index, end: m.index + m[0].length });
  }
  const inCode = (p: number) => codes.some((c) => c.start < p && p < c.end);
  const cuts = new Set<number>([0, text.length]);
  for (const c of codes) cuts.add(c.start).add(c.end);
  for (const m of rt.marks) {
    if (!inCode(m.start)) cuts.add(m.start);
    if (!inCode(m.end)) cuts.add(m.end);
  }
  const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
  const out: RichSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (start === end) continue;
    const on = (type: InlineMark["type"]) => rt.marks.find((m) => m.type === type && m.start <= start && start < m.end);
    const link = on("link");
    const isCode = codes.some((c) => c.start === start && c.end === end);
    out.push({
      text: text.slice(start, end),
      bold: on("bold") !== undefined,
      italic: on("italic") !== undefined,
      href: link?.type === "link" ? link.href : null,
      code: isCode ? text.slice(start, end) : null,
    });
  }
  return out;
}

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
