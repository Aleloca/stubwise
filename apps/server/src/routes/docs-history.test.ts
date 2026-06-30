import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import { docSearchHistory } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

const embeddingClient = createFakeEmbeddingClient();

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

async function insertProject(db: Db): Promise<string> {
  const { repositoryId } = await seedRepository(db);
  return repositoryId;
}

interface HistoryEntry {
  slug: string;
  title: string;
  kind: string;
  snippet: string | null;
  clickedAt: string;
}

async function record(
  projectId: string,
  cookie: string,
  body: { slug: string; title: string; kind?: string; snippet?: string },
) {
  return app.inject({
    method: "POST",
    url: `/api/repositories/${projectId}/docs/history`,
    headers: { cookie },
    payload: { kind: "technical", ...body },
  });
}

async function getHistory(projectId: string, cookie: string): Promise<HistoryEntry[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/repositories/${projectId}/docs/history`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as HistoryEntry[];
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient,
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("POST /api/repositories/:projectId/docs/history", () => {
  it("crea una voce e risponde 204", async () => {
    const projectId = await insertProject(testDb.db);
    const res = await record(projectId, memberCookie, { slug: "auth", title: "Auth" });
    expect(res.statusCode).toBe(204);

    const history = await getHistory(projectId, memberCookie);
    expect(history.map((h) => h.slug)).toEqual(["auth"]);
    expect(history[0]!.title).toBe("Auth");
    expect(history[0]!.kind).toBe("technical");
    // Senza snippet nel body → null.
    expect(history[0]!.snippet).toBeNull();
  });

  it("salva lo snippet e lo aggiorna al re-click; vuoto → null", async () => {
    const projectId = await insertProject(testDb.db);
    await record(projectId, memberCookie, {
      slug: "with-snippet",
      title: "With snippet",
      snippet: "Prima anteprima",
    });
    expect((await getHistory(projectId, memberCookie))[0]!.snippet).toBe("Prima anteprima");

    // Re-click con un nuovo snippet: aggiornato.
    await record(projectId, memberCookie, {
      slug: "with-snippet",
      title: "With snippet",
      snippet: "Seconda anteprima",
    });
    expect((await getHistory(projectId, memberCookie))[0]!.snippet).toBe("Seconda anteprima");

    // Re-click con snippet vuoto: normalizzato a null.
    await record(projectId, memberCookie, {
      slug: "with-snippet",
      title: "With snippet",
      snippet: "   ",
    });
    expect((await getHistory(projectId, memberCookie))[0]!.snippet).toBeNull();
  });

  it("ri-POST dello stesso slug non duplica, aggiorna clickedAt e title/kind", async () => {
    const projectId = await insertProject(testDb.db);
    await record(projectId, memberCookie, { slug: "deploy", title: "Deploy", kind: "technical" });
    await record(projectId, memberCookie, { slug: "other", title: "Other" });

    // Re-click su "deploy": deve risalire in cima e aggiornare title/kind.
    await record(projectId, memberCookie, { slug: "deploy", title: "Deploy v2", kind: "functional" });

    const history = await getHistory(projectId, memberCookie);
    // Una sola voce per slug "deploy" (upsert, non duplicato).
    expect(history.filter((h) => h.slug === "deploy")).toHaveLength(1);
    // "deploy" risalito in cima per il clickedAt aggiornato.
    expect(history.map((h) => h.slug)).toEqual(["deploy", "other"]);
    const deploy = history.find((h) => h.slug === "deploy")!;
    expect(deploy.title).toBe("Deploy v2");
    expect(deploy.kind).toBe("functional");
  });

  it("poda: dopo 21 POST con slug diversi restano 20 righe", async () => {
    const projectId = await insertProject(testDb.db);
    for (let i = 0; i < 21; i++) {
      const res = await record(projectId, memberCookie, { slug: `p-${i}`, title: `P ${i}` });
      expect(res.statusCode).toBe(204);
    }

    const rows = await testDb.db
      .select({ slug: docSearchHistory.slug })
      .from(docSearchHistory)
      .where(
        and(
          eq(docSearchHistory.userId, memberId),
          eq(docSearchHistory.repositoryId, projectId),
        ),
      );
    expect(rows).toHaveLength(20);
    // La voce più vecchia (p-0) è stata potata.
    expect(rows.some((r) => r.slug === "p-0")).toBe(false);
    expect(rows.some((r) => r.slug === "p-20")).toBe(true);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/history",
      headers: { cookie: memberCookie },
      payload: { slug: "x", title: "X", kind: "technical" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const projectId = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/docs/history`,
      payload: { slug: "x", title: "X", kind: "technical" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/repositories/:projectId/docs/history", () => {
  it("ritorna solo le righe dell'utente corrente (isolamento per utente)", async () => {
    const projectId = await insertProject(testDb.db);
    await record(projectId, memberCookie, { slug: "member-page", title: "Member" });
    await record(projectId, adminCookie, { slug: "admin-page", title: "Admin" });

    const memberHistory = await getHistory(projectId, memberCookie);
    expect(memberHistory.map((h) => h.slug)).toEqual(["member-page"]);

    const adminHistory = await getHistory(projectId, adminCookie);
    expect(adminHistory.map((h) => h.slug)).toEqual(["admin-page"]);
  });

  it("limita a 8 voci, ordinate per clickedAt desc", async () => {
    const projectId = await insertProject(testDb.db);
    for (let i = 0; i < 10; i++) {
      await record(projectId, memberCookie, { slug: `s-${i}`, title: `S ${i}` });
    }

    const history = await getHistory(projectId, memberCookie);
    expect(history).toHaveLength(8);
    // Le 8 più recenti, dalla più nuova: s-9, s-8, ... s-2.
    expect(history.map((h) => h.slug)).toEqual([
      "s-9",
      "s-8",
      "s-7",
      "s-6",
      "s-5",
      "s-4",
      "s-3",
      "s-2",
    ]);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/history",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const projectId = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${projectId}/docs/history`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/repositories/:projectId/docs/history/:slug", () => {
  it("rimuove solo la voce indicata", async () => {
    const projectId = await insertProject(testDb.db);
    await record(projectId, memberCookie, { slug: "keep", title: "Keep" });
    await record(projectId, memberCookie, { slug: "remove", title: "Remove" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/docs/history/remove`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(204);

    const history = await getHistory(projectId, memberCookie);
    expect(history.map((h) => h.slug)).toEqual(["keep"]);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/history/x",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const projectId = await insertProject(testDb.db);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/docs/history/x`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/repositories/:projectId/docs/history", () => {
  it("svuota la cronologia solo per utente+progetto correnti", async () => {
    const projectId = await insertProject(testDb.db);
    await record(projectId, memberCookie, { slug: "m-1", title: "M1" });
    await record(projectId, memberCookie, { slug: "m-2", title: "M2" });
    await record(projectId, adminCookie, { slug: "a-1", title: "A1" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/docs/history`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(204);

    // Member svuotato.
    expect(await getHistory(projectId, memberCookie)).toEqual([]);
    // Admin intatto.
    expect((await getHistory(projectId, adminCookie)).map((h) => h.slug)).toEqual(["a-1"]);
  });

  it("non tocca lo stesso utente in un altro progetto", async () => {
    const projectA = await insertProject(testDb.db);
    const projectB = await insertProject(testDb.db);
    await record(projectA, memberCookie, { slug: "a", title: "A" });
    await record(projectB, memberCookie, { slug: "b", title: "B" });

    await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectA}/docs/history`,
      headers: { cookie: memberCookie },
    });

    expect(await getHistory(projectA, memberCookie)).toEqual([]);
    expect((await getHistory(projectB, memberCookie)).map((h) => h.slug)).toEqual(["b"]);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/history",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const projectId = await insertProject(testDb.db);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/docs/history`,
    });
    expect(res.statusCode).toBe(401);
  });
});
