import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backlogItemRequesters, backlogItems, backlogJobs, notifications, projects, widgetConversations, widgetMessages } from "@stubwise/db";
import { seedBacklogItem, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { SupportConversation } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

/**
 * Support, le scritture (area 8, F3: S3 la risposta al collaboratore, solo
 * canale `mcp`; S6 la richiesta da una conversazione, S15 «Non conclusa»). Ognuna risponde con la
 * vista aggiornata; i permessi li ricontrolla il servizio.
 */

let t: TestDb;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://s.example" });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

type H = Record<string, string>;
const person = async (preset: string, projectId: string) => {
  const u = await createUserWithPat(app, `w-${randomUUID().slice(0, 8)}@acme.com`);
  await addMember(app, projectId, u.id, preset);
  return u;
};
const send = (method: "POST" | "PUT", headers: H, url: string, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const at = (min: number) => new Date(Date.UTC(2026, 10, 14, 10, min));

async function conversation(projectId: string) {
  const [c] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: randomUUID(), externalUserName: "Mario" }).returning();
  const [p] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return { id: c!.id, code: `${p!.code}-S${c!.number}` };
}
async function customer(conversationId: string, min: number) {
  await t.db.insert(widgetMessages).values({ conversationId, role: "user", content: `cliente ${min}`, createdAt: at(min) });
  await t.db.update(widgetConversations).set({ lastMessageAt: at(min) }).where(eq(widgetConversations.id, conversationId));
}
async function withRequest(projectId: string) {
  const c = await conversation(projectId);
  await customer(c.id, 1);
  const { itemId } = await seedBacklogItem(t.db, { projectId });
  await t.db.update(backlogItems).set({ supportConversationId: c.id }).where(eq(backlogItems.id, itemId));
  return c;
}
const judge = (id: string, outcome: "concluded" | "not_concluded") =>
  t.db.update(widgetConversations).set({ triageOutcome: outcome, triageOutcomeAt: at(30) }).where(eq(widgetConversations.id, id));
const teamMessages = (id: string) => t.db.select().from(widgetMessages).where(and(eq(widgetMessages.conversationId, id), eq(widgetMessages.role, "team")));
const base = (code: string) => `/api/support/conversations/by-code/${code}`;

/** Una conversazione mcp come la crea `POST /api/backlog`: col suo job d'intake, già finito su `itemId`. */
async function mcpWithJob(projectId: string, userId: string, itemId: string) {
  const [job] = await t.db
    .insert(backlogJobs)
    .values({ projectId, kind: "intake", status: "done", payload: { title: "x", body: "y", requestedByUserId: userId }, resultItemId: itemId })
    .returning();
  const [c] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: `mcp:${userId}`, channel: "mcp", intakeJobId: job!.id }).returning();
  const [p] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return { id: c!.id, code: `${p!.code}-S${c!.number}` };
}

async function mcpConversation(projectId: string) {
  const c = await withRequest(projectId);
  await t.db.update(widgetConversations).set({ channel: "mcp" }).where(eq(widgetConversations.id, c.id));
  return c;
}

