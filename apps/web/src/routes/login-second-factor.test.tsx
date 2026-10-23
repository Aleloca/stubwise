import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { LoginSecondFactorPage } from "./login-second-factor";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const api = vi.hoisted(() => ({
  getSecondFactorStatus: vi.fn(),
  postSecondFactorVerify: vi.fn(),
  postSecondFactorPasskeyOptions: vi.fn(),
  postSecondFactorPasskeyVerify: vi.fn(),
  postSecondFactorEnroll: vi.fn(),
  postSecondFactorEnrollConfirm: vi.fn(),
}));
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  ...api,
}));

const startAuthenticationMock = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: startAuthenticationMock,
}));

const user = { id: "u1", email: "ada@example.com", role: "admin" as const };

beforeEach(() => {
  navigateMock.mockReset();
  startAuthenticationMock.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
});

function renderPage(ui: ReactElement = <LoginSecondFactorPage />) {
  const queryClient = new QueryClient();
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return queryClient;
}

function statusFor(overrides: Record<string, unknown> = {}) {
  return {
    stage: "second_factor",
    passkeys: false,
    backupCodesRemaining: 10,
    lockedUntil: null,
    ...overrides,
  };
}

async function typeCodeAndSubmit(code: string) {
  await userEvent.type(await screen.findByLabelText(/authenticator code/i), code);
  await userEvent.click(screen.getByRole("button", { name: /verify/i }));
}

describe("LoginSecondFactorPage — stadio second_factor", () => {
  it("un codice giusto completa il login e porta su /tickets", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor());
    // Fixture SENZA `backupCodesRemaining`, apposta (CLAUDE.md, «NON protegge
    // il web»): il web non parsa, e un campo assente non deve né far
    // esplodere la pagina né accendere un falso avviso «codici finiti».
    api.postSecondFactorVerify.mockResolvedValue({ user });
    renderPage();

    await typeCodeAndSubmit("123456");

    expect(api.postSecondFactorVerify).toHaveBeenCalledExactlyOnceWith("123456");
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
    expect(screen.queryByText(/backup codes left/i)).not.toBeInTheDocument();
  });

  it("legge lo stato una volta sola", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor());
    renderPage();
    await screen.findByLabelText(/authenticator code/i);
    expect(api.getSecondFactorStatus).toHaveBeenCalledTimes(1);
  });

  it("un codice sbagliato mostra l'errore e non naviga", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor());
    api.postSecondFactorVerify.mockRejectedValue(
      new ApiError(401, "Invalid second factor code", "invalid_second_factor"),
    );
    renderPage();

    await typeCodeAndSubmit("000000");

    expect(await screen.findByRole("alert")).toHaveTextContent(/code is not valid/i);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("il blocco (423) dice fino a che ora", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor());
    const lockedUntil = new Date(2026, 9, 23, 14, 37).toISOString();
    api.postSecondFactorVerify.mockRejectedValue(
      new ApiError(423, "locked", "second_factor_locked", {
        details: { code: "second_factor_locked", lockedUntil },
      }),
    );
    renderPage();

    await typeCodeAndSubmit("000000");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/locked/i);
    expect(alert).toHaveTextContent("14:37");
  });

  it("un blocco già in corso si vede all'apertura", async () => {
    const lockedUntil = new Date(Date.now() + 10 * 60_000);
    api.getSecondFactorStatus.mockResolvedValue(
      statusFor({ lockedUntil: lockedUntil.toISOString() }),
    );
    renderPage();

    const hh = String(lockedUntil.getHours()).padStart(2, "0");
    const mm = String(lockedUntil.getMinutes()).padStart(2, "0");
    expect(await screen.findByRole("alert")).toHaveTextContent(`${hh}:${mm}`);
  });

  it("429 second_factor_busy invita a riprovare", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor());
    api.postSecondFactorVerify.mockRejectedValue(new ApiError(429, "busy", "second_factor_busy"));
    renderPage();

    await typeCodeAndSubmit("123456");

    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
  });

  it("«Use a backup code» cambia il campo e manda il codice di riserva", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor());
    api.postSecondFactorVerify.mockResolvedValue({ user, backupCodesRemaining: 9 });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /use a backup code/i }));
    await userEvent.type(screen.getByLabelText(/backup code/i), "abcde-fghij");
    await userEvent.click(screen.getByRole("button", { name: /verify/i }));

    expect(api.postSecondFactorVerify).toHaveBeenCalledExactlyOnceWith("abcde-fghij");
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
  });

  it("con pochi codici di riserva rimasti avvisa, con il link a Sicurezza, prima di entrare", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor());
    api.postSecondFactorVerify.mockResolvedValue({ user, backupCodesRemaining: 2 });
    renderPage();

    await typeCodeAndSubmit("123456");

    expect(await screen.findByText(/2 backup codes left/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute(
      "href",
      "/settings/security",
    );
    expect(navigateMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
  });

  it("senza passkey non offre la passkey", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor({ passkeys: false }));
    renderPage();
    await screen.findByLabelText(/authenticator code/i);
    expect(screen.queryByRole("button", { name: /passkey/i })).not.toBeInTheDocument();
  });

  it("con una passkey: opzioni → browser → verifica → /tickets", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor({ passkeys: true }));
    const options = { challenge: "c", allowCredentials: [{ id: "k", type: "public-key" }] };
    const assertion = { id: "k", rawId: "k", type: "public-key", response: {} };
    api.postSecondFactorPasskeyOptions.mockResolvedValue(options);
    startAuthenticationMock.mockResolvedValue(assertion);
    api.postSecondFactorPasskeyVerify.mockResolvedValue({ user, backupCodesRemaining: 10 });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /use a passkey/i }));

    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: options });
    expect(api.postSecondFactorPasskeyVerify).toHaveBeenCalledWith(assertion);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
  });

  it("una passkey annullata nel browser lo dice e non chiama la verifica", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor({ passkeys: true }));
    api.postSecondFactorPasskeyOptions.mockResolvedValue({ challenge: "c" });
    startAuthenticationMock.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /use a passkey/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/passkey/i);
    expect(api.postSecondFactorPasskeyVerify).not.toHaveBeenCalled();
  });

  it("senza sessione parziale (401) torna al login", async () => {
    api.getSecondFactorStatus.mockRejectedValue(
      new ApiError(401, "Authentication required", "unauthorized"),
    );
    renderPage();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/login" }));
  });

  it("con la sessione già completa (409 second_factor_done) entra", async () => {
    api.getSecondFactorStatus.mockRejectedValue(new ApiError(409, "done", "second_factor_done"));
    renderPage();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
  });
});

