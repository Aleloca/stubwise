import { randomBytes } from "node:crypto";
import { projectMembers, projectStatuses, projects } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { projectSchema, TEMPLATE_STATUSES } from "@stubwise/shared";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Modelli, moduli, cliente e codice di un progetto nuovo (integrazione area
 * 2, fetta 4): `POST /api/projects` crea gli stati del MODELLO nella stessa
 * transazione (non quelli di default), accende i moduli del modello (o quelli
 * scelti), e un codice già usato è un 409 senza niente di creato.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const create = (payload: object) =>
  app.inject({ method: "POST", url: "/api/projects", headers: { cookie: users.adminCookie }, payload });

async function statusesOf(projectId: string) {
  return testDb.db
    .select({ name: projectStatuses.name, family: projectStatuses.family, legacy: projectStatuses.legacyStatus })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(asc(projectStatuses.position));
}

describe("POST /api/projects: modello, moduli, cliente, codice", () => {
  it("marketing con un cliente: gli stati del modello, nessun modulo, commessa", async () => {
    const res = await create({ name: "Lancio primavera", code: "LPR", template: "marketing", clientName: "Mix Cucine" });
    expect(res.statusCode, res.body).toBe(201);
    const p = projectSchema.parse(res.json());
    expect(p).toMatchObject({ code: "LPR", template: "marketing", modules: [], clientName: "Mix Cucine", kind: "client" });
    expect(await statusesOf(p.id)).toEqual([
      { name: "Idea", family: "todo", legacy: "open" },
      { name: "Draft", family: "active", legacy: "in_progress" },
      { name: "In approval", family: "active", legacy: "in_review" },
      { name: "Published", family: "closed", legacy: "done" },
      { name: "Dropped", family: "closed", legacy: "closed" },
    ]);
  });

  it("senza modello: software, i quattro moduli, interno; i moduli scelti vincono su quelli del modello", async () => {
    const res = await create({ name: "Vecchio stile" });
    expect(res.statusCode, res.body).toBe(201);
    const p = projectSchema.parse(res.json());
    expect(p).toMatchObject({
      template: "software",
      modules: ["docs", "releases", "support", "servers"],
      clientName: null,
      kind: "internal",
    });
    // Senza modello esplicito (un client di prima) gli stati restano quelli di default del trigger.
    expect((await statusesOf(p.id)).map((s) => s.name)).toEqual(["To do", "In progress", "In review", "Done", "Discarded"]);
    // Col modello software esplicito, quelli del modello.
    const sw = projectSchema.parse((await create({ name: "Software esplicito", template: "software" })).json());
    expect((await statusesOf(sw.id)).map((s) => s.name)).toEqual(TEMPLATE_STATUSES.software.map((s) => s.name));
    // Il codice senza `code` lo dà il trigger, come prima.
    expect(p.code).toMatch(/^[A-Z][A-Z0-9]{1,5}$/);
    const chosen = projectSchema.parse(
      (await create({ name: "Scelti", template: "empty", modules: ["servers", "docs", "docs"] })).json(),
    );
    // In ordine, una volta sola.
    expect(chosen.modules).toEqual(["docs", "servers"]);
    expect((await statusesOf(chosen.id)).map((s) => s.name)).toEqual(["To do", "In progress", "Done"]);
  });

  it("un codice già usato → 409, e niente di creato (né progetto, né stati, né membri)", async () => {
    expect((await create({ name: "Primo", code: "DUP" })).statusCode).toBe(201);
    const before = {
      projects: (await testDb.db.select({ id: projects.id }).from(projects)).length,
      statuses: (await testDb.db.select({ id: projectStatuses.id }).from(projectStatuses)).length,
      members: (await testDb.db.select({ id: projectMembers.projectId }).from(projectMembers)).length,
    };
    const res = await create({ name: "Secondo", code: "DUP", template: "client" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("code_taken");
    expect({
      projects: (await testDb.db.select({ id: projects.id }).from(projects)).length,
      statuses: (await testDb.db.select({ id: projectStatuses.id }).from(projectStatuses)).length,
      members: (await testDb.db.select({ id: projectMembers.projectId }).from(projectMembers)).length,
    }).toEqual(before);
  });

  it("validazione: codice, modello e moduli sconosciuti → 400", async () => {
    expect((await create({ name: "X", code: "ab" })).statusCode).toBe(400);
    expect((await create({ name: "X", template: "boh" })).statusCode).toBe(400);
    expect((await create({ name: "X", modules: ["chat"] })).statusCode).toBe(400);
  });
});

describe("PATCH /api/projects/:id: cliente e moduli", () => {
  it("si cambiano, e togliere il cliente lo rende interno", async () => {
    const p = projectSchema.parse((await create({ name: "Da cambiare", template: "client", clientName: "Acme" })).json());
    expect(p.modules).toEqual(["docs"]);
    const patch = (payload: object) =>
      app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, headers: { cookie: users.adminCookie }, payload });
    const a = projectSchema.parse((await patch({ modules: ["support", "docs"] })).json());
    expect(a.modules).toEqual(["docs", "support"]);
    const b = projectSchema.parse((await patch({ clientName: null })).json());
    expect(b).toMatchObject({ clientName: null, kind: "internal", modules: ["docs", "support"] });
    expect((await patch({ modules: ["chat"] })).statusCode).toBe(400);
  });
});
