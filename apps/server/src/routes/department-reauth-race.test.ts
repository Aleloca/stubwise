import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { departmentMembers, departmentProjectPermissions, departments, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * La riconferma del `PATCH /api/departments/:id` si decide DENTRO la
 * transazione, sul salvato bloccato (registro dei rimandi, area 9, i Minor
 * della review di F8). Il caso: una bozza vecchia rimanda l'insieme intero
 * delle persone, senza `ifMatch`, mentre qualcuno ha appena tolto una di loro.
 * Letto fuori, il salvato la conteneva ancora e la riconferma non serviva;
 * dentro, rimetterla FA ARRIVARE i permessi del reparto: 403 `reauth_required`.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let mgr: { id: string; cookie: string };
let a: string;
let c: string;
let X: string;

async function person(email: string) {
  const [u] = await t.db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u!.id;
}
async function stale(userId: string): Promise<string> {
  const old = await createSession(t.db, userId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
  return `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
}
const membersOf = async (id: string) =>
  (await t.db.select({ u: departmentMembers.userId }).from(departmentMembers).where(eq(departmentMembers.departmentId, id))).map((r) => r.u).sort();

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  const { projectId } = await seedRepository(t.db);
  const [role] = await t.db.insert(roles).values({ name: "Gestore reparti corsa", scope: "instance", permissions: ["departments.manage"] }).returning({ id: roles.id });
  const mgrId = await person("mgr-race@example.com");
  await t.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, mgrId));
  mgr = { id: mgrId, cookie: await fullSessionCookie(app, mgrId) };
  await addMember(app, projectId, mgr.id, "project_lead");
  a = await person("a-race@example.com");
  c = await person("c-race@example.com");
  await addMember(app, projectId, a, "developer");
  await addMember(app, projectId, c, "developer");
  const lead = (await t.db.select({ p: roles.permissions }).from(roles).where(eq(roles.presetKey, "project_lead")))[0]!.p;
  const dev = (await t.db.select({ p: roles.permissions }).from(roles).where(eq(roles.presetKey, "developer")))[0]!.p;
  X = PROJECT_PERMISSIONS.find((p) => lead.includes(p) && !dev.includes(p) && p !== "project.members.manage")!;
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

/** Aspetta che una richiesta sia in coda su un lock (la transazione del PATCH sul reparto bloccato). */
async function untilSomeoneWaits() {
  for (let i = 0; i < 200; i++) {
    const [row] = (await t.db.execute(sql`select count(*)::int as n from pg_locks where not granted`)) as unknown as { n: number }[];
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("il PATCH non è mai arrivato al lock del reparto");
}

/**
 * Un reparto che dà X con `a` e `c`; chi toglie `c` tiene il reparto bloccato
 * finché il PATCH (che rimanda `a` e `c`) non ha letto fuori il salvato di
 * prima ed è in coda sul lock. Restituisce la risposta del PATCH.
 */
async function raceRemovingC(name: string, cookie: string) {
  const [d] = await t.db.insert(departments).values({ name, colorToken: "--dept-5" }).returning();
  for (const userId of [a, c]) await t.db.insert(departmentMembers).values({ departmentId: d!.id, userId });
  await t.db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission: X });
  let removed!: () => void;
  const removing = new Promise<void>((r) => (removed = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const remover = t.db.transaction(async (tx) => {
    await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, d!.id)).for("update");
    await tx.delete(departmentMembers).where(and(eq(departmentMembers.departmentId, d!.id), eq(departmentMembers.userId, c)));
    removed();
    await gate;
  });
  await removing;
  const patching = app.inject({ method: "PATCH", url: `/api/departments/${d!.id}`, headers: { cookie }, payload: { memberIds: [a, c] } });
  await untilSomeoneWaits();
  release();
  await remover;
  return { id: d!.id, res: await patching };
}

describe("la riconferma del PATCH di un reparto, dentro la transazione", () => {
  it("una persona tolta mentre una bozza vecchia la rimanda: 403 `reauth_required`, e resta fuori", async () => {
    const { id, res } = await raceRemovingC("Reparto corsa", await stale(mgr.id));
    expect([res.statusCode, (res.json() as { code: string }).code]).toEqual([403, "reauth_required"]);
    expect(await membersOf(id)).toEqual([a]);
    // Con la riconferma la stessa bozza la rimette.
    expect((await app.inject({ method: "PATCH", url: `/api/departments/${id}`, headers: { cookie: mgr.cookie }, payload: { memberIds: [a, c] } })).statusCode).toBe(200);
    expect(await membersOf(id)).toEqual([a, c].sort());
  });

  it("la stessa corsa con la riconferma fresca: la transazione la chiede, c'è, e la scrittura passa", async () => {
    const { id, res } = await raceRemovingC("Reparto corsa riconfermata", mgr.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(await membersOf(id)).toEqual([a, c].sort());
  });
});
