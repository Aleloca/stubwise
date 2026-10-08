import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "./testing.js";
import { agentSessionEvents, agentSessionInputs, agentSessions } from "./schema.js";

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
    await expect(
      t.db.insert(agentSessions).values({ ownerKey: "k1", kind: "nope" as never, title: "t" }),
    ).rejects.toThrow();
    const [s] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "k2", kind: "pr_review", title: "t" })
      .returning();
    await expect(
      t.db
        .insert(agentSessionEvents)
        .values({ sessionId: s!.id, segmentId: "s", type: "nope" as never, data: {} }),
    ).rejects.toThrow();
    await expect(
      t.db
        .insert(agentSessionInputs)
        .values({ sessionId: s!.id, text: "x", status: "nope" as never }),
    ).rejects.toThrow();
  });

  it("una sessione di posta senza proprietario della casella è rifiutata dal database", async () => {
    // drizzle avvolge l'errore di Postgres: il nome del vincolo sta nella `cause`.
    const err = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "email_message:x", kind: "email_message", title: "t" })
      .then(
        () => null,
        (e: unknown) => e as { cause?: { message?: string } },
      );
    expect(err?.cause?.message).toMatch(/agent_sessions_email_owner_chk/);
  });

  it("live_segment_ids nasce vuoto", async () => {
    const [s] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "k3", kind: "ai_job", title: "t" })
      .returning();
    expect(s!.liveSegmentIds).toEqual([]);
  });
});
