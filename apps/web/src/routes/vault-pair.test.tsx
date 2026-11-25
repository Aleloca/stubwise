import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { keyFingerprint } from "@stubwise/vault-crypto";
import { softwareDeviceKey } from "@stubwise/vault-crypto/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { VaultPairPage } from "./vault-pair";

/**
 * Lotto 10, la chiave del Mac (design `2026-11-24-cassaforte-desktop-design.md`
 * §7; revisione di sicurezza I2): la pagina del browser che sigilla la
 * propria chiave per il Mac. Prima di sigillare: l'avviso «solo se l'hai
 * avviato tu ora», il login del Mac (creato, ultimo uso), l'impronta INTERA
 * e una conferma ATTIVA (gli ultimi 4 caratteri), non un bottone e basta.
 */

const apiMock = vi.hoisted(() => ({
  lookup: vi.fn(),
  status: vi.fn(),
}));
const sealMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  postVaultDevicePairingLookup: apiMock.lookup,
  getVaultStatus: apiMock.status,
}));
vi.mock("../lib/vault/unlock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/vault/unlock")>()),
  sealForMac: sealMock,
}));

const DEVICE = "dddddddd-0000-4000-8000-000000000001";
let devicePublicKey: string;
let fingerprint: string;
const assign = vi.fn();

function renderPage(state = "pair-state-123") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VaultPairPage state={state} navigate={assign} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  devicePublicKey = (await softwareDeviceKey()).publicKey;
  fingerprint = await keyFingerprint(devicePublicKey);
  apiMock.lookup.mockResolvedValue({
    deviceId: DEVICE,
    deviceName: "MacBook Pro di Laura",
    devicePublicKey,
    expiresAt: "2026-11-25T10:10:00.000Z",
    patCreatedAt: "2026-11-25T09:58:00.000Z",
    patLastUsedAt: "2026-11-25T10:01:00.000Z",
  });
  apiMock.status.mockResolvedValue({ active: true, myKey: { id: "k", status: "confirmed" } });
  sealMock.mockResolvedValue(undefined);
});

describe("vault-pair: associare il Mac", () => {
  it("prima di sigillare: l'avviso, il Mac e il suo login, l'impronta intera", async () => {
    renderPage();
    await screen.findByText("MacBook Pro di Laura");
    expect(
      screen.getByText(/Continue only if you started this from your Mac just now/),
    ).toBeInTheDocument();
    expect(await screen.findByText(fingerprint)).toBeInTheDocument();
    // Il login del Mac: quando è nato e l'ultimo uso (per riconoscere un login non tuo).
    const login = screen.getByText(/Its sign-in was created/);
    expect(login.textContent).toContain(formatDateTime("2026-11-25T09:58:00.000Z"));
    expect(login.textContent).toContain(formatDateTime("2026-11-25T10:01:00.000Z"));
    expect(apiMock.lookup).toHaveBeenCalledWith("pair-state-123");
  });

  it("la conferma è ATTIVA: il bottone si accende solo con gli ultimi 4 caratteri giusti", async () => {
    const user = userEvent.setup();
    renderPage();
    const button = await screen.findByRole("button", { name: "Pair this Mac" });
    expect(button).toBeDisabled();
    const input = screen.getByLabelText(/last 4 characters/i);
    await user.type(input, "0000");
    expect(button).toBeDisabled();
    await user.clear(input);
    await user.type(input, fingerprint.slice(-4).toUpperCase());
    expect(button).toBeEnabled();
  });

  it("sigilla per il Mac dell'associazione e torna all'app col suo state", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText(/last 4 characters/i), fingerprint.slice(-4));
    await user.click(screen.getByRole("button", { name: "Pair this Mac" }));
    await screen.findByText(/This Mac now opens your vault/);
    expect(sealMock).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
      { state: "pair-state-123", deviceId: DEVICE, devicePublicKey },
      expect.any(Function),
    );
    expect(assign).toHaveBeenCalledWith("stubwise://vault?state=pair-state-123");
  });

  it("un'associazione sconosciuta, scaduta o d'altri: lo dice, niente da confermare", async () => {
    apiMock.lookup.mockRejectedValue(new ApiError(404, "x", "pairing_invalid"));
    renderPage();
    await screen.findByText(/This pairing isn't valid any more/);
    expect(screen.queryByRole("button", { name: "Pair this Mac" })).toBeNull();
  });

  it("un errore del sigillo si dice, e non si torna all'app", async () => {
    const user = userEvent.setup();
    sealMock.mockRejectedValue(new ApiError(409, "x", "pairing_invalid"));
    renderPage();
    await user.type(await screen.findByLabelText(/last 4 characters/i), fingerprint.slice(-4));
    await user.click(screen.getByRole("button", { name: "Pair this Mac" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(assign).not.toHaveBeenCalled();
  });

  it("senza uno state valido nell'indirizzo: lo dice, e non chiede niente al server", async () => {
    renderPage("");
    await screen.findByText(/This pairing isn't valid any more/);
    expect(apiMock.lookup).not.toHaveBeenCalled();
  });
});
