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
      openChannels: () => {},
      openLinkFolder: () => {},
      openNewAutomation: () => {},
    };
    cmd.run({ ...ctx, query: "  Explain AUD-3 " });
    cmd.run(ctx);
    expect(paths).toEqual(["/claude?ask=Explain%20AUD-3", "/claude"]);
  });
});

describe("comandi degli avvisi (area 8a)", () => {
  it("«Notification preferences» per tutti; «Alerts for <PRJ>» solo dentro un progetto, sul suo gruppo", () => {
    expect(ids(viewerWith([]))).toContain("prefs.notifications");
    expect(ids(viewerWith([]))).not.toContain("prefs.projectAlerts");
    const scoped = matchCommands("", viewerWith([]), (c) => c.id, {
      projectId: "prj-1",
      projectCode: "AUD",
    });
    const cmd = scoped.find((c) => c.id === "prefs.projectAlerts")!;
    const paths: string[] = [];
    cmd.run({
      navigate: (p: string) => paths.push(p),
      setTheme: () => {},
      setPersona: () => {},
      pathname: "/p/AUD/overview",
      projectCode: "AUD",
      openViewAs: () => {},
      openFilters: () => {},
      openChannels: () => {},
      openLinkFolder: () => {},
      openNewAutomation: () => {},
    });
    expect(paths).toEqual(["/preferences/notifications?project=AUD"]);
  });
});

describe("comandi dei server (area 8b)", () => {
  const ssh: Viewer = {
    personId: "p-x",
    instancePermissions: ["servers.ssh.manage"] as never,
    projectPermissions: {},
    departmentPermissions: {},
  };
  const linkSsh = (
    v: Viewer,
    state: string | undefined,
    serverCode: string | undefined = "SRV-1",
  ) =>
    matchCommands("", v, (c) => c.id, {
      projectId: "prj-1",
      projectCode: "ACQ",
      serverCode,
      serverAccessState: state as never,
    }).some((c) => c.id === "server.linkSsh");

  it("«Link SSH access»: solo con servers.ssh.manage, su un server, se l'accesso non è già a posto", () => {
    for (const state of [
      "not_linked",
      "awaiting_command",
      "verify_failed",
      "read_writes",
      "revoked",
    ])
      expect(linkSsh(ssh, state), state).toBe(true);
    expect(linkSsh(ssh, "verified")).toBe(false);
    expect(linkSsh(ssh, "regenerating")).toBe(false);
    expect(linkSsh(ssh, undefined)).toBe(false);
    expect(linkSsh(ssh, "not_linked", "")).toBe(false);
    expect(linkSsh(viewerWith([]), "not_linked")).toBe(false);
  });
});

describe("comandi delle Automations (area 7)", () => {
  it("«New automation» solo con automations.manage, in un progetto o d'istanza", () => {
    expect(ids(viewerWith(["tickets.create"]))).not.toContain("automation.new");
    expect(ids(viewerWith(["automations.manage"]))).toContain("automation.new");
    const instance: Viewer = {
      ...viewerWith([]),
      instancePermissions: ["automations.manage" as never],
    };
    expect(ids(instance)).toContain("automation.new");
  });

  it("dentro un progetto apre il dialogo preimpostato su quello", () => {
    const cmd = matchCommands("", viewerWith(["automations.manage"]), (c) => c.id).find(
      (c) => c.id === "automation.new",
    )!;
    const opened: (string | undefined)[] = [];
    cmd.run({
      navigate: () => {},
      setTheme: () => {},
      setPersona: () => {},
      pathname: "/p/AUD/tasks",
      projectCode: "AUD",
      openViewAs: () => {},
      openFilters: () => {},
      openChannels: () => {},
      openLinkFolder: () => {},
      openNewAutomation: (code) => opened.push(code),
    });
    expect(opened).toEqual(["AUD"]);
  });
});
