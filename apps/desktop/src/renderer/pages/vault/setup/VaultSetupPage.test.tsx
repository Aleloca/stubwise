import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { renderWithData } from "../../../test/renderWithData";

// La pagina minima della fase 2 (design §10): l'ordine dei passi e ciò che
// la pagina tiene (il testo del kit solo nel suo stato). Il worker e le
// cerimonie si provano in `vaultBrowser/`; qui `@backend/vault-setup` finto.

const m = vi.hoisted(() => ({
  status: { ok: true, activated: false, key: "none", sealedPasskeyIds: [] as string[] } as Record<string, unknown>,
  generateKit: vi.fn(),
  forgetKit: vi.fn(async () => undefined),
  activateVault: vi.fn(),
  createVaultKey: vi.fn(),
  rotateRecoveryKit: vi.fn(),
  loadRecoveryKit: vi.fn(),
  confirmWithRecoveryKit: vi.fn(),
  forgetRecoveryKit: vi.fn(async () => undefined),
}));

vi.mock("@backend/vault-setup", () => ({
  vaultSetupAvailable: true,
  vaultSetupStatus: async () => m.status,
  generateKit: m.generateKit,
  forgetKit: m.forgetKit,
  activateVault: m.activateVault,
  createVaultKey: m.createVaultKey,
  addPasskeyToVault: vi.fn(),
  rotateRecoveryKit: m.rotateRecoveryKit,
  loadRecoveryKit: m.loadRecoveryKit,
  confirmWithRecoveryKit: m.confirmWithRecoveryKit,
  forgetRecoveryKit: m.forgetRecoveryKit,
  lookupPairing: vi.fn(),
  sealPairing: vi.fn(),
}));

const { VaultSetupPage } = await import("./VaultSetupPage");

const KIT = "ABCDE-FGHIJ-KLMNO-PQRST";

