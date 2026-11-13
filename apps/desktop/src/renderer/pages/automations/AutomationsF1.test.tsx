import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_F1_AVAILABILITY } from "@stubwise/shared";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// R4 del piano della F1 (area 7): nella build app le pagine stanno nel
// perimetro della fetta 1 — niente automazioni generali né Sources (F4),
// la creazione solo «da zero» (P2 = a), niente «Pass time» (solo
// prototipo). La disponibilità della build app è finta (la destinazione
// resta spenta finché il server dell'area 7 non c'è).
vi.mock("../../data/integration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/integration")>()),
  automationAvailability: () => AUTOMATION_F1_AVAILABILITY,
}));

const ROBERTA = "p-roberta";
const MATTEO = "p-matteo";

async function open(path: string, personId = ROBERTA) {
  renderRoute(path, personId);
  await screen.findByRole("heading", { level: 1 });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

describe("le pagine delle automazioni nella fetta 1", () => {
  it("la colonna: niente Sources né General, anche con i permessi d'istanza", async () => {
    await open("/automations");
    const column = screen.getByRole("navigation", { name: "Automations views" });
    expect(within(column).getByRole("button", { name: "New automation" })).toBeInTheDocument();
    expect(within(column).queryByRole("link", { name: /Sources/ })).toBeNull();
    expect(within(column).queryByRole("link", { name: /^General/ })).toBeNull();
  });

  it("«New automation»: solo i progetti, senza General, e senza i modelli", async () => {
    await open("/automations");
    const column = screen.getByRole("navigation", { name: "Automations views" });
    await userEvent.click(within(column).getByRole("button", { name: "New automation" }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByRole("combobox");
    expect(within(select).queryByRole("option", { name: /General/ })).toBeNull();
    expect((select as HTMLSelectElement).value).not.toBe("");
    expect(within(dialog).queryByText("New contract → tasks for every department")).toBeNull();
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
  });

  it("il vuoto: niente modelli da usare", async () => {
    state.automations = [];
    state.automationRuns = [];
    await open("/automations");
    expect(await screen.findByText(/automations/i, { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("Start from a template")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();
  });

  it("un'esecuzione: niente «Pass time» (solo nel prototipo)", async () => {
    await open("/automations/AUD-A1/runs/1", MATTEO);
    await screen.findByRole("region", { name: "Now" });
    expect(screen.queryByRole("region", { name: "Pass time" })).toBeNull();
  });
});