describe("S3: la risposta al collaboratore (solo canale `mcp`)", () => {
  it("sul canale mcp: il messaggio del team con l'autore, nessun avviso, la vista", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await mcpConversation(projectId);
    const res = await send("POST", dev.headers, `${base(c.code)}/replies`, { body: "  Ciao Mario  " });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: "request_open", canReplyToCollaborator: true });
    const [m] = await teamMessages(c.id);
    expect(m).toMatchObject({ content: "Ciao Mario", authorId: dev.id });
    expect(await t.db.select().from(notifications).where(eq(notifications.projectId, projectId))).toEqual([]);
  });

  it("su una conversazione del WIDGET 409 `support_widget_no_reply` e niente scritto, qualunque sia lo stato (premessa corretta)", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const closed = await withRequest(projectId);
    const answered = await conversation(projectId);
    await customer(answered.id, 1);
    await judge(answered.id, "concluded");
    const triage = await conversation(projectId);
    await customer(triage.id, 1);
    for (const c of [closed, answered, triage]) {
      const res = await send("POST", dev.headers, `${base(c.code)}/replies`, { body: "No" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "support_widget_no_reply" });
      expect(await teamMessages(c.id)).toEqual([]);
    }
  });

  it("idempotente su `clientId`: un doppio invio è un messaggio solo", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await mcpConversation(projectId);
    const clientId = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => send("POST", dev.headers, `${base(c.code)}/replies`, { body: "Una volta", clientId })));
    // Ogni invio riceve la vista (non un errore): il secondo trova il primo.
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await teamMessages(c.id)).toHaveLength(1);
  });

  it("senza `support.manage` 403 e niente scritto; un progetto invisibile 404", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    const c = await mcpConversation(projectId);
    expect((await send("POST", contributor.headers, `${base(c.code)}/replies`, { body: "No" })).statusCode).toBe(403);
    const { projectId: other } = await seedRepository(t.db);
    const outsider = await person("developer", other);
    expect((await send("POST", outsider.headers, `${base(c.code)}/replies`, { body: "No" })).statusCode).toBe(404);
    expect(await teamMessages(c.id)).toEqual([]);
  });

  it("«Segui» e la bozza email non esistono più", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await mcpConversation(projectId);
    expect((await send("PUT", dev.headers, `${base(c.code)}/follow`, { on: true })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${base(c.code)}/email-draft`, headers: dev.headers })).statusCode).toBe(404);
  });
});

describe("S6: «Apri la richiesta» da una non conclusa", () => {
  it("nasce legata alla conversazione, chi la apre è il richiedente; 201 con la vista e il codice", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await customer(c.id, 1);
    // L'AI del widget ha fatto l'ultima domanda, poi il cliente se n'è andato.
    await t.db.insert(widgetMessages).values({ conversationId: c.id, role: "assistant", content: "Che formato?", createdAt: at(2) });
    await judge(c.id, "not_concluded");
    const res = await send("POST", dev.headers, `${base(c.code)}/request`, { title: "Export PDF", description: "Vuole il PDF" });
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { conversation: SupportConversation; request: { id: string; code: string } };
    expect(out.conversation.state).toBe("request_open");
    expect(out.request.code).toMatch(/-R\d+$/);
    const [item] = await t.db.select().from(backlogItems).where(eq(backlogItems.id, out.request.id));
    expect(item).toMatchObject({ supportConversationId: c.id, title: "Export PDF", document: "Vuole il PDF" });
    expect(await t.db.select().from(backlogItemRequesters).where(eq(backlogItemRequesters.itemId, item!.id))).toEqual([expect.objectContaining({ userId: dev.id })]);
  });

  it("S7: la richiesta nata pubblica `support.request` (codice, titolo, cliente; il link alla richiesta) a chi la riceve di partenza", async () => {
    const { projectId } = await seedRepository(t.db);
    const lead = await person("project_lead", projectId);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await customer(c.id, 1);
    await judge(c.id, "not_concluded");
    const out = (await send("POST", dev.headers, `${base(c.code)}/request`, { title: "Export PDF", description: "" })).json() as { request: { id: string; code: string } };
    const cards = await t.db.select().from(notifications).where(and(eq(notifications.userId, lead.id), eq(notifications.kind, "support.request")));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.event).toMatchObject({ requestCode: out.request.code, title: "Export PDF", customerName: "Mario", url: `https://s.example/#/p/${out.request.code.split("-R")[0]}/requests?request=${out.request.id}` });
  });

  it("doppio clic (anche insieme): una richiesta sola, la seconda risposta 200 con la stessa", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await customer(c.id, 1);
    await judge(c.id, "not_concluded");
    const results = await Promise.all([1, 2].map(() => send("POST", dev.headers, `${base(c.code)}/request`, { title: "Export", description: "" })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(await t.db.select().from(backlogItems).where(eq(backlogItems.supportConversationId, c.id))).toHaveLength(1);
  });

  it("su una che non è «non conclusa» 409 `support_not_concluded`; senza support.manage o backlog.create 403", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const viewer = await person("viewer", projectId);
    const contributor = await person("contributor", projectId);
    const triage = await conversation(projectId);
    await customer(triage.id, 1);
    expect((await send("POST", dev.headers, `${base(triage.code)}/request`, { title: "x" })).json()).toMatchObject({ code: "support_not_concluded" });
    const nc = await conversation(projectId);
    await customer(nc.id, 1);
    await judge(nc.id, "not_concluded");
    expect((await send("POST", viewer.headers, `${base(nc.code)}/request`, { title: "x" })).statusCode).toBe(403);
    // Il Contributor ha backlog.create ma non support.manage: niente.
    expect((await send("POST", contributor.headers, `${base(nc.code)}/request`, { title: "x" })).statusCode).toBe(403);
    expect(await t.db.select().from(backlogItems).where(eq(backlogItems.supportConversationId, nc.id))).toEqual([]);
  });
});

