import type { RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { claudeChatToolTokens, claudeConversations, issueChatToolToken, revokeChatToolToken, tickets, projects } from "@stubwise/db";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { CHAT_TOOL_READ_ROUTES } from "./chat-tool-routes.js";

// Il token di UN turno della chat con Claude (fetta 1): i tool di lettura
// chiamano il server COME l'autore. Solo GET, solo un'allowlist chiusa, mai la
// riconferma, solo finché la conversazione è dell'autore e non archiviata.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let u: Awaited<ReturnType<typeof seedUsers>>;
let author: Awaited<ReturnType<typeof createUserWithSession>>;
let visibleCode: string;
let hiddenCode: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(32) });
  u = await seedUsers(app);
  author = await createUserWithSession(app, "author@example.com");
  const seen = await seedTicket(t.db);
  const hidden = await seedTicket(t.db, { number: 2 });
  await addMember(app, seen.projectId, author.id, "developer");
  const code = async (ticketId: string) => {
    const [row] = await t.db
      .select({ number: tickets.number, key: projects.code })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    return `${row!.key}-${row!.number}`;
  };
  visibleCode = await code(seen.ticketId);
  hiddenCode = await code(hidden.ticketId);
});

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversationOf(cookie: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie }, payload: {} });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

const get = (url: string, token: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("il token del turno della chat", () => {
  it("agisce come l'autore: vede ciò che vede lui; un progetto che non vede è 404 anche col token", async () => {
    const sessionId = await conversationOf(author.headers.cookie);
    const token = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    expect((await get(`/api/tasks/by-code/${visibleCode}`, token)).statusCode).toBe(200);
    expect((await get(`/api/tasks/by-code/${hiddenCode}`, token)).statusCode).toBe(404);
  });

  it("solo GET e solo l'allowlist: altre GET, scritture e rotte di credenziale sono rifiutate", async () => {
    const sessionId = await conversationOf(author.headers.cookie);
    const token = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    const auth = { authorization: `Bearer ${token}` };
    for (const url of ["/api/auth/me", "/api/claude/conversations", `/api/agent-sessions/${sessionId}`]) {
      const res = await get(url, token);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: "chat_tool_forbidden" });
    }
    const write = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: auth, payload: {} });
    expect(write.statusCode).toBe(403);
    const pat = await app.inject({ method: "POST", url: "/api/pats", headers: auth, payload: { name: "x" } });
    expect(pat.statusCode).toBe(403);
    const message = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/messages`,
      headers: auth,
      payload: { text: "da Claude" },
    });
    expect(message.statusCode).toBe(403);
  });

  it("revocato, scaduto, conversazione archiviata o eliminata: il token cade (401)", async () => {
    const sessionId = await conversationOf(author.headers.cookie);
    const revoked = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    await revokeChatToolToken(t.db, revoked);
    expect((await get("/api/projects", revoked)).statusCode).toBe(401);

    const expired = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: -1 });
    expect((await get("/api/projects", expired)).statusCode).toBe(401);

    const live = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    expect((await get("/api/projects", live)).statusCode).toBe(200);
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, sessionId));
    expect((await get("/api/projects", live)).statusCode).toBe(401);

    const other = await conversationOf(author.headers.cookie);
    const gone = await issueChatToolToken(t.db, { sessionId: other, userId: author.id, ttlMs: 60_000 });
    await app.inject({ method: "DELETE", url: `/api/claude/conversations/${other}`, headers: { cookie: author.headers.cookie } });
    expect((await get("/api/projects", gone)).statusCode).toBe(401);
    expect(await t.db.select().from(claudeChatToolTokens).where(eq(claudeChatToolTokens.sessionId, other))).toEqual([]);
  });

  it("legato all'autore della conversazione: un token per la sessione di un altro non vale", async () => {
    const adminConversation = await conversationOf(u.adminCookie);
    const token = await issueChatToolToken(t.db, { sessionId: adminConversation, userId: author.id, ttlMs: 60_000 });
    expect((await get("/api/projects", token)).statusCode).toBe(401);
  });
});

describe("l'allowlist delle rotte del token (registro)", () => {
  it("ogni voce è una GET registrata, autenticata, senza riconferma né porta di credenziale", async () => {
    const routes = new Map<string, RouteOptions>();
    const probe = buildApp({
      onRoute: (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const m of methods) routes.set(`${m} ${route.url}`, route);
      },
    });
    await probe.ready();
    await probe.close();
    expect(CHAT_TOOL_READ_ROUTES.size).toBeGreaterThan(0);
    for (const url of CHAT_TOOL_READ_ROUTES) {
      const route = routes.get(`GET ${url}`);
      expect(route, url).toBeDefined();
      const access = route!.config?.access;
      expect(access?.kind, url).not.toBe("public");
      expect(access?.kind, url).not.toBe("second_factor");
      expect(route!.config?.reauth, url).toBeUndefined();
      expect(route!.config?.credentialDoor, url).toBeUndefined();
    }
  });
});
