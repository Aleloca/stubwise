import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encrypt, instanceSettings, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";
import type { SlackClient, SlackWorkspaceUser } from "./api.js";
import type { SlackClientFactory } from "./creds.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const SIGNING_SECRET = "slack-signing-secret-di-test-1234567890";
const BOT_TOKEN = "xoxb-test-token";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

// Spie del client Slack iniettato (niente rete).
let profileToReturn: Awaited<ReturnType<SlackClient["getUserProfile"]>> = {
  email: "u@example.com",
  displayName: "U",
  avatarUrl: "https://avatars.slack-edge.com/u.png",
};
const getUserProfile = vi.fn<SlackClient["getUserProfile"]>(async () => profileToReturn);
let workspaceToReturn: SlackWorkspaceUser[] = [];
let listShouldThrow = false;
const listWorkspaceUsers = vi.fn<SlackClient["listWorkspaceUsers"]>(async () => {
  if (listShouldThrow) throw new Error("users.list fallita");
  return workspaceToReturn;
});
const slackClientFactory: SlackClientFactory = () => ({
  openView: async () => true,
  getUserEmail: async () => profileToReturn?.email ?? null,
  getUserProfile,
  listWorkspaceUsers,
});

/** Imposta (o azzera) i segreti Slack cifrati sul singleton instance settings. */
async function setSlackCreds(enabled: boolean): Promise<void> {
  await testDb.db
    .insert(instanceSettings)
    .values({
      id: 1,
      slackSigningSecretEncrypted: enabled ? encrypt(SIGNING_SECRET, ENCRYPTION_KEY) : null,
      slackBotTokenEncrypted: enabled ? encrypt(BOT_TOKEN, ENCRYPTION_KEY) : null,
    })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: {
        slackSigningSecretEncrypted: enabled ? encrypt(SIGNING_SECRET, ENCRYPTION_KEY) : null,
        slackBotTokenEncrypted: enabled ? encrypt(BOT_TOKEN, ENCRYPTION_KEY) : null,
      },
    });
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    slackClientFactory,
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
  await setSlackCreds(true);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  getUserProfile.mockClear();
  listWorkspaceUsers.mockClear();
  profileToReturn = {
    email: "u@example.com",
    displayName: "U",
    avatarUrl: "https://avatars.slack-edge.com/u.png",
  };
  workspaceToReturn = [];
  listShouldThrow = false;
  // Azzera l'identità Slack del member tra i test.
  await testDb.db
    .update(users)
    .set({ slackUserId: null, slackAvatarUrl: null })
    .where(eq(users.id, memberId));
  await setSlackCreds(true);
});

