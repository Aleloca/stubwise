import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { claudeRunText } from "./claudeRun";

// Lotto 4, D-7.1 (72, d93c1378e): assegnata a Claude col budget del mese
// finito da chi non può scavalcarlo, la task è assegnata ma il lavoro non
// parte (`claudeRun: "refused:budget_exhausted"`): la frase dice perché.
describe("assegnata a Claude col budget finito", () => {
  it("la frase del budget, in en e in it", () => {
    const task = { code: "ACQ-7", claudeRun: "refused:budget_exhausted" };
    expect(claudeRunText(i18n.getFixedT("en"), task)).toBe(
      "ACQ-7 is assigned to Claude, but the work didn't start: the monthly AI budget is used up.",
    );
    expect(claudeRunText(i18n.getFixedT("it"), task)).toBe(
      "ACQ-7 è assegnata a Claude, ma il lavoro non è partito: il budget AI del mese è esaurito.",
    );
  });
});
