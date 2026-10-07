import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import { ApiError, type GitAccount, type RepositoryPatch } from "../lib/api";
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

const ACCOUNT_C: GitAccount = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "GitHub Review",
  provider: "github",
  workspace: null,
  createdAt: "2026-06-03T10:00:00.000Z",
};

/** Bitbucket, stesso workspace di ACCOUNT_B: un revisore valido per B. */
const ACCOUNT_D: GitAccount = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Bitbucket Review",
  provider: "bitbucket",
  workspace: "bb-prod",
  createdAt: "2026-06-04T10:00:00.000Z",
};

/** Bitbucket, workspace DIVERSO da ACCOUNT_B: il server lo rifiuterebbe. */
const ACCOUNT_E: GitAccount = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Bitbucket Other",
  provider: "bitbucket",
  workspace: "bb-other",
  createdAt: "2026-06-05T10:00:00.000Z",
};

/** GitHub, terzo account: un principale alternativo allo stesso provider. */
const ACCOUNT_F: GitAccount = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "GitHub Other",
  provider: "github",
  workspace: null,
  createdAt: "2026-06-06T10:00:00.000Z",
};

/**
 * SENZA `reviewGitAccountId` di proposito: è la forma che il dettaglio passa
 * quando un server più vecchio non manda il campo (il web fa un cast). I test
 * che vogliono un revisore iniziale lo aggiungono con lo spread.
 */
const initial = {
  name: "Demo Shop",
  repoUrl: "https://github.com/acme/demo-shop",
  defaultBranch: "main",
  gitAccountId: ACCOUNT_A.id,
  testCommand: null,
  installCommand: null,
  graphEnabled: false,
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
    [`/api/git-accounts/${ACCOUNT_C.id}/branches`]: () =>
      jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
  });
}

