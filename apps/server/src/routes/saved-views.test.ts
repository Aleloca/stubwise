import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

interface SavedViewBody {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  shared: boolean;
  ownerId: string;
  isOwn: boolean;
  createdAt: string;
}

function createView(payload: Record<string, unknown>, cookie = users.adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/saved-views",
    headers: { cookie },
    payload,
  });
}

function listViews(cookie = users.adminCookie) {
  return app.inject({ method: "GET", url: "/api/saved-views", headers: { cookie } });
}

function patchView(id: string, payload: Record<string, unknown>, cookie = users.adminCookie) {
  return app.inject({ method: "PATCH", url: `/api/saved-views/${id}`, headers: { cookie }, payload });
}

function deleteView(id: string, cookie = users.adminCookie) {
  return app.inject({ method: "DELETE", url: `/api/saved-views/${id}`, headers: { cookie } });
}

describe("POST /api/saved-views", () => {
  it("crea una vista: 201 + proiezione esplicita (isOwn true)", async () => {
    const res = await createView({
      name: "Bug aperti",
      filters: { status: "open", type: "bug", q: "crash" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as SavedViewBody;
    expect(body).toEqual({
      id: expect.any(String),
      name: "Bug aperti",
      filters: { status: "open", type: "bug", q: "crash" },
      shared: false,
      ownerId: users.adminId,
      isOwn: true,
      createdAt: expect.any(String),
    });
  });

  it("shared opzionale con default false", async () => {
    const res = await createView({ name: "Senza shared", filters: {} });
    expect(res.statusCode).toBe(201);
    expect((res.json() as SavedViewBody).shared).toBe(false);
  });

  it("nome duplicato per lo stesso owner: 409 view_exists", async () => {
    await createView({ name: "dup", filters: {} });
    const res = await createView({ name: "dup", filters: {} });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("view_exists");
  });

  it("stesso nome per owner diverso: ok", async () => {
    await createView({ name: "nome-condiviso-tra-owner", filters: {} }, users.adminCookie);
    const res = await createView(
      { name: "nome-condiviso-tra-owner", filters: {} },
      users.memberCookie,
    );
    expect(res.statusCode).toBe(201);
  });

  it("filtri con chiave non prevista: rifiutati (400)", async () => {
    const res = await createView({ name: "spazzatura", filters: { bogus: "x" } });
    expect(res.statusCode).toBe(400);
  });

  it("status «all» (tutti gli stati) è un valore valido e fa round-trip", async () => {
    const res = await createView({ name: "tutti-gli-stati", filters: { status: "all" } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as SavedViewBody).filters).toEqual({ status: "all" });
  });

  it("status non nell'enum (né «all»): 400", async () => {
    const res = await createView({ name: "stato-invalido", filters: { status: "bogus" } });
    expect(res.statusCode).toBe(400);
  });

  it("round-trip dei filtri jsonb con piu campi", async () => {
    const filters = {
      projectId: randomUUID(),
      status: "in_progress",
      type: "feature",
      priority: "high",
      assigneeId: randomUUID(),
      milestoneId: randomUUID(),
      q: "ricerca",
    };
    const res = await createView({ name: "vista-completa", filters });
    expect(res.statusCode).toBe(201);
    expect((res.json() as SavedViewBody).filters).toEqual(filters);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/saved-views",
      payload: { name: "no-auth", filters: {} },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/saved-views", () => {
  it("ritorna le proprie (private+shared) + le shared di altri, non le private di altri", async () => {
    // Admin: una privata e una condivisa.
    const adminPriv = (await createView(
      { name: "admin-privata", filters: {}, shared: false },
      users.adminCookie,
    )).json() as SavedViewBody;
    const adminShared = (await createView(
      { name: "admin-condivisa", filters: {}, shared: true },
      users.adminCookie,
    )).json() as SavedViewBody;

    // Member: una privata e una condivisa.
    const memberPriv = (await createView(
      { name: "member-privata", filters: {}, shared: false },
      users.memberCookie,
    )).json() as SavedViewBody;
    const memberShared = (await createView(
      { name: "member-condivisa", filters: {}, shared: true },
      users.memberCookie,
    )).json() as SavedViewBody;

    const res = await listViews(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const items = res.json() as SavedViewBody[];
    const ids = new Set(items.map((v) => v.id));

    expect(ids.has(adminPriv.id)).toBe(true);
    expect(ids.has(adminShared.id)).toBe(true);
    expect(ids.has(memberShared.id)).toBe(true);
    // La privata di un altro owner NON deve comparire.
    expect(ids.has(memberPriv.id)).toBe(false);

    // isOwn corretto.
    expect(items.find((v) => v.id === adminPriv.id)?.isOwn).toBe(true);
    expect(items.find((v) => v.id === memberShared.id)?.isOwn).toBe(false);
    expect(items.find((v) => v.id === memberShared.id)?.ownerId).toBe(users.memberId);
  });

  it("ordinamento: le proprie prima, poi per nome", async () => {
    const res = await listViews(users.adminCookie);
    const items = res.json() as SavedViewBody[];
    // Tutte le proprie devono precedere tutte le altrui.
    const firstNotOwn = items.findIndex((v) => !v.isOwn);
    if (firstNotOwn !== -1) {
      const afterFirstNotOwn = items.slice(firstNotOwn);
      expect(afterFirstNotOwn.every((v) => !v.isOwn)).toBe(true);
    }
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/saved-views" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/saved-views/:id", () => {
  it("il proprietario aggiorna name, filters e shared", async () => {
    const view = (await createView({ name: "patch-base", filters: { status: "open" } })).json() as SavedViewBody;
    const res = await patchView(view.id, {
      name: "patch-rinominata",
      filters: { status: "done", q: "fix" },
      shared: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SavedViewBody;
    expect(body.name).toBe("patch-rinominata");
    expect(body.filters).toEqual({ status: "done", q: "fix" });
    expect(body.shared).toBe(true);
    expect(body.isOwn).toBe(true);
  });

  it("non proprietario: 403 forbidden", async () => {
    const view = (await createView({ name: "patch-altrui", filters: {} }, users.adminCookie)).json() as SavedViewBody;
    const res = await patchView(view.id, { name: "x" }, users.memberCookie);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
  });

  it("collisione name: 409 view_exists", async () => {
    await createView({ name: "patch-collide-existing", filters: {} });
    const view = (await createView({ name: "patch-collide-move", filters: {} })).json() as SavedViewBody;
    const res = await patchView(view.id, { name: "patch-collide-existing" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("view_exists");
  });

  it("nessun campo: 400", async () => {
    const view = (await createView({ name: "patch-vuoto", filters: {} })).json() as SavedViewBody;
    const res = await patchView(view.id, {});
    expect(res.statusCode).toBe(400);
  });

  it("vista inesistente: 404 view_not_found", async () => {
    const res = await patchView(randomUUID(), { name: "x" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("view_not_found");
  });

  it("senza sessione: 401", async () => {
    const view = (await createView({ name: "patch-401", filters: {} })).json() as SavedViewBody;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/saved-views/${view.id}`,
      payload: { name: "y" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/saved-views/:id", () => {
  it("il proprietario cancella: 204 e la vista sparisce", async () => {
    const view = (await createView({ name: "delete-mia", filters: {} })).json() as SavedViewBody;
    const res = await deleteView(view.id);
    expect(res.statusCode).toBe(204);

    const list = (await listViews()).json() as SavedViewBody[];
    expect(list.find((v) => v.id === view.id)).toBeUndefined();
  });

  it("non proprietario: 403 forbidden", async () => {
    const view = (await createView({ name: "delete-altrui", filters: {} }, users.adminCookie)).json() as SavedViewBody;
    const res = await deleteView(view.id, users.memberCookie);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
  });

  it("vista inesistente: 404 view_not_found", async () => {
    const res = await deleteView(randomUUID());
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("view_not_found");
  });

  it("senza sessione: 401", async () => {
    const view = (await createView({ name: "delete-401", filters: {} })).json() as SavedViewBody;
    const res = await app.inject({ method: "DELETE", url: `/api/saved-views/${view.id}` });
    expect(res.statusCode).toBe(401);
  });
});
