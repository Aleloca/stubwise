import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiJobs, attachments, comments, notifications, ticketFollowers, tickets } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { SessionUser } from "../auth/session.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { afterCommit, assertNotDryRun, DryRunEscapeError, runActionContext } from "./effects.js";
import { executeGroup } from "./execute.js";

// La PROVA A SECCO non esce mai dalla transazione (chat, fetta 3): niente
// HTTP, storage, AI, risvegli o seguiti dopo il commit. Per costruzione: ogni
// seguito passa da `effects.ts`, che a secco lo scarta; a runtime, nessuna
// chiamata fuori e nessuna riga rimasta; sul sorgente, nessun modulo
// raggiungibile dal catalogo esce da solo.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let author: SessionUser;
let authorId: string;
let followerId: string;
let sessionId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  const a = await createUserWithSession(app, "dry-author@example.com");
  const f = await createUserWithSession(app, "dry-follower@example.com");
  authorId = a.id;
  followerId = f.id;
  await addMember(app, projectId, a.id, "project_lead");
  await addMember(app, projectId, f.id, "developer");
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: a.headers.cookie } });
  const user = me.json() as { user: { id: string; email: string; role: "admin" | "member" }; instancePermissions: string[] };
  author = {
    id: user.user.id,
    email: user.user.email,
    role: user.user.role,
    instancePermissions: new Set(user.instancePermissions),
  } as unknown as SessionUser;
  const conv = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: a.headers.cookie }, payload: {} });
  sessionId = (conv.json() as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

let n = 0;
async function task() {
  n += 1;
  const [row] = await t.db
    .insert(tickets)
    .values({ projectId, number: 9000 + n, title: `Secco ${n}`, type: "bug", priority: "medium", source: "manual", requestedByUserId: authorId })
    .returning({ id: tickets.id });
  await t.db.insert(ticketFollowers).values({ ticketId: row!.id, userId: followerId } as typeof ticketFollowers.$inferInsert);
  return row!.id;
}

/** Una prova a secco con lo storage e la rete sorvegliati. */
async function dry(actions: { fn: string; args: Record<string, unknown> }[]) {
  const storage = { deleteObject: vi.fn(async () => undefined) };
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    const result = await executeGroup(t.db, author, {
      sessionId,
      actions: actions as never,
      dryRun: true,
      effects: { storage: async () => storage },
    });
    return { result, storage, fetchCalls: fetchSpy.mock.calls.length };
  } finally {
    fetchSpy.mockRestore();
  }
}

