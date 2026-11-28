import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La pagina A SÉ della cassaforte (revisione della fase 2, I-2; design §10):
// l'ingresso (sessione, il login dell'app con `next`), le quattro pagine, e la
// riconferma nella pagina. Il worker e le cerimonie si provano in
// `data/backend/real/vaultBrowser/`; qui `./api` finto.

const m = vi.hoisted(() => ({
  me: { id: "p-roberta", email: "roberta@example.com", fullAdmin: true } as { id: string; email: string; fullAdmin: boolean } | null,
  status: { activated: false, key: "none", sealedPasskeyIds: [] as string[] } as Record<string, unknown>,
  loadMe: vi.fn(),
  vaultStatus: vi.fn(),
  myPasskeys: vi.fn(),
  confirmItsYou: vi.fn(),
  generateKit: vi.fn(),
  forgetKit: vi.fn(async () => undefined),
  activateVault: vi.fn(),
  createVaultKey: vi.fn(),
  addPasskeyToVault: vi.fn(),
  rotateRecoveryKit: vi.fn(),
  openVault: vi.fn(),
  loadRecoveryKit: vi.fn(),
  confirmWithRecoveryKit: vi.fn(),
  forgetRecoveryKit: vi.fn(async () => undefined),
  lookupPairing: vi.fn(),
  sealPairing: vi.fn(),
}));
vi.mock("./api", () => m);

const { VaultPageApp, parseRoute, loginPath } = await import("./App");

const KIT = "ABCDE-FGHIJ-KLMNO-PQRST";
const BEA = {
  userId: "u-bea",
  email: "bea@example.com",
  personKeyId: "k-bea",
  status: "pending",
  createdAt: "2026-11-27T10:00:00.000Z",
  device: "Firefox on Linux",
  fingerprint: "ab12 cd34 ef56 7890",
  credentials: [{ id: "c1", projectId: "p1", service: "AWS", label: null }],
};

let navigate: ReturnType<typeof vi.fn>;

function at(hash: string) {
  window.location.hash = hash;
  return render(<VaultPageApp navigate={navigate} />);
}

beforeEach(() => {
  navigate = vi.fn();
  m.me = { id: "p-roberta", email: "roberta@example.com", fullAdmin: true };
  m.status = { activated: false, key: "none", sealedPasskeyIds: [] };
  for (const fn of Object.values(m)) if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  m.loadMe.mockImplementation(async () => m.me);
  m.vaultStatus.mockImplementation(async () => m.status);
  m.forgetKit.mockResolvedValue(undefined);
  m.forgetRecoveryKit.mockResolvedValue(undefined);
});
afterEach(() => {
  window.location.hash = "";
});

describe("l'ingresso della pagina a sé", () => {
  it("le rotte: quattro pagine, il resto è `setup`", () => {
    expect(parseRoute("#/pair?state=abc").page).toBe("pair");
    expect(parseRoute("#/pair?state=abc").search.get("state")).toBe("abc");
    expect(parseRoute("#/recover").page).toBe("recover");
    expect(parseRoute("#/passkeys").page).toBe("passkeys");
    expect(parseRoute("#/qualcosa").page).toBe("setup");
    expect(parseRoute("").page).toBe("setup");
  });

  it("senza una sessione: il login dell'app con `next` (e lo state del Mac)", async () => {
    m.me = null;
    at("#/pair?state=c3Rh-dGU_");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/#/login?next=vault-pair&state=c3Rh-dGU_"));
    expect(loginPath(parseRoute("#/recover"))).toBe("/app/#/login?next=vault-recover");
  });

  it("i rimandi: all'app (navigazione completa) e fra le pagine; il recupero solo al full admin", async () => {
    m.me = { id: "p-laura", email: "laura@example.com", fullAdmin: false };
    m.status = { activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    at("#/setup");
    expect(await screen.findByText("You have a vault key.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Stubwise" })).toHaveAttribute("href", "/app/#/vault");
    expect(screen.getByRole("link", { name: "Passkeys for the vault" })).toHaveAttribute("href", "#/passkeys");
    expect(screen.queryByRole("link", { name: "Use the recovery kit" })).toBeNull();
  });
});

