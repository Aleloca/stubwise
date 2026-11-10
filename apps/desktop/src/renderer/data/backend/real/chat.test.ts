import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { chat, forgetPeopleChatCaches } from "./chat";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";
import { getSessionPerson } from "./session";

// La Chat fra persone nella build app (integrazione area 4, fetta 1): le viste
// del server (`/api/chat`, schemi della F1.1, rotte della F1.2) nella forma del
// prototipo. Chi vede, chi scrive e chi gestisce lo dice il server.

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const GENERAL = "7f1c2a1e-0000-4000-8000-0000000000c0";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const REPLY = "7f1c2a1e-0000-4000-8000-0000000000d2";
const MARTA = "55555555-5555-4555-8555-555555555555";

const channel = (over: Record<string, unknown> = {}) => ({
  id: CH,
  kind: "project",
  projectId: PROJECT_ID,
  name: "design",
  description: "Design reviews",
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
  unread: 2,
  mentions: 1,
  level: "all",
  lastMessageAt: "2026-11-10T10:00:00.000Z",
  publishedEvents: [],
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: ROOT,
  channelId: CH,
  threadRootId: null,
  authorId: MARTA,
  kind: "person",
  calledById: null,
  text: "@Ada can you look?",
  createdAt: "2026-11-10T10:00:00.000Z",
  editedAt: null,
  deleted: false,
  deletedBy: null,
  reactions: [{ emoji: "👍", personIds: [ME_ID] }],
  replyCount: 1,
  lastReplyAt: "2026-11-10T10:05:00.000Z",
  following: true,
  mentionedIds: [ME_ID],
  canEdit: false,
  canDelete: false,
  viaClaude: false,
  ...over,
});

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

function install(routes: Record<string, unknown> = {}) {
  return installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, MARTA] })] },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

describe("canali", () => {
  it("la lista di un progetto: i permessi del server nella forma del prototipo, i non letti e le menzioni", async () => {
    const { seen } = install({
      "GET /api/chat/channels": {
        body: { items: [channel(), channel({ id: GENERAL, name: "general", isGeneral: true, canLeave: false, canManage: false })] },
      },
    });
    await getSessionPerson();
    const rows = await chat.listChannels({ scope: "project", projectId: PROJECT_ID });
    expect(seen.map((r) => r.path)).toContain(`/api/chat/channels?projectId=${PROJECT_ID}`);
    expect(rows[0]).toMatchObject({
      id: CH,
      kind: "project",
      name: "design",
      createdById: MARTA,
      archivedById: null,
      canRead: true,
      isMember: true,
      canWrite: true,
      canLeave: true,
      canEditInfo: false,
      canArchive: false,
      canDelete: false,
      // Fuori dalla fetta 1: inviti, rimozioni, eventi.
      canInvite: false,
      canRemove: false,
      canEditEvents: false,
      notifyLevel: "all",
      unread: 2,
      mentions: 1,
      lastActivityAt: "2026-11-10T10:00:00.000Z",
    });
    expect(rows[1]).toMatchObject({ isGeneral: true, canLeave: false });
  });

  it("chi gestisce (canManage) rinomina, cambia l'argomento, archivia ed elimina", async () => {
    install({ [`GET /api/chat/channels/${CH}`]: { body: channel({ canManage: true }) } });
    await getSessionPerson();
    expect(await chat.getChannel(CH)).toMatchObject({ canEditInfo: true, canEditTopic: true, canArchive: true, canDelete: true });
  });

  it("un canale che non si vede (404): null, come uno che non esiste", async () => {
    install({ [`GET /api/chat/channels/${CH}`]: { status: 404, body: { code: "not_found", message: "x" } } });
    await getSessionPerson();
    expect(await chat.getChannel(CH)).toBeNull();
  });

  it("i membri dai memberIds del canale, col creatore", async () => {
    install({ [`GET /api/chat/channels/${CH}`]: { body: channel() } });
    await getSessionPerson();
    expect(await chat.listChannelMembers(CH)).toEqual([
      { personId: ME_ID, isCreator: false },
      { personId: MARTA, isCreator: true },
    ]);
  });

  it("crea, rinomina, archivia, elimina, entra, esce, la preferenza: le rotte e i corpi", async () => {
    const { seen } = install({
      "POST /api/chat/channels": { status: 201, body: channel({ canManage: true }) },
      [`PATCH /api/chat/channels/${CH}`]: { body: channel({ canManage: true }) },
      [`DELETE /api/chat/channels/${CH}`]: { status: 204 },
      [`POST /api/chat/channels/${CH}/join`]: { body: channel() },
      [`DELETE /api/chat/channels/${CH}/join`]: { body: channel({ isMember: false }) },
      [`PUT /api/chat/channels/${CH}/pref`]: { body: channel({ level: "muted" }) },
    });
    await getSessionPerson();
    await chat.createChannel({ projectId: PROJECT_ID, name: "Design", visibility: "open", description: "Reviews" });
    await chat.updateChannel(CH, { name: "design-2", topic: "Q4" });
    await chat.archiveChannel(CH, true);
    await chat.deleteChannel(CH);
    await chat.joinChannel(CH);
    await chat.leaveChannel(CH);
    await chat.setNotifyLevel(CH, "muted");
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", "/api/chat/channels", { projectId: PROJECT_ID, name: "Design", description: "Reviews" }],
      ["PATCH", `/api/chat/channels/${CH}`, { name: "design-2", topic: "Q4" }],
      ["PATCH", `/api/chat/channels/${CH}`, { archived: true }],
      ["DELETE", `/api/chat/channels/${CH}`, undefined],
      ["POST", `/api/chat/channels/${CH}/join`, undefined],
      ["DELETE", `/api/chat/channels/${CH}/join`, undefined],
      ["PUT", `/api/chat/channels/${CH}/pref`, { level: "muted" }],
    ]);
  });

  it("i rifiuti del server negli errori del prototipo", async () => {
    install({
      "POST /api/chat/channels": { status: 409, body: { code: "name_taken", message: "x" } },
      [`PATCH /api/chat/channels/${GENERAL}`]: { status: 409, body: { code: "general_channel", message: "x" } },
      [`DELETE /api/chat/channels/${CH}`]: { status: 403, body: { code: "forbidden", message: "x" } },
    });
    await getSessionPerson();
    await expect(chat.createChannel({ projectId: PROJECT_ID, name: "design", visibility: "open" })).rejects.toThrow("invalid: name_taken");
    await expect(chat.archiveChannel(GENERAL, true)).rejects.toThrow("invalid: general");
    await expect(chat.deleteChannel(CH)).rejects.toThrow("forbidden");
    // Fuori dalla fetta 1: privati e canali generali, senza chiamare il server.
    await expect(chat.createChannel({ projectId: PROJECT_ID, name: "x", visibility: "private" })).rejects.toThrow("invalid: visibility");
    await expect(chat.createChannel({ projectId: null, name: "x", visibility: "open" })).rejects.toThrow("invalid: visibility");
  });
});

