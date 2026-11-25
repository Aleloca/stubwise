import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// La pagina unica «Vault» (lotto 10, VA-Q1 «Entrambe», shape `vault.md` §3):
// una destinazione della barra laterale dopo Drive, con le credenziali di
// tutti i progetti di chi guarda, il codice del progetto prima del servizio
// (link alla sezione), la ricerca, il filtro per progetto nell'indirizzo, la
// riga degli accessi da confermare e «New credential» che chiede il progetto.

let clip = "";
beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(CREDENTIAL_PANEL_DOCKED_QUERY, true);
  clip = "";
  setVaultClipboard({ write: (t) => void (clip = t), read: () => clip });
});
afterEach(() => act(() => setLanguage("en")));

const services = () =>
  [...document.querySelectorAll("li[data-credential]")].map(
    (li) => li.querySelector("button")?.textContent ?? "",
  );

describe("la pagina Vault", () => {
  it("la voce Vault in barra laterale, subito dopo Drive; la pagina con codice e link al progetto", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    const nav = await screen.findByRole("navigation", { name: /main/i });
    const links = within(nav)
      .getAllByRole("link")
      .map((a) => a.getAttribute("aria-label"));
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "Vault" })).toBeInTheDocument(),
    );
    const order = within(nav)
      .getAllByRole("link")
      .map((a) => a.getAttribute("aria-label"));
    expect(order.indexOf("Vault")).toBe(order.indexOf("Drive") + 1);
    expect(links).toContain("Drive");
    await user.click(within(nav).getByRole("link", { name: "Vault" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Vault" })).toBeInTheDocument();
    expect(
      screen.getByText("Every credential you can read, in all your projects."),
    ).toBeInTheDocument();
    await waitFor(() => expect(services()).toContain("Aruba hosting"));
    const acq = screen.getAllByRole("link", { name: "ACQ" })[0]!;
    expect(acq.getAttribute("href")).toMatch(/\/p\/ACQ\/credentials$/);
  });

  it("il filtro per progetto (nell'indirizzo) e la ricerca", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/vault", "p-matteo");
    await waitFor(() => expect(services()).toEqual(expect.arrayContaining(["Figma", "Stripe"])));
    await user.click(screen.getByRole("button", { name: "MKX" }));
    await waitFor(() => expect(services()).toEqual(["Figma"]));
    expect((router.state.location.search as Record<string, unknown>).projects).toBe("MKX");
    await user.click(screen.getByRole("button", { name: "MKX" }));
    await waitFor(() => expect(services()).toContain("Stripe"));
    await user.type(screen.getByRole("searchbox", { name: "Search credentials" }), "cloud");
    await waitFor(() => expect(services()).toEqual(["Cloudflare"]));
    await user.clear(screen.getByRole("searchbox", { name: "Search credentials" }));
    await user.type(screen.getByRole("searchbox", { name: "Search credentials" }), "nessuna");
    expect(await screen.findByText("No credentials match your search.")).toBeInTheDocument();
  });

  it("New credential chiede prima il progetto (solo quelli dove si crea), poi è nell'elenco", async () => {
    const user = userEvent.setup();
    renderRoute("/vault", "p-giulia");
    await user.click(await screen.findByRole("button", { name: "New credential" }));
    const p = within(await screen.findByRole("region", { name: "New credential" }));
    const project = p.getByLabelText("Project");
    await user.selectOptions(project, "MKX");
    await user.type(p.getByLabelText("Service"), "Brevo SMTP");
    await user.type(p.getByLabelText("Password"), "Bb3!brevo-99");
    await user.click(p.getByRole("button", { name: "Save" }));
    await screen.findByRole("region", { name: "Credential Brevo SMTP" });
    await waitFor(() => expect(services()).toContain("Brevo SMTP"));
  });

  it("chi non crea non ha New credential; la riga degli accessi da confermare c'è per chi conferma", async () => {
    renderRoute("/vault", "p-sara");
    await waitFor(() => expect(services()).toEqual(["Cloudflare"]));
    expect(screen.queryByRole("button", { name: "New credential" })).toBeNull();
    expect(screen.queryByText(/waiting for access/)).toBeNull();
  });

  it("Laura vede la riga degli accessi da confermare anche qui", async () => {
    renderRoute("/vault", "p-laura");
    expect(await screen.findByText(/waiting for access/)).toBeInTheDocument();
  });

  it("con la cassaforte dell'istanza non attiva la voce Vault non c'è (Drive sì)", async () => {
    state.vault.active = false;
    renderRoute("/home", "p-laura");
    const nav = await screen.findByRole("navigation", { name: /main/i });
    await within(nav).findByRole("link", { name: "Drive" });
    await new Promise((r) => setTimeout(r, 50));
    expect(within(nav).queryByRole("link", { name: "Vault" })).toBeNull();
  });
});
