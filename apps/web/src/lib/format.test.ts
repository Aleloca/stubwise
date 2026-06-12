import { describe, expect, it } from "vitest";
import { deriveFullName } from "./format";

describe("deriveFullName", () => {
  it("ricava owner/repo da un URL https", () => {
    expect(deriveFullName("https://github.com/acme/demo")).toBe("acme/demo");
  });

  it("toglie il suffisso .git e lo slash finale", () => {
    expect(deriveFullName("https://github.com/acme/demo.git")).toBe("acme/demo");
    expect(deriveFullName("https://github.com/acme/demo/")).toBe("acme/demo");
    expect(deriveFullName("https://github.com/acme/demo.git/")).toBe("acme/demo");
  });

  it("usa gli ultimi due segmenti per host con path più profondi", () => {
    expect(deriveFullName("https://bitbucket.org/team/acme/demo")).toBe("acme/demo");
  });

  it("ritorna null su URL non parsabili o con un solo segmento", () => {
    expect(deriveFullName("non-un-url")).toBeNull();
    expect(deriveFullName("https://github.com/acme")).toBeNull();
    expect(deriveFullName("")).toBeNull();
    expect(deriveFullName("   ")).toBeNull();
  });
});
