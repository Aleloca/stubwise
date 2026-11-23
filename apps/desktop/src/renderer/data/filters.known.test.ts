import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import {
  getSavedFilter,
  listSavedFilters,
  listTasks,
  resetApi,
  saveFilter,
  setLatency,
  updateFilter,
} from "./api";
import { setSessionPersonId } from "./session";
import { state, visibleProjectIds } from "./store";
import type { SavedFilter } from "./types";

// Registro, A11 r.1414, scelta A di 46 (lotto 3, filtri salvati): un filtro
// salvato si esegue nel livello dati con i criteri veri; nella vista il
// criterio su una persona che chi guarda non conosce è il segnaposto, e un
// salvataggio con un `hidden-*` è `invalid`.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

/** Un filtro pubblico di Giulia sulle task di uno sconosciuto a Laura, e la sua task in un progetto che Laura vede. */
function strangerFilter() {
  const [who] = strangersTo(LAURA);
  const task = state.tasks.find((t) => visibleProjectIds(LAURA).has(t.projectId))!;
  task.assigneeId = who!;
  const filter: SavedFilter = {
    id: "flt-known-1",
    name: "Their tasks",
    ownerId: "p-giulia",
    visibility: "public",
    criteria: { assigneeIds: [who!, LAURA] },
    view: "list",
    groupBy: "none",
  };
  state.filters.push(filter);
  return { who: who!, task, filter };
}

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

describe("i filtri salvati senza id di chi non si conosce (r.1414, scelta A)", () => {
  it("nella vista il criterio su uno sconosciuto è il segnaposto; il proprio id resta", async () => {
    const { who } = strangerFilter();
    setSessionPersonId(LAURA);
    const one = (await getSavedFilter("flt-known-1"))!;
    expect(one.criteria.assigneeIds).toEqual(["hidden-1", LAURA]);
    const listed = (await listSavedFilters()).find((f) => f.id === "flt-known-1")!;
    expect(listed.criteria.assigneeIds).toContain(LAURA);
    expect(JSON.stringify(listed)).not.toContain(who);
  });

  it("eseguito col suo id, trova le task dello sconosciuto", async () => {
    const { task } = strangerFilter();
    setSessionPersonId(LAURA);
    const view = (await getSavedFilter("flt-known-1"))!;
    const ids = (await listTasks({ ...view.criteria, savedFilterId: view.id })).map((t) => t.id);
    expect(ids).toContain(task.id);
  });

  it("un segnaposto nei criteri senza il filtro: invalid", async () => {
    strangerFilter();
    setSessionPersonId(LAURA);
    expect(await errorOf(listTasks({ assigneeIds: ["hidden-1"] }))).toBe("invalid: criteria");
  });

  it("salvare o cambiare i criteri con un segnaposto: invalid; senza criteri restano veri", async () => {
    const { who } = strangerFilter();
    setSessionPersonId(LAURA);
    const input = {
      name: "Mine",
      visibility: "private" as const,
      view: "list" as const,
      groupBy: "none" as const,
    };
    expect(await errorOf(saveFilter({ ...input, criteria: { assigneeIds: ["hidden-1"] } }))).toBe(
      "invalid: criteria",
    );
    setSessionPersonId("p-giulia");
    expect(
      await errorOf(updateFilter("flt-known-1", { criteria: { assigneeIds: ["hidden-1"] } })),
    ).toBe("invalid: criteria");
    await updateFilter("flt-known-1", { name: "Renamed" });
    expect(state.filters.find((f) => f.id === "flt-known-1")!.criteria.assigneeIds).toEqual([
      who,
      LAURA,
    ]);
  });
});
