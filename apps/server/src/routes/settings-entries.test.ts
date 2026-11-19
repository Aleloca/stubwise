import { changeLog, encrypt, gitAccounts, projectEnvFiles, projectEnvironments, repositories, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { GitHubProvider, GitProviderError } from "@stubwise/git";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { seedUsers } from "../test/fixtures.js";

/** Area 9, F5, Task 6: le voci di repository, ambienti e widget, ciascuna nella transazione della sua scrittura. */
const KEY = Buffer.alloc(32, 9);
let t: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), publicUrl: "https://s.example.com" });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const call = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: adminCookie }, ...(payload ? { payload } : {}) });
const entries = (projectId: string, type: string) =>
  db.select().from(changeLog).where(and(eq(changeLog.projectId, projectId), eq(changeLog.type, type))).orderBy(changeLog.at, changeLog.id);
type Data = { object: { type: string; id: string; label: string }; before: string | null; after: string | null; params: Record<string, string> };
const dataOf = (rows: { data: unknown }[]) => rows.map((r) => r.data as Data);

/** Una trappola che fa fallire l'insert della voce di quel tipo: la scrittura deve annullarsi con lei. */
async function failingEntry(type: string, run: () => Promise<void>) {
  await db.execute(sql`CREATE OR REPLACE FUNCTION f5_fail_entry() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'voce fallita (test)'; END $$ LANGUAGE plpgsql`);
  await db.execute(sql.raw(`CREATE TRIGGER f5_fail_entry BEFORE INSERT ON change_log FOR EACH ROW WHEN (NEW.type = '${type}') EXECUTE FUNCTION f5_fail_entry()`));
  try {
    await run();
  } finally {
    await db.execute(sql`DROP TRIGGER f5_fail_entry ON change_log`);
    await db.execute(sql`DROP FUNCTION f5_fail_entry()`);
  }
}

async function account(name: string) {
  const [a] = await db.insert(gitAccounts).values({ name, provider: "github", encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), KEY) }).returning();
  return a!;
}

