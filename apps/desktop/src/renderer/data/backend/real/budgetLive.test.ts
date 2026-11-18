import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Budget & language (area 9, F4): passano dal client.

const instanceSettings = { get: vi.fn(async () => ({})), save: vi.fn(async () => ({})) };
vi.mock("./client", () => ({ appClient: () => ({ instanceSettings }) }));

describe("Budget, i percorsi veri", () => {
  it("lettura e salvataggio dal client.instanceSettings", async () => {
    const { liveBudgetApiForTest: api } = await import("./budget");
    await api.get();
    await api.save({ contentLanguage: "it", monthlyBudgetUsd: 800 });
    expect(instanceSettings.get).toHaveBeenCalled();
    expect(instanceSettings.save).toHaveBeenCalledWith({
      contentLanguage: "it",
      monthlyBudgetUsd: 800,
    });
  });
});
