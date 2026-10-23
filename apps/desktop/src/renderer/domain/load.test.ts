import { describe, expect, it } from "vitest";
import { familyOfStub, makeTask } from "./fixtures";
import { SIZE_WEIGHT, load, progress } from "./load";

describe("load", () => {
  it("pesa le taglie 1 2 3 5 8", () => {
    expect(SIZE_WEIGHT).toEqual({ XS: 1, S: 2, M: 3, L: 5, XL: 8 });
  });

  it("somma i pesi e conta a parte le senza stima", () => {
    const tasks = [
      makeTask({ size: "M" }),
      makeTask({ size: "L" }),
      makeTask({ size: null }),
      makeTask({ size: null }),
    ];
    expect(load(tasks)).toEqual({ weight: 8, count: 4, unsized: 2 });
  });

  it("vuoto = zeri", () => {
    expect(load([])).toEqual({ weight: 0, count: 0, unsized: 0 });
  });
});

describe("progress", () => {
  it("il peso chiuso su quello totale, senza stima fuori dai pesi", () => {
    const tasks = [
      makeTask({ size: "M", statusId: "s-closed" }),
      makeTask({ size: "XL", statusId: "s-active" }),
      makeTask({ size: "XS", statusId: "s-todo" }),
      makeTask({ size: null, statusId: "s-closed" }),
    ];
    expect(progress(tasks, familyOfStub)).toEqual({ doneWeight: 3, totalWeight: 12, unsized: 1 });
  });

  it("vuoto = zeri", () => {
    expect(progress([], familyOfStub)).toEqual({ doneWeight: 0, totalWeight: 0, unsized: 0 });
  });
});