describe("la prova a secco non chiama fuori", () => {
  it("startRun: nessun job resta, nessuna notifica, nessuna chiamata", async () => {
    const id = await task();
    const { result, fetchCalls } = await dry([{ fn: "startRun", args: { taskId: id } }]);
    expect(result.ok).toBe(true);
    expect(fetchCalls).toBe(0);
    expect(await t.db.select().from(aiJobs).where(eq(aiJobs.ticketId, id))).toEqual([]);
    expect(await t.db.select().from(notifications).where(eq(notifications.ticketId, id))).toEqual([]);
  });

  it("addComment: il commento e l'avviso al follower ci sono durante il giro (la classe sale), poi spariscono", async () => {
    const id = await task();
    const { result, fetchCalls } = await dry([{ fn: "addComment", args: { taskId: id, body: "a secco" } }]);
    expect(result).toMatchObject({ ok: true, notified: [followerId] });
    expect(fetchCalls).toBe(0);
    expect(await t.db.select().from(comments).where(eq(comments.ticketId, id))).toEqual([]);
    expect(await t.db.select().from(notifications).where(eq(notifications.userId, followerId))).toEqual([]);
  });

  it("deleteTask e deleteComment con allegati: lo storage NON si tocca a secco; dal vero sì, dopo il commit", async () => {
    const id = await task();
    await t.db.insert(attachments).values({
      ticketId: id,
      uploaderId: authorId,
      filename: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      storageKey: `k/${id}`,
    } as typeof attachments.$inferInsert);
    const secco = await dry([{ fn: "deleteTask", args: { id } }]);
    expect(secco.result.ok).toBe(true);
    expect(secco.storage.deleteObject).not.toHaveBeenCalled();
    expect(await t.db.select().from(tickets).where(eq(tickets.id, id))).toHaveLength(1);

    const storage = { deleteObject: vi.fn(async () => undefined) };
    const real = await executeGroup(t.db, author, {
      sessionId,
      actions: [{ fn: "deleteTask", args: { id } }],
      effects: { storage: async () => storage },
    });
    expect(real.ok).toBe(true);
    expect(storage.deleteObject).toHaveBeenCalledWith(`k/${id}`);

    const other = await task();
    const [c] = await t.db
      .insert(comments)
      .values({ ticketId: other, authorType: "user", authorId, body: "con file" } as typeof comments.$inferInsert)
      .returning();
    await t.db.insert(attachments).values({
      ticketId: other,
      commentId: c!.id,
      uploaderId: authorId,
      filename: "b.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      storageKey: `k/c/${c!.id}`,
    } as typeof attachments.$inferInsert);
    const seccoComment = await dry([{ fn: "deleteComment", args: { id: c!.id, taskId: other } }]);
    expect(seccoComment.result.ok).toBe(true);
    expect(seccoComment.storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe("il punto unico dei seguiti", () => {
  it("afterCommit: scartato a secco, accodato dal vero, vietato fuori dall'esecutore", async () => {
    const seen: string[] = [];
    const secco = await runActionContext({ dryRun: true }, async () => afterCommit(async () => void seen.push("secco")));
    expect(secco.followUps).toEqual([]);
    const vero = await runActionContext({ dryRun: false }, async () => afterCommit(async () => void seen.push("vero")));
    expect(vero.followUps).toHaveLength(1);
    expect(() => afterCommit(async () => undefined)).toThrow();
  });

  it("assertNotDryRun: una chiamata esterna in una prova a secco fallisce", async () => {
    await expect(runActionContext({ dryRun: true }, async () => assertNotDryRun("fetch"))).rejects.toBeInstanceOf(DryRunEscapeError);
    await expect(runActionContext({ dryRun: false }, async () => assertNotDryRun("fetch"))).resolves.toBeDefined();
  });
});

describe("sul sorgente: nessun modulo raggiungibile dal catalogo esce da solo", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  /** La chiusura degli import RELATIVI del server a partire dal catalogo e dall'esecutore. */
  function reachable(): string[] {
    const seen = new Set<string>();
    const stack = [join(here, "catalog.ts"), join(here, "execute.ts")];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)) stack.push(normalize(join(dirname(file), `${m[1]}.ts`)));
    }
    return [...seen];
  }
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  /** Ciò che esce dalla transazione: rete, storage, AI, embedding, timer, seguiti post-commit. */
  const ESCAPES = [
    /\bfetch\(/,
    /\bdeleteObject\(/,
    /\.storage\(\)/,
    /@anthropic-ai\/sdk/,
    /\bembed[A-Z]\w*\(/,
    /\bsetImmediate\(|\bqueueMicrotask\(|\bsetTimeout\(/,
    /\bpublishRequestCreated\(|\bnotifyTicketCreated\(|\bpromotePending\w*\(/,
  ];

  it("i moduli ci sono (il test non gira a vuoto)", () => {
    const files = reachable();
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("task-writes.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("jobs.ts"))).toBe(true);
  });

  it("il catalogo non raggiunge la Chat che scrive nello storage (service, allegati, storage)", () => {
    // Le scritture delle task usano dalla Chat solo il legame col messaggio,
    // in un modulo foglia (`chat/links.ts`): la catena task-writes → chat/service
    // → chat/attachments → storage portava `deleteObject` dentro il catalogo.
    const files = reachable();
    expect(files.some((f) => f.endsWith("chat/links.ts"))).toBe(true);
    expect(files.filter((f) => /chat\/service\.ts$|chat\/attachments\.ts$|\/storage\//.test(f))).toEqual([]);
  });

  it("solo `effects.ts` può uscire (e lo fa solo dopo il commit, mai a secco)", () => {
    const offenders = reachable()
      .filter((f) => !f.endsWith("effects.ts"))
      .flatMap((f) => ESCAPES.filter((re) => re.test(code(readFileSync(f, "utf8")))).map((re) => `${f}: ${re}`));
    expect(offenders).toEqual([]);
  });
});
