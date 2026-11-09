import { describe, expect, it } from "vitest";
import { effortFromSize, sizeFromEffort, TASK_SIZES } from "./sizes.js";

describe("taglie ↔ sforzo", () => {
  it("1→XS … 5→XL", () => {
    expect([1, 2, 3, 4, 5].map(sizeFromEffort)).toEqual(["XS", "S", "M", "L", "XL"]);
  });

  it("null resta null in entrambi i versi", () => {
    expect(sizeFromEffort(null)).toBeNull();
    expect(effortFromSize(null)).toBeNull();
  });

  it("andata e ritorno", () => {
    for (const size of TASK_SIZES) expect(sizeFromEffort(effortFromSize(size))).toBe(size);
    for (const effort of [1, 2, 3, 4, 5]) expect(effortFromSize(sizeFromEffort(effort))).toBe(effort);
  });

  it("uno sforzo fuori scala non ha taglia", () => {
    expect(sizeFromEffort(0)).toBeNull();
    expect(sizeFromEffort(6)).toBeNull();
  });
});
