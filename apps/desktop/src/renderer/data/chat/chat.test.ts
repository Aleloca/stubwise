import { beforeEach, describe, expect, it } from "vitest";
import {
  chat,
  createProject,
  createRequest,
  failNext,
  listNotifications,
  markNotification,
  resetApi,
  runScript,
  setLatency,
  updateMilestone,
  updateTask,
  whenIdle,
} from "../api";
import { queryKeys } from "../queries";
import { setSessionPersonId } from "../session";
import { familyOf, state } from "../store";
import type { ChannelRow, ChatMessageView } from "../types";
import { grantProjectPermission, revokeInstancePermission } from "../viewer";
import { canReadChannel, canSeeChannel } from "./visibility";

const as = (personId: string) => setSessionPersonId(personId);
const channel = (id: string) => state.channels.find((c) => c.id === id)!;
const idle = (channelId: string) => whenIdle(chat.channelStream(channelId));
const rowOf = (rows: ChannelRow[], id: string) => rows.find((r) => r.id === id);
/** Lo stato della Chat, per verificare che un rifiuto non abbia scritto nulla. */
const snapshot = () =>
  JSON.stringify({
    channels: state.channels,
    messages: state.chatMessages,
    reads: [...state.chatReads.values()],
    notify: [...state.chatNotify],
    notifications: state.notifications,
  });

async function rejects(p: Promise<unknown>, message: string): Promise<void> {
  const before = snapshot();
  await expect(p).rejects.toThrow(message);
  expect(snapshot()).toBe(before);
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("chat: visibilità (una sola regola)", () => {
  it("vedere e leggere, per tipo di canale e persona", () => {
    const cases: [string, string, boolean, boolean][] = [
      // [persona, canale, vede, legge]
      ["p-laura", "ch-aud-pricing", true, true],
      ["p-roberta", "ch-aud-pricing", true, false],
      ["p-marco", "ch-aud-pricing", false, false],
      ["p-roberta", "dm-launch-week", false, false],
      ["p-roberta", "dm-giulia-roberta", true, true],
      ["p-giulia", "dm-launch-week", true, true],
      ["p-roberta", "ch-aud-general", true, true],
      ["p-sara", "ch-aud-general", false, false],
      ["p-sara", "ch-announcements", true, true],
      ["p-claude", "ch-announcements", false, false],
    ];
    for (const [person, id, sees, reads] of cases) {
      expect(canSeeChannel(person, channel(id)), `${person} vede ${id}`).toBe(sees);
      expect(canReadChannel(person, channel(id)), `${person} legge ${id}`).toBe(reads);
    }
  });

  it("chi gestisce i canali di un progetto vede i suoi privati, chi no non sa che esistono", () => {
    expect(canSeeChannel("p-marco", channel("ch-aud-pricing"))).toBe(false);
    grantProjectPermission("p-marco", "prj-aud", "chat.channels.manage");
    expect(canSeeChannel("p-marco", channel("ch-aud-pricing"))).toBe(true);
    expect(canReadChannel("p-marco", channel("ch-aud-pricing"))).toBe(false);
  });

  it("il «general» del progetto ha i membri di adesso del progetto, Claude escluso", async () => {
    const project = state.projectsById.get("prj-aud")!;
    project.memberIds.push("p-sara", "p-claude");
    as("p-sara");
    const general = await chat.getChannel("ch-aud-general");
    expect(general?.memberIds).toContain("p-sara");
    expect(general?.memberIds).not.toContain("p-claude");
    expect(general?.isMember).toBe(true);
    expect(general?.canLeave).toBe(false);
    expect(general?.canJoin).toBe(false);
  });

  it("un progetto nuovo nasce con il suo «general», con chi l'ha creato", async () => {
    as("p-roberta");
    await createProject({ code: "NEWP", name: "New project", template: "empty" });
    const rows = await chat.listChannels({ scope: "project", projectId: "prj-newp" });
    expect(rows.map((r) => [r.name, r.isGeneral, r.memberIds])).toEqual([
      ["general", true, ["p-roberta"]],
    ]);
  });
});

describe("chat: Review Focus 1 — privato e DM per Roberta (full admin)", () => {
  it("il privato esiste (nome e membri) ma nessun messaggio arriva da nessuna parte", async () => {
    as("p-roberta");
    const rows = await chat.listChannels();
    const pricing = rowOf(rows, "ch-aud-pricing")!;
    expect(pricing).toMatchObject({
      name: "pricing",
      canRead: false,
      isMember: false,
      unread: 0,
      mentions: 0,
      lastActivityAt: null,
      canArchive: true,
      canDelete: true,
      canWrite: false,
      canJoin: false,
    });
    expect(pricing.memberIds).toEqual(["p-matteo", "p-laura", "p-elena"]);
    expect((await chat.getChannel("ch-aud-pricing"))?.canRead).toBe(false);
    expect(await chat.listChannelMembers("ch-aud-pricing")).toHaveLength(3);
    // Messaggi: flusso, thread, link/anteprima, ricerca, menzioni.
    expect(await chat.listMessages("ch-aud-pricing")).toBeNull();
    expect(await chat.listThread("ch-aud-pricing-m1")).toBeNull();
    expect(await chat.getMessage("ch-aud-pricing-m1")).toBeNull();
    expect(await chat.searchChat("annual")).toEqual([]);
    expect(await chat.searchChat("pricing-annual")).toEqual([]);
    expect(() => chat.subscribeChat(chat.channelStream("ch-aud-pricing"), () => {})).toThrow(
      "not_found",
    );
    // Chi lo legge, invece, trova lo stesso messaggio.
    as("p-laura");
    expect((await chat.searchChat("annual")).map((h) => h.message.id)).toContain(
      "ch-aud-pricing-m1",
    );
  });

  it("una domanda che la nomina in un privato non le arriva: né notifica, né «Da decidere», né menzioni", async () => {
    as("p-laura");
    await chat.sendMessage("ch-aud-pricing", {
      text: "@Roberta Fontana can we keep 15% for resellers?",
    });
    as("p-roberta");
    expect((await listNotifications()).filter((n) => n.chatMessageId)).toEqual([]);
    expect(await chat.listQuestions()).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ channelId: "ch-aud-pricing" })]),
    );
    expect((await chat.listMentions()).some((h) => h.channelId === "ch-aud-pricing")).toBe(false);
  });

  it("un DM altrui non esiste per lei, nemmeno da un link", async () => {
    as("p-roberta");
    const rows = await chat.listChannels();
    expect(rowOf(rows, "dm-launch-week")).toBeUndefined();
    expect(rowOf(rows, "dm-giulia-marco")).toBeUndefined();
    expect(await chat.getChannel("dm-launch-week")).toBeNull();
    expect(await chat.listChannelMembers("dm-launch-week")).toBeNull();
    expect(await chat.listMessages("dm-launch-week")).toBeNull();
    expect(await chat.getMessage("dm-launch-week-m1")).toBeNull();
    await rejects(chat.archiveChannel("dm-launch-week"), "not_found");
    await rejects(chat.sendMessage("dm-launch-week", { text: "hi" }), "not_found");
  });

  it("può archiviare ed eliminare il privato senza leggerlo, ma non aggiungersi", async () => {
    as("p-roberta");
    await rejects(chat.inviteMembers("ch-aud-pricing", ["p-roberta"]), "forbidden");
    const archived = await chat.archiveChannel("ch-aud-pricing");
    expect(archived).toMatchObject({ archived: true, canRead: false });
    await chat.deleteChannel("ch-aud-pricing");
    expect(state.chatMessages.some((m) => m.channelId === "ch-aud-pricing")).toBe(false);
    as("p-laura");
    expect(await chat.getChannel("ch-aud-pricing")).toBeNull();
  });
});

