import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero del registro (area 9, F2): passano dal client.

const changeLog = {
  list: vi.fn(async () => ({ entries: [], nextCursor: null })),
  listProject: vi.fn(async () => ({ entries: [], nextCursor: null })),
  filters: vi.fn(async () => ({})),
};
vi.mock("./client", () => ({ appClient: () => ({ changeLog }) }));

describe("il registro, i percorsi veri", () => {
  it("elenco, elenco di progetto e filtri dal client.changeLog", async () => {
    const { liveChangelogApiForTest: api } = await import("./changelog");
    await api.list({ group: "roles" });
    await api.listProject("p1", { cursor: "c" });
    await api.filters("p1");
    expect(changeLog.list).toHaveBeenCalledWith({ group: "roles" });
    expect(changeLog.listProject).toHaveBeenCalledWith("p1", { cursor: "c" });
    expect(changeLog.filters).toHaveBeenCalledWith("p1");
  });
});
