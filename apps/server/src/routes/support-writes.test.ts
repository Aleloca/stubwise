import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backlogItemRequesters, backlogItems, notifications, projects, supportFollowers, widgetConversations, widgetMessages } from "@stubwise/db";
import { seedBacklogItem, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { SupportConversation } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

/**
 * Support, le scritture (area 8, F3: S3 la risposta, S5 «Segui», S6 la
 * richiesta da una conversazione, S15 «Non conclusa»). Ognuna risponde con la
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

describe("S3: «Send to customer»", () => {
  it("scrive il messaggio del team con l'autore, segue da sé, toglie la bozza, risponde con la vista", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await withRequest(projectId);
    await t.db.update(widgetConversations).set({ claudeDraft: "Bozza", claudeDraftAt: at(2), draftDueAt: at(3) }).where(eq(widgetConversations.id, c.id));
    const res = await send("POST", dev.headers, `${base(c.code)}/replies`, { body: "  Ciao Mario  " });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json() as SupportConversation;
    expect(v).toMatchObject({ state: "reply_sent", following: true, claudeDraft: null, claudeDraftPending: false });
    const [m] = await teamMessages(c.id);
    expect(m).toMatchObject({ content: "Ciao Mario", authorId: dev.id });
    expect(await t.db.select().from(supportFollowers).where(eq(supportFollowers.conversationId, c.id))).toHaveLength(1);
    // Nessun avviso, nessuna email: la risposta non pubblica niente.
    expect(await t.db.select().from(notifications).where(eq(notifications.projectId, projectId))).toEqual([]);
  });

  it("idempotente su `clientId`: un doppio invio è un messaggio solo", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await withRequest(projectId);
    const clientId = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => send("POST", dev.headers, `${base(c.code)}/replies`, { body: "Una volta", clientId })));
    // Ogni invio riceve la vista (non un errore): il secondo trova il primo.
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await teamMessages(c.id)).toHaveLength(1);
  });

  it("senza `support.reply` 403 e niente scritto; durante il triage 409 `support_triage`; un progetto invisibile 404", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    const dev = await person("developer", projectId);
    const c = await withRequest(projectId);
    const forbidden = await send("POST", contributor.headers, `${base(c.code)}/replies`, { body: "No" });
    expect(forbidden.statusCode).toBe(403);
    const triage = await conversation(projectId);
    await customer(triage.id, 1);
    expect((await send("POST", dev.headers, `${base(triage.code)}/replies`, { body: "No" })).json()).toMatchObject({ code: "support_triage" });
    const { projectId: other } = await seedRepository(t.db);
    const outsider = await person("developer", other);
    expect((await send("POST", outsider.headers, `${base(c.code)}/replies`, { body: "No" })).statusCode).toBe(404);
    expect(await teamMessages(c.id)).toEqual([]);
    expect(await teamMessages(triage.id)).toEqual([]);
  });

  it("si risponde anche a una non conclusa e a una `answered` (fuori dal triage)", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    for (const outcome of ["not_concluded", "concluded"] as const) {
      const c = await conversation(projectId);
      await customer(c.id, 1);
      await judge(c.id, outcome);
      expect((await send("POST", dev.headers, `${base(c.code)}/replies`, { body: "Ciao" })).statusCode).toBe(200);
    }
  });
});

describe("S5: «Segui»", () => {
  it("chi vede il progetto segue e smette (seguire non è rispondere)", async () => {
    const { projectId } = await seedRepository(t.db);
    const viewer = await person("viewer", projectId);
    const c = await conversation(projectId);
    expect((await send("PUT", viewer.headers, `${base(c.code)}/follow`, { on: true })).json()).toMatchObject({ following: true });
    expect((await send("PUT", viewer.headers, `${base(c.code)}/follow`, { on: true })).json()).toMatchObject({ following: true });
    expect(await t.db.select().from(supportFollowers).where(eq(supportFollowers.conversationId, c.id))).toHaveLength(1);
    expect((await send("PUT", viewer.headers, `${base(c.code)}/follow`, { on: false })).json()).toMatchObject({ following: false });
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

  it("su una che non è «non conclusa» 409 `support_not_concluded`; senza backlog.create 403", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const viewer = await person("viewer", projectId);
    const triage = await conversation(projectId);
    await customer(triage.id, 1);
    expect((await send("POST", dev.headers, `${base(triage.code)}/request`, { title: "x" })).json()).toMatchObject({ code: "support_not_concluded" });
    const nc = await conversation(projectId);
    await customer(nc.id, 1);
    await judge(nc.id, "not_concluded");
    expect((await send("POST", viewer.headers, `${base(nc.code)}/request`, { title: "x" })).statusCode).toBe(403);
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

  it("solo su `answered` (409 `support_not_answered`), solo con support.reply (403)", async () => {
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

describe("una risposta al cliente nasce SOLO da «Send to customer»", () => {
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