describe("chat: Review Focus 3 — un messaggio eliminato non ha più testo, da nessuna parte", () => {
  it("canale, thread, ricerca, menzioni, notifiche e domande", async () => {
    const SECRET = "zebracode";
    as("p-giulia");
    const root = await chat.sendMessage("ch-stw-desktop", {
      text: `${SECRET} @Marco Bellini can you check the build?`,
    });
    as("p-laura");
    const reply = await chat.sendMessage("ch-stw-desktop", {
      text: `${SECRET} reply for @Marco Bellini`,
      threadOf: root.id,
    });
    as("p-marco");
    expect((await chat.listQuestions()).map((q) => q.messageId)).toContain(root.id);
    expect((await listNotifications()).filter((n) => n.chatMessageId).length).toBe(2);

    as("p-giulia");
    await chat.deleteMessage(root.id);
    as("p-laura");
    await chat.deleteMessage(reply.id);

    as("p-marco");
    const page = (await chat.listMessages("ch-stw-desktop"))!;
    const shown = page.messages.find((m) => m.id === root.id)!;
    // Con risposte (anche eliminate, entro un giorno) la radice resta «Message deleted».
    expect(shown).toMatchObject({ text: "", attachments: [], citations: [], asksReplyOf: [] });
    expect(shown.deletedAt).not.toBeNull();
    const thread = (await chat.listThread(root.id))!;
    expect(thread.root.text).toBe("");
    expect(thread.replies.map((r) => r.text)).toEqual([""]);
    const payloads = [
      page,
      thread,
      await chat.searchChat(SECRET),
      await chat.listMentions(),
      await chat.listQuestions(),
      await listNotifications(),
      await chat.getMessage(root.id),
      await chat.listThreadsWithNews(),
    ];
    expect(JSON.stringify(payloads)).not.toContain(SECRET);
    expect(await chat.searchChat(SECRET)).toEqual([]);
    expect(state.chatMessages.find((m) => m.id === root.id)?.text).toBe("");
  });

  it("lo stream porta l'eliminazione senza il testo", async () => {
    as("p-giulia");
    const received: ChatMessageView[] = [];
    chat.subscribeChat(chat.channelStream("ch-stw-desktop"), (m) => received.push(m));
    const m = await chat.sendMessage("ch-stw-desktop", { text: "zebracode" });
    await chat.deleteMessage(m.id);
    expect(received.map((x) => [x.id, x.text])).toEqual([
      [m.id, "zebracode"],
      [m.id, ""],
    ]);
  });

  it("senza risposte e dopo un giorno sparisce dal flusso; più recente resta «Message deleted»", async () => {
    const seeded = state.chatMessages.find(
      (m) => m.channelId === "ch-aud-general" && m.deletedAt !== null,
    )!;
    as("p-laura");
    const before = (await chat.listMessages("ch-aud-general", { limit: 500 }))!;
    expect(before.messages.some((m) => m.id === seeded.id)).toBe(false);
    expect(await chat.getMessage(seeded.id)).toBeNull();
    const mine = await chat.sendMessage("ch-aud-general", { text: "typo" });
    await chat.deleteMessage(mine.id);
    const after = (await chat.listMessages("ch-aud-general"))!;
    expect(after.messages.find((m) => m.id === mine.id)?.text).toBe("");
  });
});

