import { describe, expect, it } from "vitest";
import { usd } from "./money";

// Un solo formato dei dollari in tutta l'app (Impeccable 7): il simbolo «$»
// davanti e i separatori della lingua di chi guarda.

describe("usd", () => {
  it("con i centesimi: separatori della lingua, simbolo davanti", () => {
    expect(usd(410.05, "it", "always")).toBe("$410,05");
    expect(usd(1.39, "it", "always")).toBe("$1,39");
    expect(usd(1234.5, "en", "always")).toBe("$1,234.50");
    expect(usd(1234.5, "it", "always")).toBe("$1234,50");
  });

  it("automatici: gli interi senza decimali, gli altri con due", () => {
    expect(usd(50, "it")).toBe("$50");
    expect(usd(600, "en")).toBe("$600");
    expect(usd(2.5, "it")).toBe("$2,50");
    expect(usd(12000, "en")).toBe("$12,000");
  });
});
