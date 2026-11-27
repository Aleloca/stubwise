import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { state } from "../../data/store";
import { fillableFor } from "../../layout/claudePanel/fillable";
import { renderRoute } from "../../test/renderRoute";

// DESIGN e PLAN sulla task (shape `design-plan-remove.md`, DP-Q2, DP-Q2b,
// DP-Q3): chiuse di default; finché il design c'è la descrizione non si
// modifica; «Remove…» nel «⋯» con `tickets.edit`.

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

const section = (title: string) =>
  screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;

describe("design e piano sulla task", () => {
  it("chiuse di default; la descrizione non si modifica finché il design c'è", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/tasks?task=AUD-5", "p-laura");
    await screen.findByRole("heading", { name: "Design" });
    expect(within(section("Design")).queryByText("Call history export")).toBeNull();
    await user.click(within(section("Design")).getByRole("button", { name: "Show" }));
    expect(within(section("Design")).getByText("Call history export")).toBeInTheDocument();
    const description = section("Description");
    expect(within(description).getByText("Remove the design to edit the description.")).toBeInTheDocument();
    expect(within(description).queryByRole("button", { name: /edit/i })).toBeNull();
  });

  it("I1: col design attivo Claude non può riempire la descrizione (riscriverebbe il design); tolto, sì", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/tasks?task=AUD-5", "p-laura");
    await screen.findByRole("heading", { name: "Design" });
    expect(fillableFor({ kind: "taskDescription", taskId: "t-aud-5" })).toBeNull();
    await user.click(within(section("Design")).getByRole("button", { name: "More for the design" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove design…" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Remove the design?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fillableFor({ kind: "taskDescription", taskId: "t-aud-5" })).not.toBeNull());
  });

  it("I1: finché design e piano si leggono, «Edit» della descrizione non c'è", async () => {
    const pending = vi.spyOn(api, "getTaskDesignPlan").mockReturnValue(new Promise(() => {}));
    try {
      renderRoute("/p/AUD/tasks?task=AUD-4", "p-laura");
      const description = await screen.findByRole("heading", { name: "Description" });
      expect(within(description.closest("section")!).queryByRole("button", { name: /edit|add/i })).toBeNull();
      expect(fillableFor({ kind: "taskDescription", taskId: "t-aud-4" })).toBeNull();
    } finally {
      pending.mockRestore();
    }
  });

  it("togliere il design: la sezione sparisce e la descrizione torna modificabile", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/tasks?task=AUD-5", "p-laura");
    await screen.findByRole("heading", { name: "Design" });
    await user.click(within(section("Design")).getByRole("button", { name: "More for the design" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove design…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the design?" });
    expect(dialog.textContent).toContain("The description goes back to the original text.");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Design" })).toBeNull());
    expect(state.taskDesigns["t-aud-5"]!.design).toBeNull();
    expect(within(section("Description")).queryByText("Remove the design to edit the description.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
  });

  it("chi non ha `tickets.edit` legge, senza «⋯»", async () => {
    renderRoute("/p/AUD/tasks?task=AUD-5", "p-giulia");
    await screen.findByRole("heading", { name: "Design" });
    expect(screen.queryByRole("button", { name: "More for the design" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More for the plan" })).toBeNull();
  });
});