describe("chat: non letti e menzioni", () => {
  it("le cinque persone hanno conteggi diversi (dal livello dati)", async () => {
    const totals: string[] = [];
    for (const person of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-roberta"]) {
      as(person);
      const rows = await chat.listChannels();
      const unread = rows.reduce((n, r) => n + r.unread, 0);
      const mentions = rows.reduce((n, r) => n + r.mentions, 0);
      expect(unread + mentions, person).toBeGreaterThan(0);
      totals.push(`${unread}/${mentions}`);
    }
    expect(new Set(totals).size, totals.join(" ")).toBe(5);
  });

  it("un silenziato non conta i messaggi né @channel, ma le menzioni dirette sì", async () => {
    as("p-giulia");
    const start = rowOf(await chat.listChannels(), "ch-chit-chat")!;
    expect(start.notifyLevel).toBe("muted");
    as("p-federico");
    await chat.sendMessage("ch-chit-chat", { text: "@channel pizza at one" });
    as("p-giulia");
    let row = rowOf(await chat.listChannels(), "ch-chit-chat")!;
    expect([row.unread, row.mentions]).toEqual([0, start.mentions]);
    as("p-federico");
    await chat.sendMessage("ch-chit-chat", { text: "@Giulia Ferri you coming?" });
    as("p-giulia");
    row = rowOf(await chat.listChannels(), "ch-chit-chat")!;
    expect([row.unread, row.mentions]).toEqual([0, start.mentions + 1]);
  });

  it("un messaggio di sistema è non letto ma mai una menzione; in un DM ogni messaggio è una menzione", async () => {
    const task = state.tasks.find((t) => t.projectId === "prj-stw" && familyOf(t) !== "closed")!;
    const closed = state.statuses.find((s) => s.projectId === "prj-stw" && s.family === "closed")!;
    as("p-laura");
    const before = rowOf(await chat.listChannels(), "ch-stw-general")!;
    as("p-roberta");
    await updateTask(task.id, { statusId: closed.id });
    await idle("ch-stw-general");
    as("p-laura");
    const after = rowOf(await chat.listChannels(), "ch-stw-general")!;
    expect([after.unread, after.mentions]).toEqual([before.unread + 1, before.mentions]);

    const dmBefore = rowOf(await chat.listChannels(), "dm-laura-marco")!;
    as("p-marco");
    await chat.sendMessage("dm-laura-marco", { text: "ok" });
    as("p-laura");
    const dm = rowOf(await chat.listChannels(), "dm-laura-marco")!;
    expect([dm.unread, dm.mentions]).toEqual([dmBefore.unread + 1, dmBefore.mentions + 1]);
    await chat.markRead("dm-laura-marco");
    expect(rowOf(await chat.listChannels(), "dm-laura-marco")).toMatchObject({
      unread: 0,
      mentions: 0,
    });
  });

  it("chi scrive ha letto; «Mark unread from here» rimette i messaggi fra i non letti", async () => {
    as("p-marco");
    await chat.sendMessage("dm-giulia-marco", { text: "one" });
    await chat.sendMessage("dm-giulia-marco", { text: "two" });
    expect(rowOf(await chat.listChannels(), "dm-giulia-marco")?.unread).toBe(0);
    as("p-giulia");
    await chat.markRead("dm-giulia-marco");
    const page = (await chat.listMessages("dm-giulia-marco"))!;
    const one = page.messages.find((m) => m.text === "one")!;
    await chat.markRead("dm-giulia-marco", one.createdAt.replace(/:\d\dZ$/, ":00Z"));
    expect(rowOf(await chat.listChannels(), "dm-giulia-marco")?.unread).toBe(2);
  });
});

