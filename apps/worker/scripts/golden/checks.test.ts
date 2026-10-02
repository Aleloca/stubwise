import { describe, expect, it } from "vitest";

import type { AskUserFileResult } from "../../src/pipeline/ask-user.js";
import { askUserCheck, isScenarioName, SCENARIO_NAMES } from "./checks.js";

const asked: AskUserFileResult = {
  kind: "question",
  payload: {
    question: "La soglia della spedizione gratuita va sul subtotale prima o dopo il coupon?",
    options: [
      { label: "Prima del coupon", consequence: "cambia buildOrder e i test" },
      { label: "Dopo il coupon", consequence: "il codice resta, si corregge il banner" },
    ],
    allowFreeText: true,
  },
};
const absent: AskUserFileResult = { kind: "absent" };
const malformed: AskUserFileResult = { kind: "malformed", reason: "JSON non parsabile" };

describe("scenari golden", () => {
  it("no-ask è registrato accanto agli altri, e un nome ignoto no", () => {
    expect(SCENARIO_NAMES).toContain("no-ask");
    expect(SCENARIO_NAMES).toContain("ask-user");
    expect(isScenarioName("no-ask")).toBe(true);
    expect(isScenarioName("no-asks")).toBe(false);
  });
});

describe("askUserCheck", () => {
  it("ask-user: passa solo con una domanda valida", () => {
    expect(askUserCheck(asked, "asks").passed).toBe(true);
    expect(askUserCheck(absent, "asks").passed).toBe(false);
    expect(askUserCheck(malformed, "asks").passed).toBe(false);
  });

  it("no-ask: passa con il file-bridge assente", () => {
    const check = askUserCheck(absent, "does-not-ask");
    expect(check.passed).toBe(true);
    expect(check.name).toBe("ask_user NON chiamato");
  });

  it("no-ask: fallisce con una domanda presente, e il dettaglio la riporta", () => {
    const check = askUserCheck(asked, "does-not-ask");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("prima o dopo il coupon");
  });

  it("no-ask: anche un file-bridge malformato è rosso (il tool è stato chiamato)", () => {
    expect(askUserCheck(malformed, "does-not-ask").passed).toBe(false);
  });
});
