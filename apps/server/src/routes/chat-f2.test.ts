import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { backlogJobs, chatChannels, chatMessages, docPages, notifications, projectMembers, projects, roles } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

// La Chat fra persone, area 4 fetta 2: DM (solo per chi partecipa, nemmeno il
// full admin), privati (chi gestisce li vede ma non li legge), generali
// d'istanza, conteggi per livello, domande in «Da decidere», ricerca, «anche
// nel canale», gli eliminati che spariscono dopo un giorno.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let seeded: SeededUsers;
let projectId: string;
let repositoryId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let dev2: U;
let legacy: U;
let outsider: U;
let admin: { id: string; headers: { cookie: string } };

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  seeded = await seedUsers(app);
  admin = { id: seeded.adminId, headers: { cookie: seeded.adminCookie } };
  ({ projectId, repositoryId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-f2@example.com");
  dev = await createUserWithSession(app, "dev-f2@example.com");
  dev2 = await createUserWithSession(app, "dev2-f2@example.com");
  legacy = await createUserWithSession(app, "legacy-f2@example.com");
  outsider = await createUserWithSession(app, "outsider-f2@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, dev2.id, "developer");
  await addMember(app, projectId, legacy.id, "legacy_member");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

type Who = U | typeof admin;
const as = (u: Who, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const post = (u: Who, channelId: string, text: string, extra: Record<string, unknown> = {}) =>
  as(u, "POST", `/api/chat/channels/${channelId}/messages`, { text, ...extra });
const idOf = (res: { json: () => unknown }) => (res.json() as { id: string }).id;
const channelIds = async (u: Who, query = "") =>
  ((await as(u, "GET", `/api/chat/channels${query}`)).json() as { items: { id: string }[] }).items.map((c) => c.id);

async function general(): Promise<string> {
  const [row] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  return row!.id;
}
let n = 0;
async function privateChannel(by: U, members: string[]): Promise<string> {
  const res = await as(by, "POST", "/api/chat/channels", { projectId, name: `riservato ${++n}`, visibility: "private", memberIds: members });
  expect(res.statusCode, res.body).toBe(201);
  return idOf(res);
}

describe("DM", () => {
  it("si ritrova con le stesse persone; esiste solo per chi partecipa, nemmeno per il full admin", async () => {
    const opened = await as(dev, "POST", "/api/chat/dm", { personIds: [lead.id] });
    expect(opened.statusCode, opened.body).toBe(200);
    const dm = opened.json() as { id: string; kind: string; memberIds: string[]; canLeave: boolean; canInvite: boolean };
    expect(dm).toMatchObject({ kind: "dm", canLeave: false, canInvite: false });
    expect(dm.memberIds.sort()).toEqual([dev.id, lead.id].sort());
    // Lo stesso DM, comunque le si nomini (con chi apre e coi doppioni).
    expect(idOf(await as(lead, "POST", "/api/chat/dm", { personIds: [dev.id, lead.id, dev.id] }))).toBe(dm.id);
    for (const who of [admin, outsider, dev2]) {
      expect((await as(who, "GET", `/api/chat/channels/${dm.id}`)).statusCode).toBe(404);
      expect(await channelIds(who)).not.toContain(dm.id);
    }
    const msg = await post(dev, dm.id, "ciao, una cosa veloce");
    expect(msg.statusCode, msg.body).toBe(201);
    expect((await as(admin, "GET", `/api/chat/messages/${idOf(msg)}`)).statusCode).toBe(404);
    expect((await as(admin, "GET", `/api/chat/channels/${dm.id}/messages`)).statusCode).toBe(404);
    // Un DM è per chi partecipa: conta fra le sue menzioni e accende il punto, senza card.
    expect((await as(lead, "GET", `/api/chat/channels/${dm.id}`)).json()).toMatchObject({ unread: 1, mentions: 1 });
    expect((await as(lead, "GET", "/api/chat/signal")).json()).toMatchObject({ hasNews: true });
    expect(await t.db.select().from(notifications).where(eq(notifications.userId, lead.id))).toEqual([]);
    // Un DM a due non si lascia.
    expect((await as(dev, "DELETE", `/api/chat/channels/${dm.id}/join`)).json()).toMatchObject({ code: "cannot_leave" });
  });

  it("da 2 a 8 persone; un gruppo si lascia, e chi resta ritrova il DM più vecchio", async () => {
    const tooMany = await as(dev, "POST", "/api/chat/dm", { personIds: [lead.id, dev2.id, legacy.id, outsider.id, admin.id, ...Array.from({ length: 3 }, () => crypto.randomUUID())] });
    expect(tooMany.statusCode).toBe(400);
    expect((await as(dev, "POST", "/api/chat/dm", { personIds: [crypto.randomUUID()] })).json()).toMatchObject({ code: "invalid_members" });
    const pair = idOf(await as(dev2, "POST", "/api/chat/dm", { personIds: [legacy.id] }));
    const group = await as(dev2, "POST", "/api/chat/dm", { personIds: [legacy.id, outsider.id] });
    expect(group.json()).toMatchObject({ canLeave: true });
    expect(idOf(group)).not.toBe(pair);
    expect((await as(outsider, "DELETE", `/api/chat/channels/${idOf(group)}/join`)).statusCode).toBe(204);
    expect((await as(outsider, "GET", `/api/chat/channels/${idOf(group)}`)).statusCode).toBe(404);
    expect(idOf(await as(legacy, "POST", "/api/chat/dm", { personIds: [dev2.id] }))).toBe(pair);
    // Senza un DM a due più vecchio, il gruppo rimasto in due È quel DM: la chiave segue chi resta.
    const trio = idOf(await as(lead, "POST", "/api/chat/dm", { personIds: [legacy.id, outsider.id] }));
    expect((await as(outsider, "DELETE", `/api/chat/channels/${trio}/join`)).statusCode).toBe(204);
    expect(idOf(await as(legacy, "POST", "/api/chat/dm", { personIds: [lead.id] }))).toBe(trio);
  });
});

describe("privati", () => {
  it("li leggono i membri; chi gestisce li vede ma non li legge; gli altri non li vedono", async () => {
    const id = await privateChannel(dev, [dev2.id]);
    await as(dev, "PATCH", `/api/chat/channels/${id}`, { topic: "riservato", description: "solo noi" });
    const msg = idOf(await post(dev, id, "segreto di progetto"));
    // Il Lead ha chat.channels.manage: vede nome e membri, non argomento, descrizione e messaggi (D2).
    expect((await as(lead, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({
      canRead: false,
      isMember: false,
      topic: "",
      description: "",
      lastMessageAt: null,
      canRemove: true,
      canDelete: true,
    });
    expect((await as(lead, "GET", `/api/chat/channels/${id}/messages`)).statusCode).toBe(404);
    expect((await as(lead, "GET", `/api/chat/messages/${msg}`)).statusCode).toBe(404);
    expect((await as(lead, "GET", `/api/chat/channels/${id}/stream`)).statusCode).toBe(404);
    expect((await as(lead, "PATCH", `/api/chat/channels/${id}`, { description: "riscritta" })).statusCode).toBe(403);
    // Il full admin gestisce ogni progetto: vede il privato, non lo legge.
    expect((await as(admin, "GET", `/api/chat/channels/${id}/messages`)).statusCode).toBe(404);
    for (const who of [legacy, outsider]) expect((await as(who, "GET", `/api/chat/channels/${id}`)).statusCode).toBe(404);
    expect(await channelIds(legacy)).not.toContain(id);
    expect((await as(dev2, "GET", `/api/chat/channels/${id}/messages`)).json()).toMatchObject({ items: [{ text: "segreto di progetto" }] });
  });

  it("invitare: il creatore sì, chi gestisce non sé stesso, mai chi non vede il progetto; togliere: mai l'ultimo", async () => {
    const id = await privateChannel(dev, []);
    expect((await as(lead, "POST", `/api/chat/channels/${id}/members`, { personIds: [lead.id] })).statusCode).toBe(403);
    expect((await as(dev, "POST", `/api/chat/channels/${id}/members`, { personIds: [outsider.id] })).json()).toMatchObject({ code: "invalid_members" });
    expect((await as(dev2, "POST", `/api/chat/channels/${id}/members`, { personIds: [dev2.id] })).statusCode).toBe(404);
    const invited = await as(dev, "POST", `/api/chat/channels/${id}/members`, { personIds: [legacy.id] });
    expect((invited.json() as { memberIds: string[] }).memberIds).toContain(legacy.id);
    // Un membro qualunque di un privato non invita: solo il creatore o chi gestisce.
    expect((await as(legacy, "POST", `/api/chat/channels/${id}/members`, { personIds: [dev2.id] })).statusCode).toBe(403);
    expect((await as(lead, "DELETE", `/api/chat/channels/${id}/members/${legacy.id}`)).statusCode).toBe(200);
    expect((await as(legacy, "GET", `/api/chat/channels/${id}`)).statusCode).toBe(404);
    expect((await as(lead, "DELETE", `/api/chat/channels/${id}/members/${dev.id}`)).json()).toMatchObject({ code: "last_member" });
    // Il creatore può uscire da un privato solo se resta qualcuno.
    expect((await as(dev, "DELETE", `/api/chat/channels/${id}/join`)).json()).toMatchObject({ code: "cannot_leave" });
  });

  it("chi esce dal progetto non vede più il privato di cui era membro", async () => {
    const leaving = await createUserWithSession(app, "leaving-f2@example.com");
    await addMember(app, projectId, leaving.id, "developer");
    const id = await privateChannel(dev, [leaving.id]);
    expect((await as(leaving, "GET", `/api/chat/channels/${id}`)).statusCode).toBe(200);
    await t.db.execute(sql`delete from project_members where user_id = ${leaving.id}`);
    expect((await as(leaving, "GET", `/api/chat/channels/${id}`)).statusCode).toBe(404);
  });
});

describe("generali d'istanza", () => {
  it("li crea chi ha chat.general.create; un aperto lo vedono tutti e ci si entra; nome unico", async () => {
    const res = await as(dev, "POST", "/api/chat/channels", { name: "Annunci" });
    expect(res.statusCode, res.body).toBe(201);
    const id = idOf(res);
    expect(res.json()).toMatchObject({ kind: "general", projectId: null, isGeneral: false, publishedEvents: [] });
    expect(await channelIds(outsider, "?kind=general")).toContain(id);
    expect((await as(outsider, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ canJoin: true, canWrite: false });
    expect((await as(outsider, "POST", `/api/chat/channels/${id}/join`)).json()).toMatchObject({ isMember: true, canWrite: true });
    expect((await as(dev2, "POST", "/api/chat/channels", { name: "annunci" })).json()).toMatchObject({ code: "name_taken" });
    // Un canale di progetto con lo stesso nome non si scontra.
    expect((await as(dev2, "POST", "/api/chat/channels", { projectId, name: "annunci" })).statusCode).toBe(201);
  });

  it("un privato generale: chi ha chat.general.manage lo vede ma non lo legge", async () => {
    const id = idOf(await as(dev, "POST", "/api/chat/channels", { name: "soci", visibility: "private", memberIds: [outsider.id] }));
    await post(outsider, id, "fra noi");
    expect((await as(admin, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ canRead: false, canDelete: true });
    expect((await as(admin, "GET", `/api/chat/channels/${id}/messages`)).statusCode).toBe(404);
    expect((await as(dev2, "GET", `/api/chat/channels/${id}`)).statusCode).toBe(404);
  });
});

describe("messaggi", () => {
  it("«anche nel canale»: la risposta entra nel flusso; su una radice è 400", async () => {
    const g = await general();
    const root = idOf(await post(dev, g, "radice per il flusso"));
    const reply = await post(dev2, g, "risposta per tutti", { threadRootId: root, alsoInChannel: true });
    expect(reply.json()).toMatchObject({ alsoInChannel: true, threadRootId: root });
    const quiet = idOf(await post(dev2, g, "risposta nel thread", { threadRootId: root }));
    const flow = ((await as(lead, "GET", `/api/chat/channels/${g}/messages?limit=200`)).json() as { items: { id: string }[] }).items.map((m) => m.id);
    expect(flow).toContain(idOf(reply));
    expect(flow).not.toContain(quiet);
    expect((await post(dev, g, "radice", { alsoInChannel: true })).json()).toMatchObject({ code: "invalid_also_in_channel" });
  });

  it("i non letti seguono il livello; @channel conta fra le menzioni (con «tutti») ma non dà card", async () => {
    const id = idOf(await as(dev, "POST", "/api/chat/channels", { projectId, name: "livelli" }));
    await as(lead, "POST", `/api/chat/channels/${id}/join`);
    await as(lead, "POST", `/api/chat/channels/${id}/read`, {});
    await post(dev, id, "traffico normale");
    await post(dev, id, "attenzione @channel");
    await post(dev, id, "per te @lead-f2");
    const view = async () => (await as(lead, "GET", `/api/chat/channels/${id}`)).json() as { unread: number; mentions: number };
    expect(await view()).toMatchObject({ unread: 3, mentions: 2 });
    await as(lead, "PUT", `/api/chat/channels/${id}/pref`, { level: "mentions" });
    expect(await view()).toMatchObject({ unread: 1, mentions: 1 });
    await as(lead, "PUT", `/api/chat/channels/${id}/pref`, { level: "muted" });
    expect(await view()).toMatchObject({ unread: 0, mentions: 1 });
    const cards = await t.db.select().from(notifications).where(and(eq(notifications.userId, lead.id), eq(notifications.kind, "chat.mention")));
    expect(cards).toHaveLength(1);
    const mentions = ((await as(lead, "GET", "/api/chat/mentions")).json() as { items: { text: string }[] }).items.map((m) => m.text);
    expect(mentions).toEqual(expect.arrayContaining(["attenzione @channel", "per te @lead-f2"]));
  });

  it("un eliminato senza risposte sparisce dopo un giorno; con risposte resta", async () => {
    const g = await general();
    const alone = idOf(await post(dev, g, "da sparire"));
    const withReply = idOf(await post(dev, g, "da tenere"));
    await post(dev2, g, "risposta viva", { threadRootId: withReply });
    await as(dev, "DELETE", `/api/chat/messages/${alone}`);
    await as(dev, "DELETE", `/api/chat/messages/${withReply}`);
    const ids = async () =>
      ((await as(lead, "GET", `/api/chat/channels/${g}/messages?limit=200`)).json() as { items: { id: string }[] }).items.map((m) => m.id);
    expect(await ids()).toEqual(expect.arrayContaining([alone, withReply]));
    await t.db
      .update(chatMessages)
      .set({ deletedAt: sql`now() - interval '2 days'` })
      .where(sql`${chatMessages.id} in (${alone}, ${withReply})`);
    const after = await ids();
    expect(after).not.toContain(alone);
    expect(after).toContain(withReply);
  });
});

describe("domande", () => {
  it("una domanda a un membro: card chat.question, in «Da decidere» finché non risponde o la ignora", async () => {
    const g = await general();
    const asked = await post(dev, g, "@lead-f2 ci sei domani?");
    expect(asked.json()).toMatchObject({ asksReplyOf: [lead.id] });
    const card = await t.db.select().from(notifications).where(and(eq(notifications.userId, lead.id), eq(notifications.kind, "chat.question")));
    expect(card).toHaveLength(1);
    const inbox = (await as(lead, "GET", "/api/inbox")).json() as { items: { kind: string; chat: unknown; objectGone: boolean }[] };
    expect(inbox.items.find((i) => i.kind === "chat.question")).toMatchObject({ objectGone: false, chat: { channelId: g } });
    const questions = async (u: U) => ((await as(u, "GET", "/api/chat/questions")).json() as { items: { messageId: string; rootId: string }[] }).items;
    expect(await questions(lead)).toEqual([expect.objectContaining({ messageId: idOf(asked), rootId: idOf(asked) })]);
    // Rispondere nel thread la chiude.
    await post(lead, g, "sì", { threadRootId: idOf(asked) });
    expect(await questions(lead)).toEqual([]);
    // «Ask for a reply» senza «?»; ignorarla la toglie; ignorarla due volte è 404.
    const forced = idOf(await post(dev, g, "@lead-f2 guarda il report", { asksReply: true }));
    expect((await questions(lead)).map((q) => q.messageId)).toEqual([forced]);
    expect((await as(lead, "POST", `/api/chat/questions/${forced}/dismiss`)).statusCode).toBe(204);
    expect(await questions(lead)).toEqual([]);
    expect((await as(lead, "POST", `/api/chat/questions/${forced}/dismiss`)).statusCode).toBe(404);
    // Una modifica che toglie il nome toglie la domanda.
    const edited = idOf(await post(dev, g, "@lead-f2 e questo?"));
    expect((await questions(lead)).map((q) => q.messageId)).toEqual([edited]);
    await as(dev, "PATCH", `/api/chat/messages/${edited}`, { text: "lascia stare?" });
    expect(await questions(lead)).toEqual([]);
  });

  it("a chi legge senza essere membro arriva una menzione, non una domanda; in un archiviato non si chiede", async () => {
    const id = idOf(await as(dev, "POST", "/api/chat/channels", { projectId, name: "domande" }));
    await post(dev, id, "@dev2-f2 tu che ne dici?");
    const kinds = (await t.db.select().from(notifications).where(eq(notifications.userId, dev2.id))).map((r) => r.kind);
    expect(kinds).toContain("chat.mention");
    expect(kinds).not.toContain("chat.question");
    await as(lead, "POST", `/api/chat/channels/${id}/join`);
    await post(dev, id, "@lead-f2 confermi?");
    expect((await as(lead, "GET", "/api/chat/questions")).json()).toMatchObject({ items: [expect.anything()] });
    await as(dev, "PATCH", `/api/chat/channels/${id}`, { archived: true });
    expect((await as(lead, "GET", "/api/chat/questions")).json()).toMatchObject({ items: [] });
  });
});

describe("ricerca", () => {
  it("ogni parola, senza maiuscole né accenti; mai gli eliminati, mai i privati altrui; gli archiviati sì", async () => {
    const g = await general();
    const hit = idOf(await post(dev, g, "Perché il RILASCIO è fermo?"));
    const deleted = idOf(await post(dev, g, "perche rilascio cancellato"));
    await as(dev, "DELETE", `/api/chat/messages/${deleted}`);
    const priv = await privateChannel(dev, []);
    await post(dev, priv, "perche rilascio riservato");
    const search = async (u: Who, q: string, extra = "") =>
      ((await as(u, "GET", `/api/chat/search?q=${encodeURIComponent(q)}${extra}`)).json() as { items: { message: { id: string; text: string }; context: unknown; root: unknown }[] }).items;
    const forLead = await search(lead, "perche rilascio");
    expect(forLead.map((h) => h.message.id)).toEqual([hit]);
    expect((await search(dev, "PERCHÉ rilascio")).map((h) => h.message.text)).toEqual(
      expect.arrayContaining(["perche rilascio riservato", "Perché il RILASCIO è fermo?"]),
    );
    expect(await search(lead, "x")).toEqual([]);
    expect(await search(outsider, "perche rilascio")).toEqual([]);
    expect((await search(lead, "perche rilascio", `&authorId=${dev2.id}`))).toEqual([]);
    // Una risposta porta la radice; un archiviato si cerca ancora.
    const root = idOf(await post(dev, g, "radice cercabile"));
    await post(dev2, g, "risposta zebrata", { threadRootId: root });
    const reply = await search(lead, "zebrata");
    expect(reply[0]).toMatchObject({ root: { id: root }, context: { id: root } });
    const archived = idOf(await as(dev, "POST", "/api/chat/channels", { projectId, name: "vecchio" }));
    await post(dev, archived, "giraffa archiviata");
    await as(dev, "PATCH", `/api/chat/channels/${archived}`, { archived: true });
    expect((await search(lead, "giraffa")).map((h) => h.message.text)).toEqual(["giraffa archiviata"]);
  });
});

describe("dal messaggio a Stubwise", () => {
  it("«Create task»: il messaggio mostra il codice a chi vede la task; un messaggio che non si legge o eliminato è 400", async () => {
    const contributor = await createUserWithSession(app, "contributor-f2@example.com");
    await addMember(app, projectId, contributor.id, "contributor");
    const g = await general();
    const msg = idOf(await post(dev, g, "qui serve una task"));
    const created = await as(dev, "POST", "/api/tasks", { projectId, title: "Nata in chat", type: "activity", chatMessageId: msg });
    expect(created.statusCode, created.body).toBe(201);
    const code = (created.json() as { code: string }).code;
    expect((await as(dev, "GET", `/api/chat/messages/${msg}`)).json()).toMatchObject({ linkedCodes: [code], linked: [{ kind: "task", code }] });
    // Il Contributor legge il canale ma non vede la task altrui (niente tickets.view_all): il codice non esce.
    expect((await as(contributor, "GET", `/api/chat/messages/${msg}`)).json()).toMatchObject({ linkedCodes: [], linked: [] });
    // Un privato di cui non è membro, un messaggio eliminato: come un messaggio che non c'è.
    const priv = await privateChannel(dev2, []);
    const hidden = idOf(await post(dev2, priv, "solo mio"));
    expect((await as(dev, "POST", "/api/tasks", { projectId, title: "x", type: "activity", chatMessageId: hidden })).json()).toMatchObject({
      code: "chat_message_not_found",
    });
    await as(dev, "DELETE", `/api/chat/messages/${msg}`);
    expect((await as(dev, "POST", "/api/tasks", { projectId, title: "y", type: "activity", chatMessageId: msg })).statusCode).toBe(400);
    expect((await as(dev, "GET", `/api/chat/messages/${msg}`)).json()).toMatchObject({ linkedCodes: [] });
  });

  it("«Create request»: il messaggio viaggia nel job dell'intake; uno che non si legge è 400", async () => {
    const g = await general();
    const msg = idOf(await post(dev, g, "e qui una richiesta"));
    const res = await as(dev, "POST", "/api/requests", { projectId, title: "Esportare", description: "csv", chatMessageId: msg });
    expect(res.statusCode, res.body).toBe(202);
    const [job] = await t.db.select().from(backlogJobs).where(eq(backlogJobs.id, (res.json() as { jobId: string }).jobId));
    expect(job!.payload).toMatchObject({ chatMessageId: msg, requestedByUserId: dev.id });
    const priv = await privateChannel(dev2, []);
    const hidden = idOf(await post(dev2, priv, "solo mio"));
    expect((await as(dev, "POST", "/api/requests", { projectId, title: "x", chatMessageId: hidden })).json()).toMatchObject({
      code: "chat_message_not_found",
    });
  });
});

describe("citazioni (F2.7, decisione del maintainer)", () => {
  type Cit = { kind: string; id: string; label: string };
  const citationsOf = async (u: Who, id: string) =>
    ((await as(u, "GET", `/api/chat/messages/${id}`)).json() as { citations: Cit[] }).citations;

  it("si tengono le scelte che chi scrive vede e che il testo nomina; un codice scritto a mano diventa link; chi legge vede solo ciò che vede", async () => {
    const contributor = await createUserWithSession(app, "contributor2-f2@example.com");
    await addMember(app, projectId, contributor.id, "contributor");
    const [project] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    const task = (await as(dev, "POST", "/api/tasks", { projectId, title: "Da citare", type: "activity" })).json() as { id: string; code: string };
    const [page] = await t.db
      .insert(docPages)
      .values({ repositoryId, kind: "technical", slug: `pagina-${n}`, title: "Guida al rilascio" })
      .returning({ id: docPages.id });
    const g = await general();
    const sent = await post(dev, g, `Per @lead-f2: guarda ${task.code}, la Guida al rilascio e il progetto ${project!.code}`, {
      citations: [
        { kind: "person", id: lead.id },
        { kind: "doc", id: page!.id },
        { kind: "project", id: projectId },
        // Scelta ma non più nel testo: non resta.
        { kind: "person", id: dev2.id },
        // Non esiste: non resta.
        { kind: "doc", id: crypto.randomUUID() },
      ],
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const id = idOf(sent);
    expect((await citationsOf(lead, id)).map((c) => [c.kind, c.label])).toEqual([
      ["person", "lead-f2"],
      ["doc", "Guida al rilascio"],
      ["project", project!.code],
      ["task", task.code],
    ]);
    // Il Contributor non vede la task altrui: la sua citazione non esce, il resto sì.
    expect((await citationsOf(contributor, id)).map((c) => c.kind)).toEqual(["person", "doc", "project"]);
    // Chi legge senza docs.view non vede la pagina citata (un ruolo su misura: tutti i preset ce l'hanno).
    const [noDocs] = await t.db
      .insert(roles)
      .values({ name: "Senza Docs", scope: "project", permissions: ["tickets.view_all", "tickets.create"] })
      .returning({ id: roles.id });
    const reader = await createUserWithSession(app, "nodocs-f2@example.com");
    await t.db.insert(projectMembers).values({ projectId, userId: reader.id, roleId: noDocs!.id });
    // …ma con docs.view in un ALTRO progetto: il filtro deve guardare il progetto della pagina.
    const { projectId: elsewhere } = await seedRepository(t.db);
    await addMember(app, elsewhere, reader.id, "contributor");
    expect((await citationsOf(reader, id)).map((c) => c.kind)).toEqual(["person", "project", "task"]);
    // Un codice che chi scrive non vede resta testo.
    const fromContributor = idOf(await post(contributor, g, `e ${task.code}?`, { citations: [{ kind: "task", id: task.id }] }));
    expect(await citationsOf(lead, fromContributor)).toEqual([]);
    // La ricerca: «con citazioni».
    const withCitations = ((await as(lead, "GET", `/api/chat/search?q=${encodeURIComponent(task.code)}&withCitations=true`)).json() as {
      items: { message: { id: string } }[];
    }).items.map((h) => h.message.id);
    expect(withCitations).toContain(id);
    expect(withCitations).not.toContain(fromContributor);
    // Alla modifica si ricalcolano dal testo nuovo; un eliminato non ne ha.
    await as(dev, "PATCH", `/api/chat/messages/${id}`, { text: "Per @lead-f2: lascia stare" });
    expect((await citationsOf(lead, id)).map((c) => c.kind)).toEqual(["person"]);
    await as(dev, "DELETE", `/api/chat/messages/${id}`);
    expect(await citationsOf(lead, id)).toEqual([]);
  });
});