describe("chat: scritture e permessi", () => {
  it("niente ingresso silenzioso: in un aperto si scrive dopo «Join channel»", async () => {
    as("p-sara");
    const row = rowOf(await chat.listChannels(), "ch-marketing")!;
    expect(row).toMatchObject({ isMember: false, canRead: true, canJoin: true, canWrite: false });
    expect((await chat.listMessages("ch-marketing"))?.lastReadAt).toBeNull();
    await rejects(chat.sendMessage("ch-marketing", { text: "hello" }), "forbidden");
    await rejects(
      chat.toggleReaction((await chat.listMessages("ch-marketing"))!.messages[0]!.id, "👍"),
      "forbidden",
    );
    const joined = await chat.joinChannel("ch-marketing");
    expect(joined).toMatchObject({ isMember: true, canWrite: true });
    const sent = await chat.sendMessage("ch-marketing", { text: "hello" });
    expect(sent.authorId).toBe("p-sara");
    await chat.leaveChannel("ch-marketing");
    expect((await chat.getChannel("ch-marketing"))?.isMember).toBe(false);
  });

  it("un archiviato si legge e non si scrive; un messaggio vuoto o un thread sbagliato no", async () => {
    as("p-giulia");
    expect(await chat.listMessages("ch-mkx-autumn")).not.toBeNull();
    await rejects(chat.sendMessage("ch-mkx-autumn", { text: "hi" }), "invalid: archived");
    await rejects(chat.sendMessage("ch-mkx-grafica", { text: "   " }), "invalid: text");
    const reply = state.chatMessages.find(
      (m) => m.channelId === "ch-mkx-grafica" && m.threadOf !== null,
    )!;
    await rejects(
      chat.sendMessage("ch-mkx-grafica", { text: "x", threadOf: reply.id }),
      "invalid: threadOf",
    );
    await rejects(
      chat.sendMessage("ch-mkx-grafica", { text: "x", alsoInChannel: true }),
      "invalid: alsoInChannel",
    );
    failNext("chat.sendMessage");
    await rejects(chat.sendMessage("ch-mkx-grafica", { text: "x" }), "Simulated failure");
  });

  it("si modificano e si eliminano solo i propri messaggi; una risposta di Claude solo da chi l'ha chiamato", async () => {
    as("p-laura");
    const mine = await chat.sendMessage("ch-stw-desktop", { text: "draft" });
    as("p-marco");
    await rejects(chat.editMessage(mine.id, "hacked"), "forbidden");
    await rejects(chat.deleteMessage(mine.id), "forbidden");
    as("p-laura");
    const edited = await chat.editMessage(mine.id, "final");
    expect(edited).toMatchObject({ text: "final" });
    expect(edited.editedAt).not.toBeNull();

    const claudeReply = state.chatMessages.find(
      (m) => m.kind === "claude" && m.calledById === "p-marco" && m.channelId === "ch-aud-general",
    )!;
    as("p-giulia");
    await rejects(chat.deleteMessage(claudeReply.id), "forbidden");
    await rejects(chat.editMessage(claudeReply.id, "x"), "forbidden");
    as("p-marco");
    await rejects(chat.editMessage(claudeReply.id, "x"), "forbidden");
    await chat.deleteMessage(claudeReply.id);
    const gone = state.chatMessages.find((m) => m.id === claudeReply.id)!;
    expect(gone).toMatchObject({ text: "", deletedById: "p-marco", claudeEvents: [] });
  });

  it("le reazioni si mettono e si tolgono", async () => {
    as("p-laura");
    const m = await chat.sendMessage("ch-stw-desktop", { text: "ship it" });
    as("p-marco");
    let shown = await chat.toggleReaction(m.id, "🚀");
    expect(shown.reactions).toEqual([{ emoji: "🚀", personIds: ["p-marco"] }]);
    as("p-giulia");
    shown = await chat.toggleReaction(m.id, "🚀");
    expect(shown.reactions[0]?.personIds).toEqual(["p-marco", "p-giulia"]);
    as("p-marco");
    shown = await chat.toggleReaction(m.id, "🚀");
    expect(shown.reactions).toEqual([{ emoji: "🚀", personIds: ["p-giulia"] }]);
  });

  it("creare un canale chiede il permesso dell'ambito; nomi unici e membri del progetto", async () => {
    as("p-sara");
    await rejects(
      chat.createChannel({ projectId: "prj-aud", name: "x", visibility: "open" }),
      "not_found",
    );
    revokeInstancePermission("p-sara", "chat.general.create");
    await rejects(
      chat.createChannel({ projectId: null, name: "support-lunch", visibility: "open" }),
      "forbidden",
    );
    as("p-marco");
    await rejects(
      chat.createChannel({ projectId: "prj-aud", name: "Releases", visibility: "open" }),
      "invalid: name_taken",
    );
    await rejects(
      chat.createChannel({ projectId: "prj-aud", name: "bad_name!", visibility: "open" }),
      "invalid: name",
    );
    await rejects(
      chat.createChannel({
        projectId: "prj-aud",
        name: "secret",
        visibility: "private",
        memberIds: ["p-sara"],
      }),
      "invalid: members",
    );
    const created = await chat.createChannel({
      projectId: "prj-aud",
      name: "Price List",
      visibility: "private",
      memberIds: ["p-laura"],
    });
    expect(created).toMatchObject({
      name: "price-list",
      memberIds: ["p-marco", "p-laura"],
      publishedEvents: ["release_page", "milestone_reached", "brief_ready"],
      canEditInfo: true,
      canInvite: true,
    });
    as("p-giulia");
    expect(await chat.getChannel(created.id)).toBeNull();
  });

  it("nome e descrizione al creatore o a chi gestisce; l'argomento a ogni membro; il «general» non si rinomina", async () => {
    as("p-marco");
    await rejects(chat.updateChannel("ch-stw-desktop", { name: "desk" }), "forbidden");
    const topic = await chat.updateChannel("ch-stw-desktop", { topic: "Demo moved to Monday" });
    expect(topic.topic).toBe("Demo moved to Monday");
    as("p-laura");
    const renamed = await chat.updateChannel("ch-stw-desktop", { name: "desktop-prototype" });
    expect(renamed.name).toBe("desktop-prototype");
    as("p-roberta");
    await rejects(chat.updateChannel("ch-aud-general", { name: "main" }), "invalid: general");
  });

  it("archiviare ed eliminare: il creatore o chi gestisce, mai il «general» né un DM", async () => {
    as("p-marco");
    await rejects(chat.archiveChannel("ch-stw-desktop"), "forbidden");
    await rejects(chat.deleteChannel("ch-stw-desktop"), "forbidden");
    as("p-roberta");
    await rejects(chat.archiveChannel("ch-aud-general"), "forbidden");
    await rejects(chat.deleteChannel("ch-aud-general"), "forbidden");
    await rejects(chat.archiveChannel("dm-giulia-roberta"), "forbidden");
    as("p-laura");
    expect((await chat.archiveChannel("ch-stw-desktop")).archived).toBe(true);
    expect((await chat.archiveChannel("ch-stw-desktop", false)).archived).toBe(false);
  });

  it("invitare e togliere: privato al creatore o a chi gestisce, aperto a ogni membro; il privato non resta vuoto", async () => {
    as("p-elena");
    await rejects(chat.inviteMembers("ch-aud-pricing", ["p-marco"]), "forbidden");
    as("p-matteo");
    await rejects(chat.inviteMembers("ch-aud-pricing", ["p-sara"]), "invalid: members");
    const invited = await chat.inviteMembers("ch-aud-pricing", ["p-marco"]);
    expect(invited.memberIds).toContain("p-marco");
    as("p-marco");
    expect((await chat.listMessages("ch-aud-pricing"))?.messages.length).toBeGreaterThan(0);
    // Un aperto: qualunque membro aggiunge (un membro del progetto).
    const newcomer = state.projectsById
      .get("prj-stw")!
      .memberIds.find(
        (id) => id !== "p-claude" && !channel("ch-stw-desktop").memberIds.includes(id),
      )!;
    const opened = await chat.inviteMembers("ch-stw-desktop", [newcomer]);
    expect(opened.memberIds).toContain(newcomer);
    await rejects(chat.removeMember("ch-stw-desktop", newcomer), "forbidden");
    // Togliere fino all'ultimo: l'ultimo resta.
    as("p-matteo");
    for (const id of ["p-marco", "p-laura", "p-elena"])
      await chat.removeMember("ch-aud-pricing", id);
    await rejects(chat.removeMember("ch-aud-pricing", "p-matteo"), "invalid: last_member");
    await rejects(chat.leaveChannel("ch-aud-pricing"), "forbidden");
  });

  it("un DM: fino a 8 persone compreso chi lo apre, ritrova quello che c'è, il gruppo si lascia", async () => {
    as("p-giulia");
    const same = await chat.openDm(["p-marco"]);
    expect(same.id).toBe("dm-giulia-marco");
    const group = await chat.openDm(["p-sara", "p-elena", "p-marco", "p-laura", "p-giulia"]);
    expect(group.id).toBe("dm-launch-week");
    const seven = ["p-marco", "p-laura", "p-sara", "p-elena", "p-paolo", "p-chiara", "p-tommaso"];
    const fresh = await chat.openDm(seven);
    expect(fresh.memberIds).toHaveLength(8);
    expect((await chat.openDm([...seven].reverse())).id).toBe(fresh.id);
    await rejects(chat.openDm([...seven, "p-matteo"]), "invalid: members");
    await rejects(chat.openDm(["p-claude"]), "invalid: members");
    await rejects(chat.openDm([]), "invalid: members");
    await rejects(chat.leaveChannel("dm-giulia-marco"), "forbidden");
    await chat.leaveChannel("dm-launch-week");
    expect(await chat.getChannel("dm-launch-week")).toBeNull();
  });

  it("gli eventi pubblicati li sceglie chi gestisce, solo nei canali di progetto", async () => {
    as("p-marco");
    await rejects(chat.setPublishedEvents("ch-stw-desktop", ["task_closed"]), "forbidden");
    as("p-laura");
    const updated = await chat.setPublishedEvents("ch-stw-desktop", ["task_closed", "pr_opened"]);
    expect(updated.publishedEvents).toEqual(["pr_opened", "task_closed"]);
    as("p-roberta");
    await rejects(chat.setPublishedEvents("ch-announcements", ["task_closed"]), "forbidden");
  });

  it("preferenze di notifica e segui/smetti un thread: solo i membri", async () => {
    as("p-sara");
    await rejects(chat.setNotifyLevel("ch-marketing", "muted"), "forbidden");
    as("p-giulia");
    await chat.setNotifyLevel("ch-marketing", "mentions");
    expect((await chat.getChannel("ch-marketing"))?.notifyLevel).toBe("mentions");
    await chat.setNotifyLevel("ch-marketing", "all");
    expect(state.chatNotify.has(`p-giulia\u0000ch-marketing`)).toBe(false);
  });

  it("«Create task» e «Create request» da un messaggio: le creazioni di sempre e il codice sul messaggio", async () => {
    as("p-laura");
    const m = await chat.sendMessage("ch-stw-desktop", { text: "The tray icon is blurry" });
    const task = await chat.createTaskFromMessage(m.id, {
      projectId: "prj-stw",
      title: "Tray icon is blurry",
    });
    const request = await chat.createRequestFromMessage(m.id, {
      projectId: "prj-stw",
      title: "Sharper tray icon",
    });
    const linked = (await chat.getMessage(m.id))!.message;
    expect(linked.linkedCodes).toEqual([task.code, request.code]);
    // Senza il permesso di creare, nulla cambia.
    as("p-simone");
    const before = snapshot();
    revokeInstancePermission("p-simone", "chat.general.create");
    await expect(
      chat.createTaskFromMessage(m.id, { projectId: "prj-aud", title: "x" }),
    ).rejects.toThrow();
    expect(snapshot()).toBe(before);
  });
});

