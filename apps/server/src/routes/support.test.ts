import { randomUUID } from "node:crypto";
import { backlogItems, projects, widgetConversations, widgetMessages, widgets } from "@stubwise/db";
import { seedBacklogItem, seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { SupportConversation, SupportCustomerPreview } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

/**
 * Support, le letture per i membri (area 8, F3, S2): elenco, dettaglio,
 * anteprima del cliente, «Clienti in attesa». Lo stato si deriva; ciò che chi
 * guarda può fare lo dice il server; un progetto invisibile è 404.
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
  const u = await createUserWithPat(app, `s-${randomUUID().slice(0, 8)}@acme.com`);
  await addMember(app, projectId, u.id, preset);
  return u;
};
const get = (headers: H, url: string) => app.inject({ method: "GET", url, headers });
const list = async (headers: H, projectId: string, state?: string) =>
  ((await get(headers, `/api/projects/${projectId}/support/conversations${state ? `?state=${state}` : ""}`)).json() as { items: SupportConversation[] }).items;
const detail = async (headers: H, code: string) => (await get(headers, `/api/support/conversations/by-code/${code}`)).json() as SupportConversation;

const at = (min: number) => new Date(Date.UTC(2026, 10, 14, 10, min));
async function conversation(projectId: string, opts: { name?: string | null; email?: string | null; widgetId?: string | null } = {}) {
  const [c] = await t.db
    .insert(widgetConversations)
    .values({
      projectId,
      externalUserId: randomUUID(),
      externalUserName: opts.name === undefined ? "Mario Bianchi" : opts.name,
      externalUserEmail: opts.email === undefined ? "mario@x.it" : opts.email,
      widgetId: opts.widgetId ?? null,
    })
    .returning();
  const [p] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return { id: c!.id, code: `${p!.code}-S${c!.number}` };
}
async function message(conversationId: string, role: "user" | "assistant" | "team", min: number, over: Partial<typeof widgetMessages.$inferInsert> = {}) {
  await t.db.insert(widgetMessages).values({ conversationId, role, content: `${role} ${min}`, createdAt: at(min), ...over });
  await t.db.update(widgetConversations).set({ lastMessageAt: at(min) }).where(eq(widgetConversations.id, conversationId));
}

describe("Support, le letture (area 8, F3, S2)", () => {
  it("gli stati si derivano: triage, answered, not_concluded, waiting_us, reply_sent, request_open; chi aspetta noi in cima", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const triage = await conversation(projectId);
    await message(triage.id, "user", 1);
    const answered = await conversation(projectId);
    await message(answered.id, "user", 1);
    await message(answered.id, "assistant", 2);
    await t.db.update(widgetConversations).set({ triageOutcome: "concluded", triageOutcomeAt: at(20) }).where(eq(widgetConversations.id, answered.id));
    const notConcluded = await conversation(projectId);
    await message(notConcluded.id, "user", 1);
    await t.db.update(widgetConversations).set({ triageOutcome: "not_concluded", triageOutcomeAt: at(20) }).where(eq(widgetConversations.id, notConcluded.id));
    const waiting = await conversation(projectId);
    await message(waiting.id, "user", 1);
    await message(waiting.id, "user", 3);
    const { itemId } = await seedBacklogItem(t.db, { projectId });
    await t.db.update(backlogItems).set({ supportConversationId: waiting.id }).where(eq(backlogItems.id, itemId));
    const replied = await conversation(projectId);
    const { ticketId } = await seedTicket(t.db, { projectId, number: 900 });
    await message(replied.id, "user", 1, { ticketId });
    await message(replied.id, "team", 4);

    const items = await list(dev.headers, projectId);
    const stateOf = (code: string) => items.find((i) => i.code === code)!.state;
    expect(stateOf(triage.code)).toBe("triage");
    expect(stateOf(answered.code)).toBe("answered");
    expect(stateOf(notConcluded.code)).toBe("not_concluded");
    expect(stateOf(waiting.code)).toBe("waiting_us");
    expect(stateOf(replied.code)).toBe("reply_sent");
    expect(items[0]!.code).toBe(waiting.code);
    expect(items.at(-1)!.code).toBe(answered.code);
    // Nell'elenco i messaggi sono vuoti, c'è l'ultimo.
    expect(items[0]!.messages).toEqual([]);
    expect(items[0]!.lastMessage).toMatchObject({ from: "customer", body: "user 3" });
    expect(items[0]!.waitingSince).toBe(at(1).toISOString());
    // Il filtro per stato.
    expect((await list(dev.headers, projectId, "answered")).map((i) => i.code)).toEqual([answered.code]);
    // Un ticket del widget è l'esito: il blocco della task.
    expect(items.find((i) => i.code === replied.code)!.task).toMatchObject({ code: expect.stringMatching(/-900$/), customerStatus: "planned" });
    expect(items.find((i) => i.code === waiting.code)!.request).toMatchObject({ status: "new", customerStatus: "received" });
  });

  it("un messaggio del cliente DOPO il giudizio lo rende vecchio: di nuovo in triage", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await message(c.id, "user", 1);
    await t.db.update(widgetConversations).set({ triageOutcome: "concluded", triageOutcomeAt: at(20) }).where(eq(widgetConversations.id, c.id));
    await message(c.id, "user", 30);
    expect((await detail(dev.headers, c.code)).state).toBe("triage");
  });

  it("ciò che chi guarda può fare lo dice il server: Contributor no, Developer sì; la bozza solo a chi risponde", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await message(c.id, "user", 1);
    await t.db
      .update(widgetConversations)
      .set({ triageOutcome: "concluded", triageOutcomeAt: at(20), claudeDraft: "Ciao Mario", claudeDraftAt: at(21) })
      .where(eq(widgetConversations.id, c.id));
    const asContributor = await detail(contributor.headers, c.code);
    expect(asContributor).toMatchObject({ canReply: false, claudeDraft: null, claudeDraftAt: null, canMarkNotConcluded: false, emailBlocked: "no_permission" });
    const asDev = await detail(dev.headers, c.code);
    expect(asDev).toMatchObject({ canReply: true, claudeDraft: "Ciao Mario", canMarkNotConcluded: true, emailBlocked: "no_mailbox", replyClosed: null });
  });

  it("in triage la casella è chiusa; su una non conclusa «Apri la richiesta» per chi ha backlog.create", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const viewer = await person("viewer", projectId);
    const triage = await conversation(projectId);
    await message(triage.id, "user", 1);
    expect(await detail(dev.headers, triage.code)).toMatchObject({ replyClosed: "triage", emailBlocked: "triage", canOpenRequest: false });
    const nc = await conversation(projectId);
    await message(nc.id, "user", 1);
    await t.db.update(widgetConversations).set({ triageOutcome: "not_concluded", triageOutcomeAt: at(20) }).where(eq(widgetConversations.id, nc.id));
    expect((await detail(dev.headers, nc.code)).canOpenRequest).toBe(true);
    expect((await detail(viewer.headers, nc.code)).canOpenRequest).toBe(false);
  });

  it("il dettaglio: i messaggi interi, l'autore del team, il widget; senza email del cliente lo dice", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const [w] = await t.db.insert(widgets).values({ projectId, name: "Sito Acquaviva", key: randomUUID() }).returning();
    const c = await conversation(projectId, { email: null, widgetId: w!.id });
    const { itemId } = await seedBacklogItem(t.db, { projectId });
    await t.db.update(backlogItems).set({ supportConversationId: c.id }).where(eq(backlogItems.id, itemId));
    await message(c.id, "user", 1);
    await message(c.id, "assistant", 2);
    await message(c.id, "team", 3, { authorId: dev.id });
    const v = await detail(dev.headers, c.code);
    expect(v.messages.map((m) => m.from)).toEqual(["customer", "triage", "team"]);
    expect(v.messages[2]!.authorId).toBe(dev.id);
    expect(v).toMatchObject({ widgetName: "Sito Acquaviva", state: "reply_sent", emailBlocked: "no_email", customer: { name: "Mario Bianchi", email: null } });
  });

  it("un progetto invisibile risponde come inesistente; un codice storto o assente è 404", async () => {
    const { projectId } = await seedRepository(t.db);
    const { projectId: other } = await seedRepository(t.db);
    const outsider = await person("developer", other);
    const c = await conversation(projectId);
    expect((await get(outsider.headers, `/api/projects/${projectId}/support/conversations`)).statusCode).toBe(404);
    expect((await get(outsider.headers, `/api/support/conversations/by-code/${c.code}`)).statusCode).toBe(404);
    expect((await get(outsider.headers, `/api/support/conversations/by-code/${c.code}/preview`)).statusCode).toBe(404);
    const insider = await person("viewer", projectId);
    expect((await get(insider.headers, `/api/support/conversations/by-code/${c.code.replace(/S\d+$/, "S999")}`)).statusCode).toBe(404);
    expect((await get(insider.headers, `/api/support/conversations/by-code/storto`)).statusCode).toBe(404);
  });

  it("l'anteprima del cliente: solo «customer» e «us», nessun autore, nessuna bozza; lo stato in parole", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await message(c.id, "user", 1);
    await message(c.id, "assistant", 2);
    await message(c.id, "team", 3, { authorId: dev.id });
    await t.db.update(widgetConversations).set({ claudeDraft: "BOZZA SEGRETA" }).where(eq(widgetConversations.id, c.id));
    const res = await get(dev.headers, `/api/support/conversations/by-code/${c.code}/preview`);
    const p = res.json() as SupportCustomerPreview;
    expect(p.messages.map((m) => m.from)).toEqual(["customer", "us", "us"]);
    expect(res.body).not.toContain(dev.id);
    expect(res.body).not.toContain("BOZZA SEGRETA");
    expect(p.status).toBe("received");
  });

  it("«Clienti in attesa»: solo chi aspetta noi, nei progetti con support.reply; dalla più vecchia attesa", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const contributor = await person("contributor", projectId);
    const linked = async (min: number) => {
      const c = await conversation(projectId);
      await message(c.id, "user", min);
      const { itemId } = await seedBacklogItem(t.db, { projectId });
      await t.db.update(backlogItems).set({ supportConversationId: c.id }).where(eq(backlogItems.id, itemId));
      return c;
    };
    const late = await linked(9);
    const early = await linked(2);
    const notWaiting = await conversation(projectId);
    await message(notWaiting.id, "user", 1);
    const waiting = ((await get(dev.headers, "/api/me/waiting-customers")).json() as { items: SupportConversation[] }).items.filter((i) => i.projectId === projectId);
    expect(waiting.map((i) => i.code)).toEqual([early.code, late.code]);
    expect(((await get(contributor.headers, "/api/me/waiting-customers")).json() as { items: SupportConversation[] }).items.filter((i) => i.projectId === projectId)).toEqual([]);
  });
});
