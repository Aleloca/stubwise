import { createHmac, randomUUID } from "node:crypto";
import { backlogItems, encrypt, projects, tickets, widgetConversations, widgetMessages, widgets, type Db } from "@stubwise/db";
import { seedBacklogItem, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { generateWidgetIdentitySecret } from "../auth/widget-identity.js";

/**
 * Area 8, «L'API per i siti» (S3): la chat del widget con l'identità firmata
 * dal sito. Il `sub` del token vince sull'id dichiarato; «Solo clienti
 * verificati» rifiuta il cliente dichiarato; una conversazione VERIFICATA si
 * legge e si scrive solo col token del suo cliente. Un widget che non manda
 * token funziona come prima.
 */

const KEY = Buffer.alloc(32, 7);
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

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

async function scene(opts: { required?: boolean; secret?: boolean } = {}) {
  const { projectId, repositoryId } = await seedRepository(db);
  const [p] = await db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, projectId));
  const secret = generateWidgetIdentitySecret();
  const [w] = await db
    .insert(widgets)
    .values({
      projectId,
      name: "Sito",
      key: `k-${randomUUID()}`,
      enabled: true,
      enabledRepositoryIds: [repositoryId],
      identitySecretEncrypted: opts.secret === false ? null : encrypt(secret, KEY),
      identityRequired: opts.required ?? false,
    })
    .returning();
  const now = Math.floor(Date.now() / 1000);
  const token = (sub: string, over: Record<string, unknown> = {}) => sign(secret, { sub, aud: w!.id, iat: now - 5, exp: now + 600, ...over });
  const headers = (tok?: string) => ({ "x-stubwise-key": w!.key, ...(tok ? { authorization: `Bearer ${tok}` } : {}) });
  const create = (userId: string, tok?: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/widget/${p!.slug}/conversations`, headers: headers(tok), payload: { user: { id: userId, ...extra } } });
  const history = (conversationId: string, userId: string, tok?: string) =>
    app.inject({ method: "GET", url: `/widget/${p!.slug}/conversations/${conversationId}/messages?userId=${encodeURIComponent(userId)}`, headers: headers(tok) });
  return { slug: p!.slug, widget: w!, secret, token, headers, create, history };
}
const conv = async (id: string) => (await db.select().from(widgetConversations).where(eq(widgetConversations.id, id)))[0]!;

describe("S3: la conversazione col token", () => {
  it("un token valido: la conversazione è VERIFICATA, il cliente è il `sub`, email e nome del token vincono sul body", async () => {
    const s = await scene();
    const res = await s.create("anna", s.token("anna", { email: "anna@cliente.it", name: "Anna" }), { email: "altro@x.it", name: "Altro" });
    expect(res.statusCode).toBe(200);
    expect(await conv(res.json().conversationId)).toMatchObject({ externalUserId: "anna", externalUserEmail: "anna@cliente.it", externalUserName: "Anna", identityVerified: true });
  });

  it("un body che dice un ALTRO cliente del token: 401 identity_mismatch, nessuna conversazione", async () => {
    const s = await scene();
    const before = (await db.select().from(widgetConversations).where(eq(widgetConversations.widgetId, s.widget.id))).length;
    const res = await s.create("bruno", s.token("anna"));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "identity_mismatch" });
    expect((await db.select().from(widgetConversations).where(eq(widgetConversations.widgetId, s.widget.id))).length).toBe(before);
  });

  it("senza token, su un widget che non lo chiede: come prima, conversazione DICHIARATA", async () => {
    const s = await scene();
    const res = await s.create("anna");
    expect(res.statusCode).toBe(200);
    expect((await conv(res.json().conversationId)).identityVerified).toBe(false);
  });

  it("un token non valido (firma, scadenza, altro widget, widget senza segreto) è la STESSA 401 invalid_identity; la config non ne risente", async () => {
    const s = await scene();
    const other = await scene();
    const now = Math.floor(Date.now() / 1000);
    const bad = [sign(generateWidgetIdentitySecret(), { sub: "anna", aud: s.widget.id, iat: now, exp: now + 60 }), s.token("anna", { exp: now - 1 }), other.token("anna"), "non-un-token"];
    const bodies = new Set<string>();
    for (const tok of bad) {
      const res = await s.create("anna", tok);
      expect(res.statusCode).toBe(401);
      bodies.add(res.body);
    }
    expect([...bodies]).toHaveLength(1);
    expect(JSON.parse([...bodies][0]!)).toMatchObject({ code: "invalid_identity" });

    const noSecret = await scene({ secret: false });
    expect((await noSecret.create("anna", s.token("anna"))).json()).toMatchObject({ code: "invalid_identity" });

    const config = await app.inject({ method: "GET", url: `/widget/${s.slug}/config`, headers: s.headers("non-un-token") });
    expect(config.statusCode).toBe(200);
  });

  it("«Solo clienti verificati»: senza token 401 identity_required su apertura e storico; col token sì", async () => {
    const s = await scene({ required: true });
    expect((await s.create("anna")).json()).toMatchObject({ code: "identity_required" });
    const ok = await s.create("anna", s.token("anna"));
    expect(ok.statusCode).toBe(200);
    const id = ok.json().conversationId as string;
    expect((await s.history(id, "anna")).json()).toMatchObject({ code: "identity_required" });
    expect((await s.history(id, "anna", s.token("anna"))).statusCode).toBe(200);
  });

  it("una conversazione VERIFICATA non si legge dichiarando il suo cliente: senza token 404; col token di un altro 404; col suo 200", async () => {
    const s = await scene();
    const id = (await s.create("anna", s.token("anna"))).json().conversationId as string;
    expect((await s.history(id, "anna")).statusCode).toBe(404);
    expect((await s.history(id, "bruno", s.token("bruno"))).statusCode).toBe(404);
    expect((await s.history(id, "anna", s.token("anna"))).statusCode).toBe(200);
    // Il token vince anche qui: una query diversa dal sub è un mismatch.
    expect((await s.history(id, "bruno", s.token("anna"))).json()).toMatchObject({ code: "identity_mismatch" });
  });

  it("una conversazione DICHIARATA resta leggibile come prima, e anche col token del suo cliente", async () => {
    const s = await scene();
    const id = (await s.create("anna")).json().conversationId as string;
    expect((await s.history(id, "anna")).statusCode).toBe(200);
    expect((await s.history(id, "anna", s.token("anna"))).statusCode).toBe(200);
  });

  it("review finale: una conversazione DICHIARATA chiusa che continua in una VERIFICATA non fa entrare nessuno senza token (404, niente scritto)", async () => {
    const s = await scene();
    const [p] = await db.select({ projectId: widgets.projectId }).from(widgets).where(eq(widgets.id, s.widget.id));
    const declared = (await s.create("anna")).json().conversationId as string;
    const { itemId } = await seedBacklogItem(db, { projectId: p!.projectId });
    await db.update(backlogItems).set({ supportConversationId: declared }).where(eq(backlogItems.id, itemId));
    const [verified] = await db.insert(widgetConversations).values({ projectId: p!.projectId, widgetId: s.widget.id, externalUserId: "anna", identityVerified: true }).returning();
    await db.update(widgetConversations).set({ continuedInId: verified!.id }).where(eq(widgetConversations.id, declared));
    const ticketsBefore = (await db.select().from(tickets)).length;
    const res = await app.inject({
      method: "POST",
      url: `/widget/${s.slug}/conversations/${declared}/tickets`,
      headers: s.headers(),
      payload: { title: "Iniettato", body: "Testo di qualcun altro", type: "bug", userId: "anna" },
    });
    expect(res.statusCode).toBe(404);
    expect((await db.select().from(tickets)).length).toBe(ticketsBefore);
    expect(await db.select().from(widgetMessages).where(eq(widgetMessages.conversationId, verified!.id))).toEqual([]);
  });

  it("CORS: la preflight ammette l'header authorization", async () => {
    const s = await scene();
    const res = await app.inject({
      method: "OPTIONS",
      url: `/widget/${s.slug}/conversations`,
      headers: { origin: "https://sito.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-stubwise-key,authorization" },
    });
    expect(String(res.headers["access-control-allow-headers"])).toContain("authorization");
  });
});
