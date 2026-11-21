import { describe, expect, it } from "vitest";
import { sanitizeWireframeSvg, WIREFRAME_SVG_MAX } from "./sanitize-wireframe.js";

// Area 11, F6: lo SVG di una bozza di schermata lo disegna il modello, da
// fonti non fidate. Il server lo RIPULISCE prima di salvarlo, con
// un'allowlist chiusa di elementi e attributi, e lo ricostruisce da zero:
// quello che non è nell'elenco non esce, e una struttura che non regge si scarta.

const clean = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640"><rect x="0" y="0" width="360" height="56" fill="#eeeeee" stroke="#333"/><text x="16" y="34" font-size="16">Checkout &amp; pay</text><g transform="translate(0,80)"><line x1="0" y1="0" x2="360" y2="0" stroke="#999" stroke-dasharray="4 2"/><path d="M10 10 L20 20 Z" fill="none"/></g></svg>`;

describe("sanitizeWireframeSvg", () => {
  it("un wireframe pulito passa uguale (a meno della forma canonica)", () => {
    const out = sanitizeWireframeSvg(clean)!;
    expect(out).toBe(clean);
    expect(sanitizeWireframeSvg(out)).toBe(out);
  });

  it.each([
    ["script", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>`],
    ["foreignObject", `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>`],
    ["use esterno", `<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>`],
    ["image", `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png"/></svg>`],
    ["a con javascript:", `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>`],
    ["style", `<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://evil.example)}</style></svg>`],
  ])("%s: l'elemento non esce", (_name, svg) => {
    const out = sanitizeWireframeSvg(svg);
    expect(out === null || !/script|foreignObject|<use|<image|<a[ >]|<style|evil\.example|javascript:/i.test(out)).toBe(true);
  });

  it.each([
    ["onload", `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1" onclick="x()"/></svg>`],
    ["xlink:href", `<svg xmlns="http://www.w3.org/2000/svg"><rect xlink:href="https://evil.example" width="1" height="1"/></svg>`],
    ["style con url(", `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example)" width="1" height="1"/></svg>`],
    ["fill con url(", `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example#g)" width="1" height="1"/></svg>`],
    ["javascript: in un valore", `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="javascript:alert(1)" width="1" height="1"/></svg>`],
  ])("%s: l'attributo non esce", (_name, svg) => {
    const out = sanitizeWireframeSvg(svg);
    expect(out === null || !/onload|onclick|xlink|style=|url\(|javascript:|evil\.example/i.test(out)).toBe(true);
  });

  it.each([
    ["un commento", `<svg xmlns="http://www.w3.org/2000/svg"><!-- x --><rect width="1" height="1"/></svg>`],
    ["un DOCTYPE con entità", `<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`],
    ["una CDATA", `<svg xmlns="http://www.w3.org/2000/svg"><text><![CDATA[<script>]]></text></svg>`],
    ["un'istruzione", `<?xml-stylesheet href="https://evil.example/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>`],
    ["tag non chiusi", `<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></svg>`],
    ["tag incrociati", `<svg xmlns="http://www.w3.org/2000/svg"><g><text></g></text></svg>`],
    ["una radice che non è svg", `<g><rect width="1" height="1"/></g>`],
    ["due radici", `<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>`],
    ["un'entità sconosciuta", `<svg xmlns="http://www.w3.org/2000/svg"><text>&nbsp;</text></svg>`],
    ["un namespace diverso", `<svg xmlns="http://www.w3.org/1999/xhtml"><rect width="1" height="1"/></svg>`],
  ])("%s: si scarta", (_name, svg) => {
    expect(sanitizeWireframeSvg(svg)).toBeNull();
  });

  it("troppo grande: si scarta", () => {
    const big = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(WIREFRAME_SVG_MAX / 20)}</svg>`;
    expect(sanitizeWireframeSvg(big)).toBeNull();
  });

  it("il testo si riscrive escapato: un `<` dentro un testo non apre un tag", () => {
    expect(sanitizeWireframeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><text>a &lt;script&gt; b</text></svg>`)).toBe(`<svg xmlns="http://www.w3.org/2000/svg"><text>a &lt;script&gt; b</text></svg>`);
  });
});
