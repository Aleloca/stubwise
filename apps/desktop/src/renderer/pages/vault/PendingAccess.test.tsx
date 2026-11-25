import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency, vault } from "../../data/api";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// Gli accessi da confermare (lotto 10, shape `vault.md` §3): una riga sotto
// la barra per chi ha persone da confermare, «Review» apre il pannello con
// una scheda per persona (email, data e dispositivo della chiave,
// l'impronta, quante credenziali). Confirm e Reject sono a due tempi con la
// domanda intera [VA 7]; vogliono la cassaforte aperta (Touch ID, poi
// l'azione). Le frasi non presumono il genere: dicono il nome.

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

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  renderRoute("/p/ACQ/credentials", "p-laura");
  expect(await screen.findByText(/waiting for access/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Review" }));
  return within(await screen.findByRole("region", { name: "Waiting for access" }));
}

const card = (p: ReturnType<typeof within>, name: string) =>
  within(p.getAllByRole("article").find((a: HTMLElement) => a.textContent?.includes(name))!);

describe("gli accessi da confermare", () => {
  it("la riga sotto la barra e, da Review, la scheda della persona con l'impronta", async () => {
    const user = userEvent.setup();
    const p = await openReview(user);
    const marco = card(p, "Marco Bellini");
    expect(marco.getByText(/@/)).toBeInTheDocument();
    expect(marco.getByText("Device: Chrome on macOS")).toBeInTheDocument();
    expect(marco.getByText("7d20 e5a9 c31f 6b84")).toBeInTheDocument();
    expect(marco.getByText(/credential/)).toBeInTheDocument();
  });

  it("Confirm a due tempi con la domanda intera; confermata, la scheda se ne va", async () => {
    const user = userEvent.setup();
    const p = await openReview(user);
    await user.click(card(p, "Marco Bellini").getByRole("button", { name: "Confirm" }));
    expect(
      p.getByText(
        "Did you check with Marco Bellini, in person or on the phone, that this key is theirs (date, device, fingerprint)?",
      ),
    ).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Yes, I checked: confirm" }));
    expect(
      await screen.findByText(/Marco Bellini now reads \d+ credentials?\./),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        p.queryAllByRole("article").some((a) => a.textContent?.includes("Marco Bellini")),
      ).toBe(false),
    );
  });

  it("Reject a due tempi; rifiutata, la scheda se ne va", async () => {
    const user = userEvent.setup();
    const p = await openReview(user);
    await user.click(card(p, "Marco Bellini").getByRole("button", { name: "Reject" }));
    expect(
      p.getByText(
        "Reject Marco Bellini's key? It receives nothing, and Marco Bellini will have to create a new one.",
      ),
    ).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Yes, reject the key" }));
    await waitFor(() =>
      expect(
        p.queryAllByRole("article").some((a) => a.textContent?.includes("Marco Bellini")),
      ).toBe(false),
    );
  });

  it("chi non può passare l'accesso (Sara) non vede la riga", async () => {
    renderRoute("/p/ACQ/credentials", "p-sara");
    await screen.findByRole("button", { name: "Cloudflare" });
    expect(screen.queryByText(/waiting for access/)).toBeNull();
  });

  it("M7: Confirm a cassaforte chiusa: nessuna apertura prima, e resta chiusa", async () => {
    const user = userEvent.setup();
    const p = await openReview(user);
    await act(async () => {
      await vault.lock();
    });
    const unlock = vi.spyOn(vault, "unlock");
    try {
      await user.click(card(p, "Marco Bellini").getByRole("button", { name: "Confirm" }));
      await user.click(p.getByRole("button", { name: "Yes, I checked: confirm" }));
      expect(
        await screen.findByText(/Marco Bellini now reads \d+ credentials?\./),
      ).toBeInTheDocument();
      expect(unlock).not.toHaveBeenCalled();
      expect((await vault.getVaultStatus()).state).toBe("locked");
    } finally {
      unlock.mockRestore();
    }
  });

  // Review M5: zero credenziali passate non è «now reads 0 credentials»; e
  // quelle che questo Mac non riesce ad aprire si dicono.
  it("M5: niente passato e una non apribile: le frasi giuste", async () => {
    const spy = vi.spyOn(vault, "confirm").mockResolvedValue({
      ok: true,
      saved: 0,
      keyChanged: 1,
      notAllowed: 0,
      unopenable: 1,
    });
    try {
      const user = userEvent.setup();
      const p = await openReview(user);
      await user.click(card(p, "Marco Bellini").getByRole("button", { name: "Confirm" }));
      await user.click(p.getByRole("button", { name: "Yes, I checked: confirm" }));
      expect(
        await screen.findByText(
          "Nothing new reached Marco Bellini. 1 credential changed in the meantime: confirm again. 1 credential couldn't be opened on this Mac: it waits for another reader.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/now reads 0/)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
