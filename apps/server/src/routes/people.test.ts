import { randomBytes } from "node:crypto";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { personViewSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let colleague: { id: string; headers: { cookie: string } };
let stranger: { id: string; headers: { cookie: string } };

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  colleague = await createUserWithSession(app, "giulia.rossi@example.com");
  stranger = await createUserWithSession(app, "estraneo@example.com");
  const shared = (await seedRepository(testDb.db)).projectId;
  const other = (await seedRepository(testDb.db)).projectId;
  await addMember(app, shared, users.memberId);
  await addMember(app, shared, colleague.id);
  await addMember(app, other, stranger.id);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const list = async (cookie: string) => {
  const res = await app.inject({ method: "GET", url: "/api/people", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return personViewSchema.array().parse(res.json());
};

describe("GET /api/people", () => {
  it("vede sé stesso e chi condivide un progetto, nella forma condivisa", async () => {
    const people = await list(users.memberCookie);
    // L'utente di sistema «Claude» (area 3, fetta 3e) c'è sempre: si conta a parte.
    expect(people.filter((p) => p.isClaude)).toHaveLength(1);
    const ids = people.filter((p) => !p.isClaude).map((p) => p.id).sort();
    // Il full admin c'è: è membro implicito di ogni progetto.
    expect(ids).toEqual([users.memberId, colleague.id, users.adminId].sort());
    const giulia = people.find((p) => p.id === colleague.id)!;
    expect(giulia).toMatchObject({ name: "giulia.rossi", initials: "GR", email: "giulia.rossi@example.com" });
    expect(giulia.departmentIds).toHaveLength(1);
  });

  it("un Developer vede il full admin fra le persone (membro implicito di ogni progetto)", async () => {
    const dev = await createUserWithSession(app, "developer@example.com");
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, dev.id, "developer");
    const ids = (await list(dev.headers.cookie)).map((p) => p.id);
    expect(ids).toContain(users.adminId);
    expect(ids).toContain(dev.id);
  });

  it("non vede chi non condivide un progetto", async () => {
    const people = await list(users.memberCookie);
    expect(people.map((p) => p.id)).not.toContain(stranger.id);
    expect(
      (await list(stranger.headers.cookie))
        .filter((p) => !p.isClaude)
        .map((p) => p.id)
        .sort(),
    ).toEqual([stranger.id, users.adminId].sort());
  });

  it("un full admin vede tutti", async () => {
    const ids = (await list(users.adminCookie)).map((p) => p.id);
    for (const id of [users.adminId, users.memberId, colleague.id, stranger.id]) expect(ids).toContain(id);
  });

  it("il nome visualizzato vince sull'email", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie: colleague.headers.cookie },
      payload: { displayName: "Giulia Rossi" },
    });
    expect(res.statusCode).toBe(200);
    const giulia = (await list(users.memberCookie)).find((p) => p.id === colleague.id)!;
    expect(giulia).toMatchObject({ name: "Giulia Rossi", initials: "GR" });
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: colleague.headers.cookie } });
    expect((me.json() as { user: { displayName: string } }).user.displayName).toBe("Giulia Rossi");
  });

  it("un nome visualizzato con a-capo o caratteri bidi è rifiutato", async () => {
    for (const displayName of ["Giulia\nRossi", "Giulia\u202eRossi"]) {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/auth/me",
        headers: { cookie: colleague.headers.cookie },
        payload: { displayName },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("PATCH /me con la sola lingua resta valido (client vecchi)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie: colleague.headers.cookie },
      payload: { language: "it" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ language: "it" });
  });
});
