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

describe("comandi di Claude (area 3)", () => {
  it("«New conversation with Claude» e «Ask Claude…» ci sono per tutti", () => {
    expect(ids(viewerWith([]))).toEqual(expect.arrayContaining(["claude.new", "claude.ask"]));
  });

  it("«Ask Claude…» resta qualunque cosa si scriva: il testo è la domanda, non un filtro", () => {
    const found = matchCommands("why does the import drop rows", viewerWith([]), (c) => c.id);
    expect(found.map((c) => c.id)).toEqual(["claude.ask"]);
  });

  it("porta la domanda nella casella di una conversazione nuova", () => {
    const cmd = matchCommands("", viewerWith([]), (c) => c.id).find((c) => c.id === "claude.ask")!;
    const paths: string[] = [];
    const ctx = {
      navigate: (p: string) => paths.push(p),
      setTheme: () => {},
      setPersona: () => {},
      pathname: "/home",
      openViewAs: () => {},
      openFilters: () => {},
    };
    cmd.run({ ...ctx, query: "  Explain AUD-3 " });
    cmd.run(ctx);
    expect(paths).toEqual(["/claude?ask=Explain%20AUD-3", "/claude"]);
  });
});
