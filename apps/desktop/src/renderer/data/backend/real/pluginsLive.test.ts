import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dei plugin (area 9, F3): passano dal client.

const plugins = {
  list: vi.fn(async () => ({ plugins: [], recommendations: {} })),
  get: vi.fn(async () => ({})),
  register: vi.fn(async () => ({})),
  updateRef: vi.fn(async () => ({ queued: true })),
  rerunSmoke: vi.fn(async () => ({ queued: true })),
  remove: vi.fn(async () => undefined),
};
vi.mock("./client", () => ({ appClient: () => ({ plugins }) }));

describe("i plugin, i percorsi veri", () => {
  it("elenco, pagina, registra, aggiorna, smoke e rimozione dal client.plugins", async () => {
    const { livePluginsApiForTest: api } = await import("./plugins");
    await api.list();
    await api.get("p1");
    await api.register({ sourceUrl: "https://x.test/r", ref: "main", trust: true });
    await api.updateRef("p1", "v2", true);
    await api.rerunSmoke("p1");
    await api.remove("p1");
    expect(plugins.get).toHaveBeenCalledWith("p1");
    expect(plugins.register).toHaveBeenCalledWith({
      sourceUrl: "https://x.test/r",
      ref: "main",
      trust: true,
    });
    expect(plugins.updateRef).toHaveBeenCalledWith("p1", "v2", true);
    expect(plugins.rerunSmoke).toHaveBeenCalledWith("p1");
    expect(plugins.remove).toHaveBeenCalledWith("p1");
  });
});
