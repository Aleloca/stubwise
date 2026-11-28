import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, searchHistory, setLatency } from "./api";
import { setSessionPersonId } from "./session";
import { state } from "./store";
import { revokeProjectPermission } from "./viewer";

// I risultati aperti di recente nella ⌘K, livello dati del prototipo (shape
// `search-history.md`): le regole del server sullo stato finto.

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

const input = (n: number) => ({
  type: "project" as const,
  entityId: "prj-stw",
  code: "STW",
  title: `Stubwise ${n}`,
  route: "#/p/STW/tasks",
  repositoryId: null,
});

describe("i recenti della ⌘K nel prototipo", () => {
  it("il seme: tre voci di Laura (task, progetto, pagina Docs), dalla più recente; le altre persone partono vuote", async () => {
    setSessionPersonId("p-laura");
    const mine = await searchHistory.listRecentResults();
    expect(mine.map((r) => r.type)).toEqual(["ticket", "project", "doc"]);
    expect(mine.every((r) => r.route.startsWith("#/p/STW/"))).toBe(true);
    setSessionPersonId("p-giulia");
    expect(await searchHistory.listRecentResults()).toEqual([]);
  });

  it("riaprire un oggetto lo riporta in cima, una voce sola; se ne tengono 20, se ne leggono 8", async () => {
    setSessionPersonId("p-laura");
    await searchHistory.rememberResult(input(1));
    const top = await searchHistory.listRecentResults();
    expect(top[0]).toMatchObject({ type: "project", entityId: "prj-stw", title: "Stubwise 1", code: "STW" });
    expect(top.filter((r) => r.type === "project")).toHaveLength(1);
    for (let i = 0; i < 25; i++)
      await searchHistory.rememberResult({ ...input(i), type: "ticket", entityId: `t-stw-${i + 1}`, route: `#/p/STW/tasks?task=STW-${i + 1}` });
    expect(state.searchHistory.filter((e) => e.personId === "p-laura")).toHaveLength(20);
    expect(await searchHistory.listRecentResults()).toHaveLength(8);
  });

  it("togliere una voce e svuotare valgono solo per chi guarda", async () => {
    setSessionPersonId("p-giulia");
    await searchHistory.rememberResult(input(1));
    setSessionPersonId("p-laura");
    await searchHistory.forgetResult("project", "prj-stw");
    expect((await searchHistory.listRecentResults()).map((r) => r.type)).toEqual(["ticket", "doc"]);
    await searchHistory.clearRecentResults();
    expect(await searchHistory.listRecentResults()).toEqual([]);
    setSessionPersonId("p-giulia");
    expect(await searchHistory.listRecentResults()).toHaveLength(1);
  });

  it("a lettura: via le voci di un progetto che chi guarda non vede; con lo spazio, solo le sue", async () => {
    setSessionPersonId("p-sara");
    await searchHistory.rememberResult({ ...input(1), entityId: "prj-aud", route: "#/p/AUD/tasks" });
    // Sara non vede AUD: la voce resta, ma non si mostra.
    expect(await searchHistory.listRecentResults()).toEqual([]);
    expect(state.searchHistory.filter((e) => e.personId === "p-sara")).toHaveLength(1);
    setSessionPersonId("p-laura");
    const doc = (await searchHistory.listRecentResults()).find((r) => r.type === "doc")!;
    expect((await searchHistory.listRecentResults(doc.repositoryId)).map((r) => r.type)).toEqual(["doc"]);
  });

  it("I1 (a): l'indirizzo si ricostruisce da tipo e oggetto, anche per una voce scritta dal web vecchio", async () => {
    setSessionPersonId("p-laura");
    const task = state.tasks.find((t) => t.projectId === "prj-stw")!;
    state.searchHistory = [
      { personId: "p-laura", type: "ticket", entityId: task.id, title: task.title, subtitle: "Stubwise", route: `/tickets/${task.id}`, repositoryId: null, clickedAt: "2026-11-01T10:00:00Z" },
      { personId: "p-laura", type: "project", entityId: "prj-stw", title: "Stubwise", subtitle: null, route: "/projects/prj-stw", repositoryId: null, clickedAt: "2026-10-31T10:00:00Z" },
    ];
    expect(await searchHistory.listRecentResults()).toEqual([
      expect.objectContaining({ type: "ticket", code: task.code, route: `#/p/STW/tasks?task=${task.code}` }),
      expect.objectContaining({ type: "project", code: "STW", route: "#/p/STW/tasks" }),
    ]);
  });

  it("M1: i permessi del server — una task si vede con tickets.view_all o se l'ha aperta chi guarda; una pagina con docs.view", async () => {
    setSessionPersonId("p-laura");
    const mine = (await searchHistory.listRecentResults()).map((r) => r.type);
    expect(mine).toEqual(["ticket", "project", "doc"]);
    revokeProjectPermission("p-laura", "prj-stw", "tickets.view_all" as never);
    revokeProjectPermission("p-laura", "prj-stw", "docs.view" as never);
    const task = state.tasks.find((t) => t.id === state.searchHistory.find((e) => e.type === "ticket")!.entityId)!;
    const after = await searchHistory.listRecentResults();
    // La task resta solo se l'ha aperta Laura; la pagina Docs no.
    expect(after.map((r) => r.type)).toEqual(task.createdById === "p-laura" ? ["ticket", "project"] : ["project"]);
    task.createdById = "p-laura";
    expect((await searchHistory.listRecentResults()).map((r) => r.type)).toEqual(["ticket", "project"]);
  });
});