async function renderForm(props: {
  onSubmit: (values: RepositoryPatch) => Promise<void>;
  initial?: Parameters<typeof RepositoryForm>[0]["initial"];
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RepositoryForm initial={props.initial ?? initial} onSubmit={props.onSubmit} />
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

  it("accendendo il knowledge graph, il PATCH include graphEnabled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit });

    const toggle = screen.getByLabelText("Code knowledge graph");
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.graphEnabled).toBe(true);
  });

  it("branch protetti: una voce per riga, normalizzati, nel PATCH solo se cambiati", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    // `initial` è SENZA protectedBranches: un server più vecchio (cast) → `?? []`.
    await renderForm({ onSubmit });

    const field = screen.getByLabelText("Protected branches");
    expect(field).toHaveValue("");
    await user.type(field, " develop {enter}{enter}release/*{enter}develop");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.protectedBranches).toEqual(["develop", "release/*"]);
  });

  it("branch protetti invariati NON entrano nel PATCH", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit, initial: { ...initial, protectedBranches: ["develop"] } });

    expect(screen.getByLabelText("Protected branches")).toHaveValue("develop");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect("protectedBranches" in payload).toBe(false);
  });

  it("il knowledge graph invariato NON entra nel PATCH", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RepositoryForm initial={{ ...initial, graphEnabled: true }} onSubmit={onSubmit as never} />
      </QueryClientProvider>,
    );
    await screen.findByLabelText("Name");
    await waitFor(() => {
      expect(screen.getByLabelText("Default branch").tagName).toBe("SELECT");
    });

    // Lo stato acceso del repository è riflesso dalla checkbox.
    expect(screen.getByLabelText("Code knowledge graph")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect("graphEnabled" in payload).toBe(false);
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

describe("RepositoryForm — account revisore (ciclo di correzione)", () => {
  it("offre solo gli account dello stesso provider, escluso il principale", async () => {
    mockAccounts([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);
    await renderForm({ onSubmit: vi.fn() });

    const select = screen.getByLabelText("Review account (optional)");
    const values = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toEqual(["", ACCOUNT_C.id]);
  });

  it("su Bitbucket solo lo stesso workspace del principale", async () => {
    mockApi({
      "/api/git-accounts": () => jsonResponse(200, [ACCOUNT_A, ACCOUNT_B, ACCOUNT_D, ACCOUNT_E]),
      [`/api/git-accounts/${ACCOUNT_B.id}/branches`]: () =>
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
    });
    await renderForm({
      onSubmit: vi.fn(),
      initial: {
        ...initial,
        repoUrl: "https://bitbucket.org/bb-prod/demo-shop",
        gitAccountId: ACCOUNT_B.id,
      },
    });

    const select = screen.getByLabelText("Review account (optional)");
    const values = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toEqual(["", ACCOUNT_D.id]);
  });

  it("senza revisore iniziale (campo assente) il payload non lo manda", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    // `initial` non ha il campo: è la fixture che arriva al confronto
    // `initial.reviewGitAccountId ?? null` nel submit.
    expect("reviewGitAccountId" in initial).toBe(false);
    await renderForm({ onSubmit });

    expect(screen.getByLabelText("Review account (optional)")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect("reviewGitAccountId" in onSubmit.mock.calls[0]![0]).toBe(false);
  });

  it("un revisore esistente e un salvataggio che cambia solo il nome: il campo NON parte", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    await renderForm({ onSubmit, initial: { ...initial, reviewGitAccountId: ACCOUNT_C.id } });
    await waitFor(() =>
      expect(screen.getByLabelText("Review account (optional)")).toHaveValue(ACCOUNT_C.id),
    );

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Demo Shop EU");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop EU",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
    });
  });

  it("scegliendo il revisore il payload lo include", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    await renderForm({ onSubmit });

    await user.selectOptions(screen.getByLabelText("Review account (optional)"), ACCOUNT_C.id);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ reviewGitAccountId: ACCOUNT_C.id });
  });

  it("togliendo un revisore esistente il payload manda null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    await renderForm({ onSubmit, initial: { ...initial, reviewGitAccountId: ACCOUNT_C.id } });
    await waitFor(() =>
      expect(screen.getByLabelText("Review account (optional)")).toHaveValue(ACCOUNT_C.id),
    );

    await user.selectOptions(screen.getByLabelText("Review account (optional)"), "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ reviewGitAccountId: null });
  });

  it("passando a un principale di un altro provider il revisore decade a null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);
    await renderForm({ onSubmit, initial: { ...initial, reviewGitAccountId: ACCOUNT_C.id } });

    await user.selectOptions(screen.getByLabelText("Git account"), ACCOUNT_B.id);
    expect(screen.getByLabelText("Review account (optional)")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      gitAccountId: ACCOUNT_B.id,
      reviewGitAccountId: null,
    });
  });

  it("un revisore SALVATO che il filtro esclude resta, marcato non valido", async () => {
    // Es. qualcuno ha corretto il provider/workspace dell'account: il filtro
    // lo esclude, ma nessuno in questo form l'ha toccato.
    mockAccounts([ACCOUNT_A, ACCOUNT_C, ACCOUNT_E]);
    await renderForm({ onSubmit: vi.fn(), initial: { ...initial, reviewGitAccountId: ACCOUNT_E.id } });

    const select = screen.getByLabelText("Review account (optional)");
    expect(select).toHaveValue(ACCOUNT_E.id);
    expect((select as HTMLSelectElement).selectedOptions[0]).toHaveTextContent(
      "Bitbucket Other — no longer valid: different provider/workspace",
    );
  });

  it("…e salvando solo il nome il campo NON parte (il client non lo cancella)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_C, ACCOUNT_E]);
    await renderForm({ onSubmit, initial: { ...initial, reviewGitAccountId: ACCOUNT_E.id } });

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Demo Shop EU");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop EU",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
    });
  });

  it("principale cambiato verso lo STESSO provider: il revisore resta e il campo non parte", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockApi({
      "/api/git-accounts": () => jsonResponse(200, [ACCOUNT_A, ACCOUNT_C, ACCOUNT_F]),
      [`/api/git-accounts/${ACCOUNT_A.id}/branches`]: () =>
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
      [`/api/git-accounts/${ACCOUNT_F.id}/branches`]: () =>
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
    });
    await renderForm({ onSubmit, initial: { ...initial, reviewGitAccountId: ACCOUNT_C.id } });

    await user.selectOptions(screen.getByLabelText("Git account"), ACCOUNT_F.id);
    expect(screen.getByLabelText("Review account (optional)")).toHaveValue(ACCOUNT_C.id);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Demo Shop",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      gitAccountId: ACCOUNT_F.id,
    });
  });

  it("promuovendo il revisore a principale il revisore va a null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: RepositoryPatch) => Promise<void>>().mockResolvedValue(undefined);
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    await renderForm({ onSubmit, initial: { ...initial, reviewGitAccountId: ACCOUNT_C.id } });

    await user.selectOptions(screen.getByLabelText("Git account"), ACCOUNT_C.id);
    expect(screen.getByLabelText("Review account (optional)")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      gitAccountId: ACCOUNT_C.id,
      reviewGitAccountId: null,
    });
  });

  it("il suggerimento sotto il select ne è la descrizione accessibile", async () => {
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit: vi.fn() });

    expect(screen.getByLabelText("Review account (optional)")).toHaveAccessibleDescription(
      en.repositories.form.reviewAccountHint,
    );
  });

  it("l'opzione vuota del select è «Predefinito», non più «Nessuno»", async () => {
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    await renderForm({ onSubmit: vi.fn() });

    const select = screen.getByLabelText("Review account (optional)") as HTMLSelectElement;
    expect(select.options[0]!.textContent).toBe(en.repositories.form.reviewAccountDefaultOption);
  });

  // Ogni `code` che il PATCH può restituire ha un testo proprio: il `message`
  // del server (inglese, tecnico) è diverso apposta, così l'asserzione prova
  // la traduzione del code e non l'eco del message.
  const CODES = [
    "review_account_no_write_permission",
    "review_credentials_undecryptable",
    "repository_changed_concurrently",
    "main_account_identity_unresolved",
    "review_account_same_identity",
    "review_account_same_as_main",
    "review_account_provider_mismatch",
    "review_account_workspace_mismatch",
    "review_account_identity_unresolved",
    "review_git_account_not_found",
    "repository_not_found",
  ] as const;

  it.each(CODES)("l'errore %s si mostra col suo testo", async (code) => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<(values: RepositoryPatch) => Promise<void>>()
      .mockRejectedValue(new ApiError(422, "server message", code));
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.errors[code]);
    expect(alert).not.toHaveTextContent("server message");
  });

  it("review_account_invalid porta il dettaglio dei controlli falliti", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<(values: RepositoryPatch) => Promise<void>>()
      .mockRejectedValue(new ApiError(422, "missing pullrequest:write", "review_account_invalid"));
    mockAccounts([ACCOUNT_A]);
    await renderForm({ onSubmit });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The review account failed the checks on the repository. missing pullrequest:write",
    );
  });
});

