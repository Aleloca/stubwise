import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatChannels, chatMessages, notifications } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";
import { changedSince } from "../chat/service.js";

// La Chat fra persone, area 4 fetta 1: chi vede (chi vede il progetto), chi
// scrive (i membri, canale non archiviato), chi gestisce (chat.channels.manage,
// mai il «general»), messaggi e thread, menzioni nell'inbox derivate a lettura.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let seeded: SeededUsers;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let dev2: U;
let legacy: U;
let outsider: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  seeded = await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-chat@example.com");
  dev = await createUserWithSession(app, "dev-chat@example.com");
  dev2 = await createUserWithSession(app, "dev2-chat@example.com");
  legacy = await createUserWithSession(app, "legacy-chat@example.com");
  outsider = await createUserWithSession(app, "outsider-chat@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, dev2.id, "developer");
  await addMember(app, projectId, legacy.id, "legacy_member");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: U, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

async function general(): Promise<{ id: string }> {
  const [row] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  return row!;
}
let n = 0;
async function channel(): Promise<string> {
  const res = await as(dev, "POST", "/api/chat/channels", { projectId, name: `tema ${++n}` });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}
const post = (u: U, channelId: string, text: string, threadRootId?: string) =>
  as(u, "POST", `/api/chat/channels/${channelId}/messages`, { text, ...(threadRootId ? { threadRootId } : {}) });

describe("chi vede e chi scrive", () => {
  it("il «general» nasce col progetto: lo vede e ci scrive chi vede il progetto; chi non lo vede riceve 404", async () => {
    const g = await general();
    const view = (await as(legacy, "GET", `/api/chat/channels/${g.id}`)).json() as Record<string, unknown>;
    expect(view).toMatchObject({ name: "general", isGeneral: true, isMember: true, canWrite: true, canJoin: false, canManage: false });
    expect(view["memberIds"]).toEqual(expect.arrayContaining([lead.id, dev.id, legacy.id]));
    expect((await as(outsider, "GET", `/api/chat/channels/${g.id}`)).statusCode).toBe(404);
    expect(((await as(outsider, "GET", "/api/chat/channels")).json() as { items: unknown[] }).items).toEqual([]);
    expect((await post(outsider, g.id, "ciao")).statusCode).toBe(404);
  });

  it("creare: Developer sì, Legacy Member no; un nome già usato è 409", async () => {
    const id = await channel();
    // Il creatore modifica e archivia il suo canale (fetta 2, come il prototipo), ma non lo elimina (R-G3).
    expect((await as(dev, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({
      isMember: true,
      canManage: true,
      canEditInfo: true,
      canArchive: true,
      canDelete: false,
    });
    const denied = await as(legacy, "POST", "/api/chat/channels", { projectId, name: "da-legacy" });
    expect(denied.statusCode).toBe(403);
    const taken = await as(dev, "POST", "/api/chat/channels", { projectId, name: `tema ${n}` });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "name_taken" });
  });

  it("gestire: il Lead rinomina, archivia ed elimina; il creatore rinomina ma non elimina; un altro Developer no; il «general» mai", async () => {
    const id = await channel();
    expect((await as(dev2, "PATCH", `/api/chat/channels/${id}`, { name: "nuovo" })).statusCode).toBe(403);
    expect((await as(dev2, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ canManage: false, canEditTopic: false });
    // L'argomento lo cambia qualunque membro.
    await as(dev2, "POST", `/api/chat/channels/${id}/join`);
    expect((await as(dev2, "PATCH", `/api/chat/channels/${id}`, { topic: "di cosa si parla" })).json()).toMatchObject({ topic: "di cosa si parla" });
    expect((await as(dev, "PATCH", `/api/chat/channels/${id}`, { name: "del creatore" })).json()).toMatchObject({ name: "del-creatore" });
    expect((await as(dev, "DELETE", `/api/chat/channels/${id}`)).statusCode).toBe(403);
    const renamed = await as(lead, "PATCH", `/api/chat/channels/${id}`, { name: "Nuovo Nome" });
    expect(renamed.json()).toMatchObject({ name: "nuovo-nome", canManage: true });
    const g = await general();
    // Il Lead ha chat.channels.manage, ma il «general» non lo gestisce nessuno.
    expect((await as(lead, "GET", `/api/chat/channels/${g.id}`)).json()).toMatchObject({ canManage: false });
    const onGeneral = await as(lead, "PATCH", `/api/chat/channels/${g.id}`, { archived: true });
    expect(onGeneral.json()).toMatchObject({ code: "general_channel" });
    expect((await as(lead, "DELETE", `/api/chat/channels/${g.id}`)).statusCode).toBe(409);
    expect((await as(lead, "PATCH", `/api/chat/channels/${id}`, { archived: true })).json()).toMatchObject({ archived: true, canWrite: false });
    expect((await post(dev, id, "in un archiviato")).json()).toMatchObject({ code: "channel_archived" });
    expect((await as(lead, "DELETE", `/api/chat/channels/${id}`)).statusCode).toBe(204);
    expect((await as(dev, "GET", `/api/chat/channels/${id}`)).statusCode).toBe(404);
  });

  it("entrare e uscire: chi non è membro non scrive (403 not_member)", async () => {
    const id = await channel();
    expect((await post(legacy, id, "prima di entrare")).json()).toMatchObject({ code: "not_member" });
    expect((await as(legacy, "POST", `/api/chat/channels/${id}/join`)).json()).toMatchObject({ isMember: true, canWrite: true });
    expect((await post(legacy, id, "dentro")).statusCode).toBe(201);
    expect((await as(legacy, "DELETE", `/api/chat/channels/${id}/join`)).json()).toMatchObject({ isMember: false });
    expect((await as(legacy, "POST", `/api/chat/channels/${(await general()).id}/join`)).statusCode).toBe(409);
  });
});

describe("messaggi e thread", () => {
  it("un thread ha un livello; modifica ed eliminazione solo dei propri; un eliminato non ha testo", async () => {
    const id = await channel();
    await as(lead, "POST", `/api/chat/channels/${id}/join`);
    const root = (await post(dev, id, "radice")).json() as { id: string };
    const reply = (await post(lead, id, "risposta", root.id)).json() as { id: string };
    expect((await post(lead, id, "risposta a una risposta", reply.id)).json()).toMatchObject({ code: "invalid_thread" });
    const thread = (await as(dev, "GET", `/api/chat/messages/${reply.id}/thread`)).json() as {
      root: { id: string; replyCount: number; replyParticipantIds: string[] };
      replies: unknown[];
    };
    expect(thread.root).toMatchObject({ id: root.id, replyCount: 1, replyParticipantIds: [lead.id] });
    expect(thread.replies).toHaveLength(1);
    // La pagina del canale ha solo le radici.
    const page = (await as(dev, "GET", `/api/chat/channels/${id}/messages`)).json() as { items: { id: string }[] };
    expect(page.items.map((m) => m.id)).toEqual([root.id]);
    expect((await as(lead, "PATCH", `/api/chat/messages/${root.id}`, { text: "non mio" })).json()).toMatchObject({ code: "not_yours" });
    expect((await as(lead, "DELETE", `/api/chat/messages/${root.id}`)).statusCode).toBe(403);
    expect((await as(dev, "PATCH", `/api/chat/messages/${root.id}`, { text: "radice, corretta" })).json()).toMatchObject({
      text: "radice, corretta",
      canEdit: true,
    });
    expect((await as(dev, "DELETE", `/api/chat/messages/${root.id}`)).statusCode).toBe(204);
    const [row] = await t.db.select().from(chatMessages).where(eq(chatMessages.id, root.id));
    expect(row!.body).toBe("");
    expect((await as(lead, "GET", `/api/chat/messages/${root.id}`)).json()).toMatchObject({ deleted: true, text: "", canEdit: false });
  });

  it("reazioni: un toggle", async () => {
    const id = await channel();
    const m = (await post(dev, id, "reagisci")).json() as { id: string };
    const on = (await as(dev, "POST", `/api/chat/messages/${m.id}/reactions/toggle`, { emoji: "👍" })).json() as { reactions: unknown[] };
    expect(on.reactions).toEqual([{ emoji: "👍", personIds: [dev.id] }]);
    const off = (await as(dev, "POST", `/api/chat/messages/${m.id}/reactions/toggle`, { emoji: "👍" })).json() as { reactions: unknown[] };
    expect(off.reactions).toEqual([]);
  });

  it("non letti, letto, e lo stream vede ciò che cambia dopo il cursore", async () => {
    const id = await channel();
    await as(lead, "POST", `/api/chat/channels/${id}/join`);
    const first = (await post(dev, id, "uno")).json() as { id: string };
    await post(dev, id, "due");
    expect((await as(lead, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ unread: 2 });
    expect((await as(lead, "POST", `/api/chat/channels/${id}/read`, {})).statusCode).toBe(204);
    expect((await as(lead, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ unread: 0 });
    const viewer = { id: lead.id, instancePermissions: new Set<never>() };
    // Senza cursore lo stream non rimanda la storia (la carica la pagina): parte da adesso.
    const seen = new Map<string, string>();
    const start = await changedSince(t.db, viewer, id, undefined, seen);
    expect(start!.messages).toEqual([]);
    await new Promise((r) => setTimeout(r, 15));
    await as(dev, "POST", `/api/chat/messages/${first.id}/reactions/toggle`, { emoji: "🎉" });
    const after = await changedSince(t.db, viewer, id, start!.cursor ?? undefined, seen);
    expect(after!.messages.map((m) => m.id)).toEqual([first.id]);
  });
});

describe("menzioni", () => {
  it("@Nome di chi legge il canale: una card chat.mention, derivata a lettura; @channel no; chi non legge no", async () => {
    const g = await general();
    const res = await post(dev, g.id, "Ciao @lead-chat, e @outsider-chat, e @channel, e io @dev-chat");
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { mentionedIds: string[] }).mentionedIds).toEqual([lead.id]);
    const cards = await t.db.select().from(notifications).where(and(eq(notifications.userId, lead.id), eq(notifications.kind, "chat.mention")));
    expect(cards).toHaveLength(1);
    expect(await t.db.select().from(notifications).where(eq(notifications.userId, outsider.id))).toEqual([]);
    const inbox = (await as(lead, "GET", "/api/inbox")).json() as { items: { kind: string; chat: unknown; objectGone: boolean; url?: string }[] };
    const card = inbox.items.find((i) => i.kind === "chat.mention")!;
    expect(card.chat).toMatchObject({ channelId: g.id, channelName: "general", authorId: dev.id, authorName: "dev-chat" });
    expect(card.objectGone).toBe(false);
    expect(card.url).toContain(`/app/#/chat/${g.id}`);
    const mentions = (await as(lead, "GET", "/api/chat/mentions")).json() as { items: { id: string }[] };
    expect(mentions.items).toHaveLength(1);
    expect((await as(lead, "GET", "/api/chat/signal")).json()).toMatchObject({ hasNews: true });
    // Eliminato il messaggio, la card resta senza link e senza testo.
    await as(dev, "DELETE", `/api/chat/messages/${(res.json() as { id: string }).id}`);
    const after = (await as(lead, "GET", "/api/inbox")).json() as { items: { kind: string; chat: unknown; objectGone: boolean; url?: string }[] };
    const gone = after.items.find((i) => i.kind === "chat.mention")!;
    expect(gone).toMatchObject({ chat: null, objectGone: true });
    expect(gone.url).toBeUndefined();
  });

  it("chi è nominato in un thread lo segue; «Threads» mostra le risposte nuove", async () => {
    const g = await general();
    const root = (await post(dev, g.id, "una domanda")).json() as { id: string };
    await post(lead, g.id, "rispondo, @legacy-chat guarda", root.id);
    const news = (await as(dev, "GET", "/api/chat/threads")).json() as { items: { root: { id: string }; unreadReplies: number; latestReplies: unknown[] }[] };
    const item = news.items.find((i) => i.root.id === root.id)!;
    expect(item).toMatchObject({ unreadReplies: 1 });
    expect(item.latestReplies).toHaveLength(1);
    const forLegacy = (await as(legacy, "GET", `/api/chat/messages/${root.id}`)).json() as { following: boolean };
    expect(forLegacy.following).toBe(true);
    expect((await as(legacy, "PUT", `/api/chat/messages/${root.id}/follow`, { following: false })).json()).toMatchObject({ following: false });
  });
});

describe("eliminare il progetto", () => {
  it("porta via canali, messaggi e reazioni; la card della menzione resta senza link", async () => {
    const { projectId: other } = await seedRepository(t.db);
    await addMember(app, other, lead.id, "project_lead");
    await addMember(app, other, dev.id, "developer");
    const [g] = await t.db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.projectId, other), eq(chatChannels.isGeneral, true)));
    expect(g).toBeDefined();
    const created = await as(dev, "POST", "/api/chat/channels", { projectId: other, name: "da eliminare" });
    expect(created.statusCode, created.body).toBe(201);
    const msg = await post(dev, g!.id, "Per @lead-chat, prima che sparisca");
    expect(msg.statusCode, msg.body).toBe(201);
    const msgId = (msg.json() as { id: string }).id;
    await as(lead, "POST", `/api/chat/messages/${msgId}/reactions/toggle`, { emoji: "👍" });

    const del = await app.inject({ method: "DELETE", url: `/api/projects/${other}`, headers: { cookie: seeded.adminCookie } });
    expect(del.statusCode, del.body).toBe(204);

    expect(await t.db.select().from(chatChannels).where(eq(chatChannels.projectId, other))).toEqual([]);
    expect(await t.db.select().from(chatMessages).where(eq(chatMessages.id, msgId))).toEqual([]);
    const inbox = (await as(lead, "GET", "/api/inbox")).json() as {
      items: { kind: string; chat: { messageId: string } | null; objectGone: boolean; url?: string; id: string }[];
    };
    const cards = await t.db
      .select({ id: notifications.id, event: notifications.event })
      .from(notifications)
      .where(and(eq(notifications.userId, lead.id), eq(notifications.kind, "chat.mention")));
    const card = cards.find((c) => (c.event as { chatMessageId?: string }).chatMessageId === msgId);
    expect(card).toBeDefined();
    const orphan = inbox.items.find((i) => i.id === card!.id);
    expect(orphan, JSON.stringify(inbox.items)).toMatchObject({ chat: null, objectGone: true });
    expect(orphan!.url).toBeUndefined();
  });
});

describe("registro", () => {
  it("le rotte della Chat dichiarano tutte l'accesso (il test di registro le copre) e il seed ha un general", async () => {
    expect(seeded.adminId).toBeTruthy();
    expect((await general()).id).toBeTruthy();
  });
});
