import { changeLog, plugins, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F3, Task 6: il registro delle impostazioni d'istanza (9b). Ogni
 * scrittura lascia la sua voce, coi valori STABILI del prototipo
 * (`settingValues.ts`): on/off, l'importo come numero, il locale, i soli campi
 * cambiati in JSON; un segreto solo «sostituito», mai il valore.
 */

const SECRET = "valore-segretissimo-1234567890";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 21).toString("base64"), publicUrl: "https://s.example.com" });
  await seedUsers(app);
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com"));
  cookie = await fullSessionCookie(app, admin!.id);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const entries = (type: string, subjectId?: string) =>
  db
    .select()
    .from(changeLog)
    .where(subjectId ? and(eq(changeLog.type, type), eq(changeLog.subjectId, subjectId)) : eq(changeLog.type, type))
    .orderBy(asc(changeLog.at), asc(changeLog.id));
const data = async (type: string, subjectId?: string) => (await entries(type, subjectId)).map((e) => e.data as Record<string, unknown>);

describe("il registro della 9b", () => {
  it("provider: creato col tipo, interruttore on/off, nome, credenziale sostituita senza valore, riordinato, eliminato", async () => {
    const a = (await call("POST", "/api/ai-providers", { kind: "api_key", label: "Primo", secret: SECRET })).json() as { id: string };
    const b = (await call("POST", "/api/ai-providers", { kind: "account", label: "Secondo", secret: SECRET })).json() as { id: string };
    expect(await data("provider.created", a.id)).toEqual([expect.objectContaining({ object: { type: "provider", id: a.id, label: "Primo" }, params: { kind: "api_key" } })]);
    expect((await call("PATCH", `/api/ai-providers/${a.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await call("PATCH", `/api/ai-providers/${a.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await call("PATCH", `/api/ai-providers/${a.id}`, { label: "Rinominato", secret: `${SECRET}-2` })).statusCode).toBe(200);
    expect(await data("provider.updated", a.id)).toEqual([
      expect.objectContaining({ before: "on", after: "off" }),
      expect.objectContaining({ before: "Primo", after: "Rinominato", params: { field: "name" } }),
    ]);
    expect(await entries("provider.credential_replaced", a.id)).toHaveLength(1);
    const order = (await call("POST", "/api/ai-providers/reorder", { orderedIds: [b.id, a.id] })).statusCode;
    expect(order).toBe(200);
    expect(await data("provider.reordered")).toEqual([expect.objectContaining({ before: "Rinominato, Secondo", after: "Secondo, Rinominato" })]);
    await call("POST", "/api/ai-providers/reorder", { orderedIds: [b.id, a.id] });
    expect(await entries("provider.reordered")).toHaveLength(1);
    expect((await call("DELETE", `/api/ai-providers/${a.id}`)).statusCode).toBe(204);
    expect(await entries("provider.deleted", a.id)).toHaveLength(1);
  });

  it("budget, lingua e archiviazione: valori stabili, i soli campi cambiati, il secret solo sostituito; un salvataggio uguale non scrive", async () => {
    const base = { contentLanguage: "en", monthlyBudgetUsd: null };
    expect((await call("PUT", "/api/settings/instance", base)).statusCode).toBe(200);
    const before = (await db.select().from(changeLog)).length;
    const next = { contentLanguage: "it", monthlyBudgetUsd: 600, s3Endpoint: "https://s3.example.com", s3Region: "eu", s3Bucket: "b", s3AccessKey: "AKIAEXAMPLE", s3SecretKey: SECRET };
    expect((await call("PUT", "/api/settings/instance", next)).statusCode).toBe(200);
    expect(await data("budget.changed")).toEqual([expect.objectContaining({ object: { type: "ai_settings", id: "budget", label: "budget" }, before: null, after: "600" })]);
    expect(await data("content_language.changed")).toEqual([expect.objectContaining({ before: "en", after: "it" })]);
    const [storage] = await data("storage.changed");
    expect(JSON.parse(storage!.after as string)).toEqual({ endpoint: "https://s3.example.com", region: "eu", bucket: "b", accessKeyId: "AKIAEXAMPLE" });
    expect(JSON.parse(storage!.before as string)).toEqual({ endpoint: null, region: null, bucket: null, accessKeyId: null });
    expect(await entries("storage.secret_replaced")).toHaveLength(1);
    const { s3SecretKey: _omit, ...same } = next;
    void _omit;
    expect((await call("PUT", "/api/settings/instance", { ...same, monthlyBudgetUsd: 600.0 })).statusCode).toBe(200);
    expect((await db.select().from(changeLog)).length).toBe(before + 4);
    expect((await call("PUT", "/api/settings/instance", { ...same, s3Bucket: "c" })).statusCode).toBe(200);
    expect((await data("storage.changed")).at(-1)).toMatchObject({ before: JSON.stringify({ bucket: "b" }), after: JSON.stringify({ bucket: "c" }) });
  });

  it("automazione: le sole righe cambiate, la review solo se cambia; i tetti dell'analisi dei server", async () => {
    const rules = (bugAuto: boolean) => [{ type: "bug", autoFix: bugAuto, maxEffort: 2, planApprovalMinEffort: null, maxCostUsd: null }, { type: "feature", autoFix: false, maxEffort: 1, planApprovalMinEffort: null, maxCostUsd: null }];
    const off = { enabled: false, maxCostUsd: null };
    expect((await call("PUT", "/api/settings/automation", { rules: rules(false), prReview: off })).statusCode).toBe(200);
    const n = (await entries("automation.changed")).length;
    expect((await call("PUT", "/api/settings/automation", { rules: rules(true), prReview: off })).statusCode).toBe(200);
    const last = (await data("automation.changed")).at(-1)!;
    expect((await entries("automation.changed")).length).toBe(n + 1);
    expect(JSON.parse(last.after as string)).toEqual({ rules: [{ taskType: "bug", autoFix: true, maxEffort: 2, planApprovalMinEffort: null, maxCostUsd: null }], prReview: null });
    expect(JSON.parse(last.before as string).rules[0].autoFix).toBe(false);
    expect((await call("PUT", "/api/settings/automation", { rules: rules(true), prReview: { enabled: true, maxCostUsd: 5 } })).statusCode).toBe(200);
    expect(JSON.parse((await data("automation.changed")).at(-1)!.after as string)).toEqual({ rules: [], prReview: { enabled: true, maxCostUsd: 5 } });

    const limits = { enabled: true, maxMinutes: 10, maxCostUsd: 1, maxAgentReads: 30, maxSshReads: 30 };
    expect((await call("PUT", "/api/settings/server-analysis", limits)).statusCode).toBe(200);
    expect((await call("PUT", "/api/settings/server-analysis", { ...limits, enabled: false, maxMinutes: 20 })).statusCode).toBe(200);
    expect((await data("server_analysis.changed")).at(-1)).toMatchObject({
      before: JSON.stringify({ analysisEnabled: true, maxMinutes: "10" }),
      after: JSON.stringify({ analysisEnabled: false, maxMinutes: "20" }),
    });
  });

  it("account git: creato con la piattaforma, nome cambiato, token sostituito, togliere il predefinito, eliminato", async () => {
    const created = await call("POST", "/api/git-accounts", { name: "Bot", provider: "github", credentials: { username: "bot", token: SECRET } });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(await data("git_account.created", id)).toEqual([expect.objectContaining({ params: { provider: "GitHub" } })]);
    expect((await call("PATCH", `/api/git-accounts/${id}`, { name: "Bot 2", credentials: { username: "bot", token: `${SECRET}-2` } })).statusCode).toBe(200);
    expect(await data("git_account.updated", id)).toEqual([expect.objectContaining({ before: JSON.stringify({ name: "Bot" }), after: JSON.stringify({ name: "Bot 2" }) })]);
    expect(await entries("git_account.token_replaced", id)).toHaveLength(1);
    // Non era il predefinito: toglierlo non scrive niente.
    expect((await call("DELETE", `/api/git-accounts/${id}/default-reviewer`)).statusCode).toBe(204);
    expect(await entries("git_account.updated", id)).toHaveLength(1);
    expect((await call("DELETE", `/api/git-accounts/${id}`)).statusCode).toBe(204);
    expect(await entries("git_account.deleted", id)).toHaveLength(1);
  });

  it("app Google: creata, campi cambiati, secret sostituito, eliminata", async () => {
    const created = await call("POST", "/api/settings/google-workspaces", { name: "Acme", domains: ["acme.com"], clientId: "1.apps.googleusercontent.com", clientSecret: SECRET });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(await entries("google_app.created", id)).toHaveLength(1);
    expect((await call("PATCH", `/api/settings/google-workspaces/${id}`, { domains: ["acme.com", "acme.it"], clientSecret: `${SECRET}-2` })).statusCode).toBe(200);
    expect(await data("google_app.updated", id)).toEqual([expect.objectContaining({ before: JSON.stringify({ domains: ["acme.com"] }), after: JSON.stringify({ domains: ["acme.com", "acme.it"] }) })]);
    expect(await entries("google_app.secret_replaced", id)).toHaveLength(1);
    expect((await call("DELETE", `/api/settings/google-workspaces/${id}`)).statusCode).toBe(204);
    expect(await entries("google_app.deleted", id)).toHaveLength(1);
  });

  it("plugin: registrato col ref, ref aggiornato (prima e dopo), smoke rilanciato, rimosso", async () => {
    const created = await call("POST", "/api/plugins", { sourceUrl: "https://github.com/acme/log-plugin", ref: "v1", trust: true });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(await data("plugin.registered", id)).toEqual([expect.objectContaining({ params: { ref: "v1" } })]);
    await db.execute(`update plugin_jobs set status = 'done' where plugin_id = '${id}'` as never);
    expect((await call("POST", `/api/plugins/${id}/update`, { ref: "v2", trust: true })).statusCode).toBe(202);
    expect(await data("plugin.ref_updated", id)).toEqual([expect.objectContaining({ before: "v1", after: "v2" })]);
    await db.execute(`update plugin_jobs set status = 'done' where plugin_id = '${id}'` as never);
    await db.update(plugins).set({ status: "ready", resolvedSha: "a".repeat(40) }).where(eq(plugins.id, id));
    expect((await call("POST", `/api/plugins/${id}/smoke`)).statusCode).toBe(202);
    expect(await entries("plugin.smoke_rerun", id)).toHaveLength(1);
    expect((await call("DELETE", `/api/plugins/${id}`)).statusCode).toBe(204);
    expect(await entries("plugin.removed", id)).toHaveLength(1);
  });

  it("webhook modificato: i soli campi cambiati (gli eventi ordinati); niente cambiato, niente voce", async () => {
    const w = (await call("POST", "/api/settings/webhooks", { name: "W", url: "https://h.example.com/in", format: "generic", events: ["job.failed"] })).json() as { id: string };
    expect((await call("PATCH", `/api/settings/webhooks/${w.id}`, { events: ["release.failed", "job.failed"], enabled: false })).statusCode).toBe(200);
    expect(await data("webhook.updated", w.id)).toEqual([
      expect.objectContaining({ before: JSON.stringify({ enabled: true, events: ["job.failed"] }), after: JSON.stringify({ enabled: false, events: ["job.failed", "release.failed"] }) }),
    ]);
    // Una patch col solo nome non tocca il resto (né accende, né svuota gli eventi).
    const same = await call("PATCH", `/api/settings/webhooks/${w.id}`, { name: "W" });
    expect(same.json()).toMatchObject({ enabled: false, events: ["release.failed", "job.failed"] });
    expect(await entries("webhook.updated", w.id)).toHaveLength(1);
  });

  it("nessuna voce del registro contiene un segreto passato in queste scritture", async () => {
    const all = JSON.stringify(await db.select().from(changeLog));
    expect(all).not.toContain(SECRET);
  });
});
