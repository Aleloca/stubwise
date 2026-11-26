import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { changeLog, claudeActionGroups, claudeActions, notifications, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { applyInviteGrants, putProjectMember } from "../services/roles.js";
import { addMember, createUserWithSession, presetRoleId, seedUsers } from "../test/fixtures.js";
import { PRESET_ROLES } from "@stubwise/shared";

/** I permessi di chi agisce nel progetto (un Project Lead): il `held` del servizio. */
const PROJECT_LEAD_PERMS = PRESET_ROLES.find((r) => r.key === "project_lead")!.permissions;

/**
 * Area 10, F5 (D-11 = b, maintainer): l'avviso `member.added` a ogni INGRESSO
 * in un progetto, nella transazione della voce del registro. Alla persona
 * aggiunta (obbligatorio) e a chi gestisce i membri; mai a chi ha agito, né
 * per un cambio di ruolo, né per l'agente.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let n = 0;
let adminId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  adminId = (await seedUsers(app)).adminId;
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const person = () => createUserWithSession(app, `p${++n}-${randomUUID().slice(0, 6)}@example.com`);
/** Due gestori (G1, G2), un membro senza il permesso (M) e la persona da aggiungere (P). */
async function scene() {
  const { projectId } = await seedRepository(t.db);
  const g1 = await person();
  const g2 = await person();
  const m = await person();
  const p = await person();
  await addMember(app, projectId, g1.id, "project_lead");
  await addMember(app, projectId, g2.id, "project_lead");
  await addMember(app, projectId, m.id, "developer");
  return { projectId, g1, g2, m, p, developer: await presetRoleId(app, "developer"), contributor: await presetRoleId(app, "contributor") };
}
const put = (as: U, projectId: string, userId: string, body: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${userId}`, headers: as.headers, payload: body });
const cards = async (projectId: string) =>
  t.db.select({ userId: notifications.userId, event: notifications.event }).from(notifications).where(and(eq(notifications.projectId, projectId), eq(notifications.kind, "member.added")));
const who = async (projectId: string) => (await cards(projectId)).map((c) => c.userId).sort();

describe("member.added agli ingressi", () => {
  it("a mano: alla persona aggiunta e all'altro gestore; non a chi aggiunge, non a un membro qualunque; l'evento porta la voce del registro", async () => {
    const s = await scene();
    expect((await put(s.g1, s.projectId, s.p.id, { roleId: s.developer })).statusCode).toBe(200);
    // Il full admin dell'istanza gestisce ogni progetto: come per gli altri tipi del catalogo, di partenza lo riceve.
    expect(await who(s.projectId)).toEqual([adminId, s.g2.id, s.p.id].sort());
    const [entry] = await t.db.select({ id: changeLog.id }).from(changeLog).where(and(eq(changeLog.projectId, s.projectId), eq(changeLog.type, "member.added"), eq(changeLog.subjectId, s.p.id)));
    const [card] = await cards(s.projectId);
    expect(card!.event).toMatchObject({ kind: "member.added", addedUserId: s.p.id, roleName: "Developer", actorUserId: s.g1.id, viaClaude: false, changeLogEntryId: entry!.id });
  });

  it("un cambio di ruolo non è un ingresso: nessuna card", async () => {
    const s = await scene();
    expect((await put(s.g1, s.projectId, s.m.id, { roleId: s.contributor })).statusCode).toBe(200);
    expect(await cards(s.projectId)).toEqual([]);
  });

  it("chi aggiunge sé stesso non riceve la sua card; l'altro gestore sì", async () => {
    const s = await scene();
    const [admin] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com"));
    const actor = { id: admin!.id, email: "admin@example.com", isAgent: false, instancePermissions: new Set(["instance.full_admin"]) } as never;
    await putProjectMember(t.db, actor, new Set(PROJECT_LEAD_PERMS), s.projectId, admin!.id, s.developer);
    const got = await who(s.projectId);
    expect(got).not.toContain(admin!.id);
    expect(got).toContain(s.g1.id);
  });

  it("con Claude per conto di G1 (la variabile dell'esecutore): la card dice «via Claude», l'attore resta G1", async () => {
    const s = await scene();
    // Un'azione di Claude vera (le colonne «via Claude» hanno la FK verso `claude_actions`).
    const [g] = await t.db.insert(claudeActionGroups).values({ requesterId: s.g1.id }).returning();
    const [action] = await t.db.insert(claudeActions).values({ groupId: g!.id, seq: 0, fn: "addMember", args: {}, cls: "C" }).returning();
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.via_claude_action_id', ${action!.id}, true)`);
      await putProjectMember(tx as never, { id: s.g1.id, email: "g1@example.com", isAgent: false, instancePermissions: new Set() } as never, new Set(PROJECT_LEAD_PERMS), s.projectId, s.p.id, s.developer);
    });
    const [card] = (await cards(s.projectId)).filter((c) => c.userId === s.p.id);
    expect(card!.event).toMatchObject({ actorUserId: s.g1.id, viaClaude: true });
    expect(await who(s.projectId)).not.toContain(s.g1.id);
  });

  it("un invito accettato: chi accetta è l'attore, la card va ai gestori e non a lui", async () => {
    const s = await scene();
    await t.db.transaction((tx) => applyInviteGrants(tx as never, s.p.id, [{ projectId: s.projectId, roleId: s.developer }], s.g1.id));
    const got = await who(s.projectId);
    expect(got).toEqual([adminId, s.g1.id, s.g2.id].sort());
  });

  it("aggiungere l'agente non avvisa nessuno", async () => {
    const s = await scene();
    const [agent] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true)).limit(1);
    if (agent) {
      await putProjectMember(t.db, { id: s.g1.id, email: "g1@example.com", isAgent: false, instancePermissions: new Set() } as never, new Set(PROJECT_LEAD_PERMS), s.projectId, agent.id, s.developer).catch(() => undefined);
      expect(await cards(s.projectId)).toEqual([]);
    }
  });

  it("se l'ingresso fallisce (l'escalation), non resta nessuna card", async () => {
    const s = await scene();
    // M non gestisce i membri: 403, e niente card.
    expect((await put(s.m, s.projectId, s.p.id, { roleId: s.developer })).statusCode).toBe(403);
    expect(await cards(s.projectId)).toEqual([]);
  });
});
