import { describe, expect, it } from "vitest";
import type { ProductBlock, RichText } from "../schemas/product-docs.js";
import { backlogCandidatesOf } from "./backlog.js";

// Area 11, F6: le voci di backlog che una pagina propone (il prototipo:
// `domain/productDocs/backlog.ts`, spostato qui perché lo usa il server).

const plain = (text: string): RichText => ({ text, marks: [] });
const blocks: ProductBlock[] = [
  { id: "a", type: "paragraph", content: plain("What goes out when.") },
  { id: "h1", type: "heading", level: 2, content: plain("Phase 1") },
  { id: "b", type: "bullet", indent: 0, content: plain("  Customers download bills as PDF  ") },
  { id: "c", type: "paragraph", content: plain("Not a list item.") },
  { id: "h1a", type: "heading", level: 3, content: plain("Later in phase 1") },
  { id: "d", type: "todo", checked: false, content: plain("Meter readings from the app") },
  { id: "h2", type: "heading", level: 2, content: plain("Phase 2") },
  { id: "e", type: "numbered", indent: 1, content: plain("Fault reports with a photo") },
  { id: "f", type: "todo", checked: true, content: plain("   ") },
];

describe("backlogCandidatesOf", () => {
  it("voci di elenco e liste di controllo della pagina: titolo e descrizione sono la frase, senza pagina né sezione (R-G5)", () => {
    expect(backlogCandidatesOf(blocks, null).map((c) => [c.anchorId, c.title, c.description, c.sentence])).toEqual([
      ["b", "Customers download bills as PDF", "Customers download bills as PDF", "Customers download bills as PDF"],
      ["d", "Meter readings from the app", "Meter readings from the app", "Meter readings from the app"],
      ["e", "Fault reports with a photo", "Fault reports with a photo", "Fault reports with a photo"],
    ]);
  });

  it("la sola sezione di un titolo: fino al titolo dello stesso livello, sotto-titoli compresi; un'ancora che non è un titolo non ha sezione", () => {
    expect(backlogCandidatesOf(blocks, "h1").map((c) => c.anchorId)).toEqual(["b", "d"]);
    expect(backlogCandidatesOf(blocks, "h1a").map((c) => c.anchorId)).toEqual(["d"]);
    expect(backlogCandidatesOf(blocks, "h2").map((c) => c.anchorId)).toEqual(["e"]);
    expect(backlogCandidatesOf(blocks, "b")).toEqual([]);
    expect(backlogCandidatesOf(blocks, "nope")).toEqual([]);
  });

  it("un titolo lungo si taglia a 120 con «…»; la descrizione tiene la frase intera", () => {
    const long = "x".repeat(300);
    const [c] = backlogCandidatesOf([{ id: "l", type: "bullet", indent: 0, content: plain(long) }], null);
    expect(c!.title).toHaveLength(120);
    expect(c!.title.endsWith("…")).toBe(true);
    expect(c!.description).toBe(long);
  });
});