describe("LoginSecondFactorPage — stadio enrollment", () => {
  it("QR + segreto, conferma, poi i codici: «Continue» solo dopo la spunta", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor({ stage: "enrollment" }));
    api.postSecondFactorEnroll.mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUrl: "otpauth://totp/Stubwise:ada%40example.com?secret=JBSWY3DPEHPK3PXP",
    });
    api.postSecondFactorEnrollConfirm.mockResolvedValue({
      user,
      backupCodes: ["aaaaa-bbbbb", "ccccc-ddddd"],
    });
    renderPage();

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /qr/i })).toBeInTheDocument();
    expect(api.postSecondFactorEnroll).toHaveBeenCalledTimes(1);

    await userEvent.type(screen.getByLabelText(/authenticator code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(api.postSecondFactorEnrollConfirm).toHaveBeenCalledExactlyOnceWith("123456");

    expect(await screen.findByText("aaaaa-bbbbb")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: /continue/i });
    expect(next).toBeDisabled();
    expect(navigateMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText(/i saved the codes/i));
    expect(next).toBeEnabled();
    await userEvent.click(next);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
  });

  it("un primo codice sbagliato resta sulla configurazione con l'errore", async () => {
    api.getSecondFactorStatus.mockResolvedValue(statusFor({ stage: "enrollment" }));
    api.postSecondFactorEnroll.mockResolvedValue({ secret: "S", otpauthUrl: "otpauth://totp/x" });
    api.postSecondFactorEnrollConfirm.mockRejectedValue(
      new ApiError(401, "Invalid", "invalid_second_factor"),
    );
    renderPage();

    await userEvent.type(await screen.findByLabelText(/authenticator code/i), "000000");
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/code is not valid/i);
    expect(screen.queryByRole("button", { name: /continue/i })).not.toBeInTheDocument();
  });
});
