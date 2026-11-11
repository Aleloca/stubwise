import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { chat, forgetPeopleChatCaches } from "./chat";
import { resolveCitations } from "./claudeChat";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTask } from "./fakeServer";
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

  it("chi gestisce rinomina, cambia l'argomento, archivia ed elimina: i permessi del server, uno per uno (fetta 2)", async () => {
    install({
      [`GET /api/chat/channels/${CH}`]: {
        body: channel({ canManage: true, canEditInfo: true, canEditTopic: true, canArchive: true, canDelete: true }),
      },
    });
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
      ["POST", "/api/chat/channels", { projectId: PROJECT_ID, name: "Design", visibility: "open", description: "Reviews" }],
      ["PATCH", `/api/chat/channels/${CH}`, { name: "design-2", topic: "Q4" }],
      ["PATCH", `/api/chat/channels/${CH}`, { archived: true }],
      ["DELETE", `/api/chat/channels/${CH}`, undefined],
      ["POST", `/api/chat/channels/${CH}/join`, undefined],
      ["DELETE", `/api/chat/channels/${CH}/join`, undefined],
      ["PUT", `/api/chat/channels/${CH}/pref`, { level: "muted" }],
    ]);
  });

  it("un nome di canale che il server rifiuta (400) è «invalid: name», come nel dialogo", async () => {
    install({
      "POST /api/chat/channels": { status: 400, body: { code: "validation_error", message: "name" } },
      [`PATCH /api/chat/channels/${CH}`]: { status: 400, body: { message: "name" } },
    });
    await getSessionPerson();
    await expect(chat.createChannel({ projectId: PROJECT_ID, name: "!!", visibility: "open" })).rejects.toThrow("invalid: name");
    await expect(chat.updateChannel(CH, { name: "!!" })).rejects.toThrow("invalid: name");
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
    expect(seen.map((r) => r.path)).toContain(`/api/chat/channels/${CH}/messages?before=cursor-1&limit=50`);
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
    await expect(chat.completeEditedChatProposal(ROOT, "p", [])).rejects.toThrow();
  });
});

