import { describe, it, expect } from "vitest";
import { generatePat, hashServerKey } from "./shared.js";

describe("generatePat", () => {
  it("produce un token con prefisso stw_pat_ e 48 hex", () => {
    const t = generatePat();
    expect(t).toMatch(/^stw_pat_[0-9a-f]{48}$/);
  });
  it("token diversi hanno hash diversi, stesso token stesso hash", () => {
    const a = generatePat();
    expect(hashServerKey(a)).toBe(hashServerKey(a));
    expect(hashServerKey(a)).not.toBe(hashServerKey(generatePat()));
  });
});
