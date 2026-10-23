import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, listTasks, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

async function countFor(personId: string, filterId: string) {
  setSessionPersonId(personId);
  return (await listTasks(state.filters.find((f) => f.id === filterId)!.criteria)).length;
}

const group = (name: string) => screen.getByRole("region", { name });
const row = (region: HTMLElement, name: string) =>
  within(region).getByRole("link", { name }).closest("li")!;

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("AllFiltersPage", () => {
  it("«Mine» ha i filtri di chi guarda (privati e pubblici), «Public» quelli pubblici degli altri", async () => {
    renderRoute("/filters", "p-giulia");
    expect(await screen.findByRole("heading", { level: 1, name: "All filters" })).toBeInTheDocument();
    await screen.findByRole("region", { name: "Mine" });
    const mine = within(group("Mine")).getAllByRole("link").map((l) => l.textContent);
    expect(mine).toEqual(["Marketing this week", "Mix Cucine, waiting", "No estimate"]);
    const pub = within(group("Public")).getAllByRole("link").map((l) => l.textContent);
    expect(pub).toEqual(["Closed this month", "Open", "Stalled for more than 7 days", "Unassigned"]);
    expect(within(row(group("Public"), "Open")).getByText("Roberta Fontana")).toBeInTheDocument();
    expect(within(row(group("Mine"), "Mix Cucine, waiting")).getByText("Private")).toBeInTheDocument();
  });

  it("Review Focus 2: il conteggio è di chi guarda, non dell'autore", async () => {
    const giulia = await countFor("p-giulia", "flt-no-estimate");
    const sara = await countFor("p-sara", "flt-no-estimate");
    expect(sara).not.toBe(giulia);
    renderRoute("/filters", "p-sara");
    const pub = await screen.findByRole("region", { name: "Public" });
    const line = await waitFor(() => row(pub, "No estimate"));
    expect(await within(line).findByText(`${sara} tasks`)).toBeInTheDocument();
    expect(within(line).queryByText(`${giulia} tasks`)).toBeNull();
  });

  it("i privati degli altri non ci sono; il pin si accende e si spegne", async () => {
    renderRoute("/filters", "p-sara");
    const mine = await screen.findByRole("region", { name: "Mine" });
    expect(screen.queryByRole("link", { name: "Marketing this week" })).toBeNull();
    expect(within(mine).getByText("You haven't saved any filters yet.")).toBeInTheDocument();
    const pub = group("Public");
    const pin = within(row(pub, "Open")).getByRole("button", { name: "Pin Open to the column" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(pin);
    await waitFor(() => expect(pin).toHaveAttribute("aria-pressed", "true"));
    const nav = screen.getByRole("navigation", { name: "Home views" });
    expect(await within(nav).findByRole("link", { name: "Open" })).toBeInTheDocument();
  });

  it("errore con Retry", async () => {
    failNext("listSavedFilters");
    renderRoute("/filters", "p-giulia");
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Mine" })).toBeInTheDocument();
  });
});