describe("fetta 2: DM, privati, generali, domande, ricerca, da un messaggio", () => {
  const DM = "7f1c2a1e-0000-4000-8000-0000000000e0";
  const PRIVATE = "7f1c2a1e-0000-4000-8000-0000000000e1";
  const TASK = "7f1c2a1e-0000-4000-8000-0000000000f1";

  it("i permessi del canale sono quelli del server, uno per uno; un privato visto da chi gestisce non si legge", async () => {
    install({
      [`GET /api/chat/channels/${PRIVATE}`]: {
        body: channel({
          id: PRIVATE,
          visibility: "private",
          isMember: false,
          canRead: false,
          canManage: true,
          canEditInfo: true,
          canEditTopic: false,
          canInvite: true,
          canRemove: true,
          canArchive: true,
          canDelete: false,
          topic: "",
          description: "",
        }),
      },
    });
    await getSessionPerson();
    expect(await chat.getChannel(PRIVATE)).toMatchObject({
      visibility: "private",
      canRead: false,
      canEditInfo: true,
      canEditTopic: false,
      canInvite: true,
      canRemove: true,
      canArchive: true,
      canDelete: false,
    });
  });

  it("un messaggio: «anche nel canale», chi deve rispondere, i codici di ciò che ne è nato", async () => {
    install({
      [`GET /api/chat/messages/${REPLY}`]: {
        body: message({
          id: REPLY,
          threadRootId: ROOT,
          alsoInChannel: true,
          asksReplyOf: [ME_ID],
          linked: [{ kind: "task", id: TASK, code: "AUD-14" }],
          linkedCodes: ["AUD-14"],
        }),
      },
    });
    await getSessionPerson();
    expect((await chat.getMessage(REPLY))!.message).toMatchObject({
      alsoInChannel: true,
      asksReplyOf: [ME_ID],
      linkedCodes: ["AUD-14"],
      linkedRefs: [{ kind: "task", id: TASK }],
    });
  });

  it("invio con «anche nel canale» e la domanda; un canale generale o privato coi membri; DM, inviti, rimozioni", async () => {
    const { seen } = install({
      [`POST /api/chat/channels/${CH}/messages`]: { status: 201, body: message() },
      "POST /api/chat/channels": { status: 201, body: channel() },
      "POST /api/chat/dm": { body: channel({ id: DM, kind: "dm", projectId: null }) },
      [`POST /api/chat/channels/${PRIVATE}/members`]: { body: channel({ id: PRIVATE }) },
      [`DELETE /api/chat/channels/${PRIVATE}/members/${MARTA}`]: { body: channel({ id: PRIVATE }) },
    });
    await getSessionPerson();
    await chat.sendMessage(CH, { text: "Sure?", threadOf: ROOT, alsoInChannel: true, asksReply: true });
    await chat.createChannel({ projectId: null, name: "announcements", visibility: "open" });
    await chat.createChannel({ projectId: PROJECT_ID, name: "leads", visibility: "private", memberIds: [MARTA] });
    expect(await chat.openDm([MARTA])).toMatchObject({ id: DM, kind: "dm" });
    await chat.inviteMembers(PRIVATE, [MARTA]);
    await chat.removeMember(PRIVATE, MARTA);
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", `/api/chat/channels/${CH}/messages`, { text: "Sure?", threadRootId: ROOT, alsoInChannel: true, asksReply: true }],
      ["POST", "/api/chat/channels", { projectId: null, name: "announcements", visibility: "open" }],
      ["POST", "/api/chat/channels", { projectId: PROJECT_ID, name: "leads", visibility: "private", memberIds: [MARTA] }],
      ["POST", "/api/chat/dm", { personIds: [MARTA] }],
      ["POST", `/api/chat/channels/${PRIVATE}/members`, { personIds: [MARTA] }],
      ["DELETE", `/api/chat/channels/${PRIVATE}/members/${MARTA}`, undefined],
    ]);
  });

  it("i rifiuti della fetta 2 negli errori del prototipo", async () => {
    install({
      "POST /api/chat/dm": { status: 400, body: { code: "invalid_members", message: "x" } },
      [`DELETE /api/chat/channels/${PRIVATE}/join`]: { status: 409, body: { code: "cannot_leave", message: "x" } },
      [`DELETE /api/chat/channels/${PRIVATE}/members/${MARTA}`]: { status: 409, body: { code: "last_member", message: "x" } },
      [`POST /api/chat/channels/${CH}/messages`]: { status: 400, body: { code: "invalid_also_in_channel", message: "x" } },
    });
    await getSessionPerson();
    await expect(chat.openDm([MARTA])).rejects.toThrow("invalid: members");
    await expect(chat.leaveChannel(PRIVATE)).rejects.toThrow("invalid: last_member");
    await expect(chat.removeMember(PRIVATE, MARTA)).rejects.toThrow("invalid: last_member");
    await expect(chat.sendMessage(CH, { text: "x", alsoInChannel: true })).rejects.toThrow("invalid: alsoInChannel");
  });

  it("uscire da un privato che non si vede più (204): fatto, senza errori", async () => {
    install({ [`DELETE /api/chat/channels/${PRIVATE}/join`]: { status: 204 } });
    await getSessionPerson();
    await expect(chat.leaveChannel(PRIVATE)).resolves.toBeUndefined();
  });

  it("togliersi da un privato (204): null, senza rileggere il canale che non si vede più", async () => {
    const { seen } = install({ [`DELETE /api/chat/channels/${PRIVATE}/members/${ME_ID}`]: { status: 204 } });
    await getSessionPerson();
    await expect(chat.removeMember(PRIVATE, ME_ID)).resolves.toBeNull();
    expect(seen.some((r) => r.method === "GET" && r.path === `/api/chat/channels/${PRIVATE}`)).toBe(false);
  });

  it("le domande in «Da decidere», col canale come lo legge chi guarda; ignorarne una", async () => {
    const { seen } = install({
      "GET /api/chat/questions": {
        body: {
          items: [
            { id: `chat:${ROOT}`, channelId: CH, messageId: ROOT, rootId: ROOT, askedById: MARTA, text: "@Ada ready?", createdAt: "2026-11-10T10:00:00.000Z" },
          ],
        },
      },
      "GET /api/chat/channels": { body: { items: [channel()] } },
      "GET /api/people": { body: [{ id: MARTA, name: "Marta Rinaldi", initials: "MR", departmentIds: [], email: "m@example.com" }] },
      [`POST /api/chat/questions/${ROOT}/dismiss`]: { status: 204 },
    });
    await getSessionPerson();
    expect(await chat.listQuestions()).toEqual([
      {
        id: `chat:${ROOT}`,
        channelId: CH,
        messageId: ROOT,
        rootId: ROOT,
        channelLabel: "AUD · design",
        askedById: MARTA,
        text: "@Ada ready?",
        createdAt: "2026-11-10T10:00:00.000Z",
      },
    ]);
    await chat.dismissQuestion(ROOT);
    expect(seen.some((r) => r.method === "POST" && r.path === `/api/chat/questions/${ROOT}/dismiss`)).toBe(true);
  });

  it("la ricerca coi filtri del prototipo; i risultati col contesto e la radice", async () => {
    const { seen } = install({
      "GET /api/chat/search": {
        body: { items: [{ channelId: CH, message: message({ id: REPLY, threadRootId: ROOT }), context: null, root: message() }] },
      },
    });
    await getSessionPerson();
    const hits = await chat.searchChat("export", { channelId: CH, authorId: MARTA, peopleOnly: true, from: "2026-11-01", to: "2026-11-10" });
    expect(seen.map((r) => r.path)).toContain(
      `/api/chat/search?q=export&channelId=${CH}&authorId=${MARTA}&peopleOnly=true&from=2026-11-01&to=2026-11-10`,
    );
    expect(hits).toMatchObject([{ channelId: CH, message: { id: REPLY, threadOf: ROOT }, context: null, root: { id: ROOT } }]);
  });

  it("una richiesta da un messaggio si ferma col segnale (il dialogo chiuso): niente più attesa dell'intake", async () => {
    const abort = new AbortController();
    const { seen } = install({
      "POST /api/requests": { status: 202, body: { jobId: "job-2" } },
      "GET /api/requests/jobs/job-2": () => {
        abort.abort();
        return { body: { status: "pending", outcome: null, request: null } };
      },
    });
    await getSessionPerson();
    await expect(
      chat.createRequestFromMessage(ROOT, { projectId: PROJECT_ID, title: "PDF export", description: "" }, { signal: abort.signal }),
    ).rejects.toThrow("aborted");
    expect(seen.filter((r) => r.path === "/api/requests/jobs/job-2")).toHaveLength(1);
  });

  it("task e richiesta da un messaggio: la creazione di sempre, col messaggio da cui nasce", async () => {
    const { seen } = install({
      "POST /api/tasks": { status: 201, body: serverTask() },
      "POST /api/requests": { status: 202, body: { jobId: "job-1" } },
      "GET /api/requests/jobs/job-1": { body: { status: "failed", outcome: null, request: null } },
    });
    await getSessionPerson();
    await chat.createTaskFromMessage(ROOT, { projectId: PROJECT_ID, title: "Export PDF", requestId: null });
    await chat.createRequestFromMessage(ROOT, { projectId: PROJECT_ID, title: "PDF export", description: "" }).catch(() => undefined);
    const posts = seen.filter((r) => r.method === "POST");
    expect(posts[0]).toMatchObject({ path: "/api/tasks", body: expect.objectContaining({ title: "Export PDF", chatMessageId: ROOT }) });
    expect(posts[1]).toMatchObject({ path: "/api/requests", body: { projectId: PROJECT_ID, title: "PDF export", description: "", chatMessageId: ROOT } });
  });
});

