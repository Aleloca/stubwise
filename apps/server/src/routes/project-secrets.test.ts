import { randomUUID } from "node:crypto";
import { changeLog, encrypt, gitAccounts, projectMembers, projects, repositories, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { GitHubProvider, GitProviderError } from "@stubwise/git";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/** Area 9, F5, Task 3: le rigenerazioni della chiave d'ingestione e del segreto del webhook git. */
const KEY = Buffer.alloc(32, 11);
let t: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let stale: string;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), publicUrl: "https://s.example.com" });
  ({ adminCookie } = await seedUsers(app));
  const adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
  const old = await createSession(db, adminId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
  stale = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const post = (url: string, cookie = adminCookie) => app.inject({ method: "POST", url, headers: { cookie } });
const entries = (type: string, projectId: string) => db.select().from(changeLog).where(and(eq(changeLog.type, type), eq(changeLog.projectId, projectId)));

describe("la chiave d'ingestione", () => {
  it("riconferma; la nuova una volta; la vecchia rifiutata SUBITO, la nuova accettata; la voce senza la chiave", async () => {
    const { projectId } = await seedRepository(db);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect((await post(`/api/projects/${projectId}/ingestion-key`, stale)).statusCode).toBe(403);
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]!.ingestionKey).toBe(p!.ingestionKey);
    const res = await post(`/api/projects/${projectId}/ingestion-key`);
    expect(res.statusCode).toBe(200);
    const fresh = (res.json() as { ingestionKey: string }).ingestionKey;
    expect(fresh).not.toBe(p!.ingestionKey);
    const ingest = (key: string) => app.inject({ method: "POST", url: `/ingest/${p!.slug}`, headers: { "x-stubwise-key": key, "content-type": "application/json" }, payload: { events: "malformato" } });
    expect((await ingest(p!.ingestionKey)).statusCode).toBe(401);
    expect((await ingest(fresh)).statusCode).not.toBe(401);
    const [entry] = await entries("project.ingestion_key_regenerated", projectId);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(fresh);
  });
});

