import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { departmentMembers, departmentProjectPermissions, departments, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F8, Task 4: la provenienza `department` accanto a `role` e `grant`
 * (Members, la pagina della persona, «Chi può farlo?», l'anteprima del
 * membro), l'elenco dei reparti coi permessi per chi li gestisce, e
 * l'aggiunta a un progetto di chi porta permessi dal suo reparto (F8-4 = a:
 * l'escalation la controlla l'aggiunta).
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let adminCookie: string;
let p: string;
let leadCookie: string;
let dev: string;
let outsider: string;
let deptId: string;
let deptName: string;
/** Un permesso che il Developer non ha (lo dà il reparto); `Z` uno che ha già dal ruolo. */
let X: string;
let Z: string;
let limited: { id: string; cookie: string };
let devRoleId: string;

async function person(email: string) {
  const [u] = await t.db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u!.id;
}

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  ({ adminCookie } = await seedUsers(app));
  ({ projectId: p } = await seedRepository(t.db));
  const leadId = await person("lead-f8s@example.com");
  await addMember(app, p, leadId, "project_lead");
  leadCookie = await fullSessionCookie(app, leadId);
  dev = await person("dev-f8s@example.com");
  await addMember(app, p, dev, "developer");
  const [devRole] = await t.db.select({ id: roles.id, p: roles.permissions }).from(roles).where(eq(roles.presetKey, "developer"));
  devRoleId = devRole!.id;
  X = PROJECT_PERMISSIONS.find((x) => !devRole!.p.includes(x) && x !== "project.members.manage")!;
  Z = devRole!.p.find((x) => (PROJECT_PERMISSIONS as readonly string[]).includes(x))!;
  deptName = "Reparto fonti F8";
  const [d] = await t.db.insert(departments).values({ name: deptName, colorToken: "--dept-6" }).returning();
  deptId = d!.id;
  await t.db.insert(departmentProjectPermissions).values([
    { departmentId: deptId, permission: X },
    { departmentId: deptId, permission: Z },
  ]);
  await t.db.insert(departmentMembers).values({ departmentId: deptId, userId: dev });
  // Chi gestisce i membri di P ma non ha X: un ruolo di progetto col solo `project.members.manage`.
  const [r] = await t.db.insert(roles).values({ name: "Solo membri F8", scope: "project", permissions: ["project.members.manage"] }).returning({ id: roles.id });
  const limitedId = await person("lim-f8s@example.com");
  const { projectMembers } = await import("@stubwise/db");
  await t.db.insert(projectMembers).values({ projectId: p, userId: limitedId, roleId: r!.id });
  limited = { id: limitedId, cookie: await fullSessionCookie(app, limitedId) };
  // Uno fuori dal progetto, nello stesso reparto: entrando porterebbe X.
  outsider = await person("out-f8s@example.com");
  await t.db.insert(departmentMembers).values({ departmentId: deptId, userId: outsider });
  // Un progetto in comune con chi gestisce: così lo vede (R-G5) e può aggiungerlo.
  const { projectId: q } = await seedRepository(t.db);
  await t.db.insert(projectMembers).values([
    { projectId: q, userId: limitedId, roleId: devRoleId },
    { projectId: q, userId: outsider, roleId: devRoleId },
  ]);
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

type Src = { kind: string; departmentId?: string | null; departmentName?: string | null };
const dept = (s: Src) => s.kind === "department" && s.departmentId === deptId;

