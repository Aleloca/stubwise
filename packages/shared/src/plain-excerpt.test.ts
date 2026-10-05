import { describe, expect, it } from "vitest";
import { plainExcerpt } from "./plain-excerpt.js";

describe("plainExcerpt", () => {
  it("toglie link, grassetto e codice", () => {
    expect(plainExcerpt("Vedi **la PR** [#4](https://x.test/pr/4) e `npm test`", 120)).toBe(
      "Vedi la PR #4 e npm test",
    );
  });

  it("un testo entro il limite resta intero, senza «…»", () => {
    expect(plainExcerpt("Fix automatico pronto", 120)).toBe("Fix automatico pronto");
  });

  it("taglia su un confine di parola e aggiunge «…»", () => {
    const out = plainExcerpt("uno due tre quattro cinque", 12);
    expect(out).toBe("uno due tre…");
    expect(out.length).toBeLessThanOrEqual(13);
  });

  it("una parola sola più lunga del limite si taglia comunque", () => {
    expect(plainExcerpt("abcdefghijklmnop", 5)).toBe("abcde…");
  });

  it("le righe si collassano in una", () => {
    expect(plainExcerpt("prima riga\n\nseconda riga", 120)).toBe("prima riga seconda riga");
  });
});
