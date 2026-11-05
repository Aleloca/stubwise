import { describe, expect, it } from "vitest";
import { fitFileName } from "./saveFile";

// Il nome proposto per un'esportazione (fix round 1, I1): il processo
// principale rifiuta un nome oltre 120 caratteri, e un titolo di pagina non
// ha tetto. Il renderer lo accorcia prima: con l'estensione del formato il
// nome resta entro 120, tagliato fra due parole (o fra due caratteri, se una
// parola sola è troppo lunga), mai a metà di una coppia surrogata.

const MAX = 120;

describe("fitFileName", () => {
  it("un nome corto resta com'è", () => {
    expect(fitFileName("ACQ-D5 Sign-in", "pdf")).toBe("ACQ-D5 Sign-in");
  });

  it("un titolo lungo si taglia fra due parole: col .docx entro 120, ed è un inizio del nome", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const name = `ACQ-D5 ${words}`;
    for (const format of ["pdf", "docx"] as const) {
      const fitted = fitFileName(name, format);
      expect(`${fitted}.${format}`.length).toBeLessThanOrEqual(MAX);
      expect(name.startsWith(fitted)).toBe(true);
      // Il taglio cade davanti a uno spazio: nessuna parola a metà.
      expect(name[fitted.length]).toBe(" ");
      expect(fitted).toMatch(/^ACQ-D5 word0 /);
      expect(fitted.length).toBeGreaterThan(MAX - 20);
    }
  });

  it("una parola sola troppo lunga si taglia fra due caratteri, mai a metà di un'emoji", () => {
    expect(fitFileName("a".repeat(300), "docx")).toBe("a".repeat(MAX - 5));
    const emoji = fitFileName("😀".repeat(200), "pdf");
    expect(`${emoji}.pdf`.length).toBeLessThanOrEqual(MAX);
    expect([...emoji].every((c) => c === "😀")).toBe(true);
  });

  it("niente spazi, punti o trattini lasciati in coda dal taglio", () => {
    const name = `${"x".repeat(100)} - .. ${"y".repeat(30)}`;
    const fitted = fitFileName(name, "pdf");
    expect(fitted).toBe("x".repeat(100));
  });
});
