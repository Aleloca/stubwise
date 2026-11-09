import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessState } from "../../data/access/state";
import { automations, instance, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { setSessionPersonId } from "../../data/session";
import type { AutomationFlow } from "../../data/types";
import { setLanguage } from "../../i18n";
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

describe("I2 e la pausa di chi è stato disattivato", () => {
  it("annullata mentre aspetta: nell'elenco dice «Cancelled», non «Waiting»", async () => {
    const code = await heldRun();
    const auto = state.automations.find((x) => x.code === code)!;
    const run = state.automationRuns.find((r) => r.automationId === auto.id)!;
    await automations.cancelRun(run.id);
    renderRoute(`/automations/${code}`, ROBERTA);
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-run-row="${code} #1"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row.querySelector("[data-run-status]")).toHaveAttribute("data-run-status", "cancelled");
    expect(row).not.toHaveTextContent("Waiting for the AI budget");
  });

  it("ferma per la coda di STW messa da una persona poi disattivata: il nome lo dice", async () => {
    setSessionPersonId(ROBERTA);
    state.instance.queuePauses[0]!.byId = "p-marco";
    accessState().people.find((p) => p.personId === "p-marco")!.status = "deactivated";
    const a = await automations.createAutomation({ name: "Triage", projectId: "prj-stw", flow });
    const live = await automations.activate(a.id);
    await automations.startManual(a.id);
    await automations.whenAutomationsIdle();
    renderRoute(`/automations/${live.code}/runs/1`, ROBERTA);
    const now = await screen.findByRole("region", { name: "Now" });
    await waitFor(() =>
      expect(now).toHaveTextContent("Waiting: STW's queue is paused by Marco Bellini (deactivated)"),
    );
    expect(screen.getByText("Waiting: queue paused by Marco Bellini (deactivated)")).toBeInTheDocument();
  });
});

describe("due blocchi: il registro dice quando il blocco cambia", () => {
  it("budget tornato con STW in pausa: «Budget available again · still waiting: queue paused by …», in en e it", async () => {
    setSessionPersonId(ROBERTA);
    await instance.simulateBudgetReached(true);
    const a = await automations.createAutomation({ name: "Triage", projectId: "prj-stw", flow });
    const live = await automations.activate(a.id);
    await automations.startManual(a.id);
    await automations.whenAutomationsIdle();
    await instance.simulateBudgetReached(false);
    await automations.whenAutomationsIdle();
    renderRoute(`/automations/${live.code}/runs/1`, ROBERTA);
    expect(
      await screen.findByText(
        "Budget available again · still waiting: queue paused by Roberta Fontana",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Waiting for an approval")).toBeNull();
    act(() => setLanguage("it"));
    expect(
      await screen.findByText(
        "Budget di nuovo disponibile · ancora in attesa: coda in pausa da Roberta Fontana",
      ),
    ).toBeInTheDocument();
    act(() => setLanguage("en"));
  });

  it("coda ripresa col budget esaurito: «Queue resumed · still waiting: monthly AI budget reached»", async () => {
    setSessionPersonId(ROBERTA);
    const a = await automations.createAutomation({ name: "Triage", projectId: "prj-stw", flow });
    const live = await automations.activate(a.id);
    await automations.startManual(a.id);
    await automations.whenAutomationsIdle();
    await instance.simulateBudgetReached(true);
    await instance.resumeQueue("prj-stw");
    await automations.whenAutomationsIdle();
    renderRoute(`/automations/${live.code}/runs/1`, ROBERTA);
    expect(
      await screen.findByText("Queue resumed · still waiting: monthly AI budget reached"),
    ).toBeInTheDocument();
  });
});
