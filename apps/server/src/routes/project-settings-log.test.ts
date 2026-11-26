import { aiProviders, changeLog, projects, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/** Area 9, F5, Task 5: la regola del pulse e le voci delle scritture del progetto. */
let t: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 5).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const patch = (projectId: string, payload: object) => app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: adminCookie }, payload });
const put = (url: string, payload: object) => app.inject({ method: "PUT", url, headers: { cookie: adminCookie }, payload });
const entries = (projectId: string, type?: string) =>
  db
    .select()
    .from(changeLog)
    .where(and(eq(changeLog.projectId, projectId), type ? eq(changeLog.type, type) : undefined))
    .orderBy(changeLog.at, changeLog.id);
const projectOf = async (id: string) => (await db.select().from(projects).where(eq(projects.id, id)))[0]!;

describe("la regola del pulse (K-2)", () => {
  it("NEGATIVI: il pulse acceso senza la discovery è 400 pulse_needs_backlog, anche insieme allo spegnimento; niente cambia, nessuna voce", async () => {
    const { projectId } = await seedRepository(db);
    const res = await patch(projectId, { pulseEnabled: true, name: "Non deve passare" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "pulse_needs_backlog" });
    await patch(projectId, { backlogEnabled: true });
    expect((await patch(projectId, { backlogEnabled: false, pulseEnabled: true })).statusCode).toBe(400);
    const p = await projectOf(projectId);
    expect(p).toMatchObject({ pulseEnabled: false, backlogEnabled: true });
    expect(p.name).not.toBe("Non deve passare");
    expect(await entries(projectId, "project.renamed")).toHaveLength(0);
  });

  it("spegnere la discovery spegne il pulse nello stesso salvataggio: due voci", async () => {
    const { projectId } = await seedRepository(db);
    expect((await patch(projectId, { backlogEnabled: true, pulseEnabled: true })).statusCode).toBe(200);
    const res = await patch(projectId, { backlogEnabled: false });
    expect(res.json()).toMatchObject({ backlogEnabled: false, pulseEnabled: false });
    const switches = (await entries(projectId, "project.switch_changed")).slice(-2).map((e) => e.data);
    expect(switches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ before: "on", after: "off", params: { switch: "backlogDiscovery" } }),
        expect.objectContaining({ before: "on", after: "off", params: { switch: "pulse" } }),
      ]),
    );
  });
});

describe("le voci del PATCH del progetto", () => {
  it("ogni campo coi suoi valori stabili; la descrizione senza testo; un salvataggio uguale non scrive", async () => {
    const { projectId } = await seedRepository(db);
    const p0 = await projectOf(projectId);
    const [acct] = await db.insert(aiProviders).values({ position: 1, kind: "api_key", label: "Backup Max", secretEncrypted: "x" }).returning({ id: aiProviders.id });
    const body = {
      name: "Nome nuovo",
      description: "testo-della-descrizione",
      modules: p0.modules.includes("docs") ? p0.modules.filter((m) => m !== "docs") : [...p0.modules, "docs"],
      aiProviderId: acct!.id,
      aiProviderExclusive: true,
      dailyReportEnabled: !p0.dailyReportEnabled,
      pulseEveryDays: 7,
      prCorrectionMaxRounds: 5,
    };
    expect((await patch(projectId, body)).statusCode).toBe(200);
    const byType = new Map((await entries(projectId)).map((e) => [e.type, e.data as { object: unknown; before: string | null; after: string | null; params: Record<string, string> }]));
    expect(byType.get("project.renamed")).toMatchObject({ object: { type: "project", id: projectId }, before: p0.name, after: "Nome nuovo" });
    expect(byType.get("project.description_changed")).toMatchObject({ before: null, after: null });
    expect(JSON.stringify(byType.get("project.description_changed"))).not.toContain("testo-della-descrizione");
    const docsOn = !p0.modules.includes("docs");
    expect(byType.get("project.docs_toggled")).toMatchObject({ before: docsOn ? "off" : "on", after: docsOn ? "on" : "off" });
    expect(byType.get("project.ai_account_changed")).toMatchObject({ before: "auto", after: `account:${acct!.id}:exclusive`, params: { accountAfter: "Backup Max" } });
    expect(byType.get("project.switch_changed")).toMatchObject({ params: { switch: "dailyReport" }, after: p0.dailyReportEnabled ? "off" : "on" });
    expect(byType.get("project.pulse_interval_changed")).toMatchObject({ before: String(p0.pulseEveryDays), after: "7" });
    expect(byType.get("project.correction_cap_changed")).toMatchObject({ before: String(p0.prCorrectionMaxRounds), after: "5" });
    const count = (await entries(projectId)).length;
    expect((await patch(projectId, body)).statusCode).toBe(200);
    expect(await entries(projectId)).toHaveLength(count);
    // Tolto l'account: torna `auto`, col nome di allora come «prima».
    await patch(projectId, { aiProviderId: null });
    expect((await entries(projectId, "project.ai_account_changed")).at(-1)!.data).toMatchObject({ before: `account:${acct!.id}:exclusive`, after: "auto", params: { accountBefore: "Backup Max" } });
  });
});

describe("le soglie di stallo e gli stati", () => {
  it("soglie: changedFields coi numeri in stringa, solo i campi cambiati; uguale → nessuna voce", async () => {
    const { projectId } = await seedRepository(db);
    const p0 = await projectOf(projectId);
    const url = `/api/projects/${projectId}/stall-thresholds`;
    expect((await put(url, { activeDays: p0.stallActiveDays + 1, todoDays: p0.stallTodoDays })).statusCode).toBe(200);
    const [e] = await entries(projectId, "project.stall_thresholds_changed");
    expect(e!.data).toMatchObject({ before: JSON.stringify({ activeDays: String(p0.stallActiveDays) }), after: JSON.stringify({ activeDays: String(p0.stallActiveDays + 1) }) });
    await put(url, { activeDays: p0.stallActiveDays + 1, todoDays: p0.stallTodoDays });
    expect(await entries(projectId, "project.stall_thresholds_changed")).toHaveLength(1);
  });

  it("stati: i nomi nell'ordine e «nome:famiglia» di chi ha cambiato famiglia; uguale → nessuna voce", async () => {
    const { projectId } = await seedRepository(db);
    const url = `/api/projects/${projectId}/statuses`;
    const list = (await app.inject({ method: "GET", url, headers: { cookie: adminCookie } })).json() as { id: string; name: string; family: string }[];
    const same = { statuses: list.map((s) => ({ id: s.id, name: s.name, family: s.family })), reassign: {} };
    expect((await put(url, same)).statusCode).toBe(200);
    expect(await entries(projectId, "project.statuses_changed")).toHaveLength(0);
    // Il primo stato cambia nome, nessuna famiglia cambia: `statusFamilies` resta fuori.
    const renamed = same.statuses.map((s, i) => (i === 0 ? { ...s, name: `${s.name} bis` } : s));
    expect((await put(url, { statuses: renamed, reassign: {} })).statusCode).toBe(200);
    const [e] = await entries(projectId, "project.statuses_changed");
    expect(e!.data).toMatchObject({ before: JSON.stringify({ statuses: list.map((s) => s.name) }), after: JSON.stringify({ statuses: renamed.map((s) => s.name) }) });
  });
});
