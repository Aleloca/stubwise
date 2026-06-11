import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectForm } from "./project-form";

/**
 * Form progetto puro: `onSubmit` iniettato, si verificano i payload prodotti.
 * Punto delicato: le credenziali sono write-only — in modifica i campi non
 * devono MAI essere prefillati e lasciarli vuoti deve omettere `credentials`.
 */

const initial = {
  name: "Demo Shop",
  provider: "github" as const,
  repoUrl: "https://github.com/acme/demo-shop",
  defaultBranch: "main",
};

describe("ProjectForm in creazione", () => {
  it("invia il payload completo, credenziali incluse", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Nome"), "Demo Shop");
    await user.selectOptions(screen.getByLabelText("Provider"), "bitbucket");
    await user.type(screen.getByLabelText("URL repository"), "https://bitbucket.org/acme/shop");
    // Il branch di default è precompilato con "main".
    expect(screen.getByLabelText("Branch di default")).toHaveValue("main");
    await user.type(screen.getByLabelText("Username"), "acme-bot");
    await user.type(screen.getByLabelText("Token di accesso"), "app-password-123");
    await user.click(screen.getByRole("button", { name: "Crea progetto" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/shop",
      defaultBranch: "main",
      credentials: { username: "acme-bot", token: "app-password-123" },
    });
  });

  it("senza username invia credenziali con solo token", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Nome"), "Demo");
    await user.type(screen.getByLabelText("URL repository"), "https://github.com/acme/demo");
    await user.type(screen.getByLabelText("Token di accesso"), "ghp_secret");
    await user.click(screen.getByRole("button", { name: "Crea progetto" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo",
      provider: "bitbucket",
      repoUrl: "https://github.com/acme/demo",
      defaultBranch: "main",
      credentials: { token: "ghp_secret" },
    });
  });

  it("spazi attorno a token e username vengono rimossi nel payload", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Nome"), "Demo");
    await user.type(screen.getByLabelText("URL repository"), "https://github.com/acme/demo");
    // Tipico copia-incolla del token con whitespace di troppo.
    await user.type(screen.getByLabelText("Username"), "  acme-bot ");
    await user.type(screen.getByLabelText("Token di accesso"), "  ghp_secret  ");
    await user.click(screen.getByRole("button", { name: "Crea progetto" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo",
      provider: "bitbucket",
      repoUrl: "https://github.com/acme/demo",
      defaultBranch: "main",
      credentials: { username: "acme-bot", token: "ghp_secret" },
    });
  });

  it("i campi credenziali sono input password e c'è l'avviso write-only", () => {
    render(<ProjectForm mode="create" onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("Token di accesso")).toHaveAttribute("type", "password");
    expect(screen.getByText(/non verranno mai mostrate/i)).toBeInTheDocument();
  });

  it("un rigetto di onSubmit mostra l'errore", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Vietato"));
    render(<ProjectForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Nome"), "Demo");
    await user.type(screen.getByLabelText("URL repository"), "https://github.com/acme/demo");
    await user.type(screen.getByLabelText("Token di accesso"), "ghp_secret");
    await user.click(screen.getByRole("button", { name: "Crea progetto" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Vietato");
  });
});

describe("ProjectForm in modifica", () => {
  it("prefilla i campi del progetto ma MAI le credenziali", () => {
    render(<ProjectForm mode="edit" initial={initial} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("Nome")).toHaveValue("Demo Shop");
    expect(screen.getByLabelText("URL repository")).toHaveValue(
      "https://github.com/acme/demo-shop",
    );
    expect(screen.getByLabelText("Branch di default")).toHaveValue("main");
    // Provider non modificabile dopo la creazione.
    expect(screen.getByLabelText("Provider")).toBeDisabled();
    expect(screen.getByLabelText("Token di accesso")).toHaveValue("");
    expect(screen.getByLabelText("Username")).toHaveValue("");
  });

  it("con il token vuoto il payload omette credentials", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm mode="edit" initial={initial} onSubmit={onSubmit} />);

    const name = screen.getByLabelText("Nome");
    await user.clear(name);
    await user.type(name, "Demo Shop EU");
    await user.click(screen.getByRole("button", { name: "Salva modifiche" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop EU",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
    });
    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect("credentials" in payload).toBe(false);
    expect("provider" in payload).toBe(false);
  });

  it("con un token nuovo il payload sostituisce le credenziali", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm mode="edit" initial={initial} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Token di accesso"), "ghp_nuovo");
    await user.click(screen.getByRole("button", { name: "Salva modifiche" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      credentials: { token: "ghp_nuovo" },
    });
  });
});
