import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatChannels, chatMessages, environmentServers, projectEnvironments, releaseCiRuns, releases, repositories, servers } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0175 (13 nov 2026, area 8, fetta 1): i rilasci (codice unico,
 * un rilascio per merge), le run di CI, le impostazioni del repository, le PR
 * dei colleghi, gli ambienti per repository (R-L2) con una sola produzione,
 * e l'evento `release_page` della Chat.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const release = (projectId: string, repositoryId: string, over: Partial<typeof releases.$inferInsert> = {}) => ({
  code: `R${randomUUID().slice(0, 6)}-V1`,
  seq: Math.floor(Math.random() * 1e9),
  projectId,
  repositoryId,
  prNumber: 7,
  prUrl: "https://x/pr/7",
  title: "Una PR",
  mergeSha: randomUUID().replace(/-/g, ""),
  mergedAt: new Date(),
  viaStubwise: true,
  ...over,
});

describe("migrazione 0175", () => {
  it("un merge = un rilascio: lo stesso (repository, commit di merge) non entra due volte; il codice è unico", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const r = release(projectId, repositoryId);
    await t.db.insert(releases).values(r);
    await expectSqlState(t.db.insert(releases).values({ ...release(projectId, repositoryId), mergeSha: r.mergeSha }), "23505");
    await expectSqlState(t.db.insert(releases).values({ ...release(projectId, repositoryId), code: r.code }), "23505");
  });

  it("le run di un rilascio: stato fra tre, una sola per run del provider", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const [r] = await t.db.insert(releases).values(release(projectId, repositoryId)).returning();
    await t.db.insert(releaseCiRuns).values({ releaseId: r!.id, providerRunId: "1", name: "ci", status: "running" });
    await expectSqlState(t.db.insert(releaseCiRuns).values({ releaseId: r!.id, providerRunId: "1", name: "ci", status: "success" }), "23505");
    await expectSqlState(t.db.insert(releaseCiRuns).values({ releaseId: r!.id, providerRunId: "2", name: "ci", status: "cancelled" as never }), "23514");
  });

  it("le impostazioni del repository: i default (ramo null, pipeline auto, PR dei colleghi in solo analisi) e i valori ammessi", async () => {
    const { repositoryId } = await seedRepository(t.db);
    const [repo] = await t.db.select().from(repositories).where(eq(repositories.id, repositoryId));
    expect(repo).toMatchObject({ releaseBranch: null, releasePipeline: { mode: "auto" }, ciProvider: null, colleaguePrs: "analyze_only" });
    await expectSqlState(t.db.update(repositories).set({ colleaguePrs: "sempre" as never }).where(eq(repositories.id, repositoryId)), "23514");
    await expectSqlState(t.db.update(repositories).set({ ciProvider: "jenkins" as never }).where(eq(repositories.id, repositoryId)), "23514");
  });

  it("gli ambienti: un server per repository, e una sola produzione per progetto", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const [srv] = await t.db.insert(servers).values({ name: `s-${randomUUID().slice(0, 6)}`, keyHash: randomUUID() }).returning();
    const [prod] = await t.db.insert(projectEnvironments).values({ projectId, name: "production", kind: "production" }).returning();
    await t.db.insert(environmentServers).values({ environmentId: prod!.id, repositoryId, serverId: srv!.id });
    await expectSqlState(t.db.insert(environmentServers).values({ environmentId: prod!.id, repositoryId, serverId: srv!.id }), "23505");
    await expectSqlState(t.db.insert(projectEnvironments).values({ projectId, name: "prod-2", kind: "production" }), "23505");
  });

  it("un rilascio nuovo pubblica `release_page` nei canali del progetto che l'hanno acceso", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const [ch] = await t.db.insert(chatChannels).values({ projectId, kind: "project", name: `general-${randomUUID().slice(0, 4)}`, publishedEvents: ["release_page"] }).returning();
    const [r] = await t.db.insert(releases).values(release(projectId, repositoryId)).returning();
    const events = await t.db.select().from(chatMessages).where(and(eq(chatMessages.channelId, ch!.id), eq(chatMessages.eventKind, "release_page")));
    expect(events).toEqual([expect.objectContaining({ kind: "system", eventRefKind: "release", eventRefId: r!.id })]);
  });
});