describe("S15: «Non conclusa» a mano (decisione del maintainer)", () => {
  it("da `answered` a `not_concluded`, autore la persona, e nessun controllo finché il cliente non riscrive", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await customer(c.id, 1);
    await judge(c.id, "concluded");
    const res = await send("POST", dev.headers, `${base(c.code)}/not-concluded`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: "not_concluded", canMarkNotConcluded: false, triage: { outcome: "not_concluded", byUserId: dev.id } });
    const [row] = await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, c.id));
    expect(row!.triageCheckedAt).not.toBeNull();
    // Idempotente: una seconda volta non riscrive.
    const before = row!.triageOutcomeAt!.toISOString();
    expect((await send("POST", dev.headers, `${base(c.code)}/not-concluded`)).statusCode).toBe(200);
    const [again] = await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, c.id));
    expect(again!.triageOutcomeAt!.toISOString()).toBe(before);
  });

  it("solo su `answered` (409 `support_not_answered`), solo con support.manage (403)", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const contributor = await person("contributor", projectId);
    const triage = await conversation(projectId);
    await customer(triage.id, 1);
    expect((await send("POST", dev.headers, `${base(triage.code)}/not-concluded`)).json()).toMatchObject({ code: "support_not_answered" });
    const answered = await conversation(projectId);
    await customer(answered.id, 1);
    await judge(answered.id, "concluded");
    expect((await send("POST", contributor.headers, `${base(answered.code)}/not-concluded`)).statusCode).toBe(403);
  });
});

