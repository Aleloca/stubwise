import { describe, expect, it } from "vitest";
import { planDigest } from "./plan-digest.js";

describe("planDigest", () => {
  it("è deterministico: stesso testo → stesso digest", () => {
    const text = "## Piano\n1. fai questo\n2. poi quello";
    expect(planDigest(text)).toBe(planDigest(text));
  });

  it("un carattere diverso produce un digest diverso", () => {
    expect(planDigest("## Piano\n1. fai questo")).not.toBe(planDigest("## Piano\n1. fai questa"));
  });

  it("è un esadecimale SHA-256 (64 caratteri)", () => {
    expect(planDigest("piano")).toMatch(/^[0-9a-f]{64}$/);
  });
});
