import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero delle app Google (area 9, F3): passano dal client.

const googleApps = {
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
};
vi.mock("./client", () => ({ appClient: () => ({ googleApps }) }));
vi.mock("./supportWidgets", () => ({ instanceOrigin: async () => "https://x.test" }));

describe("le app Google, i percorsi veri", () => {
  it("elenco, crea, modifica ed elimina dal client.googleApps", async () => {
    const { liveGoogleAppsApiForTest: api } = await import("./googleApps");
    await api.list();
    await api.create({ name: "N", domains: ["a.it"], clientId: "c", clientSecret: "s" });
    await api.update("g1", { name: "M" });
    await api.remove("g1");
    expect(await api.origin()).toBe("https://x.test");
    expect(googleApps.create).toHaveBeenCalledWith({
      name: "N",
      domains: ["a.it"],
      clientId: "c",
      clientSecret: "s",
    });
    expect(googleApps.update).toHaveBeenCalledWith("g1", { name: "M" });
    expect(googleApps.remove).toHaveBeenCalledWith("g1");
  });
});
