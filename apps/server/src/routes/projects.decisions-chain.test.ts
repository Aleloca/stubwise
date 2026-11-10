import { randomBytes } from "node:crypto";
import { projectDecisions } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { projectDecisionSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Il «superata da» del registro decisioni (integrazione area 2, fetta 4):
 * una decisione nuova può dire quale supera (`supersedesId`, nella stessa
 * transazione), e una catena non diventa mai un giro (400 `decision_cycle`,
 * `wouldCycle` di `@stubwise/shared`).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let otherProjectId: string;
let developer: { id: string; headers: { cookie: string } };

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  ({ projectId: otherProjectId } = await seedRepository(testDb.db));
  developer = await createUserWithSession(app, "dev-decisioni@example.com");
  await addMember(app, projectId, developer.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const record = (pid: string, payload: object, cookie = users.adminCookie) =>
  app.inject({ method: "POST", url: `/api/projects/${pid}/decisions`, headers: { cookie }, payload });

async function decision(pid: string, title: string, extra: object = {}): Promise<string> {
  const res = await record(pid, { title, decision: `Decidiamo ${title}`, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return projectDecisionSchema.parse(res.json()).id;
}

const supersededByOf = async (id: string) =>
  (await testDb.db.select({ by: projectDecisions.supersededById }).from(projectDecisions).where(eq(projectDecisions.id, id)))[0]!
    .by;

describe("registro decisioni: «superata da»", () => {
  it("una decisione nuova con supersedesId segna la vecchia come superata da lei", async () => {
    const old = await decision(projectId, "Vecchia");
    const fresh = await decision(projectId, "Nuova", { supersedesId: old });
    expect(await supersededByOf(old)).toBe(fresh);
    expect(await supersededByOf(fresh)).toBeNull();
  });

  it("supersedesId di un altro progetto o inesistente → 400 invalid_supersede, e niente registrato", async () => {
    const elsewhere = await decision(otherProjectId, "Altrove");
    const before = (await testDb.db.select({ id: projectDecisions.id }).from(projectDecisions)).length;
    const res = await record(projectId, { title: "Sbagliata", decision: "x", supersedesId: elsewhere });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_supersede" });
    expect((await testDb.db.select({ id: projectDecisions.id }).from(projectDecisions)).length).toBe(before);
    expect(await supersededByOf(elsewhere)).toBeNull();
  });

  it("superare la decisione di un altro senza poterla modificare → 403, e niente registrato", async () => {
    const theirs = await decision(projectId, "Dell'admin");
    const before = (await testDb.db.select({ id: projectDecisions.id }).from(projectDecisions)).length;
    const res = await record(projectId, { title: "La supero io", decision: "x", supersedesId: theirs }, developer.headers.cookie);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: "decision_forbidden" });
    expect((await testDb.db.select({ id: projectDecisions.id }).from(projectDecisions)).length).toBe(before);
    expect(await supersededByOf(theirs)).toBeNull();
    // La propria sì.
    const mine = projectDecisionSchema.parse(
      (await record(projectId, { title: "Mia", decision: "x" }, developer.headers.cookie)).json(),
    ).id;
    expect((await record(projectId, { title: "Mia, nuova", decision: "y", supersedesId: mine }, developer.headers.cookie)).statusCode).toBe(201);
  });

  it("superare una voce già superata → 409 already_superseded, e il legame resta", async () => {
    const old = await decision(projectId, "Vecchia due");
    const first = await decision(projectId, "Prima", { supersedesId: old });
    const before = (await testDb.db.select({ id: projectDecisions.id }).from(projectDecisions)).length;
    const res = await record(projectId, { title: "Seconda", decision: "x", supersedesId: old });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "already_superseded" });
    expect(await supersededByOf(old)).toBe(first);
    expect((await testDb.db.select({ id: projectDecisions.id }).from(projectDecisions)).length).toBe(before);
  });

  it("due «superata da» incrociati in parallelo (A da B, B da A): mai un giro, uno dei due 400", async () => {
    for (let round = 0; round < 8; round += 1) {
      const a = await decision(projectId, `Giro A${round}`);
      const b = await decision(projectId, `Giro B${round}`);
      const patch = (id: string, by: string) =>
        app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/decisions/${id}`,
          headers: { cookie: users.adminCookie },
          payload: { supersededById: by },
        });
      const [ab, ba] = await Promise.all([patch(a, b), patch(b, a)]);
      expect([ab.statusCode, ba.statusCode].sort()).toEqual([200, 400]);
      expect([await supersededByOf(a), await supersededByOf(b)].filter((x) => x !== null)).toHaveLength(1);
    }
  });

  it("un «superata da» che chiuderebbe un giro → 400 decision_cycle, e il legame non cambia", async () => {
    const a = await decision(projectId, "A");
    const b = await decision(projectId, "B", { supersedesId: a });
    const c = await decision(projectId, "C", { supersedesId: b });
    // a → b → c: segnare c come superata da a chiuderebbe il giro.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/decisions/${c}`,
      headers: { cookie: users.adminCookie },
      payload: { supersededById: a },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "decision_cycle" });
    expect(await supersededByOf(c)).toBeNull();
  });
});
