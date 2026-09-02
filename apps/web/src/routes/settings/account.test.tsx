import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";

/**
 * Sotto-pagina Impostazioni → Account (`/settings/account`) col router vero
 * (memory history) e fetch mockata, limitatamente alle sezioni PERSONALI
 * aggiunte in fase 0: progetti seguiti e preferenze di notifica. Email, ruolo e
 * lingua restano coperti da `routes/settings.test.tsx`.
 */

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

type Handler = (url: URL, init?: RequestInit) => Response;

interface AccountMockState {
  /** Insieme dei progetti seguiti, sostituito da ogni PUT. */
  followed: string[];
  /** Body inviati a PUT /api/me/follows (l'insieme COMPLETO, mai un delta). */
  followPuts: unknown[];
  /** Preferenze di notifica correnti (`slackLinked` è contesto del server). */
  prefs: { slackDm: boolean; push: boolean; slackLinked: boolean };
  /** Body inviati a PUT /api/me/notification-prefs. */
  prefsPuts: unknown[];
}

function mockAccountApi(
  overrides: {
    followed?: string[];
    prefs?: { slackDm: boolean; push: boolean; slackLinked: boolean };
  } = {},
): AccountMockState {
  const state: AccountMockState = {
    followed: overrides.followed ?? [],
    followPuts: [],
    prefs: overrides.prefs ?? { slackDm: false, push: true, slackLinked: true },
    prefsPuts: [],
  };

  const handlers: Record<string, Handler> = {
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: { id: "u1", email: "ada@example.com", role: "member", language: "en" },
      }),
    "GET /api/projects": () =>
      jsonResponse(200, [
        {
          id: PROJECT_A,
          name: "Acme Platform",
          slug: "acme-platform",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          dailyReportEnabled: false,
          backlogEnabled: false,
          ingestionKey: "0123456789abcdef0123456789abcdef",
          nextTicketNumber: 1,
          repositoryCount: 1,
          createdAt: "2026-06-01T10:00:00.000Z",
        },
        {
          id: PROJECT_B,
          name: "Beta Shop",
          slug: "beta-shop",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          dailyReportEnabled: false,
          backlogEnabled: false,
          ingestionKey: "fedcba9876543210fedcba9876543210",
          nextTicketNumber: 1,
          repositoryCount: 0,
          createdAt: "2026-06-02T10:00:00.000Z",
        },
      ]),
    "GET /api/me/follows": () => jsonResponse(200, { projectIds: state.followed }),
    "PUT /api/me/follows": (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { projectIds: string[] };
      state.followPuts.push(body);
      state.followed = body.projectIds;
      return new Response(null, { status: 204 });
    },
    "GET /api/me/notification-prefs": () => jsonResponse(200, state.prefs),
    "PUT /api/me/notification-prefs": (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { slackDm: boolean; push: boolean };
      state.prefsPuts.push(body);
      state.prefs = { ...state.prefs, slackDm: body.slackDm, push: body.push };
      return new Response(null, { status: 204 });
    },
  };

  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });

  return state;
}

function renderAccount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/settings/account"] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("account: progetti seguiti", () => {
  it("una checkbox per progetto, spuntata per quelli già seguiti", async () => {
    mockAccountApi({ followed: [PROJECT_B] });
    renderAccount();

    expect(await screen.findByText("Followed projects")).toBeInTheDocument();
    expect(screen.getByLabelText(/Acme Platform/)).not.toBeChecked();
    expect(screen.getByLabelText(/Beta Shop/)).toBeChecked();
  });

  it("spuntare un progetto salva subito l'insieme COMPLETO", async () => {
    const state = mockAccountApi({ followed: [PROJECT_B] });
    renderAccount();

    await userEvent.click(await screen.findByLabelText(/Acme Platform/));

    // PUT di sostituzione: l'insieme parte intero, non come delta.
    await waitFor(() => expect(state.followPuts).toEqual([{ projectIds: [PROJECT_B, PROJECT_A] }]));
    expect(screen.getByLabelText(/Acme Platform/)).toBeChecked();
  });

  it("togliere la spunta manda l'insieme senza quel progetto", async () => {
    const state = mockAccountApi({ followed: [PROJECT_A, PROJECT_B] });
    renderAccount();

    await userEvent.click(await screen.findByLabelText(/Beta Shop/));

    await waitFor(() => expect(state.followPuts).toEqual([{ projectIds: [PROJECT_A] }]));
  });
});

describe("account: preferenze di notifica", () => {
  it("il toggle del DM Slack salva la preferenza", async () => {
    const state = mockAccountApi({ prefs: { slackDm: false, push: true, slackLinked: true } });
    renderAccount();

    const toggle = await screen.findByLabelText(/Slack DM/i);
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);

    // Il PUT sostituisce l'insieme: `push` viaggia com'era, non si perde.
    await waitFor(() => expect(state.prefsPuts).toEqual([{ slackDm: true, push: true }]));
    expect(toggle).toBeChecked();
  });

  it("senza identità Slack collegata il toggle è disabilitato, con l'hint", async () => {
    const state = mockAccountApi({ prefs: { slackDm: false, push: true, slackLinked: false } });
    renderAccount();

    const toggle = await screen.findByLabelText(/Slack DM/i);
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Link your Slack account first/i)).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(state.prefsPuts).toEqual([]);
  });
});
