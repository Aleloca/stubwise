import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { renderWithData } from "../../../test/renderWithData";

// «Use for the vault» accanto a una passkey (design §10): solo con una chiave
// viva aperta da un'altra passkey; col sigillo, la riga lo dice.

const m = vi.hoisted(() => ({
  status: { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] } as Record<string, unknown>,
  addPasskeyToVault: vi.fn(),
}));
vi.mock("@backend/vault-setup", () => ({
  vaultSetupAvailable: true,
  vaultSetupStatus: async () => m.status,
  addPasskeyToVault: m.addPasskeyToVault,
}));

const { VaultPasskeyAction } = await import("./VaultPasskeyAction");

beforeEach(() => {
  resetApi();
  setLatency(0);
  m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
  m.addPasskeyToVault.mockReset();
});

describe("Use for the vault", () => {
  it("una passkey senza sigillo: il bottone, che la aggiunge", async () => {
    m.addPasskeyToVault.mockResolvedValue({ ok: true });
    renderWithData(<VaultPasskeyAction passkeyId="pk-2" name="YubiKey" />, { personId: "p-laura" });
    fireEvent.click(await screen.findByRole("button", { name: "Use passkey YubiKey for the vault" }));
    await waitFor(() => expect(m.addPasskeyToVault).toHaveBeenCalledWith("pk-2"));
  });

  it("una passkey che apre già: «Opens the vault», nessun bottone", async () => {
    renderWithData(<VaultPasskeyAction passkeyId="pk-1" name="Mac" />, { personId: "p-laura" });
    expect(await screen.findByText("Opens the vault")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("senza chiave, o senza una passkey che la apra: niente", async () => {
    m.status = { ok: true, activated: true, key: "none", sealedPasskeyIds: [] };
    const { container, unmount } = renderWithData(<VaultPasskeyAction passkeyId="pk-2" name="YubiKey" />, { personId: "p-laura" });
    await new Promise((r) => setTimeout(r, 10));
    expect(container).toBeEmptyDOMElement();
    unmount();
    m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: [] };
    const second = renderWithData(<VaultPasskeyAction passkeyId="pk-2" name="YubiKey" />, { personId: "p-laura" });
    await new Promise((r) => setTimeout(r, 10));
    expect(second.container).toBeEmptyDOMElement();
  });

  it("la seconda passkey senza PRF: l'errore lo dice", async () => {
    m.addPasskeyToVault.mockResolvedValue({ ok: false, code: "passkey_unsupported" });
    renderWithData(<VaultPasskeyAction passkeyId="pk-2" name="YubiKey" />, { personId: "p-laura" });
    fireEvent.click(await screen.findByRole("button", { name: "Use passkey YubiKey for the vault" }));
    expect(await screen.findByText(/does not support the PRF extension/)).toBeInTheDocument();
  });
});
