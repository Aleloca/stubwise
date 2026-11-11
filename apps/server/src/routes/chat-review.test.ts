import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { chatChannelMembers, chatChannels, chatMessageCitations, chatMessages, chatThreadFollows, notifications } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { changedSince } from "../chat/service.js";
import { stillNamed } from "../chat/citations.js";

// La Chat, le correzioni delle review delle fette 1 e 2 (10 nov 2026): ogni
// test è nato rosso sul difetto che la review ha trovato.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let dev2: U;
let ale: U;
let aleLoca: U;
let outsider: U;
let w1: U;
let w2: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-rv@example.com");
  dev = await createUserWithSession(app, "dev-rv@example.com");
  dev2 = await createUserWithSession(app, "dev2-rv@example.com");
  outsider = await createUserWithSession(app, "outsider-rv@example.com");
  w1 = await createUserWithSession(app, "w1-rv@example.com");
  w2 = await createUserWithSession(app, "w2-rv@example.com");
  ale = await createUserWithSession(app, "ale-rv@example.com");
  aleLoca = await createUserWithSession(app, "aleloca-rv@example.com");
  await t.db.execute(sql`update users set display_name = 'Ale' where id = ${ale.id}`);
  await t.db.execute(sql`update users set display_name = 'Ale Loca' where id = ${aleLoca.id}`);
  await addMember(app, projectId, lead.id, "project_lead");
  for (const u of [dev, dev2, ale, aleLoca, w1, w2]) await addMember(app, projectId, u.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: U, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const post = (u: U, channelId: string, text: string, extra: Record<string, unknown> = {}) =>
  as(u, "POST", `/api/chat/channels/${channelId}/messages`, { text, ...extra });
const idOf = (res: { json: () => unknown }) => (res.json() as { id: string }).id;
const viewerOf = (u: U) => ({ id: u.id, instancePermissions: new Set<never>() });

async function general(): Promise<string> {
  const [row] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  return row!.id;
}
let n = 0;
const openChannel = async (by: U, extra: Record<string, unknown> = {}) =>
  idOf(await as(by, "POST", "/api/chat/channels", { projectId, name: `canale ${++n}`, ...extra }));

/**
 * Due uscite che leggono i membri INSIEME: una transazione esterna tiene il
 * lock sulle righe dei membri che escono, così entrambe le richieste leggono
 * il conteggio di prima e si fermano sulla DELETE; poi la si rilascia.
 */
async function raceLeaves(channelId: string, leavers: U[]): Promise<number[]> {
  const holder = t.client;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const held = holder.begin(async (tx) => {
    await tx`select 1 from chat_channel_members where channel_id = ${channelId} and user_id in ${tx(leavers.map((l) => l.id))} for update`;
    await released;
  });
  // Le richieste partono e aspettano il lock.
  await new Promise((r) => setTimeout(r, 50));
  const requests = leavers.map((l) => as(l, "DELETE", `/api/chat/channels/${channelId}/join`));
  for (let i = 0; i < 100; i++) {
    const [row] = await holder`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
    if ((row as { n: number }).n >= 1) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 100));
  release();
  await held;
  return (await Promise.all(requests)).map((r) => r.statusCode);
}

describe("review fetta 2", () => {
  it("1. due uscite insieme da un DM a 4: la chiave segue chi resta, e chi è uscito ritrova il DM degli altri", async () => {
    const dm = idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [dev2.id, w1.id, w2.id] }));
    await raceLeaves(dm, [w1, w2]);
    const [row] = await t.db.select({ key: chatChannels.dmKey }).from(chatChannels).where(eq(chatChannels.id, dm));
    expect(row!.key).toBe([dev.id, dev2.id].sort().join(","));
    expect(idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [dev2.id] }))).toBe(dm);
  });

  it("1. un privato a due: due uscite insieme non lo lasciano vuoto", async () => {
    const id = await openChannel(w1, { visibility: "private", memberIds: [w2.id] });
    const codes = await raceLeaves(id, [w1, w2]);
    expect(codes.sort()).toEqual([204, 409]);
    const members = await t.db.select().from(chatChannelMembers).where(eq(chatChannelMembers.channelId, id));
    expect(members).toHaveLength(1);
  });

  it("1. openDm ritrova un DM solo se le persone sono esattamente quelle", async () => {
    const dm = idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [outsider.id] }));
    // Una chiave rimasta indietro (dati vecchi, una corsa) non deve aprire il DM sbagliato.
    await t.db.insert(chatChannelMembers).values({ channelId: dm, userId: lead.id });
    const other = idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [outsider.id] }));
    expect(other).not.toBe(dm);
  });

  it("2. il nome di un privato non dice che esiste: 409 solo fra i canali non privati", async () => {
    await openChannel(lead, { visibility: "private", name: "hiring-plan" });
    expect((await as(dev, "POST", "/api/chat/channels", { projectId, name: "hiring-plan" })).statusCode).toBe(201);
    expect((await as(dev2, "POST", "/api/chat/channels", { projectId, name: "hiring-plan" })).json()).toMatchObject({ code: "name_taken" });
    expect((await as(dev2, "POST", "/api/chat/channels", { projectId, name: "hiring-plan", visibility: "private" })).statusCode).toBe(201);
    await as(dev, "POST", "/api/chat/channels", { name: "segreto-generale", visibility: "private" });
    expect((await as(dev2, "POST", "/api/chat/channels", { name: "segreto-generale" })).statusCode).toBe(201);
  });

  it("3. una menzione in un DM: «in a direct message», non «in #»", async () => {
    const dm = idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [dev2.id] }));
    await post(dev, dm, "@dev2-rv ci sei?");
    const inbox = (await as(dev2, "GET", "/api/inbox")).json() as { items: { kind: string; text: string }[] };
    const card = inbox.items.find((i) => i.kind === "chat.question")!;
    expect(card.text).toContain("direct message");
    expect(card.text).not.toContain("#");
  });
});

describe("review fetta 1", () => {
  it("1. «Mark unread from here»: un `at` più vecchio riporta indietro il segno; senza `at`, l'ultimo messaggio", async () => {
    const id = await openChannel(dev);
    await as(lead, "POST", `/api/chat/channels/${id}/join`);
    const first = (await post(dev, id, "uno")).json() as { createdAt: string };
    await post(dev, id, "due");
    await as(lead, "POST", `/api/chat/channels/${id}/read`, {});
    expect((await as(lead, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ unread: 0 });
    const before = new Date(Date.parse(first.createdAt) - 1).toISOString();
    await as(lead, "POST", `/api/chat/channels/${id}/read`, { at: before });
    expect((await as(lead, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ unread: 2 });
    // Senza `at`: fino all'ultimo messaggio, non all'ora del server.
    await as(lead, "POST", `/api/chat/channels/${id}/read`, {});
    const [last] = await t.db
      .select({ at: chatMessages.createdAt })
      .from(chatMessages)
      .where(eq(chatMessages.channelId, id))
      .orderBy(sql`created_at desc`)
      .limit(1);
    expect((await as(lead, "GET", `/api/chat/channels/${id}`)).json()).toMatchObject({ lastReadAt: last!.at.toISOString() });
  });

  it("2-3. lo stream senza cursore non rimanda la storia; con la finestra di sovrapposizione non perde e non ripete", async () => {
    const id = await openChannel(dev);
    await post(dev, id, "storia");
    const seen = new Map<string, string>();
    const start = await changedSince(t.db, viewerOf(dev), id, undefined, seen);
    expect(start!.messages).toEqual([]);
    expect(start!.cursor).toMatch(/^\d+$/);
    // Un messaggio con `updated_at` PRIMA del cursore (una transazione partita prima e committata dopo).
    const late = idOf(await post(dev, id, "in ritardo"));
    await t.db.update(chatMessages).set({ updatedAt: sql`to_timestamp(${String(Number(start!.cursor) / 1e6)}::double precision - 1)` }).where(eq(chatMessages.id, late));
    const next = await changedSince(t.db, viewerOf(dev), id, start!.cursor!, seen);
    // Il primo giro rimanda la finestra (anche «storia», che il client ha già dalla pagina).
    expect(next!.messages.map((m) => m.id)).toContain(late);
    const again = await changedSince(t.db, viewerOf(dev), id, next!.cursor!, seen);
    expect(again!.messages).toEqual([]);
  });

  it("4. nessuna modifica né eliminazione in un archiviato; la modifica solo da membro; seguire solo da membro", async () => {
    const id = await openChannel(dev);
    const msg = idOf(await post(dev, id, "prima"));
    await as(dev, "DELETE", `/api/chat/channels/${id}/join`);
    expect((await as(dev, "PATCH", `/api/chat/messages/${msg}`, { text: "da fuori" })).statusCode).toBe(403);
    expect((await as(outsider, "PUT", `/api/chat/messages/${msg}/follow`, { following: true })).statusCode).toBe(404);
    expect((await as(dev2, "PUT", `/api/chat/messages/${msg}/follow`, { following: true })).statusCode).toBe(403);
    await as(dev, "POST", `/api/chat/channels/${id}/join`);
    await as(lead, "PATCH", `/api/chat/channels/${id}`, { archived: true });
    expect((await as(dev, "PATCH", `/api/chat/messages/${msg}`, { text: "nell'archivio" })).json()).toMatchObject({ code: "channel_archived" });
    expect((await as(dev, "DELETE", `/api/chat/messages/${msg}`)).json()).toMatchObject({ code: "channel_archived" });
  });

  it("6. «@Ale Loca» non avvisa anche «Ale»; «@Ale» da solo sì", async () => {
    const g = await general();
    const both = await post(dev, g, "Ciao @Ale Loca, e poi @Ale.");
    expect((both.json() as { mentionedIds: string[] }).mentionedIds.sort()).toEqual([ale.id, aleLoca.id].sort());
    const onlyLong = await post(dev, g, "Ciao @Ale Loca, come va");
    expect((onlyLong.json() as { mentionedIds: string[] }).mentionedIds).toEqual([aleLoca.id]);
  });

  it("minori: cursore di pagina e `after` validati (400, non 500 né un giro infinito)", async () => {
    const id = await openChannel(dev);
    expect((await as(dev, "GET", `/api/chat/channels/${id}/messages?before=${encodeURIComponent("123|non-un-uuid")}`)).statusCode).toBe(400);
    expect((await as(dev, "GET", `/api/chat/channels/${id}/stream?after=99999999999999999999`)).statusCode).toBe(400);
  });

  it("minori: il cursore di pagina non perde i microsecondi", async () => {
    const id = await openChannel(dev);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(idOf(await post(dev, id, `m${i}`)));
    // Due messaggi nello stesso millisecondo, microsecondi diversi.
    await t.db.execute(sql`update chat_messages set created_at = '2026-11-10 10:00:00.000100+00' where id = ${ids[0]}`);
    await t.db.execute(sql`update chat_messages set created_at = '2026-11-10 10:00:00.000200+00' where id = ${ids[1]}`);
    await t.db.execute(sql`update chat_messages set created_at = '2026-11-10 10:00:00.000300+00' where id = ${ids[2]}`);
    const page1 = (await as(dev, "GET", `/api/chat/channels/${id}/messages?limit=1`)).json() as { items: { id: string }[]; before: string };
    const page2 = (await as(dev, "GET", `/api/chat/channels/${id}/messages?limit=1&before=${encodeURIComponent(page1.before)}`)).json() as { items: { id: string }[]; before: string };
    const page3 = (await as(dev, "GET", `/api/chat/channels/${id}/messages?limit=1&before=${encodeURIComponent(page2.before)}`)).json() as { items: { id: string }[] };
    expect([page1.items[0]!.id, page2.items[0]!.id, page3.items[0]!.id]).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("minori: eliminare una risposta avanza la radice", async () => {
    const id = await openChannel(dev);
    const root = idOf(await post(dev, id, "radice"));
    const reply = idOf(await post(dev, id, "risposta", { threadRootId: root }));
    const [before] = await t.db.select({ at: chatMessages.updatedAt }).from(chatMessages).where(eq(chatMessages.id, root));
    await new Promise((r) => setTimeout(r, 5));
    await as(dev, "DELETE", `/api/chat/messages/${reply}`);
    const [after] = await t.db.select({ at: chatMessages.updatedAt }).from(chatMessages).where(eq(chatMessages.id, root));
    expect(after!.at.getTime()).toBeGreaterThan(before!.at.getTime());
  });

  it("minori: una menzione tolta e rimessa non manda una seconda card; chi è nominato con una modifica segue il thread", async () => {
    const id = await openChannel(dev);
    const root = idOf(await post(dev, id, "radice"));
    const reply = idOf(await post(dev, id, "risposta", { threadRootId: root }));
    await as(dev, "PATCH", `/api/chat/messages/${reply}`, { text: "ora @dev2-rv" });
    await as(dev, "PATCH", `/api/chat/messages/${reply}`, { text: "senza nomi" });
    await as(dev, "PATCH", `/api/chat/messages/${reply}`, { text: "di nuovo @dev2-rv" });
    const cards = await t.db.select().from(notifications).where(and(eq(notifications.userId, dev2.id), eq(notifications.kind, "chat.mention")));
    expect(cards.filter((c) => (c.event as { chatMessageId?: string }).chatMessageId === reply)).toHaveLength(1);
    const follows = await t.db.select().from(chatThreadFollows).where(and(eq(chatThreadFollows.userId, dev2.id), eq(chatThreadFollows.rootMessageId, root)));
    expect(follows).toHaveLength(1);
  });

  it("minori: gli ex membri del progetto non compaiono fra i membri di un canale", async () => {
    const gone = await createUserWithSession(app, "gone-rv@example.com");
    await addMember(app, projectId, gone.id, "developer");
    const id = await openChannel(dev);
    await as(gone, "POST", `/api/chat/channels/${id}/join`);
    await t.db.execute(sql`delete from project_members where user_id = ${gone.id}`);
    expect(((await as(dev, "GET", `/api/chat/channels/${id}`)).json() as { memberIds: string[] }).memberIds).not.toContain(gone.id);
  });
});

describe("review fetta 2, seconda (11 nov 2026)", () => {
  it("1. un messaggio arrivato fra la pagina e l'apertura dello stream non si perde", async () => {
    const id = await openChannel(dev);
    // La pagina è letta; poi arriva un messaggio, poi lo stream si apre senza cursore.
    const between = idOf(await post(dev, id, "fra pagina e stream"));
    const seen = new Map<string, string>();
    const start = await changedSince(t.db, viewerOf(dev), id, undefined, seen);
    expect(start!.messages).toEqual([]);
    const next = await changedSince(t.db, viewerOf(dev), id, start!.cursor!, seen);
    expect(next!.messages.map((m) => m.id)).toContain(between);
    // Una volta mandato, non riparte.
    const again = await changedSince(t.db, viewerOf(dev), id, next!.cursor!, seen);
    expect(again!.messages.map((m) => m.id)).not.toContain(between);
  });

  it("6. con più di 500 righe nella finestra lo stream non si blocca", async () => {
    const id = await openChannel(dev);
    const [author] = [dev.id];
    await t.db.insert(chatMessages).values(Array.from({ length: 501 }, (_, i) => ({ channelId: id, authorId: author, body: `m${i}` })));
    const seen = new Map<string, string>();
    let cursor = (await changedSince(t.db, viewerOf(dev), id, undefined, seen))!.cursor!;
    const delivered = new Set<string>();
    let last = "";
    for (let tick = 0; tick < 6; tick++) {
      if (tick === 2) last = idOf(await post(dev, id, "dopo la folla"));
      const r = (await changedSince(t.db, viewerOf(dev), id, cursor, seen))!;
      for (const m of r.messages) delivered.add(m.id);
      cursor = r.cursor!;
    }
    expect(delivered.has(last)).toBe(true);
    expect(delivered.size).toBe(502);
  });

  it("2. una citazione resta solo se il testo nomina ANCORA l'oggetto, col suo confine", () => {
    const task = { kind: "task" as const, id: "t", label: "AUD-1", projectId: null };
    expect(stillNamed(task, "vedi AUD-1, grazie")).toBe(true);
    expect(stillNamed(task, "vedi AUD-12")).toBe(false);
    expect(stillNamed(task, "vedi XAUD-1")).toBe(false);
    const project = { kind: "project" as const, id: "p", label: "AUD", projectId: null };
    expect(stillNamed(project, "il progetto AUD")).toBe(true);
    expect(stillNamed(project, "la task AUD-12")).toBe(false);
    expect(stillNamed(project, "AUDIT")).toBe(false);
    const doc = { kind: "doc" as const, id: "d", label: "Sync", projectId: null };
    expect(stillNamed(doc, "leggi Sync.")).toBe(true);
    expect(stillNamed(doc, "leggi Syncing")).toBe(false);
    const person = { kind: "person" as const, id: "u", label: "Ale", projectId: null };
    expect(stillNamed(person, "ciao @Ale")).toBe(true);
    expect(stillNamed(person, "ciao @Alessio")).toBe(false);
  });

  it("3. «con citazioni» conta solo le citazioni che chi cerca vede", async () => {
    const contributor = await createUserWithSession(app, "contrib-rv@example.com");
    await addMember(app, projectId, contributor.id, "contributor");
    const g = await general();
    const { ticketId } = await seedTicket(t.db, { projectId, number: 77 });
    const msg = idOf(await post(dev, g, "nascosta citazionefantasma"));
    await t.db.insert(chatMessageCitations).values({ messageId: msg, kind: "task", refId: ticketId });
    const search = (u: U) => as(u, "GET", `/api/chat/search?q=citazionefantasma&withCitations=true`);
    const forDev = (await search(dev)).json() as { items: { message: { id: string } }[] };
    expect(forDev.items.map((h) => h.message.id)).toEqual([msg]);
    // Il Contributor legge il «general» ma non vede la task: il filtro non gli conferma che esiste.
    const forContributor = (await search(contributor)).json() as { items: unknown[] };
    expect(forContributor.items).toEqual([]);
  });
});
