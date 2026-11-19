import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessionEvents, agentSessions, automations, automationVersions, claudeConversationQuestions } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0198 (19 nov 2026, area 10, F2; era la 0197, rinumerata dopo la 0197 della review di F1): l'evento `question`, le domande
 * di Claude nella conversazione libera (una per turno) e `via_claude_action_id`
 * sulle versioni delle automazioni.
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function session(): Promise<string> {
  const [s] = await t.db.insert(agentSessions).values({ ownerKey: `free:${randomUUID()}`, kind: "free", title: "t" }).returning();
  return s!.id;
}

describe("migrazione 0198", () => {
  it("l'evento `question` si scrive; un tipo inventato resta rifiutato", async () => {
    const sid = await session();
    await t.db.insert(agentSessionEvents).values({ sessionId: sid, segmentId: "s", type: "question", data: { questionId: randomUUID() } });
    await expect(t.db.insert(agentSessionEvents).values({ sessionId: sid, segmentId: "s", type: "inventato" as never, data: {} })).rejects.toThrow();
  });

  it("UNA domanda per turno; la risposta va con chi e quando; la sessione cancellata le porta via", async () => {
    const sid = await session();
    const inputId = randomUUID();
    const q = { sessionId: sid, inputId, text: "Quale reparto?", options: [{ label: "Vendite" }, { label: "Supporto" }] };
    const [row] = await t.db.insert(claudeConversationQuestions).values(q).returning();
    // Una seconda domanda nello stesso turno, anche diversa, è rifiutata.
    await expect(t.db.insert(claudeConversationQuestions).values({ ...q, text: "E quale urgenza?" })).rejects.toThrow();
    // Un altro turno della stessa sessione ne ha una sua.
    await t.db.insert(claudeConversationQuestions).values({ ...q, inputId: randomUUID() });
    // Una risposta senza `answered_at` (o viceversa) è rifiutata.
    await expect(t.db.update(claudeConversationQuestions).set({ answerOptionIndex: 1 }).where(eq(claudeConversationQuestions.id, row!.id))).rejects.toThrow();
    await expect(t.db.update(claudeConversationQuestions).set({ answeredAt: new Date() }).where(eq(claudeConversationQuestions.id, row!.id))).rejects.toThrow();
    await t.db.update(claudeConversationQuestions).set({ answerOptionIndex: 1, answeredAt: new Date() }).where(eq(claudeConversationQuestions.id, row!.id));
    await t.db.delete(agentSessions).where(eq(agentSessions.id, sid));
    expect(await t.db.select().from(claudeConversationQuestions).where(eq(claudeConversationQuestions.sessionId, sid))).toEqual([]);
  });

  it("una versione di automazione prende `via_claude_action_id` dalla variabile di transazione; senza, null", async () => {
    const [a] = await t.db.insert(automations).values({ code: `T${randomUUID().slice(0, 4).toUpperCase()}-A1`, seq: 1, name: "a", description: "", projectId: null, status: "draft" } as never).returning();
    const action = randomUUID();
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.via_claude_action_id', ${action}, true)`);
      await tx.insert(automationVersions).values({ automationId: a!.id, n: 1, flow: {}, rev: 1 });
    });
    await t.db.insert(automationVersions).values({ automationId: a!.id, n: 2, flow: {}, rev: 1, publishedAt: new Date() });
    const rows = await t.db.select({ n: automationVersions.n, via: automationVersions.viaClaudeActionId }).from(automationVersions).where(eq(automationVersions.automationId, a!.id));
    expect(rows.sort((x, y) => x.n - y.n)).toEqual([{ n: 1, via: action }, { n: 2, via: null }]);
  });

  it("il journal: 0197 e 0198 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0197_claude_private_reads");
    expect(tags.slice(i, i + 2)).toEqual(["0197_claude_private_reads", "0198_area10_questions"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
