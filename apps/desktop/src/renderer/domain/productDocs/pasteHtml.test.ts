import { describe, expect, it } from "vitest";
import type { ProductBlock } from "../../data/model";
import { blocksFromHtml } from "./pasteHtml";
import { plain } from "./richText";

// L'incolla che tiene la struttura (prove a mano del 7 nov 2026, decisione
// del maintainer): prima [PE 14] faceva sempre paragrafi.

const ids = () => {
  let n = 0;
  return () => `b${++n}`;
};

/** I blocchi senza id, per confrontare solo la forma. */
function shape(blocks: ProductBlock[]): unknown[] {
  return blocks.map((b) => {
    if (b.type === "table") return { type: "table", rows: b.rows.map((r) => r.cells.map((c) => c.content.text)) };
    return Object.fromEntries(Object.entries(b).filter(([k]) => k !== "id"));
  });
}

const GDOC = (inner: string) =>
  '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-6a1f3c2e-7fff-4b1d-91a0-0c9e5d2b8f11">' +
  inner +
  '</b><br class="Apple-interchange-newline">';
const span = (text: string, style = "font-weight:400;font-style:normal;") =>
  `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;${style}white-space:pre-wrap;">${text}</span>`;

describe("blocksFromHtml: frasi e segni", () => {
  it("tiene grassetto e corsivo, scarta un link non http(s) e ogni tag", () => {
    const out = blocksFromHtml('<p><b>One</b> <a href="javascript:x">two</a></p><p><i>Three</i></p>', ids());
    expect(shape(out)).toEqual([
      { type: "paragraph", content: { text: "One two", marks: [{ type: "bold", start: 0, end: 3 }] } },
      { type: "paragraph", content: { text: "Three", marks: [{ type: "italic", start: 0, end: 5 }] } },
    ]);
  });

  it("Google Docs: segni dagli stili, l'involucro <b> non è grassetto, i link relativi restano testo", () => {
    const html = GDOC(
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
        span("Login", "font-weight:700;font-style:normal;") +
        span(" only with ") +
        '<a href="https://accounts.google.com" style="text-decoration:none;">' +
        span("Google", "font-weight:400;font-style:italic;") +
        "</a></p><br>" +
        '<p dir="ltr">' +
        span("Bills&nbsp;by ") +
        '<a href="/relative">' +
        span("email", "font-weight:700;") +
        "</a></p>",
    );
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      {
        type: "paragraph",
        content: {
          text: "Login only with Google",
          marks: [
            { type: "bold", start: 0, end: 5 },
            { type: "italic", start: 16, end: 22 },
            { type: "link", start: 16, end: 22, href: "https://accounts.google.com" },
          ],
        },
      },
      { type: "paragraph", content: { text: "Bills by email", marks: [{ type: "bold", start: 9, end: 14 }] } },
    ]);
  });

  it("righe separate da <br> sono paragrafi diversi; script, stili e immagini non diventano testo", () => {
    const out = blocksFromHtml('<div>one<br>two<style>p{}</style><script>x()</script><img src="x.png" alt="pic"></div>', ids());
    expect(shape(out)).toEqual([
      { type: "paragraph", content: plain("one") },
      { type: "paragraph", content: plain("two") },
    ]);
  });

  it("solo spazi: nessun blocco", () => {
    expect(blocksFromHtml("<p> </p><br>", ids())).toEqual([]);
  });

  it("ogni id (blocchi, righe, celle) dal generatore", () => {
    const out = blocksFromHtml("<h2>A</h2><table><tr><td>x</td></tr></table>", ids());
    expect(out[0]!.id).toBe("b1");
    expect(out[1]).toMatchObject({ type: "table", rows: [{ id: expect.stringMatching(/^b/), cells: [{ id: expect.stringMatching(/^b/) }] }] });
  });
});

