import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { agentSessionEvents, agentSessions, claudeConversations, users } from "@stubwise/db";
import { pruneAgentSessions } from "./store.js";

// La potatura delle sessioni e le conversazioni con Claude (fetta 5, D5 del
// maintainer): una PUBBLICA non si pota (né la sessione né i suoi eventi);
// una tornata privata riparte da «Make private»; una privata vecchia sì.

let t: TestDb;
let ownerId: string;

beforeAll(async () => {
  t = await startTestDb();
  const [u] = await t.db.insert(users).values({ email: `p-${randomUUID()}@example.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  ownerId = u!.id;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

const DAY = 86_400_000;

async function conversation(over: Partial<typeof claudeConversations.$inferInsert>): Promise<string> {
  const old = new Date(Date.now() - 30 * DAY);
  const [s] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: `free:${randomUUID()}`, kind: "free", title: "x", startedAt: old, lastEventAt: old } as typeof agentSessions.$inferInsert)
    .returning({ id: agentSessions.id });
  await t.db.insert(claudeConversations).values({ sessionId: s!.id, ownerId, title: "x", ...over } as typeof claudeConversations.$inferInsert);
  await t.db
    .insert(agentSessionEvents)
    .values({ sessionId: s!.id, segmentId: "s", type: "assistant_text", data: { text: "vecchio" }, createdAt: old } as typeof agentSessionEvents.$inferInsert);
  return s!.id;
}

describe("potatura e conversazioni pubbliche", () => {
  it("si pota la privata vecchia; la pubblica e quella appena tornata privata restano, eventi compresi", async () => {
    const privateOld = await conversation({});
    const publicOld = await conversation({ visibility: "public", publishedAt: new Date(Date.now() - 30 * DAY) });
    const madePrivate = await conversation({ visibilityChangedAt: new Date(Date.now() - DAY) });
    await pruneAgentSessions(t.db);
    const left = (await t.db.select({ id: agentSessions.id }).from(agentSessions).where(inArray(agentSessions.id, [privateOld, publicOld, madePrivate]))).map((r) => r.id);
    expect(left.sort()).toEqual([publicOld, madePrivate].sort());
    expect(await t.db.select().from(agentSessionEvents).where(eq(agentSessionEvents.sessionId, publicOld))).toHaveLength(1);
    expect(await t.db.select().from(agentSessionEvents).where(eq(agentSessionEvents.sessionId, madePrivate))).toHaveLength(1);
  });
});
