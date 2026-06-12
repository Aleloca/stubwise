import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccount } from "../lib/api";
import { ProjectForm } from "./project-form";

/**
 * Form di MODIFICA progetto: nome, repoUrl, branch e account git collegato
 * (select fra quelli esistenti). Le credenziali NON vivono più sul progetto —
 * stanno sull'account git — quindi il form non le tocca: niente campi
 * credenziali né validazione. La creazione passa dal wizard, testato a parte.
 *
 * Il form legge gli account con `useSuspenseQuery`: rete mockata via `fetch`
 * globale, come negli altri test che dipendono dalle queryOptions.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const ACCOUNT_A: GitAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "GitHub Demo",
  provider: "github",
  createdAt: "2026-06-01T10:00:00.000Z",
};

const ACCOUNT_B: GitAccount = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Bitbucket Prod",
  provider: "bitbucket",
  createdAt: "2026-06-02T10:00:00.000Z",
};

const initial = {
  name: "Demo Shop",
  repoUrl: "https://github.com/acme/demo-shop",
  defaultBranch: "main",
  gitAccountId: ACCOUNT_A.id,
};

function mockAccounts(accounts: GitAccount[]) {
  fetchMock.mockImplementation((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    if (url.pathname === "/api/git-accounts") return Promise.resolve(jsonResponse(200, accounts));
    throw new Error(`fetch non mockata per ${raw}`);
  });
}

async function renderForm(props: { onSubmit: (values: unknown) => Promise<void> }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectForm initial={initial} onSubmit={props.onSubmit as never} />
    </QueryClientProvider>,
  );
  // Attende che la suspense risolva (gli account sono caricati).
  await screen.findByLabelText("Nome");
}

describe("ProjectForm in modifica", () => {
  it("prefilla i campi e NON mostra campi credenziali", async () => {
    mockAccounts([ACCOUNT_A, ACCOUNT_B]);
    await renderForm({ onSubmit: vi.fn() });

    expect(screen.getByLabelText("Nome")).toHaveValue("Demo Shop");
    expect(screen.getByLabelText("URL repository")).toHaveValue("https://github.com/acme/demo-shop");
    expect(screen.getByLabelText("Branch di default")).toHaveValue("main");
    // L'account collegato è preselezionato.
    expect(screen.getByLabelText("Account git")).toHaveValue(ACCOUNT_A.id);

    // Nessun campo credenziale né bottone di validazione: vivono sull'account.
    expect(screen.queryByLabelText("Token di accesso")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /valida/i })).not.toBeInTheDocument();
  });

  it("senza cambiare account il payload omette gitAccountId", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_B]);
    await renderForm({ onSubmit });

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
    expect("gitAccountId" in payload).toBe(false);
    expect("credentials" in payload).toBe(false);
  });

  it("cambiando account il payload include il nuovo gitAccountId", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_B]);
    await renderForm({ onSubmit });

    await user.selectOptions(screen.getByLabelText("Account git"), ACCOUNT_B.id);
    await user.click(screen.getByRole("button", { name: "Salva modifiche" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      gitAccountId: ACCOUNT_B.id,
    });
  });

  it("un rigetto di onSubmit mostra l'errore", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Vietato"));
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit });

    await user.click(screen.getByRole("button", { name: "Salva modifiche" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Vietato");
  });
});
