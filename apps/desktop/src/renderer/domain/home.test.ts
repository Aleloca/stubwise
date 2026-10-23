import { beforeEach, describe, expect, it } from "vitest";
import {
  getPersonalHome,
  listDepartmentHomes,
  listPeople,
  markDepartmentHomeSeen,
  resetApi,
  setDepartmentHome,
  setLatency,
} from "../data/api";
import { setSessionPersonId } from "../data/session";
import type { DepartmentHome, Person } from "../data/types";
import { resolveHome } from "./home";

const person = (departmentIds: string[]): Person => ({
  id: "u1",
  name: "Una Persona",
  initials: "UP",
  departmentIds,
  isClaude: false,
  presetRole: "developer",
});

const HOMES: DepartmentHome[] = [
  {
    departmentId: "d1",
    blocks: [
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "myTasks" },
      { kind: "filter", filterId: "f1" },
    ],
    updatedAt: "2026-10-10T09:00:00Z",
  },
  {
    departmentId: "d2",
    blocks: [
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "newRequests" },
      { kind: "filter", filterId: "f1" },
      { kind: "filter", filterId: "f2" },
      { kind: "myTasks" },
    ],
    updatedAt: "2026-10-20T09:00:00Z",
  },
];

describe("resolveHome", () => {
  it("senza Home personale: unione dei reparti nell'ordine del primo, doppioni una volta", () => {
    expect(resolveHome(person(["d1", "d2"]), HOMES, null)).toEqual({
      blocks: [
        { kind: "decide" },
        { kind: "myWeek" },
        { kind: "myTasks" },
        { kind: "filter", filterId: "f1" },
        { kind: "newRequests" },
        { kind: "filter", filterId: "f2" },
      ],
      departmentChanged: [],
    });
  });

  it("i fissi ci sono sempre, in testa, anche se la Home personale li ha tolti", () => {
    const { blocks } = resolveHome(person(["d1"]), HOMES, {
      personId: "u1",
      blocks: [{ kind: "myTasks" }],
      seenDepartmentUpdates: { d1: "2026-10-10T09:00:00Z" },
    });
    expect(blocks).toEqual([{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }]);
  });

  it("senza reparti: solo i fissi", () => {
    expect(resolveHome(person([]), HOMES, null).blocks).toEqual([
      { kind: "decide" },
      { kind: "myWeek" },
    ]);
  });

  it("departmentChanged: i reparti cambiati dopo l'ultima volta che li ha visti", () => {
    const { departmentChanged } = resolveHome(person(["d1", "d2"]), HOMES, {
      personId: "u1",
      blocks: [],
      seenDepartmentUpdates: { d1: "2026-10-10T09:00:00Z", d2: "2026-10-14T09:00:00Z" },
    });
    expect(departmentChanged).toEqual(["d2"]);
  });
});

describe("resolveHome sui dati del livello finto", () => {
  beforeEach(() => {
    setLatency(0);
    resetApi();
  });

  const homeOf = async (personId: string) => {
    setSessionPersonId(personId);
    const person = (await listPeople()).find((p) => p.id === personId)!;
    return resolveHome(person, await listDepartmentHomes(), await getPersonalHome());
  };

  it("departmentChanged dopo setDepartmentHome: chi ha la Home personale lo vede, gli altri no", async () => {
    setSessionPersonId("p-marco");
    await markDepartmentHomeSeen("dep-development");
    expect((await homeOf("p-marco")).departmentChanged).toEqual([]);
    setSessionPersonId("p-laura");
    await setDepartmentHome("dep-development", [{ kind: "decide" }, { kind: "myTasks" }]);
    expect((await homeOf("p-marco")).departmentChanged).toEqual(["dep-development"]);
    // Chi usa la Home del reparto la vede cambiata, senza avviso.
    const federico = await homeOf("p-federico");
    expect(federico.departmentChanged).toEqual([]);
    expect(federico.blocks).toEqual([{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }]);
  });
});