beforeEach(() => {
  resetApi();
  setLatency(0);
  m.status = { ok: true, activated: false, key: "none", sealedPasskeyIds: [] };
  for (const fn of [m.generateKit, m.activateVault, m.createVaultKey, m.rotateRecoveryKit, m.loadRecoveryKit, m.confirmWithRecoveryKit]) fn.mockReset();
  m.forgetKit.mockClear();
  m.forgetRecoveryKit.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("la pagina della cassaforte (fase 2)", () => {
  it("non attiva, chi non è full admin: lo dice, e nessun bottone", async () => {
    renderWithData(<VaultSetupPage />, { personId: "p-laura" });
    expect(await screen.findByText(/A full admin activates it here/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate the recovery kit" })).toBeNull();
  });

  it("attivazione: il kit una volta, la prosecuzione solo dopo «saved», e il testo sparisce", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.activateVault.mockResolvedValue({ ok: true });
    renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    expect(await screen.findByText(KIT)).toBeInTheDocument();
    expect(m.generateKit).toHaveBeenCalledWith("activate");
    const activate = screen.getByRole("button", { name: "Activate the vault" });
    expect(activate).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the kit" }));
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    fireEvent.click(activate);
    await waitFor(() => expect(m.activateVault).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(KIT)).toBeNull());
    expect(await screen.findByText("The vault is active on this instance.")).toBeInTheDocument();
  });

  it("attivazione con una passkey senza PRF: il kit resta (non è partito niente) e l'errore lo dice", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.activateVault.mockResolvedValue({ ok: false, code: "passkey_unsupported" });
    renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I printed/saved the kit" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate the vault" }));
    expect(await screen.findByText(/does not support the PRF extension/)).toBeInTheDocument();
    expect(screen.getByText(KIT)).toBeInTheDocument();
  });

  it("lasciando la pagina col kit, il worker lo butta", async () => {
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    const { unmount } = renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    await screen.findByText(KIT);
    unmount();
    expect(m.forgetKit).toHaveBeenCalled();
  });

  it("attiva, senza chiave: «Create your key»", async () => {
    m.status = { ok: true, activated: true, key: "none", sealedPasskeyIds: [] };
    m.createVaultKey.mockResolvedValue({ ok: true });
    renderWithData(<VaultSetupPage />, { personId: "p-laura" });
    fireEvent.click(await screen.findByRole("button", { name: "Create your key" }));
    await waitFor(() => expect(m.createVaultKey).toHaveBeenCalledWith({}));
    expect(await screen.findByText(/Your vault key is ready/)).toBeInTheDocument();
  });

  it("una chiave che nessuna passkey apre più: l'avviso e «Recreate», con `recreate`", async () => {
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: [] };
    m.createVaultKey.mockResolvedValue({ ok: true });
    renderWithData(<VaultSetupPage />, { personId: "p-laura" });
    expect(await screen.findByText(/go back to «pending»/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recreate the vault key" }));
    await waitFor(() => expect(m.createVaultKey).toHaveBeenCalledWith({ recreate: true }));
  });

  it("rotazione con credenziali senza copia: le elenca, e nessun kit", async () => {
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    m.generateKit.mockResolvedValue({ ok: false, code: "missing", missing: [{ id: "c1", projectId: "p1", service: "AWS", label: "root" }] });
    renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate the recovery kit" }));
    expect(await screen.findByText("AWS · root")).toBeInTheDocument();
    expect(m.generateKit).toHaveBeenCalledWith("rotate");
    expect(screen.queryByText(KIT)).toBeNull();
  });

  it("rotazione: il kit nuovo, e «Replace» lo sostituisce; il testo sparisce", async () => {
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    m.generateKit.mockResolvedValue({ ok: true, kitText: KIT });
    m.rotateRecoveryKit.mockResolvedValue({ ok: true });
    renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate the recovery kit" }));
    await screen.findByText(KIT);
    fireEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the new kit" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace the recovery kit" }));
    expect(await screen.findByText(/The recovery kit was replaced/)).toBeInTheDocument();
    expect(screen.queryByText(KIT)).toBeNull();
  });

  it("recupero: il testo incollato esce subito dalla pagina; conferma una persona alla volta; «Done» dimentica", async () => {
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    const bea = {
      userId: "u-bea",
      email: "bea@example.com",
      personKeyId: "k-bea",
      status: "pending",
      createdAt: "2026-11-27T10:00:00.000Z",
      device: "Firefox on Linux",
      fingerprint: "ab12 cd34 ef56 7890",
      credentials: [{ id: "c1", projectId: "p1", service: "AWS", label: null }],
    };
    m.loadRecoveryKit.mockResolvedValue({ ok: true, items: [bea] });
    m.confirmWithRecoveryKit.mockResolvedValue({ ok: true, saved: 1, keyChanged: 0, notAllowed: 0, unopenable: 0, items: [] });
    renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Use the recovery kit" }));
    const box = screen.getByLabelText("Recovery kit");
    fireEvent.change(box, { target: { value: KIT } });
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    expect(await screen.findByText("bea@example.com")).toBeInTheDocument();
    expect(m.loadRecoveryKit).toHaveBeenCalledWith(KIT);
    expect(document.body.textContent).not.toContain(KIT);
    expect(screen.getByText("ab12 cd34 ef56 7890")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm the access of bea@example.com with the kit" }));
    await waitFor(() => expect(m.confirmWithRecoveryKit).toHaveBeenCalledWith("k-bea", undefined));
    expect(await screen.findByText("No access is waiting for a confirmation.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done: forget the kit" }));
    await waitFor(() => expect(m.forgetRecoveryKit).toHaveBeenCalled());
  });

  it("I-1: recupero senza passkey: la conferma chiede il codice, per QUELLA conferma", async () => {
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    const bea = {
      userId: "u-bea",
      email: "bea@example.com",
      personKeyId: "k-bea",
      status: "pending",
      createdAt: "2026-11-27T10:00:00.000Z",
      device: null,
      fingerprint: "ab12 cd34 ef56 7890",
      credentials: [],
    };
    m.loadRecoveryKit.mockResolvedValue({ ok: true, items: [bea] });
    m.confirmWithRecoveryKit
      .mockResolvedValueOnce({ ok: false, code: "code_required" })
      .mockResolvedValueOnce({ ok: true, saved: 0, keyChanged: 0, notAllowed: 0, unopenable: 0, items: [] });
    renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Use the recovery kit" }));
    fireEvent.change(screen.getByLabelText("Recovery kit"), { target: { value: KIT } });
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    const confirm = await screen.findByRole("button", { name: "Confirm the access of bea@example.com with the kit" });
    fireEvent.click(confirm);
    const code = await screen.findByLabelText("Code from your authenticator app");
    expect(confirm).toBeDisabled();
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(m.confirmWithRecoveryKit).toHaveBeenLastCalledWith("k-bea", "123456"));
    expect(await screen.findByText("No access is waiting for a confirmation.")).toBeInTheDocument();
  });

  it("recupero con un testo che non è un kit: lo dice", async () => {
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    m.loadRecoveryKit.mockResolvedValue({ ok: false, code: "invalid_kit" });
    renderWithData(<VaultSetupPage />, { personId: "p-roberta" });
    fireEvent.click(await screen.findByRole("button", { name: "Use the recovery kit" }));
    fireEvent.change(screen.getByLabelText("Recovery kit"), { target: { value: "boh" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use the kit" })));
    expect(await screen.findByText(/This is not a valid recovery kit/)).toBeInTheDocument();
    // Il testo è andato al worker: anche a errore non resta nella pagina.
    expect(screen.getByLabelText("Recovery kit")).toHaveValue("");
  });

  it("chi non è full admin non vede né la rotazione né il recupero", async () => {
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
    renderWithData(<VaultSetupPage />, { personId: "p-laura" });
    expect(await screen.findByText("You have a vault key.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate the recovery kit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use the recovery kit" })).toBeNull();
  });
});
