import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { VAULT_IDS } from "../../data/seed/vault";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// Il dettaglio di una credenziale (lotto 10, shape `vault.md` §3): il
// pannello di destra su `?credential=<id>`, coi campi, la password che si
// mostra (e resta finché «Hide», VA-Q3), le note in chiaro con l'avviso, e
// il registro degli accessi con «da dove» per chi gestisce (VA-Q5).

const PASSWORDS = /Kx4!pa|Gq7#v2|mg-Tr9|sk-Wd2|Fg5&k1/;
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

const panel = () => screen.findByRole("region", { name: /Credential/ });

describe("il dettaglio di una credenziale", () => {
  it("dalla riga: il pannello coi campi, la password in pallini, le note con l'avviso", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Aruba hosting" }));
    const p = within(await panel());
    expect(p.getByText("admin@acquedotto")).toBeInTheDocument();
    expect(p.getByText("https://admin.aruba.it")).toBeInTheDocument();
    expect(p.getByText("Panel for the production server.")).toBeInTheDocument();
    expect(p.getByText("Notes aren't encrypted.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(PASSWORDS);
  });

  it("Show nel pannello apre col Touch ID e mostra; resta finché Hide", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = within(await panel());
    await user.click(p.getByRole("button", { name: "Show the password of Aruba hosting" }));
    await waitFor(() => expect(p.getByText("Kx4!pa-77Wq")).toBeInTheDocument());
    await user.click(p.getByRole("button", { name: "Hide the password of Aruba hosting" }));
    expect(document.body.textContent).not.toMatch(PASSWORDS);
  });

  it("il registro degli accessi (chi gestisce), con «from the Mac» e «from the browser»", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = within(await panel());
    const log = await p.findByRole("list", { name: "Access log" });
    expect(log.textContent).toMatch(/Laura Costa.*shown.*from the Mac/);
  });

  it("Sara legge Cloudflare ma non la gestisce: niente registro", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.CLOUDFLARE}`, "p-sara");
    const p = within(await panel());
    await p.findByText("ops@acquedotto");
    expect(p.queryByRole("list", { name: "Access log" })).toBeNull();
  });

  it("una credenziale che chi guarda non vede: il pannello non si apre", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.FIGMA}`, "p-laura");
    await screen.findByRole("heading", { level: 1, name: "Credentials" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: /Credential/ })).toBeNull();
  });
});