describe("blocksFromHtml: la struttura", () => {
  it("titoli: h1–h3 coi loro livelli, h4–h6 valgono 3", () => {
    const out = blocksFromHtml("<h1>Uno</h1><h2>Due</h2><h3>Tre</h3><h4>Quattro</h4><h6>Sei</h6>", ids());
    expect(shape(out)).toEqual([
      { type: "heading", level: 1, content: plain("Uno") },
      { type: "heading", level: 2, content: plain("Due") },
      { type: "heading", level: 3, content: plain("Tre") },
      { type: "heading", level: 3, content: plain("Quattro") },
      { type: "heading", level: 3, content: plain("Sei") },
    ]);
  });

  it("elenchi annidati: puntato e numerato coi rientri, al più tre livelli", () => {
    const html =
      "<ul><li>A<ul><li>A1<ol><li>A1a<ul><li>troppo dentro</li></ul></li></ol></li></ul></li><li>B</li></ul><ol><li>Uno</li></ol>";
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      { type: "bullet", indent: 0, content: plain("A") },
      { type: "bullet", indent: 1, content: plain("A1") },
      { type: "numbered", indent: 2, content: plain("A1a") },
      { type: "bullet", indent: 2, content: plain("troppo dentro") },
      { type: "bullet", indent: 0, content: plain("B") },
      { type: "numbered", indent: 0, content: plain("Uno") },
    ]);
  });

  it("Google Docs: elenchi piatti col livello in aria-level e il tipo nello stile della voce", () => {
    const li = (level: number, type: string, text: string) =>
      `<li dir="ltr" aria-level="${level}" style="list-style-type:${type};font-size:11pt;"><p dir="ltr" role="presentation">${span(text)}</p></li>`;
    const html = GDOC(
      `<ol style="margin-top:0;margin-bottom:0;">${li(1, "decimal", "Introduzione")}${li(1, "decimal", "Requisiti Generali")}</ol>` +
        `<ul style="margin-top:0;">${li(1, "disc", "Rispondere a chiamate")}${li(2, "circle", "in entrata")}</ul>`,
    );
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      { type: "numbered", indent: 0, content: plain("Introduzione") },
      { type: "numbered", indent: 0, content: plain("Requisiti Generali") },
      { type: "bullet", indent: 0, content: plain("Rispondere a chiamate") },
      { type: "bullet", indent: 1, content: plain("in entrata") },
    ]);
  });

  it("caselle da spuntare: role=checkbox (Google Docs) e <input type=checkbox>", () => {
    const html =
      '<ul><li role="checkbox" aria-checked="true">Fatto</li><li role="checkbox" aria-checked="false">Da fare</li></ul>' +
      '<ul><li><input type="checkbox" checked> Spuntata</li></ul>';
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      { type: "todo", checked: true, content: plain("Fatto") },
      { type: "todo", checked: false, content: plain("Da fare") },
      { type: "todo", checked: true, content: plain("Spuntata") },
    ]);
  });

  it("citazione e riga orizzontale", () => {
    const out = blocksFromHtml("<blockquote><p>Detto</p></blockquote><hr><p>Dopo</p>", ids());
    expect(shape(out)).toEqual([
      { type: "quote", content: plain("Detto") },
      { type: "divider" },
      { type: "paragraph", content: plain("Dopo") },
    ]);
  });

  it("tabella: una frase per cella (i paragrafi a capo, i segni restano), righe pareggiate", () => {
    const html =
      '<div dir="ltr"><table><colgroup><col></colgroup><tbody>' +
      "<tr><td><p><b>Funzionalità</b></p></td><td><p>Descrizione</p></td></tr>" +
      "<tr><td><p>Terminare</p><p>chiamate</p></td></tr>" +
      "</tbody></table></div>";
    const out = blocksFromHtml(html, ids());
    expect(shape(out)).toEqual([{ type: "table", rows: [["Funzionalità", "Descrizione"], ["Terminare\nchiamate", ""]] }]);
    const table = out[0] as Extract<ProductBlock, { type: "table" }>;
    expect(table.rows[0]!.cells[0]!.content.marks).toEqual([{ type: "bold", start: 0, end: 12 }]);
  });

  it("codice: <pre> tiene a capo e spazi in testa, niente segni; il linguaggio dalla classe", () => {
    const html = '<pre class="language-json"><code>{\n  "sid": "CA1",\n  <b>"to"</b>: "+39"\n}\n</code></pre>';
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      { type: "code", language: "json", content: plain('{\n  "sid": "CA1",\n  "to": "+39"\n}') },
    ]);
  });

  it("codice senza linguaggio, e <br> dentro un <pre> va a capo", () => {
    expect(shape(blocksFromHtml("<pre>uno<br>due</pre>", ids()))).toEqual([{ type: "code", content: plain("uno\ndue") }]);
  });

  // La forma vera degli appunti di Google Docs (8 nov 2026, «Requisiti
  // Tecnici per Provider di Telefonia VoIP» copiato dal maintainer).
  const mono = (text: string) =>
    `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">` +
    span(text, "font-weight:400;").replace("font-size:11pt;font-family:Arial,sans-serif;", "font-size:11pt;font-family:'Roboto Mono',monospace;") +
    "</p>";

  it("Google Docs: il «Titolo» (26pt) è un titolo di livello 1, il sottotitolo resta un paragrafo", () => {
    const big = span("Requisiti Tecnici", "font-weight:400;").replace("font-size:11pt", "font-size:26pt");
    const sub = span("Scopo: definire i requisiti", "font-weight:400;").replace("font-size:11pt", "font-size:15pt");
    const html = GDOC(`<p dir="ltr" style="margin-top:24pt;">${big}</p><p dir="ltr">${sub}</p><p dir="ltr"><hr /></p><h1>${span("Indice")}</h1>`);
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      { type: "heading", level: 1, content: plain("Requisiti Tecnici") },
      { type: "paragraph", content: plain("Scopo: definire i requisiti") },
      { type: "divider" },
      { type: "heading", level: 1, content: plain("Indice") },
    ]);
  });

  it("Google Docs: i paragrafi a spaziatura fissa in fila sono un blocco di codice, un <br> in mezzo è una riga vuota", () => {
    const html = GDOC(
      `<p dir="ltr">${span("Esempio richiesta webhook:")}</p>` +
        mono("POST /hook HTTP/1.1") +
        mono("Content-Type: application/json") +
        "<br />" +
        mono("{") +
        mono("&nbsp;&nbsp;\"sid\": \"CA1\"") +
        mono("}") +
        "<br />" +
        `<p dir="ltr">${span("Oppure ")}<span style="font-family:'Courier New',monospace;">application/json</span></p>`,
    );
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      { type: "paragraph", content: plain("Esempio richiesta webhook:") },
      // HTTP con dentro un JSON: nel dubbio testo semplice.
      { type: "code", content: plain('POST /hook HTTP/1.1\nContent-Type: application/json\n\n{\n  "sid": "CA1"\n}') },
      // Il codice in mezzo a una frase resta testo: l'editor non ha il codice in linea.
      { type: "paragraph", content: plain("Oppure application/json") },
    ]);
  });

  it("Google Docs: una riga di soli spazi dentro il codice è una riga vuota, non lo spezza", () => {
    const html = GDOC(mono("a") + mono("&nbsp;&nbsp;") + mono("b"));
    expect(shape(blocksFromHtml(html, ids()))).toEqual([{ type: "code", content: plain("a\n\nb") }]);
  });

  it("Google Docs: due blocchi di codice separati da una frase restano due", () => {
    const html = GDOC(mono("&lt;Response/&gt;") + `<p dir="ltr">${span("JSON alternativo:")}</p>` + mono("{}"));
    expect(shape(blocksFromHtml(html, ids()))).toEqual([
      { type: "code", language: "xml", content: plain("<Response/>") },
      { type: "paragraph", content: plain("JSON alternativo:") },
      { type: "code", language: "json", content: plain("{}") },
    ]);
  });

  it("l'ordine della pagina: titolo, paragrafo, elenco, tabella, codice", () => {
    const html =
      "<h2>2.1 API REST</h2><p>Il provider deve esporre:</p><ul><li>chiamate</li></ul>" +
      "<table><tr><td>a</td><td>b</td></tr></table><pre>x</pre><p>fine</p>";
    expect(blocksFromHtml(html, ids()).map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "bullet",
      "table",
      "code",
      "paragraph",
    ]);
  });
});
