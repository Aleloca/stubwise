import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changeLog, comments, decisionRequests, personalAccessTokens, projects, ticketEvents, users, type Db } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { generatePat, hashServerKey } from "../routes/shared.js";
import { recordChange } from "../services/change-log.js";
import { addMember, fullSessionCookie } from "../test/fixtures.js";
import { currentViaClient, outsideRequest, runWithViaClient } from "./via-client.js";

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

  it("un commento di SISTEMA o un evento senza attore scritti nella stessa transazione non sono «via Claude Code» (revisione D4, M3)", async () => {
    await db.insert(comments).values({ ticketId, authorType: "system", body: "di sistema, nella transazione dell'MCP", viaClient: "claude_code" });
    await db.insert(ticketEvents).values({ ticketId, actorId: null, kind: "title_changed", viaClient: "claude_code" });
    const activity = await app.inject({ method: "GET", url: `/api/tasks/${ticketId}/activity`, headers: { cookie } });
    const entries = activity.json() as Array<{ kind: string; body?: string; authorId: string | null; viaClaudeCode: boolean }>;
    expect(entries.find((e) => e.body === "di sistema, nella transazione dell'MCP")?.viaClaudeCode).toBe(false);
    expect(entries.filter((e) => e.kind === "field_change" && e.authorId === null).every((e) => !e.viaClaudeCode)).toBe(true);
  });

  it("il registro decisioni: una voce scritta dall'MCP, e una modificata dall'MCP, portano il segno (decisione del maintainer)", async () => {
    const mcp = await app.inject({ method: "POST", url: `/api/projects/${projectId}/decisions`, headers: { authorization: auth.manual, ...MCP }, payload: { title: "Da Claude Code", decision: "Sì" } });
    expect(mcp.statusCode, mcp.body).toBe(201);
    expect(mcp.json()).toMatchObject({ viaClaudeCode: true, decidedBy: { id: userId } });
    const web = await app.inject({ method: "POST", url: `/api/projects/${projectId}/decisions`, headers: { cookie }, payload: { title: "Dal browser", decision: "No" } });
    expect(web.statusCode, web.body).toBe(201);
    const webId = (web.json() as { id: string; viaClaudeCode: boolean }).id;
    expect((web.json() as { viaClaudeCode: boolean }).viaClaudeCode).toBe(false);
    const patched = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}/decisions/${webId}`, headers: { authorization: auth.manual, ...MCP }, payload: { decision: "Forse" } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ decision: "Forse", viaClaudeCode: true });
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

describe("revisione della D4", () => {
  it("con HTTP vero (app.listen, non inject) il segno arriva", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/api/tickets/${ticketId}/comments`, {
      method: "POST",
      headers: { authorization: auth.manual, ...MCP, "content-type": "application/json" },
      body: JSON.stringify({ body: "via HTTP vero" }),
    });
    expect(res.status).toBe(201);
    const [row] = await db.select({ viaClient: comments.viaClient }).from(comments).where(eq(comments.body, "via HTTP vero"));
    expect(row?.viaClient).toBe("claude_code");
  });

  it("una richiesta di decisione fatta dall'MCP, passando dalla rotta, porta il segno", async () => {
    const res = await app.inject({ method: "POST", url: `/api/tasks/${ticketId}/decisions`, headers: { authorization: auth.manual, ...MCP }, payload: { askedOfId: userId, question: "Da Claude Code?" } });
    expect(res.statusCode, res.body).toBe(201);
    const [row] = await db.select({ viaClient: decisionRequests.viaClient }).from(decisionRequests).where(eq(decisionRequests.question, "Da Claude Code?"));
    expect(row?.viaClient).toBe("claude_code");
  });

  it("recordChange FUORI da una transazione, dentro una richiesta segnata, porta il segno (lo scrive esplicitamente)", async () => {
    const [p] = await db.select({ id: projects.id, code: projects.code }).from(projects).where(eq(projects.id, projectId));
    // `testDb.db` non è avvolto da `withViaClientTransactions`: conta solo la scrittura esplicita.
    const id = await runWithViaClient("claude_code", () =>
      recordChange(testDb.db, { type: "queue.paused", actor: { id: userId, email: "via@acme.com" }, projectId, data: { object: { type: "project", id: p!.id, label: p!.code } } }),
    );
    const [row] = await db.select({ viaClient: changeLog.viaClient }).from(changeLog).where(eq(changeLog.id, id));
    expect(row?.viaClient).toBe("claude_code");
  });

  it("outsideRequest: ciò che nasce lì (un timer) non porta il segno della richiesta", async () => {
    const inside = await runWithViaClient("claude_code", () => new Promise<string | null>((r) => setTimeout(() => r(currentViaClient()), 1)));
    expect(inside).toBe("claude_code");
    const outside = await runWithViaClient("claude_code", () => outsideRequest(() => new Promise<string | null>((r) => setTimeout(() => r(currentViaClient()), 1))));
    expect(outside).toBeNull();
  });

  it("guardia sul sorgente: commenti, storia, richieste di decisione e registro decisioni si inseriscono da un `tx` (eccezione nota: webhooks.ts)", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(src, f), "utf8");
      for (const m of text.matchAll(/([A-Za-z_$][\w$.]*)\s*\.insert\((comments|ticketEvents|decisionRequests|projectDecisions)\)/g)) {
        const receiver = m[1]!.split(".").pop()!;
        if (receiver !== "tx") offenders.push(`${f}: ${m[1]}.insert(${m[2]})`);
      }
    }
    // Il commento di un webhook in ingresso: nessuna richiesta dell'MCP passa di lì.
    expect(offenders).toEqual([join("routes", "webhooks.ts") + ": instance.db.insert(comments)"]);
  });
});
