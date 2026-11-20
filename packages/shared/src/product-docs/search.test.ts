import { describe, expect, it } from "vitest";
import { PRODUCT_PASSAGE_MAX, foldSearchText, productPassage, productSearchWords } from "./search.js";

describe("la ricerca nelle pagine di prodotto (area 11, F3)", () => {
  it("piega maiuscole e accenti, e spezza le parole", () => {
    expect(foldSearchText("Caffè PERCHÉ")).toBe("caffe perche");
    expect(productSearchWords("  Caffè   lungo ")).toEqual(["caffe", "lungo"]);
  });

  it("il passaggio è la riga che contiene una parola; senza, l'estratto; sempre una riga", () => {
    expect(productPassage(["Prima riga", "Il caffè è pronto"], ["caffe"], "Estratto")).toBe("Il caffè è pronto");
    expect(productPassage(["Niente"], ["caffe"], "L'estratto\ndella pagina")).toBe("L'estratto della pagina");
  });

  it("una riga lunga si taglia intorno alla parola, al più 160 caratteri più i «…»", () => {
    const line = `${"a ".repeat(150)}caffè ${"b ".repeat(150)}`;
    const out = productPassage([line], ["caffe"], "");
    expect(out).toContain("caffè");
    expect(out.startsWith("…")).toBe(true);
    expect(out.replace(/…/g, "").length).toBeLessThanOrEqual(PRODUCT_PASSAGE_MAX);
  });
});
