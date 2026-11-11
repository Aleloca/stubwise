import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessions, chatChannels, chatClaudeQuestions, chatMessages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0140 (10 nov 2026, area 4, fetta 3): @Claude nella Chat. Il kind
 * `chat_mention` delle sessioni, lo stato di una risposta di Claude (solo sulle
 * risposte `claude`, con i motivi chiusi) e una domanda per risposta.
 */

let t: TestDb;
let general: string;
beforeAll(async () => {
  t = await startTestDb();
  const { projectId } = await seedRepository(t.db);
  const [g] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  general = g!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0140 @Claude nella Chat", () => {
  it("il kind `chat_mention` è ammesso; uno ignoto no", async () => {
    await t.db.insert(agentSessions).values({ ownerKey: "chat_mention:x", kind: "chat_mention", title: "" });
    await expect(t.db.insert(agentSessions).values({ ownerKey: "nope:x", kind: "nope" as never, title: "" })).rejects.toThrow();
  });

  it("lo stato c'è SOLO su una risposta di Claude, e i motivi sono chiusi", async () => {
    await expect(t.db.insert(chatMessages).values({ channelId: general, body: "x", kind: "claude" })).rejects.toThrow();
    await expect(t.db.insert(chatMessages).values({ channelId: general, body: "x", claudeState: "working" })).rejects.toThrow();
    await expect(
      t.db.insert(chatMessages).values({ channelId: general, body: "", kind: "claude", claudeState: "failed", claudeError: "boh" as never }),
    ).rejects.toThrow();
    await t.db.insert(chatMessages).values({ channelId: general, body: "", kind: "claude", claudeState: "failed", claudeError: "budget" });
  });

  it("una domanda per risposta; risposta e autore insieme", async () => {
    const [reply] = await t.db
      .insert(chatMessages)
      .values({ channelId: general, body: "", kind: "claude", claudeState: "waiting" })
      .returning({ id: chatMessages.id });
    await t.db.insert(chatClaudeQuestions).values({ replyMessageId: reply!.id, text: "?", options: [{ label: "a" }] });
    await expect(t.db.insert(chatClaudeQuestions).values({ replyMessageId: reply!.id, text: "??", options: [] })).rejects.toThrow();
    await expect(
      t.db.update(chatClaudeQuestions).set({ answeredAt: new Date() }).where(eq(chatClaudeQuestions.replyMessageId, reply!.id)),
    ).rejects.toThrow();
  });
});
