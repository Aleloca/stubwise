import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gitAuthorsSeen, gitIdentities, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let adminId: string;

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
  // Ripulisce le associazioni tra i test per isolarli.
  await testDb.db.delete(gitIdentities);
  await testDb.db.delete(gitAuthorsSeen);
  await testDb.db.update(users).set({ bitbucketUsername: null }).where(eq(users.id, memberId));
  await testDb.db.update(users).set({ bitbucketUsername: null }).where(eq(users.id, adminId));
});

describe("POST /api/users/:id/git-identities", () => {
  it("associa un'email e ritorna la lista; una seconda email → 2 identità", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "dev@x.it", authorName: "Dev" },
    });
    expect(first.statusCode).toBe(200);
    const firstList = first.json() as { email: string; authorName: string | null }[];
    expect(firstList).toHaveLength(1);
    expect(firstList[0]!.email).toBe("dev@x.it");
    expect(firstList[0]!.authorName).toBe("Dev");

    const second = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "dev2@x.it" },
    });
    expect(second.statusCode).toBe(200);
    const secondList = second.json() as { email: string; authorName: string | null }[];
    expect(secondList).toHaveLength(2);
    expect(secondList.map((i) => i.email).sort()).toEqual(["dev2@x.it", "dev@x.it"]);
  });

  it("normalizza l'email a lowercase + trim", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "  Dev@X.it  " },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { email: string }[];
    expect(list[0]!.email).toBe("dev@x.it");
  });

  it("email whitespace-only → 400 e nessuna riga inserita", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "   " },
    });
    expect(res.statusCode).toBe(400);
    const rows = await testDb.db.select().from(gitIdentities);
    expect(rows).toHaveLength(0);
  });

  it("case-collision: Dev@X.it poi dev@x.it → il secondo 409 git_identity_taken", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "Dev@X.it" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "dev@x.it" },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe("git_identity_taken");
  });

  it("email già di un altro membro → 409 git_identity_taken", async () => {
    // L'admin possiede già l'email.
    await testDb.db.insert(gitIdentities).values({ userId: adminId, email: "taken@x.it" });
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "taken@x.it" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("git_identity_taken");
  });

  it("utente assente → 404 user_not_found", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${randomUUID()}/git-identities`,
      headers: { cookie: adminCookie },
      payload: { email: "x@x.it" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("user_not_found");
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: memberCookie },
      payload: { email: "x@x.it" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      payload: { email: "x@x.it" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/users/:id/git-identities/:email", () => {
  it("rimuove un'associazione esistente → 204", async () => {
    await testDb.db.insert(gitIdentities).values({ userId: memberId, email: "del@x.it" });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/git-identities/${encodeURIComponent("del@x.it")}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const rows = await testDb.db
      .select()
      .from(gitIdentities)
      .where(eq(gitIdentities.userId, memberId));
    expect(rows).toHaveLength(0);
  });

  it("normalizza l'email a lowercase in DELETE", async () => {
    await testDb.db.insert(gitIdentities).values({ userId: memberId, email: "del@x.it" });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/git-identities/${encodeURIComponent("Del@X.it")}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
  });

  it("associazione assente → 404 git_identity_not_found", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/git-identities/${encodeURIComponent("nope@x.it")}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("git_identity_not_found");
  });

  it(":email malformato (decode → %ZZ) → 404, non 500", async () => {
    // %25ZZ: il router Fastify decodifica %25→% dando "%ZZ", poi il
    // decodeURIComponent dell'handler lancia URIError. Deve tradursi in 404.
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/git-identities/%25ZZ`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("git_identity_not_found");
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/git-identities/${encodeURIComponent("x@x.it")}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PUT /api/users/:id/bitbucket", () => {
  it("linka bitbucketUsername → 200", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/bitbucket`,
      headers: { cookie: adminCookie },
      payload: { username: "member-bb" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; bitbucketUsername: string | null };
    expect(body.id).toBe(memberId);
    expect(body.bitbucketUsername).toBe("member-bb");
  });

  it("trima lo username: '  bob  ' → 'bob'", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/bitbucket`,
      headers: { cookie: adminCookie },
      payload: { username: "  bob  " },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bitbucketUsername: string | null }).bitbucketUsername).toBe("bob");
  });

  it("stesso username per un altro utente → 409 bitbucket_identity_taken", async () => {
    await testDb.db
      .update(users)
      .set({ bitbucketUsername: "shared-bb" })
      .where(eq(users.id, adminId));
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/bitbucket`,
      headers: { cookie: adminCookie },
      payload: { username: "shared-bb" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("bitbucket_identity_taken");
  });

  it("utente assente → 404 user_not_found", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${randomUUID()}/bitbucket`,
      headers: { cookie: adminCookie },
      payload: { username: "x-bb" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("user_not_found");
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/bitbucket`,
      headers: { cookie: memberCookie },
      payload: { username: "x-bb" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/users/:id/bitbucket", () => {
  it("azzera bitbucketUsername → 204", async () => {
    await testDb.db
      .update(users)
      .set({ bitbucketUsername: "to-clear" })
      .where(eq(users.id, memberId));
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/bitbucket`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await testDb.db
      .select({ bitbucketUsername: users.bitbucketUsername })
      .from(users)
      .where(eq(users.id, memberId));
    expect(row!.bitbucketUsername).toBeNull();
  });

  it("utente assente → 404 user_not_found", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${randomUUID()}/bitbucket`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/bitbucket`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/git/observed-authors", () => {
  it("lista con linkedUserId valorizzato per un'email associata e null altrimenti", async () => {
    await testDb.db.insert(gitAuthorsSeen).values([
      { email: "linked@x.it", authorName: "Linked" },
      { email: "free@x.it", authorName: "Free" },
    ]);
    await testDb.db.insert(gitIdentities).values({ userId: memberId, email: "linked@x.it" });

    const res = await app.inject({
      method: "GET",
      url: "/api/git/observed-authors",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as {
      email: string;
      authorName: string | null;
      lastSeenAt: string;
      linkedUserId: string | null;
    }[];
    const linked = list.find((a) => a.email === "linked@x.it")!;
    const free = list.find((a) => a.email === "free@x.it")!;
    expect(linked.linkedUserId).toBe(memberId);
    expect(linked.authorName).toBe("Linked");
    expect(typeof linked.lastSeenAt).toBe("string");
    expect(free.linkedUserId).toBeNull();
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/git/observed-authors",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
