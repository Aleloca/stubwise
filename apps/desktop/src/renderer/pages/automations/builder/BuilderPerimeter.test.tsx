import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_F1_AVAILABILITY, AUTOMATION_F2_AVAILABILITY } from "@stubwise/shared";
import { resetApi, setLatency } from "../../../data/api";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// R5 del piano della F1 (area 7): nella build app il costruttore offre solo
// i passi e gli inizi della fetta 1; gli altri ci sono, «Coming soon», e non
// si scelgono. Un flusso che li contiene ha il problema `not_available`. Qui
// la disponibilità della build app è finta: qui gira il prototipo, con le
// regole della F1.
// F2 (R1): con la disponibilità della F2, email, attese, inizi a orario e
// «email in arrivo» si scelgono; Claude (F3) resta «Coming soon».
const perimeter = vi.hoisted(() => ({ slice: 1 as 1 | 2 }));
vi.mock("../../../data/integration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../data/integration")>()),
  automationAvailability: () =>
    perimeter.slice === 2 ? AUTOMATION_F2_AVAILABILITY : AUTOMATION_F1_AVAILABILITY,
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
  perimeter.slice = 1;
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

describe("il costruttore della fetta 2", () => {
  beforeEach(() => {
    perimeter.slice = 2;
  });

  it("«Send an email» e «Wait» si scelgono; «Start another automation» è «Coming soon»", async () => {
    await open("/automations/STW-A1/edit");
    const before = stepIds();
    row(before[0]!).focus();
    await userEvent.keyboard("a");
    const menu = await screen.findByRole("dialog", { name: "Add a step" });
    expect(within(menu).getByRole("option", { name: /Send an email/ })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(within(menu).getByRole("option", { name: /^Wait/ })).not.toHaveAttribute("aria-disabled");
    const start = within(menu).getByRole("option", { name: /Start another automation/ });
    expect(start).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(menu).getByRole("option", { name: /Send an email/ }));
    await waitFor(() => expect(stepIds()).toHaveLength(before.length + 1));
  });

  it("gli inizi: «An email arrives» e l'orario si scelgono", async () => {
    await open("/automations/STW-A1/edit");
    expect(await screen.findByRole("radio", { name: /An email arrives in your mailbox/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /On a date or a schedule/ })).toBeEnabled();
  });

  it("Claude (F3) resta «Coming soon» sulla riga", async () => {
    await open("/automations/STW-A1/edit");
    await waitFor(() => expect(row("tr-classify")).toHaveTextContent("Coming soon"));
  });
});