/**
 * Il revisore EFFETTIVO sotto il select vuoto (D8): lo deriva il SERVER
 * (`effectiveReviewAccount` / `skippedDefaultReviewAccount`), il form lo legge
 * e basta. La fixture `initial` resta SENZA i due campi: è la prova che la
 * lettura `?? null` regge un server più vecchio (il web fa un cast).
 */
describe("RepositoryForm — revisore effettivo (predefinito)", () => {
  const PR_BOT = { id: "77777777-7777-4777-8777-777777777777", name: "pr-bot" };

  it("predefinito effettivo e select vuoto: «Revisore: predefinito (pr-bot)»", async () => {
    // La lista degli account dice ALTRO (C marcato predefinito): il nome viene
    // dal campo derivato, mai ridedotto dalla lista nel client.
    mockAccounts([ACCOUNT_A, { ...ACCOUNT_C, isDefaultReviewer: true }]);
    await renderForm({
      onSubmit: vi.fn(),
      initial: { ...initial, effectiveReviewAccount: { ...PR_BOT, source: "default" } },
    });

    expect(screen.getByText("Reviewer: default (pr-bot)")).toBeInTheDocument();
    expect(screen.queryByText(/GitHub Review/, { selector: "p" })).not.toBeInTheDocument();
  });

  it("fixture SENZA i campi nuovi: «Revisore: nessuno», nessuna eccezione", async () => {
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    expect("effectiveReviewAccount" in initial).toBe(false);
    expect("skippedDefaultReviewAccount" in initial).toBe(false);
    await renderForm({ onSubmit: vi.fn() });

    expect(screen.getByText(en.repositories.form.reviewEffectiveNone)).toBeInTheDocument();
  });

  it("predefinito saltato perché è il principale: lo dice", async () => {
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    await renderForm({
      onSubmit: vi.fn(),
      initial: {
        ...initial,
        effectiveReviewAccount: null,
        skippedDefaultReviewAccount: { id: ACCOUNT_A.id, name: "GitHub Demo" },
      },
    });

    expect(
      screen.getByText("Reviewer: none — the default (GitHub Demo) is the main account of this repository"),
    ).toBeInTheDocument();
  });

  it("revisore esplicito salvato: nessuna scritta del predefinito", async () => {
    mockAccounts([ACCOUNT_A, ACCOUNT_C]);
    await renderForm({
      onSubmit: vi.fn(),
      initial: {
        ...initial,
        reviewGitAccountId: ACCOUNT_C.id,
        effectiveReviewAccount: { id: ACCOUNT_C.id, name: ACCOUNT_C.name, source: "explicit" },
      },
    });

    expect(screen.queryByText(/^Reviewer:/)).not.toBeInTheDocument();
  });

  it("principale cambiato nel form senza salvare: la scritta si nasconde (descrive lo stato SALVATO)", async () => {
    const user = userEvent.setup();
    mockAccounts([ACCOUNT_A, ACCOUNT_C, ACCOUNT_F]);
    await renderForm({
      onSubmit: vi.fn(),
      initial: { ...initial, effectiveReviewAccount: { ...PR_BOT, source: "default" } },
    });
    expect(screen.getByText("Reviewer: default (pr-bot)")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Git account"), ACCOUNT_C.id);

    expect(screen.queryByText(/^Reviewer:/)).not.toBeInTheDocument();
  });
});
