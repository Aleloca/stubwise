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

// Nuova e modifica (lotto 10, shape `vault.md` §3 «Nuova e modifica»): il
// modulo nel pannello di destra. Service · Label · URL · Username ·
// Password · Notes, niente «Generate» (VA-Q6); gli avvisi sotto Password e
// Notes; in modifica la password vuota resta quella di prima. Creare non
// chiede la cassaforte aperta; cambiare la password sì (Touch ID, poi salva).

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

const panel = () => screen.findByRole("region", { name: /credential/i });

describe("nuova e modifica di una credenziale", () => {
  it("New credential (chi crea): il modulo con gli avvisi; salvata, si apre il suo dettaglio e sta nell'elenco", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(await screen.findByRole("button", { name: "New credential" }));
    const p = within(await panel());
    expect(p.getByText("Encrypted on this Mac: the server never sees it.")).toBeInTheDocument();
    expect(p.getByText("Notes aren't encrypted: don't write secrets here.")).toBeInTheDocument();
    expect(p.queryByRole("button", { name: /generate/i })).toBeNull();
    const save = p.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.type(p.getByLabelText("Service"), "Brevo SMTP");
    await user.type(p.getByLabelText("Username"), "postmaster@acquedotto");
    await user.type(p.getByLabelText("Password"), "Zz9!mail-01");
    await user.click(save);
    const detail = within(await screen.findByRole("region", { name: "Credential Brevo SMTP" }));
    expect(detail.getByText("postmaster@acquedotto")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        [...document.querySelectorAll("li[data-credential]")].some((li) =>
          li.textContent?.includes("Brevo SMTP"),
        ),
      ).toBe(true),
    );
    // La password non resta nella pagina.
    expect(document.body.textContent).not.toContain("Zz9!mail-01");
  });

  it("chi non crea non vede New credential", async () => {
    renderRoute("/p/ACQ/credentials", "p-sara");
    await screen.findByRole("heading", { level: 1, name: "Credentials" });
    await screen.findByRole("button", { name: "Cloudflare" });
    expect(screen.queryByRole("button", { name: "New credential" })).toBeNull();
  });

  it("Edit: i campi in chiaro si cambiano; la password vuota resta quella di prima", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    await user.click(within(await panel()).getByRole("button", { name: "Edit" }));
    const p = within(await panel());
    expect(p.getByText("Leave empty to keep the current password.")).toBeInTheDocument();
    const label = p.getByLabelText("Label");
    await user.clear(label);
    await user.type(label, "Pannello nuovo");
    await user.click(p.getByRole("button", { name: "Save" }));
    const detail = within(await panel());
    expect(await detail.findByText("Pannello nuovo")).toBeInTheDocument();
    await user.click(detail.getByRole("button", { name: "Show the password of Aruba hosting" }));
    await waitFor(() => expect(detail.getByText("Kx4!pa-77Wq")).toBeInTheDocument());
  });

  it("Edit con una password nuova a cassaforte chiusa: Touch ID, poi salva; Show dà la nuova", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    await user.click(within(await panel()).getByRole("button", { name: "Edit" }));
    const p = within(await panel());
    await user.type(p.getByLabelText("Password"), "Nn1!nuova-22");
    await user.click(p.getByRole("button", { name: "Save" }));
    const detail = within(await panel());
    await user.click(
      await detail.findByRole("button", { name: "Show the password of Aruba hosting" }),
    );
    await waitFor(() => expect(detail.getByText("Nn1!nuova-22")).toBeInTheDocument());
  });

  it("Cancel in modifica torna al dettaglio senza salvare", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    await user.click(within(await panel()).getByRole("button", { name: "Edit" }));
    const p = within(await panel());
    await user.clear(p.getByLabelText("Service"));
    await user.click(p.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("region", { name: "Credential Aruba hosting" }),
    ).toBeInTheDocument();
  });

  it("chi legge senza gestire (Sara su Cloudflare) non ha Edit", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.CLOUDFLARE}`, "p-sara");
    const p = within(await panel());
    await p.findByText("ops@acquedotto");
    expect(p.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
