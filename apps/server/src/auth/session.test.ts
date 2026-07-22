import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { personalAccessTokens } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { generatePat, hashServerKey } from "../routes/shared.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ memberId } = await seedUsers(app));
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
});
