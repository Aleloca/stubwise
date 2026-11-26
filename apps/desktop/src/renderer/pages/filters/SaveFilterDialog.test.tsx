import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state, visibleProjectIds } from "../../data/store";
import { strangersTo } from "../../test/strangers";
import i18n from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { saveFilterErrorKey } from "./SaveFilterDialog";

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

  // Revisione di 3bbe2ddc6..444b8b773, I-6 (la forma di 72, f0d312736): un
  // «Save as filter» da un filtro che nomina uno sconosciuto manda il filtro
  // d'origine (`savedFilterId`), e lo sconosciuto si salva con l'id vero. Se
  // il segnaposto non si risolve, il dialogo dice perché.
  function strangerFilterOfGiulia() {
    const [who] = strangersTo("p-laura");
    const task = state.tasks.find((t) => visibleProjectIds("p-laura").has(t.projectId))!;
    task.assigneeId = who!;
    state.filters.push({
      id: "flt-known-dialog",
      name: "Their tasks",
      ownerId: "p-giulia",
      visibility: "public",
      criteria: { assigneeIds: [who!] },
      view: "list",
      groupBy: "none",
    });
    return who!;
  }

  it("«Save as filter» da un filtro con uno sconosciuto: la copia lo nomina davvero", async () => {
    const who = strangerFilterOfGiulia();
    renderRoute("/filters/flt-known-dialog", "p-laura");
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Loro");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save filter" }));
    await waitFor(() => expect(state.filters.some((f) => f.name === "Loro")).toBe(true));
    expect(state.filters.find((f) => f.name === "Loro")!.criteria).toEqual({ assigneeIds: [who] });
  });

  it("un segnaposto che non si risolve: il motivo, non l'errore generico", async () => {
    expect(saveFilterErrorKey(new Error("invalid: criteria"))).toBe("filter.dialog.someone");
    expect(saveFilterErrorKey({ code: "too_many_filters" })).toBe("filter.dialog.tooMany");
    expect(saveFilterErrorKey(new Error("boom"))).toBe("filter.dialog.failed");
    expect(
      i18n.t("filter.dialog.someone", { someone: i18n.t("taskUi.someone") }),
    ).toBe(
      "This filter names someone you can't see, so it can't be saved as it is. Take “Someone” out of the assignees and try again.",
    );
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
