import { randomBytes, randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gitIdentities, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { seedUsers, sessionCookie } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let adminId: string;
let memberId: string;
// Ids degli utenti creati ad-hoc dai singoli test, ripuliti in afterEach.
const extraUserIds = new Set<string>();

/**
 * Crea un secondo admin (invito + register), lo promuove ad admin e ne fa il
 * login: serve un caller admin DISTINTO dall'admin corrente, con cookie
 * proprio. Restituisce id e cookie di sessione.
 */
async function loginNewAdmin(): Promise<{ id: string; cookie: string }> {
  const email = `admin2-${randomUUID()}@example.com`;
  const invite = await app.inject({
    method: "POST",
    url: "/api/auth/invites",
    headers: { cookie: adminCookie },
    payload: { email },
  });
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      token: (invite.json() as { token: string }).token,
      email,
      password: "password-admin2",
    },
  });
  const id = (register.json() as { user: { id: string } }).user.id;
  await testDb.db.update(users).set({ role: "admin" }).where(eq(users.id, id));
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "password-admin2" },
  });
  extraUserIds.add(id);
  return { id, cookie: sessionCookie(login) };
}

/** Conta gli admin attualmente presenti in DB. */
async function countAdmins(): Promise<number> {
  const [row] = await testDb.db
    .select({ value: count() })
    .from(users)
    .where(eq(users.role, "admin"));
  return row?.value ?? 0;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, adminId, memberId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  // Riporta lo stato noto: adminId admin, memberId member; rimuove gli extra.
  await testDb.db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
  await testDb.db.update(users).set({ role: "member" }).where(eq(users.id, memberId));
  // Azzera eventuali link git/bitbucket creati dai singoli test.
  await testDb.db.delete(gitIdentities);
  await testDb.db.update(users).set({ bitbucketUsername: null }).where(eq(users.id, memberId));
  for (const id of extraUserIds) {
    await testDb.db.delete(users).where(eq(users.id, id));
  }
  extraUserIds.clear();
});

describe("GET /api/users", () => {
  it("non autenticato → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
  });

  it("espone bitbucketUsername e gitIdentities per ogni utente", async () => {
    // memberId: 2 git identities + un bitbucketUsername; adminId: nessuno.
    await testDb.db.insert(gitIdentities).values([
      { userId: memberId, email: "bea@work.example", authorName: "Bea Work" },
      { userId: memberId, email: "bea@home.example", authorName: null },
    ]);
    await testDb.db
      .update(users)
      .set({ bitbucketUsername: "bea-bb" })
      .where(eq(users.id, memberId));

    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      bitbucketUsername: string | null;
      gitIdentities: { id: string; email: string; authorName: string | null }[];
    }[];

    const member = body.find((u) => u.id === memberId)!;
    expect(member.bitbucketUsername).toBe("bea-bb");
    expect(member.gitIdentities).toHaveLength(2);
    expect(new Set(member.gitIdentities.map((g) => g.email))).toEqual(
      new Set(["bea@work.example", "bea@home.example"]),
    );
    for (const identity of member.gitIdentities) {
      expect(typeof identity.id).toBe("string");
    }
    expect(member.gitIdentities.find((g) => g.email === "bea@home.example")!.authorName).toBeNull();

    const admin = body.find((u) => u.id === adminId)!;
    expect(admin.bitbucketUsername).toBeNull();
    expect(admin.gitIdentities).toEqual([]);
  });
});

describe("PATCH /api/users/:id/role", () => {
  it("admin promuove un member → 200, ruolo admin", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${memberId}/role`,
      headers: { cookie: adminCookie },
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string; role: string }).role).toBe("admin");

    const [row] = await testDb.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, memberId));
    expect(row!.role).toBe("admin");
  });

  it("admin declassa un altro admin (≥2 admin) → 200, ruolo member", async () => {
    const other = await loginNewAdmin();
    expect(await countAdmins()).toBe(2);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${other.id}/role`,
      headers: { cookie: adminCookie },
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { role: string }).role).toBe("member");

    const [row] = await testDb.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, other.id));
    expect(row!.role).toBe("member");
    // Il declassamento ha lasciato 1 solo admin: il guard non è scattato perché
    // al momento del check gli admin erano 2.
    expect(await countAdmins()).toBe(1);
  });

  it("declassare l'ULTIMO admin → 409 last_admin", async () => {
    // Stato di partenza: un solo admin (adminId). Tentarne il declassamento è
    // vietato col codice più specifico last_admin, controllato PRIMA del
    // self-check: lasciare l'istanza senza admin è la ragione autoritativa.
    expect(await countAdmins()).toBe(1);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${adminId}/role`,
      headers: { cookie: adminCookie },
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("last_admin");
    // Non è stato declassato: resta 1 admin.
    expect(await countAdmins()).toBe(1);
  });

  it("admin cambia il PROPRIO ruolo (con altri admin presenti) → 400 cannot_change_own_role", async () => {
    // ≥2 admin: il rifiuto è dovuto al self-check, non a last_admin.
    await loginNewAdmin();
    expect(await countAdmins()).toBe(2);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${adminId}/role`,
      headers: { cookie: adminCookie },
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("cannot_change_own_role");
  });

  it("id inesistente → 404 user_not_found", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${randomUUID()}/role`,
      headers: { cookie: adminCookie },
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("user_not_found");
  });

  it("member autenticato → 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${adminId}/role`,
      headers: { cookie: memberCookie },
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("non autenticato → 401", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${memberId}/role`,
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(401);
  });
});
