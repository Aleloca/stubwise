import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dei provider AI (area 9, F3): passano dal client.

const aiProviders = {
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  reorder: vi.fn(async () => []),
  test: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
};
const aiUsage = { snapshots: vi.fn(async () => []) };
vi.mock("./client", () => ({ appClient: () => ({ aiProviders, aiUsage }) }));

describe("i provider AI, i percorsi veri", () => {
  it("elenco, quota, crea, modifica, riordina, prova ed elimina dal client", async () => {
    const { liveProvidersApiForTest: api } = await import("./aiProviders");
    await api.list();
    await api.snapshots();
    await api.create({ kind: "api_key", label: "L", secret: "s" });
    await api.update("p1", { label: "M" });
    await api.reorder(["p1", "p2"]);
    await api.test("p1");
    await api.remove("p1");
    expect(aiProviders.list).toHaveBeenCalled();
    expect(aiUsage.snapshots).toHaveBeenCalled();
    expect(aiProviders.create).toHaveBeenCalledWith({ kind: "api_key", label: "L", secret: "s" });
    expect(aiProviders.update).toHaveBeenCalledWith("p1", { label: "M" });
    expect(aiProviders.reorder).toHaveBeenCalledWith(["p1", "p2"]);
    expect(aiProviders.test).toHaveBeenCalledWith("p1");
    expect(aiProviders.remove).toHaveBeenCalledWith("p1");
  });
});
