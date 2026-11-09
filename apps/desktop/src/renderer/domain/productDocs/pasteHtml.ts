import type { InlineMark, ProductBlock, ProductTableRow, RichText } from "../../data/model";
import { guessLanguage, normalizeLanguage } from "./codeLanguages";
import { deleteRange, normalize, SKIP_TAGS, styleOf, type Style } from "./richText";

// L'HTML degli appunti in blocchi della doc di prodotto (prove a mano del
// 7 nov 2026, decisione del maintainer: l'incolla tiene la struttura; prima
// [PE 14] faceva sempre paragrafi). Restano tutti i blocchi che l'editor sa
// fare: titoli (h1–h3; h4–h6 valgono 3), elenchi puntati e numerati coi
// rientri (al più 3 livelli), caselle da spuntare, citazioni, tabelle, riga
// orizzontale e codice; dentro le frasi grassetto, corsivo e link http(s).
// Google Docs compreso: avvolge tutto in un `<b style="font-weight:normal">`
// che non è grassetto, scrive i segni negli `style` e i rientri degli elenchi
// in `aria-level`; il suo «Titolo» è un `<p>` col carattere grande (diventa
// un titolo di livello 1) e il suo codice è una fila di `<p>` tutti in un
// carattere a spaziatura fissa, con un `<br>` per riga vuota (diventa un
// blocco di codice; il linguaggio negli appunti non c'è, e si indovina solo
// quando è sicuro: JSON o XML, vedi `guessLanguage`). Le immagini
// nell'HTML non entrano (un'immagine si incolla come file). Tutto il resto
// dell'HTML diventa testo o sparisce.

type Ctx =
  | { type: "paragraph" | "quote" }
  | { type: "heading"; level: 1 | 2 | 3 }
  | { type: "bullet" | "numbered"; indent: 0 | 1 | 2 }
  | { type: "todo"; checked: boolean }
  | { type: "code"; language?: string };

const PARAGRAPH: Ctx = { type: "paragraph" };
const PLAIN: Style = { bold: false, italic: false, href: null };

/** Gli elementi che chiudono la frase in corso e ne cominciano un'altra, con lo stesso contesto. */
const BREAK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "DD", "DT", "FIGURE", "FIGCAPTION"]);

/** Un carattere a spaziatura fissa: il codice di Google Docs (Roboto Mono, Courier New…). */
const MONO_FONT = /mono|courier|consolas|menlo/i;
/** Da quanti punti un paragrafo è il «Titolo» di Google Docs (26pt; il suo h1 è 20pt). */
const TITLE_PT = 24;

const clampIndent = (n: number): 0 | 1 | 2 => (n <= 0 ? 0 : n >= 2 ? 2 : 1) as 0 | 1 | 2;

/** Le frasi coi segni, in costruzione: una alla volta. */
class Line {
  text = "";
  marks: InlineMark[] = [];

  append(raw: string, style: Style, keepSpaces: boolean) {
    let chunk = raw.replace(/ /g, " ");
    if (!keepSpaces) {
      chunk = chunk.replace(/[\t\n\r\f ]+/g, " ");
      if (this.text === "" || this.text.endsWith(" ") || this.text.endsWith("\n")) chunk = chunk.replace(/^ /, "");
    } else chunk = chunk.replace(/\r\n?/g, "\n");
    if (chunk === "") return;
    const start = this.text.length;
    this.text += chunk;
    const end = this.text.length;
    if (keepSpaces) return; // il codice è testo semplice
    if (style.bold) this.marks.push({ type: "bold", start, end });
    if (style.italic) this.marks.push({ type: "italic", start, end });
    if (style.href !== null) this.marks.push({ type: "link", start, end, href: style.href });
  }

