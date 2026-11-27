import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, searchHistory, setLatency } from "./api";
import { setSessionPersonId } from "./session";
import { state } from "./store";

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

  it("a lettura: via le voci di un progetto che chi guarda non vede, e quelle del web vecchio; con lo spazio, solo le sue", async () => {
    setSessionPersonId("p-sara");
    await searchHistory.rememberResult({ ...input(1), entityId: "prj-aud", route: "#/p/AUD/tasks" });
    await searchHistory.rememberResult({ ...input(2), entityId: "prj-acq", route: "/projects/prj-acq" });
    // Sara non vede AUD; la seconda ha un indirizzo del web vecchio.
    expect(await searchHistory.listRecentResults()).toEqual([]);
    expect(state.searchHistory.filter((e) => e.personId === "p-sara")).toHaveLength(2);
    setSessionPersonId("p-laura");
    const doc = (await searchHistory.listRecentResults()).find((r) => r.type === "doc")!;
    expect((await searchHistory.listRecentResults(doc.repositoryId)).map((r) => r.type)).toEqual(["doc"]);
  });
});
