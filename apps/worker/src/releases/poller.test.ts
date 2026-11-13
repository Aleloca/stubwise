import { randomUUID } from "node:crypto";
import {
  encrypt,
  environmentServers,
  gitAccounts,
  notifications,
  projectEnvironments,
  projectMembers,
  releaseCiRuns,
  releases,
  repositories,
  roles,
  serverMetrics,
  servers,
  users,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { CommitRuns } from "@stubwise/git";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollReleasesOnce, RELEASE_WATCH_HOURS } from "./poller.js";

/**
 * Area 8, F1, S4: lo stato dopo il merge. Le run di CI del commit di merge
 * (lette dal provider, scritte in `release_ci_runs`), il commit in produzione
 * (`seen_in_production_at`, dal server della repository, R-L2), l'avviso
 * `release.failed` UNA volta sola, mai «riuscito» su una lettura illeggibile.
 */

const KEY = Buffer.alloc(32, 9);
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function setup(opts: { ciProvider?: "github_actions" | null } = {}) {
  const { projectId, repositoryId } = await seedRepository(t.db);
  const [repo] = await t.db.select().from(repositories).where(eq(repositories.id, repositoryId));
  await t.db.update(gitAccounts).set({ encryptedCredentials: encrypt(JSON.stringify({ token: "t" }), KEY) }).where(eq(gitAccounts.id, repo!.gitAccountId));
  await t.db.update(repositories).set({ ciProvider: opts.ciProvider === undefined ? "github_actions" : opts.ciProvider }).where(eq(repositories.id, repositoryId));
  const [lead] = await t.db.insert(users).values({ email: `l-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "project_lead"));
  await t.db.insert(projectMembers).values({ projectId, userId: lead!.id, roleId: role!.id });
  const [rel] = await t.db
    .insert(releases)
    .values({ code: `R${randomUUID().slice(0, 5)}-V1`, seq: 1, projectId, repositoryId, prNumber: 3, prUrl: "u", title: "Checkout", mergeSha: "c".repeat(40), mergedAt: new Date(Date.now() - 60_000), viaStubwise: true })
    .returning();
  return { projectId, repositoryId, leadId: lead!.id, release: rel! };
}

const fake = (out: CommitRuns) => ({ providerFor: () => ({ getCommitRuns: async () => out }) });
const poll = (extra: object) => pollReleasesOnce({ db: t.db, encryptionKey: KEY, publicUrl: "https://s.example", ...extra });
const reload = async (id: string) => (await t.db.select().from(releases).where(eq(releases.id, id)))[0]!;
const cardsOf = (userId: string) => t.db.select().from(notifications).where(eq(notifications.userId, userId)).then((r) => r.filter((n) => n.kind === "release.failed"));

describe("pollReleasesOnce", () => {
  it("le run in corso si scrivono e il rilascio resta da guardare; riuscite, si sistema senza avvisi", async () => {
    const s = await setup();
    await poll(fake({ status: "ok", runs: [{ id: "1", name: "build", status: "running", url: "h", failedStep: null, startedAt: new Date().toISOString(), endedAt: null }] }));
    expect(await t.db.select().from(releaseCiRuns).where(eq(releaseCiRuns.releaseId, s.release.id))).toEqual([expect.objectContaining({ providerRunId: "1", status: "running" })]);
    expect((await reload(s.release.id)).runsSettledAt).toBeNull();
    await poll(fake({ status: "ok", runs: [{ id: "1", name: "build", status: "success", url: "h", failedStep: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] }));
    expect((await reload(s.release.id)).runsSettledAt).not.toBeNull();
    expect(await cardsOf(s.leadId)).toEqual([]);
  });

  it("una run fallita: l'avviso release.failed a chi ha release.merge, UNA volta sola", async () => {
    const s = await setup();
    const failed: CommitRuns = { status: "ok", runs: [{ id: "9", name: "test", status: "failed", url: "h", failedStep: "3 test rossi", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] };
    await poll(fake(failed));
    await t.db.update(releases).set({ runsSettledAt: null }).where(eq(releases.id, s.release.id));
    await poll(fake(failed));
    const cards = await cardsOf(s.leadId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.event).toMatchObject({ releaseCode: s.release.code, failedRun: "test" });
    expect((await reload(s.release.id)).failedNotifiedAt).not.toBeNull();
  });

  it("una lettura illeggibile senza run già lette: niente «riuscito», niente avviso, il rilascio resta da guardare", async () => {
    const s = await setup();
    await poll(fake({ status: "unknown" }));
    expect(await reload(s.release.id)).toMatchObject({ runsSettledAt: null, failedNotifiedAt: null });
    expect(await cardsOf(s.leadId)).toEqual([]);
  });

  it("senza CI: il commit in produzione sul server della repository (R-L2) lo fa «in produzione», e si sistema", async () => {
    const s = await setup({ ciProvider: null });
    const [srv] = await t.db.insert(servers).values({ name: `s-${randomUUID().slice(0, 6)}`, keyHash: randomUUID() }).returning();
    const [env] = await t.db.insert(projectEnvironments).values({ projectId: s.projectId, name: "production", kind: "production" }).returning();
    await t.db.insert(environmentServers).values({ environmentId: env!.id, repositoryId: s.repositoryId, serverId: srv!.id });
    await t.db.insert(serverMetrics).values({ serverId: srv!.id, ts: new Date(), cpuPct: 1, load1m: 0, memUsedBytes: 1, memTotalBytes: 2, swapUsedBytes: 0, diskUsedBytes: 0, diskTotalBytes: 1, netRxBytes: 0, netTxBytes: 0, disks: [], services: [{ name: "web", kind: "docker", status: "running", commitSha: "c".repeat(12) }] } as never);
    await poll({});
    const after = await reload(s.release.id);
    expect(after.seenInProductionAt).not.toBeNull();
    expect(after.runsSettledAt).not.toBeNull();
  });

  it("fuori dalla finestra si sistema così com'è", async () => {
    const s = await setup();
    await t.db.update(releases).set({ mergedAt: new Date(Date.now() - (RELEASE_WATCH_HOURS + 1) * 3_600_000) }).where(eq(releases.id, s.release.id));
    await poll(fake({ status: "unknown" }));
    expect((await reload(s.release.id)).runsSettledAt).not.toBeNull();
  });
});
