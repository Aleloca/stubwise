import { createHmac, randomBytes } from "node:crypto";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { changeLog, commitSummaries, deletedProjectMembers, deletedProjects, graphJobs, projects, repositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F6 (0193): un repository STACCATO (il suo progetto è stato
 * eliminato) non è di nessun progetto. Lo vede solo l'Amministrazione,
 * dalle rotte dedicate: nemmeno il full admin lo trova negli elenchi, nella
 * ricerca o nel dettaglio di progetto, e il suo webhook non entra.
 */
let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  ({ adminCookie, adminId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Un repository col nome dato, poi staccato eliminandone il progetto. */
async function detached(name: string) {
  const { projectId, repositoryId } = await seedRepository(testDb.db);
  await testDb.db.update(repositories).set({ name, webhookSecret: "segreto-del-webhook" }).where(eq(repositories.id, repositoryId));
  await testDb.db.delete(projects).where(eq(projects.id, projectId));
  const [row] = await testDb.db.select().from(repositories).where(eq(repositories.id, repositoryId));
  return row!;
}

describe("area 9, F6: un repository staccato non è di nessun progetto", () => {
  it("il full admin non lo vede in GET /api/repositories né nel dettaglio (404)", async () => {
    const attached = await seedRepository(testDb.db);
    const repo = await detached("staccato-elenco");
    const list = await app.inject({ method: "GET", url: "/api/repositories", headers: { cookie: adminCookie } });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(attached.repositoryId);
    expect(ids).not.toContain(repo.id);
    const one = await app.inject({ method: "GET", url: `/api/repositories/${repo.slug}`, headers: { cookie: adminCookie } });
    expect(one.statusCode).toBe(404);
  });

  it("la ricerca del full admin non lo trova", async () => {
    const repo = await detached("staccatoricercabile");
    const attached = await seedRepository(testDb.db);
    await testDb.db.update(repositories).set({ name: "agganciatoricercabile staccatoricercabile" }).where(eq(repositories.id, attached.repositoryId));
    const res = await app.inject({ method: "GET", url: "/api/search?q=staccatoricercabile", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { repositories: { items: { id: string }[] } }).repositories.items.map((r) => r.id);
    expect(ids).toEqual([attached.repositoryId]);
    expect(ids).not.toContain(repo.id);
  });

  it("i suoi commit non entrano nell'attività delle persone del full admin", async () => {
    const repo = await detached("staccato-commit");
    const at = new Date("2026-11-18T10:00:00Z");
    await testDb.db.insert(commitSummaries).values({ repositoryId: repo.id, sha: "c".repeat(40), authorName: "Bea", authorEmail: "bea@acme.com", subject: "commit staccato", summary: "commit staccato", committedAt: at });
    // Il controllo: lo stesso commit in un repository col progetto si vede.
    const attached = await seedRepository(testDb.db);
    await testDb.db.insert(commitSummaries).values({ repositoryId: attached.repositoryId, sha: "d".repeat(40), authorName: "Bea", authorEmail: "bea@acme.com", subject: "commit agganciato", summary: "commit agganciato", committedAt: at });
    const res = await app.inject({ method: "GET", url: "/api/people/activity?date=2026-11-18", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain("commit agganciato");
    expect(JSON.stringify(res.json())).not.toContain("commit staccato");
  });

  it("il webhook di un repository staccato risponde 401 anche con la firma giusta", async () => {
    const repo = await detached("staccato-webhook");
    const body = JSON.stringify({ ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), commits: [] });
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${repo.slug}`,
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${createHmac("sha256", repo.webhookSecret).update(body).digest("hex")}` },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    // Il controllo: con un progetto, la stessa consegna firmata entra.
    const ok = await seedRepository(testDb.db);
    await testDb.db.update(repositories).set({ webhookSecret: "segreto-del-webhook" }).where(eq(repositories.id, ok.repositoryId));
    const [okRepo] = await testDb.db.select().from(repositories).where(eq(repositories.id, ok.repositoryId));
    const accepted = await app.inject({
      method: "POST",
      url: `/webhooks/git/${okRepo!.slug}`,
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${createHmac("sha256", "segreto-del-webhook").update(body).digest("hex")}` },
      payload: body,
    });
    expect(accepted.statusCode).not.toBe(401);
  });
});

describe("area 9, F6, Task 6: elencare, collegare, eliminare un repository senza progetto", () => {
  /** Uno staccato come lo lascia l'eliminazione: con la memoria del progetto e i suoi ex membri. */
  async function detachedFrom(code: string, formerMembers: string[] = []) {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    await testDb.db.update(repositories).set({ name: `rep-${randomBytes(3).toString("hex")}`, repoUrl: "https://github.com/cliente-segreto/sito.git" }).where(eq(repositories.id, repositoryId));
    await testDb.db.insert(deletedProjects).values({ id: projectId, code, name: `Progetto ${code}` });
    for (const userId of formerMembers) await testDb.db.insert(deletedProjectMembers).values({ projectId, userId });
    await testDb.db.update(repositories).set({ detachedAt: new Date(), detachedFromProjectId: projectId }).where(eq(repositories.id, repositoryId));
    await testDb.db.delete(projects).where(eq(projects.id, projectId));
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.id, repositoryId));
    return { formerProjectId: projectId, repo: row! };
  }
  async function person(preset: string | null, projectId?: string) {
    const u = await createUserWithSession(app, `p-${randomBytes(4).toString("hex")}@acme.com`);
    if (preset && projectId) await addMember(app, projectId, u.id, preset);
    return u;
  }
  const list = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/repositories/detached", headers });
  const link = (headers: Record<string, string>, id: string, projectId: string) => app.inject({ method: "POST", url: `/api/repositories/${id}/link`, headers, payload: { projectId } });
  const del = (headers: Record<string, string>, id: string) => app.inject({ method: "DELETE", url: `/api/repositories/${id}`, headers });

  it("l'elenco: il full admin vede nome intero, URL e provenienza; chi gestisce i repository altrove solo l'ultimo segmento e nessuna provenienza; senza repos.manage 403", async () => {
    const target = await seedRepository(testDb.db);
    const lead = await person("project_lead", target.projectId);
    const { repo } = await detachedFrom(`D${randomBytes(2).toString("hex").toUpperCase()}`.slice(0, 6).replace(/[^A-Z0-9]/g, "X"));
    const mine = (await list({ cookie: adminCookie })).json() as Record<string, unknown>[];
    expect(mine.find((r) => r.id === repo.id)).toMatchObject({ fullName: "cliente-segreto/sito", repoUrl: repo.repoUrl, formerProject: { code: expect.any(String) }, canDelete: true });
    const theirs = (await list(lead.headers)).json() as Record<string, unknown>[];
    expect(theirs.find((r) => r.id === repo.id)).toMatchObject({ fullName: "sito", repoUrl: null, formerProject: null, canDelete: false });
    expect((theirs[0]!.linkTargets as { projectId: string }[]).map((t) => t.projectId)).toEqual([target.projectId]);
    const nobody = await person(null);
    expect((await list(nobody.headers)).statusCode).toBe(403);
  });

  it("un ex membro conosce la provenienza", async () => {
    const target = await seedRepository(testDb.db);
    const former = await person("project_lead", target.projectId);
    const { repo } = await detachedFrom("EXM", [former.id]);
    const rows = (await list(former.headers)).json() as Record<string, unknown>[];
    expect(rows.find((r) => r.id === repo.id)).toMatchObject({ fullName: "cliente-segreto/sito", formerProject: { code: "EXM" } });
  });

  it("collegare: repos.manage nel progetto di DESTINAZIONE (L-4); il segreto si rigenera; la voce nel progetto di destinazione; NEGATIVI: Contributor (senza repos.manage) 403, progetto altrui 404, nome già preso 409, già collegato 409", async () => {
    const target = await seedRepository(testDb.db);
    const lead = await person("project_lead", target.projectId);
    const dev = await person("contributor", target.projectId);
    const other = await seedRepository(testDb.db);
    const { repo } = await detachedFrom("LNK");
    expect((await link(dev.headers, repo.id, target.projectId)).statusCode).toBe(403);
    const elsewhere = await link(lead.headers, repo.id, other.projectId);
    expect([elsewhere.statusCode, (elsewhere.json() as { code: string }).code]).toEqual([404, "target_not_found"]);
    // La destinazione archiviata nel frattempo: lo stesso codice, non «il repository non c'è».
    await testDb.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, target.projectId));
    const archivedTarget = await link({ cookie: adminCookie }, repo.id, target.projectId);
    expect([archivedTarget.statusCode, (archivedTarget.json() as { code: string }).code]).toEqual([404, "target_not_found"]);
    await testDb.db.update(projects).set({ archivedAt: null }).where(eq(projects.id, target.projectId));
    // Il repository che non c'è: `not_found`.
    const missing = await link(lead.headers, "00000000-0000-4000-8000-000000000000", target.projectId);
    expect([missing.statusCode, (missing.json() as { code: string }).code]).toEqual([404, "not_found"]);
    const [clash] = await testDb.db.select({ name: repositories.name }).from(repositories).where(eq(repositories.id, target.repositoryId));
    const { repo: twin } = await detachedFrom("TWN");
    await testDb.db.update(repositories).set({ name: clash!.name }).where(eq(repositories.id, twin.id));
    const taken = await link(lead.headers, twin.id, target.projectId);
    expect([taken.statusCode, (taken.json() as { code: string }).code]).toEqual([409, "name_taken"]);
    const [still] = await testDb.db.select().from(repositories).where(eq(repositories.id, repo.id));
    expect(still!.projectId).toBeNull();

    expect((await link(lead.headers, repo.id, target.projectId)).statusCode).toBe(204);
    const [linked] = await testDb.db.select().from(repositories).where(eq(repositories.id, repo.id));
    expect(linked).toMatchObject({ projectId: target.projectId, detachedAt: null, detachedFromProjectId: null, webhookConfiguredAt: null });
    expect(linked!.webhookSecret).not.toBe(repo.webhookSecret);
    expect(await testDb.db.select().from(changeLog).where(and(eq(changeLog.type, "repository.linked"), eq(changeLog.projectId, target.projectId)))).toHaveLength(1);
    const again = await link(lead.headers, repo.id, target.projectId);
    expect([again.statusCode, (again.json() as { code: string }).code]).toEqual([409, "not_detached"]);
  });

  it("eliminare: solo uno staccato, solo un full admin, con la riconferma; la voce d'istanza risolve la provenienza a lettura e non fa mai uscire formerProjectId", async () => {
    const target = await seedRepository(testDb.db);
    const lead = await person("project_lead", target.projectId);
    const { repo, formerProjectId } = await detachedFrom("DEL");
    expect((await del(lead.headers, repo.id)).statusCode).toBe(403);
    const attached = await del({ cookie: adminCookie }, target.repositoryId);
    expect([attached.statusCode, (attached.json() as { code: string }).code]).toEqual([409, "not_detached"]);
    const old = await createSession(testDb.db, adminId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
    const stale = await del({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}` }, repo.id);
    expect([stale.statusCode, (stale.json() as { code: string }).code]).toEqual([403, "reauth_required"]);
    expect(await testDb.db.select().from(repositories).where(eq(repositories.id, repo.id))).toHaveLength(1);
    // I rifiuti non accodano niente.
    expect(await testDb.db.select().from(graphJobs).where(and(eq(graphJobs.repositoryId, repo.id), eq(graphJobs.kind, "prune")))).toEqual([]);

    await testDb.db.insert(graphJobs).values({ repositoryId: repo.id, kind: "build" });
    expect((await del({ cookie: adminCookie }, repo.id)).statusCode).toBe(204);
    expect(await testDb.db.select().from(repositories).where(eq(repositories.id, repo.id))).toEqual([]);
    // Il worker poterà mirror e grafo: il job `prune` (con l'URL) al posto della build di prima.
    expect((await testDb.db.select().from(graphJobs).where(eq(graphJobs.repositoryId, repo.id))).map((j) => [j.kind, j.status, j.repoUrl])).toEqual([["prune", "queued", repo.repoUrl]]);
    const log = (await app.inject({ method: "GET", url: "/api/change-log", headers: { cookie: adminCookie } })).json() as { entries: { type: string; data: { object: { id: string }; params?: Record<string, unknown> } }[] };
    const entry = log.entries.find((e) => e.type === "repository.deleted" && e.data.object.id === repo.id);
    expect(entry!.data.params).toEqual({ formerProject: "DEL" });
    expect(JSON.stringify(log.entries)).not.toContain(formerProjectId);
  });
});
