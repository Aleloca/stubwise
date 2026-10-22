import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_PERMISSIONS, PRESET_ROLES } from "@stubwise/shared";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

/**
 * I permessi EFFETTIVI verso i client (22 ott 2026): `/api/auth/me` porta
 * quelli d'istanza e, per ogni progetto visibile, quelli di progetto; il
 * dettaglio progetto porta `myPermissions` di chi guarda. Il client li legge
 * invece di dedurli dal ruolo.
 */
const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let visibleId: string;
let hiddenId: string;
let dev: { id: string; headers: { authorization: string } };

const presetPerms = (key: string) =>
  [...PRESET_ROLES.find((r) => r.key === key)!.permissions].sort();

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET });
  ({ adminCookie } = await seedUsers(app));
  const create = async (name: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { name },
    });
    return (res.json() as { id: string }).id;
  };
  visibleId = await create("Visibile");
  hiddenId = await create("Nascosto");
  dev = await createUserWithPat(app, "dev@example.com");
  await addMember(app, visibleId, dev.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("GET /api/auth/me: permessi effettivi", () => {
  it("un Developer: permessi d'istanza del preset User, e solo il progetto di cui è membro", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: dev.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      instancePermissions: string[];
      projectPermissions: Record<string, string[]>;
    };
    expect([...body.instancePermissions].sort()).toEqual(presetPerms("user"));
    expect(Object.keys(body.projectPermissions)).toEqual([visibleId]);
    expect([...body.projectPermissions[visibleId]!].sort()).toEqual(presetPerms("developer"));
    expect(body.projectPermissions).not.toHaveProperty(hiddenId);
  });

  it("un full admin: tutti i permessi su tutti i progetti, anche senza esserne membro", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
    });
    const body = res.json() as {
      instancePermissions: string[];
      projectPermissions: Record<string, string[]>;
    };
    expect(body.instancePermissions).toContain("instance.full_admin");
    for (const id of [visibleId, hiddenId]) {
      expect([...body.projectPermissions[id]!].sort()).toEqual([...PROJECT_PERMISSIONS].sort());
    }
  });
});

describe("GET /api/projects/:projectId: myPermissions", () => {
  it("porta i permessi di progetto di chi guarda", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${visibleId}`,
      headers: dev.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { myPermissions: string[] };
    expect([...body.myPermissions].sort()).toEqual(presetPerms("developer"));
    expect(body.myPermissions).not.toContain("project.settings.manage");
  });

  it("un full admin li ha tutti", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${hiddenId}`,
      headers: { cookie: adminCookie },
    });
    const body = res.json() as { myPermissions: string[] };
    expect([...body.myPermissions].sort()).toEqual([...PROJECT_PERMISSIONS].sort());
  });
});
