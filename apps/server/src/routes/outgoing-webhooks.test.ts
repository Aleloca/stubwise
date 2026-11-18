import { createHmac, randomUUID } from "node:crypto";
import { changeLog, outgoingWebhooks, roles, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { OutgoingWebhookView, OutgoingWebhookWithSecret } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F3, Task 4: le rotte dei webhook in uscita. Il segreto si vede UNA
 * volta e mai più; la riconferma su creazione, rigenerazione, eliminazione;
 * la prova firmata; l'anteprima per formato ed evento; il tetto di 20.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminId: string;
let cookie: string;
let stale: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 13).toString("base64"), publicUrl: "https://s.example.com" });
  await seedUsers(app);
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
  cookie = await fullSessionCookie(app, adminId);
  const old = await createSession(db, adminId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
  stale = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const body = (overrides: Record<string, unknown> = {}) => ({ name: `W ${randomUUID().slice(0, 4)}`, url: "https://hooks.example.com/in", format: "generic", events: ["job.failed"], ...overrides });
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, as = cookie) =>
  app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });

describe("i webhook in uscita", () => {
  it("creare mostra il segreto UNA volta; nessuna lettura lo ripete (né la tabella in chiaro); il registro dice senza segreto", async () => {
    const created = await call("POST", "/api/settings/webhooks", body());
    expect(created.statusCode).toBe(201);
    const w = created.json() as OutgoingWebhookWithSecret;
    expect(w.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(w.secretSet).toBe(true);
    const list = await call("GET", "/api/settings/webhooks");
    expect(list.body).not.toContain(w.secret);
    expect((list.json() as OutgoingWebhookView[]).find((x) => x.id === w.id)).toMatchObject({ secretSet: true, url: "https://hooks.example.com/in" });
    const [row] = await db.select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, w.id));
    expect(row!.secretEncrypted).not.toContain(w.secret);
    const entries = JSON.stringify(await db.select().from(changeLog).where(eq(changeLog.subjectId, w.id)));
    expect(entries).toContain("webhook.created");
    expect(entries).not.toContain(w.secret);
  });

  it("rigenerare dà un segreto nuovo (una volta) e lascia la voce; modificare senza riconferma; eliminare", async () => {
    const w = (await call("POST", "/api/settings/webhooks", body())).json() as OutgoingWebhookWithSecret;
    const rotated = await call("POST", `/api/settings/webhooks/${w.id}/secret`);
    expect(rotated.statusCode).toBe(200);
    const fresh = rotated.json() as OutgoingWebhookWithSecret;
    expect(fresh.secret).not.toBe(w.secret);
    expect(fresh.secretRotatedAt).not.toBeNull();
    const patched = await call("PATCH", `/api/settings/webhooks/${w.id}`, { name: "Rinominato", events: ["job.failed", "release.failed"], enabled: false }, stale);
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Rinominato", enabled: false, events: ["job.failed", "release.failed"] });
    expect((await call("DELETE", `/api/settings/webhooks/${w.id}`)).statusCode).toBe(204);
    const types = (await db.select({ type: changeLog.type }).from(changeLog).where(eq(changeLog.subjectId, w.id))).map((r) => r.type).sort();
    expect(types).toEqual(["webhook.created", "webhook.deleted", "webhook.secret_replaced", "webhook.updated"]);
  });

  it("NEGATIVI: la riconferma su creare, rigenerare, eliminare; un evento fuori catalogo; un URL non https; il 21° webhook; senza integrations.manage", async () => {
    expect((await call("POST", "/api/settings/webhooks", body(), stale)).statusCode).toBe(403);
    const w = (await call("POST", "/api/settings/webhooks", body())).json() as OutgoingWebhookWithSecret;
    expect((await call("POST", `/api/settings/webhooks/${w.id}/secret`, undefined, stale)).statusCode).toBe(403);
    expect((await call("DELETE", `/api/settings/webhooks/${w.id}`, undefined, stale)).statusCode).toBe(403);
    expect((await call("POST", "/api/settings/webhooks", body({ events: ["chat.mention"] }))).statusCode).toBe(400);
    expect((await call("POST", "/api/settings/webhooks", body({ url: "http://hooks.example.com" }))).statusCode).toBe(400);
    const count = (await db.select().from(outgoingWebhooks)).length;
    for (let i = count; i < 20; i++) expect((await call("POST", "/api/settings/webhooks", body())).statusCode).toBe(201);
    const over = await call("POST", "/api/settings/webhooks", body());
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: "webhook_limit" });
    const [r] = await db.insert(roles).values({ name: `S ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["settings.manage"] }).returning({ id: roles.id });
    const [u] = await db.insert(users).values({ email: `s-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member", instanceRoleId: r!.id }).returning({ id: users.id });
    expect((await call("GET", "/api/settings/webhooks", undefined, await fullSessionCookie(app, u!.id))).statusCode).toBe(403);
    await db.delete(outgoingWebhooks);
  });

  it("la prova parte FIRMATA col segreto del webhook, nel suo formato; senza segreto, senza firma", async () => {
    const seen: { headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: String(init.body) });
      return new Response(null, { status: 200 });
    });
    const w = (await call("POST", "/api/settings/webhooks", body())).json() as OutgoingWebhookWithSecret;
    const test = await call("POST", `/api/settings/webhooks/${w.id}/test`);
    expect(test.json()).toMatchObject({ ok: true, status: 200 });
    const signature = seen[0]!.headers.get("x-stubwise-signature")!;
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature)!;
    expect(createHmac("sha256", w.secret).update(`${t}.${seen[0]!.body}`).digest("hex")).toBe(v1);
    await db.update(outgoingWebhooks).set({ secretEncrypted: null }).where(eq(outgoingWebhooks.id, w.id));
    await call("POST", `/api/settings/webhooks/${w.id}/test`);
    expect(seen[1]!.headers.get("x-stubwise-signature")).toBeNull();
    await db.delete(outgoingWebhooks);
  });

  it("l'anteprima per formato ed evento usa i template veri; un evento senza notifica viva è 422", async () => {
    const slack = await call("GET", "/api/settings/webhooks/preview?format=slack&event=job.failed");
    expect(slack.statusCode).toBe(200);
    expect(slack.json()).toMatchObject({ format: "slack", event: "job.failed" });
    const generic = (await call("GET", "/api/settings/webhooks/preview?format=generic&event=job.failed")).json() as { body: unknown };
    expect(generic.body).not.toEqual((slack.json() as { body: unknown }).body);
    expect((await call("GET", "/api/settings/webhooks/preview?format=slack&event=task.created_by_automation")).statusCode).toBe(422);
  });
});