describe("il segreto del webhook git (K-5)", () => {
  async function repo(configured: boolean) {
    const { projectId, repositoryId } = await seedRepository(db);
    const [account] = await db.insert(gitAccounts).values({ name: `Bot ${repositoryId.slice(0, 4)}`, provider: "github", encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), KEY) }).returning();
    const [r] = await db.update(repositories).set({ provider: "github", repoUrl: "https://github.com/acme/web", gitAccountId: account!.id, webhookSecret: "a".repeat(32), webhookConfiguredAt: configured ? new Date() : null }).where(eq(repositories.id, repositoryId)).returning();
    return { projectId, slug: r!.slug, id: r!.id };
  }
  const secretOf = async (id: string) => (await db.select({ s: repositories.webhookSecret }).from(repositories).where(eq(repositories.id, id)))[0]!.s;
  const scopes = (ok: boolean) => vi.spyOn(GitHubProvider.prototype, "validateCredentials").mockResolvedValue([{ name: "Webhook", ok, detail: ok ? "ok" : "Serve lo scope admin:repo_hook", purpose: "webhook" }]);

  it("NON configurato da Stubwise: si scrive il nuovo, da copiare a mano (manual); la piattaforma non si tocca; riconferma", async () => {
    const r = await repo(false);
    const ensure = vi.spyOn(GitHubProvider.prototype, "ensureWebhook");
    expect((await post(`/api/repositories/${r.slug}/webhook-secret`, stale)).statusCode).toBe(403);
    const res = await post(`/api/repositories/${r.slug}/webhook-secret`);
    expect(res.json()).toMatchObject({ mode: "manual" });
    const fresh = (res.json() as { webhookSecret: string }).webhookSecret;
    expect(await secretOf(r.id)).toBe(fresh);
    expect(ensure).not.toHaveBeenCalled();
    const [entry] = await entries("repository.webhook_secret_regenerated", r.projectId);
    expect(JSON.stringify(entry)).not.toContain(fresh);
  });

  it("review del lotto 5, I-1: per ID in modalità platform, l'URL del webhook sulla piattaforma è quello dello SLUG (quello che /webhooks/git cerca), anche nel rollback", async () => {
    const r = await repo(true);
    scopes(true);
    const urls: string[] = [];
    vi.spyOn(GitHubProvider.prototype, "ensureWebhook").mockImplementation(async (_p, hook) => {
      urls.push(hook.url);
      return { created: false, updated: true, id: "1", detail: "ok" };
    });
    const res = await post(`/api/repositories/${r.id}/webhook-secret`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mode: "platform" });
    expect(urls).toEqual([expect.stringMatching(new RegExp(`/webhooks/git/${r.slug}$`))]);
    expect(urls[0]).not.toContain(r.id);
  });

  it("rimandi, lotto 5: si rigenera anche per ID del repository (l'app non ha lo slug), con le stesse regole", async () => {
    const r = await repo(false);
    const res = await post(`/api/repositories/${r.id}/webhook-secret`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mode: "manual" });
    expect(await secretOf(r.id)).toBe((res.json() as { webhookSecret: string }).webhookSecret);
  });

  it("configurato, token senza lo scope: 422 webhook_scope_missing, niente cambia né qui né sulla piattaforma", async () => {
    const r = await repo(true);
    scopes(false);
    const ensure = vi.spyOn(GitHubProvider.prototype, "ensureWebhook");
    const res = await post(`/api/repositories/${r.slug}/webhook-secret`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "webhook_scope_missing" });
    expect(ensure).not.toHaveBeenCalled();
    expect(await secretOf(r.id)).toBe("a".repeat(32));
    expect(await entries("repository.webhook_secret_regenerated", r.projectId)).toHaveLength(0);
  });

  it("configurato, la piattaforma rifiuta: 502 platform_update_failed, resta il VECCHIO, nessuna voce", async () => {
    const r = await repo(true);
    scopes(true);
    vi.spyOn(GitHubProvider.prototype, "ensureWebhook").mockRejectedValue(new GitProviderError("La piattaforma ha rifiutato", 422, ""));
    const res = await post(`/api/repositories/${r.slug}/webhook-secret`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "platform_update_failed" });
    expect(await secretOf(r.id)).toBe("a".repeat(32));
    expect(await entries("repository.webhook_secret_regenerated", r.projectId)).toHaveLength(0);
  });

  it("configurato, la piattaforma accetta: il nuovo va PRIMA alla piattaforma, poi nel DB con la voce (platform)", async () => {
    const r = await repo(true);
    scopes(true);
    const seenSecrets: string[] = [];
    vi.spyOn(GitHubProvider.prototype, "ensureWebhook").mockImplementation(async (_p, hook) => {
      seenSecrets.push(hook.secret);
      // Al momento dell'aggiornamento della piattaforma il DB ha ancora il vecchio.
      expect(await secretOf(r.id)).toBe("a".repeat(32));
      return { created: false, updated: true, id: "1", detail: "ok" };
    });
    const res = await post(`/api/repositories/${r.slug}/webhook-secret`);
    expect(res.json()).toMatchObject({ mode: "platform" });
    const fresh = (res.json() as { webhookSecret: string }).webhookSecret;
    expect(seenSecrets).toEqual([fresh]);
    expect(await secretOf(r.id)).toBe(fresh);
    expect(await entries("repository.webhook_secret_regenerated", r.projectId)).toHaveLength(1);
  });

  it("CONCORRENZA (review I2): due rigenerazioni insieme lasciano DB e piattaforma sullo STESSO segreto", async () => {
    const r = await repo(true);
    scopes(true);
    const pushed: string[] = [];
    vi.spyOn(GitHubProvider.prototype, "ensureWebhook").mockImplementation(async (_p, hook) => {
      pushed.push(hook.secret);
      // La prima arriva alla piattaforma e poi si attarda: senza blocco la seconda la scavalca.
      await new Promise((resolve) => setTimeout(resolve, pushed.length === 1 ? 150 : 0));
      return { created: false, updated: true, id: "1", detail: "ok" };
    });
    const [a, b] = await Promise.all([post(`/api/repositories/${r.slug}/webhook-secret`), post(`/api/repositories/${r.slug}/webhook-secret`)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(pushed).toHaveLength(2);
    expect(await secretOf(r.id)).toBe(pushed.at(-1));
  });

  it("CONCORRENZA (review I2): «configura» e rigenerazione insieme lasciano DB e piattaforma sullo STESSO segreto", async () => {
    const r = await repo(true);
    scopes(true);
    const landed: string[] = [];
    let calls = 0;
    vi.spyOn(GitHubProvider.prototype, "ensureWebhook").mockImplementation(async (_p, hook) => {
      // La prima chiamata arriva alla piattaforma in ritardo: senza blocco, il segreto vecchio di «configura» scavalca quello nuovo.
      const delay = calls++ === 0 ? 150 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      landed.push(hook.secret);
      return { created: false, updated: true, id: "1", detail: "ok" };
    });
    const [c, g] = await Promise.all([post(`/api/repositories/${r.slug}/configure-webhook`), post(`/api/repositories/${r.slug}/webhook-secret`)]);
    expect([c.statusCode, g.statusCode]).toEqual([200, 200]);
    expect(await secretOf(r.id)).toBe(landed.at(-1));
  });

  it("la scrittura fallisce DOPO che la piattaforma ha accettato: si rimette il vecchio sulla piattaforma (rollback), il DB resta col vecchio", async () => {
    const r = await repo(true);
    scopes(true);
    const seenSecrets: string[] = [];
    vi.spyOn(GitHubProvider.prototype, "ensureWebhook").mockImplementation(async (_p, hook) => {
      seenSecrets.push(hook.secret);
      return { created: false, updated: true, id: "1", detail: "ok" };
    });
    await db.execute(sql`CREATE OR REPLACE FUNCTION f5_fail_secret_entry() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'scrittura fallita (test)'; END $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER f5_fail_secret_entry BEFORE INSERT ON change_log FOR EACH ROW WHEN (NEW.type = 'repository.webhook_secret_regenerated') EXECUTE FUNCTION f5_fail_secret_entry()`);
    try {
      const res = await post(`/api/repositories/${r.slug}/webhook-secret`);
      expect(res.json()).toEqual({ mode: "rollback", platformRestored: true });
      expect(seenSecrets).toHaveLength(2);
      expect(seenSecrets[1]).toBe("a".repeat(32));
      expect(await secretOf(r.id)).toBe("a".repeat(32));
    } finally {
      await db.execute(sql`DROP TRIGGER f5_fail_secret_entry ON change_log`);
      await db.execute(sql`DROP FUNCTION f5_fail_secret_entry()`);
    }
  });
});

