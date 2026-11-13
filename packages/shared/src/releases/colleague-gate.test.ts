import { describe, expect, it } from "vitest";
import { colleagueCorrectionAllowed } from "./colleague-gate.js";

const base = { mode: "analyze_and_fix", prAnalysisOnly: false, explicitlyAdopted: false } as const;

describe("colleagueCorrectionAllowed", () => {
  it("«spento» sul repository: niente, nemmeno chiesta o adottata", () => {
    for (const trigger of ["automatic", "provider", "requested"] as const) {
      expect(colleagueCorrectionAllowed({ ...base, mode: "off", explicitlyAdopted: true, trigger })).toBe(false);
    }
  });

  it("«Solo analisi» sulla PR: niente, nemmeno chiesta o adottata", () => {
    for (const trigger of ["automatic", "provider", "requested"] as const) {
      expect(colleagueCorrectionAllowed({ ...base, prAnalysisOnly: true, explicitlyAdopted: true, trigger })).toBe(false);
    }
  });

  it("«solo analisi» sul repository: niente giro automatico né «Request changes» della piattaforma; «Chiedi modifiche» in Stubwise sì", () => {
    expect(colleagueCorrectionAllowed({ ...base, mode: "analyze_only", trigger: "automatic" })).toBe(false);
    // (O, 46): un revisore qualunque sulla piattaforma non fa pushare sul ramo di chi ha scelto «solo analisi».
    expect(colleagueCorrectionAllowed({ ...base, mode: "analyze_only", trigger: "provider" })).toBe(false);
    expect(colleagueCorrectionAllowed({ ...base, mode: "analyze_only", trigger: "requested" })).toBe(true);
  });

  it("l'adozione esplicita (client vecchi) vale «analisi e correzioni» su quella PR", () => {
    expect(colleagueCorrectionAllowed({ ...base, mode: "analyze_only", explicitlyAdopted: true, trigger: "automatic" })).toBe(true);
    expect(colleagueCorrectionAllowed({ ...base, mode: "analyze_only", explicitlyAdopted: true, trigger: "provider" })).toBe(true);
  });

  it("«analisi e correzioni»: anche il giro automatico", () => {
    for (const trigger of ["automatic", "provider", "requested"] as const) {
      expect(colleagueCorrectionAllowed({ ...base, trigger })).toBe(true);
    }
  });
});
