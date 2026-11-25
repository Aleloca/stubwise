import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency, vault } from "../../data/api";
import { VAULT_IDS } from "../../data/seed/vault";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { queryKeys } from "../../data/queries";
import { lastQueryClient, renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// I lettori nel dettaglio (lotto 10, shape `vault.md` §3 «Readers»): chi la
// legge, con la fonte e il perché di chi aspetta; chi è aggiunto
// direttamente, con «Remove» (conferma a due tempi, poi la frase che dice di
// cambiare la password); «Share with» persone e ruoli del progetto. Share e
// Remove chiedono la cassaforte aperta (Touch ID, poi l'azione) e
// `credentials.share`.

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

const panel = async () =>
  within(await screen.findByRole("region", { name: "Credential Aruba hosting" }));
const row = (list: HTMLElement, name: string) =>
  within(list)
    .getAllByRole("listitem")
    .find((li) => li.textContent?.includes(name));

describe("i lettori di una credenziale", () => {
  it("chi la legge, con la fonte e il perché dell'attesa; chi è aggiunto direttamente", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = await panel();
    const who = await p.findByRole("list", { name: "Who reads it" });
    expect(row(who, "Laura Costa")?.textContent).toContain("created it");
    expect(row(who, "Roberta Fontana")?.textContent).toContain("full admin");
    // Marco ha la chiave in attesa di conferma (seme): il perché lo dice.
    expect(row(who, "Marco Bellini")?.textContent).toMatch(
      /role Developer.*waiting: their key needs confirmation/,
    );
    expect(row(who, "Federico Sartori")?.textContent).toContain("waiting: no vault key yet");
    const direct = p.getByRole("list", { name: "Added directly" });
    expect(row(direct, "role Developer")).toBeDefined();
  });

  it("Share with una persona: Touch ID, poi condivisa; compare fra gli aggiunti", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = await panel();
    await user.selectOptions(await p.findByLabelText("Share with"), "Sara Montanari");
    await user.click(p.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Shared with Sara Montanari.")).toBeInTheDocument();
    await waitFor(() =>
      expect(row(p.getByRole("list", { name: "Added directly" }), "Sara Montanari")).toBeDefined(),
    );
  });

  it("Remove: conferma a due tempi, poi la frase che resta, con Change the password", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = await panel();
    const direct = await p.findByRole("list", { name: "Added directly" });
    await user.click(
      within(row(direct, "role Developer")!).getByRole("button", { name: "Remove" }),
    );
    // Il primo clic chiede conferma, in posto: non toglie ancora.
    expect(row(p.getByRole("list", { name: "Added directly" }), "role Developer")).toBeDefined();
    await user.click(p.getByRole("button", { name: "Confirm remove" }));
    expect(
      await p.findByText(
        "Role Developer no longer reads this credential. If someone saw the password, change it on the service and here.",
      ),
    ).toBeInTheDocument();
    // Era l'unico aggiunto direttamente.
    expect(await p.findByText("Nobody added directly.")).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Change the password" }));
    expect(await p.findByLabelText("Password")).toBeInTheDocument();
  });

  it("chi legge senza poter condividere vede chi la legge, ma niente Share né Remove", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.CLOUDFLARE}`, "p-sara");
    const p = within(await screen.findByRole("region", { name: "Credential Cloudflare" }));
    await p.findByRole("list", { name: "Who reads it" });
    expect(p.queryByLabelText("Share with")).toBeNull();
    expect(p.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  // Review I4: condividere vuol dire ricifrare la PROPRIA copia della chiave
  // per un altro: chi gestisce senza leggere non ce l'ha. Niente «Share
  // with», e la frase che dice perché.
  it("chi gestisce senza leggere (Matteo su Aruba): niente Share with, e il perché", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-matteo");
    const p = await panel();
    await p.findByRole("list", { name: "Who reads it" });
    expect(p.queryByLabelText("Share with")).toBeNull();
    // Quarta revisione, punto 3: «Remove» come Share, solo a chi legge.
    expect(p.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(
      p.getByText("You can share it once you read it yourself: ask someone who reads it."),
    ).toBeInTheDocument();
  });

  // Review M3: senza il nome del ruolo (un server di prima), «via a role»,
  // non «role » vuoto.
  it("un lettore via ruolo senza nome del ruolo: «via a role»", async () => {
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = await panel();
    await p.findByRole("list", { name: "Who reads it" });
    act(() =>
      lastQueryClient().setQueryData(queryKeys.readers("p-laura", VAULT_IDS.ARUBA), {
        direct: [],
        effective: [
          {
            personId: "p-x",
            name: "Marco Bellini",
            source: "role",
            roleName: null,
            state: "reads",
          },
        ],
        canShare: false,
      }),
    );
    const who = await p.findByRole("list", { name: "Who reads it" });
    await waitFor(() => expect(row(who, "Marco Bellini")?.textContent).toContain("via a role"));
  });

  // Review M7: un solo Touch ID per azione. Share fa il suo tocco nel main:
  // a cassaforte chiusa il renderer non la apre prima (sarebbe il secondo),
  // e la cassaforte resta chiusa.
  it("M7: Share a cassaforte chiusa: nessuna apertura prima, e resta chiusa", async () => {
    const user = userEvent.setup();
    renderRoute(`/p/ACQ/credentials?credential=${VAULT_IDS.ARUBA}`, "p-laura");
    const p = await panel();
    await act(async () => {
      await vault.lock();
    });
    const unlock = vi.spyOn(vault, "unlock");
    try {
      await user.selectOptions(await p.findByLabelText("Share with"), "Sara Montanari");
      await user.click(p.getByRole("button", { name: "Share" }));
      expect(await screen.findByText("Shared with Sara Montanari.")).toBeInTheDocument();
      expect(unlock).not.toHaveBeenCalled();
      expect((await vault.getVaultStatus()).state).toBe("locked");
    } finally {
      unlock.mockRestore();
    }
  });
});
