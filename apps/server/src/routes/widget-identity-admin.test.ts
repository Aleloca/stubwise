import { randomUUID } from "node:crypto";
import { decrypt, personalAccessTokens, sessions, widgets, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { widgetListSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";
import { generatePat, hashServerKey } from "./shared.js";

/**
 * Area 8, «L'API per i siti» (S1): il segreto d'identità del widget e
 * «Solo clienti verificati». Il segreto si vede UNA volta, alla generazione:
 * nessuna lettura lo restituisce. Generarlo vuole `widget.manage` e la
 * riconferma recente (un PAT non la soddisfa mai).
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY });
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function scene() {
  const { projectId } = await seedRepository(db);
  const lead = await createUserWithSession(app, `lead-${randomUUID().slice(0, 8)}@acme.com`);
  await addMember(app, projectId, lead.id, "project_lead");
  const [w] = await db.insert(widgets).values({ projectId, name: "Sito", key: `k-${randomUUID()}` }).returning();
  return { projectId, lead, widget: w! };
}
const url = (projectId: string, widgetId: string) => `/api/projects/${projectId}/widgets/${widgetId}/identity-secret`;
const list = async (projectId: string, headers: Record<string, string>) => {
  const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/widgets`, headers });
  expect(res.statusCode).toBe(200);
  return { raw: res.body, parsed: widgetListSchema.parse(res.json()) };
};
const putBody = (over: Record<string, unknown> = {}) => ({
  name: "Sito",
  enabled: false,
  enabledRepositoryIds: [],
  repositoryFilters: {},
  title: "Assistenza",
  welcomeMessage: "Ciao!",
  instructions: "",
  accentColor: "#22c55e",
  language: "it",
  dailyMessageCap: null,
  dailyTicketCap: null,
  ...over,
});

describe("il segreto d'identità del widget", () => {
  it("un widget nuovo non ha segreto; generarlo lo mostra UNA volta, cifrato a riposo, e la vista dice solo che c'è", async () => {
    const { projectId, lead, widget } = await scene();
    expect((await list(projectId, lead.headers)).parsed.widgets[0]).toMatchObject({ identitySecretSet: false, identitySecretRotatedAt: null, identityRequired: false });

    const res = await app.inject({ method: "POST", url: url(projectId, widget.id), headers: lead.headers });
    expect(res.statusCode).toBe(200);
    const { secret, rotatedAt } = res.json() as { secret: string; rotatedAt: string };
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(res.headers["cache-control"]).toBe("no-store");

    const [row] = await db.select().from(widgets).where(eq(widgets.id, widget.id));
    expect(row!.identitySecretEncrypted).not.toContain(secret);
    expect(decrypt(row!.identitySecretEncrypted!, Buffer.from(KEY, "base64"))).toBe(secret);

    const after = await list(projectId, lead.headers);
    expect(after.parsed.widgets[0]).toMatchObject({ identitySecretSet: true, identitySecretRotatedAt: rotatedAt });
    expect(after.raw).not.toContain(secret);
    expect(after.raw).not.toContain(row!.identitySecretEncrypted!);
  });

  it("rigenerare dà un segreto NUOVO e il vecchio non è più quello salvato (D-5: smette subito)", async () => {
    const { projectId, lead, widget } = await scene();
    const first = (await app.inject({ method: "POST", url: url(projectId, widget.id), headers: lead.headers })).json() as { secret: string };
    const second = (await app.inject({ method: "POST", url: url(projectId, widget.id), headers: lead.headers })).json() as { secret: string };
    expect(second.secret).not.toBe(first.secret);
    const [row] = await db.select().from(widgets).where(eq(widgets.id, widget.id));
    expect(decrypt(row!.identitySecretEncrypted!, Buffer.from(KEY, "base64"))).toBe(second.secret);
  });

  it("NEGATIVI: senza `widget.manage` (Legacy Member) 403; un PAT (anche del lead) non è una riconferma; una sessione senza riconferma recente 403; il widget di un altro progetto 404 — e il segreto non cambia", async () => {
    const { projectId, lead, widget } = await scene();
    const dev = await createUserWithSession(app, `dev-${randomUUID().slice(0, 8)}@acme.com`);
    await addMember(app, projectId, dev.id, "legacy_member");
    expect((await app.inject({ method: "POST", url: url(projectId, widget.id), headers: dev.headers })).statusCode).toBe(403);

    const token = generatePat();
    await db.insert(personalAccessTokens).values({ userId: lead.id, name: "pat", tokenHash: hashServerKey(token) });
    const pat = await app.inject({ method: "POST", url: url(projectId, widget.id), headers: { authorization: `Bearer ${token}` } });
    expect(pat.statusCode).toBe(403);

    const stale = await createUserWithSession(app, `stale-${randomUUID().slice(0, 8)}@acme.com`);
    await addMember(app, projectId, stale.id, "project_lead");
    await db.update(sessions).set({ secondFactorAt: new Date(Date.now() - 3_600_000) }).where(eq(sessions.userId, stale.id));
    const old = await app.inject({ method: "POST", url: url(projectId, widget.id), headers: stale.headers });
    expect(old.statusCode).toBe(403);
    expect(old.json()).toMatchObject({ code: "reauth_required" });

    const other = await scene();
    expect((await app.inject({ method: "POST", url: url(projectId, other.widget.id), headers: lead.headers })).statusCode).toBe(404);

    const [row] = await db.select().from(widgets).where(eq(widgets.id, widget.id));
    expect(row!.identitySecretEncrypted).toBeNull();
    const [otherRow] = await db.select().from(widgets).where(eq(widgets.id, other.widget.id));
    expect(otherRow!.identitySecretEncrypted).toBeNull();
  });
});

describe("«Solo clienti verificati»", () => {
  it("senza un segreto non si accende (422 identity_secret_missing); con il segreto sì; un PUT che non lo nomina lo lascia com'è", async () => {
    const { projectId, lead, widget } = await scene();
    const put = (body: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/projects/${projectId}/widgets/${widget.id}`, headers: lead.headers, payload: body });

    const missing = await put(putBody({ identityRequired: true }));
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: "identity_secret_missing" });

    await app.inject({ method: "POST", url: url(projectId, widget.id), headers: lead.headers });
    expect((await put(putBody({ identityRequired: true }))).json()).toMatchObject({ widget: { identityRequired: true } });
    expect((await put(putBody({ name: "Sito 2" }))).json()).toMatchObject({ widget: { name: "Sito 2", identityRequired: true } });
    expect((await put(putBody({ identityRequired: false }))).json()).toMatchObject({ widget: { identityRequired: false } });
  });

  it("la creazione accetta il campo; senza segreto non può nascere acceso", async () => {
    const { projectId, lead } = await scene();
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/widgets`, headers: lead.headers, payload: putBody({ identityRequired: true }) });
    expect(res.statusCode).toBe(422);
    const ok = await app.inject({ method: "POST", url: `/api/projects/${projectId}/widgets`, headers: lead.headers, payload: putBody() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ widget: { identityRequired: false, identitySecretSet: false } });
  });
});
