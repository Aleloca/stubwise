import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations, instance, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import type { AutomationFlow } from "../../data/types";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// Un'esecuzione ferma per un blocco d'istanza (area 9b, Task 6, shape
// instance-effects [EF 6] e ruling 15): resta `running`, l'elenco dice
// «Waiting» col glifo dell'attesa, il riquadro «Now» dice perché e che
// riparte da sola, «Pass time» non la muove. Roberta è full admin.

const ROBERTA = "p-roberta";

const flow: AutomationFlow = {
  trigger: { kind: "manual" },
  titleTemplate: "Smistamento di prova",
  steps: [
    {
      id: "c-classify",
      kind: "claude",
      instruction: "Classifica la richiesta.",
      inputs: ["avvio.data"],
      outcomes: ["bug", "funzionalità"],
      fields: [],
      branches: {},
    },
  ],
};

/** Un'automazione di ACQ con un solo passo di Claude, accesa e avviata a mano: il suo codice. */
async function heldRun(): Promise<string> {
  setSessionPersonId(ROBERTA);
  await instance.simulateBudgetReached(true);
  const a = await automations.createAutomation({ name: "Smistamento", projectId: "prj-acq", flow });
  const live = await automations.activate(a.id);
  await automations.startManual(a.id);
  await automations.whenAutomationsIdle();
  return live.code;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => resetApi());

describe("esecuzione ferma per il budget del mese", () => {
  it("«Now» dice l'attesa e che riparte da sola, «Pass time» è spento; alzato il budget finisce", async () => {
    const code = await heldRun();
    renderRoute(`/automations/${code}/runs/1`, ROBERTA);
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent("Waiting: monthly AI budget reached");
    expect(now).toHaveTextContent(
      "Step 1 “Ask Claude” starts again on its own when the budget is available — when someone raises it, or next month. Nothing is lost.",
    );
    expect(within(now).getByRole("button", { name: /Who/ })).toBeInTheDocument();
    expect(screen.getByText("Passing time won't move this run: it waits for the budget.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+1 day" })).toBeDisabled();
    // Il registro dice l'attesa nelle sue parole, non quelle di un'approvazione.
    expect(screen.getAllByText("Waiting: monthly AI budget reached")).toHaveLength(2);
    expect(screen.queryByText("Waiting for an approval")).toBeNull();

    await act(async () => {
      await instance.simulateBudgetReached(false);
      await automations.whenAutomationsIdle();
    });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Now" })).not.toHaveTextContent("Waiting"),
    );
  });

  it("nell'elenco: «Waiting» e la frase dell'attesa, non fra quelle fallite", async () => {
    const code = await heldRun();
    renderRoute(`/automations/${code}`, ROBERTA);
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-run-row="${code} #1"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row.querySelector("[data-run-status]")).toHaveAttribute(
      "data-run-status",
      "waiting_event",
    );
    expect(row).toHaveTextContent("Waiting for the AI budget · “Ask Claude”");
  });
});