describe("chat: thread, menzioni e domande", () => {
  it("chi scrive nel thread lo segue, e lo segue chi ha scritto la radice e chi è nominato", async () => {
    as("p-laura");
    const root = await chat.sendMessage("ch-stw-desktop", { text: "Build 42 is out" });
    as("p-marco");
    await chat.sendMessage("ch-stw-desktop", {
      text: "Crashes on start, @Simone Rossetti",
      threadOf: root.id,
    });
    as("p-laura");
    let threads = await chat.listThreadsWithNews();
    expect(threads.find((t) => t.root.id === root.id)).toMatchObject({ newCount: 1 });
    as("p-simone");
    threads = await chat.listThreadsWithNews();
    expect(threads.find((t) => t.root.id === root.id)?.newCount).toBe(1);
    await chat.markThreadRead(root.id);
    expect((await chat.listThreadsWithNews()).some((t) => t.root.id === root.id)).toBe(false);
    as("p-marco");
    const page = (await chat.listMessages("ch-stw-desktop"))!;
    expect(page.messages.find((m) => m.id === root.id)?.thread).toMatchObject({
      replyCount: 1,
      lastReplyById: "p-marco",
      following: true,
      hasNews: false,
    });
    await chat.setThreadFollow(root.id, false);
    expect((await chat.listThread(root.id))?.lastReadAt).toBeNull();
  });

  it("«Rispondi anche nel canale»: la risposta è nel thread e nel flusso del canale", async () => {
    as("p-laura");
    const root = await chat.sendMessage("ch-stw-desktop", { text: "Release?" });
    const reply = await chat.sendMessage("ch-stw-desktop", {
      text: "Friday",
      threadOf: root.id,
      alsoInChannel: true,
    });
    const page = (await chat.listMessages("ch-stw-desktop"))!;
    expect(page.messages.map((m) => m.id).slice(-2)).toEqual([root.id, reply.id]);
    expect((await chat.listThread(root.id))?.replies.map((r) => r.id)).toEqual([reply.id]);
  });

  it("@persona, @reparto (solo chi è nel canale) e @channel finiscono in Menzioni", async () => {
    as("p-laura");
    const m = await chat.sendMessage("ch-stw-desktop", {
      text: "@Development please review, @channel FYI",
    });
    as("p-marco");
    expect((await chat.listMentions())[0]?.message.id).toBe(m.id);
    // Giulia (Marketing) è nel canale: @channel la riguarda, @Development no.
    as("p-giulia");
    const hit = (await chat.listMentions()).find((h) => h.message.id === m.id);
    expect(hit?.message.mentionsViewer).toBe(true);
    // Chi non è nel canale non è toccato da @reparto.
    as("p-stefano");
    expect((await chat.listMentions()).some((h) => h.message.id === m.id)).toBe(false);
  });

  it("una domanda va in «Da decidere» finché non si risponde o la si ignora", async () => {
    as("p-laura");
    const q1 = await chat.sendMessage("ch-stw-desktop", { text: "@Marco Bellini ready?" });
    const q2 = await chat.sendMessage("ch-stw-desktop", {
      text: "@Marco Bellini have a look",
      asksReply: true,
    });
    const notQuestion = await chat.sendMessage("ch-stw-desktop", { text: "@Marco Bellini thanks" });
    expect([q1.asksReplyOf, q2.asksReplyOf, notQuestion.asksReplyOf]).toEqual([
      ["p-marco"],
      ["p-marco"],
      [],
    ]);
    as("p-marco");
    let open = (await chat.listQuestions()).map((q) => q.messageId);
    expect(open).toEqual(expect.arrayContaining([q1.id, q2.id]));
    expect(open).not.toContain(notQuestion.id);
    await chat.sendMessage("ch-stw-desktop", { text: "yes", threadOf: q1.id });
    await chat.dismissQuestion(q2.id);
    open = (await chat.listQuestions()).map((q) => q.messageId);
    expect(open).not.toContain(q1.id);
    expect(open).not.toContain(q2.id);
    const answered = (await chat.listMessages("ch-stw-desktop"))!.messages.find(
      (m) => m.id === q1.id,
    );
    expect(answered?.answeredIds).toEqual(["p-marco"]);
    await rejects(chat.dismissQuestion(q2.id), "not_found");
  });

  it("le notifiche di menzione: solo a chi legge, testo dal messaggio di adesso, segnabili", async () => {
    as("p-laura");
    const m = await chat.sendMessage("ch-stw-desktop", { text: "@Marco Bellini the build is red" });
    as("p-marco");
    const mine = (await listNotifications()).find((n) => n.chatMessageId === m.id)!;
    expect(mine).toMatchObject({
      kind: "chat.mention",
      title: "Laura Costa mentioned you in STW · desktop-app",
      body: "@Marco Bellini the build is red",
      link: `#/chat/ch-stw-desktop?message=${m.id}`,
      read: false,
    });
    await markNotification(mine.id, { read: true });
    expect((await listNotifications()).find((n) => n.id === mine.id)?.read).toBe(true);
    as("p-laura");
    await chat.editMessage(m.id, "@Marco Bellini the build is green");
    as("p-marco");
    expect((await listNotifications()).find((n) => n.id === mine.id)?.body).toContain("green");
    as("p-laura");
    await chat.removeMember("ch-stw-desktop", "p-marco");
    as("p-marco");
    // Il canale è aperto: Marco lo legge ancora (vede il progetto), la notifica resta.
    expect((await listNotifications()).some((n) => n.id === mine.id)).toBe(true);
  });
});

