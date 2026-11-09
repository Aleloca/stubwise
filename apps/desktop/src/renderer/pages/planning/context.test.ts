import { describe, expect, it } from "vitest";
import { chipKey, dragId, dragTaskId, spotId, spotOf, type Spot } from "./context";

const pool: Spot = { kind: "pool" };
const cell: Spot = { kind: "cell", personId: "p-matteo", week: "2026-W43" };

describe("id del trascinamento", () => {
  it("le due copie di una slittata hanno id diversi e portano la stessa task", () => {
    expect(dragId(pool, "t-mkx-5")).not.toBe(dragId(cell, "t-mkx-5"));
    // Come dnd-kit passa `active` a onDragStart/onDragEnd: la task viene dai dati.
    const fromPool = { id: dragId(pool, "t-mkx-5"), data: { current: { spot: pool, taskId: "t-mkx-5" } } };
    const fromCell = { id: dragId(cell, "t-mkx-5"), data: { current: { spot: cell, taskId: "t-mkx-5" } } };
    expect(dragTaskId(fromPool)).toBe("t-mkx-5");
    expect(dragTaskId(fromCell)).toBe("t-mkx-5");
    expect(dragTaskId({ data: { current: null } })).toBeNull();
  });

  it("un id di trascinamento non è mai un bersaglio", () => {
    expect(spotOf(dragId(cell, "t-mkx-5"))).toBeNull();
    expect(spotOf(spotId(cell))).toEqual(cell);
    expect(spotOf("pool")).toEqual(pool);
  });

  it("la chiave della copia distingue il posto", () => {
    expect(chipKey(pool, "MKX-5")).not.toBe(chipKey(cell, "MKX-5"));
  });
});
