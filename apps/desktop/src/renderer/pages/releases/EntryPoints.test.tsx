import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// Le porte d'ingresso della sezione Releases (Task 8): il blocco Home
// «Releases» ([R 22], [R 23]) e il gruppo «Releases» di ⌘K (R-G5).

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

describe("Home — blocco «Releases»", () => {
  it("Laura (release.merge, Home non personalizzata): prima il fallito, poi la pronta; nessun «Release»", async () => {
    const router = renderRoute("/home", "p-laura");
    const block = await screen.findByRole("region", { name: /^Releases/ });
    const rows = await within(block).findAllByRole("link");
    expect(rows[0]).toHaveTextContent("AUD-V3");
    expect(rows[0]).toHaveTextContent("Failed");
    expect(within(block).getByRole("link", { name: /audin-app#244/ })).toBeInTheDocument();
    expect(within(block).queryByRole("button", { name: /^Release/ })).toBeNull();
    // La riga della PR apre la sezione col pannello: il merge si fa col contesto.
    await userEvent.click(within(block).getByRole("link", { name: /audin-app#244/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/releases"));
    expect(router.state.location.search).toMatchObject({ pr: "opr-aud-244" });
  });

  it("Marco (senza release.merge e con la Home personalizzata): il blocco non c'è", async () => {
    renderRoute("/home", "p-marco");
    await screen.findByRole("region", { name: /^Decide/ });
    expect(screen.queryByRole("region", { name: /^Releases/ })).toBeNull();
  });
});

describe("⌘K — gruppo «Releases»", () => {
  it("un rilascio per codice: codice · titolo · stato, e porta al dettaglio", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-laura");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "AUD-V3");
    const group = await within(dialog).findByRole("group", { name: "Releases" });
    const option = within(group).getByRole("option", { name: /AUD-V3/ });
    expect(option).toHaveTextContent("Invoices with the VAT number");
    expect(option).toHaveTextContent("Failed");
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/releases/AUD-V3"));
  });

  it("chi non vede il progetto non trova il rilascio (R-G5)", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-sara");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "AUD-V3");
    await waitFor(() => expect(within(dialog).queryByText(/Searching|Loading/i)).toBeNull());
    await new Promise((r) => setTimeout(r, 200));
    expect(within(dialog).queryByRole("group", { name: "Releases" })).toBeNull();
  });
});
