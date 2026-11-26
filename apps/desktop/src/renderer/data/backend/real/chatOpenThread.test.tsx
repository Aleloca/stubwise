import { screen, waitFor } from "@testing-library/react";
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
} from "./fakeServer";

// «Apri il thread» dopo un invio nella build app (review della fetta 1 della
// Chat): `openHref` confrontava chi scrive con la sessione del prototipo, che
// nella build app è vuota, e non navigava mai.
vi.mock("@backend/api", async () => await import("./index"));
// `chat-claude` è acceso nella build app (fetta 3): si prova che «apri il
// thread» dopo un invio usi la persona vera (`openHref`), non la sessione del prototipo.

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const MARTA = "55555555-5555-4555-8555-555555555555";

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
  installFakeServer({
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
  } as Parameters<typeof installFakeServer>[0]);
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

describe("apri il thread dopo un invio, nella build app", () => {
  it("dopo un «@Claude» il pannello del thread si apre (la persona è quella vera)", async () => {
    const SENT = "7f1c2a1e-0000-4000-8000-0000000000d8";
    install({
      [`POST /api/chat/channels/${CH}/messages`]: { status: 201, body: message({ id: SENT, authorId: ME_ID, text: "@Claude summarize" }) },
      [`GET /api/chat/messages/${SENT}/thread`]: {
        body: { root: message({ id: SENT, authorId: ME_ID, text: "@Claude summarize" }), replies: [], lastReadAt: null },
      },
      [`GET /api/chat/messages/${SENT}`]: { body: message({ id: SENT, authorId: ME_ID, text: "@Claude summarize" }) },
    });
    const ue = userEvent.setup();
    const router = renderRoute(`/chat/${CH}`);
    const box = await screen.findByRole("combobox", { name: /^Message/ });
    await ue.type(box, "@Claude summarize");
    await ue.keyboard("{Escape}{Enter}");
    await waitFor(() => expect((router.state.matches.at(-1)!.search as { thread?: string }).thread).toBe(SENT));
  });
});