describe("l'Integrazione in lettura (I2)", () => {
  async function member(projectId: string, preset: string) {
    const [u] = await db.insert(users).values({ email: `i-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, preset));
    await db.insert(projectMembers).values({ projectId, userId: u!.id, roleId: r!.id });
    return fullSessionCookie(app, u!.id);
  }
  const read = (projectId: string, cookie = adminCookie) => app.inject({ method: "GET", url: `/api/projects/${projectId}/integration`, headers: { cookie } });

  it("le ultime 4, MAI la chiave intera (né qui né nella vista del progetto); dopo la rigenerazione quando e da chi", async () => {
    const { projectId } = await seedRepository(db);
    const key = (await db.select().from(projects).where(eq(projects.id, projectId)))[0]!.ingestionKey;
    const before = await read(projectId);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ ingestion: { last4: key.slice(-4), createdAt: null, createdBy: null, dsnBase: expect.stringMatching(/^https:\/\/s\.example\.com\/p\//) }, canRegenerateKey: true, canRegenerateWebhookSecret: true });
    expect(before.body).not.toContain(key);
    const view = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie: adminCookie } });
    expect(view.body).not.toContain(key);
    expect((view.json() as { ingestionKey: unknown }).ingestionKey).toBeNull();
    const fresh = ((await post(`/api/projects/${projectId}/ingestion-key`)).json() as { ingestionKey: string }).ingestionKey;
    const after = (await read(projectId)).json() as { ingestion: { last4: string; createdAt: string | null; createdBy: { name: string } | null } };
    expect(after.ingestion.last4).toBe(fresh.slice(-4));
    expect(after.ingestion.createdAt).not.toBeNull();
    expect(after.ingestion.createdBy).not.toBeNull();
  });

  it("i webhook git (ultime 4 del segreto, l'URL, configurato) solo a chi vede i repository; i permessi calcolati dal server", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    await db.update(repositories).set({ webhookSecret: "b".repeat(28) + "wxyz" }).where(eq(repositories.id, repositoryId));
    const admin = (await read(projectId)).json() as { gitWebhooks: { repositoryId: string; secretLast4: string; url: string; configured: boolean }[] };
    expect(admin.gitWebhooks).toEqual([expect.objectContaining({ repositoryId, secretLast4: "wxyz", configured: false, url: expect.stringContaining("/webhooks/git/") })]);
    // Rimandi, lotto 5: la piattaforma, per il dialogo del segreto.
    expect((admin.gitWebhooks[0] as unknown as { provider: string }).provider).toMatch(/^(github|bitbucket)$/);
    expect(JSON.stringify(admin)).not.toContain("b".repeat(28));
    const contributor = await read(projectId, await member(projectId, "contributor"));
    expect(contributor.statusCode).toBe(200);
    expect(contributor.json()).toMatchObject({ gitWebhooks: [], canRegenerateKey: false, canRegenerateWebhookSecret: false });
    const lead = (await read(projectId, await member(projectId, "project_lead"))).json() as { gitWebhooks: unknown[]; canRegenerateKey: boolean };
    expect(lead.canRegenerateKey).toBe(true);
    expect(lead.gitWebhooks).toHaveLength(1);
  });
});
