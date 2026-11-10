import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { resetStreamsForTests } from "./claudeStream";
import { forgetClaudeCaches } from "./claude";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// Le conversazioni pubbliche nelle pagine della build app (chat, fetta 5,
// F5.4), sulle rotte della F5.2–F5.3, col flag `claude-public` acceso.
vi.mock("@backend/api", async () => await import("./index"));

const CONV = "cccccccc-0000-4000-8000-0000000000f5";
const MINE = "cccccccc-0000-4000-8000-0000000000f6";
const GIULIA = "55555555-5555-4555-8555-555555555555";
let seen: SeenRequest[] = [];

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "free",
  title: "Callbacks",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-11-10T10:00:00.000Z",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  canWrite: false,
  canIntervene: false,
  canInterrupt: false,
  canClose: false,
  questions: [],
  inputs: [],
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  id: MINE,
  title: "Callbacks",
  archived: false,
  context: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  visibility: "private",
  author: { id: ME_ID, name: "Ada" },
  isOwner: true,
  publishedAt: null,
  publishedBy: null,
  publishedProjects: [],
  privateTail: false,
  heldProjects: [],
  continuesFrom: null,
  canPublish: true,
  canContinue: false,
  ...over,
});

const theirs = (over: Record<string, unknown> = {}) =>
  view({
    id: CONV,
    visibility: "public",
    author: { id: GIULIA, name: "Giulia Ferri" },
    isOwner: false,
    publishedAt: "2026-11-10T10:06:00.000Z",
    publishedBy: { id: GIULIA, name: "Giulia Ferri" },
    publishedProjects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }],
    canPublish: false,
    canContinue: true,
    ...over,
  });

