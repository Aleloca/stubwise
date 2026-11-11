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
  serverTask,
  type SeenRequest,
} from "./fakeServer";

// La Chat fra persone nelle pagine della build app (area 4, fette 1 e 2), sulle
// rotte del server. Ciò che è della fetta 4 (allegati, eventi) non compare;
// @Claude (fetta 3) sta in `chatClaudePage.test.tsx`.
vi.mock("@backend/api", async () => await import("./index"));

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const MARTA = "55555555-5555-4555-8555-555555555555";
const DM = "7f1c2a1e-0000-4000-8000-0000000000e0";
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
  it("la colonna: i canali del server, «New message», la ricerca e i messaggi diretti (fetta 2)", async () => {
    install({
      "GET /api/chat/channels": {
        body: { items: [channel(), channel({ id: DM, kind: "dm", projectId: null, name: "", memberIds: [ME_ID, MARTA] })] },
      },
    });
    renderRoute("/chat");
    const column = await screen.findByRole("navigation", { name: "Chat views" });
    expect(await within(column).findByText("design")).toBeInTheDocument();
    expect(within(column).getByRole("button", { name: "New message" })).toBeInTheDocument();
    expect(within(column).getByText("Direct messages")).toBeInTheDocument();
    expect(await within(column).findByText("Marta Rinaldi")).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
  });

  it("un canale: la casella manda il testo e la domanda («Ask for a reply»); gli allegati ci sono (fetta 4)", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("The new layout is up.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
    await ue.click(screen.getByRole("button", { name: "Message options" }));
    await ue.click(await screen.findByText("Ask for a reply"));
    const box = await screen.findByRole("combobox", { name: /^Message/ });
    await ue.type(box, "Looks good");
    await ue.keyboard("{Enter}");
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).map((r) => r.body)).toEqual([
        { text: "Looks good", asksReply: true },
      ]),
    );
  });

  it("il menu di un messaggio: «Create task» crea la task dal messaggio (chatMessageId)", async () => {
    install({ "POST /api/tasks": { status: 201, body: serverTask({ title: "The new layout is up." }) } });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    await screen.findByText("The new layout is up.");
    await ue.click(screen.getAllByRole("button", { name: "More actions" })[0]!);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Create request")).toBeInTheDocument();
    await ue.click(within(menu).getByText("Create task"));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await ue.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(seen.find((r) => r.method === "POST" && r.path === "/api/tasks")?.body).toMatchObject({ chatMessageId: ROOT }),
    );
  });

  it("⌘N apre «New message»; scegliere una persona apre il DM sul server", async () => {
    install({ "POST /api/chat/dm": { body: channel({ id: DM, kind: "dm", projectId: null, name: "", memberIds: [ME_ID, MARTA] }) } });
    const ue = userEvent.setup();
    renderRoute("/chat");
    await screen.findByRole("navigation", { name: "Chat views" });
    await ue.click(screen.getByRole("button", { name: "New message" }));
    const dialog = await screen.findByRole("dialog", { name: "New message" });
    const list = within(dialog).getByRole("list", { name: "To" });
    await waitFor(() => expect(list.querySelector(`[data-person-option="${MARTA}"]`)).not.toBeNull());
    await ue.click(list.querySelector(`[data-person-option="${MARTA}"]`)!);
    await ue.click(within(dialog).getByRole("button", { name: /Start conversation|Open conversation/ }));
    await waitFor(() =>
      expect(seen.find((r) => r.method === "POST" && r.path === "/api/chat/dm")?.body).toEqual({ personIds: [MARTA] }),
    );
  });

  it("«New channel»: privato e canale dell'azienda si possono scegliere (fetta 2)", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}?newChannel=1`);
    await screen.findByRole("dialog", { name: "New channel" });
    // Il dialogo si ri-renderizza mentre legge i progetti: si cerca sullo schermo di adesso.
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Private/ })).toBeInTheDocument());
    void ue;
  });

  it("un messaggio con una citazione: il codice si apre, come lo vede chi guarda (F2.7)", async () => {
    const TASK = "7f1c2a1e-0000-4000-8000-0000000000f1";
    install({
      [`GET /api/chat/channels/${CH}/messages`]: {
        body: {
          items: [message({ text: "Have a look at AUD-14", citations: [{ kind: "task", id: TASK, label: "AUD-14", projectId: PROJECT_ID }] })],
          before: null,
        },
      },
    });
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByRole("link", { name: /AUD-14/ }, { timeout: 3000 })).toHaveAttribute("href", "#/p/AUD/tasks?task=AUD-14");
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

  it("Modifica ed Elimina di un messaggio seguono canEdit e canDelete del server", async () => {
    const MINE = "7f1c2a1e-0000-4000-8000-0000000000d7";
    install({
      [`GET /api/chat/channels/${CH}/messages`]: {
        body: {
          items: [
            message({ canEdit: false, canDelete: true }),
            message({ id: MINE, authorId: ME_ID, text: "My note", createdAt: "2026-11-10T10:01:00.000Z", canEdit: false, canDelete: false }),
          ],
          before: null,
        },
      },
    });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    await screen.findByText("My note");
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-message="${id}"]`)!;
    await ue.click(within(row(MINE)).getByRole("button", { name: "More actions" }));
    let menu = screen.getByRole("menu", { name: "Message actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull();
    await ue.keyboard("{Escape}");
    await ue.click(within(row(ROOT)).getByRole("button", { name: "More actions" }));
    menu = screen.getByRole("menu", { name: "Message actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("in un canale archiviato i flag falsi del server spengono Modifica ed Elimina anche sui propri messaggi", async () => {
    const MINE = "7f1c2a1e-0000-4000-8000-0000000000d7";
    const archived = channel({ archived: true, canWrite: false });
    install({
      "GET /api/chat/channels": { body: { items: [archived] } },
      [`GET /api/chat/channels/${CH}`]: { body: archived },
      [`GET /api/chat/channels/${CH}/messages`]: {
        body: {
          items: [message({ id: MINE, authorId: ME_ID, text: "My note", canEdit: false, canDelete: false })],
          before: null,
        },
      },
    });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    await screen.findByText("My note");
    const row = document.querySelector<HTMLElement>(`[data-message="${MINE}"]`)!;
    await ue.click(within(row).getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu", { name: "Message actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("la ricerca: i messaggi dal server, coi canali che chi guarda legge (fetta 2)", async () => {
    install({
      "GET /api/chat/search": { body: { items: [{ channelId: CH, message: message({ text: "Export the PDF" }), context: null, root: null }] } },
    });
    renderRoute("/chat?view=search&q=export");
    const results = await screen.findByRole("region", { name: "Search results" }, { timeout: 3000 });
    await waitFor(() => expect(results).toHaveTextContent("Export the PDF"));
    expect(seen.some((r) => r.path.startsWith("/api/chat/search?q=export"))).toBe(true);
  });

  it("il salto a un messaggio vecchio continua dal cursore dell'ultima pagina, senza rileggere le più nuove", async () => {
    const OLD = "7f1c2a1e-0000-4000-8000-0000000000a9";
    const old = message({ id: OLD, text: "The first sketch.", createdAt: "2026-11-01T10:00:00.000Z" });
    install({
      [`GET /api/chat/channels/${CH}/messages`]: (req: SeenRequest) => {
        const before = new URL(`http://x${req.path}`).searchParams.get("before");
        return before === "cur1"
          ? { body: { items: [old], before: null } }
          : { body: { items: [message()], before: "cur1" } };
      },
      [`GET /api/chat/messages/${OLD}`]: { body: old },
    });
    renderRoute(`/chat/${CH}?message=${OLD}`);
    expect(await screen.findByText("The first sketch.", {}, { timeout: 3000 })).toBeInTheDocument();
    const pages = seen
      .filter((r) => r.method === "GET" && r.path.startsWith(`/api/chat/channels/${CH}/messages`))
      .map((r) => new URL(`http://x${r.path}`).searchParams.get("before"));
    expect(pages).toEqual([null, "cur1"]);
  });

  it("una ripresa dello stream senza cursore rilegge tutte le pagine del canale, non solo l'ultima", async () => {
    const handlers: { onFrame: (f: unknown) => void; onClose: (e: unknown) => void }[] = [];
    setChatStreamTransport((_path, h) => {
      handlers.push(h as never);
      return () => undefined;
    });
    const OLD = "7f1c2a1e-0000-4000-8000-0000000000a9";
    const old = message({ id: OLD, text: "The first sketch.", createdAt: "2026-11-01T10:00:00.000Z" });
    install({
      [`GET /api/chat/channels/${CH}/messages`]: (req: SeenRequest) => {
        const before = new URL(`http://x${req.path}`).searchParams.get("before");
        return before === "cur1"
          ? { body: { items: [old], before: null } }
          : { body: { items: [message()], before: "cur1" } };
      },
      [`GET /api/chat/messages/${OLD}`]: { body: old },
    });
    renderRoute(`/chat/${CH}?message=${OLD}`);
    expect(await screen.findByText("The first sketch.", {}, { timeout: 3000 })).toBeInTheDocument();
    const pages = () =>
      seen
        .filter((r) => r.method === "GET" && r.path.startsWith(`/api/chat/channels/${CH}/messages`))
        .map((r) => new URL(`http://x${r.path}`).searchParams.get("before"));
    await waitFor(() => expect(handlers).toHaveLength(1));
    const before = pages().length;
    // Cade prima di ogni frame (nessun cursore), poi riparte e manda il primo frame.
    handlers[0]!.onClose({ fatal: false });
    await waitFor(() => expect(handlers).toHaveLength(2), { timeout: 3000 });
    handlers[1]!.onFrame({ messages: [], cursor: "7", real: true });
    // Tutte e due le pagine lette, non solo la più nuova.
    await waitFor(() => expect(pages().slice(before)).toEqual([null, "cur1"]), { timeout: 3000 });
  });

  it("una risposta nel thread «anche nel canale» (fetta 2)", async () => {
    install({
      [`GET /api/chat/messages/${ROOT}/thread`]: { body: { root: message({ replyCount: 0 }), replies: [], lastReadAt: null } },
      [`GET /api/chat/messages/${ROOT}`]: { body: message() },
    });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const also = await screen.findByRole("checkbox", { name: /^Also send to/ }, { timeout: 3000 });
    await ue.click(also);
    const reply = await screen.findByRole("combobox", { name: "Reply…" });
    await ue.type(reply, "Done");
    await ue.keyboard("{Enter}");
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).map((r) => r.body)).toEqual([
        { text: "Done", threadRootId: ROOT, alsoInChannel: true },
      ]),
    );
  });
});
