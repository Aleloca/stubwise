import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { LoginPage } from "./login";

beforeEach(() => {
  navigateMock.mockReset();
  postLoginMock.mockReset();
});

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const postLoginMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  postLogin: postLoginMock,
}));

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient();
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return queryClient;
}

async function fillAndSubmit(email: string, password: string) {
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/password/i), password);
  await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginPage", () => {
  it("con credenziali valide chiama postLogin e naviga su /tickets", async () => {
    const user = { id: "u1", email: "ada@example.com", role: "admin" as const };
    postLoginMock.mockResolvedValue({ user });
    renderWithClient(<LoginPage />);

    await fillAndSubmit("ada@example.com", "hunter22");

    expect(postLoginMock).toHaveBeenCalledExactlyOnceWith({
      email: "ada@example.com",
      password: "hunter22",
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/tickets" }));
  });

  it("su 401 mostra l'errore e non naviga", async () => {
    postLoginMock.mockRejectedValue(new ApiError(401, "Credenziali non valide"));
    renderWithClient(<LoginPage />);

    await fillAndSubmit("ada@example.com", "sbagliata");

    expect(await screen.findByRole("alert")).toHaveTextContent("Credenziali non valide");
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
