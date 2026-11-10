import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { forgetPeopleChatCaches } from "./chat";
import { resetChatStreams, setChatStreamTransport } from "./chatStream";
import {
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  type SeenRequest,
} from "./fakeServer";

// La Chat fra persone nelle pagine della build app (area 4, fetta 1), sulle
// rotte della F1.2. Ciò che è delle fette dopo (DM, ricerca, privati e
// generali, allegati, la domanda, @Claude, task da un messaggio) non compare.
vi.mock("@backend/api", async () => await import("./index"));

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const MARTA = "55555555-5555-4555-8555-555555555555";
let seen: SeenRequest[] = [];

const channel = (over: Record<string, unknown> = {}) => ({
  id: CH,
  kind: "project",
  projectId: PROJECT_ID,
  name: "design",
  description: "",
  topic: "",
  visibility: "open",
  isGeneral: false,
  archived: false,
  archivedAt: null,
  archivedBy: null,
  createdBy: MARTA,
  createdAt: "2026-11-10T09:00:00.000Z",
  memberIds: [ME_ID, MARTA],
  isMember: true,
  canWrite: true,
  canJoin: false,
  canLeave: true,
  canManage: false,
  unread: 0,
  mentions: 0,
  level: "all",
  lastMessageAt: "2026-11-10T10:00:00.000Z",
  lastReadAt: "2026-11-10T10:00:00.000Z",
  publishedEvents: [],
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: ROOT,
  channelId: CH,
  threadRootId: null,
  authorId: MARTA,
  kind: "person",
  text: "The new layout is up.",
  createdAt: "2026-11-10T10:00:00.000Z",
  ...over,
});