describe("#/setup", () => {
  it("non attiva, chi non è full admin: lo dice, e nessun bottone", async () => {
    m.me = { id: "p-laura", email: "laura@example.com", fullAdmin: false };
    at("#/setup");
    expect(await screen.findByText(/A full admin activates it here/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate the recovery kit" })).toBeNull();
  });

  it("attivazione: il kit una volta (non tradotto né corretto), la prosecuzione solo dopo «saved», e il testo sparisce", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.activateVault.mockResolvedValue({ ok: true });
    at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    const kit = await screen.findByText(KIT);
    expect(kit).toHaveAttribute("translate", "no");
    expect(kit).toHaveAttribute("data-gramm", "false");
    expect(m.generateKit).toHaveBeenCalledWith("activate");
    const activate = screen.getByRole("button", { name: "Activate the vault" });
    expect(activate).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the kit" }));
    m.status = { activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    fireEvent.click(activate);
    await waitFor(() => expect(screen.queryByText(KIT)).toBeNull());
    expect(await screen.findByText("The vault is active on this instance.")).toBeInTheDocument();
  });

  it("attivazione con una passkey senza PRF: il kit resta e l'errore lo dice", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.activateVault.mockResolvedValue({ ok: false, code: "passkey_unsupported" });
    at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I printed/saved the kit" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate the vault" }));
    expect(await screen.findByText(/does not support the PRF extension/)).toBeInTheDocument();
    expect(screen.getByText(KIT)).toBeInTheDocument();
  });

  it("I-2: la riconferma nella pagina: `reauth_required` apre «Confirm it's you», e confermato l'attivazione riparte", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.activateVault.mockResolvedValueOnce({ ok: false, code: "reauth_required" }).mockResolvedValueOnce({ ok: true });
    m.confirmItsYou.mockResolvedValue({ ok: true });
    at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I printed/saved the kit" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate the vault" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(m.activateVault).toHaveBeenCalledTimes(2));
    expect(m.confirmItsYou).toHaveBeenCalledWith(undefined);
  });

  it("I-2: la riconferma senza passkey chiede il codice, e lo passa al worker", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.activateVault.mockResolvedValueOnce({ ok: false, code: "reauth_required" }).mockResolvedValueOnce({ ok: true });
    m.confirmItsYou.mockResolvedValueOnce({ ok: false, code: "code_required" }).mockResolvedValueOnce({ ok: true });
    at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I printed/saved the kit" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate the vault" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    fireEvent.change(await within(dialog).findByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(m.confirmItsYou).toHaveBeenLastCalledWith("123456"));
    await waitFor(() => expect(m.activateVault).toHaveBeenCalledTimes(2));
  });

  it("lasciando la pagina col kit, il worker lo butta", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    const { unmount } = at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    await screen.findByText(KIT);
    unmount();
    expect(m.forgetKit).toHaveBeenCalled();
  });

  it("attiva, senza chiave: «Create your key»", async () => {
    m.status = { activated: true, key: "none", sealedPasskeyIds: [] };
    m.createVaultKey.mockResolvedValue({ ok: true });
    at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Create your key" }));
    await waitFor(() => expect(m.createVaultKey).toHaveBeenCalledWith({}));
    expect(await screen.findByText(/Your vault key is ready/)).toBeInTheDocument();
  });

  it("una chiave che nessuna passkey apre più: l'avviso e «Recreate», con `recreate`", async () => {
    m.status = { activated: true, key: "confirmed", sealedPasskeyIds: [] };
    m.createVaultKey.mockResolvedValue({ ok: true });
    at("#/setup");
    expect(await screen.findByText(/go back to «pending»/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recreate the vault key" }));
    await waitFor(() => expect(m.createVaultKey).toHaveBeenCalledWith({ recreate: true }));
  });

  it("rotazione con credenziali senza copia: le elenca, e nessun kit", async () => {
    m.status = { activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    m.generateKit.mockResolvedValue({ ok: false, code: "missing", missing: [{ id: "c1", projectId: "p1", service: "AWS", label: "root" }] });
    at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate the recovery kit" }));
    expect(await screen.findByText("AWS · root")).toBeInTheDocument();
    expect(m.generateKit).toHaveBeenCalledWith("rotate");
  });

  it("rotazione a cassaforte chiusa: la apre con la passkey e riprova, il testo sparisce", async () => {
    m.status = { activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.rotateRecoveryKit.mockResolvedValueOnce({ ok: false, code: "vault_locked" }).mockResolvedValueOnce({ ok: true });
    m.openVault.mockResolvedValue({ ok: true });
    at("#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate the recovery kit" }));
    await screen.findByText(KIT);
    fireEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the new kit" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace the recovery kit" }));
    expect(await screen.findByText(/The recovery kit was replaced/)).toBeInTheDocument();
    expect(m.openVault).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(KIT)).toBeNull();
  });
});

