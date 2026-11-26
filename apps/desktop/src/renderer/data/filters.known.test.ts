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

  const input = {
    name: "Mine",
    visibility: "private" as const,
    view: "list" as const,
    groupBy: "none" as const,
  };

  it("salvare un segnaposto senza l'origine: invalid; senza criteri restano veri", async () => {
    const { who } = strangerFilter();
    setSessionPersonId(LAURA);
    expect(await errorOf(saveFilter({ ...input, criteria: { assigneeIds: ["hidden-1"] } }))).toBe(
      "invalid: criteria",
    );
    setSessionPersonId("p-giulia");
    await updateFilter("flt-known-1", { name: "Renamed" });
    expect(state.filters.find((f) => f.id === "flt-known-1")!.criteria.assigneeIds).toEqual([
      who,
      LAURA,
    ]);
  });

  // Revisione di 3bbe2ddc6..444b8b773, I-6 (la forma di 72, f0d312736): il
  // segnaposto si rimette con gli assegnatari del filtro d'origine che chi
  // salva non conosce. I veri prendono il posto del PRIMO segnaposto, gli
  // altri spariscono; gli id veri mandati restano, nell'ordine.
  it("«Salva come» da un filtro che vedo: i segnaposto diventano gli sconosciuti dell'origine", async () => {
    const { who } = strangerFilter();
    setSessionPersonId(LAURA);
    const saved = await saveFilter({
      ...input,
      criteria: { assigneeIds: ["hidden-1", LAURA, "hidden-2"] },
      savedFilterId: "flt-known-1",
    });
    const stored = state.filters.find((f) => f.id === saved.id)!;
    expect(stored.criteria).toEqual({ assigneeIds: [who, LAURA] });
    // Nella risposta a Laura, lo sconosciuto resta un segnaposto.
    expect(JSON.stringify(saved)).not.toContain(who);
  });

  it("«Salva come» da un filtro che non vedo, o che non c'è: invalid", async () => {
    strangerFilter();
    state.filters.find((f) => f.id === "flt-known-1")!.visibility = "private";
    setSessionPersonId(LAURA);
    const criteria = { assigneeIds: ["hidden-1"] };
    expect(await errorOf(saveFilter({ ...input, criteria, savedFilterId: "flt-known-1" }))).toBe(
      "invalid: criteria",
    );
    expect(await errorOf(saveFilter({ ...input, criteria, savedFilterId: "flt-nope" }))).toBe(
      "invalid: criteria",
    );
  });

  it("modificare il proprio filtro: i segnaposto tornano gli sconosciuti del filtro stesso", async () => {
    const { who } = strangerFilter();
    const mine: SavedFilter = {
      id: "flt-known-mine",
      name: "Theirs, mine",
      ownerId: LAURA,
      visibility: "private",
      criteria: { assigneeIds: [who] },
      view: "list",
      groupBy: "none",
    };
    state.filters.push(mine);
    setSessionPersonId(LAURA);
    await updateFilter("flt-known-mine", {
      criteria: { assigneeIds: ["hidden-1"], families: ["todo"] },
    });
    expect(state.filters.find((f) => f.id === "flt-known-mine")!.criteria).toEqual({
      assigneeIds: [who],
      families: ["todo"],
    });
  });
});
