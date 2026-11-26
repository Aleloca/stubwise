import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency, vault } from "../../data/api";
import { VAULT_IDS } from "../../data/seed/vault";
import { setSessionPersonId } from "../../data/session";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { queryKeys } from "../../data/queries";
import { lastQueryClient, renderRoute } from "../../test/renderRoute";

// La sezione Credentials (lotto 10, shape `vault.md` §3): la barra della
// cassaforte, le righe con Show/Hide/Copy, la voce della colonna. La
// password non è MAI nel DOM finché non la si mostra; «Copy» non la mette
// nel DOM nemmeno per un momento.

const PASSWORDS = /Kx4!pa|Gq7#v2|mg-Tr9|sk-Wd2|Fg5&k1/;
let clip = "";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  clip = "";
  setVaultClipboard({ write: (t) => void (clip = t), read: () => clip });
});
afterEach(() => act(() => setLanguage("en")));

const row = (id: string) => document.querySelector<HTMLElement>(`[data-credential="${id}"]`)!;
const bar = () => document.querySelector<HTMLElement>("[data-vault-bar]")!;

async function openSection(person: string, code = "ACQ") {
  const router = renderRoute(`/p/${code}/credentials`, person);
  await screen.findByRole("heading", { level: 1, name: "Credentials" });
  await waitFor(() => expect(row(VAULT_IDS.ARUBA) ?? row(VAULT_IDS.CLOUDFLARE)).toBeTruthy());
  return router;
}

describe("Credentials — l'elenco e la barra", () => {
  it("Laura: chiusa col Touch ID; le righe dicono chi legge, chi aspetta, chi gestisce; nessuna password", async () => {
    await openSection("p-laura");
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("locked"));
    expect(within(bar()).getByText("Locked.")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Open with Touch ID" })).toBeInTheDocument();
    expect(within(row(VAULT_IDS.MAILGUN)).getByText("You don't read this one")).toBeInTheDocument();
    expect(within(row(VAULT_IDS.STRIPE)).getByText("Waiting for confirmation")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(PASSWORDS);
  });

  it("VA-Q2: Show a cassaforte chiusa apre col Touch ID e mostra; resta finché Hide (VA-Q3); Lock la nasconde", async () => {
    const user = userEvent.setup();
    await openSection("p-laura");
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("locked"));
    await user.click(
      within(row(VAULT_IDS.ARUBA)).getByRole("button", {
        name: "Show the password of Aruba hosting",
      }),
    );
    await waitFor(() => expect(row(VAULT_IDS.ARUBA).textContent).toContain("Kx4!pa-77Wq"));
    expect(bar().dataset.vaultBar).toBe("open");
    await user.click(
      within(row(VAULT_IDS.CLOUDFLARE)).getByRole("button", {
        name: "Show the password of Cloudflare",
      }),
    );
    await waitFor(() => expect(row(VAULT_IDS.CLOUDFLARE).textContent).toContain("Gq7#v2-LmpZ"));
    // Hide nasconde solo quella riga.
    await user.click(
      within(row(VAULT_IDS.ARUBA)).getByRole("button", {
        name: "Hide the password of Aruba hosting",
      }),
    );
    expect(row(VAULT_IDS.ARUBA).textContent).not.toContain("Kx4!pa");
    expect(row(VAULT_IDS.CLOUDFLARE).textContent).toContain("Gq7#v2");
    // Lock: ogni password torna pallini.
    await user.click(within(bar()).getByRole("button", { name: "Lock" }));
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("locked"));
    expect(document.body.textContent).not.toMatch(PASSWORDS);
  });

  it("Copy: gli appunti dal livello dati, la password mai nel DOM; il toast lo dice", async () => {
    const user = userEvent.setup();
    await openSection("p-laura");
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("locked"));
    await user.click(
      within(row(VAULT_IDS.CLOUDFLARE)).getByRole("button", {
        name: "Copy the password of Cloudflare",
      }),
    );
    await screen.findByText("Copied. The clipboard is cleared in 30 seconds.");
    expect(clip).toBe("Gq7#v2-LmpZ");
    expect(document.body.textContent).not.toMatch(PASSWORDS);
  });

  it("D-1a: un Mac senza Touch ID si apre nel browser; Show e Copy restano spenti", async () => {
    await vault.setVaultSimulation({ touchId: "unavailable" });
    await openSection("p-laura");
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("locked"));
    expect(within(bar()).getByText(/This Mac has no Touch ID/)).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Open in the browser" })).toBeInTheDocument();
    expect(
      within(row(VAULT_IDS.ARUBA)).getByRole("button", {
        name: "Show the password of Aruba hosting",
      }),
    ).toBeDisabled();
  });

  it("Marco (chiave in attesa): la barra dice di aspettare, con l'impronta della sua chiave", async () => {
    await openSection("p-marco");
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("key_pending"));
    expect(bar().textContent).toContain("7d20 e5a9 c31f 6b84");
  });
});

