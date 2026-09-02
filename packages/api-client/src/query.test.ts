import { describe, expect, it } from "vitest";
import { seg, toQuery } from "./query.js";

describe("toQuery", () => {
  it("omette i parametri assenti E quelli vuoti", () => {
    // La distinzione non è cosmetica: `statuses=` vuoto è un 400 (vedi
    // `TicketFilters.statuses`), quindi "assente" e "vuoto" non coincidono.
    expect(toQuery({ a: undefined, b: "", c: "x" })).toBe("?c=x");
    expect(toQuery({ a: undefined })).toBe("");
  });

  it("lascia passare lo zero, che è un valore e non un'assenza", () => {
    expect(toQuery({ limit: 0 })).toBe("?limit=0");
  });

  it("codifica spazi e caratteri riservati", () => {
    expect(toQuery({ q: "a b&c" })).toBe("?q=a+b%26c");
  });
});

describe("seg", () => {
  it("codifica i caratteri che spezzerebbero il path", () => {
    // Uno slug di pagina docs può contenere una barra: senza encoding
    // diventerebbe un segmento in più e la rotta non combacerebbe.
    expect(seg("guida/avvio")).toBe("guida%2Favvio");
    expect(seg("a b")).toBe("a%20b");
  });
});
