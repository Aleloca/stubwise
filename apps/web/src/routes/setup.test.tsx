import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupPage } from "./setup";

// NOTA: il mock del modulo router qui sotto è un'eccezione storica, da NON
// replicare. Il pattern per i nuovi test è: componenti puri testati da soli
// (login-form.test.tsx) o router vero con memory history (router.test.tsx).
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const postSetupMock = vi.hoisted(() => vi.fn());
const postLoginMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  postSetup: postSetupMock,
  postLogin: postLoginMock,
}));

beforeEach(() => {
  navigateMock.mockReset();
  postSetupMock.mockReset();
  postLoginMock.mockReset();
});

function renderPage(): void {
  const queryClient = new QueryClient();
  const ui: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <SetupPage />
    </QueryClientProvider>
  );
  render(ui);
}

async function fillAndSubmit(email: string, password: string, confirm: string) {
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/^password/i), password);
  await userEvent.type(screen.getByLabelText(/conferma password/i), confirm);
  await userEvent.click(screen.getByRole("button", { name: /crea account/i }));
}

describe("SetupPage", () => {
  it("se le password non coincidono mostra l'errore senza chiamare l'API", async () => {
    renderPage();

    await fillAndSubmit("admin@example.com", "password-1", "password-2");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Le password non coincidono",
    );
    expect(postSetupMock).not.toHaveBeenCalled();
    expect(postLoginMock).not.toHaveBeenCalled();
  });

  it("con dati validi crea l'admin, fa login e naviga su /tickets", async () => {
    const user = { id: "u1", email: "admin@example.com", role: "admin" as const };
    postSetupMock.mockResolvedValue({ user });
    postLoginMock.mockResolvedValue({ user });
    renderPage();

    await fillAndSubmit("admin@example.com", "password-1", "password-1");

    const credentials = { email: "admin@example.com", password: "password-1" };
    expect(postSetupMock).toHaveBeenCalledExactlyOnceWith(credentials);
    // Il setup non apre la sessione lato server: serve un login esplicito.
    expect(postLoginMock).toHaveBeenCalledExactlyOnceWith(credentials);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
  });
});
