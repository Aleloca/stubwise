import { randomUUID } from "node:crypto";
import { aiJobs, environmentServers, instanceSettings, prCorrections, projectEnvironments, servers, ticketRepositories } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Rimandi, lotto 4 (D-7.1, il maintainer, 23 nov 2026): a budget MENSILE
 * finito un avvio a mano legato a un progetto lo rifiuta SUBITO (409
 * `budget_exhausted`) chi non ha `plans.approve` nel progetto; chi ce l'ha lo
 * scavalca come prima. Un avvio senza progetto (l'analisi a mano di un server)
 * si ferma per tutti. `/work` dice `monthly_budget` solo a chi non lo scavalca.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let u: SeededUsers;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), encryptionKey: Buffer.alloc(32, 3).toString("base64") });
  u = await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});
const exhaust = () => t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "0" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "0" } });
afterEach(async () => {
  await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null }).where(eq(instanceSettings.id, 1));
});

async function people() {
  const { ticketId, projectId, repositoryId } = await seedTicket(t.db);
  const dev = await createUserWithSession(app, `dev-${randomUUID().slice(0, 6)}@acme.com`);
  const lead = await createUserWithSession(app, `lead-${randomUUID().slice(0, 6)}@acme.com`);
  await addMember(app, projectId, dev.id, "developer"); // runs.start, corrections.request; niente plans.approve
  await addMember(app, projectId, lead.id, "project_lead"); // plans.approve
  return { ticketId, projectId, repositoryId, dev, lead };
}
const post = (cookie: string, url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: { cookie }, payload });

describe("D-7.1: il budget mensile finito e gli avvii a mano", () => {
  it("Start di una task: chi non ha `plans.approve` riceve 409 `budget_exhausted` e nessun job nasce; chi ce l'ha parte come sempre", async () => {
    const s = await people();
    await exhaust();
    const refused = await post(s.dev.headers.cookie, `/api/tickets/${s.ticketId}/run-ai`);
    expect([refused.statusCode, (refused.json() as { code: string }).code]).toEqual([409, "budget_exhausted"]);
    expect(await t.db.select().from(aiJobs).where(eq(aiJobs.ticketId, s.ticketId))).toEqual([]);
    const started = await post(s.lead.headers.cookie, `/api/tickets/${s.ticketId}/run-ai`);
    expect(started.statusCode, started.body).toBe(202);
  });

  it("«Chiedi modifiche»: chi non ha `plans.approve` è rifiutato subito, nessuna correzione; chi ce l'ha la chiede", async () => {
    const s = await people();
    await t.db.insert(ticketRepositories).values({ ticketId: s.ticketId, repositoryId: s.repositoryId, branch: "stubwise/ticket-1", prUrl: "https://github.com/acme/repo/pull/42", prState: "open", prNumber: 42 });
    await exhaust();
    const url = `/api/tickets/${s.ticketId}/repositories/${s.repositoryId}/corrections`;
    const refused = await post(s.dev.headers.cookie, url);
    expect([refused.statusCode, (refused.json() as { code: string }).code]).toEqual([409, "budget_exhausted"]);
    expect(await t.db.select().from(prCorrections).where(eq(prCorrections.ticketId, s.ticketId))).toEqual([]);
    const asked = await post(s.lead.headers.cookie, url);
    expect(asked.statusCode, asked.body).toBe(202);
  });

  it("`/work`: `blocked` dice `monthly_budget` a chi non lo scavalca, null a chi ha `plans.approve`", async () => {
    const s = await people();
    await exhaust();
    const work = async (cookie: string) => ((await app.inject({ method: "GET", url: `/api/tasks/${s.ticketId}/work`, headers: { cookie } })).json() as { blocked: unknown }).blocked;
    expect(await work(s.dev.headers.cookie)).toEqual({ reason: "monthly_budget" });
    expect(await work(s.lead.headers.cookie)).toBeNull();
  });

  it("senza un progetto (l'analisi a mano di un server) il budget finito ferma TUTTI, anche un full admin", async () => {
    const s = await people();
    const [server] = await t.db.insert(servers).values({ name: `srv-${randomUUID().slice(0, 6)}`, keyHash: randomUUID(), keyPrefix: "sk_x" } as never).returning({ id: servers.id });
    const [env] = await t.db.insert(projectEnvironments).values({ projectId: s.projectId, name: "prod", kind: "production" } as never).returning({ id: projectEnvironments.id });
    await t.db.insert(environmentServers).values({ environmentId: env!.id, repositoryId: s.repositoryId, serverId: server!.id });
    // Senza budget finito l'analisi parte (la richiesta è accettata).
    expect((await post(u.adminCookie, `/api/servers/${server!.id}/analyses`)).statusCode).toBe(202);
    await t.db.delete((await import("@stubwise/db")).serverAnalyses).where(eq((await import("@stubwise/db")).serverAnalyses.serverId, server!.id));
    await exhaust();
    const res = await post(u.adminCookie, `/api/servers/${server!.id}/analyses`);
    expect([res.statusCode, (res.json() as { code: string }).code]).toEqual([409, "budget_exhausted"]);
  });
});
