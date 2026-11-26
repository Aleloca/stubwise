import { randomUUID } from "node:crypto";
import { changeLog, comments, personalAccessTokens, ticketEvents, users, type Db } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { generatePat, hashServerKey } from "../routes/shared.js";
import { addMember, fullSessionCookie } from "../test/fixtures.js";

/**
 * D4 della parità MCP (design `docs/plans/2026-11-26-mcp-parita-design.md`,
 * «Decisioni»): ciò che una persona fa DA Claude Code (il PAT `manual` con
 * l'header dell'MCP) porta «via Claude Code», nella storia del ticket e nel
 * registro delle modifiche; l'autore resta la persona. Con un cookie, col PAT
 * del desktop o senza l'header, no.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let userId: string;
let projectId: string;
let ticketId: string;
const auth: Record<"manual" | "desktop", string> = { manual: "", desktop: "" };
let cookie: string;

const MCP = { "x-stubwise-client": "claude-code" };

async function patOf(kind: "manual" | "desktop"): Promise<string> {
  const token = generatePat();
  await db.insert(personalAccessTokens).values({ userId, name: `test ${kind}`, tokenHash: hashServerKey(token), kind });
  return `Bearer ${token}`;
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 9).toString("base64") });
  const [u] = await db.insert(users).values({ email: `via-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  userId = u!.id;
  ({ projectId, ticketId } = await seedTicket(db));
  await addMember(app, projectId, userId, "project_lead");
  auth.manual = await patOf("manual");
  auth.desktop = await patOf("desktop");
  cookie = await fullSessionCookie(app, userId);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

async function comment(headers: Record<string, string>, body: string) {
  const res = await app.inject({ method: "POST", url: `/api/tickets/${ticketId}/comments`, headers, payload: { body } });
  expect(res.statusCode, res.body).toBe(201);
  const [row] = await db.select({ viaClient: comments.viaClient, authorId: comments.authorId }).from(comments).where(and(eq(comments.ticketId, ticketId), eq(comments.body, body)));
  return row!;
}

describe("«via Claude Code» sui commenti", () => {
  it("PAT manual + header dell'MCP: il commento è via Claude Code, e l'autore resta la persona", async () => {
    expect(await comment({ authorization: auth.manual, ...MCP }, "da claude code")).toEqual({ viaClient: "claude_code", authorId: userId });
  });

  it("subito dopo, una richiesta senza l'header non eredita il segno (la variabile è locale alla transazione)", async () => {
    expect((await comment({ authorization: auth.manual }, "senza header")).viaClient).toBeNull();
  });

  it("col PAT del desktop, anche con l'header: no", async () => {
    expect((await comment({ authorization: auth.desktop, ...MCP }, "dal desktop")).viaClient).toBeNull();
  });

  it("con un cookie di sessione, anche con l'header: no", async () => {
    expect((await comment({ cookie, ...MCP }, "dal browser")).viaClient).toBeNull();
  });

  it("un valore diverso dell'header: no", async () => {
    expect((await comment({ authorization: auth.manual, "x-stubwise-client": "altro" }, "altro client")).viaClient).toBeNull();
  });
});

describe("«via Claude Code» nella storia della task e nel registro", () => {
  it("un cambio di campo dall'MCP porta il segno, nella colonna e nella storia letta", async () => {
    const res = await app.inject({ method: "PATCH", url: `/api/tasks/${ticketId}`, headers: { authorization: auth.manual, ...MCP }, payload: { title: "Titolo da Claude Code" } });
    expect(res.statusCode, res.body).toBe(200);
    const events = await db.select({ kind: ticketEvents.kind, viaClient: ticketEvents.viaClient, actorId: ticketEvents.actorId }).from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.viaClient === "claude_code" && e.actorId === userId)).toBe(true);

    const activity = await app.inject({ method: "GET", url: `/api/tasks/${ticketId}/activity`, headers: { cookie } });
    expect(activity.statusCode, activity.body).toBe(200);
    const entries = activity.json() as Array<{ kind: string; body?: string; viaClaudeCode: boolean; viaClaude: boolean }>;
    const byBody = (b: string) => entries.find((e) => e.kind === "comment" && e.body === b);
    expect(byBody("da claude code")?.viaClaudeCode).toBe(true);
    expect(byBody("dal browser")?.viaClaudeCode).toBe(false);
    expect(entries.filter((e) => e.kind === "field_change").every((e) => e.viaClaudeCode && !e.viaClaude)).toBe(true);
  });

  it("una voce del registro dall'MCP porta il segno, e la lettura del registro lo dice", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/queue/pause`, headers: { authorization: auth.manual, ...MCP } });
    expect(res.statusCode, res.body).toBe(204);
    const resumed = await app.inject({ method: "POST", url: `/api/projects/${projectId}/queue/resume`, headers: { cookie } });
    expect(resumed.statusCode, resumed.body).toBe(204);
    const rows = await db.select({ type: changeLog.type, viaClient: changeLog.viaClient }).from(changeLog).where(eq(changeLog.projectId, projectId));
    expect(rows.find((r) => r.type === "queue.paused")?.viaClient).toBe("claude_code");
    expect(rows.find((r) => r.type === "queue.resumed")?.viaClient).toBeNull();

    const read = await app.inject({ method: "GET", url: `/api/change-log?projectId=${projectId}`, headers: { cookie } });
    expect(read.statusCode, read.body).toBe(200);
    const entries = (read.json() as { entries: Array<{ type: string; viaClaudeCode: boolean; via: string | null }> }).entries;
    expect(entries.find((e) => e.type === "queue.paused")).toMatchObject({ viaClaudeCode: true, via: null });
    expect(entries.find((e) => e.type === "queue.resumed")).toMatchObject({ viaClaudeCode: false });
  });
});
