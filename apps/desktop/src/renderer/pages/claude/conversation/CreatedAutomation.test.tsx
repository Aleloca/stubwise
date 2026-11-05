import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import type { AutomationRow } from "../../../data/types";
import i18n from "../../../i18n";
import { renderWithData } from "../../../test/renderWithData";
import { ExecutedRow } from "./ExecutedRow";
import type { Ev } from "./flow";

// La riga «Created AUD-A1 …» (area 10b, ri-revisione finale del 5 nov 2026):
// finché l'elenco delle automazioni non è arrivato, il codice NON è il
// codice spento di ciò che non si può aprire (R-E9): sarebbe un lampo di
// «You can't open this» prima del link. Mentre carica è neutro; arrivato,
// è un link se chi legge la vede, spento se no.

const MATTEO = "p-matteo";
const CODE = "AUD-A1";

beforeEach(async () => {
  api.setLatency(0);
  api.resetApi();
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());

const event = {
  type: "executed",
  groupId: "grp-test",
  status: "done",
  actions: [{ fn: "createAutomation", args: { projectId: "prj-aud" } }],
  objectCodes: [CODE],
  resultCodes: [CODE],
} as unknown as Ev<"executed">;

function mount() {
  return renderWithData(
    <ExecutedRow
      conversationId="cv-test"
      event={event}
      undo={undefined}
      viewerId={MATTEO}
      ownerId={MATTEO}
      viewerName="Matteo"
    />,
    { personId: MATTEO },
  );
}

/** L'elenco delle automazioni fermo finché il test non lo lascia arrivare. */
function holdAutomations() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const real = api.automations.listAutomations;
  vi.spyOn(api.automations, "listAutomations").mockImplementation(async (filter) => {
    const rows = await real(filter);
    await gate;
    return rows;
  });
  return release;
}

const row = () => document.querySelector<HTMLElement>('[data-executed-action="createAutomation"]')!;

describe("CreatedAutomation mentre l'elenco carica", () => {
  it("il codice non è spento né «You can't open this» prima che le automazioni arrivino; poi è il link", async () => {
    const release = holdAutomations();
    mount();
    await waitFor(() => expect(row()).toHaveTextContent(`Created ${CODE}`));
    // Ancora in attesa: nessun codice spento, nessun titolo, nessun link.
    expect(row().querySelector('[data-citation="hidden"]')).toBeNull();
    expect(row().querySelector("[title]")).toBeNull();
    expect(screen.queryByRole("link", { name: CODE })).toBeNull();
    release();
    const link = await screen.findByRole("link", { name: CODE });
    expect(link).toHaveAttribute("href", `#/automations/${CODE}/edit`);
    expect(row().querySelector('[data-citation="hidden"]')).toBeNull();
  });

  it("arrivato l'elenco senza quell'automazione (chi legge non la vede): il codice spento", async () => {
    vi.spyOn(api.automations, "listAutomations").mockResolvedValue([] as AutomationRow[]);
    mount();
    await waitFor(() => expect(row().querySelector('[data-citation="hidden"]')).not.toBeNull());
    expect(screen.queryByRole("link", { name: CODE })).toBeNull();
  });
});
