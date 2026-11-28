import { randomUUID } from "node:crypto";
import { aiProviders, gitAccounts, googleWorkspaces, instanceSettings, personalAccessTokens, plugins, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { generatePat, hashServerKey } from "./shared.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F3, Task 3 (D-5): la riconferma sulle rotte con segreti. Una sessione
 * con il secondo fattore di 11 minuti fa: le rotte intere danno 403
 * `reauth_required` e non scrivono niente; le parziali solo quando il corpo
 * porta un segreto. Più il «Mi fido» dei plugin.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminId: string;
let fresh: string;
let stale: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 12).toString("base64") });
  await seedUsers(app);
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
  fresh = await fullSessionCookie(app, adminId);
  const old = await createSession(db, adminId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
  stale = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const call = (cookie: string, method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const expectReauth = async (res: Awaited<ReturnType<typeof call>>) => {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ code: "reauth_required" });
};

describe("la riconferma sulle rotte con segreti", () => {
  it("creare: provider, account git, plugin, app Google — scaduta → 403 e niente scritto; fresca → passa", async () => {
    const provider = { kind: "api_key", label: `P ${randomUUID().slice(0, 4)}`, secret: "sk-segreto" };
    await expectReauth(await call(stale, "POST", "/api/ai-providers", provider));
    expect(await db.select().from(aiProviders).where(eq(aiProviders.label, provider.label))).toHaveLength(0);
    expect((await call(fresh, "POST", "/api/ai-providers", provider)).statusCode).toBe(201);

    const account = { name: `G ${randomUUID().slice(0, 4)}`, provider: "github", credentials: { username: "bot", token: "ghp_x" } };
    await expectReauth(await call(stale, "POST", "/api/git-accounts", account));
    expect(await db.select().from(gitAccounts).where(eq(gitAccounts.name, account.name))).toHaveLength(0);

    const plugin = { sourceUrl: "https://github.com/obra/superpowers", ref: "v1", trust: true };
    await expectReauth(await call(stale, "POST", "/api/plugins", plugin));
    expect(await db.select().from(plugins)).toHaveLength(0);

    const google = { name: `W ${randomUUID().slice(0, 4)}`, domains: [`${randomUUID().slice(0, 6)}.example.com`], clientId: "1.apps.googleusercontent.com", clientSecret: "s" };
    await expectReauth(await call(stale, "POST", "/api/settings/google-workspaces", google));
    expect(await db.select().from(googleWorkspaces).where(eq(googleWorkspaces.name, google.name))).toHaveLength(0);
  });

  it("eliminare: provider, account git, app Google — scaduta → 403 prima di cercare l'oggetto", async () => {
    for (const url of ["/api/ai-providers/", "/api/git-accounts/", "/api/settings/google-workspaces/"]) {
      await expectReauth(await call(stale, "DELETE", `${url}${randomUUID()}`));
    }
  });

  it("le PARZIALI: senza segreto nel corpo passano, col segreto (anche per azzerarlo) vogliono la riconferma", async () => {
    const created = (await call(fresh, "POST", "/api/ai-providers", { kind: "api_key", label: `Q ${randomUUID().slice(0, 4)}`, secret: "sk-1" })).json() as { id: string };
    expect((await call(stale, "PATCH", `/api/ai-providers/${created.id}`, { label: "Rinominato" })).statusCode).toBe(200);
    await expectReauth(await call(stale, "PATCH", `/api/ai-providers/${created.id}`, { secret: "sk-2" }));
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, created.id));
    expect(row!.label).toBe("Rinominato");

    expect((await call(stale, "PUT", "/api/settings/instance", { contentLanguage: "it" })).statusCode).toBe(200);
    await expectReauth(await call(stale, "PUT", "/api/settings/instance", { contentLanguage: "it", s3SecretKey: "" }));
  });
});

describe("endpoint e bucket dello storage chiedono la riconferma, per QUALUNQUE chiamante (decisione del maintainer, 26 nov 2026)", () => {
  // Lotto 10 la voleva per l'azione di Claude (`saveStorage`); ora vale anche
  // per la rotta: endpoint e bucket decidono DOVE vanno e da dove si servono
  // gli allegati di tutti, col segreto salvato che resta in uso.
  it("sessione scaduta: cambiare l'endpoint o il bucket è 403 reauth_required e non scrive; lo stesso valore, o la regione, passano", async () => {
    expect((await call(fresh, "PUT", "/api/settings/instance", { contentLanguage: "it", s3Endpoint: "https://s3.prima.example", s3Bucket: "prima" })).statusCode).toBe(200);
    await expectReauth(await call(stale, "PUT", "/api/settings/instance", { contentLanguage: "it", s3Endpoint: "https://s3.altro.example" }));
    await expectReauth(await call(stale, "PUT", "/api/settings/instance", { contentLanguage: "it", s3Bucket: "altro" }));
    const [row] = await db.select().from(instanceSettings);
    expect(row).toMatchObject({ s3Endpoint: "https://s3.prima.example", s3Bucket: "prima" });
    // Rimandare gli stessi valori (anche con spazi) non cambia dove vanno gli allegati.
    expect((await call(stale, "PUT", "/api/settings/instance", { contentLanguage: "it", s3Endpoint: " https://s3.prima.example ", s3Bucket: "prima" })).statusCode).toBe(200);
    expect((await call(stale, "PUT", "/api/settings/instance", { contentLanguage: "it", s3Region: "eu-west-1" })).statusCode).toBe(200);
  });

  it("col PAT: session_required, e niente scritto", async () => {
    const token = generatePat();
    await db.insert(personalAccessTokens).values({ userId: adminId, name: "mcp", tokenHash: hashServerKey(token), kind: "manual" });
    const res = await app.inject({ method: "PUT", url: "/api/settings/instance", headers: { authorization: `Bearer ${token}` }, payload: { contentLanguage: "it", s3Bucket: "di-un-altro" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "session_required" });
    const [row] = await db.select().from(instanceSettings);
    expect(row?.s3Bucket).not.toBe("di-un-altro");
  });
});

describe("il plugin «Mi fido»", () => {
  it("senza `trust: true` → 422 trust_required e niente registrato; con → 201; anche per cambiare il ref", async () => {
    const body = { sourceUrl: "https://github.com/obra/superpowers", ref: "v4.0.3" };
    const no = await call(fresh, "POST", "/api/plugins", body);
    expect(no.statusCode).toBe(422);
    expect(no.json()).toMatchObject({ code: "trust_required" });
    expect(await db.select().from(plugins)).toHaveLength(0);
    const ok = await call(fresh, "POST", "/api/plugins", { ...body, trust: true });
    expect(ok.statusCode).toBe(201);
    const id = (ok.json() as { id: string }).id;
    expect((await call(fresh, "POST", `/api/plugins/${id}/update`, { ref: "v5" })).statusCode).toBe(422);
  });
});