describe("area 9, F8: la provenienza «department»", () => {
  it("Members (la vista): X è un permesso in più, dal reparto, col nome", async () => {
    const view = (await app.inject({ method: "GET", url: `/api/projects/${p}/members/view`, headers: { cookie: leadCookie } })).json() as {
      members: { personId: string; extra: { permission: string; sources: Src[] }[] }[];
    };
    const row = view.members.find((m) => m.personId === dev)!;
    const extra = row.extra.find((e) => e.permission === X)!;
    expect(extra.sources.some((s) => dept(s) && s.departmentName === deptName)).toBe(true);
  });

  it("i membri del progetto (la rotta di prima): X dal reparto, Z dal ruolo E dal reparto", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/projects/${p}/members`, headers: { cookie: leadCookie } })).json() as {
      userId: string;
      permissions: { permission: string; sources: Src[] }[];
    }[];
    const row = list.find((m) => m.userId === dev)!;
    expect(row.permissions.find((x) => x.permission === X)!.sources.some(dept)).toBe(true);
    expect(row.permissions.find((x) => x.permission === Z)!.sources.map((s) => s.kind).sort()).toEqual(["department", "role"]);
  });

  it("la pagina della persona: X nel progetto, dal reparto", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/admin/people/${dev}`, headers: { cookie: adminCookie } })).json() as {
      projects: { projectId: string; extra: { permission: string; sources: Src[] }[] }[];
    };
    const proj = detail.projects.find((x) => x.projectId === p)!;
    expect(proj.extra.find((e) => e.permission === X)!.sources.some((s) => dept(s) && s.departmentName === deptName)).toBe(true);
  });

  it("«Chi può farlo?»: il motivo «via <reparto>», col nome", async () => {
    const res = (await app.inject({ method: "GET", url: `/api/access/who-can?permission=${X}&projectId=${p}`, headers: { cookie: leadCookie } })).json() as {
      people: { userId: string; reasons: Src[] }[];
    };
    const row = res.people.find((x) => x.userId === dev)!;
    expect(row.reasons).toEqual([expect.objectContaining({ kind: "department", departmentId: deptId, departmentName: deptName })]);
  });

  it("l'anteprima del membro: X resta, dal reparto", async () => {
    const res = (await app.inject({ method: "POST", url: `/api/projects/${p}/members/${dev}/preview`, headers: { cookie: leadCookie }, payload: { roleId: devRoleId, granted: [] } })).json() as {
      permissions: { permission: string; sources: Src[] }[];
    };
    expect(res.permissions.find((x) => x.permission === X)!.sources.some(dept)).toBe(true);
  });
});

describe("area 9, F8: aggiungere a un progetto chi porta permessi dal suo reparto (F8-4 = a)", () => {
  it("chi gestisce i membri ma non ha X: la persona del reparto è spenta col motivo, e aggiungerla è 403 escalation", async () => {
    const view = (await app.inject({ method: "GET", url: `/api/projects/${p}/members/view`, headers: { cookie: limited.cookie } })).json() as {
      addableMissing: Record<string, string[]>;
    };
    expect(view.addableMissing[outsider]).toContain(X);
    const res = await app.inject({ method: "PUT", url: `/api/projects/${p}/members/${outsider}`, headers: { cookie: limited.cookie }, payload: { roleId: devRoleId } });
    // Il ruolo stesso (Developer) ha permessi che lui non ha: l'escalation c'è comunque; quella del reparto si prova sotto.
    expect(res.statusCode).toBe(403);
  });

  it("chi ha il ruolo ma non X: aggiungere la persona del reparto è 403 escalation su X; senza reparto passa", async () => {
    const [r] = await t.db.insert(roles).values({ name: "Developer e membri F8", scope: "project", permissions: [...((await t.db.select({ p: roles.permissions }).from(roles).where(eq(roles.id, devRoleId)))[0]!.p), "project.members.manage"] }).returning({ id: roles.id });
    const actorId = await person("act-f8s@example.com");
    const { projectMembers } = await import("@stubwise/db");
    await t.db.insert(projectMembers).values({ projectId: p, userId: actorId, roleId: r!.id });
    const cookie = await fullSessionCookie(app, actorId);
    const res = await app.inject({ method: "PUT", url: `/api/projects/${p}/members/${outsider}`, headers: { cookie }, payload: { roleId: devRoleId } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", permission: X });
    const plain = await person("plain-f8s@example.com");
    expect((await app.inject({ method: "PUT", url: `/api/projects/${p}/members/${plain}`, headers: { cookie }, payload: { roleId: devRoleId } })).statusCode).toBe(200);
  });
});

describe("area 9, F8: l'elenco dei reparti", () => {
  it("projectPermissions solo a chi gestisce i reparti; agli altri []", async () => {
    const asAdmin = (await app.inject({ method: "GET", url: "/api/departments", headers: { cookie: adminCookie } })).json() as { id: string; projectPermissions: string[] }[];
    expect(asAdmin.find((d) => d.id === deptId)!.projectPermissions.sort()).toEqual([X, Z].sort());
    const asLead = (await app.inject({ method: "GET", url: "/api/departments", headers: { cookie: leadCookie } })).json() as { id: string; projectPermissions: string[] }[];
    expect(asLead.find((d) => d.id === deptId)!.projectPermissions).toEqual([]);
  });
});
