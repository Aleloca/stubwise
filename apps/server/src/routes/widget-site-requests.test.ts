import { createHmac, randomUUID } from "node:crypto";
import { backlogItems, comments, decrypt, encrypt, projects, tickets, widgetConversations, widgetMessages, widgets, type Db } from "@stubwise/db";
import { seedBacklogItem, seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { siteRequestDetailSchema, siteRequestListSchema } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { generateWidgetIdentitySecret } from "../auth/widget-identity.js";

/**
 * Area 8, «L'API per i siti» (S4, S4b): il cliente FIRMATO dal sito legge le
 * sue richieste e i suoi ticket, e il dettaglio con la SUA conversazione col
 * widget. Solo le conversazioni verificate del suo `sub`, sul canale
 * `widget`, con un esito. Mai il testo del team, mai codici o titoli interni.
 * I NEGATIVI sono il punto.
 */

const KEY = Buffer.alloc(32, 5);
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let ticketNumber = 5000;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64") });
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function sign(secret: string, payload: Record<string, unknown>): string {
  const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" });
  const body = b(payload);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

async function site(language: "it" | "en" = "it", projectId?: string) {
  const pid = projectId ?? (await seedRepository(db)).projectId;
  const [p] = await db.select({ slug: projects.slug, code: projects.code }).from(projects).where(eq(projects.id, pid));
  const secret = generateWidgetIdentitySecret();
  const [w] = await db.insert(widgets).values({ projectId: pid, name: "Sito", key: `k-${randomUUID()}`, enabled: true, language, identitySecretEncrypted: encrypt(secret, KEY) }).returning();
  const now = Math.floor(Date.now() / 1000);
  const token = (sub: string) => sign(secret, { sub, aud: w!.id, iat: now - 5, exp: now + 600 });
  const get = (path: string, sub?: string) =>
    app.inject({ method: "GET", url: `/widget/${p!.slug}/me/requests${path}`, headers: { "x-stubwise-key": w!.key, ...(sub ? { authorization: `Bearer ${token(sub)}` } : {}) } });
  /** Una conversazione del widget, coi messaggi `[ruolo, testo]`. */
  async function conversation(sub: string, msgs: [string, string][], over: Partial<typeof widgetConversations.$inferInsert> = {}) {
    const [c] = await db.insert(widgetConversations).values({ projectId: pid, widgetId: w!.id, externalUserId: sub, identityVerified: true, ...over }).returning();
    let t = Date.UTC(2026, 10, 16, 9, 0);
    for (const [role, content] of msgs) await db.insert(widgetMessages).values({ conversationId: c!.id, role, content, createdAt: new Date((t += 60_000)) });
    return { id: c!.id, code: `${p!.code}-S${c!.number}` };
  }
  async function withRequest(sub: string, words: string, over: Partial<typeof widgetConversations.$inferInsert> = {}) {
    const c = await conversation(sub, [["user", words], ["assistant", "Ho aperto una richiesta per te."]], over);
    const { itemId } = await seedBacklogItem(db, { projectId: pid, title: "TITOLO-INTERNO della richiesta" });
    await db.update(backlogItems).set({ supportConversationId: c.id }).where(eq(backlogItems.id, itemId));
    return { ...c, itemId };
  }
  async function withTicket(sub: string, words: string) {
    const c = await conversation(sub, [["user", words]]);
    const { ticketId } = await seedTicket(db, { projectId: pid, number: ticketNumber++ });
    await db.update(tickets).set({ title: "TITOLO-INTERNO del ticket" }).where(eq(tickets.id, ticketId));
    await db.insert(widgetMessages).values({ conversationId: c.id, role: "assistant", content: "Ticket aperto.", ticketId, createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0)) });
    return { ...c, ticketId };
  }
  return { projectId: pid, code: p!.code, widget: w!, get, conversation, withRequest, withTicket };
}
const list = async (s: Awaited<ReturnType<typeof site>>, sub: string) => {
  const res = await s.get("", sub);
  expect(res.statusCode).toBe(200);
  return { raw: res.body, page: siteRequestListSchema.parse(res.json()) };
};

