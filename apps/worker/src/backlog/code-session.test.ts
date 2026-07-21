import {
  backlogChatMessages,
  backlogCodeSessions,
  backlogItems,
  gitAccounts,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createCodeSessionRegistry,
  sweepCodeSessions,
  type CodeSessionEntry,
} from "./code-session.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
});

afterAll(async () => {
  await testDb.stop();
});

const silentLogger = { warn: () => {}, error: () => {} };

async function seed(db: Db): Promise<{ projectId: string; repositoryId: string; itemId: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({ name: `A ${randomUUID()}`, provider: "github", encryptedCredentials: "x" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "R",
      slug: `r-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/o/r",
      defaultBranch: "main",
    })
    .returning();
  const [item] = await db
    .insert(backlogItems)
    .values({ projectId: project!.id, title: "V", document: "d", source: "manual" })
    .returning({ id: backlogItems.id });
  return { projectId: project!.id, repositoryId: repository!.id, itemId: item!.id };
}

async function createSession(
  db: Db,
  itemId: string,
  repositoryId: string,
  lastActivityAt: Date,
): Promise<string> {
  const [s] = await db
    .insert(backlogCodeSessions)
    .values({ itemId, repositoryId, status: "active", lastActivityAt })
    .returning({ id: backlogCodeSessions.id });
  return s!.id;
}

/** Voce di registro con remove() spia. */
function entryWithSpy(sessionId: string, repositoryId: string): CodeSessionEntry & { removed: () => number } {
  const state = { removes: 0 };
  return Object.assign(
    {
      sessionId,
      repositoryId,
      dir: "/tmp/fake",
      cliSessionId: null,
      lastUsed: Date.now(),
      remove: async () => {
        state.removes++;
      },
    },
    { removed: () => state.removes },
  );
}

describe("createCodeSessionRegistry", () => {
  it("set/get/remove è idempotente e chiude il worktree una sola volta", async () => {
    const reg = createCodeSessionRegistry();
    const entry = entryWithSpy("s1", "r1");
    reg.set("item1", entry);
    expect(reg.get("item1")).toBe(entry);
    expect(reg.itemIds()).toEqual(["item1"]);

    await reg.remove("item1");
    expect(reg.get("item1")).toBeUndefined();
    expect(entry.removed()).toBe(1);
    // Seconda remove: no-op, non richiude.
    await reg.remove("item1");
    expect(entry.removed()).toBe(1);
  });

  it("closeAll chiude tutti i worktree e svuota il registro", async () => {
    const reg = createCodeSessionRegistry();
    const a = entryWithSpy("s1", "r1");
    const b = entryWithSpy("s2", "r2");
    reg.set("i1", a);
    reg.set("i2", b);
    await reg.closeAll();
    expect(a.removed()).toBe(1);
    expect(b.removed()).toBe(1);
    expect(reg.itemIds()).toEqual([]);
  });
});

describe("sweepCodeSessions", () => {
  it("chiude le sessioni active inattive oltre il TTL con un messaggio system e ne rimuove il worktree", async () => {
    const db = testDb.db;
    const { repositoryId, itemId } = await seed(db);
    // Inattiva da 40' (TTL 30').
    const old = new Date(Date.now() - 40 * 60_000);
    const sessionId = await createSession(db, itemId, repositoryId, old);
    const reg = createCodeSessionRegistry();
    const entry = entryWithSpy(sessionId, repositoryId);
    reg.set(itemId, entry);

    await sweepCodeSessions({ db, registry: reg, ttlMinutes: 30, logger: silentLogger });

    const [session] = await db.select().from(backlogCodeSessions).where(eq(backlogCodeSessions.id, sessionId));
    expect(session!.status).toBe("closed");
    expect(session!.closedAt).not.toBeNull();
    // Worktree rimosso, registro svuotato.
    expect(entry.removed()).toBe(1);
    expect(reg.get(itemId)).toBeUndefined();
    // Messaggio system i18n di scadenza.
    const [msg] = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, itemId));
    expect(msg!.role).toBe("system");
    expect(msg!.content).toContain("inactivity"); // en: "...due to inactivity."
  });

  it("NON chiude le sessioni active recenti (entro il TTL)", async () => {
    const db = testDb.db;
    const { repositoryId, itemId } = await seed(db);
    const recent = new Date(Date.now() - 5 * 60_000);
    const sessionId = await createSession(db, itemId, repositoryId, recent);
    const reg = createCodeSessionRegistry();
    const entry = entryWithSpy(sessionId, repositoryId);
    reg.set(itemId, entry);

    await sweepCodeSessions({ db, registry: reg, ttlMinutes: 30, logger: silentLogger });

    const [session] = await db.select().from(backlogCodeSessions).where(eq(backlogCodeSessions.id, sessionId));
    expect(session!.status).toBe("active");
    expect(entry.removed()).toBe(0);
    expect(reg.get(itemId)).toBe(entry);
  });

  it("rimuove il worktree di una sessione già chiusa (DELETE/convert) anche se non scaduta", async () => {
    const db = testDb.db;
    const { repositoryId, itemId } = await seed(db);
    // Sessione chiusa dal server (DELETE): nessun turno l'ha ripulita.
    const [s] = await db
      .insert(backlogCodeSessions)
      .values({ itemId, repositoryId, status: "closed", closedAt: new Date() })
      .returning({ id: backlogCodeSessions.id });
    const reg = createCodeSessionRegistry();
    const entry = entryWithSpy(s!.id, repositoryId);
    reg.set(itemId, entry);

    await sweepCodeSessions({ db, registry: reg, ttlMinutes: 30, logger: silentLogger });

    expect(entry.removed()).toBe(1);
    expect(reg.get(itemId)).toBeUndefined();
    // Nessun messaggio system aggiunto dallo sweep (era già chiusa).
    const msgs = await db.select().from(backlogChatMessages).where(eq(backlogChatMessages.itemId, itemId));
    expect(msgs).toHaveLength(0);
  });
});