describe("messaggi", () => {
  it("la pagina del canale: le radici col riepilogo del thread, le reazioni, chi è nominato; «altri» col cursore del server", async () => {
    const { seen } = install({
      [`GET /api/chat/channels/${CH}`]: { body: channel() },
      [`GET /api/chat/channels/${CH}/messages`]: ({ path }: { path: string }) =>
        path.includes("before=")
          ? { body: { items: [], before: null } }
          : { body: { items: [message()], before: "cursor-1" } },
    });
    await getSessionPerson();
    const page = (await chat.listMessages(CH))!;
    expect(page.hasMore).toBe(true);
    expect(page.messages[0]).toMatchObject({
      id: ROOT,
      channelId: CH,
      threadOf: null,
      authorId: MARTA,
      text: "@Ada can you look?",
      reactions: [{ emoji: "👍", personIds: [ME_ID] }],
      mentionsViewer: true,
      deletedAt: null,
      attachments: [],
      citations: [],
      linkedCodes: [],
      thread: { replyCount: 1, lastReplyAt: "2026-11-10T10:05:00.000Z", following: true },
    });
    await chat.listMessages(CH, { before: ROOT });
    expect(seen.map((r) => r.path)).toContain(`/api/chat/channels/${CH}/messages?before=cursor-1`);
  });

  it("un messaggio eliminato: niente testo, eliminato", async () => {
    install({
      [`GET /api/chat/channels/${CH}`]: { body: channel() },
      [`GET /api/chat/channels/${CH}/messages`]: { body: { items: [message({ text: "", deleted: true, deletedBy: MARTA, replyCount: 0 })] } },
    });
    await getSessionPerson();
    const [m] = (await chat.listMessages(CH))!.messages;
    expect(m).toMatchObject({ text: "", deletedById: MARTA, thread: null });
    expect(m!.deletedAt).not.toBeNull();
  });

  it("il thread: la radice e le risposte; un messaggio per id è un risultato col suo canale", async () => {
    install({
      [`GET /api/chat/messages/${REPLY}/thread`]: {
        body: { root: message(), replies: [message({ id: REPLY, threadRootId: ROOT, text: "Sure", replyCount: 0 })] },
      },
      [`GET /api/chat/messages/${REPLY}`]: { body: message({ id: REPLY, threadRootId: ROOT, text: "Sure", replyCount: 0 }) },
    });
    await getSessionPerson();
    const thread = (await chat.listThread(REPLY))!;
    expect(thread).toMatchObject({ channelId: CH, root: { id: ROOT }, replies: [{ id: REPLY, threadOf: ROOT }] });
    expect(await chat.getMessage(REPLY)).toMatchObject({ channelId: CH, message: { id: REPLY, threadOf: ROOT } });
  });

  it("invia (anche nel thread), modifica, elimina, reazione, follow, letto: le rotte e i corpi", async () => {
    const { seen } = install({
      [`POST /api/chat/channels/${CH}/messages`]: { status: 201, body: message({ id: REPLY, threadRootId: ROOT, authorId: ME_ID }) },
      [`PATCH /api/chat/messages/${REPLY}`]: { body: message({ id: REPLY, text: "Edited" }) },
      [`DELETE /api/chat/messages/${REPLY}`]: { status: 204 },
      [`POST /api/chat/messages/${ROOT}/reactions/toggle`]: { body: message() },
      [`PUT /api/chat/messages/${ROOT}/follow`]: { body: message({ following: false }) },
      [`POST /api/chat/channels/${CH}/read`]: { status: 204 },
      [`GET /api/chat/messages/${ROOT}`]: { body: message() },
    });
    await getSessionPerson();
    await chat.sendMessage(CH, { text: "Sure", threadOf: ROOT });
    await chat.editMessage(REPLY, "Edited");
    await chat.deleteMessage(REPLY);
    await chat.toggleReaction(ROOT, "👍");
    await chat.setThreadFollow(ROOT, false);
    await chat.markRead(CH);
    await chat.markThreadRead(ROOT);
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", `/api/chat/channels/${CH}/messages`, { text: "Sure", threadRootId: ROOT }],
      ["PATCH", `/api/chat/messages/${REPLY}`, { text: "Edited" }],
      ["DELETE", `/api/chat/messages/${REPLY}`, undefined],
      ["POST", `/api/chat/messages/${ROOT}/reactions/toggle`, { emoji: "👍" }],
      ["PUT", `/api/chat/messages/${ROOT}/follow`, { following: false }],
      ["POST", `/api/chat/channels/${CH}/read`, {}],
      ["POST", `/api/chat/channels/${CH}/read`, { threadRootId: ROOT }],
    ]);
  });

  it("i rifiuti del server: non tuo, canale archiviato, non membro", async () => {
    install({
      [`PATCH /api/chat/messages/${ROOT}`]: { status: 403, body: { code: "not_yours", message: "x" } },
      [`POST /api/chat/channels/${CH}/messages`]: { status: 409, body: { code: "channel_archived", message: "x" } },
      [`DELETE /api/chat/messages/${ROOT}`]: { status: 409, body: { code: "deleted", message: "x" } },
    });
    await getSessionPerson();
    await expect(chat.editMessage(ROOT, "x")).rejects.toThrow("forbidden");
    await expect(chat.sendMessage(CH, { text: "x" })).rejects.toThrow("invalid: archived");
    await expect(chat.deleteMessage(ROOT)).rejects.toThrow("invalid: deleted");
  });
});

describe("le viste di chi guarda", () => {
  it("Threads, Mentions e il punto del binario", async () => {
    install({
      "GET /api/chat/threads": { body: { items: [{ root: message(), unreadReplies: 2 }] } },
      "GET /api/chat/mentions": { body: { items: [message()] } },
      "GET /api/chat/signal": { body: { hasNews: true, mentions: 1 } },
    });
    await getSessionPerson();
    expect(await chat.listThreadsWithNews()).toMatchObject([{ channelId: CH, root: { id: ROOT }, newCount: 2, latestReplies: [] }]);
    expect(await chat.listMentions()).toMatchObject([{ channelId: CH, message: { id: ROOT, mentionsViewer: true } }]);
    expect(await chat.hasNews()).toBe(true);
  });

  it("le funzioni delle fette dopo restano «non integrate»", async () => {
    await expect(chat.openDm([MARTA])).rejects.toThrow();
  });
});
