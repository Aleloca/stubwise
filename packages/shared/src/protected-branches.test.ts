import { describe, expect, it } from "vitest";
import { isAdoptedBranchProtected, isProtectedBranch, protectedBranchesInputSchema } from "./protected-branches.js";

describe("isProtectedBranch — la regola unica dei branch protetti", () => {
  it("lista vuota: niente è protetto (il comportamento di prima)", () => {
    expect(isProtectedBranch("develop", [])).toBe(false);
  });

  it("nome esatto: combacia solo quel nome", () => {
    expect(isProtectedBranch("develop", ["develop"])).toBe(true);
    expect(isProtectedBranch("develop-2", ["develop"])).toBe(false);
    expect(isProtectedBranch("feature/develop", ["develop"])).toBe(false);
  });

  it("`*` finale: prefisso", () => {
    expect(isProtectedBranch("release/1.2", ["release/*"])).toBe(true);
    expect(isProtectedBranch("release/", ["release/*"])).toBe(true);
    expect(isProtectedBranch("releases/1.2", ["release/*"])).toBe(false);
    expect(isProtectedBranch("hotfix-1", ["hotfix*"])).toBe(true);
  });

  it("maiuscole distinte, come in git", () => {
    expect(isProtectedBranch("Develop", ["develop"])).toBe(false);
  });

  it("una voce malformata (salvata prima della validazione) non protegge per caso tutto il resto", () => {
    expect(isProtectedBranch("feature/x", ["fea*ture"])).toBe(false);
  });
});

describe("protectedBranchesInputSchema — normalizzazione dell'input", () => {
  it("toglie spazi ai bordi, voci vuote e doppioni", () => {
    expect(protectedBranchesInputSchema.parse(["  develop ", "", "   ", "develop", "release/*"])).toEqual([
      "develop",
      "release/*",
    ]);
  });

  it.each([
    ["spazio in mezzo", "dev elop"],
    ["`*` non finale", "rel*ease"],
    ["doppio punto", "a..b"],
    ["segmento vuoto", "a//b"],
    ["inizia con -", "-x"],
    ["troppo lungo", "a".repeat(201)],
  ])("rifiuta %s", (_label, value) => {
    expect(protectedBranchesInputSchema.safeParse([value]).success).toBe(false);
  });

  it("al più 50 voci", () => {
    const many = Array.from({ length: 51 }, (_, i) => `b${i}`);
    expect(protectedBranchesInputSchema.safeParse(many).success).toBe(false);
    expect(protectedBranchesInputSchema.safeParse(many.slice(0, 50)).success).toBe(true);
  });
});

describe("isAdoptedBranchProtected — una PR adottata il cui branch è protetto (7 ott 2026)", () => {
  const adopted = { branch: "feature/login", adoptedAt: new Date(), adoptionReleasedAt: null };

  it("adottata e branch protetto: vero", () => {
    expect(isAdoptedBranchProtected(adopted, ["feature/*"])).toBe(true);
  });

  it("adottata ma branch non protetto: falso", () => {
    expect(isAdoptedBranchProtected(adopted, ["develop"])).toBe(false);
  });

  it("adozione rilasciata, o mai adottata: falso anche col branch protetto", () => {
    expect(isAdoptedBranchProtected({ ...adopted, adoptionReleasedAt: new Date() }, ["feature/*"])).toBe(false);
    expect(isAdoptedBranchProtected({ ...adopted, adoptedAt: null }, ["feature/*"])).toBe(false);
  });

  it("branch assente: falso (non si inventa)", () => {
    expect(isAdoptedBranchProtected({ ...adopted, branch: null }, ["*"])).toBe(false);
  });
});
