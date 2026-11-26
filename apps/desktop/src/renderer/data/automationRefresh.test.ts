import { afterEach, describe, expect, it, vi } from "vitest";
import { automationRunsRefreshMs } from "./queries";

// Area 7, F1 (review, minore): l'elenco intero delle esecuzioni (50, coi
// registri) nella build app non si rilegge ogni secondo.

afterEach(() => vi.unstubAllEnvs());

describe("il ritmo delle esecuzioni in corso", () => {
  it("nel prototipo ogni secondo", () => {
    expect(automationRunsRefreshMs({})).toBe(1000);
  });

  it("nella build app l'elenco intero ogni 5 s; un elenco filtrato (un'automazione) ogni secondo", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(automationRunsRefreshMs({})).toBe(5000);
    expect(automationRunsRefreshMs({ status: "running" })).toBe(5000);
    expect(automationRunsRefreshMs({ automationId: "a-1" })).toBe(1000);
  });
});