describe("#/recover", () => {
  beforeEach(() => {
    m.status = { activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
  });

  it("il testo incollato esce subito dalla pagina; una persona alla volta; «Done» dimentica", async () => {
    m.loadRecoveryKit.mockResolvedValue({ ok: true, items: [BEA] });
    m.confirmWithRecoveryKit.mockResolvedValue({ ok: true, saved: 1, keyChanged: 0, notAllowed: 0, unopenable: 0, items: [] });
    at("#/recover");
    const box = await screen.findByLabelText("Recovery kit");
    expect(box).toHaveAttribute("translate", "no");
    expect(box).toHaveAttribute("data-gramm", "false");
    fireEvent.change(box, { target: { value: KIT } });
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    expect(await screen.findByText("bea@example.com")).toBeInTheDocument();
    expect(m.loadRecoveryKit).toHaveBeenCalledWith(KIT);
    expect(document.body.textContent).not.toContain(KIT);
    fireEvent.click(screen.getByRole("button", { name: "Confirm the access of bea@example.com with the kit" }));
    await waitFor(() => expect(m.confirmWithRecoveryKit).toHaveBeenCalledWith("k-bea", undefined));
    expect(await screen.findByText("No access is waiting for a confirmation.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done: forget the kit" }));
    await waitFor(() => expect(m.forgetRecoveryKit).toHaveBeenCalled());
  });

  it("un testo che non è un kit: lo dice, e la textarea è già vuota", async () => {
    m.loadRecoveryKit.mockResolvedValue({ ok: false, code: "invalid_kit" });
    at("#/recover");
    fireEvent.change(await screen.findByLabelText("Recovery kit"), { target: { value: "boh" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use the kit" })));
    expect(await screen.findByText(/This is not a valid recovery kit/)).toBeInTheDocument();
    expect(screen.getByLabelText("Recovery kit")).toHaveValue("");
  });

  it("I-1: senza passkey la conferma chiede il codice, per QUELLA conferma", async () => {
    m.loadRecoveryKit.mockResolvedValue({ ok: true, items: [BEA] });
    m.confirmWithRecoveryKit
      .mockResolvedValueOnce({ ok: false, code: "code_required" })
      .mockResolvedValueOnce({ ok: true, saved: 1, keyChanged: 0, notAllowed: 0, unopenable: 0, items: [] });
    at("#/recover");
    fireEvent.change(await screen.findByLabelText("Recovery kit"), { target: { value: KIT } });
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    const confirm = await screen.findByRole("button", { name: "Confirm the access of bea@example.com with the kit" });
    fireEvent.click(confirm);
    fireEvent.change(await screen.findByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(m.confirmWithRecoveryKit).toHaveBeenLastCalledWith("k-bea", "123456"));
  });

  it("I-1: il kit scaduto o buttato dal worker: la pagina lo dice e torna a chiederlo", async () => {
    m.loadRecoveryKit.mockResolvedValue({ ok: true, items: [BEA] });
    m.confirmWithRecoveryKit.mockResolvedValue({ ok: false, code: "no_kit" });
    at("#/recover");
    fireEvent.change(await screen.findByLabelText("Recovery kit"), { target: { value: KIT } });
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm the access of bea@example.com with the kit" }));
    expect(await screen.findByText(/The kit was forgotten/)).toBeInTheDocument();
    expect(screen.getByLabelText("Recovery kit")).toBeInTheDocument();
  });

  it("chi non è full admin: niente modulo", async () => {
    m.me = { id: "p-laura", email: "laura@example.com", fullAdmin: false };
    at("#/recover");
    expect(await screen.findByText("Only a full admin can do this.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Recovery kit")).toBeNull();
  });
});

describe("#/pair", () => {
  const STATE = "c3RhdGUtZGVsLW1hYw";
  beforeEach(() => {
    m.lookupPairing.mockResolvedValue({
      ok: true,
      deviceName: "MacBook di Ada",
      patCreatedAt: "2026-11-28T09:58:00.000Z",
      patLastUsedAt: null,
      expiresAt: "2026-11-28T10:10:00.000Z",
    });
  });

  it("l'avviso, il Mac; il bottone solo con 4 caratteri; poi torna all'app con `stubwise://vault`", async () => {
    m.sealPairing.mockResolvedValue({ ok: true });
    at(`#/pair?state=${STATE}`);
    expect(await screen.findByText("MacBook di Ada")).toBeInTheDocument();
    expect(screen.getByText(/Continue only if you started this from your Mac just now/)).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Pair this Mac" });
    expect(action).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type the last 4 characters/), { target: { value: "ab12" } });
    fireEvent.click(action);
    await waitFor(() => expect(m.sealPairing).toHaveBeenCalledWith(STATE, "ab12"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`stubwise://vault?state=${STATE}`));
  });

  it("uno state non valido o un'associazione scaduta: «isn't valid any more»", async () => {
    const { unmount } = at("#/pair?state=non%20valido!");
    expect(await screen.findByText(/This pairing isn't valid any more/)).toBeInTheDocument();
    expect(m.lookupPairing).not.toHaveBeenCalled();
    unmount();
    m.lookupPairing.mockResolvedValue({ ok: false, code: "pairing_invalid" });
    at(`#/pair?state=${STATE}`);
    expect(await screen.findByText(/This pairing isn't valid any more/)).toBeInTheDocument();
  });
});

describe("#/passkeys", () => {
  it("le passkey: quale apre, e «Use for the vault» per le altre (due tocchi)", async () => {
    m.status = { activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    m.myPasskeys.mockResolvedValue([
      { id: "pk-1", name: "Mac" },
      { id: "pk-2", name: "YubiKey" },
    ]);
    m.addPasskeyToVault.mockResolvedValue({ ok: true });
    at("#/passkeys");
    expect(await screen.findByText("Opens the vault")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use passkey YubiKey for the vault" }));
    await waitFor(() => expect(m.addPasskeyToVault).toHaveBeenCalledWith("pk-2"));
    expect(await screen.findByText("YubiKey now opens the vault too.")).toBeInTheDocument();
  });

  it("senza una chiave: lo dice, e nessun bottone", async () => {
    m.status = { activated: true, key: "none", sealedPasskeyIds: [] };
    m.myPasskeys.mockResolvedValue([{ id: "pk-2", name: "YubiKey" }]);
    at("#/passkeys");
    expect(await screen.findByText(/create it first/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /for the vault/ })).toBeNull();
  });
});