  /** La frase senza spazi ai lati (i segni si spostano); per il codice solo gli a capo in coda. */
  take(code: boolean): RichText {
    let rt: RichText = { text: this.text, marks: normalize(this.marks, this.text.length) };
    this.text = "";
    this.marks = [];
    if (code) {
      const trail = rt.text.length - rt.text.replace(/\n+$/, "").length;
      return trail > 0 ? deleteRange(rt, rt.text.length - trail, rt.text.length) : rt;
    }
    const lead = rt.text.length - rt.text.trimStart().length;
    if (lead > 0) rt = deleteRange(rt, 0, lead);
    const trail = rt.text.length - rt.text.trimEnd().length;
    if (trail > 0) rt = deleteRange(rt, rt.text.length - trail, rt.text.length);
    return rt;
  }
}

/** Il valore di `prop` nello stile in linea più vicino al testo, fra `node` e `root`. */
function inlineStyle(node: Node, root: Element, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i");
  for (let el = node.parentElement; el !== null; el = el.parentElement) {
    const hit = re.exec(el.getAttribute("style") ?? "");
    if (hit) return hit[1]!.trim();
    if (el === root) break;
  }
  return null;
}

/** Se ogni pezzo di testo di `el` (ce n'è almeno uno) ha uno stile che rispetta `ok`. */
function everyText(el: Element, prop: string, ok: (value: string | null) => boolean): boolean {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let any = false;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if ((n.textContent ?? "").replace(/\u00a0/g, " ").trim() === "") continue;
    any = true;
    if (!ok(inlineStyle(n, el, prop))) return false;
  }
  return any;
}

const isMonoParagraph = (el: Element) => el.tagName === "P" && everyText(el, "font-family", (v) => v !== null && MONO_FONT.test(v));

const isTitleParagraph = (el: Element) =>
  el.tagName === "P" &&
  everyText(el, "font-size", (v) => {
    const m = /^([\d.]+)\s*(pt|px)$/i.exec(v ?? "");
    if (!m) return false;
    const pt = m[2]!.toLowerCase() === "px" ? Number(m[1]) * 0.75 : Number(m[1]);
    return pt >= TITLE_PT;
  });

/** Il testo di una riga di codice, spazi compresi; un `<br>` va a capo. */
function codeTextOf(el: Element): string {
  let text = "";
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) text += child.textContent ?? "";
      else if (child.nodeType === 1) {
        const tag = (child as Element).tagName;
        if (tag === "BR") text += "\n";
        else if (!SKIP_TAGS.has(tag)) visit(child);
      }
    }
  };
  visit(el);
  return text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
}