describe("S12: il canale `mcp` (le richieste dal server MCP in modalità collaboratore)", () => {
  it("POST /api/backlog con la conversazione: una conversazione `mcp` legata al job d'intake, il cliente è chi chiede", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog",
      headers: contributor.headers,
      payload: {
        projectId,
        title: "Export PDF",
        body: "Vorrei il PDF",
        conversation: [
          { from: "customer", text: "Si può avere l'export in PDF?" },
          { from: "assistant", text: "Oggi c'è solo il CSV." },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const [c] = await t.db.select().from(widgetConversations).where(eq(widgetConversations.intakeJobId, jobId));
    expect(c).toMatchObject({ channel: "mcp", projectId, externalUserId: `mcp:${contributor.id}`, widgetId: null });
    const messages = await t.db.select().from(widgetMessages).where(eq(widgetMessages.conversationId, c!.id));
    expect(messages.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    // Il job d'intake non porta campi nuovi (il payload è strict: un worker più vecchio lo rifiuterebbe).
    const [job] = await t.db.select().from(backlogJobs).where(eq(backlogJobs.id, jobId));
    expect(Object.keys(job!.payload as object).sort()).toEqual(["body", "requestedByUserId", "title"]);
  });

  it("senza conversazione come oggi: nessuna conversazione", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    const res = await app.inject({ method: "POST", url: "/api/backlog", headers: contributor.headers, payload: { projectId, title: "x", body: "y" } });
    const { jobId } = res.json() as { jobId: string };
    expect(await t.db.select().from(widgetConversations).where(eq(widgetConversations.intakeJobId, jobId))).toEqual([]);
  });

  it("review F3, I1: una richiesta FUSA in una che c'era — la conversazione mcp ha l'esito dal job, le risposte arrivano a chi l'ha scritta e non al co-richiedente; niente «Apri la richiesta»", async () => {
    const { projectId } = await seedRepository(t.db);
    const first = await person("contributor", projectId);
    const second = await person("contributor", projectId);
    const dev = await person("developer", projectId);
    // La voce c'era (e porta la conversazione del primo); la richiesta del secondo vi è stata fusa.
    const [item] = await t.db.insert(backlogItems).values({ projectId, title: "Export PDF", source: "manual" }).returning();
    const own = await mcpWithJob(projectId, first.id, item!.id);
    await t.db.update(backlogItems).set({ supportConversationId: own.id }).where(eq(backlogItems.id, item!.id));
    const merged = await mcpWithJob(projectId, second.id, item!.id);
    await t.db.insert(backlogItemRequesters).values([{ itemId: item!.id, userId: first.id }, { itemId: item!.id, userId: second.id }]);
    await t.db.insert(widgetMessages).values({ conversationId: merged.id, role: "user", content: "Anche a me", createdAt: at(1) });
    // La conversazione fusa ha un esito (la voce del job): chiusa, nessuna richiesta doppia.
    const view = (await app.inject({ method: "GET", url: base(merged.code), headers: dev.headers })).json() as SupportConversation;
    expect(view).toMatchObject({ state: "request_open", canOpenRequest: false, request: { id: item!.id } });
    // Le risposte: a ciascuno le sue.
    expect((await send("POST", dev.headers, `${base(merged.code)}/replies`, { body: "Per te, secondo" })).statusCode).toBe(200);
    expect((await send("POST", dev.headers, `${base(own.code)}/replies`, { body: "Per te, primo" })).statusCode).toBe(200);
    const repliesOf = async (headers: H) =>
      ((await app.inject({ method: "GET", url: "/api/backlog?mine=true", headers })).json() as { items: { id: string; teamReplies?: { body: string }[] }[] }).items
        .find((i) => i.id === item!.id)!
        .teamReplies!.map((r) => r.body);
    expect(await repliesOf(second.headers)).toEqual(["Per te, secondo"]);
    expect(await repliesOf(first.headers)).toEqual(["Per te, primo"]);
  });

  it("`mine=true`: le richieste di chi chiede portano le risposte del team (senza autore); senza `mine` no", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    const dev = await person("developer", projectId);
    const [item] = await t.db.insert(backlogItems).values({ projectId, title: "Export PDF", source: "manual" }).returning();
    const c = await mcpWithJob(projectId, contributor.id, item!.id);
    await t.db.update(backlogItems).set({ supportConversationId: c.id }).where(eq(backlogItems.id, item!.id));
    await t.db.insert(backlogItemRequesters).values({ itemId: item!.id, userId: contributor.id });
    await t.db.insert(widgetMessages).values({ conversationId: c!.id, role: "user", content: "Si può?", createdAt: at(1) });
    await t.db.insert(widgetMessages).values({ conversationId: c!.id, role: "team", content: "Sì, la mettiamo in pianificazione.", authorId: dev.id, createdAt: at(5) });
    const mine = (await app.inject({ method: "GET", url: "/api/backlog?mine=true", headers: contributor.headers })).json() as { items: { id: string; teamReplies?: unknown }[] };
    const row = mine.items.find((i) => i.id === item!.id)!;
    expect(row.teamReplies).toEqual([{ body: "Sì, la mettiamo in pianificazione.", at: at(5).toISOString() }]);
    expect(JSON.stringify(mine)).not.toContain(dev.id);
    const all = (await app.inject({ method: "GET", url: `/api/backlog?projectId=${projectId}`, headers: dev.headers })).json() as { items: { id: string; teamReplies?: unknown }[] };
    expect(all.items.find((i) => i.id === item!.id)!.teamReplies).toEqual([]);
  });
});

describe("il team non scrive al cliente del widget: un messaggio `team` nasce SOLO dalla risposta al collaboratore", () => {
  it("nessun altro sorgente di server e worker scrive un messaggio `team`", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules" || name === "dist") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(join(root, "server/src"));
    walk(join(root, "worker/src"));
    const writers = files.filter((f) => /role:\s*"team"/.test(readFileSync(f, "utf8")));
    expect(writers.map((f) => f.slice(root.length))).toEqual(["server/src/services/support-writes.ts"]);
  });
});
