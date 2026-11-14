import { randomUUID } from "node:crypto";
import { alertSubscriptions, notifications, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { publishNotification } from "@stubwise/notifications";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

/** Area 8, F2, S5: le iscrizioni agli avvisi di chi chiede, per progetto. */

let t: TestDb;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://s.example" });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

type Row = { type: string; app: boolean; phone: boolean; state: string; suspendedReason: string | null; mandatory: string[] };
const person = async (preset: string, projectId: string) => {
  const u = await createUserWithPat(app, `u-${randomUUID().slice(0, 8)}@acme.com`);
  await addMember(app, projectId, u.id, preset);
  return u;
};
const list = async (headers: Record<string, string>, projectId: string) =>
  ((await app.inject({ method: "GET", url: "/api/me/alert-subscriptions", headers })).json() as { items: { projectId: string; rows: Row[] }[] }).items.find((p) => p.projectId === projectId)!.rows;
const rowOf = (rows: Row[], type: string) => rows.find((r) => r.type === type)!;
const put = (headers: Record<string, string>, projectId: string, type: string, payload: object) =>
  app.inject({ method: "PUT", url: `/api/me/alert-subscriptions/${projectId}/${encodeURIComponent(type)}`, headers, payload });

describe("le iscrizioni agli avvisi (area 8, F2, S5)", () => {
  it("lo stato lo calcola il server: default dai permessi, sospeso senza il permesso, solo obbligatorio", async () => {
    const { projectId } = await seedRepository(t.db);
    const lead = await person("project_lead", projectId);
    const contributor = await person("contributor", projectId);
    const leadRows = await list(lead.headers, projectId);
    expect(rowOf(leadRows, "release.failed")).toMatchObject({ app: true, phone: true, state: "on", mandatory: ["merged", "task_author"] });
    expect(rowOf(leadRows, "release.merged")).toMatchObject({ app: false, state: "off" });
    expect(rowOf(leadRows, "pr.corrected")).toMatchObject({ state: "mandatory" });
    // La riga dei server (monitor.* confluisce in server.trouble): `monitor.manage` è d'istanza, il lead non l'ha.
    expect(rowOf(leadRows, "server.trouble")).toMatchObject({ app: false, state: "off" });
    const cRows = await list(contributor.headers, projectId);
    expect(rowOf(cRows, "pr.analysis_issues")).toMatchObject({ state: "suspended", suspendedReason: "repos.view" });
  });

  it("46: senza riga il Telefono di partenza vuole anche `push` di oggi", async () => {
    const { projectId } = await seedRepository(t.db);
    const lead = await person("project_lead", projectId);
    await t.db.update(users).set({ notifyPush: false }).where(eq(users.id, lead.id));
    expect(rowOf(await list(lead.headers, projectId), "release.failed")).toMatchObject({ app: true, phone: false });
  });

  it("PUT scrive la riga e i suoi partner, e la pubblicazione la rispetta", async () => {
    const { projectId } = await seedRepository(t.db);
    const lead = await person("project_lead", projectId);
    const res = await put(lead.headers, projectId, "server.trouble", { app: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "server.trouble", app: true, state: "on" });
    const written = (await t.db.select().from(alertSubscriptions).where(and(eq(alertSubscriptions.userId, lead.id), eq(alertSubscriptions.projectId, projectId)))).map((r) => r.alertType).sort();
    // La riga dei server e i kind che vi confluiscono (`sameRowAs`): tutti scritti insieme.
    for (const k of ["server.trouble", "server.down", "server.recovered", "monitor.alert", "monitor.recovered"]) expect(written).toContain(k);
    await publishNotification(t.db, { kind: "monitor.alert", serverName: "web", condition: "disk", detail: "d", url: "u" }, { projectId });
    const cards = await t.db.select().from(notifications).where(and(eq(notifications.userId, lead.id), eq(notifications.kind, "monitor.alert")));
    expect(cards).toHaveLength(1);
  });

  it("403 su una riga solo obbligatoria o sospesa; 404 su un progetto che non si vede o un tipo che non c'è", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    expect((await put(contributor.headers, projectId, "pr.corrected", { app: true })).json()).toMatchObject({ code: "alert_mandatory_only" });
    expect((await put(contributor.headers, projectId, "pr.analysis_issues", { app: true })).statusCode).toBe(403);
    const { projectId: other } = await seedRepository(t.db);
    expect((await put(contributor.headers, other, "release.failed", { app: false })).statusCode).toBe(404);
    expect((await put(contributor.headers, projectId, "boh.nulla", { app: false })).statusCode).toBe(404);
  });

  it("«Mute» spegne tutto e risponde con le righe di prima; «Copia da» prende i valori dell'altro progetto", async () => {
    const { projectId: a } = await seedRepository(t.db);
    const { projectId: b } = await seedRepository(t.db);
    const lead = await person("project_lead", a);
    await addMember(app, b, lead.id, "project_lead");
    await put(lead.headers, a, "release.merged", { app: true });
    const mute = await app.inject({ method: "POST", url: `/api/me/alert-subscriptions/${a}/mute`, headers: lead.headers });
    expect(rowOf((mute.json() as { before: Row[] }).before, "release.merged")).toMatchObject({ app: true });
    expect((await list(lead.headers, a)).filter((r) => r.state === "on")).toEqual([]);
    // Copia in A da B (di partenza: release.failed acceso).
    const copy = await app.inject({ method: "POST", url: `/api/me/alert-subscriptions/${a}/copy`, headers: lead.headers, payload: { fromProjectId: b } });
    expect(copy.statusCode).toBe(200);
    expect(rowOf((copy.json() as { before: Row[] }).before, "release.failed")).toMatchObject({ app: false });
    expect(rowOf(await list(lead.headers, a), "release.failed")).toMatchObject({ app: true });
  });
});
