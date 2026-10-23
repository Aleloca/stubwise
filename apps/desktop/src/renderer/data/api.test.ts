import { beforeEach, describe, expect, it } from "vitest";
import {
  failNext,
  getProjectByCode,
  listPinnedProjectIds,
  listProjects,
  markNotification,
  listNotifications,
  resetApi,
  search,
  setLatency,
  setPinned,
} from "./api";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("api finta", () => {
  it("getProjectByCode di un codice sconosciuto dà null", async () => {
    expect(await getProjectByCode("XXXX")).toBeNull();
    expect((await getProjectByCode("CBV"))?.code).toBe("CBV");
  });

  it("setPinned cambia i fissati", async () => {
    const id = (await getProjectByCode("TLM"))!.id;
    expect(await listPinnedProjectIds()).not.toContain(id);
    await setPinned(id, true);
    expect(await listPinnedProjectIds()).toContain(id);
    await setPinned(id, false);
    expect(await listPinnedProjectIds()).not.toContain(id);
  });

  it("failNext fa fallire solo la chiamata successiva", async () => {
    failNext("listProjects");
    await expect(listProjects()).rejects.toThrow();
    await expect(listProjects()).resolves.toHaveLength(50);
  });

  it("markNotification aggiorna la notifica", async () => {
    const first = (await listNotifications())[0]!;
    await markNotification(first.id, { read: true, archived: true });
    const again = (await listNotifications()).find((n) => n.id === first.id)!;
    expect(again.read).toBe(true);
    expect(again.archived).toBe(true);
  });

  it("search('cbv') trova progetto e task, senza badare alle maiuscole", async () => {
    const results = await search("cbv");
    expect(results.some((r) => r.kind === "project" && r.code === "CBV")).toBe(true);
    expect(results.some((r) => r.kind === "task" && r.code?.startsWith("CBV-"))).toBe(true);
    expect(await search("")).toEqual([]);
  });
});
