import { describe, expect, it } from "vitest";
import { dropAfter } from "./blockOps";

// Dove cade un blocco trascinato per ⋮⋮ (shape [PE 4]): il blocco prima di
// cui va (`afterId`), o `null` se torna dov'era (nessuna scrittura).

const IDS = ["a", "b", "c", "d"];

describe("dropAfter", () => {
  it("salendo va prima del blocco su cui cade", () => {
    expect(dropAfter(IDS, "d", "b")).toEqual({ afterId: "a", edge: "top" });
    expect(dropAfter(IDS, "c", "a")).toEqual({ afterId: null, edge: "top" });
  });

  it("scendendo va dopo il blocco su cui cade", () => {
    expect(dropAfter(IDS, "a", "c")).toEqual({ afterId: "c", edge: "bottom" });
    expect(dropAfter(IDS, "b", "d")).toEqual({ afterId: "d", edge: "bottom" });
  });

  it("su sé stesso, o un id che non c'è: null (resta dov'era)", () => {
    expect(dropAfter(IDS, "b", "b")).toBeNull();
    expect(dropAfter(IDS, "b", "z")).toBeNull();
    expect(dropAfter(IDS, "z", "b")).toBeNull();
  });
});