describe("chat: eventi dei progetti, solo dove sono accesi", () => {
  const systemIn = (channelId: string) =>
    state.chatMessages.filter((m) => m.channelId === channelId && m.kind === "system").length;

  it("task chiusa, richiesta nuova, traguardo raggiunto", async () => {
    const counts = () =>
      Object.fromEntries(
        ["ch-aud-general", "ch-aud-releases", "ch-mkx-general", "ch-stw-general"].map((id) => [
          id,
          systemIn(id),
        ]),
      );
    const before = counts();
    as("p-roberta");
    const close = async (projectId: string) => {
      const task = state.tasks.find((t) => t.projectId === projectId && familyOf(t) !== "closed")!;
      const closed = state.statuses.find(
        (s) => s.projectId === projectId && s.family === "closed",
      )!;
      await updateTask(task.id, { statusId: closed.id });
    };
    await close("prj-aud"); // AUD non pubblica le task chiuse
    await close("prj-mkx"); // MKX sì
    await createRequest({ projectId: "prj-aud", title: "Bulk export" }); // AUD general sì
    const milestone = state.milestones.find((m) => m.projectId === "prj-aud" && !m.closed)!;
    await updateMilestone(milestone.id, { closed: true });
    await updateMilestone(milestone.id, { closed: true }); // già chiuso: nessun secondo evento
    for (const id of ["ch-aud-general", "ch-aud-releases", "ch-mkx-general"]) await idle(id);
    expect(counts()).toEqual({
      ...before,
      "ch-aud-general": before["ch-aud-general"]! + 2,
      "ch-mkx-general": before["ch-mkx-general"]! + 1,
    });
    const last = state.chatMessages.filter((m) => m.channelId === "ch-aud-general").at(-1)!;
    expect(last.event).toEqual({
      kind: "milestone_reached",
      ref: { kind: "milestone", id: milestone.id },
    });
    expect(last.text).toBe(`Milestone reached: ${milestone.name}`);
  });

  it("PR aperta da una sessione di lavoro, PR mergiata, pagina di Release, brief", async () => {
    const before = {
      desktop: systemIn("ch-stw-desktop"),
      stwGeneral: systemIn("ch-stw-general"),
      releases: systemIn("ch-aud-releases"),
      audGeneral: systemIn("ch-aud-general"),
    };
    await runScript("cv-run-stw-13", [
      { step: "event", event: { type: "work_result", kind: "pr_opened", text: "PR opened" } },
    ]);
    await idle("ch-stw-desktop");
    await chat.recordPullRequestEvent({
      id: "pr-x",
      projectId: "prj-aud",
      taskId: "t-aud-12",
      kind: "pr_merged",
      at: "2026-10-23T12:00:00Z",
      number: 300,
      repo: "audin/audin-app",
    });
    await chat.publishReleasePage({
      id: "rel-aud-9",
      projectId: "prj-aud",
      version: "1.0.0",
      title: "Launch",
      summary: "",
      publishedAt: "2026-10-23T12:00:00Z",
      publishedById: "p-laura",
    });
    const brief = state.briefs.find((b) => b.projectId === "prj-aud")!;
    await chat.publishWeeklyBrief({ ...brief, id: "brief-aud-new" });
    expect({
      desktop: systemIn("ch-stw-desktop"),
      stwGeneral: systemIn("ch-stw-general"),
      releases: systemIn("ch-aud-releases"),
      audGeneral: systemIn("ch-aud-general"),
    }).toEqual({
      desktop: before.desktop + 1,
      stwGeneral: before.stwGeneral,
      releases: before.releases + 2,
      audGeneral: before.audGeneral + 1,
    });
    as("p-marco");
    const page = (await chat.listMessages("ch-aud-releases"))!;
    expect(page.messages.at(-1)?.event).toEqual({
      kind: "release_page",
      ref: { kind: "release", id: "rel-aud-9" },
    });
  });

  it("un canale archiviato non riceve eventi", async () => {
    as("p-laura");
    await chat.archiveChannel("ch-stw-desktop");
    const before = systemIn("ch-stw-desktop");
    await runScript("cv-run-stw-13", [
      { step: "event", event: { type: "work_result", kind: "pr_opened", text: "PR opened" } },
    ]);
    await idle("ch-stw-desktop");
    expect(systemIn("ch-stw-desktop")).toBe(before);
  });
});

