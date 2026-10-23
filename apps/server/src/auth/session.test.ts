import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { personalAccessTokens, sessions } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { generatePat, hashServerKey } from "../routes/shared.js";
import { partialSessionCookie, seedUsers } from "../test/fixtures.js";
import { PARTIAL_SESSION_TTL_MS, SESSION_COOKIE } from "./session.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let memberId: string;
let memberCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ memberId, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  await testDb.db.delete(personalAccessTokens);
});

describe("requireAuth con Bearer PAT", () => {
  it("autentica una route protetta con Bearer PAT valido → 200", async () => {
    const token = generatePat();
    await testDb.db.insert(personalAccessTokens).values({
      userId: memberId,
      name: "t",
      tokenHash: hashServerKey(token),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("aggiorna lastUsedAt dopo una chiamata autenticata con PAT valido", async () => {
    const token = generatePat();
    const [row] = await testDb.db
      .insert(personalAccessTokens)
      .values({ userId: memberId, name: "t", tokenHash: hashServerKey(token) })
      .returning({ id: personalAccessTokens.id });
    // Prima dell'uso: lastUsedAt è null.
    const [before] = await testDb.db
      .select({ lastUsedAt: personalAccessTokens.lastUsedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, row!.id));
    expect(before!.lastUsedAt).toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const [after] = await testDb.db
      .select({ lastUsedAt: personalAccessTokens.lastUsedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, row!.id));
    expect(after!.lastUsedAt).not.toBeNull();
  });

  it("rifiuta un PAT scaduto → 401", async () => {
    const token = generatePat();
    await testDb.db.insert(personalAccessTokens).values({
      userId: memberId,
      name: "t",
      tokenHash: hashServerKey(token),
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rifiuta un PAT inesistente / hash sbagliato → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${generatePat()}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rifiuta un Bearer senza il prefisso stw_pat_ → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer token-a-caso-non-pat" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accetta un Bearer con schema minuscolo (case-insensitive) + PAT valido → 200", async () => {
    const token = generatePat();
    await testDb.db.insert(personalAccessTokens).values({
      userId: memberId,
      name: "t",
      tokenHash: hashServerKey(token),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("requireAuth: coesistenza cookie/PAT", () => {
  it("cookie di sessione valido + header Authorization spazzatura → 200 (fallback cookie)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: memberCookie, authorization: "Bearer garbage" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("cookie di sessione valido + header Basic → 200 (fallback cookie)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: memberCookie, authorization: "Basic xyz" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("cookie di sessione valido, nessun header Authorization → 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("requireAuth: header Authorization malformati → 401", () => {
  it("Bearer senza token → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("schema Basic → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Basic abc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("header vuoto → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireAuth: boundary scadenza PAT", () => {
  it("PAT con expiresAt nel passato immediato → 401 (fail-closed)", async () => {
    const token = generatePat();
    await testDb.db.insert(personalAccessTokens).values({
      userId: memberId,
      name: "t",
      tokenHash: hashServerKey(token),
      expiresAt: new Date(Date.now() - 1),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("PAT con expiresAt nel futuro → 200", async () => {
    const token = generatePat();
    await testDb.db.insert(personalAccessTokens).values({
      userId: memberId,
      name: "t",
      tokenHash: hashServerKey(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("sessione a stadi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("una sessione parziale non apre GET /api/auth/me: 401 second_factor_required", async () => {
    for (const stage of ["second_factor", "enrollment"] as const) {
      const cookie = await partialSessionCookie(app, memberId, stage);
      const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "second_factor_required" });
    }
  });

  it("una sessione parziale non apre nemmeno le altre rotte (inbox, elenchi)", async () => {
    const cookie = await partialSessionCookie(app, memberId, "second_factor");
    for (const url of ["/api/inbox", "/api/projects", "/api/me/notification-prefs"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toMatchObject({ code: "second_factor_required" });
    }
  });

  it("una sessione parziale scaduta dopo 10 minuti è 401 unauthorized", async () => {
    expect(PARTIAL_SESSION_TTL_MS).toBe(10 * 60 * 1000);
    const cookie = await partialSessionCookie(app, memberId, "second_factor");
    const start = Date.now();
    // Poco prima della scadenza è ancora una sessione parziale viva...
    vi.spyOn(Date, "now").mockReturnValue(start + PARTIAL_SESSION_TTL_MS - 5_000);
    const alive = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(alive.json()).toMatchObject({ code: "second_factor_required" });
    // ...dopo i 10 minuti non c'è più.
    vi.spyOn(Date, "now").mockReturnValue(start + PARTIAL_SESSION_TTL_MS + 1_000);
    const expired = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ code: "unauthorized" });
  });

  it("una sessione esistente senza colonne nuove (default full, secondFactorAt null) apre le rotte come prima", async () => {
    const id = randomBytes(32).toString("base64url");
    await testDb.db
      .insert(sessions)
      .values({ id, userId: memberId, expiresAt: new Date(Date.now() + 60_000) });
    const [row] = await testDb.db.select().from(sessions).where(eq(sessions.id, id));
    expect(row?.stage).toBe("full");
    expect(row?.secondFactorAt).toBeNull();
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(id))}`;
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });
});
