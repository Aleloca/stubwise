import type { Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { FastifyInstance, RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { catalogEntries, catalogInput, openApiPath, visibleEntries, type CatalogEntry } from "../mcp/catalog.js";
import { createUserWithPat, seedUsers } from "../test/fixtures.js";

/**
 * `GET /api/mcp/catalog` (design `docs/plans/2026-11-26-mcp-parita-design.md`
 * § 2): le voci con `config.mcp.action` del registro di questo server, gli
 * schemi dalla spec OpenAPI, e il filtro delle voci `instance`.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let pat: { authorization: string };
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 9).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  ({ headers: pat } = await createUserWithPat(app, "mcp-catalog@acme.com"));
}, 120_000);
afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

describe("GET /api/mcp/catalog", () => {
  it("col PAT elenca le azioni dichiarate, senza schemi e senza il permesso interno", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp/catalog", headers: pat });
    expect(res.statusCode).toBe(200);
    const { actions } = res.json() as { actions: Array<Record<string, unknown>> };
    const projects = actions.find((a) => a.action === "projects.list");
    expect(projects).toEqual({
      action: "projects.list",
      method: "GET",
      path: "/api/projects",
      area: "projects",
      summary: expect.stringContaining("progetti"),
      effect: "read",
      access: "user",
    });
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["me.get", "mcp.catalog", "mcp.describe"]));
    // In ordine di azione (il filtro delle rotte escluse lo prova «il catalogo, le funzioni»).
    expect(actions.map((a) => a.action)).toEqual([...actions.map((a) => a.action as string)].sort((x, y) => x.localeCompare(y)));
    expect(actions.every((a) => !("instancePermission" in a) && !("input" in a))).toBe(true);
  });

  it("senza credenziali: 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/mcp/catalog" })).statusCode).toBe(401);
  });

  it("una voce sola porta gli schemi dalla spec: i parametri del percorso", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp/catalog/mcp.describe", headers: pat });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { path: string; input: { params?: { properties: Record<string, unknown>; required?: string[] }; bodyKind: string } };
    expect(body.path).toBe("/api/mcp/catalog/:action");
    expect(Object.keys(body.input.params?.properties ?? {})).toEqual(["action"]);
    expect(body.input.params?.required).toEqual(["action"]);
    expect(body.input.bodyKind).toBe("none");
  });

  it("le voci `instance` senza il permesso non ci sono, né nell'elenco né da sole; chi ha il permesso le vede (M7 del lotto 0)", async () => {
    const asMember = (await app.inject({ method: "GET", url: "/api/mcp/catalog", headers: pat })).json() as { actions: Array<{ action: string }> };
    const asAdmin = (await app.inject({ method: "GET", url: "/api/mcp/catalog", headers: { cookie: adminCookie } })).json() as { actions: Array<{ action: string; access: string }> };
    expect(asMember.actions.map((a) => a.action)).not.toContain("admin.invites");
    expect(asAdmin.actions.find((a) => a.action === "admin.invites")).toMatchObject({ access: "instance:users.invite" });
    // Una voce `user` la vedono entrambi.
    expect(asMember.actions.map((a) => a.action)).toContain("access.whoCan");
    expect((await app.inject({ method: "GET", url: "/api/mcp/catalog/admin.invites", headers: pat })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/mcp/catalog/admin.invites", headers: { cookie: adminCookie } })).statusCode).toBe(200);
  });

  it("un'azione che non c'è: 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp/catalog/tickets.nonEsiste", headers: pat });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
  });
});

describe("il catalogo, le funzioni", () => {
  const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
    action: "x.y",
    method: "GET",
    path: "/api/x",
    area: "x",
    summary: "Una voce di prova.",
    effect: "read",
    access: "user",
    ...over,
  });

  it("una rotta esclusa dal registro non entra nel catalogo, anche se dichiara un'azione (difesa in profondità)", () => {
    const action = (extra: Record<string, unknown>) =>
      ({ method: "POST", url: "/api/x", config: { access: { kind: "user" }, mcp: { action: "x.do", summary: "Una voce di prova.", effect: "write" }, ...extra } }) as unknown as RouteOptions;
    expect(catalogEntries([action({})]).map((e) => e.action)).toEqual(["x.do"]);
    expect(catalogEntries([action({ reauth: true })])).toEqual([]);
    expect(catalogEntries([action({ browserOnly: true })])).toEqual([]);
    expect(catalogEntries([action({ credentialDoor: true })])).toEqual([]);
  });

  it("le voci `instance` senza il permesso non si vedono; le altre sì", () => {
    const entries = [entry({ action: "a.user" }), entry({ action: "b.instance", access: "instance:settings.manage", instancePermission: "settings.manage" })];
    expect(visibleEntries(entries, new Set()).map((e) => e.action)).toEqual(["a.user"]);
    expect(visibleEntries(entries, new Set(["settings.manage"])).map((e) => e.action)).toEqual(["a.user", "b.instance"]);
  });

  it("i percorsi della spec, e query e corpo JSON da un'operazione", () => {
    expect(openApiPath("/api/tickets/:id/repositories/:repositoryId/release")).toBe("/api/tickets/{id}/repositories/{repositoryId}/release");
    const spec = {
      paths: {
        "/api/x/{id}": {
          post: {
            parameters: [
              { in: "path", name: "id", required: true, schema: { type: "string" } },
              { in: "query", name: "dry", schema: { type: "boolean" } },
            ],
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" } } } } } },
          },
        },
      },
    };
    expect(catalogInput({ method: "POST", path: "/api/x/:id" }, spec)).toEqual({
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      query: { type: "object", properties: { dry: { type: "boolean" } } },
      body: { type: "object", properties: { title: { type: "string" } } },
      bodyKind: "json",
    });
    expect(catalogInput({ method: "GET", path: "/api/assente" }, spec)).toEqual({ bodyKind: "none" });
  });
});