describe("chat: arrivo dal vivo (un solo punto d'emissione)", () => {
  it("chi guarda il canale riceve il messaggio nuovo e, per una risposta, la radice aggiornata", async () => {
    as("p-laura");
    const events: [string, string, number | undefined][] = [];
    const off = chat.subscribeChat(chat.channelStream("ch-stw-desktop"), (m, mode) =>
      events.push([m.id, mode, m.thread?.replyCount]),
    );
    const threadEvents: string[] = [];
    const root = await chat.sendMessage("ch-stw-desktop", { text: "root" });
    chat.subscribeChat(chat.threadStream(root.id), (m, mode) =>
      threadEvents.push(`${m.id}:${mode}`),
    );
    const reply = await chat.sendMessage("ch-stw-desktop", { text: "reply", threadOf: root.id });
    off();
    await chat.sendMessage("ch-stw-desktop", { text: "after" });
    expect(events).toEqual([
      [root.id, "append", undefined],
      [root.id, "update", 1],
    ]);
    expect(threadEvents).toEqual([`${reply.id}:append`, `${root.id}:update`]);
  });

  it("cambiata la persona, lo stream si chiude prima di consegnare", async () => {
    as("p-laura");
    const received: string[] = [];
    let closed = false;
    chat.subscribeChat(chat.channelStream("ch-stw-desktop"), (m) => received.push(m.id), {
      onConnection: () => {
        closed = true;
      },
    });
    as("p-marco");
    await chat.sendMessage("ch-stw-desktop", { text: "hello" });
    expect(received).toEqual([]);
    expect(closed).toBe(true);
  });

  it("chi esce da un privato smette subito di ricevere", async () => {
    as("p-elena");
    let closed = false;
    chat.subscribeChat(chat.channelStream("ch-aud-pricing"), () => {}, {
      onConnection: () => {
        closed = true;
      },
    });
    await chat.leaveChannel("ch-aud-pricing");
    expect(closed).toBe(true);
  });
});

describe("chat: chiavi delle query per persona", () => {
  it("ogni chiave della Chat comincia con [as, persona]", () => {
    const keys = [
      queryKeys.chatChannels("p-giulia", { scope: "all" }),
      queryKeys.chatChannel("p-giulia", "c"),
      queryKeys.chatMembers("p-giulia", "c"),
      queryKeys.chatMessages("p-giulia", "c"),
      queryKeys.chatThread("p-giulia", "m"),
      queryKeys.chatThreads("p-giulia"),
      queryKeys.chatMentions("p-giulia"),
      queryKeys.chatQuestions("p-giulia"),
      queryKeys.chatSearch("p-giulia", "q", {}),
      queryKeys.chatMessage("p-giulia", "m"),
    ];
    for (const key of keys) expect(key.slice(0, 2)).toEqual(["as", "p-giulia"]);
    expect(new Set(keys.map((k) => k[2])).size).toBe(keys.length);
  });
});
