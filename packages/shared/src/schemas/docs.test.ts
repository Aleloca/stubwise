import { describe, expect, it } from "vitest";
import { docPageKindSchema } from "./docs.js";

describe("docPageKindSchema", () => {
  it("accetta i kind autogenerati e curati esistenti", () => {
    for (const kind of ["technical", "functional", "manual", "releases"] as const) {
      expect(docPageKindSchema.parse(kind)).toBe(kind);
    }
  });

  it("accetta il kind 'product' (verticali pubbliche per superficie)", () => {
    expect(docPageKindSchema.parse("product")).toBe("product");
  });

  it("rifiuta un kind sconosciuto", () => {
    expect(() => docPageKindSchema.parse("marketing")).toThrow();
  });
});
