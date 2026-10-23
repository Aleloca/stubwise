import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const mkxId = () => state.projects.find((p) => p.code === "MKX")!.id;

async function openDialog() {
  const toolbar = await screen.findByRole("toolbar", { name: "Tasks commands" });
  await userEvent.click(within(toolbar).getByRole("button", { name: "Save as filter" }));
  return screen.findByRole("dialog", { name: "Save as filter" });
}

describe("SaveFilterDialog", () => {
  it("dal progetto salva con quel progetto, i criteri, la vista e il raggruppamento correnti", async () => {
    const filters = encodeURIComponent(JSON.stringify({ families: ["active"] }));
    renderRoute(`/p/MKX/tasks?view=timeline&group=assignee&filters=${filters}`, "p-giulia");
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Everyone can open a public filter/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "MKX in corso");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Public/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save filter" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = state.filters.find((f) => f.name === "MKX in corso")!;
    expect(saved).toMatchObject({
      ownerId: "p-giulia",
      visibility: "public",
      view: "timeline",
      groupBy: "assignee",
      criteria: { families: ["active"], projectIds: [mkxId()] },
    });
    // Fissato alla colonna della Home, di default.
    expect(state.pinnedFilters.get("p-giulia")).toContain(saved.id);
    expect(await screen.findByText("Saved MKX in corso.")).toBeInTheDocument();
  });

  it("di default è privato; senza nome non salva", async () => {
    renderRoute("/p/MKX/tasks", "p-giulia");
    const dialog = await openDialog();
    expect(within(dialog).getByRole("radio", { name: /Private/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save filter" }));
    expect(within(dialog).getByText("Give the filter a name.")).toBeInTheDocument();
    expect(state.filters).toHaveLength(7);
  });

  it("un salvataggio che fallisce lascia il dialogo aperto e lo dice", async () => {
    renderRoute("/p/MKX/tasks", "p-giulia");
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Prova");
    failNext("saveFilter");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save filter" }));
    expect(await within(dialog).findByText("Couldn't save the filter. Try again.")).toBeInTheDocument();
  });

  it("da un filtro salvato, «Save as filter» ne fa una copia senza progetto fissato", async () => {
    renderRoute("/filters/flt-open", "p-sara");
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Le mie aperte");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save filter" }));
    await waitFor(() => expect(state.filters.some((f) => f.name === "Le mie aperte")).toBe(true));
    const copy = state.filters.find((f) => f.name === "Le mie aperte")!;
    expect(copy).toMatchObject({ ownerId: "p-sara", criteria: { families: ["todo", "active"] } });
    expect(copy.criteria.projectIds).toBeUndefined();
  });
});
