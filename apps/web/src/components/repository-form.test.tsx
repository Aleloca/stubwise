import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccount } from "../lib/api";
import { RepositoryForm } from "./repository-form";

/**
 * Form di MODIFICA repository: nome, repoUrl, branch, account git collegato e
 * comandi install/test. Le credenziali NON vivono sul repository — stanno
 * sull'account git — quindi il form non le tocca. Il provider AI e l'auto-update
 * Docs NON sono qui: sono saliti al progetto (gruppo). La creazione passa dal
 * wizard, testato a parte.
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
  workspace: null,
  createdAt: "2026-06-01T10:00:00.000Z",
};

const ACCOUNT_B: GitAccount = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Bitbucket Prod",
  provider: "bitbucket",
  workspace: "bb-prod",
  createdAt: "2026-06-02T10:00:00.000Z",
};

const initial = {
  name: "Demo Shop",
  repoUrl: "https://github.com/acme/demo-shop",
  defaultBranch: "main",
  gitAccountId: ACCOUNT_A.id,
  testCommand: null,
  installCommand: null,
};

type Handler = (url: URL) => Response;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`fetch non mockata per ${raw}`);
    return Promise.resolve(handler(url));
  });
}

/**
 * Mock di base: account git + elenco branch del repo (popola il BranchSelect).
 * `repoUrl` iniziale → acme/demo-shop, da cui il form ricava owner/repo.
 */
function mockAccounts(accounts: GitAccount[]) {
  mockApi({
    "/api/git-accounts": () => jsonResponse(200, accounts),
    [`/api/git-accounts/${ACCOUNT_A.id}/branches`]: () =>
      jsonResponse(200, { branches: ["main", "develop"], defaultBranch: "main" }),
    [`/api/git-accounts/${ACCOUNT_B.id}/branches`]: () =>
      jsonResponse(200, { branches: ["main", "develop"], defaultBranch: "main" }),
  });
}

async function renderForm(props: { onSubmit: (values: unknown) => Promise<void> }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RepositoryForm initial={initial} onSubmit={props.onSubmit as never} />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("Name");
  await waitFor(() => {
    const branch = screen.getByLabelText("Default branch");
    expect(branch.tagName).toBe("SELECT");
  });
}

describe("RepositoryForm in modifica", () => {
  it("prefilla i campi e NON mostra campi credenziali", async () => {
    mockAccounts([ACCOUNT_A, ACCOUNT_B]);
    await renderForm({ onSubmit: vi.fn() });

    expect(screen.getByLabelText("Name")).toHaveValue("Demo Shop");
    expect(screen.getByLabelText("Repository URL")).toHaveValue("https://github.com/acme/demo-shop");
    expect(screen.getByLabelText("Default branch")).toHaveValue("main");
    expect(screen.getByLabelText("Git account")).toHaveValue(ACCOUNT_A.id);

    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /valida/i })).not.toBeInTheDocument();
  });

  it("NON mostra il provider AI né il toggle auto-update (sono sul progetto)", async () => {
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit: vi.fn() });

    expect(screen.queryByLabelText("Project AI provider")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Auto-update documentation on every push"),
    ).not.toBeInTheDocument();
  });

  it("senza cambiare account il payload omette gitAccountId", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_B]);
    await renderForm({ onSubmit });

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Demo Shop EU");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

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

    await user.selectOptions(screen.getByLabelText("Git account"), ACCOUNT_B.id);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      gitAccountId: ACCOUNT_B.id,
    });
  });

  it("impostando il comando di test, il PATCH lo include", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit });

    await user.type(screen.getByLabelText("Test command (optional)"), "pnpm test");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.testCommand).toBe("pnpm test");
  });

  it("prefilla il comando di installazione dal repository", async () => {
    mockAccounts([ACCOUNT_A]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RepositoryForm
          initial={{ ...initial, installCommand: "pnpm install" }}
          onSubmit={vi.fn() as never}
        />
      </QueryClientProvider>,
    );
    await screen.findByLabelText("Name");

    expect(screen.getByLabelText("Install command (optional)")).toHaveValue("pnpm install");
  });

  it("impostando il comando di installazione, il PATCH lo include", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit });

    await user.type(screen.getByLabelText("Install command (optional)"), "pnpm install");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.installCommand).toBe("pnpm install");
  });

  it("svuotando un comando di test esistente, il PATCH invia null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RepositoryForm
          initial={{ ...initial, testCommand: "npm test" }}
          onSubmit={onSubmit as never}
        />
      </QueryClientProvider>,
    );
    await screen.findByLabelText("Name");
    await waitFor(() => {
      expect(screen.getByLabelText("Default branch").tagName).toBe("SELECT");
    });

    const cmd = screen.getByLabelText("Test command (optional)");
    expect(cmd).toHaveValue("npm test");
    await user.clear(cmd);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.testCommand).toBeNull();
  });

  it("un comando di test invariato NON entra nel PATCH", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RepositoryForm
          initial={{ ...initial, testCommand: "npm test" }}
          onSubmit={onSubmit as never}
        />
      </QueryClientProvider>,
    );
    await screen.findByLabelText("Name");
    await waitFor(() => {
      expect(screen.getByLabelText("Default branch").tagName).toBe("SELECT");
    });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect("testCommand" in payload).toBe(false);
  });

  it("un rigetto di onSubmit mostra l'errore", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Vietato"));
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Vietato");
  });

  it("con account e repoUrl validi il branch è una SELECT popolata dall'API", async () => {
    mockApi({
      "/api/git-accounts": () => jsonResponse(200, [ACCOUNT_A]),
      [`/api/git-accounts/${ACCOUNT_A.id}/branches`]: () =>
        jsonResponse(200, { branches: ["main", "develop", "release"], defaultBranch: "main" }),
    });
    await renderForm({ onSubmit: vi.fn() });

    const branch = screen.getByLabelText("Default branch");
    expect(branch.tagName).toBe("SELECT");
    expect(branch).toHaveValue("main");
    expect(screen.getByRole("option", { name: "release" })).toBeInTheDocument();
  });

  it("se l'elenco dei branch fallisce ricade su un input testuale", async () => {
    mockApi({
      "/api/git-accounts": () => jsonResponse(200, [ACCOUNT_A]),
      [`/api/git-accounts/${ACCOUNT_A.id}/branches`]: () =>
        jsonResponse(422, { message: "scope branch mancante" }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RepositoryForm initial={initial} onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );

    const branch = await screen.findByLabelText("Default branch");
    await waitFor(() => expect(branch.tagName).toBe("INPUT"));
    expect(branch).toHaveValue("main");
  });
});