describe("Credentials — la voce della colonna", () => {
  it("Laura la vede, col punto «ti aspetta»: Marco aspetta che lei lo confermi", async () => {
    await openSection("p-laura");
    const link = await screen.findByRole("link", { name: /^Credentials/ });
    await waitFor(() => expect(link.querySelector("[data-waiting-dot]")).not.toBeNull());
  });

  it("Marta (Contributor in ACQ, nessuna credenziale, non può crearne): la voce non c'è", async () => {
    renderRoute("/p/ACQ/overview", "p-marta");
    await screen.findByRole("link", { name: /^Tasks/ });
    // La lettura della voce è arrivata: c'è la colonna completa, senza Credentials.
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: /^Settings/ }).length).toBeGreaterThan(0),
    );
    // La lettura della voce risponde (`show: false`) prima di guardare la colonna.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: /^Credentials/ })).toBeNull();
  });

  // Review M2: i testi della shape.
  it("M2: il sottotitolo della shape, e Show/Copy a chiusa col title «Open the vault first»", async () => {
    await openSection("p-laura");
    expect(
      screen.getByText(
        "Passwords for the project's services. Only the people who read one see it.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("locked"));
    const aruba = within(row(VAULT_IDS.ARUBA));
    expect(
      aruba.getByRole("button", { name: "Show the password of Aruba hosting" }),
    ).toHaveAttribute("title", "Open the vault first");
    expect(
      aruba.getByRole("button", { name: "Copy the password of Aruba hosting" }),
    ).toHaveAttribute("title", "Open the vault first");
  });

  it("M2: non attiva, «Activate it in the browser.» solo per l'admin", async () => {
    const inactive = (person: string) =>
      act(() =>
        lastQueryClient().setQueryData(queryKeys.vaultStatus(person), {
          state: "inactive",
          touchId: true,
          macFingerprint: null,
          ownFingerprint: null,
          pairing: null,
        }),
      );
    await openSection("p-laura");
    inactive("p-laura");
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("inactive"));
    expect(within(bar()).queryByText("Activate it in the browser.")).toBeNull();
  });

  it("M2: non attiva, l'admin legge «Activate it in the browser.»", async () => {
    await openSection("p-roberta");
    act(() =>
      lastQueryClient().setQueryData(queryKeys.vaultStatus("p-roberta"), {
        state: "inactive",
        touchId: true,
        macFingerprint: null,
        ownFingerprint: null,
        pairing: null,
      }),
    );
    await waitFor(() => expect(bar().dataset.vaultBar).toBe("inactive"));
    expect(within(bar()).getByText("Activate it in the browser.")).toBeInTheDocument();
  });

  // Review M10: nella build web (l'app servita su /app, senza il ponte del
  // desktop) cifrare non si può: niente «New credential», e la barra dice
  // come si apre la cassaforte dal browser.
  describe("M10: la build web", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_STUBWISE_BUILD", "app");
      // Nella build «app» chi guarda è la persona della sessione del livello dati.
      setSessionPersonId("p-laura");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("niente «New credential» nella sezione", async () => {
      await openSection("p-laura");
      expect(screen.queryByRole("button", { name: "New credential" })).toBeNull();
    });

    it("con il ponte del desktop «New credential» c'è", async () => {
      vi.stubGlobal("stubwise", { vault: { create: vi.fn() } });
      await openSection("p-laura");
      expect(screen.getByRole("button", { name: "New credential" })).toBeInTheDocument();
    });

    it("la barra «unsupported» con la frase del browser", async () => {
      await openSection("p-laura");
      act(() =>
        lastQueryClient().setQueryData(queryKeys.vaultStatus("p-laura"), {
          state: "unsupported",
          touchId: false,
          macFingerprint: null,
          ownFingerprint: null,
          pairing: null,
        }),
      );
      await waitFor(() => expect(bar().dataset.vaultBar).toBe("unsupported"));
      expect(
        within(bar()).getByText(
          "In the browser, the vault opens on Stubwise's web pages, with your passkey.",
        ),
      ).toBeInTheDocument();
      expect(
        within(bar()).getByRole("button", { name: "Open the vault page" }),
      ).toBeInTheDocument();
    });
  });
});