describe("PUT /api/users/:id/slack", () => {
  it("link ok → salva slackUserId + avatar (derivato dal profilo)", async () => {
    profileToReturn = {
      email: "m@example.com",
      displayName: "Member",
      avatarUrl: "https://avatars.slack-edge.com/m.png",
    };
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: adminCookie },
      payload: { slackUserId: "Umember1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; slackUserId: string | null; avatarUrl: string | null };
    expect(body.id).toBe(memberId);
    expect(body.slackUserId).toBe("Umember1");
    expect(body.avatarUrl).toBe("https://avatars.slack-edge.com/m.png");

    const [row] = await testDb.db
      .select({ slackUserId: users.slackUserId, slackAvatarUrl: users.slackAvatarUrl })
      .from(users)
      .where(eq(users.id, memberId));
    expect(row!.slackUserId).toBe("Umember1");
    expect(row!.slackAvatarUrl).toBe("https://avatars.slack-edge.com/m.png");
  });

  it("utente assente → 404 user_not_found", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${randomUUID()}/slack`,
      headers: { cookie: adminCookie },
      payload: { slackUserId: "Ux" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("user_not_found");
  });

  it("profilo Slack null → 400 slack_user_not_found", async () => {
    profileToReturn = null;
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: adminCookie },
      payload: { slackUserId: "Uunknown" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("slack_user_not_found");
  });

  it("Slack non configurato → 400 slack_not_configured", async () => {
    await setSlackCreds(false);
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: adminCookie },
      payload: { slackUserId: "Ux" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("slack_not_configured");
  });

  it("Slack id già di un altro utente → 409 slack_identity_taken", async () => {
    // Crea un secondo utente che possiede già lo Slack id.
    const [other] = await testDb.db
      .insert(users)
      .values({
        email: `other-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
        slackUserId: "Utaken",
      })
      .returning({ id: users.id });
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: adminCookie },
      payload: { slackUserId: "Utaken" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("slack_identity_taken");
    await testDb.db.delete(users).where(eq(users.id, other!.id));
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: memberCookie },
      payload: { slackUserId: "Ux" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione → 401", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      payload: { slackUserId: "Ux" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/users/:id/slack", () => {
  it("204 + campi azzerati", async () => {
    await testDb.db
      .update(users)
      .set({ slackUserId: "Udel", slackAvatarUrl: "https://a/x.png" })
      .where(eq(users.id, memberId));
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await testDb.db
      .select({ slackUserId: users.slackUserId, slackAvatarUrl: users.slackAvatarUrl })
      .from(users)
      .where(eq(users.id, memberId));
    expect(row!.slackUserId).toBeNull();
    expect(row!.slackAvatarUrl).toBeNull();
  });

  it("utente assente → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${randomUUID()}/slack`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/slack/workspace-users", () => {
  it("lista con linkedUserId corretto per un membro già linkato", async () => {
    await testDb.db
      .update(users)
      .set({ slackUserId: "Ulinked" })
      .where(eq(users.id, memberId));
    workspaceToReturn = [
      { id: "Ulinked", displayName: "Linked", email: "l@x.com", avatarUrl: "https://a/l.png" },
      { id: "Ufree", displayName: "Free", email: "f@x.com", avatarUrl: null },
    ];
    const res = await app.inject({
      method: "GET",
      url: "/api/slack/workspace-users",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string; linkedUserId: string | null }[];
    expect(list.find((m) => m.id === "Ulinked")?.linkedUserId).toBe(memberId);
    expect(list.find((m) => m.id === "Ufree")?.linkedUserId).toBeNull();
  });

  it("Slack non configurato → 400 slack_not_configured", async () => {
    await setSlackCreds(false);
    const res = await app.inject({
      method: "GET",
      url: "/api/slack/workspace-users",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("slack_not_configured");
  });

  it("client lancia → 502 slack_unavailable (non 500)", async () => {
    listShouldThrow = true;
    const res = await app.inject({
      method: "GET",
      url: "/api/slack/workspace-users",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { code: string }).code).toBe("slack_unavailable");
  });

  it("member → 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/slack/workspace-users",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("proiezione utente estesa", () => {
  it("GET /api/users include avatarUrl/slackUserId (null di default, valorizzati dopo il link)", async () => {
    // Prima del link: entrambi null.
    let res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    let rows = res.json() as { id: string; avatarUrl: string | null; slackUserId: string | null }[];
    const before = rows.find((r) => r.id === memberId)!;
    expect(before.avatarUrl).toBeNull();
    expect(before.slackUserId).toBeNull();

    // Link via endpoint admin.
    profileToReturn = { email: "m@x.com", displayName: "M", avatarUrl: "https://a/me.png" };
    await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: adminCookie },
      payload: { slackUserId: "Uproj" },
    });

    res = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } });
    rows = res.json() as { id: string; avatarUrl: string | null; slackUserId: string | null }[];
    const after = rows.find((r) => r.id === memberId)!;
    expect(after.avatarUrl).toBe("https://a/me.png");
    expect(after.slackUserId).toBe("Uproj");
  });

  it("GET /api/auth/me espone avatarUrl/slackUserId dell'utente corrente", async () => {
    profileToReturn = { email: "m@x.com", displayName: "M", avatarUrl: "https://a/self.png" };
    await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: adminCookie },
      payload: { slackUserId: "Uself" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as {
      user: { avatarUrl: string | null; slackUserId: string | null };
    };
    expect(user.avatarUrl).toBe("https://a/self.png");
    expect(user.slackUserId).toBe("Uself");
  });
});
