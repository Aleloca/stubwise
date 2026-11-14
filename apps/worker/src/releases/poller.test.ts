import { randomUUID } from "node:crypto";
import {
  alertSubscriptions,
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
  ticketRepositories,
  tickets,
  users,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { CommitRuns } from "@stubwise/git";
import { eq, sql } from "drizzle-orm";
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

  it("review F1: l'esito dell'ultima lettura si salva (illeggibile → ci_unreadable_at; letta → null)", async () => {
    const s = await setup();
    await poll(fake({ status: "unknown" }));
    expect((await reload(s.release.id)).ciUnreadableAt).not.toBeNull();
    await poll(fake({ status: "ok", runs: [{ id: "1", name: "build", status: "running", url: "h", failedStep: null, startedAt: new Date().toISOString(), endedAt: null }] }));
    expect((await reload(s.release.id)).ciUnreadableAt).toBeNull();
  });

  it("review F1: a turno — con più di 50 rilasci aperti, il giro dopo guarda quelli rimasti fuori", async () => {
    const s = await setup();
    const extra = [];
    for (let i = 0; i < 55; i++) {
      const [r] = await t.db
        .insert(releases)
        .values({ code: `RR${i}-${randomUUID().slice(0, 4)}`, seq: 100 + i, projectId: s.projectId, repositoryId: s.repositoryId, prNumber: 100 + i, prUrl: "u", title: "x", mergeSha: String(i).padStart(40, "a"), mergedAt: new Date(Date.now() - 3_600_000 + i * 1000), viaStubwise: true })
        .returning();
      extra.push(r!.id);
    }
    const running = fake({ status: "ok", runs: [{ id: "1", name: "build", status: "running", url: "h", failedStep: null, startedAt: new Date().toISOString(), endedAt: null }] });
    await poll(running);
    await poll(running);
    const polled = await t.db.select({ id: releases.id, at: releases.lastPolledAt }).from(releases).where(eq(releases.projectId, s.projectId));
    // Tutti i 56 (55 + quello del setup) sono stati guardati in due giri da 50.
    expect(polled.filter((r) => r.at === null)).toEqual([]);
  });

  it("review F1: un avviso la cui pubblicazione fallisce si riprova al giro dopo, e arriva una volta sola", async () => {
    const s = await setup();
    const failed: CommitRuns = { status: "ok", runs: [{ id: "9", name: "test", status: "failed", url: "h", failedStep: "x", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] };
    // Il primo giro: la scrittura delle notifiche fallisce (un trigger che lancia).
    await t.db.execute(sql`create or replace function stubwise_test_fail_notify() returns trigger language plpgsql as $$ begin raise exception 'giù'; end $$`);
    await t.db.execute(sql`create trigger stubwise_test_fail_notify before insert on notifications for each row execute function stubwise_test_fail_notify()`);
    try {
      await poll(fake(failed));
    } finally {
      await t.db.execute(sql`drop trigger stubwise_test_fail_notify on notifications`);
      await t.db.execute(sql`drop function stubwise_test_fail_notify()`);
    }
    expect(await reload(s.release.id)).toMatchObject({ failedNotifiedAt: null, runsSettledAt: null });
    expect(await cardsOf(s.leadId)).toEqual([]);
    await poll(fake(failed));
    await poll(fake(failed));
    expect(await cardsOf(s.leadId)).toHaveLength(1);
  });

  it("review F2 (46), 2: nessun destinatario (tutti hanno spento release.failed) non è un errore: il segno resta e il rilascio si sistema", async () => {
    const s = await setup();
    await t.db.insert(alertSubscriptions).values({ userId: s.leadId, projectId: s.projectId, alertType: "release.failed", app: false, phone: false });
    // Anche i full admin dell'istanza (ricevono di partenza): spenti anche loro.
    const admins = await t.db.execute<{ id: string }>(sql`select u.id from users u join roles r on r.id = u.instance_role_id where r.permissions @> array['instance.full_admin']::text[]`);
    for (const a of admins) {
      await t.db.insert(alertSubscriptions).values({ userId: a.id, projectId: s.projectId, alertType: "release.failed", app: false, phone: false }).onConflictDoNothing();
    }
    const failed: CommitRuns = { status: "ok", runs: [{ id: "9", name: "test", status: "failed", url: "h", failedStep: "x", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] };
    await poll(fake(failed));
    const after = await reload(s.release.id);
    expect(after.failedNotifiedAt).not.toBeNull();
    expect(after.runsSettledAt).not.toBeNull();
    expect(await cardsOf(s.leadId)).toEqual([]);
  });

  it("review F1: una repository senza la sua riga in environment_servers usa il server dell'ambiente (`server_id`)", async () => {
    const s = await setup({ ciProvider: null });
    const [srv] = await t.db.insert(servers).values({ name: `s-${randomUUID().slice(0, 6)}`, keyHash: randomUUID() }).returning();
    await t.db.insert(projectEnvironments).values({ projectId: s.projectId, name: "production", kind: "production", serverId: srv!.id });
    await t.db.insert(serverMetrics).values({ serverId: srv!.id, ts: new Date(), cpuPct: 1, load1m: 0, memUsedBytes: 1, memTotalBytes: 2, swapUsedBytes: 0, diskUsedBytes: 0, diskTotalBytes: 1, netRxBytes: 0, netTxBytes: 0, disks: [], services: [{ name: "web", kind: "docker", status: "running", commitSha: "c".repeat(12) }] } as never);
    await poll({});
    expect((await reload(s.release.id)).seenInProductionAt).not.toBeNull();
  });

  describe("area 8, F2, S4: gli avvisi del rilascio dal catalogo", () => {
    const memberAs = async (projectId: string, preset: string) => {
      const [u] = await t.db.insert(users).values({ email: `m-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
      const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, preset));
      await t.db.insert(projectMembers).values({ projectId, userId: u!.id, roleId: role!.id });
      return u!.id;
    };
    const failedRun: CommitRuns = { status: "ok", runs: [{ id: "9", name: "test", status: "failed", url: "h", failedStep: "x", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] };
    const cardsFor = async (userId: string, kind: string) => (await t.db.select().from(notifications).where(eq(notifications.userId, userId))).filter((n) => n.kind === kind);

    it("release.failed: chi ha fatto il merge (senza release.merge) la riceve da obbligatorio", async () => {
      const s = await setup();
      const merger = await memberAs(s.projectId, "viewer");
      await t.db.update(releases).set({ mergedBy: merger }).where(eq(releases.id, s.release.id));
      await poll(fake(failedRun));
      const cards = await cardsFor(merger, "release.failed");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.event).toMatchObject({ alertMandatory: "merged" });
    });

    it("release.failed: merge di un'identità non collegata → l'autore della task della PR", async () => {
      const s = await setup();
      const author = await memberAs(s.projectId, "viewer");
      const [tk] = await t.db.insert(tickets).values({ projectId: s.projectId, number: 900 + Math.floor(Math.random() * 1000), title: "Checkout", type: "feature", priority: "medium", source: "manual", requestedByUserId: author }).returning();
      await t.db.insert(ticketRepositories).values({ ticketId: tk!.id, repositoryId: s.repositoryId, branch: "stubwise/ticket-1", prUrl: "u", prNumber: 3, prState: "merged" });
      await poll(fake(failedRun));
      expect((await cardsFor(author, "release.failed"))[0]?.event).toMatchObject({ alertMandatory: "task_author" });
    });

    it("release.succeeded: a chi si è iscritto, UNA volta sola", async () => {
      const s = await setup();
      const sub = await memberAs(s.projectId, "viewer");
      await t.db.insert(alertSubscriptions).values({ userId: sub, projectId: s.projectId, alertType: "release.succeeded", app: true, phone: false });
      const ok: CommitRuns = { status: "ok", runs: [{ id: "1", name: "build", status: "success", url: "h", failedStep: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] };
      await poll(fake(ok));
      await t.db.update(releases).set({ runsSettledAt: null }).where(eq(releases.id, s.release.id));
      await poll(fake(ok));
      expect(await cardsFor(sub, "release.succeeded")).toHaveLength(1);
      expect(await cardsFor(s.leadId, "release.succeeded")).toEqual([]);
    });
  });

  it("fuori dalla finestra si sistema così com'è", async () => {
    const s = await setup();
    await t.db.update(releases).set({ mergedAt: new Date(Date.now() - (RELEASE_WATCH_HOURS + 1) * 3_600_000) }).where(eq(releases.id, s.release.id));
    await poll(fake({ status: "unknown" }));
    expect((await reload(s.release.id)).runsSettledAt).not.toBeNull();
  });
});
