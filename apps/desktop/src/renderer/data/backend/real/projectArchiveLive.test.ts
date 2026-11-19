import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di archiviazione e riapertura (area 9, F6): passano dal client.

const projects = {
  archivePreview: vi.fn(async () => ({ openAutomationRuns: 1, busy: [] })),
  archive: vi.fn(async () => undefined),
  reopen: vi.fn(async () => undefined),
};
vi.mock("./client", () => ({ appClient: () => ({ projects }) }));

describe("archiviare e riaprire, i percorsi veri", () => {
  it("anteprima, archiviazione e riapertura dal client", async () => {
    const { projectSettings } = await import("./index");
    expect(await projectSettings.getArchivePreview("p1")).toMatchObject({
      ok: true,
      openAutomationRuns: 1,
      busy: [],
    });
    expect(await projectSettings.archiveProject("p1")).toEqual({ ok: true });
    expect(await projectSettings.reopenProject("p1")).toEqual({ ok: true });
    expect(projects.archivePreview).toHaveBeenCalledWith("p1");
    expect(projects.archive).toHaveBeenCalledWith("p1");
    expect(projects.reopen).toHaveBeenCalledWith("p1");
  });
});
