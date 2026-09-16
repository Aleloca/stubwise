import { describe, expect, it } from "vitest";
import { plainSearchSnippet, searchSnippetSegments } from "./search-snippet.js";

/**
 * Il difetto che ha fatto nascere questo modulo (16 set 2026): l'app mostrava
 * `<b>` scritto in chiaro nelle righe della ricerca — «sia nell'anteprima
 * delle mail che qui vedo i tag tipo "<b>"». Il web li toglieva da sempre, in
 * una funzione che viveva solo lì dentro.
 */
describe("searchSnippetSegments", () => {
  it("separa il pezzo che ha combaciato dal resto", () => {
    expect(searchSnippetSegments("durante l'<b>export</b> del CSV")).toEqual([
      { text: "durante l'", highlighted: false },
      { text: "export", highlighted: true },
      { text: " del CSV", highlighted: false },
    ]);
  });

  it("⚠️ NON mangia lo spazio dopo il pezzo evidenziato", () => {
    // La ragione per cui la pulizia gira sull'intera stringa e non segmento
    // per segmento: rifilando ogni pezzo per conto suo, «del» si
    // attaccherebbe a «export».
    const testo = searchSnippetSegments("durante l'<b>export</b> del CSV")
      .map((s) => s.text)
      .join("");
    expect(testo).toBe("durante l'export del CSV");
  });

  it("regge più pezzi evidenziati, e uno in apertura", () => {
    expect(searchSnippetSegments("<b>errore</b> grave: <b>errore</b> di rete")).toEqual([
      { text: "errore", highlighted: true },
      { text: " grave: ", highlighted: false },
      { text: "errore", highlighted: true },
      { text: " di rete", highlighted: false },
    ]);
  });

  it("toglie il markdown, che è il caso che il maintainer non aveva ancora visto", () => {
    // I `<b>` sono i più frequenti, ma lo snippet è ritagliato da corpi di
    // ticket e pagine Docs: backtick, heading e link ci finiscono dentro.
    expect(plainSearchSnippet("## Titolo\n\nusa `npm run build` e vedi [la guida](http://x.test)")).toBe(
      "Titolo usa npm run build e vedi la guida",
    );
  });

  it("markdown ed evidenziazione insieme", () => {
    expect(searchSnippetSegments("esegui `pnpm <b>build</b>` come **sempre**")).toEqual([
      { text: "esegui pnpm ", highlighted: false },
      { text: "build", highlighted: true },
      { text: " come sempre", highlighted: false },
    ]);
  });

  it("un marcatore spaiato non resta visibile", () => {
    // `ts_headline` non li produce, ma un troncamento a monte sì — e il punto
    // di questo modulo è che un `<b>` non arrivi MAI sullo schermo.
    expect(plainSearchSnippet("testo <b>troncato a metà")).toBe("testo troncato a metà");
  });

  it("uno snippet senza nulla da evidenziare resta un segmento solo", () => {
    expect(searchSnippetSegments("nessun marcatore qui")).toEqual([
      { text: "nessun marcatore qui", highlighted: false },
    ]);
  });

  it("una stringa vuota dà zero segmenti, non un segmento vuoto", () => {
    expect(searchSnippetSegments("")).toEqual([]);
    expect(plainSearchSnippet("")).toBe("");
  });

  it("concatenare i segmenti dà sempre la versione piatta", () => {
    const raw = "## Errore\n\nl'<b>export</b> del `CSV` fallisce su [prod](http://x.test)";
    expect(searchSnippetSegments(raw).map((s) => s.text).join("")).toBe(plainSearchSnippet(raw));
  });
});
