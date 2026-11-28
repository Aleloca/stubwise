import { describe, expect, it } from "vitest";
import { truncateText } from "./truncate.js";

describe("truncateText", () => {
  it("un testo corto resta com'è", () => {
    expect(truncateText("ciao", 10)).toBe("ciao");
  });

  it("tronca con l'ellissi dentro il tetto", () => {
    const out = truncateText("una frase abbastanza lunga", 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it("non spezza una coppia di surrogati (un'emoji resta intera o fuori)", () => {
    const out = truncateText("ab😀😀😀😀", 5);
    expect(out).toBe("ab😀…");
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});
