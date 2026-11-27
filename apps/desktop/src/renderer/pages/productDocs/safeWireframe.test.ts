import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_WIREFRAMES } from "../../data/seed/productDocs/wireframes";
import { safeWireframeSvg } from "./safeWireframe";

// Revisione di sicurezza della cassaforte nel browser, M3 (27 nov 2026): lo
// SVG di una bozza di schermata entra nel documento con
// `dangerouslySetInnerHTML`. Il server lo ripulisce già prima di salvarlo; il
// client lo ripulisce di nuovo prima di disegnarlo (difesa in profondità: un
// server di prima, una riga scritta a mano, un SVG del seme).

describe("safeWireframeSvg", () => {
  it.each([
    ["script", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>`],
    ["onload", `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>`],
    ["foreignObject", `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>`],
    ["a javascript:", `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>`],
  ])("%s non arriva al documento", (_name, svg) => {
    const out = safeWireframeSvg(svg);
    expect(out === null || !/script|onload|onerror|foreignObject|javascript:/i.test(out)).toBe(true);
  });

  it("null resta null", () => {
    expect(safeWireframeSvg(null)).toBeNull();
  });

  it("ogni SVG del seme sopravvive alla pulizia (gli schizzi non spariscono)", () => {
    for (const [id, w] of Object.entries(PRODUCT_WIREFRAMES)) {
      w.variants.forEach((svg, i) => expect(safeWireframeSvg(svg), `${id}:${i}`).not.toBeNull());
    }
  });

  it("i due punti che disegnano uno schizzo passano dall'helper", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ["editor/WireframeBlock.tsx", "export/PrintView.tsx"]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).toMatch(/safeWireframeSvg\(/);
    }
  });
});