describe("fetta 2: le citazioni (F2.7)", () => {
  const TASK = "7f1c2a1e-0000-4000-8000-0000000000f1";
  const PAGE = "7f1c2a1e-0000-4000-8000-0000000000f2";

  it("il messaggio porta le citazioni che il server ha già filtrato; si risolvono come le vede chi guarda", async () => {
    install({
      [`GET /api/chat/messages/${ROOT}`]: {
        body: message({
          citations: [
            { kind: "task", id: TASK, label: "AUD-14", projectId: PROJECT_ID },
            { kind: "person", id: MARTA, label: "Marta Rinaldi", projectId: null },
            { kind: "project", id: PROJECT_ID, label: "AUD", projectId: PROJECT_ID },
            { kind: "doc", id: PAGE, label: "Billing", projectId: PROJECT_ID },
          ],
        }),
      },
    });
    await getSessionPerson();
    const m = (await chat.getMessage(ROOT))!.message;
    expect(m.citations).toEqual([
      { kind: "task", id: TASK },
      { kind: "person", id: MARTA },
      { kind: "project", id: PROJECT_ID },
      { kind: "doc", id: PAGE },
    ]);
    const views = await resolveCitations([...m.citations, { kind: "task", id: "7f1c2a1e-0000-4000-8000-0000000000ff" }]);
    expect(views).toMatchObject([
      { kind: "task", id: TASK, visible: true, code: "AUD-14", projectCode: "AUD", route: "#/p/AUD/tasks?task=AUD-14" },
      { kind: "person", id: MARTA, visible: true, name: "Marta Rinaldi", personId: MARTA, route: null },
      { kind: "project", id: PROJECT_ID, visible: true, code: "AUD", route: "#/p/AUD/overview" },
      { kind: "doc", id: PAGE, visible: true, name: "Billing", route: null },
      // Una che il server non ha confermato resta non visibile, senza nome.
      { kind: "task", visible: false, code: null, name: null },
    ]);
  });

  it("l'invio porta le citazioni scelte con «#» (solo i tipi del server); la ricerca «con citazioni»", async () => {
    const { seen } = install({
      [`POST /api/chat/channels/${CH}/messages`]: { status: 201, body: message() },
      "GET /api/chat/search": { body: { items: [] } },
    });
    await getSessionPerson();
    await chat.sendMessage(CH, {
      text: "See AUD-14",
      citations: [
        { kind: "task", id: TASK },
        { kind: "milestone", id: TASK },
      ],
    });
    await chat.searchChat("export", { withCitations: true });
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({ text: "See AUD-14", citations: [{ kind: "task", id: TASK }] });
    expect(seen.map((r) => r.path)).toContain("/api/chat/search?q=export&withCitations=true");
  });

  it("una pagina scelta con «#» ha per id il suo codice: non parte fra le citazioni, la cita il codice nel testo", async () => {
    const { seen } = install({ [`POST /api/chat/channels/${CH}/messages`]: { status: 201, body: message() } });
    await getSessionPerson();
    await chat.sendMessage(CH, { text: "See AUD-D3 Sync", citations: [{ kind: "doc", id: "AUD-D3" }] });
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({ text: "See AUD-D3 Sync" });
  });
});

