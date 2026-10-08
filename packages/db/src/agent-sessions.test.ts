import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "./testing.js";
import { randomUUID } from "node:crypto";
import {
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  backlogJobs,
  docGenerations,
  gitAccounts,
  prReviews,
  projects,
  repositories,
} from "./schema.js";

/** drizzle avvolge l'errore di Postgres: il nome del vincolo sta nella `cause`. */
async function failureMessage(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { cause?: { message?: string } }).cause?.message ?? String(e);
  }
  return "";
}

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

describe("0086 agent_sessions", () => {
  it("owner_key è unico e gli eventi cadono in cascata con la sessione", async () => {
    const [s] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "ai_job:x", kind: "ai_job", title: "t" })
      .returning();
    await expect(
      t.db.insert(agentSessions).values({ ownerKey: "ai_job:x", kind: "ai_job", title: "t" }),
    ).rejects.toThrow();
    await t.db.insert(agentSessionEvents).values({
      sessionId: s!.id,
      segmentId: "seg",
      type: "assistant_text",
      data: { text: "ciao" },
    });
    await t.db.delete(agentSessions).where(sql`id = ${s!.id}`);
    const rows = await t.db.select().from(agentSessionEvents);
    expect(rows).toHaveLength(0);
  });

  it("i CHECK rifiutano kind, tipo di evento e stato di input sconosciuti", async () => {
    expect(
      await failureMessage(
        t.db.insert(agentSessions).values({ ownerKey: "k1", kind: "nope" as never, title: "t" }),
      ),
    ).toMatch(/agent_sessions_kind_chk/);
    const [s] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "k2", kind: "pr_review", title: "t" })
      .returning();
    expect(
      await failureMessage(
        t.db
          .insert(agentSessionEvents)
          .values({ sessionId: s!.id, segmentId: "s", type: "nope" as never, data: {} }),
      ),
    ).toMatch(/agent_session_events_type_chk/);
    expect(
      await failureMessage(
        t.db
          .insert(agentSessionInputs)
          .values({ sessionId: s!.id, text: "x", status: "nope" as never }),
      ),
    ).toMatch(/agent_session_inputs_status_chk/);
  });

  it("una sessione di posta senza proprietario della casella è rifiutata dal database", async () => {
    expect(
      await failureMessage(
        t.db
          .insert(agentSessions)
          .values({ ownerKey: "email_message:x", kind: "email_message", title: "t" }),
      ),
    ).toMatch(/agent_sessions_email_owner_chk/);
  });

  it("live_segment_ids nasce vuoto", async () => {
    const [s] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "k3", kind: "ai_job", title: "t" })
      .returning();
    expect(s!.liveSegmentIds).toEqual([]);
  });

  it("cancellare la riga proprietaria (review, generazione Docs, job di backlog) NON cancella la sessione", async () => {
    const [project] = await t.db
      .insert(projects)
      .values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() })
      .returning();
    const [account] = await t.db
      .insert(gitAccounts)
      .values({ name: `A ${randomUUID()}`, provider: "github", encryptedCredentials: "blob" })
      .returning();
    const [repo] = await t.db
      .insert(repositories)
      .values({
        projectId: project!.id,
        name: "r",
        slug: `r-${randomUUID()}`,
        provider: "github",
        gitAccountId: account!.id,
        repoUrl: "https://example.com/r.git",
        defaultBranch: "main",
      })
      .returning();
    const [review] = await t.db
      .insert(prReviews)
      .values({ repositoryId: repo!.id, prNumber: 1, prUrl: "u", prTitle: "t", headSha: "abc" })
      .returning();
    const [gen] = await t.db
      .insert(docGenerations)
      .values({ repositoryId: repo!.id })
      .returning();
    const [job] = await t.db
      .insert(backlogJobs)
      .values({ projectId: project!.id, kind: "estimate", payload: {} as never })
      .returning();
    const [s] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: `owners:${randomUUID()}`,
        kind: "ai_job",
        title: "t",
        prReviewId: review!.id,
        docGenerationId: gen!.id,
        backlogJobId: job!.id,
      })
      .returning();

    await t.db.delete(prReviews).where(sql`id = ${review!.id}`);
    await t.db.delete(docGenerations).where(sql`id = ${gen!.id}`);
    await t.db.delete(backlogJobs).where(sql`id = ${job!.id}`);

    const [after] = await t.db.select().from(agentSessions).where(sql`id = ${s!.id}`);
    expect(after).toBeDefined();
    expect(after!.prReviewId).toBeNull();
    expect(after!.docGenerationId).toBeNull();
    expect(after!.backlogJobId).toBeNull();
  });
});