describe("repository", () => {
  it("creato: la voce col nome; se la voce fallisce, il repository non c'è", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 500 }))));
    const { projectId } = await seedRepository(db);
    const acct = await account("Bot creato");
    const res = await call("POST", "/api/repositories", { projectId, name: "Sito nuovo", gitAccountId: acct.id, repoUrl: "https://github.com/acme/sito-nuovo" });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    // Decisione C: il segreto del webhook intero esce UNA volta, alla creazione (e alla rigenerazione).
    expect((res.json() as { webhookSecret: string }).webhookSecret).toBe((await db.select({ s: repositories.webhookSecret }).from(repositories).where(eq(repositories.id, id)))[0]!.s);
    expect(dataOf(await entries(projectId, "repository.created"))).toEqual([expect.objectContaining({ object: { type: "repository", id, label: "Sito nuovo" } })]);
    await failingEntry("repository.created", async () => {
      expect((await call("POST", "/api/repositories", { projectId, name: "Mai nato", gitAccountId: acct.id, repoUrl: "https://github.com/acme/mai-nato" })).statusCode).toBe(500);
    });
    expect(await db.select().from(repositories).where(eq(repositories.name, "Mai nato"))).toHaveLength(0);
  });

  it("aggiornato: una voce per campo (params.field, l'account col NOME), PR dei colleghi e pipeline coi loro tipi; uguale → niente", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 500 }))));
    const { projectId, repositoryId } = await seedRepository(db);
    const a1 = await account("Bot uno");
    const a2 = await account("Bot due");
    const [r] = await db.update(repositories).set({ provider: "github", gitAccountId: a1.id }).where(eq(repositories.id, repositoryId)).returning();
    const body = { name: "Rinominato", testCommand: "pnpm test", gitAccountId: a2.id, colleaguePrs: "off", releasePipeline: { mode: "named", names: ["deploy"] }, releaseBranch: "release" };
    expect((await call("PATCH", `/api/repositories/${r!.slug}`, body)).statusCode).toBe(200);
    const updated = dataOf(await entries(projectId, "repository.updated"));
    expect(updated.map((d) => d.params.field).sort()).toEqual(["gitAccount", "name", "testCommand"]);
    expect(updated.find((d) => d.params.field === "gitAccount")).toMatchObject({ before: JSON.stringify({ gitAccount: "Bot uno" }), after: JSON.stringify({ gitAccount: "Bot due" }) });
    expect(dataOf(await entries(projectId, "repository.pr_mode_changed"))).toEqual([expect.objectContaining({ before: JSON.stringify({ prMode: r!.colleaguePrs }), after: JSON.stringify({ prMode: "off" }) })]);
    expect(dataOf(await entries(projectId, "repository.release_pipeline_changed"))).toEqual([
      expect.objectContaining({ before: JSON.stringify({ pipeline: "auto", branch: r!.defaultBranch }), after: JSON.stringify({ pipeline: "named:deploy", branch: "release" }) }),
    ]);
    const slug = (await db.select({ slug: repositories.slug }).from(repositories).where(eq(repositories.id, repositoryId)))[0]!.slug;
    await call("PATCH", `/api/repositories/${slug}`, body);
    expect(await entries(projectId, "repository.updated")).toHaveLength(3);
  });

  it("webhook configurato: configured, e il tentativo fallito come failed (lo stato non cambia)", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const acct = await account("Bot webhook");
    const [r] = await db.update(repositories).set({ provider: "github", gitAccountId: acct.id, repoUrl: "https://github.com/acme/web" }).where(eq(repositories.id, repositoryId)).returning();
    vi.spyOn(GitHubProvider.prototype, "ensureWebhook").mockRejectedValueOnce(new GitProviderError("Scope mancante", 403, "")).mockResolvedValueOnce({ created: true, updated: false, id: "1", detail: "ok" });
    expect((await call("POST", `/api/repositories/${r!.slug}/configure-webhook`)).statusCode).toBe(422);
    expect((await call("POST", `/api/repositories/${r!.slug}/configure-webhook`)).statusCode).toBe(200);
    expect(dataOf(await entries(projectId, "repository.webhook_configured")).map((d) => [d.before, d.after])).toEqual([
      ["not_configured", "failed"],
      ["not_configured", "configured"],
    ]);
  });
});