describe("S4: l'elenco", () => {
  it("le richieste e i ticket del cliente: il codice della conversazione, le SUE parole, lo stato in parole nella lingua del widget; mai titoli interni", async () => {
    const s = await site();
    const r = await s.withRequest("anna", "Vorrei   esportare\nle fatture in CSV.");
    const t = await s.withTicket("anna", "Il login non funziona da ieri.");
    const { raw, page } = await list(s, "anna");
    expect(page.total).toBe(2);
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: r.code, kind: "request", label: "Vorrei esportare le fatture in CSV.", status: "received", statusLabel: "Ricevuta" }),
        expect.objectContaining({ code: t.code, kind: "ticket", label: "Il login non funziona da ieri.", status: "planned", statusLabel: "Pianificata" }),
      ]),
    );
    expect(raw).not.toContain("TITOLO-INTERNO");
    expect(raw).not.toMatch(new RegExp(`${s.code}-R\\d`));
  });

  it("la forma è CHIUSA: esattamente queste chiavi; un commento del team, un assegnatario e il titolo non escono", async () => {
    const s = await site();
    const t = await s.withTicket("anna", "Aiuto");
    await db.insert(comments).values({ ticketId: t.ticketId, authorType: "user", body: "COMMENTO-INTERNO del team" });
    const { raw, page } = await list(s, "anna");
    expect(Object.keys(page.items[0]!).sort()).toEqual(["code", "kind", "label", "openedAt", "status", "statusLabel"]);
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(["items", "total"]);
    expect(raw).not.toContain("COMMENTO-INTERNO");
  });

  it("la label è al più 140 caratteri; lo stato in inglese per un widget inglese", async () => {
    const s = await site("en");
    await s.withRequest("anna", "x".repeat(300));
    const { page } = await list(s, "anna");
    expect(page.items[0]!.label.length).toBeLessThanOrEqual(140);
    expect(page.items[0]!.statusLabel).toBe("Received");
  });

  it("NEGATIVI: un altro cliente dello stesso widget; lo stesso `sub` su un widget di un ALTRO progetto e su un altro widget dello stesso; una conversazione DICHIARATA; il canale mcp; una senza esito", async () => {
    const s = await site();
    await s.withRequest("bruno", "Di Bruno");
    await s.withRequest("anna", "Dichiarata", { identityVerified: false });
    await s.withRequest("anna", "Interna", { channel: "mcp" });
    await s.conversation("anna", [["user", "Solo una domanda"], ["assistant", "Risposta"]]);
    const otherProject = await site();
    await otherProject.withRequest("anna", "Altro progetto");
    const sibling = await site("it", s.projectId);
    await sibling.withRequest("anna", "Altro widget");
    expect((await list(s, "anna")).page).toEqual({ items: [], total: 0 });
    expect((await list(s, "bruno")).page.items.map((i) => i.label)).toEqual(["Di Bruno"]);
  });

  it("una richiesta FUSA: lo stato della destinazione, il codice e le parole del cliente, nulla della destinazione", async () => {
    const s = await site();
    const r = await s.withRequest("anna", "Le mie parole");
    const dest = await seedBacklogItem(db, { projectId: s.projectId, title: "DESTINAZIONE di un altro cliente", status: "ready" });
    await db.update(backlogItems).set({ status: "archived", mergedIntoId: dest.itemId }).where(eq(backlogItems.id, r.itemId));
    const { raw, page } = await list(s, "anna");
    expect(page.items).toEqual([expect.objectContaining({ code: r.code, label: "Le mie parole", status: "planned" })]);
    expect(raw).not.toContain("DESTINAZIONE");
  });

  it("le conversazioni successive sono righe a sé, ognuna col suo codice", async () => {
    const s = await site();
    const first = await s.withRequest("anna", "Prima");
    const second = await s.withRequest("anna", "Seconda");
    await db.update(widgetConversations).set({ continuedInId: second.id }).where(eq(widgetConversations.id, first.id));
    const { page } = await list(s, "anna");
    expect(page.items.map((i) => i.code).sort()).toEqual([first.code, second.code].sort());
  });

  it("review finale: a widget SPENTO anche le letture del sito sono spente (404 widget_disabled), elenco e dettaglio", async () => {
    const s = await site();
    const r = await s.withRequest("anna", "Mia");
    await db.update(widgets).set({ enabled: false }).where(eq(widgets.id, s.widget.id));
    expect((await s.get("", "anna")).json()).toMatchObject({ code: "widget_disabled" });
    expect((await s.get(`/${r.code}`, "anna")).json()).toMatchObject({ code: "widget_disabled" });
  });

  it("senza token: 401 identity_required anche su un widget che non lo chiede per la chat", async () => {
    const s = await site();
    const res = await s.get("");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "identity_required" });
  });
});

