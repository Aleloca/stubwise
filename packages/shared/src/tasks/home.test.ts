import { describe, expect, it } from "vitest";
import { homeBlockSchema, setHomeBodySchema } from "../schemas/home.js";
import {
  FIXED_BLOCKS,
  departmentNovelties,
  normalizeBlocks,
  resolveHome,
  sameBlock,
  withFixed,
  type DepartmentHomeData,
} from "./home.js";

/**
 * La Home a blocchi (integrazione area 2, fetta 3): le regole spostate da
 * `apps/desktop/src/renderer/domain/home.ts`, per il finto, il server e l'app.
 */

const HOMES: DepartmentHomeData[] = [
  {
    departmentId: "d1",
    blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }, { kind: "filter", filterId: "f1" }],
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
  it("senza Home personale: l'unione dei reparti nell'ordine del primo, lo stesso blocco una volta sola", () => {
    expect(resolveHome({ departmentIds: ["d1", "d2"] }, HOMES, null)).toEqual({
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
    // Nell'ordine inverso, l'ordine è quello di d2.
    expect(resolveHome({ departmentIds: ["d2", "d1"] }, HOMES, null).blocks.map((b) => b.kind)).toEqual([
      "decide",
      "myWeek",
      "newRequests",
      "filter",
      "filter",
      "myTasks",
    ]);
  });

  it("con la Home personale: i suoi blocchi coi fissi, e i reparti cambiati dopo l'ultima vista", () => {
    const personal = {
      blocks: [{ kind: "myTasks" }, { kind: "myWeek" }],
      seenDepartmentUpdates: { d1: "2026-10-10T09:00:00Z", d2: "2026-10-15T09:00:00Z" },
    };
    expect(resolveHome({ departmentIds: ["d1", "d2"] }, HOMES, personal)).toEqual({
      blocks: [{ kind: "decide" }, { kind: "myTasks" }, { kind: "myWeek" }],
      departmentChanged: ["d2"],
    });
    // Mai vista: cambiata.
    expect(resolveHome({ departmentIds: ["d1"] }, HOMES, { ...personal, seenDepartmentUpdates: {} }).departmentChanged).toEqual([
      "d1",
    ]);
  });

  it("gli extra vanno in coda solo alla Home non personale; un reparto senza Home non conta", () => {
    expect(resolveHome({ departmentIds: ["d9"] }, HOMES, null, ["releases"]).blocks).toEqual([
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "releases" },
    ]);
    expect(
      resolveHome({ departmentIds: ["d1"] }, HOMES, { blocks: [], seenDepartmentUpdates: {} }, ["releases"]).blocks,
    ).toEqual([{ kind: "decide" }, { kind: "myWeek" }]);
  });
});

describe("blocchi", () => {
  it("sameBlock: un filtro è lo stesso blocco solo con lo stesso filtro", () => {
    expect(sameBlock({ kind: "myTasks" }, { kind: "myTasks" })).toBe(true);
    expect(sameBlock({ kind: "filter", filterId: "a" }, { kind: "filter", filterId: "b" })).toBe(false);
    expect(sameBlock({ kind: "filter", filterId: "a" }, { kind: "filter", filterId: "a" })).toBe(true);
  });

  it("withFixed rimette i fissi mancanti in testa, «Decide» prima di «My week»", () => {
    expect(FIXED_BLOCKS).toEqual(["decide", "myWeek"]);
    expect(withFixed([{ kind: "myTasks" }])).toEqual([{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }]);
    expect(withFixed([{ kind: "myTasks" }, { kind: "myWeek" }])).toEqual([
      { kind: "decide" },
      { kind: "myTasks" },
      { kind: "myWeek" },
    ]);
    expect(withFixed([{ kind: "decide" }, { kind: "myTasks" }])).toEqual([
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "myTasks" },
    ]);
  });

  it("normalizeBlocks: doppioni via e fissi rimessi — la forma che il server salva", () => {
    expect(
      normalizeBlocks([{ kind: "myTasks" }, { kind: "myTasks" }, { kind: "filter", filterId: "a" }, { kind: "filter", filterId: "a" }]),
    ).toEqual([{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }, { kind: "filter", filterId: "a" }]);
  });

  it("departmentNovelties: i blocchi delle Home cambiate che la mia non ha, una volta sola", () => {
    const mine = [{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }];
    expect(departmentNovelties(["d1", "d2"], HOMES, mine)).toEqual([
      { kind: "filter", filterId: "f1" },
      { kind: "newRequests" },
      { kind: "filter", filterId: "f2" },
    ]);
    expect(departmentNovelties([], HOMES, mine)).toEqual([]);
  });

  it("lo schema: un kind ignoto passa (il client lo ignora), un filtro vuole il suo id, al massimo 50 blocchi", () => {
    expect(homeBlockSchema.parse({ kind: "dashboardFuturo" })).toEqual({ kind: "dashboardFuturo" });
    expect(homeBlockSchema.safeParse({ kind: "filter" }).success).toBe(false);
    expect(homeBlockSchema.safeParse({ kind: "" }).success).toBe(false);
    expect(setHomeBodySchema.safeParse({ blocks: Array.from({ length: 51 }, () => ({ kind: "myTasks" })) }).success).toBe(
      false,
    );
  });
});
