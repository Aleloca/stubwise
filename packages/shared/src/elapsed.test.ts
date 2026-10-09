import { describe, expect, it } from "vitest";
import { elapsedParts } from "./elapsed.js";

describe("elapsedParts", () => {
  it("conta da startedAt, mai negativo", () => {
    const start = "2026-10-09T10:00:00.000Z";
    expect(elapsedParts(start, Date.parse("2026-10-09T11:05:00.000Z"))).toEqual({
      hours: 1,
      minutes: 5,
    });
    expect(elapsedParts(start, Date.parse("2026-10-09T09:00:00.000Z"))).toEqual({
      hours: 0,
      minutes: 0,
    });
  });
});