describe("S4b: il dettaglio", () => {
  it("la riga e i messaggi del cliente e dell'AI, in ordine; un messaggio del team (ruolo o autore) non esce", async () => {
    const s = await site();
    const r = await s.withRequest("anna", "Vorrei il CSV");
    await db.insert(widgetMessages).values({ conversationId: r.id, role: "team", content: "MESSAGGIO-DEL-TEAM", createdAt: new Date(Date.UTC(2026, 10, 16, 11, 0)) });
    await db.insert(widgetMessages).values({ conversationId: r.id, role: "assistant", content: "ASSISTENTE-CON-AUTORE", authorId: (await firstUserId()) ?? null, createdAt: new Date(Date.UTC(2026, 10, 16, 11, 1)) });
    const res = await s.get(`/${r.code}`, "anna");
    expect(res.statusCode).toBe(200);
    const d = siteRequestDetailSchema.parse(res.json());
    expect(d).toMatchObject({ code: r.code, kind: "request", label: "Vorrei il CSV", status: "received" });
    expect(d.messages.map((m) => [m.from, m.body])).toEqual([
      ["customer", "Vorrei il CSV"],
      ["assistant", "Ho aperto una richiesta per te."],
    ]);
    expect(res.body).not.toContain("MESSAGGIO-DEL-TEAM");
    expect(res.body).not.toContain("ASSISTENTE-CON-AUTORE");
    expect(Object.keys(res.json() as object).sort()).toEqual(["code", "kind", "label", "messages", "openedAt", "status", "statusLabel"]);
    expect(Object.keys(d.messages[0]!).sort()).toEqual(["at", "body", "from"]);
  });

  it("NEGATIVI, lo STESSO 404: il codice di un altro cliente, uno inesistente, uno malformato, una dichiarata, una senza esito, un altro progetto", async () => {
    const s = await site();
    const bruno = await s.withRequest("bruno", "Di Bruno");
    const declared = await s.withRequest("anna", "Dichiarata", { identityVerified: false });
    const noOutcome = await s.conversation("anna", [["user", "Domanda"]]);
    const other = await site();
    const elsewhere = await other.withRequest("anna", "Altrove");
    const bodies = new Set<string>();
    for (const code of [bruno.code, `${s.code}-S99999`, "non-un-codice", declared.code, noOutcome.code, elsewhere.code]) {
      const res = await s.get(`/${encodeURIComponent(code)}`, "anna");
      expect(res.statusCode).toBe(404);
      bodies.add(res.body);
    }
    expect([...bodies]).toHaveLength(1);
  });

  it("il numero di una SUA richiesta col prefisso di un altro progetto non è la sua: 404", async () => {
    const s = await site();
    const mine = await s.withRequest("anna", "Mia");
    const other = await site();
    const number = mine.code.split("-S")[1];
    expect((await s.get(`/${mine.code}`, "anna")).statusCode).toBe(200);
    expect((await s.get(`/${other.code}-S${number}`, "anna")).statusCode).toBe(404);
  });

  it("la successiva è un dettaglio a sé: i messaggi dell'una non stanno nell'altra", async () => {
    const s = await site();
    const first = await s.withRequest("anna", "PRIMA conversazione");
    const second = await s.withRequest("anna", "SECONDA conversazione");
    await db.update(widgetConversations).set({ continuedInId: second.id }).where(eq(widgetConversations.id, first.id));
    const res = await s.get(`/${first.code}`, "anna");
    expect(res.body).toContain("PRIMA conversazione");
    expect(res.body).not.toContain("SECONDA conversazione");
  });
});

