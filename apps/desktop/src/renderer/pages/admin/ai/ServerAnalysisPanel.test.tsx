import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import { renderRoute } from "../../../test/renderRoute";

// Area 8, F4b (R0-C): i tetti dell'analisi dei server nella scheda Budget di
// Amministrazione → AI, per chi ha `settings.manage`. Un Save; un valore
// fuori dai limiti si dice sotto il suo campo, col limite.

const ROBERTA = "p-roberta";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

async function openPart() {
  renderRoute("/admin/ai?tab=budget", ROBERTA);
  return screen.findByRole("region", { name: "Server analysis" });
}

describe("i tetti dell'analisi dei server (R0-C)", () => {
  it("di base i valori di shared; si cambiano e si salvano", async () => {
    const part = await openPart();
    expect(
      within(part).getByRole("switch", { name: "Claude looks into server alerts" }),
    ).toBeChecked();
    expect(within(part).getByLabelText("Minutes at most")).toHaveValue(10);
    expect(within(part).getByLabelText("Cost at most ($)")).toHaveValue(1);
    expect(within(part).getByLabelText("SSH reads at most")).toHaveValue(30);
    expect(within(part).getByLabelText("Agent reads at most")).toHaveValue(30);
    await userEvent.clear(within(part).getByLabelText("Minutes at most"));
    await userEvent.type(within(part).getByLabelText("Minutes at most"), "5");
    await userEvent.click(
      within(part).getByRole("switch", { name: "Claude looks into server alerts" }),
    );
    await userEvent.click(within(part).getByRole("button", { name: "Save limits" }));
    await waitFor(() =>
      expect(state.instance.serverAnalysis).toMatchObject({ enabled: false, maxMinutes: 5 }),
    );
    expect(await within(part).findByText("Saved")).toBeInTheDocument();
  });

  it("fuori dai limiti: la frase sotto il campo, niente salvato", async () => {
    const part = await openPart();
    await userEvent.clear(within(part).getByLabelText("Minutes at most"));
    await userEvent.type(within(part).getByLabelText("Minutes at most"), "90");
    await userEvent.click(within(part).getByRole("button", { name: "Save limits" }));
    expect(await within(part).findByText("From 1 to 60 minutes.")).toBeInTheDocument();
    expect(state.instance.serverAnalysis.maxMinutes).toBe(10);
  });
});
