import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

// «Remove design…» e «Remove plan…» sulla richiesta (shape
// `design-plan-remove.md`, DP-Q1): nel «⋯» della sezione, con un dialogo che
// dice la conseguenza; solo con `backlog.edit`.

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

const section = (title: string) =>
  screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;

describe("togliere design e piano da una richiesta", () => {
  it("Laura toglie il design: il dialogo dice che la descrizione resta; la sezione sparisce", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/requests?request=req-aud-2", "p-laura");
    await screen.findByRole("heading", { name: "Design" });
    await user.click(within(section("Design")).getByRole("button", { name: "More for the design" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove design…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the design?" });
    expect(dialog.textContent).toContain("the request keeps its description");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Design" })).toBeNull());
    expect(await screen.findByText("Design removed")).toBeInTheDocument();
    expect(state.requests.find((r) => r.id === "req-aud-2")!.design).toBeNull();
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
  });

  it("e il piano", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/requests?request=req-aud-2", "p-laura");
    await screen.findByRole("heading", { name: "Plan" });
    await user.click(within(section("Plan")).getByRole("button", { name: "More for the plan" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove plan…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the plan?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Plan" })).toBeNull());
  });

  it("chi non ha `backlog.edit` legge design e piano senza il «⋯»", async () => {
    renderRoute("/p/AUD/requests?request=req-aud-2", "p-giulia");
    await screen.findByRole("heading", { name: "Design" });
    expect(screen.queryByRole("button", { name: "More for the design" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More for the plan" })).toBeNull();
  });
});
