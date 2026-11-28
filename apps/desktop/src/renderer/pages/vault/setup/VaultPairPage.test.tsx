import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { renderWithData } from "../../../test/renderWithData";

// L'associazione del Mac nella build web (design §10, I7; M3): il worker
// legge l'associazione e ne tiene l'impronta, la pagina non la mostra; gli
// ultimi 4 scritti, la passkey, e il ritorno all'app con `stubwise://vault`.

const m = vi.hoisted(() => ({ lookupPairing: vi.fn(), sealPairing: vi.fn() }));
vi.mock("@backend/vault-setup", () => ({
  vaultSetupAvailable: true,
  lookupPairing: m.lookupPairing,
  sealPairing: m.sealPairing,
}));

const { VaultPairPage } = await import("./VaultPairPage");

const STATE = "c3RhdGUtZGVsLW1hYw";

beforeEach(() => {
  resetApi();
  setLatency(0);
  m.lookupPairing.mockReset();
  m.sealPairing.mockReset();
  m.lookupPairing.mockResolvedValue({
    ok: true,
    deviceName: "MacBook di Ada",
    patCreatedAt: "2026-11-28T09:58:00.000Z",
    patLastUsedAt: null,
    expiresAt: "2026-11-28T10:10:00.000Z",
  });
});

describe("/vault-pair", () => {
  it("l'avviso, il Mac e il suo login; il bottone solo con 4 caratteri; poi torna all'app", async () => {
    m.sealPairing.mockResolvedValue({ ok: true });
    const navigate = vi.fn();
    renderWithData(<VaultPairPage state={STATE} navigate={navigate} />, { personId: "p-laura" });
    expect(await screen.findByText("MacBook di Ada")).toBeInTheDocument();
    expect(m.lookupPairing).toHaveBeenCalledWith(STATE);
    expect(screen.getByText(/Continue only if you started this from your Mac just now/)).toBeInTheDocument();
    expect(screen.getByText(/hasn't been used yet/)).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Pair this Mac" });
    expect(action).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type the last 4 characters/), { target: { value: "ab12" } });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    await waitFor(() => expect(m.sealPairing).toHaveBeenCalledWith(STATE, "ab12"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`stubwise://vault?state=${STATE}`));
    expect(await screen.findByText(/This Mac now opens your vault/)).toBeInTheDocument();
  });

  it("4 caratteri sbagliati: lo dice, e non torna all'app", async () => {
    m.sealPairing.mockResolvedValue({ ok: false, code: "fingerprint_mismatch" });
    const navigate = vi.fn();
    renderWithData(<VaultPairPage state={STATE} navigate={navigate} />, { personId: "p-laura" });
    fireEvent.change(await screen.findByLabelText(/Type the last 4 characters/), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair this Mac" }));
    expect(await screen.findByText(/don't match the code on your Mac/)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("un'associazione scaduta o d'altri, o uno state non valido: «isn't valid any more»", async () => {
    m.lookupPairing.mockResolvedValue({ ok: false, code: "pairing_invalid" });
    const { unmount } = renderWithData(<VaultPairPage state={STATE} />, { personId: "p-laura" });
    expect(await screen.findByText(/This pairing isn't valid any more/)).toBeInTheDocument();
    unmount();
    renderWithData(<VaultPairPage state="non valido!" />, { personId: "p-laura" });
    expect(await screen.findByText(/This pairing isn't valid any more/)).toBeInTheDocument();
    expect(m.lookupPairing).toHaveBeenCalledTimes(1);
  });
});