async function firstUserId(): Promise<string | undefined> {
  const { users } = await import("@stubwise/db");
  const [u] = await db.insert(users).values({ email: `t-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u?.id;
}

async function widgetSecret(widgetId: string): Promise<string> {
  const [w] = await db.select({ secret: widgets.identitySecretEncrypted }).from(widgets).where(eq(widgets.id, widgetId));
  return decrypt(w!.secret!, KEY);
}

describe("registro, r.1061: i tetti per cliente verificato", () => {
  let limited: FastifyInstance;
  beforeAll(async () => {
    limited = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), ingestRateLimit: { max: 3, timeWindow: "1 minute" } });
    await limited.ready();
  });
  afterAll(async () => {
    await limited.close();
  });

  async function limitedSite() {
    const { projectId } = await seedRepository(db);
    const [p] = await db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, projectId));
    const secret = generateWidgetIdentitySecret();
    const [w] = await db.insert(widgets).values({ projectId, name: "Sito", key: `k-${randomUUID()}`, enabled: true, identitySecretEncrypted: encrypt(secret, KEY) }).returning();
    const now = Math.floor(Date.now() / 1000);
    const token = (sub: string) => sign(secret, { sub, aud: w!.id, iat: now - 5, exp: now + 600 });
    const read = (auth: string) => limited.inject({ method: "GET", url: `/widget/${p!.slug}/me/requests`, headers: { "x-stubwise-key": w!.key, authorization: auth } });
    return { widget: w!, slug: p!.slug, token, read };
  }

  it("il limitatore delle letture è per `sub` verificato, dopo identify: anna oltre il tetto 429, bea sullo stesso sito no", async () => {
    const s = await limitedSite();
    for (let i = 0; i < 3; i++) expect((await s.read(`Bearer ${s.token("anna")}`)).statusCode).toBe(200);
    expect((await s.read(`Bearer ${s.token("anna")}`)).statusCode).toBe(429);
    // Un token nuovo di anna (un header diverso) non apre un bucket nuovo.
    expect((await s.read(`Bearer ${s.token("anna")}x`)).statusCode).toBe(401);
    const fresh = sign("altro", { sub: "anna" });
    expect((await s.read(`Bearer ${fresh}`)).statusCode).toBe(401);
    expect((await s.read(`Bearer ${s.token("bea")}`)).statusCode).toBe(200);
  });

  it("gli header inventati li conta il bucket per chiave della rotta (dieci volte quello di un cliente), prima della decifratura", async () => {
    const s = await limitedSite();
    for (let i = 0; i < 30; i++) expect((await s.read(`Bearer inventato-${i}`)).statusCode).toBe(401);
    expect((await s.read(`Bearer inventato-31`)).statusCode).toBe(429);
  });

  // Dalla rotta le richieste si servono una dopo l'altra (`inject`): questo caso fissa i codici;
  // quello sotto, con la pausa fra conteggio e inserimento, è la prova del lock.
  it("revisione del lotto 2, M6: aperture CONCORRENTI dello stesso `sub` all'ultimo posto: ne passa una sola, le altre 429", async () => {
    const s = await site();
    const { WIDGET_VERIFIED_CONVERSATIONS_PER_DAY } = await import("./widget.js");
    await db.insert(widgetConversations).values(
      Array.from({ length: WIDGET_VERIFIED_CONVERSATIONS_PER_DAY - 1 }, () => ({ projectId: s.projectId, widgetId: s.widget.id, externalUserId: "carla", identityVerified: true })),
    );
    const [{ slug }] = (await db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, s.projectId))) as [{ slug: string }];
    const secret = await widgetSecret(s.widget.id);
    const now = Math.floor(Date.now() / 1000);
    const auth = `Bearer ${sign(secret, { sub: "carla", aud: s.widget.id, iat: now - 5, exp: now + 600 })}`;
    const res = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: "POST", url: `/widget/${slug}/conversations`, headers: { "x-stubwise-key": s.widget.key, authorization: auth }, payload: { user: { id: "carla" } } })),
    );
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 429, 429, 429, 429, 429]);
    const opened = await db.select().from(widgetConversations).where(and(eq(widgetConversations.widgetId, s.widget.id), eq(widgetConversations.externalUserId, "carla")));
    expect(opened).toHaveLength(WIDGET_VERIFIED_CONVERSATIONS_PER_DAY);
  });

  it("revisione del lotto 2, M6: il conteggio e l'apertura stanno sotto un lock per widget e `sub` — anche con una pausa fra i due, all'ultimo posto ne passa una sola", async () => {
    const s = await site();
    const { WIDGET_VERIFIED_CONVERSATIONS_PER_DAY, openWidgetConversation } = await import("./widget.js");
    await db.insert(widgetConversations).values(
      Array.from({ length: WIDGET_VERIFIED_CONVERSATIONS_PER_DAY - 1 }, () => ({ projectId: s.projectId, widgetId: s.widget.id, externalUserId: "dora", identityVerified: true })),
    );
    const row = { projectId: s.projectId, widgetId: s.widget.id, externalUserId: "dora", identityVerified: true };
    const pause = () => new Promise<void>((r) => setTimeout(r, 50));
    const out = await Promise.all(Array.from({ length: 6 }, () => openWidgetConversation(db, row, { afterCount: pause })));
    expect(out.filter((o) => o === "too_many")).toHaveLength(5);
    expect(await db.select().from(widgetConversations).where(and(eq(widgetConversations.widgetId, s.widget.id), eq(widgetConversations.externalUserId, "dora")))).toHaveLength(WIDGET_VERIFIED_CONVERSATIONS_PER_DAY);
  });

  it("al più WIDGET_VERIFIED_CONVERSATIONS_PER_DAY conversazioni verificate al giorno per `sub`; senza token il tetto non c'entra", async () => {
    const s = await site();
    const { WIDGET_VERIFIED_CONVERSATIONS_PER_DAY } = await import("./widget.js");
    await db.insert(widgetConversations).values(
      Array.from({ length: WIDGET_VERIFIED_CONVERSATIONS_PER_DAY }, () => ({ projectId: s.projectId, widgetId: s.widget.id, externalUserId: "anna", identityVerified: true })),
    );
    const [{ slug }] = (await db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, s.projectId))) as [{ slug: string }];
    const secret = await widgetSecret(s.widget.id);
    const now = Math.floor(Date.now() / 1000);
    const open = (sub: string, signed: boolean) =>
      app.inject({
        method: "POST",
        url: `/widget/${slug}/conversations`,
        headers: { "x-stubwise-key": s.widget.key, ...(signed ? { authorization: `Bearer ${sign(secret, { sub, aud: s.widget.id, iat: now - 5, exp: now + 600 })}` } : {}) },
        payload: { user: { id: sub } },
      });
    const over = await open("anna", true);
    expect([over.statusCode, (over.json() as { code: string }).code]).toEqual([429, "too_many_conversations"]);
    expect((await open("bea", true)).statusCode).toBe(200);
    expect((await open("anna", false)).statusCode).toBe(200);
    // Le vecchie di ieri non contano.
    await db.update(widgetConversations).set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(widgetConversations.widgetId, s.widget.id));
    expect((await open("anna", true)).statusCode).toBe(200);
  });
});
