import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Members (area 9, R8): passano dal client.

const projects = {
  membersView: vi.fn(async () => ({ members: [] })),
  previewMember: vi.fn(async () => ({})),
  putMember: vi.fn(async () => ({})),
  removeMember: vi.fn(async () => undefined),
};
vi.mock("./client", () => ({ appClient: () => ({ projects }) }));

describe("Members, i percorsi veri", () => {
  it("vista, anteprima, PUT e DELETE del membro dal client.projects", async () => {
    const { liveMembersApiForTest: api } = await import("./adminMembers");
    await api.view("p1");
    await api.preview("p1", "u1", { roleId: "r1", granted: [] });
    await api.put("p1", "u1", { roleId: "r1" });
    await api.remove("p1", "u1");
    expect(projects.membersView).toHaveBeenCalledWith("p1");
    expect(projects.previewMember).toHaveBeenCalledWith("p1", "u1", { roleId: "r1", granted: [] });
    expect(projects.putMember).toHaveBeenCalledWith("p1", "u1", { roleId: "r1" });
    expect(projects.removeMember).toHaveBeenCalledWith("p1", "u1");
  });
});
