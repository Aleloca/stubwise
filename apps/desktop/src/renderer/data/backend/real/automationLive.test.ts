import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Automation (area 9, F3): passano dal client.

const instanceSettings = {
  automation: vi.fn(async () => ({ rules: [], prReview: { enabled: false, maxCostUsd: null } })),
  saveAutomation: vi.fn(async () => ({})),
};
vi.mock("./client", () => ({ appClient: () => ({ instanceSettings }) }));

describe("Automation, i percorsi veri", () => {
  it("lettura e salvataggio dal client.instanceSettings", async () => {
    const { liveAutomationApiForTest: api } = await import("./automation");
    await api.get();
    const body = { rules: [], prReview: { enabled: true, maxCostUsd: null } };
    await api.save(body);
    expect(instanceSettings.automation).toHaveBeenCalled();
    expect(instanceSettings.saveAutomation).toHaveBeenCalledWith(body);
  });
});
