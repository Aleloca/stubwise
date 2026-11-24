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
 * anteprima del cliente. Lo stato si deriva (una conversazione con un esito è
 * chiusa); ciò che chi guarda può fare lo dice il server; un progetto
 * invisibile è 404.
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

describe("⌘K (rimandi, lotto 5): la ricerca delle conversazioni", () => {
  it("per codice, nome o email del cliente, SOLO nei progetti che chi cerca vede, con lo stato derivato; sotto i 2 caratteri niente", async () => {
    const { projectId: a } = await seedRepository(t.db);
    const { projectId: b } = await seedRepository(t.db);
    const mine = await conversation(a, { name: "Lucia Verdi", email: "lucia@verdi.it" });
    await conversation(b, { name: "Lucia Neri", email: "lucia@neri.it" });
    const member = await person("developer", a);
    const search = async (headers: H, q: string) => ((await get(headers, `/api/support/search?q=${encodeURIComponent(q)}`)).json() as { items: { id: string; code: string; label: string; state: string; projectCode: string }[] }).items;
    const found = await search(member.headers, "lucia");
    expect(found.map((r) => r.id)).toEqual([mine.id]);
    expect(found[0]).toMatchObject({ kind: "support", code: mine.code, label: "Lucia Verdi", projectId: a, projectCode: mine.code.split("-S")[0] });
    expect(typeof found[0]!.state).toBe("string");
    expect((await search(member.headers, mine.code.toLowerCase())).map((r) => r.id)).toEqual([mine.id]);
    expect((await search(member.headers, "verdi.it")).map((r) => r.id)).toEqual([mine.id]);
    expect(await search(member.headers, "neri")).toEqual([]);
    expect(await search(member.headers, "L")).toEqual([]);
    // Il filtro sta nella WHERE, prima del limite (permissions.md): 20 conversazioni
    // più recenti del progetto invisibile non tolgono il posto a quella visibile.
    for (let i = 0; i < 20; i++) {
      const c = await conversation(b, { name: `Lucia ${i}` });
      await t.db.update(widgetConversations).set({ lastMessageAt: new Date(Date.now() + 60_000 + i) }).where(eq(widgetConversations.id, c.id));
    }
    expect((await search(member.headers, "lucia")).map((r) => r.id)).toEqual([mine.id]);
  });
});

