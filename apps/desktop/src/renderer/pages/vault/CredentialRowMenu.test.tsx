import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import type { CredentialView } from "../../data/vault/types";
import { queryKeys } from "../../data/queries";
import { lastQueryClient, renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// Il «⋯» di una riga (lotto 10, shape `vault.md` §3): secondo i permessi del
// server, Edit · Readers · Access log · Delete…; Delete è a due tempi in
// posto, come nel web.

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

async function openMenu(user: ReturnType<typeof userEvent.setup>, service: string) {
  await user.click(await screen.findByRole("button", { name: `More for ${service}` }));
  return within(await screen.findByRole("menu", { name: `Actions for ${service}` }));
}

describe("il «⋯» di una riga", () => {
  it("chi gestisce: Edit · Readers · Access log · Delete…", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    const menu = await openMenu(user, "Aruba hosting");
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Edit",
      "Readers",
      "Access log",
      "Delete…",
    ]);
  });

  it("chi legge senza gestire (Sara): solo Readers", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-sara");
    const menu = await openMenu(user, "Cloudflare");
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Readers"]);
  });

  it("Edit apre il dettaglio già in modifica", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    const menu = await openMenu(user, "Aruba hosting");
    await user.click(menu.getByRole("menuitem", { name: "Edit" }));
    const p = within(await screen.findByRole("region", { name: "Credential Aruba hosting" }));
    expect(await p.findByLabelText("Label")).toBeInTheDocument();
  });

  it("Delete… a due tempi in posto: la riga sparisce", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    const menu = await openMenu(user, "Aruba hosting");
    await user.click(menu.getByRole("menuitem", { name: "Delete…" }));
    // Il primo passo chiede soltanto.
    expect(
      screen.getByText("Delete Aruba hosting? Everyone who reads it loses it."),
    ).toBeInTheDocument();
    expect(services()).toContain("Aruba hosting");
    await user.click(screen.getByRole("button", { name: "Delete Aruba hosting" }));
    expect(await screen.findByText("Aruba hosting deleted.")).toBeInTheDocument();
    await waitFor(() => expect(services()).not.toContain("Aruba hosting"));
  });

  // Quarta revisione, punto 1: «Access log» lo apre il server (`canSeeLog`),
  // non «può modificare o condividere».
  it("chi modifica senza `canSeeLog`: niente Access log nel «⋯»", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await screen.findByRole("button", { name: "More for Aruba hosting" });
    const key = queryKeys.credentials("p-laura", "prj-acq");
    act(() =>
      lastQueryClient().setQueryData(key, (rows: CredentialView[] | undefined) =>
        rows?.map((r) => (r.service === "Aruba hosting" ? { ...r, canSeeLog: false } : r)),
      ),
    );
    const menu = await openMenu(user, "Aruba hosting");
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Edit",
      "Readers",
      "Delete…",
    ]);
  });
});
