import { randomUUID } from "node:crypto";
import { changeLog, projectMembers, projects, roles, users, workspaceMembers, workspaceProjects, workspaces, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, createUserWithSession, presetRoleId, seedUsers } from "../test/fixtures.js";

/**
 * WORKSPACE, lotto 3 (`docs/plans/2026-11-27-workspace-piano.md`): le rotte e
 * le loro regole. Lea gestisce le workspace (`workspaces.manage`) ed è Project
 * Lead di A e B; Dino è Developer di A; Vera è la persona che entra; Olga non
 * c'entra. Ogni negativo verifica anche che il DB non sia cambiato.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

type Who = { id: string; headers: { cookie: string } };

async function project(name: string) {
  const [p] = await db.insert(projects).values({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  return p!.id;
}
async function person(name: string, instancePermissions?: string[]): Promise<Who> {
  const u = await createUserWithSession(app, `${name}-${randomUUID()}@x.test`);
  await db.update(users).set({ displayName: name }).where(eq(users.id, u.id));
  if (instancePermissions) {
    const [r] = await db.insert(roles).values({ name: `${name} ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: instancePermissions }).returning();
    await db.update(users).set({ instanceRoleId: r!.id }).where(eq(users.id, u.id));
  }
  return u;
}
async function seed() {
  const a = await project("Alfa");
  const b = await project("Beta");
  const lea = await person("Lea", ["users.view_all", "workspaces.manage"]);
  await addMember(app, a, lea.id, "project_lead");
  await addMember(app, b, lea.id, "project_lead");
  const dino = await person("Dino", ["users.view_all"]);
  await addMember(app, a, dino.id, "developer");
  const vera = await person("Vera");
  const olga = await person("Olga", []);
  return { a, b, lea, dino, vera, olga };
}
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const count = async (table: typeof workspaces | typeof workspaceMembers | typeof workspaceProjects) => (await db.select().from(table)).length;
async function created(lea: Who, body: Record<string, unknown>) {
  const res = await call("POST", "/api/workspaces", lea.headers, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; projectIds: string[]; canManage: boolean; canManagePeople: boolean };
}

describe("struttura", () => {
  it("Lea crea una workspace con A; chi non ha workspaces.manage no (403, niente scritto)", async () => {
    const { a, lea, dino } = await seed();
    const w = await created(lea, { name: "Clienti", projectIds: [a] });
    expect(w).toMatchObject({ projectIds: [a], canManage: true, canManagePeople: true });
    const before = await count(workspaces);
    expect((await call("POST", "/api/workspaces", dino.headers, { name: "No" })).statusCode).toBe(403);
    expect(await count(workspaces)).toBe(before);
    const [entry] = await db.select().from(changeLog).where(and(eq(changeLog.type, "workspace.project_added"), eq(changeLog.projectId, a)));
    expect(entry).toBeDefined();
  });

  it("D4: un progetto in cui chi agisce non gestisce i membri non entra (403), e la workspace non nasce", async () => {
    const { lea } = await seed();
    const c = await project("Gamma");
    await addMember(app, c, lea.id, "viewer");
    const before = await count(workspaces);
    const res = await call("POST", "/api/workspaces", lea.headers, { name: "Con Gamma", projectIds: [c] });
    expect(res.statusCode).toBe(403);
    expect(await count(workspaces)).toBe(before);
  });

  it("rinominare e spostare: un progetto passa da una workspace all'altra in una scrittura, col registro di entrambe", async () => {
    const { a, b, lea } = await seed();
    const one = await created(lea, { name: "Uno", projectIds: [a, b] });
    expect((await call("PATCH", `/api/workspaces/${one.id}`, lea.headers, { name: "Primo" })).json()).toMatchObject({ name: "Primo" });
    const two = await created(lea, { name: "Due" });
    const moved = await call("PUT", `/api/workspaces/${two.id}/projects/${b}`, lea.headers);
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await db.select().from(workspaceProjects).where(eq(workspaceProjects.projectId, b))).map((r) => r.workspaceId)).toEqual([two.id]);
    const types = (await db.select({ type: changeLog.type }).from(changeLog).where(eq(changeLog.projectId, b))).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["workspace.project_added", "workspace.project_removed"]));
  });
});

describe("M2 (revisione d'insieme): spostamenti incrociati", () => {
  it("A da Uno a Due e B da Due a Uno, in parallelo e più volte: nessun deadlock, ogni spostamento riesce", async () => {
    const { a, b, lea } = await seed();
    const one = await created(lea, { name: "Uno", projectIds: [a] });
    const two = await created(lea, { name: "Due", projectIds: [b] });
    let [left, right] = [one.id, two.id];
    for (let round = 0; round < 8; round++) {
      const results = await Promise.all([
        call("PUT", `/api/workspaces/${right}/projects/${a}`, lea.headers),
        call("PUT", `/api/workspaces/${left}/projects/${b}`, lea.headers),
      ]);
      expect(results.map((r) => [r.statusCode, r.statusCode === 200 ? "" : r.body])).toEqual([[200, ""], [200, ""]]);
      [left, right] = [right, left];
    }
    const placed = await db.select().from(workspaceProjects).where(inArray(workspaceProjects.projectId, [a, b]));
    expect(Object.fromEntries(placed.map((r) => [r.projectId, r.workspaceId]))).toEqual({ [a]: left, [b]: right });
  }, 60_000);
});

describe("persone", () => {
  it("Vera entra (Viewer di default, D3) e vede A; il registro lo dice; tolta, non lo vede più", async () => {
    const { a, lea, vera } = await seed();
    const w = await created(lea, { name: "Clienti", projectIds: [a] });
    expect((await call("GET", `/api/projects/${a}`, vera.headers)).statusCode).toBe(404);
    const res = await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { people: { userId: string; roleName: string }[] }).people).toEqual([expect.objectContaining({ userId: vera.id, roleName: "Viewer" })]);
    expect((await call("GET", `/api/projects/${a}`, vera.headers)).statusCode).toBe(200);
    expect(await db.select().from(changeLog).where(and(eq(changeLog.type, "workspace.member_added"), eq(changeLog.subjectId, vera.id)))).toHaveLength(1);
    expect((await call("DELETE", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers)).statusCode).toBe(204);
    expect((await call("GET", `/api/projects/${a}`, vera.headers)).statusCode).toBe(404);
  });

  it("NEGATIVO escalation: un ruolo con servers.operate (che Lea non ha) → 403 escalation, niente scritto", async () => {
    const { a, lea, vera } = await seed();
    const w = await created(lea, { name: "Ops", projectIds: [a] });
    const [ops] = await db.insert(roles).values({ name: `Ops ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["docs.view", "servers.operate"] }).returning();
    const before = await count(workspaceMembers);
    const res = await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, { roleId: ops!.id });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", missing: ["servers.operate"], projectId: a });
    expect(await count(workspaceMembers)).toBe(before);
  });

  it("NEGATIVO: chi non gestisce i membri di OGNI progetto non mette persone (403); Claude (400 system_user); un PAT (riconferma)", async () => {
    const { a, b, lea, dino, vera } = await seed();
    const w = await created(lea, { name: "Due progetti", projectIds: [a, b] });
    await addMember(app, a, dino.id, "project_lead");
    // Dino gestisce A, non B.
    const notAll = await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, dino.headers, {});
    expect(notAll.statusCode).toBe(403);
    expect(notAll.json()).toMatchObject({ code: "forbidden" });
    const [claude] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    const sys = await call("PUT", `/api/workspaces/${w.id}/members/${claude!.id}`, lea.headers, {});
    expect(sys.statusCode).toBe(400);
    expect(sys.json()).toMatchObject({ code: "system_user" });
    // Il PAT di chi potrebbe (un full admin): lo ferma la riconferma, non un permesso.
    const pat = await createUserWithPat(app, `pat-${randomUUID()}@x.test`);
    await db.update(users).set({ instanceRoleId: (await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin")))[0]!.id }).where(eq(users.id, pat.id));
    const viaPat = await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, pat.headers, {});
    expect(viaPat.statusCode).toBe(403);
    expect(viaPat.json()).toMatchObject({ code: "session_required" });
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.id))).toEqual([]);
  });

  it("D12: togliendo Vera con alsoProjects esce anche dai progetti dove era membro esplicito (member.removed); senza, l'override resta", async () => {
    const { a, lea, vera } = await seed();
    const w = await created(lea, { name: "Override", projectIds: [a] });
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    await addMember(app, a, vera.id, "developer");
    expect((await call("DELETE", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers)).statusCode).toBe(204);
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, a), eq(projectMembers.userId, vera.id)))).toHaveLength(1);
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    expect((await call("DELETE", `/api/workspaces/${w.id}/members/${vera.id}?alsoProjects=true`, lea.headers)).statusCode).toBe(204);
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, a), eq(projectMembers.userId, vera.id)))).toEqual([]);
    expect(await db.select().from(changeLog).where(and(eq(changeLog.type, "member.removed"), eq(changeLog.projectId, a), eq(changeLog.subjectId, vera.id)))).toHaveLength(1);
  });
});

describe("last_manager (D18)", () => {
  it("l'unico gestore di D è Vera per via di workspace: togliere il progetto, togliere lei, abbassarla, eliminare la workspace → 409, niente cambia", async () => {
    const d = await project("Delta");
    const vera = await person("Vera");
    const admin = { cookie: adminCookie };
    const w = (await call("POST", "/api/workspaces", admin, { name: "Delta", projectIds: [d] })).json() as { id: string };
    const lead = await presetRoleId(app, "project_lead");
    expect((await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, admin, { roleId: lead })).statusCode).toBe(200);
    const snapshot = async () => [await count(workspaces), await count(workspaceMembers), await count(workspaceProjects)];
    const before = await snapshot();
    for (const res of [
      await call("DELETE", `/api/workspaces/${w.id}/projects/${d}`, admin),
      await call("DELETE", `/api/workspaces/${w.id}/members/${vera.id}`, admin),
      await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, admin, { roleId: await presetRoleId(app, "viewer") }),
      await call("DELETE", `/api/workspaces/${w.id}`, admin),
    ]) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: "last_manager", projectId: d });
    }
    expect(await snapshot()).toEqual(before);
    // L'anteprima dice lo stesso.
    const effect = (await call("POST", "/api/workspaces/effect", admin, { kind: "removeMember", workspaceId: w.id, userId: vera.id })).json() as { lastManager: string[] };
    expect(effect.lastManager).toEqual([d]);
    // Anche l'eliminazione della workspace (46): l'anteprima lo dice.
    const deleting = (await call("POST", "/api/workspaces/effect", admin, { kind: "deleteWorkspace", workspaceId: w.id })).json() as { lastManager: string[] };
    expect(deleting.lastManager).toEqual([d]);
    const preview = (await call("POST", `/api/workspaces/${w.id}/members/${vera.id}/preview`, admin, { roleId: await presetRoleId(app, "viewer") })).json() as { lastManager: { blocked: boolean; projectId: string | null } };
    expect(preview.lastManager).toEqual({ blocked: true, projectId: d });
  });
});

describe("chi vede cosa (r.1414, D5)", () => {
  it("una workspace che Olga non vede: 404 e fuori dall'elenco; Dino (membro di A, non della workspace) la vede con il SOLO A", async () => {
    const { a, b, lea, dino, olga } = await seed();
    const w = await created(lea, { name: "Mista", projectIds: [a, b] });
    expect((await call("GET", `/api/workspaces/${w.id}`, olga.headers)).statusCode).toBe(404);
    expect(((await call("GET", "/api/workspaces", olga.headers)).json() as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(w.id);
    // M1 (revisione d'insieme): anche le scritture sulle sue persone rispondono 404, non 403 (che direbbe che esiste).
    const put = await call("PUT", `/api/workspaces/${w.id}/members/${dino.id}`, olga.headers, {});
    expect([put.statusCode, put.json().code]).toEqual([404, "not_found"]);
    const del = await call("DELETE", `/api/workspaces/${w.id}/members/${lea.id}`, olga.headers);
    expect([del.statusCode, del.json().code]).toEqual([404, "not_found"]);
    expect((await call("GET", `/api/workspaces/${w.id}`, lea.headers)).json().people.map((p: { userId: string }) => p.userId)).not.toContain(dino.id);
    const seen = await call("GET", `/api/workspaces/${w.id}`, dino.headers);
    expect(seen.json()).toMatchObject({ projectIds: [a], canManage: false, canManagePeople: false });
    expect(seen.body).not.toContain(b);
  });
});

describe("l'effetto di un cambio (workspaceAccessEffect)", () => {
  it("mettere B nella workspace di Vera: Vera comincia a vederla; togliere Vera: smette; e la scrittura fa lo stesso", async () => {
    const { a, b, lea, vera } = await seed();
    const w = await created(lea, { name: "Effetto", projectIds: [a] });
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    const add = (await call("POST", "/api/workspaces/effect", lea.headers, { kind: "addProject", workspaceId: w.id, projectId: b })).json() as {
      projects: { projectId: string; startSeeing: { userId: string }[]; stopSeeing: { userId: string }[] }[];
      escalation: unknown[];
    };
    expect(add.projects).toEqual([{ projectId: b, startSeeing: [expect.objectContaining({ userId: vera.id })], stopSeeing: [] }]);
    expect(add.escalation).toEqual([]);
    // L'anteprima non ha scritto niente.
    expect((await call("GET", `/api/projects/${b}`, vera.headers)).statusCode).toBe(404);
    await call("PUT", `/api/workspaces/${w.id}/projects/${b}`, lea.headers);
    expect((await call("GET", `/api/projects/${b}`, vera.headers)).statusCode).toBe(200);
    const remove = (await call("POST", "/api/workspaces/effect", lea.headers, { kind: "removeMember", workspaceId: w.id, userId: vera.id })).json() as {
      projects: { projectId: string; stopSeeing: { userId: string }[] }[];
    };
    expect(remove.projects.map((p) => [p.projectId, p.stopSeeing.map((s) => s.userId)])).toEqual(expect.arrayContaining([[a, [vera.id]], [b, [vera.id]]]));
  });

  it("l'anteprima dell'ingresso dice cosa guadagna Vera in ogni progetto", async () => {
    const { a, lea, vera } = await seed();
    const w = await created(lea, { name: "Anteprima", projectIds: [a] });
    const preview = (await call("POST", `/api/workspaces/${w.id}/members/${vera.id}/preview`, lea.headers, {})).json() as { projects: { projectId: string; gains: string[] }[]; escalation: unknown[] };
    expect(preview.escalation).toEqual([]);
    expect(preview.projects).toEqual([{ projectId: a, gains: expect.arrayContaining(["docs.view", "tickets.view_all"]) }]);
    expect(PROJECT_PERMISSIONS).toContain("tickets.view_all");
  });

});

describe("la card member.added (D13)", () => {
  it("chi entra in una workspace riceve UNA card che la nomina, coi progetti che vede; chi agisce no; un progetto aggiunto non manda card", async () => {
    const { notifications } = await import("@stubwise/db");
    const { a, b, lea, vera } = await seed();
    const w = await created(lea, { name: "Benvenuti", projectIds: [a] });
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    const cards = await db.select().from(notifications).where(and(eq(notifications.kind, "member.added"), eq(notifications.userId, vera.id)));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.event).toMatchObject({ kind: "member.added", workspaceId: w.id, workspaceName: "Benvenuti", addedUserId: vera.id });
    expect(await db.select().from(notifications).where(and(eq(notifications.kind, "member.added"), eq(notifications.userId, lea.id)))).toEqual([]);
    const inbox = (await call("GET", "/api/inbox", vera.headers)).json() as { items: { kind: string; memberAdded: { workspaceId: string | null; workspaceName: string | null; projectIds: string[] } | null }[] };
    expect(inbox.items.find((i) => i.kind === "member.added")?.memberAdded).toMatchObject({ workspaceId: w.id, workspaceName: "Benvenuti", projectIds: [a] });
    await call("PUT", `/api/workspaces/${w.id}/projects/${b}`, lea.headers);
    expect(await db.select().from(notifications).where(and(eq(notifications.kind, "member.added"), eq(notifications.userId, vera.id)))).toHaveLength(1);
  });
});

describe("D9: l'invito di registrazione promette una workspace", () => {
  let ip = 0;
  const register = (token: string) =>
    app.inject({ method: "POST", url: "/api/auth/register", payload: { token, password: "una-password-lunga-123", displayName: "Nuova" }, remoteAddress: `10.9.${Math.floor(++ip / 200)}.${ip % 200}` });
  async function inviter() {
    const s = await seed();
    await db.update(users).set({ instanceRoleId: (await db.insert(roles).values({ name: `Invita ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["users.view_all", "git_accounts.view", "mail_admission.view", "claude.public.view", "chat.general.create", "users.invite", "workspaces.manage"] }).returning())[0]!.id }).where(eq(users.id, s.lea.id));
    return s;
  }

  it("Lea invita un esterno nella workspace (Viewer di default): registrato, ne fa parte e vede A", async () => {
    const { a, lea } = await inviter();
    const w = await created(lea, { name: "Invitati", projectIds: [a] });
    const email = `ext-${randomUUID()}@x.test`;
    const inv = await call("POST", "/api/auth/invites", lea.headers, { email, workspaces: [{ workspaceId: w.id }] });
    expect(inv.statusCode, inv.body).toBe(201);
    const res = await register((inv.json() as { token: string }).token);
    expect(res.statusCode, res.body).toBe(201);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    const { visibleProjectIds } = await import("../auth/access.js");
    expect(await visibleProjectIds(db, { id: u!.id, instancePermissions: new Set() })).toContain(a);
    const rows = await db.select({ roleId: workspaceMembers.roleId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, w.id), eq(workspaceMembers.userId, u!.id)));
    expect(rows).toEqual([{ roleId: await presetRoleId(app, "viewer") }]);
  });

  it("revisione del lotto 4 (I-1): l'invito pendente mostra le workspace che promette, nella vista e nel registro", async () => {
    const { a, lea } = await inviter();
    const w = await created(lea, { name: "Promessa", projectIds: [a] });
    const email = `v-${randomUUID()}@x.test`;
    expect((await call("POST", "/api/auth/invites", lea.headers, { email, workspaces: [{ workspaceId: w.id }] })).statusCode).toBe(201);
    const views = (await call("GET", "/api/admin/invites", lea.headers)).json() as { email: string; workspaces: { workspaceId: string; name: string; roleName: string }[] }[];
    expect(views.find((v) => v.email === email)?.workspaces).toEqual([{ workspaceId: w.id, name: "Promessa", roleId: await presetRoleId(app, "viewer"), roleName: "Viewer" }]);
    const [entry] = await db.select({ data: changeLog.data }).from(changeLog).where(and(eq(changeLog.type, "invite.created"), sql`${changeLog.data}->'object'->>'label' = ${email}`));
    expect((entry!.data as { params: { workspaces: string[] } }).params.workspaces).toEqual(["Promessa · Viewer"]);
  });

  it("NEGATIVO all'invito: un ruolo che Lea non può dare (403 escalation), una workspace due volte (400): nessun invito", async () => {
    const { invites } = await import("@stubwise/db");
    const { a, lea } = await inviter();
    const w = await created(lea, { name: "No", projectIds: [a] });
    const [ops] = await db.insert(roles).values({ name: `Ops ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["servers.operate"] }).returning();
    const before = (await db.select().from(invites)).length;
    const esc = await call("POST", "/api/auth/invites", lea.headers, { email: `e-${randomUUID()}@x.test`, workspaces: [{ workspaceId: w.id, roleId: ops!.id }] });
    expect(esc.statusCode).toBe(403);
    expect(esc.json()).toMatchObject({ code: "escalation" });
    const dup = await call("POST", "/api/auth/invites", lea.headers, { email: `d-${randomUUID()}@x.test`, workspaces: [{ workspaceId: w.id }, { workspaceId: w.id }] });
    expect(dup.statusCode).toBe(400);
    expect((await db.select().from(invites)).length).toBe(before);
  });

  it("R51: se Lea non gestisce più i membri di A all'accettazione, la workspace si scarta e l'utente nasce lo stesso", async () => {
    const { a, lea } = await inviter();
    const w = await created(lea, { name: "Riverifica", projectIds: [a] });
    const inv = await call("POST", "/api/auth/invites", lea.headers, { email: `r-${randomUUID()}@x.test`, workspaces: [{ workspaceId: w.id }] });
    const { inviteWorkspaces } = await import("@stubwise/db");
    // La promessa è salvata (il `toEqual([])` sotto non passa per un invito vuoto).
    expect(await db.select().from(inviteWorkspaces).where(eq(inviteWorkspaces.workspaceId, w.id))).toHaveLength(1);
    await addMember(app, a, lea.id, "viewer");
    const res = await register((inv.json() as { token: string }).token);
    expect(res.statusCode, res.body).toBe(201);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.id))).toEqual([]);
  });
});

describe("revisione del lotto 3: i negativi che mancavano", () => {
  it("spostare D in un'altra workspace toglie a Vera l'unico gestore: 409 last_manager, D resta dov'era", async () => {
    const d = await project("Delta2");
    const vera = await person("Vera");
    const admin = { cookie: adminCookie };
    const from = (await call("POST", "/api/workspaces", admin, { name: "Da", projectIds: [d] })).json() as { id: string };
    await call("PUT", `/api/workspaces/${from.id}/members/${vera.id}`, admin, { roleId: await presetRoleId(app, "project_lead") });
    const to = (await call("POST", "/api/workspaces", admin, { name: "A" })).json() as { id: string };
    const res = await call("PUT", `/api/workspaces/${to.id}/projects/${d}`, admin);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_manager", projectId: d });
    expect((await db.select().from(workspaceProjects).where(eq(workspaceProjects.projectId, d))).map((r) => r.workspaceId)).toEqual([from.id]);
  });

  it("escalation mettendo un progetto in una workspace con persone: Lea non può dare il ruolo di Vera in B → 403, B fuori", async () => {
    const { a, b, lea, vera } = await seed();
    const [ops] = await db.insert(roles).values({ name: `Ops ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["docs.view", "servers.operate"] }).returning();
    const w = (await call("POST", "/api/workspaces", { cookie: adminCookie }, { name: "Ops", projectIds: [a] })).json() as { id: string };
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, { cookie: adminCookie }, { roleId: ops!.id });
    const res = await call("PUT", `/api/workspaces/${w.id}/projects/${b}`, lea.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", missing: ["servers.operate"], projectId: b });
    expect(await db.select().from(workspaceProjects).where(eq(workspaceProjects.projectId, b))).toEqual([]);
  });

  it("/effect: un progetto che non c'è o che non vedi → 404; chi non gestisce → 403; un PAT su PUT projects → session_required", async () => {
    const { a, lea, dino } = await seed();
    const w = await created(lea, { name: "Effetto2", projectIds: [a] });
    const hidden = await project("Nascosto");
    for (const projectId of [hidden, randomUUID()]) {
      const res = await call("POST", "/api/workspaces/effect", lea.headers, { kind: "addProject", workspaceId: w.id, projectId });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(hidden);
    }
    expect((await call("POST", "/api/workspaces/effect", dino.headers, { kind: "addProject", workspaceId: w.id, projectId: a })).statusCode).toBe(403);
    const pat = await createUserWithPat(app, `pat2-${randomUUID()}@x.test`);
    await db.update(users).set({ instanceRoleId: (await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin")))[0]!.id }).where(eq(users.id, pat.id));
    const viaPat = await call("PUT", `/api/workspaces/${w.id}/projects/${hidden}`, pat.headers);
    expect(viaPat.json()).toMatchObject({ code: "session_required" });
  });

  it("M3 (revisione d'insieme): l'anteprima di mettere o togliere un progetto vuole project.members.manage lì, come la scrittura", async () => {
    const { a, b, lea } = await seed();
    // Lea ha workspaces.manage, ma in C è solo Developer: vede C, non ne gestisce i membri.
    const c = await project("Gamma");
    await addMember(app, c, lea.id, "developer");
    const w = await created(lea, { name: "M3", projectIds: [a] });
    const preview = await call("POST", "/api/workspaces/effect", lea.headers, { kind: "addProject", workspaceId: w.id, projectId: c });
    expect([preview.statusCode, preview.json().code]).toEqual([403, "forbidden"]);
    const write = await call("PUT", `/api/workspaces/${w.id}/projects/${c}`, lea.headers);
    expect(write.statusCode).toBe(403);
    // Togliere: C dentro (dall'admin), Lea non lo toglie e non ne vede l'effetto.
    await call("PUT", `/api/workspaces/${w.id}/projects/${c}`, { cookie: adminCookie });
    const removePreview = await call("POST", "/api/workspaces/effect", lea.headers, { kind: "removeProject", workspaceId: w.id, projectId: c });
    expect([removePreview.statusCode, removePreview.json().code]).toEqual([403, "forbidden"]);
    // Dove li gestisce, l'anteprima risponde.
    expect((await call("POST", "/api/workspaces/effect", lea.headers, { kind: "addProject", workspaceId: w.id, projectId: b })).statusCode).toBe(200);
  });

  it("M-2: l'anteprima con il ruolo di adesso non dice escalation (la scrittura non farebbe niente)", async () => {
    const { a, lea, vera } = await seed();
    const [ops] = await db.insert(roles).values({ name: `Ops ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["docs.view", "servers.operate"] }).returning();
    const w = (await call("POST", "/api/workspaces", { cookie: adminCookie }, { name: "Stesso", projectIds: [a] })).json() as { id: string };
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, { cookie: adminCookie }, { roleId: ops!.id });
    const preview = (await call("POST", `/api/workspaces/${w.id}/members/${vera.id}/preview`, lea.headers, { roleId: ops!.id })).json() as { escalation: unknown[] };
    expect(preview.escalation).toEqual([]);
    expect((await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, { roleId: ops!.id })).statusCode).toBe(200);
  });
});

describe("D4 (maintainer, via 46): le persone vogliono ANCHE workspaces.manage", () => {
  it("Project Lead di tutti i progetti della workspace ma senza workspaces.manage: 403 su mettere, togliere e sull'anteprima; il DB resta com'è", async () => {
    const { a, b, lea, vera } = await seed();
    const w = await created(lea, { name: "Solo gestori", projectIds: [a, b] });
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    const pl = await person("Paolo", ["users.view_all"]);
    await addMember(app, a, pl.id, "project_lead");
    await addMember(app, b, pl.id, "project_lead");
    const olga = await person("Olga2");
    const before = await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.id));
    for (const res of [
      await call("PUT", `/api/workspaces/${w.id}/members/${olga.id}`, pl.headers, {}),
      await call("DELETE", `/api/workspaces/${w.id}/members/${vera.id}`, pl.headers),
      await call("POST", `/api/workspaces/${w.id}/members/${olga.id}/preview`, pl.headers, {}),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: "forbidden" });
    }
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.id))).toEqual(before);
    expect((await call("GET", `/api/workspaces/${w.id}`, pl.headers)).json()).toMatchObject({ canManagePeople: false });
  });
});

describe("lotto 5 (i limiti della build app)", () => {
  it("l'effetto di una workspace NUOVA coi progetti: chi smette di vedere B spostandolo, e nessuna scrittura", async () => {
    const { a, b, lea, vera } = await seed();
    const old = await created(lea, { name: "Vecchia", projectIds: [b] });
    await call("PUT", `/api/workspaces/${old.id}/members/${vera.id}`, lea.headers, {});
    const before = await count(workspaces);
    const res = await call("POST", "/api/workspaces/effect", lea.headers, { kind: "create", projectIds: [a, b] });
    expect(res.statusCode, res.body).toBe(200);
    const effect = res.json() as { projects: { projectId: string; startSeeing: unknown[]; stopSeeing: { userId: string }[] }[] };
    expect(effect.projects.find((p) => p.projectId === b)?.stopSeeing.map((s) => s.userId)).toEqual([vera.id]);
    expect(effect.projects.find((p) => p.projectId === a)).toMatchObject({ startSeeing: [], stopSeeing: [] });
    expect(await count(workspaces)).toBe(before);
    expect((await db.select().from(workspaceProjects).where(eq(workspaceProjects.projectId, b))).map((r) => r.workspaceId)).toEqual([old.id]);
  });

  it("le persone della vista portano email e stato", async () => {
    const { a, lea, vera } = await seed();
    const w = await created(lea, { name: "Persone", projectIds: [a] });
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, vera.id));
    const view = (await call("GET", `/api/workspaces/${w.id}`, lea.headers)).json() as { people: { userId: string; email: string; status: string }[] };
    expect(view.people.find((p) => p.userId === vera.id)).toMatchObject({ email: row!.email, status: "active" });
  });

  it("i candidati: le persone attive che chi gestisce vede, fuori dai membri e da Claude, con ciò che non può dare", async () => {
    const { a, lea, vera, olga, dino } = await seed();
    const w = await created(lea, { name: "Candidati", projectIds: [a] });
    await call("PUT", `/api/workspaces/${w.id}/members/${vera.id}`, lea.headers, {});
    const res = await call("GET", `/api/workspaces/${w.id}/candidates`, lea.headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { candidates: { userId: string; missing: string[] }[]; roles: { roleId: string; missing: string[] }[]; defaultRoleId: string | null };
    const ids = body.candidates.map((c) => c.userId);
    expect(ids).toContain(olga.id);
    expect(ids).not.toContain(vera.id);
    const [claude] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    expect(ids).not.toContain(claude!.id);
    expect(body.defaultRoleId).toBe(await presetRoleId(app, "viewer"));
    // Il Viewer Lea lo può dare; un ruolo con servers.operate no.
    expect(body.roles.find((r) => r.roleId === body.defaultRoleId)?.missing).toEqual([]);
    // Senza users.view_all: solo le persone che vede (Olga non condivide progetti con lei).
    await db.update(roles).set({ permissions: ["workspaces.manage"] }).where(eq(roles.id, (await db.select({ r: users.instanceRoleId }).from(users).where(eq(users.id, lea.id)))[0]!.r!));
    const narrow = (await call("GET", `/api/workspaces/${w.id}/candidates`, lea.headers)).json() as { candidates: { userId: string }[] };
    expect(narrow.candidates.map((c) => c.userId)).not.toContain(olga.id);
    // Chi la vede (Developer di A) ma non ne gestisce le persone: 403.
    expect((await call("GET", `/api/workspaces/${w.id}/candidates`, dino.headers)).statusCode).toBe(403);
  });
});