describe("Support, le letture (area 8, F3, S2)", () => {
  it("gli stati si derivano: triage, answered, not_concluded, request_open (una con esito è chiusa); le non concluse in cima", async () => {
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
    // Con una richiesta legata: chiusa, anche se l'ultimo messaggio è del cliente.
    const withRequest = await conversation(projectId);
    await message(withRequest.id, "user", 1);
    await message(withRequest.id, "user", 3);
    const { itemId } = await seedBacklogItem(t.db, { projectId });
    await t.db.update(backlogItems).set({ supportConversationId: withRequest.id }).where(eq(backlogItems.id, itemId));
    const withTicket = await conversation(projectId);
    const { ticketId } = await seedTicket(t.db, { projectId, number: 900 });
    await message(withTicket.id, "user", 1, { ticketId });
    await message(withTicket.id, "assistant", 4);

    const items = await list(dev.headers, projectId);
    const stateOf = (code: string) => items.find((i) => i.code === code)!.state;
    expect(stateOf(triage.code)).toBe("triage");
    expect(stateOf(answered.code)).toBe("answered");
    expect(stateOf(notConcluded.code)).toBe("not_concluded");
    expect(stateOf(withRequest.code)).toBe("request_open");
    expect(stateOf(withTicket.code)).toBe("request_open");
    expect(items[0]!.code).toBe(notConcluded.code);
    expect(items.at(-1)!.code).toBe(answered.code);
    // Nell'elenco i messaggi sono vuoti, c'è l'ultimo.
    const listed = items.find((i) => i.code === withRequest.code)!;
    expect(listed.messages).toEqual([]);
    expect(listed.lastMessage).toMatchObject({ from: "customer", body: "user 3" });
    // Il filtro per stato.
    expect((await list(dev.headers, projectId, "answered")).map((i) => i.code)).toEqual([answered.code]);
    // Un ticket del widget è l'esito: il blocco della task.
    expect(items.find((i) => i.code === withTicket.code)!.task).toMatchObject({ code: expect.stringMatching(/-900$/), customerStatus: "planned" });
    expect(listed.request).toMatchObject({ status: "new", customerStatus: "received" });
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

  it("ciò che chi guarda può fare lo dice il server: Contributor no, Developer sì (support.manage)", async () => {
    const { projectId } = await seedRepository(t.db);
    const contributor = await person("contributor", projectId);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await message(c.id, "user", 1);
    await t.db.update(widgetConversations).set({ triageOutcome: "concluded", triageOutcomeAt: at(20) }).where(eq(widgetConversations.id, c.id));
    expect(await detail(contributor.headers, c.code)).toMatchObject({ canMarkNotConcluded: false, canReplyToCollaborator: false });
    // Sul widget nessuno risponde al cliente, nemmeno chi ha support.manage.
    expect(await detail(dev.headers, c.code)).toMatchObject({ canMarkNotConcluded: true, canReplyToCollaborator: false });
  });

  it("su una non conclusa «Apri la richiesta» per chi ha support.manage e backlog.create; non in triage", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const viewer = await person("viewer", projectId);
    const triage = await conversation(projectId);
    await message(triage.id, "user", 1);
    expect((await detail(dev.headers, triage.code)).canOpenRequest).toBe(false);
    const nc = await conversation(projectId);
    await message(nc.id, "user", 1);
    await t.db.update(widgetConversations).set({ triageOutcome: "not_concluded", triageOutcomeAt: at(20) }).where(eq(widgetConversations.id, nc.id));
    expect((await detail(dev.headers, nc.code)).canOpenRequest).toBe(true);
    expect((await detail(viewer.headers, nc.code)).canOpenRequest).toBe(false);
  });

  it("la successiva di una chiusa: «continua in» sulla chiusa, «seguito di» sulla successiva", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const closed = await conversation(projectId);
    const next = await conversation(projectId);
    await t.db.update(widgetConversations).set({ continuedInId: next.id }).where(eq(widgetConversations.id, closed.id));
    expect(await detail(dev.headers, closed.code)).toMatchObject({ continuedIn: { code: next.code }, continuedFrom: null });
    expect(await detail(dev.headers, next.code)).toMatchObject({ continuedIn: null, continuedFrom: { code: closed.code } });
  });

  it("il dettaglio: i messaggi interi, l'autore del team (canale mcp), il widget", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const [w] = await t.db.insert(widgets).values({ projectId, name: "Sito Acquaviva", key: randomUUID() }).returning();
    const c = await conversation(projectId, { email: null, widgetId: w!.id });
    await t.db.update(widgetConversations).set({ channel: "mcp" }).where(eq(widgetConversations.id, c.id));
    const { itemId } = await seedBacklogItem(t.db, { projectId });
    await t.db.update(backlogItems).set({ supportConversationId: c.id }).where(eq(backlogItems.id, itemId));
    await message(c.id, "user", 1);
    await message(c.id, "assistant", 2);
    await message(c.id, "team", 3, { authorId: dev.id });
    const v = await detail(dev.headers, c.code);
    expect(v.messages.map((m) => m.from)).toEqual(["customer", "triage", "team"]);
    expect(v.messages[2]!.authorId).toBe(dev.id);
    expect(v).toMatchObject({ widgetName: "Sito Acquaviva", state: "request_open", canReplyToCollaborator: true, customer: { name: "Mario Bianchi", email: null } });
  });

  it("area 8, «L'API per i siti»: il cliente FIRMATO dal sito si vede (`identityVerified`); dichiarato no", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const signed = await conversation(projectId);
    await t.db.update(widgetConversations).set({ identityVerified: true }).where(eq(widgetConversations.id, signed.id));
    const declared = await conversation(projectId);
    await message(signed.id, "user", 1);
    await message(declared.id, "user", 2);
    expect((await detail(dev.headers, signed.code)).identityVerified).toBe(true);
    expect((await detail(dev.headers, declared.code)).identityVerified).toBe(false);
    const rows = await list(dev.headers, projectId);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.identityVerified]))).toEqual({ [signed.code]: true, [declared.code]: false });
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

  it("l'anteprima del cliente: solo «customer» e «us», nessun autore; lo stato in parole", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId);
    await message(c.id, "user", 1);
    await message(c.id, "assistant", 2);
    await message(c.id, "team", 3, { authorId: dev.id });
    const res = await get(dev.headers, `/api/support/conversations/by-code/${c.code}/preview`);
    const p = res.json() as SupportCustomerPreview;
    expect(p.messages.map((m) => m.from)).toEqual(["customer", "us", "us"]);
    expect(res.body).not.toContain(dev.id);
    expect(p.status).toBe("received");
  });

  it("«Clienti in attesa» non è più di Support (premessa corretta): la rotta legge le CASELLE, una conversazione del widget che aspetta non c'entra", async () => {
    // Da «Clienti in attesa» (area 8, 15 nov 2026) `/api/me/waiting-customers`
    // esiste di nuovo, ma sulla posta delle mie caselle
    // (`apps/server/src/routes/me-waiting-customers.ts`): il widget non la alimenta.
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId, { name: "Cliente in attesa" });
    await message(c.id, "user", 1);
    const res = await get(dev.headers, "/api/me/waiting-customers");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });

  it("S6: la provenienza di una richiesta e la conversazione di una task del widget si DERIVANO a lettura (null per le altre)", async () => {
    const { projectId } = await seedRepository(t.db);
    const dev = await person("developer", projectId);
    const c = await conversation(projectId, { name: "Luca Riva" });
    await message(c.id, "user", 1);
    await message(c.id, "assistant", 2);
    const { itemId } = await seedBacklogItem(t.db, { projectId });
    await t.db.update(backlogItems).set({ supportConversationId: c.id }).where(eq(backlogItems.id, itemId));
    const { itemId: plain } = await seedBacklogItem(t.db, { projectId });
    const req = (await get(dev.headers, `/api/requests/${itemId}`)).json() as { origin: unknown };
    expect(req.origin).toEqual({ kind: "support", conversationCode: c.code, channel: "widget", customerName: "Luca Riva", messageCount: 2 });
    expect(((await get(dev.headers, `/api/requests/${plain}`)).json() as { origin: unknown }).origin).toBeNull();

    const { ticketId } = await seedTicket(t.db, { projectId, number: 901 });
    const { ticketId: other } = await seedTicket(t.db, { projectId, number: 902 });
    await message(c.id, "user", 3, { ticketId });
    const [p] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    const task = (await get(dev.headers, `/api/tasks/by-code/${p!.code}-901`)).json() as { supportConversationCode: string | null };
    expect(task.supportConversationCode).toBe(c.code);
    const plainTask = (await get(dev.headers, `/api/tasks/by-code/${p!.code}-902`)).json() as { supportConversationCode: string | null };
    expect(plainTask.supportConversationCode).toBeNull();
    expect(other).toBeDefined();
  });
});
