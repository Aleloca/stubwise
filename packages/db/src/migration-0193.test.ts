import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeLog, deletedProjectMembers, deletedProjects, projects, repositories, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0193 (19 nov 2026, area 9, F6): archivio ed eliminazione. Un
 * progetto si archivia (`archived_at`), un repository sopravvive al suo
 * progetto (staccato, `project_id` null) e il registro tiene l'id di un
 * progetto eliminato (L-3: le sue voci non diventano «senza progetto»).
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function newUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({ email: `${randomUUID()}@acme.com`, passwordHash: "h", role: "member" }).returning({ id: users.id });
  return u!.id;
}

describe("migrazione 0193", () => {
  it("l'archivio nasce nullo; chi ha archiviato va a null se la persona si elimina", async () => {
    const { projectId } = await seedRepository(t.db);
    const [p] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p).toMatchObject({ archivedAt: null, archivedByUserId: null });
    const u = await newUser();
    await t.db.update(projects).set({ archivedAt: new Date(), archivedByUserId: u }).where(eq(projects.id, projectId));
    await t.db.delete(users).where(eq(users.id, u));
    const [after] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(after!.archivedAt).not.toBeNull();
    expect(after!.archivedByUserId).toBeNull();
  });

  it("eliminare il progetto STACCA i suoi repository invece di portarli via", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    await t.db.delete(projects).where(eq(projects.id, projectId));
    const [r] = await t.db.select().from(repositories).where(eq(repositories.id, repositoryId));
    expect(r).toBeDefined();
    expect(r!.projectId).toBeNull();
  });

  it("le voci del registro TENGONO l'id del progetto eliminato (nessuna FK)", async () => {
    const { projectId } = await seedRepository(t.db);
    await t.db.insert(changeLog).values({ actorEmail: "a@acme.com", actorKind: "user", type: "project.updated", projectId, subjectKind: "project", subjectId: projectId });
    await t.db.delete(projects).where(eq(projects.id, projectId));
    const rows = await t.db.select().from(changeLog).where(eq(changeLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    // Un id che non esiste più si scrive (la voce `project.deleted` porta il suo).
    const gone = randomUUID();
    await t.db.insert(changeLog).values({ actorEmail: "a@acme.com", actorKind: "user", type: "project.deleted", projectId: gone, subjectKind: "project", subjectId: gone });
    // E resta append-only.
    await expect(t.db.update(changeLog).set({ projectId: null }).where(eq(changeLog.projectId, projectId))).rejects.toThrow();
  });

  it("la memoria del progetto eliminato: codice, nome, ex membri; il repository staccato ne tiene l'id e la data", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const u = await newUser();
    await t.db.insert(deletedProjects).values({ id: projectId, code: "ACM", name: "Acme" });
    await t.db.insert(deletedProjectMembers).values({ projectId, userId: u });
    await t.db.update(repositories).set({ detachedAt: new Date(), detachedFromProjectId: projectId }).where(eq(repositories.id, repositoryId));
    await t.db.delete(projects).where(eq(projects.id, projectId));
    const [r] = await t.db.select().from(repositories).where(eq(repositories.id, repositoryId));
    expect(r).toMatchObject({ projectId: null, detachedFromProjectId: projectId });
    expect(r!.detachedAt).toBeInstanceOf(Date);
    // Un ex membro eliminato esce dalla memoria; la memoria tolta lascia il repository.
    await t.db.delete(users).where(eq(users.id, u));
    expect(await t.db.select().from(deletedProjectMembers).where(eq(deletedProjectMembers.projectId, projectId))).toEqual([]);
    await t.db.delete(deletedProjects).where(eq(deletedProjects.id, projectId));
    const [after] = await t.db.select().from(repositories).where(eq(repositories.id, repositoryId));
    expect(after!.detachedFromProjectId).toBeNull();
  });

  it("l'indice parziale degli archiviati c'è, e le FK sono quelle attese", async () => {
    const res = (await t.db.execute(sql`select
      exists(select 1 from pg_indexes where indexname = 'projects_archived_idx' and indexdef ilike '%where (archived_at is not null)%') as idx,
      (select confdeltype from pg_constraint where conname = 'repositories_project_id_projects_id_fk') as repo_fk,
      exists(select 1 from pg_constraint where conname = 'change_log_project_id_projects_id_fk') as log_fk,
      (select is_nullable from information_schema.columns where table_name = 'repositories' and column_name = 'project_id') as repo_null`)) as unknown as { rows?: unknown[] } & unknown[];
    expect((res.rows ?? res)[0]).toEqual({ idx: true, repo_fk: "n", log_fk: false, repo_null: "YES" });
  });

  it("il migratore ha applicato 0192 e 0193 in fila, e TUTTO il journal nel suo ordine", async () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0192_ingestion_key_meta");
    expect(tags.slice(i, i + 2)).toEqual(["0192_ingestion_key_meta", "0193_project_archive"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const applied = (await t.db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`)) as unknown as { rows?: { created_at: string }[] } & { created_at: string }[];
    const rows = (applied.rows ?? applied) as { created_at: string }[];
    expect(rows.map((r) => Number(r.created_at))).toEqual(whens);
  });
});
