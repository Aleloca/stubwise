import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// Il registro degli accessi di TUTTO il progetto (lotto 10, shape `vault.md`
// §3 «Access log»): dal «⋯» della sezione, per chi gestisce le credenziali;
// righe con data, chi, la credenziale, l'azione e da dove (D-8, VA-Q5).

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

describe("il registro degli accessi del progetto", () => {
  it("dal «⋯» della sezione: tutte le credenziali, con da dove", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(await screen.findByRole("button", { name: "More for Credentials" }));
    await user.click(screen.getByRole("menuitem", { name: "Access log" }));
    const p = within(await screen.findByRole("region", { name: "Access log of ACQ" }));
    const list = await p.findByRole("list", { name: "Access log" });
    const text = list.textContent ?? "";
    expect(text).toContain("Aruba hosting");
    expect(text).toMatch(/from the Mac|from the browser/);
    // Le righe sono di più di una credenziale (il registro del progetto).
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(1);
  });

  it("chi non gestisce (Sara) non ha la voce", async () => {
    renderRoute("/p/ACQ/credentials", "p-sara");
    await screen.findByRole("button", { name: "Cloudflare" });
    expect(screen.queryByRole("button", { name: "More for Credentials" })).toBeNull();
  });
});
