import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Repository } from "../lib/api";
import { NewTicketDialog } from "./new-ticket-dialog";

/**
 * Dialog "Nuovo ticket" puro: progetti (gruppi) iniettati, repository del
 * progetto selezionato letti via query (fetch mockata). Si verifica il payload
 * prodotto — incluso il repository bersaglio — e la chiusura.
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

const PROJECT_ALFA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const projects: Project[] = [
  {
    id: PROJECT_ALFA,
    name: "Progetto Alfa",
    slug: "progetto-alfa",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: PROJECT_BETA,
    name: "Progetto Beta",
    slug: "progetto-beta",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

function repo(id: string, projectId: string, name: string, slug: string): Repository {
  return {
    id,
    projectId,
    name,
    slug,
    provider: "github",
    repoUrl: `https://github.com/acme/${slug}`,
    defaultBranch: "main",
    ingestionKey: `key-${slug}`,
    gitAccountId: "acc-1",
    gitAccountName: "GitHub Demo",
    webhookConfiguredAt: null,
    testCommand: null,
    installCommand: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const REPO_ALFA_1 = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_BETA_1 = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Mock di /api/repositories?projectId= con la lista per progetto. */
function mockRepositories(byProject: Record<string, Repository[]>) {
  fetchMock.mockImplementation((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    if (url.pathname === "/api/repositories") {
      const projectId = url.searchParams.get("projectId") ?? "";
      return Promise.resolve(jsonResponse(200, byProject[projectId] ?? []));
    }
    throw new Error(`fetch non mockata per ${raw}`);
  });
}

function renderDialog(props: {
  onSubmit: (draft: unknown) => Promise<void>;
  onClose?: () => void;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <NewTicketDialog
        projects={projects}
        onSubmit={props.onSubmit as never}
        onClose={props.onClose ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("NewTicketDialog", () => {
  it("invia il payload con progetto, repository bersaglio, tipo, priorità e body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockRepositories({
      [PROJECT_ALFA]: [repo(REPO_ALFA_1, PROJECT_ALFA, "alfa-api", "alfa-api")],
      [PROJECT_BETA]: [repo(REPO_BETA_1, PROJECT_BETA, "beta-web", "beta-web")],
    });
    renderDialog({ onSubmit });

    expect(screen.getByRole("dialog", { name: "New ticket" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Title"), "Crash al checkout");
    await user.selectOptions(screen.getByLabelText("Project"), "Progetto Beta");
    // Il dropdown repository si popola dal progetto scelto.
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "beta-web" })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Target repository"), REPO_BETA_1);
    await user.selectOptions(screen.getByLabelText("Type"), "Bug");
    await user.selectOptions(screen.getByLabelText("Priority"), "High");
    await user.type(screen.getByLabelText("Description (optional)"), "Stacktrace in allegato");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: PROJECT_BETA,
      repositoryId: REPO_BETA_1,
      title: "Crash al checkout",
      body: "Stacktrace in allegato",
      type: "bug",
      priority: "high",
    });
  });

  it("preseleziona il primo repository del progetto e omette body senza descrizione", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockRepositories({
      [PROJECT_ALFA]: [repo(REPO_ALFA_1, PROJECT_ALFA, "alfa-api", "alfa-api")],
    });
    renderDialog({ onSubmit });

    await waitFor(() => {
      expect(screen.getByLabelText("Target repository")).toHaveValue(REPO_ALFA_1);
    });
    await user.type(screen.getByLabelText("Title"), "Solo titolo");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: PROJECT_ALFA,
      repositoryId: REPO_ALFA_1,
      title: "Solo titolo",
      type: "task",
      priority: "medium",
    });
  });

  it("se il progetto non ha repository, il submit è disabilitato e mostra un avviso", async () => {
    const onSubmit = vi.fn();
    mockRepositories({ [PROJECT_ALFA]: [] });
    renderDialog({ onSubmit });

    await screen.findByRole("alert");
    const submit = screen.getByRole("button", { name: "Create ticket" });
    expect(submit).toBeDisabled();
  });

  it("Annulla ed Escape chiudono senza inviare", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    mockRepositories({ [PROJECT_ALFA]: [repo(REPO_ALFA_1, PROJECT_ALFA, "alfa-api", "alfa-api")] });
    renderDialog({ onSubmit, onClose });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("un rigetto di onSubmit mostra l'errore e non chiude", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Repository non trovato"));
    const onClose = vi.fn();
    mockRepositories({ [PROJECT_ALFA]: [repo(REPO_ALFA_1, PROJECT_ALFA, "alfa-api", "alfa-api")] });
    renderDialog({ onSubmit, onClose });

    await waitFor(() => {
      expect(screen.getByLabelText("Target repository")).toHaveValue(REPO_ALFA_1);
    });
    await user.type(screen.getByLabelText("Title"), "Boom");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(await screen.findByText("Repository non trovato")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
