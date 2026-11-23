import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTasks, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state, visibleProjectIds } from "../../data/store";
import type { SavedFilter } from "../../data/types";
import { runnableCriteria } from "../../domain/filters";
import { renderRoute } from "../../test/renderRoute";
import { strangersTo } from "../../test/strangers";

// Revisione di 3bbe2ddc6..444b8b773, I-3 (r.1414, scelta A di 46): un
// filtro salvato con una persona che chi guarda non conosce ha il segnaposto
// nei criteri, e si esegue SOLO col suo id (`savedFilterId`). Ogni
// consumatore che esegue un filtro passa da `runnableCriteria`: il conteggio
// di All filters e il blocco della Home, oltre alla pagina del filtro.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

/** Un filtro pubblico di Giulia sulle task di uno sconosciuto a Laura, con una sua task che Laura vede. */
function strangerFilter() {
  const [who] = strangersTo(LAURA);
  const task = state.tasks.find((t) => visibleProjectIds(LAURA).has(t.projectId))!;
  task.assigneeId = who!;
  const filter: SavedFilter = {
    id: "flt-known-ui",
    name: "Their tasks",
    ownerId: "p-giulia",
    visibility: "public",
    criteria: { assigneeIds: [who!] },
    view: "list",
    groupBy: "none",
  };
  state.filters.push(filter);
  return { task, filter };
}

describe("un filtro con uno sconosciuto si esegue col suo id", () => {
  it("`runnableCriteria`: i criteri del filtro col suo id", () => {
    expect(
      runnableCriteria({
        id: "flt-1",
        criteria: { assigneeIds: ["hidden-1"], families: ["todo"] },
      }),
    ).toEqual({ assigneeIds: ["hidden-1"], families: ["todo"], savedFilterId: "flt-1" });
  });

  it("All filters: il conteggio di chi guarda, non «—»", async () => {
    strangerFilter();
    setSessionPersonId(LAURA);
    const expected = (await listTasks({ ...state.filters.at(-1)!.criteria })).length;
    renderRoute("/filters", LAURA);
    const region = await screen.findByRole("region", { name: "Public" });
    const row = within(region).getByRole("link", { name: "Their tasks" }).closest("li")!;
    await waitFor(() => expect(within(row).getByText(String(expected))).toBeInTheDocument());
    expect(expected).toBeGreaterThan(0);
    expect(within(row).queryByText("—")).toBeNull();
  });

  it("il blocco della Home: le righe del filtro, senza errore", async () => {
    const { task } = strangerFilter();
    const blocks = [{ kind: "filter" as const, filterId: "flt-known-ui" }];
    const home = state.personalHomes.find((h) => h.personId === LAURA);
    if (home) home.blocks = blocks;
    else state.personalHomes.push({ personId: LAURA, blocks, seenDepartmentUpdates: {} });
    renderRoute("/home", LAURA);
    const block = await screen.findByRole("region", { name: "Their tasks" });
    expect(await within(block).findByText(task.title)).toBeInTheDocument();
  });
});
