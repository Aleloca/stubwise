import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { renderWithData } from "../../../test/renderWithData";

// «Use for the vault» accanto a una passkey (design §10, I-2): un link alla
// pagina a sé della cassaforte; col sigillo, la riga lo dice.

const m = vi.hoisted(() => ({
  status: { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] } as Record<string, unknown>,
}));
vi.mock("@backend/vault-setup", () => ({ vaultSetupAvailable: true, vaultSetupStatus: async () => m.status }));

const { VaultPasskeyAction } = await import("./VaultPasskeyAction");

beforeEach(() => {
  resetApi();
  setLatency(0);
  m.status = { ok: true, activated: true, key: "confirmed", sealedPasskeyIds: ["pk-1"] };
});

describe("Use for the vault", () => {
  it("una passkey senza sigillo: un link (navigazione completa) alla pagina a sé, `#/passkeys`", async () => {
    renderWithData(<VaultPasskeyAction passkeyId="pk-2" name="YubiKey" />, { personId: "p-laura" });
    const link = await screen.findByRole("link", { name: "Use passkey YubiKey for the vault" });
    expect(link).toHaveAttribute("href", "/vault/#/passkeys");
  });

  it("una passkey che apre già: «Opens the vault», nessun link", async () => {
    renderWithData(<VaultPasskeyAction passkeyId="pk-1" name="Mac" />, { personId: "p-laura" });
    expect(await screen.findByText("Opens the vault")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
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
});
