import { describe, expect, it } from "vitest";
import type { Task } from "../data/model";
import { familyOfStub, makeTask } from "./fixtures";
import { SIZE_WEIGHT, load, progress, usualWeekWeight } from "./load";

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

describe("usualWeekWeight", () => {
  const at = (plannedWeek: string, size: Task["size"], statusId = "s-closed") =>
    makeTask({ plannedWeek, size, statusId });

  it("la mediana delle 6 settimane prima, esclusa quella corrente, aperte e chiuse", () => {
    const tasks = [
      at("2026-W43", "XL"), // la settimana corrente non conta
      at("2026-W42", "L"),
      at("2026-W42", "S", "s-active"), // 7
      at("2026-W41", "M"), // 3
      at("2026-W40", "XL"), // 8
      at("2026-W36", "XL"), // fuori dalla finestra di 6
      at("2026-W39", null), // senza stima: la settimana non conta
    ];
    expect(usualWeekWeight(tasks, "2026-W43")).toBe(7);
  });

  it("con un numero pari di settimane, la media delle due centrali", () => {
    expect(usualWeekWeight([at("2026-W42", "XL"), at("2026-W41", "M")], "2026-W43")).toBe(5.5);
  });

  it("meno di due settimane con lavoro stimato: nessuna settimana solita", () => {
    expect(usualWeekWeight([], "2026-W43")).toBeNull();
    expect(usualWeekWeight([at("2026-W42", "L"), at("2026-W42", "M")], "2026-W43")).toBeNull();
  });
});
