import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectForm } from "./project-form";
import * as api from "../lib/api";

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

  it("con username ed email (API token Bitbucket) invia tutti e tre i campi", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Nome"), "Demo Shop");
    await user.selectOptions(screen.getByLabelText("Provider"), "bitbucket");
    await user.type(screen.getByLabelText("URL repository"), "https://bitbucket.org/acme/shop");
    await user.type(screen.getByLabelText("Username"), "acme-bot");
    await user.type(screen.getByLabelText("Email"), "bot@acme.io");
    await user.type(screen.getByLabelText("Token di accesso"), "atlassian-api-token");
    await user.click(screen.getByRole("button", { name: "Crea progetto" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/shop",
      defaultBranch: "main",
      credentials: { username: "acme-bot", email: "bot@acme.io", token: "atlassian-api-token" },
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

describe("ProjectForm — validazione credenziali", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("il pulsante Valida è disabilitato senza token", () => {
    render(<ProjectForm mode="create" onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Valida credenziali" })).toBeDisabled();
  });

  it("clic su Valida chiama l'API col payload giusto e mostra i check", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "postValidateCredentials").mockResolvedValue({
      ok: false,
      checks: [
        { name: "Accesso git (push)", ok: true, detail: "autenticazione git e push ok" },
        {
          name: "Accesso REST API (PR)",
          ok: false,
          detail: "autenticazione REST fallita (401): serve l'email",
        },
      ],
    });
    render(<ProjectForm mode="create" onSubmit={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("Provider"), "bitbucket");
    await user.type(screen.getByLabelText("URL repository"), "https://bitbucket.org/acme/shop");
    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Email"), "alice@corp.io");
    await user.type(screen.getByLabelText("Token di accesso"), "api-token");

    const validateBtn = screen.getByRole("button", { name: "Valida credenziali" });
    expect(validateBtn).toBeEnabled();
    await user.click(validateBtn);

    expect(spy).toHaveBeenCalledWith({
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/shop",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
    });

    expect(await screen.findByText("Problemi rilevati")).toBeInTheDocument();
    expect(screen.getByText(/autenticazione git e push ok/)).toBeInTheDocument();
    expect(screen.getByText(/serve l'email/)).toBeInTheDocument();
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
    expect(screen.getByLabelText("Email")).toHaveValue("");
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

  it("con credentialsConfigured parte collassato: conferma + 'Modifica credenziali', campi nascosti", async () => {
    const user = userEvent.setup();
    render(
      <ProjectForm mode="edit" initial={initial} credentialsConfigured onSubmit={vi.fn()} />,
    );

    // Stato compatto "configurato": niente campi credenziali finché non si apre.
    expect(screen.getByTestId("credentials-configured")).toHaveTextContent(
      "Credenziali git configurate",
    );
    expect(screen.queryByLabelText("Token di accesso")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();

    // I campi sopra le credenziali (nome/repo/branch) restano sempre visibili.
    expect(screen.getByLabelText("Nome")).toHaveValue("Demo Shop");

    await user.click(screen.getByRole("button", { name: "Modifica credenziali" }));

    // Ora i campi compaiono, vuoti (write-only), con il bottone Valida.
    expect(screen.getByLabelText("Token di accesso")).toHaveValue("");
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Valida credenziali" })).toBeInTheDocument();
    expect(screen.queryByTestId("credentials-configured")).not.toBeInTheDocument();

    // Annulla richiude allo stato compatto.
    await user.click(screen.getByRole("button", { name: "Annulla" }));
    expect(screen.getByTestId("credentials-configured")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token di accesso")).not.toBeInTheDocument();
  });

  it("senza credentialsConfigured i campi credenziali sono subito visibili", () => {
    render(<ProjectForm mode="edit" initial={initial} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("credentials-configured")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Token di accesso")).toBeInTheDocument();
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
