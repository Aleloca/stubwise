import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { LoginForm } from "./login-form";

describe("LoginForm", () => {
  it("rende i campi email e password e il bottone di submit", () => {
    render(<LoginForm onSubmit={vi.fn()} />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("al submit chiama onSubmit con i valori inseriti", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<LoginForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      email: "ada@example.com",
      password: "hunter22",
    });
  });

  it("su 401 mostra «Credenziali non valide»", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(401, "Credenziali non valide"));
    render(<LoginForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "sbagliata");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Credenziali non valide");
  });

  it("disabilita il bottone mentre il submit è in corso", async () => {
    let resolveSubmit!: () => void;
    const onSubmit = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => (resolveSubmit = resolve)),
    );
    render(<LoginForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    resolveSubmit();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled(),
    );
  });

  it("un nuovo submit dopo un errore pulisce il messaggio precedente", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(401, "Credenziali non valide"))
      .mockResolvedValueOnce(undefined);
    render(<LoginForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "sbagliata");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
