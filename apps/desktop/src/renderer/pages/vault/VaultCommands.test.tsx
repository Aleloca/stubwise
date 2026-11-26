import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency, vault } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// I comandi ⌘K della cassaforte (lotto 10, shape `vault.md` §3): «Open the
// vault» (chiusa: Touch ID da qualunque pagina), «Lock the vault» (aperta),
// «Pair this Mac» (da associare), «Find a credential» (apre la Vault con la
// ricerca). Ognuno c'è solo nello stato in cui ha senso.

let clip = "";
beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  clip = "";
  setVaultClipboard({ write: (t) => void (clip = t), read: () => clip });
});
afterEach(() => act(() => setLanguage("en")));

async function palette(user: ReturnType<typeof userEvent.setup>, query: string) {
  await user.keyboard("{Control>}k{/Control}");
  const d = within(await screen.findByRole("dialog", { name: "Search and commands" }));
  await user.type(d.getByRole("combobox"), query);
  return d;
}
const names = (d: ReturnType<typeof within>) =>
  d.queryAllByRole("option").map((o: HTMLElement) => o.textContent ?? "");

describe("i comandi ⌘K della cassaforte", () => {
  it("chiusa: «Open the vault» apre col Touch ID, da qualunque pagina; poi c'è «Lock the vault»", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    await screen.findByRole("navigation", { name: /main/i });
    let d = await palette(user, "vault");
    await waitFor(() =>
      expect(names(d).some((n: string) => n.includes("Open the vault"))).toBe(true),
    );
    expect(names(d).some((n: string) => n.includes("Lock the vault"))).toBe(false);
    await user.click(d.getByRole("option", { name: /Open the vault/ }));
    await waitFor(async () => expect((await vault.getVaultStatus()).state).toBe("open"));
    d = await palette(user, "vault");
    await waitFor(() =>
      expect(names(d).some((n: string) => n.includes("Lock the vault"))).toBe(true),
    );
    await user.click(d.getByRole("option", { name: /Lock the vault/ }));
    await waitFor(async () => expect((await vault.getVaultStatus()).state).toBe("locked"));
  });

  it("da associare: «Pair this Mac» apre la finestra dell'associazione", async () => {
    const user = userEvent.setup();
    setSessionPersonId("p-laura");
    await vault.forgetThisMac();
    renderRoute("/home", "p-laura");
    await screen.findByRole("navigation", { name: /main/i });
    const d = await palette(user, "pair");
    await user.click(await d.findByRole("option", { name: /Pair this Mac/ }));
    expect(await screen.findByRole("dialog", { name: "Pair this Mac" })).toBeInTheDocument();
  });

  it("«Find a credential» apre la Vault con la ricerca a fuoco", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    await screen.findByRole("navigation", { name: /main/i });
    const d = await palette(user, "find a cred");
    await user.click(await d.findByRole("option", { name: /Find a credential/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Vault" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: "Search credentials" })).toHaveFocus(),
    );
  });

  it("con la cassaforte dell'istanza non attiva, nessuno dei quattro", async () => {
    const user = userEvent.setup();
    state.vault.active = false;
    renderRoute("/home", "p-laura");
    await screen.findByRole("navigation", { name: /main/i });
    const d = await palette(user, "vault");
    await new Promise((r) => setTimeout(r, 50));
    // «Ask Claude: “vault”» cita il testo scritto: non è uno dei quattro.
    const four = ["Open the vault", "Lock the vault", "Pair this Mac", "Find a credential"];
    expect(names(d).filter((n: string) => four.some((f) => n.includes(f)))).toEqual([]);
  });
});
