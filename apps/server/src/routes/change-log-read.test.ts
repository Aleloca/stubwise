import { randomUUID } from "node:crypto";
import { changeLog, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ChangeEntry, ChangeLogFilters, ChangeLogPage } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { recordChange } from "../services/change-log.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F2, Task 8: la lettura del registro, filtrata nella WHERE prima
 * della paginazione. Il test d'ACCORDO: per un seme con voci d'istanza e di
 * due progetti e cinque persone, ogni voce letta ⇔ la regola scritta qui.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let admin: { id: string; email: string };

let projectA: string;
let projectB: string;
const cast: Record<"rolesMgr" | "leadA" | "devA" | "viewerAll" | "outsider", { id: string; email: string; cookie: string }> = {} as never;

async function person(prefix: string, instancePermissions?: string[]) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@acme.com`;
  const [u] = await db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  if (instancePermissions) {
    const [r] = await db.insert(roles).values({ name: `I ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: instancePermissions }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: r!.id }).where(eq(users.id, u!.id));
  }
  return { id: u!.id, email, cookie: await fullSessionCookie(app, u!.id) };
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 11).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  const [a] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, "admin@example.com"));
  admin = a!;
  ({ projectId: projectA } = await seedRepository(db));
  ({ projectId: projectB } = await seedRepository(db));
  cast.rolesMgr = await person("roles", ["roles.manage"]);
  cast.leadA = await person("leadA");
  await addMember(app, projectA, cast.leadA.id, "project_lead");
  cast.devA = await person("devA");
  await addMember(app, projectA, cast.devA.id, "developer");
  cast.viewerAll = await person("viewall", ["changelog.view", "users.view_all"]);
  cast.outsider = await person("outsider");
  await addMember(app, projectB, cast.outsider.id, "project_lead");
  // Il seme: voci d'istanza di più tipi e voci di progetto in A e in B.
  await db.transaction(async (tx) => {
    const role = { type: "role", id: randomUUID(), label: "R" };
    await recordChange(tx, { type: "role.created", actor: admin, projectId: null, data: { object: role } });
    await recordChange(tx, { type: "person.deactivated", actor: admin, projectId: null, data: { object: { type: "person", id: cast.devA.id, label: cast.devA.email } } });
    await recordChange(tx, { type: "person.deactivated", actor: admin, projectId: null, data: { object: { type: "person", id: cast.outsider.id, label: cast.outsider.email } } });
    await recordChange(tx, { type: "member.added", actor: admin, projectId: projectA, data: { object: { type: "member", id: cast.devA.id, label: cast.devA.email } } });
    await recordChange(tx, { type: "member.added", actor: admin, projectId: projectB, data: { object: { type: "member", id: cast.outsider.id, label: cast.outsider.email } } });
  });
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const read = async (cookie: string, query = "") => {
  const res = await app.inject({ method: "GET", url: `/api/change-log${query}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as ChangeLogPage;
};

/** La regola, riscritta qui a mano: chi legge quale voce del seme. */
function expected(who: keyof typeof cast | "admin", e: ChangeEntry): boolean {
  if (who === "admin") return true;
  // changelog.view ma nessun progetto: le voci d'istanza, tranne quelle su
  // persone che non vede (R-G5: devA e l'outsider non condividono nulla con lui).
  if (who === "viewerAll") return e.projectId === null && !(e.type.startsWith("person.") && [cast.devA.id, cast.outsider.id].includes(e.data.object.id));
  if (who === "rolesMgr") return e.type === "role.created";
  if (who === "leadA") return e.projectId === projectA; // gestisce A
  if (who === "devA") return false; // né changelog.view né la gestione
  if (who === "outsider") return e.projectId === projectB;
  return false;
}

describe("leggere il registro", () => {
  it("ACCORDO: ogni voce del seme si legge ⇔ la regola", async () => {
    const all = (await read(adminCookie, "?withinDays=1")).entries;
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const who of ["rolesMgr", "leadA", "devA", "viewerAll", "outsider"] as const) {
      const seen = new Set((await read(cast[who].cookie, "?withinDays=1")).entries.map((e) => e.id));
      for (const e of all) expect(seen.has(e.id), `${who} / ${e.type} / ${e.projectId}`).toBe(expected(who, e));
    }
  });

  it("NEGATIVI: un progetto invisibile → 404, senza gestione → 403; una persona invisibile non c'è (anche con changelog.view)", async () => {
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectB}/change-log`, headers: { cookie: cast.leadA.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectA}/change-log`, headers: { cookie: cast.devA.cookie } })).statusCode).toBe(403);
    const lead = (await app.inject({ method: "GET", url: `/api/projects/${projectA}/change-log`, headers: { cookie: cast.leadA.cookie } })).json() as ChangeLogPage;
    expect(lead.entries.every((e) => e.projectId === projectA)).toBe(true);
    // Chi ha changelog.view ma non vede l'outsider (nessun progetto in comune, niente users.manage).
    const viewerSees = (await read(cast.viewerAll.cookie, "?withinDays=1")).entries;
    expect(viewerSees.some((e) => e.data.object.id === cast.outsider.id)).toBe(false);
  });

  it("le persone invisibili escono dai `params` di un reparto, id e nomi insieme", async () => {
    const dept = { type: "department", id: randomUUID(), label: "Ops" };
    await db.transaction((tx) =>
      recordChange(tx, { type: "department.members_changed", actor: admin, projectId: null, data: { object: dept, params: { added: [cast.leadA.id, cast.outsider.id], removed: [], addedNames: [cast.leadA.email, cast.outsider.email], removedNames: [] } } }),
    );
    const [mgr] = await db.insert(roles).values({ name: `Dep ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["departments.manage"] }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: mgr!.id }).where(eq(users.id, cast.devA.id));
    const cookie = await fullSessionCookie(app, cast.devA.id);
    const e = (await read(cookie, "?type=department.members_changed")).entries.find((x) => x.data.object.id === dept.id)!;
    expect(e.data.params).toMatchObject({ added: [cast.leadA.id], addedNames: [cast.leadA.email] });
  });

  it("la paginazione: 50 per pagina, il cursore continua senza buchi né doppioni, e il filtro sta prima", async () => {
    await db.transaction(async (tx) => {
      for (let i = 0; i < 60; i++) {
        await recordChange(tx, { type: "role.updated", actor: admin, projectId: null, data: { object: { type: "role", id: randomUUID(), label: `R${i}` } } });
      }
    });
    const first = await read(cast.rolesMgr.cookie, "?type=role.updated");
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await read(cast.rolesMgr.cookie, `?type=role.updated&cursor=${first.nextCursor}`);
    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(60);
    // Chi non legge i ruoli non riceve pagine corte: nessuna voce, nessun cursore.
    expect(await read(cast.devA.cookie, "?type=role.updated")).toEqual({ entries: [], nextCursor: null });
  });

  it("le scelte dei filtri: everything, i gruppi che si leggono, solo i progetti visibili", async () => {
    const f = (await app.inject({ method: "GET", url: "/api/change-log/filters", headers: { cookie: cast.leadA.cookie } })).json() as ChangeLogFilters;
    expect(f.everything).toBe(false);
    // Il Project Lead gestisce membri, coda (F4), impostazioni e repository (F5): non ambienti né widget.
    expect(f.groups).toEqual(["members", "queue", "project", "repositories"]);
    expect(f.projects.map((p) => p.projectId)).toEqual([projectA]);
    const v = (await app.inject({ method: "GET", url: "/api/change-log/filters", headers: { cookie: cast.viewerAll.cookie } })).json() as ChangeLogFilters;
    expect(v.everything).toBe(true);
  });

  it("il trigger: un UPDATE e un DELETE diretti falliscono", async () => {
    const [row] = await db.select({ id: changeLog.id }).from(changeLog).limit(1);
    await expect(db.execute(sql`update change_log set data = '{}' where id = ${row!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from change_log where id = ${row!.id}`)).rejects.toThrow();
  });

  it("review I1: i permessi di un ruolo restano nei `params` anche per chi non ha users.manage", async () => {
    const role = { type: "role", id: randomUUID(), label: "Rel" };
    await db.transaction((tx) => recordChange(tx, { type: "role.updated", actor: admin, projectId: null, data: { object: role, before: "Rel", after: "Rel", params: { added: ["release.merge"], removed: ["tickets.view_all"] } } }));
    const e = (await read(cast.rolesMgr.cookie, "?type=role.updated&withinDays=1")).entries.find((x) => x.data.object.id === role.id)!;
    expect(e.data.params).toMatchObject({ added: ["release.merge"], removed: ["tickets.view_all"] });
  });

  it("review I2: chi gestisce il progetto legge le voci di chi ne è USCITO", async () => {
    const { projectId } = await seedRepository(db);
    const lead = await person("lead2");
    await addMember(app, projectId, lead.id, "project_lead");
    const gone = await person("gone");
    await addMember(app, projectId, gone.id, "developer");
    const res = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/members/${gone.id}`, headers: { cookie: lead.cookie } });
    expect(res.statusCode).toBe(204);
    const page = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/change-log`, headers: { cookie: lead.cookie } })).json() as ChangeLogPage;
    expect(page.entries.some((e) => e.type === "member.removed" && e.data.object.id === gone.id)).toBe(true);
  });

  it("review I4 (decisione b), superata dal registro A11 r.1414: l'attore si mostra per nome a chi lo CONOSCE (qui un ex membro di un progetto che chi guarda vede), non a chi non lo conosce", async () => {
    const [r] = await db.insert(roles).values({ name: `Att ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["roles.manage"] }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: r!.id, displayName: "Fuori Vista" }).where(eq(users.id, cast.outsider.id));
    const role = { type: "role", id: randomUUID(), label: "Da fuori" };
    await db.transaction((tx) => recordChange(tx, { type: "role.created", actor: { id: cast.outsider.id, email: cast.outsider.email }, projectId: null, data: { object: role } }));
    const e = (await read(cast.rolesMgr.cookie, "?type=role.created&withinDays=1")).entries.find((x) => x.data.object.id === role.id)!;
    // `rolesMgr` non ha progetti né canali in comune con `outsider`: niente id, niente nome.
    expect(e.actor).toMatchObject({ id: expect.stringMatching(/^hidden-\d+$/), name: null, kind: "user" });
    // Chi lo conosce (il full admin) lo legge per nome.
    const seen = (await read(adminCookie, "?type=role.created&withinDays=1")).entries.find((x) => x.data.object.id === role.id)!;
    expect(seen.actor).toMatchObject({ id: cast.outsider.id, name: "Fuori Vista", kind: "user" });
  });
});

describe("registro, A11 r.1414: chi non si conosce non ha né id né nome", () => {
  it("l'attore sconosciuto (nessun progetto in comune, nessun canale leggibile) esce come `hidden-<n>` senza nome; chi si conosce no", async () => {
    const reader = await person("reader", ["changelog.view"]);
    await addMember(app, projectA, reader.id, "viewer");
    const stranger = await person("stranger", ["roles.manage"]);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) await recordChange(tx, { type: "role.created", actor: stranger, projectId: null, data: { object: { type: "role", id: randomUUID(), label: `Da sconosciuto ${i}` } } });
      await recordChange(tx, { type: "role.created", actor: cast.leadA, projectId: null, data: { object: { type: "role", id: randomUUID(), label: "Da Lead A" } } });
    });
    const res = await app.inject({ method: "GET", url: "/api/change-log?type=role.created", headers: { cookie: reader.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as ChangeLogPage;
    const byLabel = (label: string) => page.entries.find((e) => JSON.stringify(e.data).includes(label))!;
    expect(byLabel("Da sconosciuto 0").actor).toEqual({ id: "hidden-1", name: null, kind: "user" });
    // Lo stesso segnaposto per la stessa persona, in tutta la risposta.
    expect(byLabel("Da sconosciuto 1").actor.id).toBe("hidden-1");
    expect(byLabel("Da Lead A").actor).toMatchObject({ id: cast.leadA.id, name: expect.any(String) });
    expect(res.body).not.toContain(stranger.id);
    expect(res.body).not.toContain(stranger.email.split("@")[0]!);
    // Chi ha tutti i progetti (full admin) conosce tutti.
    const all = (await read(adminCookie, "?type=role.created")).entries;
    expect(all.some((e) => e.actor.id === stranger.id)).toBe(true);
  });

  it("un ex membro di un progetto visibile resta conosciuto; chi scrive in un canale che chi guarda legge anche", async () => {
    const reader = await person("reader2", ["changelog.view"]);
    await addMember(app, projectA, reader.id, "viewer");
    const former = await person("former", ["roles.manage"]);
    const writer = await person("writer", ["roles.manage"]);
    await db.transaction(async (tx) => {
      await recordChange(tx, { type: "member.removed", actor: admin, projectId: projectA, data: { object: { type: "member", id: former.id, label: former.email } } });
      await recordChange(tx, { type: "role.created", actor: former, projectId: null, data: { object: { type: "role", id: randomUUID(), label: "Da ex membro" } } });
      await recordChange(tx, { type: "role.created", actor: writer, projectId: null, data: { object: { type: "role", id: randomUUID(), label: "Da chi scrive" } } });
    });
    const { chatChannels, chatMessages } = await import("@stubwise/db");
    const [ch] = await db.insert(chatChannels).values({ kind: "general", visibility: "open", name: `tutti-${randomUUID().slice(0, 6)}` } as never).returning({ id: chatChannels.id });
    await db.insert(chatMessages).values({ channelId: ch!.id, authorId: writer.id, kind: "person", body: "ciao a tutti", searchFolded: "ciao a tutti" } as never);
    const entries = (await read(reader.cookie, "?type=role.created")).entries;
    const byLabel = (label: string) => entries.find((e) => JSON.stringify(e.data).includes(label))!;
    expect(byLabel("Da ex membro").actor.id).toBe(former.id);
    expect(byLabel("Da chi scrive").actor.id).toBe(writer.id);
  });

  it("un progetto ARCHIVIATO di chi guarda conta come visibile: chi ne è membro resta conosciuto", async () => {
    const { projectId: archivedP } = await seedRepository(db);
    const reader = await person("reader3", ["changelog.view"]);
    await addMember(app, archivedP, reader.id, "viewer");
    const mate = await person("mate", ["roles.manage"]);
    await addMember(app, archivedP, mate.id, "developer");
    const { projects } = await import("@stubwise/db");
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archivedP));
    await db.transaction((tx) => recordChange(tx, { type: "role.created", actor: mate, projectId: null, data: { object: { type: "role", id: randomUUID(), label: "Da compagno di un archiviato" } } }));
    const entries = (await read(reader.cookie, "?type=role.created")).entries;
    expect(entries.find((e) => JSON.stringify(e.data).includes("Da compagno di un archiviato"))!.actor.id).toBe(mate.id);
  });
});

describe("le righe VECCHIE si leggono mascherate (revisione finale della parità MCP, I1)", () => {
  it("una voce webhook.updated scritta «alla vecchia», con l'URL in chiaro, esce con host e ultime 4 cifre; le credenziali in un URL escono user:***@", async () => {
    const hookId = randomUUID();
    const repoId = randomUUID();
    // Inserite direttamente: com'erano scritte dal codice di main, prima della maschera alla scrittura.
    await db.insert(changeLog).values([
      {
        actorUserId: admin.id,
        actorEmail: admin.email,
        actorKind: "user",
        type: "webhook.updated",
        projectId: null,
        subjectKind: "webhook",
        subjectId: hookId,
        data: {
          object: { type: "webhook", id: hookId, label: "Slack" },
          before: JSON.stringify({ url: "https://hooks.example.com/T000/B000/vecchioABCD" }),
          after: JSON.stringify({ url: "https://hooks.example.com/T000/B111/nuovoWXYZ", name: "Slack 2" }),
          params: {},
        },
      },
      {
        actorUserId: admin.id,
        actorEmail: admin.email,
        actorKind: "user",
        type: "repository.updated",
        projectId: projectA,
        subjectKind: "repository",
        subjectId: repoId,
        data: {
          object: { type: "repository", id: repoId, label: "r" },
          before: JSON.stringify({ url: "https://bob:s3cr3t@git.example.com/r.git" }),
          after: JSON.stringify({ url: "https://git.example.com/r.git" }),
          params: { field: "url" },
        },
      },
    ]);
    const page = await read(adminCookie, "?withinDays=1");
    const hook = page.entries.find((e) => e.data.object.id === hookId)!;
    expect(JSON.parse(hook.data.before!)).toEqual({ url: "hooks.example.com …ABCD" });
    expect(JSON.parse(hook.data.after!)).toEqual({ url: "hooks.example.com …WXYZ", name: "Slack 2" });
    const repo = page.entries.find((e) => e.data.object.id === repoId)!;
    expect(JSON.parse(repo.data.before!)).toEqual({ url: "https://bob:***@git.example.com/r.git" });
    expect(JSON.stringify(page)).not.toContain("vecchioABCD");
    expect(JSON.stringify(page)).not.toContain("B111");
    expect(JSON.stringify(page)).not.toContain("s3cr3t");
    // Anche dal registro di progetto.
    const proj = (await app.inject({ method: "GET", url: `/api/projects/${projectA}/change-log`, headers: { cookie: adminCookie } })).body;
    expect(proj).not.toContain("s3cr3t");
  });

  it("una voce nuova, già mascherata alla scrittura, non si maschera due volte", async () => {
    const hookId = randomUUID();
    await recordChange(db, {
      type: "webhook.updated",
      actor: admin,
      projectId: null,
      data: { object: { type: "webhook", id: hookId, label: "W" }, before: JSON.stringify({ url: "hooks.example.com …ABCD" }), after: JSON.stringify({ url: "hooks.example.com …WXYZ (cambiato)" }) },
    });
    const hook = (await read(adminCookie, "?withinDays=1")).entries.find((e) => e.data.object.id === hookId)!;
    expect(JSON.parse(hook.data.after!)).toEqual({ url: "hooks.example.com …WXYZ (cambiato)" });
  });
});
