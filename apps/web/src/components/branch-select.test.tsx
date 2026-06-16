import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchSelect } from "./branch-select";

/**
 * BranchSelect: select dei branch del repo via API, con fallback a input
 * testuale (errore di fetch o repo non determinabile). Rete mockata via `fetch`
 * globale, come negli altri test che passano dal wrapper api.
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

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function renderSelect(props: {
  accountId?: string;
  repoFullName?: string;
  value: string;
  onChange?: (b: string) => void;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BranchSelect
        accountId={props.accountId}
        repoFullName={props.repoFullName}
        value={props.value}
        onChange={props.onChange ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

describe("BranchSelect", () => {
  it("con account e repo carica i branch e preseleziona value", async () => {
    mockApi({
      [`/api/git-accounts/${ACCOUNT_ID}/branches`]: () =>
        jsonResponse(200, { branches: ["main", "develop", "release"], defaultBranch: "main" }),
    });

    renderSelect({ accountId: ACCOUNT_ID, repoFullName: "acme/demo", value: "develop" });

    const select = await screen.findByLabelText("Default branch");
    expect(select.tagName).toBe("SELECT");
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("develop"));
    expect(
      screen.getByRole("option", { name: "release" }),
    ).toBeInTheDocument();
  });

  it("include value anche se non è fra i branch tornati dall'API", async () => {
    mockApi({
      [`/api/git-accounts/${ACCOUNT_ID}/branches`]: () =>
        jsonResponse(200, { branches: ["main", "develop"], defaultBranch: "main" }),
    });

    renderSelect({ accountId: ACCOUNT_ID, repoFullName: "acme/demo", value: "feature/x" });

    const select = await screen.findByLabelText("Default branch");
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("feature/x"));
    expect(screen.getByRole("option", { name: "feature/x" })).toBeInTheDocument();
  });

  it("su errore di fetch ricade su un input testuale", async () => {
    mockApi({
      [`/api/git-accounts/${ACCOUNT_ID}/branches`]: () =>
        jsonResponse(422, { message: "scope branch mancante" }),
    });

    renderSelect({ accountId: ACCOUNT_ID, repoFullName: "acme/demo", value: "main" });

    const input = await screen.findByLabelText("Default branch");
    await waitFor(() => expect(input.tagName).toBe("INPUT"));
    expect(input).toHaveValue("main");
    expect(screen.getByText(/unable to load branches/i)).toBeInTheDocument();
  });

  it("senza account o repo mostra direttamente l'input testuale", () => {
    // Nessuna chiamata di rete deve partire.
    fetchMock.mockImplementation(() => {
      throw new Error("nessuna fetch attesa");
    });

    renderSelect({ value: "main" });

    const input = screen.getByLabelText("Default branch");
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveValue("main");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
