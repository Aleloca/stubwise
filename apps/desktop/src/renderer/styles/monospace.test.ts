import { describe, expect, it } from "vitest";

// Il monospace dell'app (DESIGN.md, «Typography»): il logo («font-logo») e i
// letterali che si scrivono in un terminale o in un file («font-code»). Una
// chiave, un ramo o un comando hanno lo stesso carattere su ogni pagina.
// `font-mono` invece è mappato alla sans (tokens.css): chi lo scrive crede di
// avere un monospace e ha Archivo, quindi lo stesso valore cambia carattere
// da una pagina all'altra (rifinitura 11 della revisione finale del 9c).

const SOURCES = import.meta.glob(["../**/*.tsx", "!**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("il monospace", () => {
  it("trova i sorgenti", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it("SecretField non usa font-mono: la chiave che si incolla è font-code", () => {
    // Le righe di codice, non i commenti che spiegano l'alias.
    const lines = SOURCES["../components/SecretField.tsx"]!.split("\n").filter(
      (line) => /\bfont-mono\b/.test(line) && !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line),
    );
    expect(lines).toEqual([]);
  });

  it("una chiave mascherata è font-code su ogni pagina", () => {
    const lines = Object.entries(SOURCES).flatMap(([path, source]) =>
      source
        .split("\n")
        .filter((line) => /<span[^>]*>\{maskedSecret\(/.test(line))
        .filter((line) => !line.includes("font-code"))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(lines).toEqual([]);
  });
});