describe("ambienti e widget", () => {
  it("ambiente: creato, aggiornato (prima/dopo di nome e URL), eliminato; una voce fallita annulla l'eliminazione", async () => {
    const { projectId } = await seedRepository(db);
    const created = await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", kind: "staging" });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(dataOf(await entries(projectId, "environment.created"))).toEqual([expect.objectContaining({ object: { type: "environment", id, label: "staging" } })]);
    await call("PATCH", `/api/projects/${projectId}/environments/${id}`, { name: "preprod" });
    expect(dataOf(await entries(projectId, "environment.updated"))).toEqual([expect.objectContaining({ before: JSON.stringify({ name: "staging" }), after: JSON.stringify({ name: "preprod" }) })]);
    await failingEntry("environment.deleted", async () => {
      expect((await call("DELETE", `/api/projects/${projectId}/environments/${id}`)).statusCode).toBe(500);
    });
    expect((await call("DELETE", `/api/projects/${projectId}/environments/${id}`)).statusCode).toBe(204);
    expect(dataOf(await entries(projectId, "environment.deleted"))).toEqual([expect.objectContaining({ object: { type: "environment", id, label: "preprod" } })]);
  });

  it("widget: creato, aggiornato (il nome), eliminato; mai la chiave nella voce", async () => {
    const { projectId } = await seedRepository(db);
    const body = { name: "Widget", enabled: true, enabledRepositoryIds: [], title: "Supporto", welcomeMessage: "Ciao", accentColor: "#3366ff", language: "it", dailyMessageCap: null, dailyTicketCap: null };
    const res = await call("POST", `/api/projects/${projectId}/widgets`, body);
    expect(res.statusCode).toBe(200);
    const w = (res.json() as { widget: { id: string; key: string } }).widget;
    expect(dataOf(await entries(projectId, "widget.created"))).toEqual([expect.objectContaining({ object: { type: "widget", id: w.id, label: "Widget" } })]);
    await call("PUT", `/api/projects/${projectId}/widgets/${w.id}`, { ...body, name: "Assistenza" });
    expect(dataOf(await entries(projectId, "widget.updated"))).toEqual([expect.objectContaining({ before: JSON.stringify({ name: "Widget" }), after: JSON.stringify({ name: "Assistenza" }) })]);
    expect((await call("DELETE", `/api/projects/${projectId}/widgets/${w.id}`)).statusCode).toBe(204);
    expect(dataOf(await entries(projectId, "widget.deleted"))).toEqual([expect.objectContaining({ object: { type: "widget", id: w.id, label: "Assistenza" } })]);
    expect(JSON.stringify(await db.select().from(changeLog).where(eq(changeLog.projectId, projectId)))).not.toContain(w.key);
  });

  it("ambiente: se la voce della creazione fallisce, l'ambiente non c'è (la voce è nella transazione)", async () => {
    const { projectId } = await seedRepository(db);
    await failingEntry("environment.created", async () => {
      expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "mai-nato", kind: "staging" })).statusCode).toBe(500);
    });
    expect(await db.select().from(projectEnvironments).where(and(eq(projectEnvironments.projectId, projectId), eq(projectEnvironments.name, "mai-nato")))).toHaveLength(0);
  });

  it("ambiente con file: la riconferma (solo se ha file) e una voce env_file.deleted per ogni file cancellato in cascata", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
    const old = await createSession(db, adminId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
    const stale = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
    const del = (cookie: string, id: string) => app.inject({ method: "DELETE", url: `/api/projects/${projectId}/environments/${id}`, headers: { cookie } });

    // Senza file: passa anche con la riconferma scaduta.
    const empty = ((await call("POST", `/api/projects/${projectId}/environments`, { name: "vuoto", kind: "staging" })).json() as { id: string }).id;
    expect((await del(stale, empty)).statusCode).toBe(204);

    const envId = ((await call("POST", `/api/projects/${projectId}/environments`, { name: "prod", kind: "production" })).json() as { id: string }).id;
    const files: string[] = [];
    for (const path of [".env", "apps/api/.env"]) {
      const res = await call("POST", `/api/repositories/${repositoryId}/env-files`, { path, environmentId: envId });
      expect(res.statusCode).toBe(201);
      files.push((res.json() as { id: string }).id);
    }
    const res = await del(stale, envId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "reauth_required" });
    expect(await db.select().from(projectEnvironments).where(eq(projectEnvironments.id, envId))).toHaveLength(1);
    expect(await entries(projectId, "env_file.deleted")).toHaveLength(0);

    // Se una voce fallisce, ambiente e file restano.
    await failingEntry("env_file.deleted", async () => {
      expect((await call("DELETE", `/api/projects/${projectId}/environments/${envId}`)).statusCode).toBe(500);
    });
    expect(await db.select().from(projectEnvFiles).where(eq(projectEnvFiles.environmentId, envId))).toHaveLength(2);

    expect((await call("DELETE", `/api/projects/${projectId}/environments/${envId}`)).statusCode).toBe(204);
    const repoName = (await db.select({ name: repositories.name }).from(repositories).where(eq(repositories.id, repositoryId)))[0]!.name;
    expect(dataOf(await entries(projectId, "env_file.deleted")).map((d) => [d.object, d.params]).sort((a, b) => (a[0] as { label: string }).label.localeCompare((b[0] as { label: string }).label))).toEqual([
      [{ type: "env_file", id: files[0], label: ".env" }, { environment: "prod", repository: repoName }],
      [{ type: "env_file", id: files[1], label: "apps/api/.env" }, { environment: "prod", repository: repoName }],
    ]);
    expect(await entries(projectId, "environment.deleted")).toHaveLength(2);
  });
});