describe("area 5, fetta 2: le citazioni dei file del Drive", () => {
  const FILE = "7f1c2a1e-0000-4000-8000-0000000000f3";

  it("una citazione `drive` del server: la scheda (tipo, aperture, progetto) e il dettaglio nel Drive", async () => {
    install({
      [`GET /api/chat/messages/${ROOT}`]: {
        body: message({
          citations: [
            {
              kind: "drive",
              id: FILE,
              label: "spec.pdf",
              projectId: PROJECT_ID,
              code: "AUD-F3",
              drive: { type: "pdf", projectCode: "AUD", projectName: "Audin AI", opens90d: 3, summary: null },
            },
          ],
        }),
      },
    });
    await getSessionPerson();
    const m = (await chat.getMessage(ROOT))!.message;
    expect(m.citations).toEqual([{ kind: "drive", id: FILE, code: "AUD-F3" }]);
    expect(await resolveCitations(m.citations)).toMatchObject([
      {
        kind: "drive",
        id: FILE,
        visible: true,
        code: "AUD-F3",
        name: "spec.pdf",
        projectCode: "AUD",
        route: "#/p/AUD/drive?file=AUD-F3",
        drive: { type: "pdf", google: false, summary: null, opens90d: 3, unavailable: null, projectName: "Audin AI" },
      },
    ]);
  });

  it("un file scelto con «#» parte fra le citazioni", async () => {
    const { seen } = install({ [`POST /api/chat/channels/${CH}/messages`]: { status: 201, body: message() } });
    await getSessionPerson();
    await chat.sendMessage(CH, { text: "See AUD-F3 spec.pdf", citations: [{ kind: "drive", id: FILE, code: "AUD-F3" }] });
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({
      text: "See AUD-F3 spec.pdf",
      citations: [{ kind: "drive", id: FILE }],
    });
  });
});
