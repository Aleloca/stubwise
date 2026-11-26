import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { VAULT_IDS } from "../../data/seed/vault";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { lastQueryClient, renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// Review I3: una password non resta nella cache di React Query — né il
// risultato di «Show» (dopo Hide la riga la scorda, e la mutazione anche),
// né le variabili di una creazione o di una password nuova.

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

/** Tutto ciò che tiene la QueryClient (query e mutazioni), in testo. */
const cached = () => {
  const c = lastQueryClient();
  return JSON.stringify([
    c
      .getQueryCache()
      .getAll()
      .map((q) => q.state.data),
    c
      .getMutationCache()
      .getAll()
      .map((m) => [m.state.data, m.state.variables]),
  ]);
};

describe("la password non resta nella cache", () => {
  it("Show: la mutazione non tiene la password; dopo Hide non c'è da nessuna parte", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(
      await screen.findByRole("button", { name: "Show the password of Aruba hosting" }),
    );
    await screen.findByText("Kx4!pa-77Wq");
    // Mostrata, la password sta nella riga, non nella cache.
    await waitFor(() => expect(cached()).not.toContain("Kx4!pa-77Wq"));
    await user.click(screen.getByRole("button", { name: "Hide the password of Aruba hosting" }));
    expect(document.body.textContent).not.toContain("Kx4!pa-77Wq");
    expect(cached()).not.toContain("Kx4!pa-77Wq");
  });

  it("la password nuova: le variabili non restano nella cache", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = within(await screen.findByRole("region", { name: "Credential Aruba hosting" }));
    await user.click(p.getByRole("button", { name: "Edit" }));
    await user.type(await p.findByLabelText("Password"), "Nn1!nuova-22");
    await user.click(p.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(cached()).not.toContain("Nn1!nuova-22"));
    await screen.findAllByRole("button", { name: "Show the password of Aruba hosting" });
    expect(cached()).not.toContain("Nn1!nuova-22");
  });

  // Quarta revisione, punto 6: il caso «creare» che il nome prometteva.
  it("creare: le variabili (con la password) non restano nella cache", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(await screen.findByRole("button", { name: "New credential" }));
    const p = within(await screen.findByRole("region", { name: "New credential" }));
    await user.type(p.getByLabelText("Service"), "Brevo SMTP");
    await user.type(p.getByLabelText("Password"), "Zz9!crea-77");
    await user.click(p.getByRole("button", { name: "Save" }));
    await screen.findByRole("region", { name: "Credential Brevo SMTP" });
    await waitFor(() => expect(cached()).not.toContain("Zz9!crea-77"));
    expect(cached()).toContain("Brevo SMTP");
  });
});
