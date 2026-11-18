import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di «Chi può farlo?» (area 9, R9).

const access = {
  whoCan: vi.fn(async () => ({ permission: "plans.approve", projectId: null, people: [] })),
  whatCan: vi.fn(async () => ({ userId: "u", instance: [], projects: [] })),
};
vi.mock("./client", () => ({ appClient: () => ({ access }) }));
vi.mock("./people", () => ({ listPeople: async () => [] }));
vi.mock("./projects", () => ({ listProjects: async () => [] }));

describe("«Chi può farlo?», i percorsi veri", () => {
  it("chiede client.access.whoCan e whatCan coi parametri del server", async () => {
    const { liveWhoCanApiForTest: api } = await import("./whoCan");
    await api.whoCan({ permission: "plans.approve", projectId: "p1" });
    await api.whatCan({ userId: "u1" });
    expect(access.whoCan).toHaveBeenCalledWith({ permission: "plans.approve", projectId: "p1" });
    expect(access.whatCan).toHaveBeenCalledWith({ userId: "u1" });
  });
});
