import { describe, expect, it } from "vitest";
import { PRODUCT_QUOTE_MAX, cleanQuote } from "./comments.js";

describe("cleanQuote (area 11, F2)", () => {
  it("toglie gli spazi ai lati e fa di più righe una riga sola", () => {
    expect(cleanQuote("  Prima riga\n\n  seconda\triga  ")).toBe("Prima riga seconda riga");
  });

  it("taglia a 200 caratteri con «…», e lascia com'è una frase corta", () => {
    const long = "a".repeat(250);
    const out = cleanQuote(long);
    expect(out).toHaveLength(PRODUCT_QUOTE_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(cleanQuote("a".repeat(200))).toBe("a".repeat(200));
  });
});
