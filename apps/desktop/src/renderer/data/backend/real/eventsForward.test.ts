import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { chat, forgetPeopleChatCaches } from "./chat";
import { readEvents } from "./claude";
import { pollingTransport } from "./claudeStream";
import { installFakeServer, me, ME_ID, serverProject } from "./fakeServer";
import { getSessionPerson } from "./session";

// Review della fetta 3, punto 4: gli eventi di una sessione si leggono IN
// AVANTI dall'inizio (`after: "0"`). Senza cursore il server dà gli ultimi N:
// oltre i 500 i primi si perdevano. Vale per le righe di @Claude nella Chat,
// per il dettaglio di una conversazione e per il ripiego senza stream.

const SESSION = "7f1c2a1e-0000-4000-8000-0000000000f1";
const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const REPLY = "7f1c2a1e-0000-4000-8000-0000000000d2";
const TOTAL = 600;

const event = (n: number) => ({
  id: String(n),
  type: "tool_use",
  segmentId: "s1",
  at: "2026-11-10T10:00:01.000Z",
  data: { toolUseId: `t${n}`, name: "mcp__stubwise_chat__search_tasks", input: { q: String(n) } },
});
const ALL = Array.from({ length: TOTAL }, (_, i) => event(i + 1));

/** Come il server: con `after` in avanti da lì; senza, gli ULTIMI `limit`. */
const eventsRoute = (req: { path: string }) => {
  const q = new URL(`http://x${req.path}`).searchParams;
  const limit = Number(q.get("limit") ?? 100);
  const after = q.get("after");
  const events = after === null ? ALL.slice(-limit) : ALL.filter((e) => Number(e.id) > Number(after)).slice(0, limit);
  return { body: { events, before: null } };
};

beforeEach(() => {
  setAppClientForTests(null);
  forgetPeopleChatCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("gli eventi di una sessione, in avanti dall'inizio", () => {
  it("il dettaglio di una conversazione (`readEvents`): tutti, in ordine", async () => {
    installFakeServer({ "GET /api/auth/me": { body: me() }, [`GET /api/agent-sessions/${SESSION}/events`]: eventsRoute });
    const events = await readEvents(SESSION);
    expect(events.map((e) => e.id)).toEqual(ALL.map((e) => e.id));
  });

  it("le righe di @Claude nella Chat: tutte, dalla prima", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
      [`GET /api/agent-sessions/${SESSION}/events`]: eventsRoute,
      [`GET /api/chat/messages/${ROOT}/thread`]: {
        body: {
          root: { id: ROOT, channelId: CH, threadRootId: null, authorId: ME_ID, text: "@Claude", createdAt: "2026-11-10T10:00:00.000Z", replyCount: 1 },
          replies: [
            {
              id: REPLY,
              channelId: CH,
              threadRootId: ROOT,
              authorId: null,
              kind: "claude",
              calledById: ME_ID,
              text: "",
              createdAt: "2026-11-10T10:00:05.000Z",
              claude: { state: "done", sessionId: SESSION },
            },
          ],
        },
      },
    });
    await getSessionPerson();
    const m = (await chat.listThread(ROOT))!.replies[0]!;
    const actions = (m.claudeEvents ?? []).filter((e) => e.type === "action");
    expect(actions).toHaveLength(TOTAL);
    expect(actions[0]).toMatchObject({ input: expect.stringContaining('"1"') });
  });

  it("il ripiego senza stream: si parte dall'inizio (`after=0`), non dagli ultimi", async () => {
    const { seen } = installFakeServer({
      [`GET /api/agent-sessions/${SESSION}/events`]: eventsRoute,
      [`GET /api/agent-sessions/${SESSION}`]: { body: { id: SESSION } },
    });
    const stop = pollingTransport(`/api/agent-sessions/${SESSION}/stream`, {
      onFrame: () => undefined,
      onClose: () => undefined,
    });
    await vi.waitFor(() => expect(seen.some((r) => r.path.includes("/events"))).toBe(true));
    stop();
    expect(seen.find((r) => r.path.includes("/events"))!.path).toContain("after=0");
  });
});
