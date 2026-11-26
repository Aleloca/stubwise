import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatChannels, chatMessages, chatThreadFollows, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { citeablesFor } from "../chat/citations.js";
import { listChannels, mentionsOf, questionsOf, searchChat, signalOf, threadsWithNews } from "../chat/service.js";

// La Chat, review della fetta 2 (11 nov 2026), punto 7: niente N+1. Ogni
// lettura fa lo STESSO numero di query con due progetti e con quattro.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let viewer: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  lead = await createUserWithSession(app, "lead-n1@example.com");
  viewer = await createUserWithSession(app, "viewer-n1@example.com");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: U, method: "POST", url: string, payload: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, payload: payload as Record<string, unknown> });

/** Il db con un contatore delle query: ogni builder (`select`, `execute`…) è una query. */
function counting(db: Db): { db: Db; count: () => number } {
  let n = 0;
  const counted = new Set(["select", "selectDistinct", "execute", "insert", "update", "delete"]);
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && counted.has(prop)) {
        return (...args: unknown[]) => {
          n += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { db: proxy, count: () => n };
}

/** Un progetto con il suo «general»: un thread seguito con novità, una menzione con domanda, una risposta di Claude. */
async function addProject(): Promise<void> {
  const { projectId } = await seedRepository(t.db);
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, viewer.id, "developer");
  const [g] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  const [root] = await t.db.insert(chatMessages).values({ channelId: g!.id, authorId: viewer.id, body: "il mio thread" }).returning({ id: chatMessages.id });
  await t.db.insert(chatThreadFollows).values({ userId: viewer.id, rootMessageId: root!.id, following: true });
  await t.db.insert(chatMessages).values({ channelId: g!.id, authorId: lead.id, body: "una novità", threadRootId: root!.id });
  const res = await as(lead, "POST", `/api/chat/channels/${g!.id}/messages`, { text: "@viewer-n1 ci sei?" });
  expect(res.statusCode, res.body).toBe(201);
  await t.db
    .insert(chatMessages)
    .values({ channelId: g!.id, kind: "claude", body: "zibaldone di Claude", searchFolded: "zibaldone di claude", threadRootId: root!.id, calledById: lead.id, claudeState: "done" });
}

const v = () => ({ id: viewer.id, instancePermissions: new Set<never>() });
const reads: [string, (db: Db) => Promise<unknown>][] = [
  ["listChannels", (db) => listChannels(db, v(), { archived: false })],
  ["threadsWithNews", (db) => threadsWithNews(db, v())],
  ["mentionsOf", (db) => mentionsOf(db, v())],
  ["questionsOf", (db) => questionsOf(db, v())],
  ["signalOf", (db) => signalOf(db, v())],
  ["searchChat", (db) => searchChat(db, v(), "zibaldone", {})],
];

async function measure(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, read] of reads) {
    const c = counting(t.db);
    await read(c.db);
    out[name] = c.count();
  }
  return out;
}

describe("niente N+1 nelle letture della Chat", () => {
  it("con due progetti e con quattro, le stesse query", async () => {
    await addProject();
    await addProject();
    const two = await measure();
    // Controllo di senso: le letture trovano davvero i dati di entrambi.
    expect(((await threadsWithNews(t.db, v())) as unknown[]).length).toBe(2);
    expect((await searchChat(t.db, v(), "zibaldone", {})).length).toBe(2);
    await addProject();
    await addProject();
    const four = await measure();
    expect((await searchChat(t.db, v(), "zibaldone", {})).length).toBe(4);
    expect(four).toEqual(two);
  });

  it("citeablesFor senza riferimenti non legge i progetti visibili", async () => {
    const c = counting(t.db);
    await citeablesFor(c.db, v(), []);
    expect(c.count()).toBe(0);
    await citeablesFor(c.db, v(), [{ kind: "person", id: viewer.id }]);
    expect(c.count()).toBe(1);
  });

  it("signalOf non costruisce le viste dei thread per un booleano", async () => {
    // Canali letti: niente menzioni, il segnale viene dai thread seguiti.
    for (const ch of await listChannels(t.db, v(), { archived: false })) {
      const read = await app.inject({ method: "POST", url: `/api/chat/channels/${ch.id}/read`, headers: { cookie: viewer.headers.cookie }, payload: {} });
      expect(read.statusCode).toBe(204);
    }
    expect((await signalOf(t.db, v())).mentions).toBe(0);
    const signal = counting(t.db);
    expect((await signalOf(signal.db, v())).hasNews).toBe(true);
    const list = counting(t.db);
    await listChannels(list.db, v(), { archived: false });
    const threads = counting(t.db);
    await threadsWithNews(threads.db, v());
    // Oggi signalOf = l'elenco dei canali + threadsWithNews con le viste: deve costare meno.
    expect(signal.count()).toBeLessThan(list.count() + threads.count());
  });
});