function install(routes: Record<string, unknown> = {}) {
  const events = (text: string) => ({
    body: {
      events: [
        { id: "1", type: "input", segmentId: "s1", at: "2026-11-10T10:00:10.000Z", data: { inputId: "i1", text: "How are the callbacks?" } },
        { id: "2", type: "assistant_text", segmentId: "s1", at: "2026-11-10T10:01:00.000Z", data: { text } },
      ],
      before: null,
    },
  });
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ instancePermissions: ["claude.public.view"] }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, GIULIA] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" },
        { id: GIULIA, name: "Giulia Ferri", initials: "GF", departmentIds: [DEPT_ID], email: "giulia@example.com" },
      ],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/claude/conversations": ({ path }: SeenRequest) => ({
      body: { items: path.includes("scope=public") ? [theirs()] : [view()], nextCursor: null },
    }),
    [`GET /api/claude/conversations/${MINE}`]: { body: { ...view(), session: session(MINE, { canWrite: true, canIntervene: true }) } },
    [`GET /api/agent-sessions/${MINE}`]: { body: session(MINE, { canWrite: true, canIntervene: true }) },
    [`GET /api/agent-sessions/${MINE}/events`]: events("They're fine."),
    [`GET /api/claude/conversations/${MINE}/proposals`]: { body: [] },
    [`GET /api/claude/conversations/${MINE}/groups`]: { body: [] },
    [`GET /api/claude/conversations/${CONV}`]: { body: { ...theirs(), session: session(CONV) } },
    [`GET /api/agent-sessions/${CONV}`]: { body: session(CONV) },
    [`GET /api/agent-sessions/${CONV}/events`]: events("Giulia's callbacks are fine."),
    [`GET /api/claude/conversations/${CONV}/proposals`]: { body: [] },
    [`GET /api/claude/conversations/${CONV}/groups`]: { body: [] },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetStreamsForTests();
  forgetClaudeCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le pubbliche nelle pagine della build app", () => {
  it("«Make public»: il dialogo coi progetti del server e la frase sulle letture di Claude; la conferma manda l'elenco", async () => {
    install({
      [`POST /api/claude/conversations/${MINE}/visibility`]: (req: SeenRequest) =>
        (req.body as { confirmedProjectIds?: string[] }).confirmedProjectIds
          ? { body: view({ visibility: "public", publishedAt: "2026-11-10T12:00:00.000Z", publishedBy: { id: ME_ID, name: "Ada" } }) }
          : {
              status: 409,
              body: { code: "needs_confirmation", message: "x", projects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }], includesToolReads: true, reconfirm: false },
            },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${MINE}`);
    await ue.click(await screen.findByRole("button", { name: "Make public" }));
    const dialog = await screen.findByRole("dialog", { name: "Make this conversation public?" });
    expect(await within(dialog).findByText("Audin AI")).toBeInTheDocument();
    expect(within(dialog).getByText(/will also see what Claude read for you/)).toBeInTheDocument();
    await ue.click(within(dialog).getByRole("button", { name: "Make public, I'm responsible" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
        { visibility: "public" },
        { visibility: "public", confirmedProjectIds: [PROJECT_ID] },
      ]),
    );
  });

  it("senza progetti né letture: il dialogo si mostra lo stesso (la conferma è sempre esplicita), senza la frase", async () => {
    install({
      [`POST /api/claude/conversations/${MINE}/visibility`]: (req: SeenRequest) =>
        (req.body as { confirmedProjectIds?: string[] }).confirmedProjectIds
          ? { body: view({ visibility: "public" }) }
          : { status: 409, body: { code: "needs_confirmation", message: "x", projects: [], includesToolReads: false, reconfirm: false } },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${MINE}`);
    await ue.click(await screen.findByRole("button", { name: "Make public" }));
    const dialog = await screen.findByRole("dialog", { name: "Make this conversation public?" });
    expect(await within(dialog).findByText("Claude didn't use any project.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/will also see what Claude read for you/)).toBeNull();
    await ue.click(within(dialog).getByRole("button", { name: "Make public, I'm responsible" }));
    await waitFor(() => expect(seen.filter((r) => r.method === "POST").at(-1)!.body).toEqual({ visibility: "public", confirmedProjectIds: [] }));
  });

  it("una pubblica di un'altra: la testata dice chi l'ha resa pubblica, niente gestione; la colonna ha «Public»", async () => {
    install();
    renderRoute(`/claude/${CONV}`);
    expect(await screen.findByText("Giulia's callbacks are fine.")).toBeInTheDocument();
    expect(await screen.findByText(/made public by Giulia Ferri/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make public" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
    const column = screen.getByRole("navigation", { name: "Claude views" });
    expect(within(column).getByText("Public")).toBeInTheDocument();
    expect(seen.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("l'autrice di una pubblica col seguito privato: la fascia nomina i progetti nuovi; la riconferma manda solo quelli", async () => {
    const MKX = "22222222-2222-4222-8222-2222222222b2";
    const held = view({
      visibility: "public",
      publishedAt: "2026-11-10T10:06:00.000Z",
      publishedBy: { id: ME_ID, name: "Ada" },
      publishedProjects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }],
      heldProjects: [{ id: MKX, code: "MKX", name: "Marketing" }],
    });
    install({
      "GET /api/projects": {
        body: [
          serverProject({ memberIds: [ME_ID, GIULIA] }),
          serverProject({ id: MKX, name: "Marketing", slug: "marketing", code: "MKX", memberIds: [ME_ID] }),
        ],
      },
      [`GET /api/claude/conversations/${MINE}`]: { body: { ...held, session: session(MINE, { canWrite: true, canIntervene: true }) } },
      [`POST /api/claude/conversations/${MINE}/visibility`]: (req: SeenRequest) =>
        (req.body as { confirmedProjectIds?: string[] }).confirmedProjectIds
          ? { body: { ...held, heldProjects: [], publishedProjects: [...(held.publishedProjects as unknown[]), { id: MKX, code: "MKX", name: "Marketing" }] } }
          : {
              status: 409,
              body: { code: "needs_confirmation", message: "x", projects: [{ id: MKX, code: "MKX", name: "Marketing" }], includesToolReads: false, reconfirm: true },
            },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${MINE}`);
    expect(await screen.findByText(/New messages are private: Claude used MKX/)).toBeInTheDocument();
    await ue.click(screen.getByRole("button", { name: "Review and share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share the new messages?" });
    expect(await within(dialog).findByText("Marketing")).toBeInTheDocument();
    expect(within(dialog).queryByText("Audin AI")).toBeNull();
    await ue.click(within(dialog).getByRole("button", { name: "Share, I'm responsible" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
        { visibility: "public" },
        { visibility: "public", confirmedProjectIds: [MKX] },
      ]),
    );
  });

  it("«Continue»: chi legge scrive nella casella, nasce la SUA conversazione (201) e il primo messaggio va lì; l'originale resta in testa", async () => {
    const continued = view({ continuesFrom: { id: CONV, available: true } });
    install({
      [`POST /api/claude/conversations/${CONV}/continue`]: { status: 201, body: continued },
      [`GET /api/claude/conversations/${MINE}`]: { body: { ...continued, session: session(MINE, { canWrite: true, canIntervene: true }) } },
      [`GET /api/agent-sessions/${MINE}/events`]: { body: { events: [], before: null } },
      [`POST /api/agent-sessions/${MINE}/messages`]: { status: 202, body: { inputId: "eeeeeeee-0000-4000-8000-000000000001", status: "pending" } },
    });
    const ue = userEvent.setup();
    const router = renderRoute(`/claude/${CONV}`);
    expect(await screen.findByText("What you write starts your own private conversation. Claude will act as you.")).toBeInTheDocument();
    const box = await screen.findByPlaceholderText("Continue in your own conversation…");
    await ue.type(box, "And mine?");
    await ue.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe(`/claude/${MINE}`));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
        [`/api/claude/conversations/${CONV}/continue`, {}],
        [`/api/agent-sessions/${MINE}/messages`, { text: "And mine?" }],
      ]),
    );
    // L'originale in sola lettura in testa, dal vivo.
    expect(await screen.findByText("Giulia's callbacks are fine.")).toBeInTheDocument();
  });
});
