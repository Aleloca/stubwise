import { describe, expect, it } from "vitest";
import type { Viewer } from "../data/types";
import { matchCommands } from "./commands";

const viewerWith = (perms: string[]): Viewer => ({
  personId: "p-x",
  instancePermissions: [],
  projectPermissions: { "prj-1": perms as never },
  departmentPermissions: {},
});

const ids = (v: Viewer) => matchCommands("", v, (c) => c.id).map((c) => c.id);

describe("comandi dell'area 2", () => {
  it("«New task» manca a chi non ha tickets.create in nessun progetto", () => {
    expect(ids(viewerWith(["tickets.comment"]))).not.toContain("task.new");
    expect(ids(viewerWith(["tickets.create"]))).toContain("task.new");
  });

  it("«New request» chiede backlog.create, «Open filter…» è per tutti", () => {
    expect(ids(viewerWith(["tickets.comment"]))).not.toContain("request.new");
    expect(ids(viewerWith(["backlog.create"]))).toContain("request.new");
    expect(ids(viewerWith([]))).toContain("filter.open");
  });
});
