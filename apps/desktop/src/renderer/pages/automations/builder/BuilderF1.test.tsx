import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_F1_AVAILABILITY } from "@stubwise/shared";
import { resetApi, setLatency } from "../../../data/api";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// R5 del piano della F1 (area 7): nella build app il costruttore offre solo
// i passi e gli inizi della fetta 1; gli altri ci sono, «Coming soon», e non
// si scelgono. Un flusso che li contiene ha il problema `not_available`. Qui
// la disponibilità della build app è finta (la destinazione nella build app
// resta spenta finché il server dell'area 7 non c'è).
vi.mock("../../../data/integration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../data/integration")>()),
  automationAvailability: () => AUTOMATION_F1_AVAILABILITY,
}));

const LAURA = "p-laura";
const tree = () => screen.getByRole("tree");
const row = (id: string) => tree().querySelector<HTMLElement>(`[data-tree-row="${id}"]`)!;
const stepIds = () =>
  [...tree().querySelectorAll<HTMLElement>("[data-step-path]")].map((r) => r.dataset.treeRow);

async function open(path: string, personId = LAURA) {
  renderRoute(path, personId);
  await screen.findByRole("heading", { level: 1 });
  await screen.findByRole("tree");
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

describe("il costruttore della fetta 1", () => {
  it("il menu dei passi: «Send email» c'è, «Coming soon», e non si sceglie; «Create task» sì", async () => {
    await open("/automations/STW-A1/edit");
    const before = stepIds();
    row(before[0]!).focus();
    await userEvent.keyboard("a");
    const menu = await screen.findByRole("dialog", { name: "Add a step" });
    const email = within(menu).getByRole("option", { name: /Send an email/ });
    expect(email).toHaveAttribute("aria-disabled", "true");
    expect(email).toHaveTextContent("Coming soon");
    expect(within(menu).getByRole("option", { name: /Create a task/ })).not.toHaveAttribute("aria-disabled");
    await userEvent.click(email);
    // Né col clic né con la tastiera: cercato «email», Enter non crea niente.
    await userEvent.type(within(menu).getByRole("combobox"), "email");
    await userEvent.keyboard("{Enter}");
    expect(stepIds()).toEqual(before);
  });

  it("gli inizi: «A task is created» si sceglie, «An email arrives» è «Coming soon»", async () => {
    await open("/automations/STW-A1/edit");
    const mailStart = await screen.findByRole("radio", { name: /An email arrives in your mailbox/ });
    expect(mailStart).toBeDisabled();
    expect(mailStart).toHaveTextContent("Coming soon");
    expect(screen.getByRole("radio", { name: /A task is created/ })).toBeEnabled();
  });

  it("un passo che la fetta non offre (Claude, F3) ha il problema «Coming soon» sulla riga", async () => {
    await open("/automations/STW-A1/edit");
    await waitFor(() => expect(row("tr-classify")).toHaveTextContent("Coming soon"));
  });
});
