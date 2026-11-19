import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dei plugin del progetto (area 9, F5): passano dal client.

const projects = { plugins: vi.fn(async () => ({})), setPlugins: vi.fn(async () => ({})) };
vi.mock("./client", () => ({ appClient: () => ({ projects }) }));

describe("i plugin del progetto, i percorsi veri", () => {
  it("lettura e salvataggio con ifMatch dal client", async () => {
    const { liveProjectPluginsApiForTest: api } = await import("./projectPlugins");
    await api.get("p1");
    await api.put("p1", [], "v7");
    expect(projects.plugins).toHaveBeenCalledWith("p1");
    expect(projects.setPlugins).toHaveBeenCalledWith("p1", [], "v7");
  });
});