function install(routes: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "tickets.create", "chat.channels.create"] } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, MARTA] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" },
        { id: MARTA, name: "Marta Rinaldi", initials: "MR", departmentIds: [DEPT_ID], email: "marta@example.com" },
      ],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/chat/channels": { body: { items: [channel()] } },
    [`GET /api/chat/channels/${CH}`]: { body: channel() },
    [`GET /api/chat/channels/${CH}/messages`]: { body: { items: [message()], before: null } },
    [`POST /api/chat/channels/${CH}/messages`]: { status: 201, body: message({ id: "7f1c2a1e-0000-4000-8000-0000000000d9", authorId: ME_ID, text: "Looks good" }) },
    [`POST /api/chat/channels/${CH}/read`]: { status: 204 },
    "GET /api/chat/threads": { body: { items: [] } },
    "GET /api/chat/mentions": { body: { items: [] } },
    "GET /api/chat/signal": { body: { hasNews: false, mentions: 0 } },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetChatStreams();
  forgetPeopleChatCaches();
  // Lo stream: un trasporto che non manda niente (le letture bastano qui).
  setChatStreamTransport(() => () => undefined);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  setChatStreamTransport(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la Chat nella build app", () => {
  it("la colonna: i canali del server; niente «New message», ricerca né messaggi diretti (fetta 2)", async () => {
    install();
    renderRoute("/chat");
    const column = await screen.findByRole("navigation", { name: "Chat views" });
    expect(await within(column).findByText("design")).toBeInTheDocument();
    expect(within(column).queryByRole("button", { name: "New message" })).toBeNull();
    expect(within(column).queryByText("Direct messages")).toBeNull();
    expect(within(column).queryByRole("searchbox")).toBeNull();
    expect(screen.queryByText("Coming soon")).toBeNull();
  });

  it("un canale: i messaggi del server; la casella manda il testo, senza allegati né opzioni", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("The new layout is up.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Message options" })).toBeNull();
    const box = await screen.findByRole("combobox", { name: /^Message/ });
    await ue.type(box, "Looks good");
    await ue.keyboard("{Enter}");
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).map((r) => r.body)).toEqual([
        { text: "Looks good" },
      ]),
    );
  });

  it("il menu di un messaggio: niente «Create task» né «Create request» (fetta 2)", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    await screen.findByText("The new layout is up.");
    await ue.click(screen.getAllByRole("button", { name: "More actions" })[0]!);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Create task")).toBeNull();
    expect(within(menu).queryByText("Create request")).toBeNull();
  });

  it("⌘N non apre un messaggio diretto", async () => {
    install();
    const ue = userEvent.setup();
    const router = renderRoute("/chat");
    await screen.findByRole("navigation", { name: "Chat views" });
    await ue.keyboard("{Meta>}n{/Meta}");
    await ue.keyboard("{Control>}n{/Control}");
    expect((router.state.location.search as { newMessage?: string }).newMessage).toBeUndefined();
  });

  describe("un canale lungo (review della fetta 1)", () => {
    // 260 radici: la pagina più nuova ne dà 200 (il massimo del server) col
    // cursore, la più vecchia le altre 60.
    const id = (i: number) => `7f1c2a1e-0000-4000-8000-${String(100000000000 + i)}`;
    const roots = Array.from({ length: 260 }, (_, i) =>
      message({ id: id(i), text: `Message ${i}`, createdAt: new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString() }),
    );
    const pages = (fail = false) => ({
      [`GET /api/chat/channels/${CH}/messages`]: ({ path }: SeenRequest) => {
        const limit = Number(new URL(`http://x${path}`).searchParams.get("limit") ?? "50");
        if (limit > 200) return { status: 400, body: { code: "invalid", message: "limit" } };
        if (path.includes("before=old")) return fail ? { status: 500, body: { code: "x", message: "x" } } : { body: { items: roots.slice(0, 60), before: null } };
        return { body: { items: roots.slice(260 - Math.min(limit, 200)), before: "old" } };
      },
      [`GET /api/chat/messages/${id(0)}`]: { body: roots[0] },
    });

    it("una menzione della radice più vecchia: si arriva fino a lei, col cursore del server e mai oltre 200 per pagina", async () => {
      install(pages());
      renderRoute(`/chat/${CH}?message=${id(0)}`);
      expect(await screen.findByText("Message 0", {}, { timeout: 4000 })).toBeInTheDocument();
      const reads = seen.filter((r) => r.path.startsWith(`/api/chat/channels/${CH}/messages`));
      expect(reads.every((r) => Number(new URL(`http://x${r.path}`).searchParams.get("limit") ?? "50") <= 200)).toBe(true);
      expect(reads.some((r) => r.path.includes("before=old"))).toBe(true);
    });

    it("se la pagina più vecchia non arriva, ci si ferma e lo si dice: nessun giro infinito", async () => {
      install(pages(true));
      renderRoute(`/chat/${CH}?message=${id(0)}`);
      expect(await screen.findByText("Couldn't load messages", {}, { timeout: 4000 })).toBeInTheDocument();
      const before = seen.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.filter((r) => r.path.includes("before=old")).length).toBeLessThanOrEqual(2);
      expect(seen.length - before).toBeLessThan(5);
    });
  });

  it("troppi stream aperti nella finestra: il canale lo dice, i messaggi letti restano", async () => {
    install();
    setChatStreamTransport((_path, handlers) => {
      queueMicrotask(() => handlers.onClose({ fatal: true, limit: true }));
      return () => undefined;
    });
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("The new layout is up.")).toBeInTheDocument();
    expect(await screen.findByText(/Too many live views are open in this window/)).toBeInTheDocument();
  });

  it("«@Claude» scritto a mano non apre il thread (Claude nei canali è della fetta 3)", async () => {
    install({
      [`POST /api/chat/channels/${CH}/messages`]: {
        status: 201,
        body: message({ id: "7f1c2a1e-0000-4000-8000-0000000000d8", authorId: ME_ID, text: "@Claude summarize" }),
      },
    });
    const ue = userEvent.setup();
    const router = renderRoute(`/chat/${CH}`);
    const box = await screen.findByRole("combobox", { name: /^Message/ });
    await ue.type(box, "@Claude summarize");
    await ue.keyboard("{Escape}{Enter}");
    await waitFor(() => expect(seen.some((r) => r.method === "POST" && r.path.endsWith("/messages"))).toBe(true));
    await new Promise((r) => setTimeout(r, 100));
    expect((router.state.location.search as { thread?: string }).thread).toBeUndefined();
  });
});
