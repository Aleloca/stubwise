import { aiJobs, projects, repositories, tickets, type Db } from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createGenerationWorktreeRegistry } from "./docs/recursive/registry.js";
import type { GenerationWorktree } from "./docs/generation-worktree.js";
import { claimNextJob } from "./queue.js";

// ESCLUSIONE FIX↔GENERAZIONE, coerente PER-PROGETTO (Fase 3): una generazione
// docs attiva su un repo di un progetto tiene un worktree aperto (registrato nel
// registro in-processo). Il claim dei fix esclude i PROGETTI "occupati", derivati
// da `registry.activeProjectIds()`: un fix di progetto aprirebbe un worktree su
// TUTTI i suoi repo — incluso quello con la generazione — e il suo `fetch --prune`
// cancellerebbe il ref del worktree di generazione (invariante del mirror). Questo
// test verifica la coerenza end-to-end fra il registro e claimNextJob(exclude).

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
});

afterAll(async () => {
  await testDb.stop();
});

function fakeWorktree(): GenerationWorktree {
  return { dir: "/tmp/x", commitSha: "0".repeat(40), close: async () => {} } as GenerationWorktree;
}

/** Progetto + repo + ticket + fix-job `queued`. Ritorna gli id utili. */
async function seedProjectWithQueuedFix(
  db: Db,
  createdAt: Date,
): Promise<{ projectId: string; repositoryId: string; jobId: string }> {
  const gitAccountId = await seedGitAccount(db, { provider: "github" });
  const [project] = await db
    .insert(projects)
    .values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  if (!project) throw new Error("insert progetto");
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project.id,
      name: "R",
      slug: `r-${randomUUID()}`,
      provider: "github",
      gitAccountId,
      repoUrl: "https://example.com/r.git",
      defaultBranch: "main",
    })
    .returning();
  if (!repository) throw new Error("insert repository");
  const [ticket] = await db
    .insert(tickets)
    .values({ projectId: project.id, number: 1, title: "t", type: "bug", priority: "high", source: "manual" })
    .returning();
  if (!ticket) throw new Error("insert ticket");
  const [job] = await db.insert(aiJobs).values({ ticketId: ticket.id, createdAt }).returning();
  if (!job) throw new Error("insert job");
  return { projectId: project.id, repositoryId: repository.id, jobId: job.id };
}

describe("esclusione fix↔generazione (per-progetto)", () => {
  it("un fix NON parte se una generazione è attiva su un repo del suo progetto (e viceversa)", async () => {
    const { db } = testDb;
    // Progetto A: fix più VECCHIO (normalmente reclamato per primo).
    const a = await seedProjectWithQueuedFix(db, new Date(Date.now() - 10 * 60_000));
    // Progetto B: fix più recente.
    const b = await seedProjectWithQueuedFix(db, new Date(Date.now() - 1 * 60_000));

    const registry = createGenerationWorktreeRegistry();
    // Generazione docs attiva su un repo del progetto A: A è "occupato".
    registry.register("gen-a", a.repositoryId, a.projectId, fakeWorktree());
    expect(registry.activeProjectIds()).toEqual(new Set([a.projectId]));

    // Il claim esclude i progetti con generazione attiva → salta A (più vecchio),
    // reclama il fix di B.
    const claimed = await claimNextJob(db, [...registry.activeProjectIds()]);
    expect(claimed?.id).toBe(b.jobId);

    // Chiusa la generazione di A, il progetto torna reclamabile.
    registry.claimForFinalize("gen-a");
    expect(registry.activeProjectIds().size).toBe(0);
    const claimedA = await claimNextJob(db, [...registry.activeProjectIds()]);
    expect(claimedA?.id).toBe(a.jobId);
  });

  it("l'esclusione è a livello di PROGETTO: una generazione su UN repo esclude i fix dell'INTERO progetto", async () => {
    const { db } = testDb;
    // Progetto A con DUE repo; il fix è di progetto (tocca tutti i repo). Una
    // generazione su un SOLO repo del progetto deve bastare a escludere il fix.
    const a = await seedProjectWithQueuedFix(db, new Date(Date.now() - 5 * 60_000));
    const gitAccountId = await seedGitAccount(db, { provider: "github" });
    const [secondRepo] = await db
      .insert(repositories)
      .values({
        projectId: a.projectId,
        name: "R2",
        slug: `r2-${randomUUID()}`,
        provider: "github",
        gitAccountId,
        repoUrl: "https://example.com/r2.git",
        defaultBranch: "main",
      })
      .returning();
    if (!secondRepo) throw new Error("insert repository 2");

    const registry = createGenerationWorktreeRegistry();
    // Generazione sul SECONDO repo del progetto A.
    registry.register("gen-a2", secondRepo.id, a.projectId, fakeWorktree());

    // Il fix di A è escluso (il progetto è occupato dalla generazione sul 2° repo).
    const claimed = await claimNextJob(db, [...registry.activeProjectIds()]);
    expect(claimed).toBeNull();
  });
});
