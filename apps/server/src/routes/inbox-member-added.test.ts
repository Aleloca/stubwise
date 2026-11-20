import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { changeLog, claudeActionGroups, claudeActions, notifications } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { PRESET_ROLES } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { putProjectMember, removeProjectMember } from "../services/roles.js";
import { addMember, createUserWithSession, presetRoleId, seedUsers } from "../test/fixtures.js";

/**
 * Area 10, F5 (D-11 = b): «Undone by» sulle card `member.added`, DERIVATO a
 * lettura dal registro delle modifiche, mai dal jsonb (CLAUDE.md, «I campi che
 * un client legge su una card… si DERIVANO A LETTURA»).
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let n = 0;
const LEAD = new Set(PRESET_ROLES.find((r) => r.key === "project_lead")!.permissions);

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const person = () => createUserWithSession(app, `u${++n}-${randomUUID().slice(0, 6)}@example.com`);
const actorOf = (u: U) => ({ id: u.id, email: `${u.id}@example.com`, isAgent: false, instancePermissions: new Set<string>() }) as never;
async function scene() {
  const { projectId } = await seedRepository(t.db);
  const g1 = await person();
  const g2 = await person();
  const p = await person();
  await addMember(app, projectId, g1.id, "project_lead");
  await addMember(app, projectId, g2.id, "project_lead");
  return { projectId, g1, g2, p, developer: await presetRoleId(app, "developer") };
}
/** Un'azione di Claude vera (le colonne «via Claude» hanno la FK). */
async function claudeAction(requesterId: string): Promise<string> {
  const [g] = await t.db.insert(claudeActionGroups).values({ requesterId }).returning();
  const [a] = await t.db.insert(claudeActions).values({ groupId: g!.id, seq: 0, fn: "addMember", args: {}, cls: "C" }).returning();
  return a!.id;
}
const inboxOf = async (u: U) =>
  ((await app.inject({ method: "GET", url: "/api/inbox", headers: u.headers })).json() as { items: { kind: string; projectId: string | null; undoneBy: { id: string; name: string } | null }[] }).items;
const cardOf = async (u: U, projectId: string) => (await inboxOf(u)).find((i) => i.kind === "member.added" && i.projectId === projectId);

describe("«Undone by» sulle card member.added", () => {
  it("un ingresso fatto da Claude e annullato con «Annulla»: chi ha annullato", async () => {
    const s = await scene();
    const action = await claudeAction(s.g1.id);
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.via_claude_action_id', ${action}, true)`);
      await putProjectMember(tx as never, actorOf(s.g1), LEAD, s.projectId, s.p.id, s.developer);
    });
    expect((await cardOf(s.p, s.projectId))!.undoneBy).toBeNull();
    // L'«Annulla»: l'esecutore imposta la variabile dell'azione annullata.
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.undo_of_claude_action_id', ${action}, true)`);
      await removeProjectMember(tx as never, actorOf(s.g2), LEAD, s.projectId, s.p.id);
    });
    // Chi è stato tolto non vede più il progetto (né la sua card): la legge un gestore che resta.
    expect((await cardOf(s.g2, s.projectId))!.undoneBy).toMatchObject({ id: s.g2.id });
  });

  it("tolto A MANO (non un «Annulla»): nessun «Undone by»", async () => {
    const s = await scene();
    const action = await claudeAction(s.g1.id);
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.via_claude_action_id', ${action}, true)`);
      await putProjectMember(tx as never, actorOf(s.g1), LEAD, s.projectId, s.p.id, s.developer);
    });
    await removeProjectMember(t.db, actorOf(s.g2), LEAD, s.projectId, s.p.id);
    expect((await cardOf(s.g2, s.projectId))!.undoneBy).toBeNull();
  });

  it("CARD VECCHIA senza changeLogEntryId: null, e non lancia; un `undoneBy` nel jsonb viene SOVRASCRITTO dal derivato", async () => {
    const s = await scene();
    await addMember(app, s.projectId, s.p.id, "developer");
    await t.db.insert(notifications).values([
      { userId: s.p.id, projectId: s.projectId, kind: "member.added", status: "open", event: { kind: "member.added", projectId: s.projectId, projectCode: "X", projectName: "X", addedUserId: s.p.id, addedName: "P", roleName: "Developer", actorUserId: s.g1.id, actorName: "G1", viaClaude: false, alertMandatory: "added" } },
    ]);
    expect((await cardOf(s.p, s.projectId))!.undoneBy).toBeNull();
    // Un ingresso a mano, con un jsonb che MENTE.
    await putProjectMember(t.db, actorOf(s.g1), LEAD, s.projectId, (await person()).id, s.developer);
    const [entry] = await t.db.select({ id: changeLog.id }).from(changeLog).where(and(eq(changeLog.projectId, s.projectId), eq(changeLog.type, "member.added"))).limit(1);
    const liar = await person();
    await t.db.insert(notifications).values({ userId: liar.id, projectId: s.projectId, kind: "member.added", status: "open", event: { kind: "member.added", changeLogEntryId: entry!.id, undoneBy: { id: s.g2.id, name: "Falso" }, projectId: s.projectId, projectCode: "X", projectName: "X", addedUserId: liar.id, addedName: "L", roleName: "Developer", actorUserId: s.g1.id, actorName: "G1", viaClaude: false, alertMandatory: "added" } });
    await addMember(app, s.projectId, liar.id, "developer");
    expect((await cardOf(liar, s.projectId))!.undoneBy).toBeNull();
  });
});
