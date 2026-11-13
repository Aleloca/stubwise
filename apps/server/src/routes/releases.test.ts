import { randomUUID } from "node:crypto";
import { aiJobs, comments, projects, releaseCiRuns, releases, repositories, tickets, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 8, F1, S5: le rotte dei rilasci. Nascosto = inesistente (404); lo
 * stato DERIVATO dalle run; «Fai sistemare a Claude» una task normale, una
 * sola, solo per un rilascio fallito e con `tickets.create`.
 */

let t: TestDb;
let db: Db;
let app: FastifyInstance;
beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const person = () => createUserWithSession(app, `u-${randomUUID().slice(0, 8)}@acme.com`);
const call = (h: { cookie: string }, method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url: `/api${url}`, headers: h, ...(payload ? { payload } : {}) });

async function setup(runStatus: "running" | "success" | "failed" = "failed") {
  const { projectId, repositoryId } = await seedRepository(db);
  const code = `R${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  await db.update(projects).set({ code }).where(eq(projects.id, projectId));
  await db.update(repositories).set({ ciProvider: "github_actions" }).where(eq(repositories.id, repositoryId));
  const [rel] = await db
    .insert(releases)
    .values({ code: `${code}-V1`, seq: 1, projectId, repositoryId, prNumber: 4, prUrl: "https://x/pr/4", title: "Checkout", mergeSha: "d".repeat(40), mergedAt: new Date(), viaStubwise: true })
    .returning();
  await db.insert(releaseCiRuns).values({ releaseId: rel!.id, providerRunId: "1", name: "test", status: runStatus, failedStep: runStatus === "failed" ? "3 test rossi" : null, startedAt: new Date(), endedAt: runStatus === "running" ? null : new Date() });
  const lead = await person();
  const viewer = await person();
  const outsider = await person();
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, viewer.id, "viewer");
  return { projectId, release: rel!, lead, viewer, outsider };
}

describe("i rilasci", () => {
  it("elenco e dettaglio a chi vede il progetto, con lo stato derivato dalle run; a chi non lo vede 404", async () => {
    const s = await setup("failed");
    const list = await call(s.lead.headers, "GET", `/projects/${s.projectId}/releases`);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: { code: string; status: { kind: string } }[] }).items).toEqual([expect.objectContaining({ code: s.release.code, status: expect.objectContaining({ kind: "failed" }) })]);
    const detail = (await call(s.lead.headers, "GET", `/releases/${s.release.code}`)).json() as { runs: unknown[]; permissions: { fix: boolean } };
    expect(detail.runs).toEqual([expect.objectContaining({ name: "test", status: "failed", failedStep: "3 test rossi" })]);
    expect(detail.permissions.fix).toBe(true);
    expect((await call(s.outsider.headers, "GET", `/projects/${s.projectId}/releases`)).statusCode).toBe(404);
    expect((await call(s.outsider.headers, "GET", `/releases/${s.release.code}`)).statusCode).toBe(404);
  });

  it("review F1: una CI mai letta perché illeggibile (permessi del token) è «unknown», mai «in corso» o «non in produzione»; letta, torna allo stato delle run", async () => {
    const s = await setup("running");
    await db.delete(releaseCiRuns).where(eq(releaseCiRuns.releaseId, s.release.id));
    const statusNow = async () => ((await call(s.lead.headers, "GET", `/releases/${s.release.code}`)).json() as { status: { kind: string } }).status.kind;
    // Mai provata: entro la soglia dal merge le run possono ancora partire.
    expect(await statusNow()).toBe("running");
    await db.update(releases).set({ ciUnreadableAt: new Date() }).where(eq(releases.id, s.release.id));
    expect(await statusNow()).toBe("unknown");
    // Con una run letta prima, la lettura fallita dopo non la cancella.
    await db.insert(releaseCiRuns).values({ releaseId: s.release.id, providerRunId: "2", name: "test", status: "success", startedAt: new Date(), endedAt: new Date() });
    expect(await statusNow()).toBe("succeeded");
  });

  it("«Fai sistemare a Claude»: una task bug col passo fallito e la nota; un altro clic restituisce la stessa (existing) e la nota diventa un commento; il dettaglio la mostra aperta", async () => {
    const s = await setup("failed");
    const res = await call(s.lead.headers, "POST", `/releases/${s.release.code}/fix`, { note: "Guarda il test del carrello" });
    expect(res.statusCode).toBe(201);
    const first = res.json() as { taskId: string; existing: boolean; noteAdded: boolean; started: boolean };
    expect(first).toMatchObject({ existing: false, noteAdded: true, started: false });
    const [task] = await db.select().from(tickets).where(eq(tickets.id, first.taskId));
    expect(task).toMatchObject({ type: "bug", projectId: s.projectId });
    expect(task!.body).toContain("3 test rossi");
    expect(task!.body).toContain("Guarda il test del carrello");
    const again = await call(s.lead.headers, "POST", `/releases/${s.release.code}/fix`, { note: "Anche il checkout" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ taskId: first.taskId, existing: true, noteAdded: true });
    expect((await db.select().from(comments).where(eq(comments.ticketId, first.taskId))).map((c) => c.body)).toContain("Anche il checkout");
    expect((await db.select().from(tickets).where(eq(tickets.projectId, s.projectId))).length).toBe(1);
    const detail = (await call(s.lead.headers, "GET", `/releases/${s.release.code}`)).json() as { fixTask: { id: string; open: boolean } | null; permissions: { fix: boolean } };
    expect(detail.fixTask).toMatchObject({ id: first.taskId, open: true });
    expect(detail.permissions.fix).toBe(false);
  });

  it("chiusa la task di riparazione, il rilascio ancora fallito ne fa nascere una nuova", async () => {
    const s = await setup("failed");
    const first = (await call(s.lead.headers, "POST", `/releases/${s.release.code}/fix`, {})).json() as { taskId: string };
    await db.update(tickets).set({ closedAt: new Date() }).where(eq(tickets.id, first.taskId));
    const second = await call(s.lead.headers, "POST", `/releases/${s.release.code}/fix`, {});
    expect(second.statusCode).toBe(201);
    expect((second.json() as { taskId: string }).taskId).not.toBe(first.taskId);
  });

  it("start: con runs.start Claude parte sulla task (un job), e la riga dice permissions.startFix; waitsOnViewer per chi ha fatto il merge", async () => {
    const s = await setup("failed");
    await db.update(releases).set({ mergedBy: s.lead.id }).where(eq(releases.id, s.release.id));
    const [row] = ((await call(s.lead.headers, "GET", `/projects/${s.projectId}/releases`)).json() as { items: { permissions: { fix: boolean; startFix: boolean }; waitsOnViewer: boolean }[] }).items;
    expect(row).toMatchObject({ permissions: { fix: true, startFix: true }, waitsOnViewer: true });
    const out = (await call(s.lead.headers, "POST", `/releases/${s.release.code}/fix`, { start: true })).json() as { taskId: string; started: boolean };
    expect(out.started).toBe(true);
    expect(await db.select().from(aiJobs).where(eq(aiJobs.ticketId, out.taskId))).toHaveLength(1);
    const [after] = ((await call(s.lead.headers, "GET", `/projects/${s.projectId}/releases`)).json() as { items: { waitsOnViewer: boolean }[] }).items;
    expect(after!.waitsOnViewer).toBe(false);
  });

  it("un rilascio non fallito non si fa sistemare (409); senza tickets.create 403 e nessuna task", async () => {
    const ok = await setup("success");
    expect((await call(ok.lead.headers, "POST", `/releases/${ok.release.code}/fix`, {})).statusCode).toBe(409);
    const s = await setup("failed");
    const before = (await db.select().from(tickets).where(eq(tickets.projectId, s.projectId))).length;
    expect((await call(s.viewer.headers, "POST", `/releases/${s.release.code}/fix`, {})).statusCode).toBe(403);
    expect((await db.select().from(tickets).where(eq(tickets.projectId, s.projectId))).length).toBe(before);
    expect(((await call(s.viewer.headers, "GET", `/releases/${s.release.code}`)).json() as { permissions: { fix: boolean } }).permissions.fix).toBe(false);
  });
});
