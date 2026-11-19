import { createHmac, randomBytes } from "node:crypto";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { commitSummaries, projects, repositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F6 (0193): un repository STACCATO (il suo progetto è stato
 * eliminato) non è di nessun progetto. Lo vede solo l'Amministrazione,
 * dalle rotte dedicate: nemmeno il full admin lo trova negli elenchi, nella
 * ricerca o nel dettaglio di progetto, e il suo webhook non entra.
 */
let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Un repository col nome dato, poi staccato eliminandone il progetto. */
async function detached(name: string) {
  const { projectId, repositoryId } = await seedRepository(testDb.db);
  await testDb.db.update(repositories).set({ name, webhookSecret: "segreto-del-webhook" }).where(eq(repositories.id, repositoryId));
  await testDb.db.delete(projects).where(eq(projects.id, projectId));
  const [row] = await testDb.db.select().from(repositories).where(eq(repositories.id, repositoryId));
  return row!;
}

describe("area 9, F6: un repository staccato non è di nessun progetto", () => {
  it("il full admin non lo vede in GET /api/repositories né nel dettaglio (404)", async () => {
    const attached = await seedRepository(testDb.db);
    const repo = await detached("staccato-elenco");
    const list = await app.inject({ method: "GET", url: "/api/repositories", headers: { cookie: adminCookie } });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(attached.repositoryId);
    expect(ids).not.toContain(repo.id);
    const one = await app.inject({ method: "GET", url: `/api/repositories/${repo.slug}`, headers: { cookie: adminCookie } });
    expect(one.statusCode).toBe(404);
  });

  it("la ricerca del full admin non lo trova", async () => {
    const repo = await detached("staccatoricercabile");
    const attached = await seedRepository(testDb.db);
    await testDb.db.update(repositories).set({ name: "agganciatoricercabile staccatoricercabile" }).where(eq(repositories.id, attached.repositoryId));
    const res = await app.inject({ method: "GET", url: "/api/search?q=staccatoricercabile", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { repositories: { items: { id: string }[] } }).repositories.items.map((r) => r.id);
    expect(ids).toEqual([attached.repositoryId]);
    expect(ids).not.toContain(repo.id);
  });

  it("i suoi commit non entrano nell'attività delle persone del full admin", async () => {
    const repo = await detached("staccato-commit");
    const at = new Date("2026-11-18T10:00:00Z");
    await testDb.db.insert(commitSummaries).values({ repositoryId: repo.id, sha: "c".repeat(40), authorName: "Bea", authorEmail: "bea@acme.com", subject: "commit staccato", summary: "commit staccato", committedAt: at });
    // Il controllo: lo stesso commit in un repository col progetto si vede.
    const attached = await seedRepository(testDb.db);
    await testDb.db.insert(commitSummaries).values({ repositoryId: attached.repositoryId, sha: "d".repeat(40), authorName: "Bea", authorEmail: "bea@acme.com", subject: "commit agganciato", summary: "commit agganciato", committedAt: at });
    const res = await app.inject({ method: "GET", url: "/api/people/activity?date=2026-11-18", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain("commit agganciato");
    expect(JSON.stringify(res.json())).not.toContain("commit staccato");
  });

  it("il webhook di un repository staccato risponde 401 anche con la firma giusta", async () => {
    const repo = await detached("staccato-webhook");
    const body = JSON.stringify({ ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), commits: [] });
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${repo.slug}`,
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${createHmac("sha256", repo.webhookSecret).update(body).digest("hex")}` },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    // Il controllo: con un progetto, la stessa consegna firmata entra.
    const ok = await seedRepository(testDb.db);
    await testDb.db.update(repositories).set({ webhookSecret: "segreto-del-webhook" }).where(eq(repositories.id, ok.repositoryId));
    const [okRepo] = await testDb.db.select().from(repositories).where(eq(repositories.id, ok.repositoryId));
    const accepted = await app.inject({
      method: "POST",
      url: `/webhooks/git/${okRepo!.slug}`,
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${createHmac("sha256", "segreto-del-webhook").update(body).digest("hex")}` },
      payload: body,
    });
    expect(accepted.statusCode).not.toBe(401);
  });
});
