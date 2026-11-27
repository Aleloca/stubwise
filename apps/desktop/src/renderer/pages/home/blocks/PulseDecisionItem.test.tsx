import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { state } from "../../../data/store";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { clearPendingAnswers } from "../pendingAnswers";

// Le proposte del polso in «Decide» (shape `pulse-proposals.md`, PQ-1b): TRM
// fermo da 9 giorni, le due richieste con la suggerita già scelta, la
// conseguenza scritta prima di Start, e Start che crea la task e fa partire
// Claude. Laura la riceve; Sara (senza `runs.start`) no.

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});
afterEach(() => {
  clearPendingAnswers();
  clearToasts();
});

const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");

async function proposal(person = "p-laura"): Promise<HTMLElement> {
  renderRoute("/home", person);
  const decide = await screen.findByRole("region", { name: "Decide" });
  await waitFor(async () => {
    const more = within(decide).queryByRole("button", { name: /^Show \d+ more$/ });
    if (more && !decide.querySelector("[data-pulse-proposal]")) await userEvent.click(more);
    expect(decide.querySelector("[data-pulse-proposal]")).not.toBeNull();
  });
  return decide.querySelector<HTMLElement>("[data-pulse-proposal]")!;
}

describe("Decide: le proposte del polso", () => {
  it("il progetto fermo, le voci con urgenza ed effort, la suggerita scelta, la conseguenza prima di Start", async () => {
    const row = await proposal();
    expect(flat(row)).toContain("TRM has been idle for 9 days. Pick what to start.");
    const options = within(row).getAllByRole("radio");
    expect(options).toHaveLength(2);
    expect(options[0]).toBeChecked();
    expect(flat(row)).toContain("Delivery photos from the drivers' app");
    expect(flat(row)).toContain("High urgency");
    expect(row.querySelector("[data-suggested]")?.textContent).toBe("Suggested");
    expect(flat(row)).toContain("Claude writes a plan first, and it waits for approval before any code changes.");
  });

  it("Start sulla seconda voce: nasce la task da quella richiesta, la riga sparisce, il toast la apre", async () => {
    const row = await proposal();
    const user = userEvent.setup();
    await user.click(within(row).getAllByRole("radio")[1]!);
    await user.click(within(row).getByRole("button", { name: "Start" }));
    const toast = await screen.findByText(/^Started TRM-\d+: Claude is writing the plan\.$/);
    const code = /TRM-\d+/.exec(toast.textContent ?? "")![0];
    expect([...state.tasksById.values()].find((t) => t.code === code)?.title).toBe("Sign-off on the delivery note");
    await waitFor(() => expect(document.querySelector("[data-pulse-proposal]")).toBeNull());
  });

  it("una voce non più aperta lo dice in parole, e Start si spegne", async () => {
    const row = await proposal();
    state.requests.find((r) => r.id === "req-trm-1")!.status = "archived";
    await userEvent.click(within(row).getByRole("button", { name: "Start" }));
    expect((await within(row).findByRole("alert")).textContent).toBe(
      "This proposal is out of date: nothing was started.",
    );
    expect(within(row).getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("Not now la toglie a chi lo preme", async () => {
    const row = await proposal();
    await userEvent.click(within(row).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(document.querySelector("[data-pulse-proposal]")).toBeNull());
    expect(state.pulseProposals[0]!.dismissedBy).toEqual(["p-laura"]);
  });

  it("chi non può avviare lavoro in TRM non la vede", async () => {
    state.pulseProposals[0]!.recipientIds.push("p-sara");
    renderRoute("/home", "p-sara");
    const decide = await screen.findByRole("region", { name: "Decide" });
    await waitFor(() => expect(decide.getAttribute("aria-busy")).not.toBe("true"));
    expect(decide.querySelector("[data-pulse-proposal]")).toBeNull();
  });
});
