import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeLog, projects, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0187 (16 nov 2026, area 9, F2): il registro delle modifiche.
 * Solo in aggiunta (D-4): il trigger rifiuta UPDATE, DELETE e TRUNCATE, e
 * lascia passare solo le `SET NULL` delle FK di attore e progetto.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function person(): Promise<{ id: string; email: string }> {
  const email = `${randomUUID()}@acme.com`;
  const [u] = await t.db.insert(users).values({ email, passwordHash: "h", role: "member" }).returning({ id: users.id });
  return { id: u!.id, email };
}
/** Il trigger rifiuta: il motivo sta nella `cause` dell'errore di Drizzle. */
async function rejectedAppendOnly(run: () => Promise<unknown>) {
  const error = await run().then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(`${error?.message ?? ""} ${error?.cause?.message ?? ""}`).toMatch(/append-only/);
}
async function entry(actor: { id: string; email: string }, projectId: string | null) {
  const [row] = await t.db
    .insert(changeLog)
    .values({ actorUserId: actor.id, actorEmail: actor.email, actorKind: "user", type: "role.created", projectId, subjectKind: "role", subjectId: randomUUID(), data: { object: { type: "role", id: "x", label: "R" } } })
    .returning();
  return row!;
}

describe("0187: il registro delle modifiche", () => {
  it("una voce nasce con l'istante, e `actor_kind` è chiuso", async () => {
    const p = await person();
    const row = await entry(p, null);
    expect(row.at).toBeInstanceOf(Date);
    await expect(
      t.db.insert(changeLog).values({ actorEmail: "x", actorKind: "robot" as never, type: "role.created", subjectKind: "role", subjectId: "x", data: {} }),
    ).rejects.toThrow();
  });

  it("UPDATE, DELETE e TRUNCATE sono rifiutati", async () => {
    const row = await entry(await person(), null);
    await rejectedAppendOnly(() => t.db.update(changeLog).set({ data: { forged: true } }).where(eq(changeLog.id, row.id)));
    await rejectedAppendOnly(() => t.db.update(changeLog).set({ actorEmail: "altro@acme.com" }).where(eq(changeLog.id, row.id)));
    await rejectedAppendOnly(() => t.db.delete(changeLog).where(eq(changeLog.id, row.id)));
    await rejectedAppendOnly(() => t.db.execute(sql`truncate change_log`));
    const [still] = await t.db.select().from(changeLog).where(eq(changeLog.id, row.id));
    expect(still!.data).toEqual(row.data);
  });

  it("eliminare l'utente o il progetto azzera il riferimento, e la voce resta com'era", async () => {
    const p = await person();
    const { projectId } = await seedRepository(t.db);
    const row = await entry(p, projectId);
    await t.db.delete(users).where(eq(users.id, p.id));
    await t.db.delete(projects).where(eq(projects.id, projectId));
    const [after] = await t.db.select().from(changeLog).where(eq(changeLog.id, row.id));
    expect(after).toMatchObject({ actorUserId: null, projectId: null, actorEmail: p.email, type: "role.created", data: row.data });
  });
});