/** Il linguaggio di un `<pre>`/`<code>`: `language-json`, `lang-json` o `data-language`. */
function languageOf(el: Element): string | undefined {
  const sources = [el, el.querySelector("code")].filter((e): e is Element => e !== null);
  for (const e of sources) {
    const data = e.getAttribute("data-language") ?? e.getAttribute("data-lang");
    if (data) return normalizeLanguage(data);
    const cls = /(?:^|\s)(?:language|lang)-([A-Za-z0-9+#-]+)/.exec(e.getAttribute("class") ?? "");
    if (cls) return normalizeLanguage(cls[1]);
  }
  return undefined;
}

/** Il tipo di una voce d'elenco: lo stile della voce vince sul tag dell'elenco (Google Docs). */
function listTypeOf(li: Element, ordered: boolean): "bullet" | "numbered" {
  const css = (li.getAttribute("style") ?? "").toLowerCase();
  const kind = /list-style-type\s*:\s*([a-z-]+)/.exec(css)?.[1];
  if (kind === undefined) return ordered ? "numbered" : "bullet";
  return kind === "disc" || kind === "circle" || kind === "square" || kind === "none" ? "bullet" : "numbered";
}

/** Una casella da spuntare: `role="checkbox"` (Google Docs) o un `<input type="checkbox">` in testa. */
function checkboxOf(li: Element): { checked: boolean } | null {
  if (li.getAttribute("role") === "checkbox") return { checked: li.getAttribute("aria-checked") === "true" };
  const box = (el: Element) => el.tagName === "INPUT" && el.getAttribute("type")?.toLowerCase() === "checkbox";
  const first = li.firstElementChild;
  const input = first && (box(first) ? first : first.tagName === "P" && first.firstElementChild && box(first.firstElementChild) ? first.firstElementChild : null);
  if (input) return { checked: input.hasAttribute("checked") };
  return null;
}

/**
 * I blocchi dell'HTML incollato, nell'ordine; `makeId` dà gli id di blocchi,
 * righe e celle. Le frasi vuote non restano (Google Docs mette `<br>` fra i
 * paragrafi). Un HTML senza testo dà `[]`.
 */
export function blocksFromHtml(html: string, makeId: () => string): ProductBlock[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: ProductBlock[] = [];
  const line = new Line();
  let ctx: Ctx = PARAGRAPH;
  // Le righe di codice di Google Docs in fila, e le righe vuote (`<br>`)
  // viste dopo l'ultima: contano solo se un'altra riga di codice segue.
  let codeRun: string[] | null = null;
  let blankLines = 0;

  const closeCode = () => {
    if (codeRun === null) return;
    const text = codeRun.join("\n").replace(/\n+$/, "");
    codeRun = null;
    blankLines = 0;
    if (text.trim() === "") return;
    const language = guessLanguage(text);
    const content = { text, marks: [] };
    out.push(language === undefined ? { id: makeId(), type: "code", content } : { id: makeId(), type: "code", content, language });
  };

  const flush = () => {
    const content = line.take(ctx.type === "code");
    if (content.text.trim() === "") return;
    const id = makeId();
    switch (ctx.type) {
      case "heading":
        out.push({ id, type: "heading", level: ctx.level, content });
        break;
      case "bullet":
      case "numbered":
        out.push({ id, type: ctx.type, indent: ctx.indent, content });
        break;
      case "todo":
        out.push({ id, type: "todo", checked: ctx.checked, content });
        break;
      case "code": {
        // Un `<pre>` senza etichetta: il linguaggio solo se è sicuro.
        const language = ctx.language ?? guessLanguage(content.text);
        out.push(language === undefined ? { id, type: "code", content } : { id, type: "code", content, language });
        break;
      }
      default:
        out.push({ id, type: ctx.type, content });
    }
  };

  /** Il contenuto di `el` dentro il contesto `next`, chiuso prima e dopo. */
  const within = (el: Element, style: Style, next: Ctx, depth: number) => {
    flush();
    const saved = ctx;
    ctx = next;
    walk(el, styleOf(el, style), depth);
    flush();
    ctx = saved;
  };

  const walk = (node: Node, style: Style, depth: number) => {
    for (const child of Array.from(node.childNodes)) {
      const el0 = child.nodeType === 1 ? (child as Element) : null;
      const mono = el0 !== null && ctx.type === "paragraph" && isMonoParagraph(el0);
      if (codeRun !== null) {
        const blank = child.nodeType === 3 && (child.textContent ?? "").trim() === "";
        // Una riga di soli spazi (o un paragrafo vuoto) dentro il codice: una riga vuota.
        if (el0?.tagName === "BR" || (el0?.tagName === "P" && (el0.textContent ?? "").replace(/\u00a0/g, " ").trim() === "")) {
          blankLines++;
          continue;
        }
        if (!blank && !mono) closeCode();
      }
      if (mono) {
        flush();
        if (codeRun === null) codeRun = [];
        else for (; blankLines > 0; blankLines--) codeRun.push("");
        codeRun.push(codeTextOf(el0));
        continue;
      }
      if (child.nodeType === 3) {
        line.append(child.textContent ?? "", style, ctx.type === "code");
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag) || tag === "IMG") continue;
      if (tag === "BR") {
        if (ctx.type === "code") line.append("\n", style, true);
        else flush();
        continue;
      }
      if (tag === "HR") {
        flush();
        out.push({ id: makeId(), type: "divider" });
        continue;
      }
      if (/^H[1-6]$/.test(tag)) {
        within(el, style, { type: "heading", level: Math.min(Number(tag[1]), 3) as 1 | 2 | 3 }, depth);
        continue;
      }
      if (tag === "PRE") {
        within(el, PLAIN, { type: "code", language: languageOf(el) }, depth);
        continue;
      }
      if (tag === "BLOCKQUOTE") {
        within(el, style, { type: "quote" }, depth);
        continue;
      }
      if (tag === "UL" || tag === "OL") {
        flush();
        walkList(el, style, tag === "OL", depth);
        continue;
      }
      if (tag === "TABLE") {
        flush();
        const table = tableOf(el);
        if (table) out.push(table);
        continue;
      }
      if (tag === "LI") {
        // Una voce fuori da un elenco: come un paragrafo.
        within(el, style, ctx, depth);
        continue;
      }
      if (BREAK_TAGS.has(tag)) {
        // Un paragrafo dentro una voce o una citazione resta di quel tipo;
        // nel codice un paragrafo è una riga.
        if (ctx.type === "code") {
          if (line.text !== "" && !line.text.endsWith("\n")) line.append("\n", style, true);
          walk(el, PLAIN, depth);
          continue;
        }
        within(el, style, ctx.type === "paragraph" && isTitleParagraph(el) ? { type: "heading", level: 1 } : ctx, depth);
        continue;
      }
      walk(el, ctx.type === "code" ? PLAIN : styleOf(el, style), depth);
    }
  };

  const walkList = (list: Element, style: Style, ordered: boolean, depth: number) => {
    for (const li of Array.from(list.children)) {
      if (li.tagName === "UL" || li.tagName === "OL") {
        walkList(li, style, li.tagName === "OL", depth + 1);
        continue;
      }
      if (li.tagName !== "LI") {
        within(li, style, PARAGRAPH, depth);
        continue;
      }
      // Google Docs dice il livello in `aria-level` (elenchi piatti), l'HTML
      // comune con gli elenchi annidati.
      const aria = Number(li.getAttribute("aria-level"));
      const indent = clampIndent(Number.isFinite(aria) && aria >= 1 ? aria - 1 : depth);
      const box = checkboxOf(li);
      const next: Ctx = box ? { type: "todo", checked: box.checked } : { type: listTypeOf(li, ordered), indent };
      within(li, style, next, depth + 1);
    }
  };

  /** Una tabella: ogni cella una frase (i suoi paragrafi a capo), le righe pareggiate alla più larga. */
  const tableOf = (table: Element): ProductBlock | null => {
    const rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table);
    const cells = rows.map((tr) =>
      Array.from(tr.children)
        .filter((c) => c.tagName === "TD" || c.tagName === "TH")
        .map((c) => cellText(c)),
    );
    const width = Math.max(0, ...cells.map((r) => r.length));
    if (width === 0) return null;
    const built: ProductTableRow[] = cells.map((r) => ({
      id: makeId(),
      cells: Array.from({ length: width }, (_, i) => ({ id: makeId(), content: r[i] ?? { text: "", marks: [] } })),
    }));
    if (built.every((r) => r.cells.every((c) => c.content.text === ""))) return null;
    return { id: makeId(), type: "table", rows: built };
  };

  /** Il testo di una cella: le sue frasi unite da un a capo. */
  const cellText = (cell: Element): RichText => {
    const parts = blocksFromHtml(cell.innerHTML, makeId).flatMap((b) => {
      if ("content" in b) return [b.content];
      if (b.type === "table") return b.rows.map((r) => joinRich(r.cells.map((c) => c.content), " "));
      return [];
    });
    return joinRich(parts, "\n");
  };

  walk(doc.body, PLAIN, 0);
  flush();
  closeCode();
  return out;
}

/** Le frasi in fila con `sep` fra l'una e l'altra, coi loro segni. */
function joinRich(parts: readonly RichText[], sep: string): RichText {
  let text = "";
  const marks: InlineMark[] = [];
  parts.forEach((p, i) => {
    if (i > 0) text += sep;
    const at = text.length;
    text += p.text;
    for (const m of p.marks) marks.push({ ...m, start: m.start + at, end: m.end + at });
  });
  return { text, marks: normalize(marks, text.length) };
}

