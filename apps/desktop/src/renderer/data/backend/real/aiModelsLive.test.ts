import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Models (area 9, F3): passano dal client.

const settings = {
  models: vi.fn(async () => ({ operations: [], choices: [] })),
  setModels: vi.fn(async () => ({})),
};
vi.mock("./client", () => ({ appClient: () => ({ settings }) }));

describe("Models, i percorsi veri", () => {
  it("lettura e scelta dal client.settings", async () => {
    const { liveModelsApiForTest: api } = await import("./aiModels");
    await api.get();
    await api.set({ fix_plan: "opus" });
    expect(settings.models).toHaveBeenCalled();
    expect(settings.setModels).toHaveBeenCalledWith({ fix_plan: "opus" });
  });
});
