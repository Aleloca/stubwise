import { describe, expect, it } from "vitest";
import { planStartAutomation, type StartTarget } from "./plans.js";

/** «Avvia un'altra» (area 7, F4, S6): la regola del prototipo, in shared per prototipo ed esecutore. */
describe("planStartAutomation", () => {
  const target = (over: Partial<StartTarget> = {}): StartTarget => ({ id: "b", name: "B", status: "active", visibleToOwner: true, manageableByOwner: true, ...over });
  const errorOf = (r: ReturnType<typeof planStartAutomation>) => (r.ok ? null : (r.outcome.input as { error?: string }).error);

  it("A → B parte; A → B → C parte (la catena è [B, A] quando B avvia C)", () => {
    expect(planStartAutomation(target(), "Olga", ["a"]).ok).toBe(true);
    expect(planStartAutomation(target({ id: "c" }), "Olga", ["b", "a"]).ok).toBe(true);
  });

  it("A → B → C → D no (chain_limit); A → B → A no (automation_cycle)", () => {
    expect(errorOf(planStartAutomation(target({ id: "d" }), "Olga", ["c", "b", "a"]))).toBe("chain_limit");
    expect(errorOf(planStartAutomation(target({ id: "a" }), "Olga", ["b", "a"]))).toBe("automation_cycle");
  });

  it("che non esiste o che il proprietario non vede: automation_not_found; che non può gestire: permission_lost; spenta: automation_not_active", () => {
    expect(errorOf(planStartAutomation(null, "Olga", []))).toBe("automation_not_found");
    expect(errorOf(planStartAutomation(target({ visibleToOwner: false }), "Olga", []))).toBe("automation_not_found");
    expect(errorOf(planStartAutomation(target({ manageableByOwner: false }), "Olga", []))).toBe("permission_lost");
    expect(errorOf(planStartAutomation(target({ status: "paused" }), "Olga", []))).toBe("automation_not_active");
  });
});
