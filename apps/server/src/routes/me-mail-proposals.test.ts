import { randomUUID } from "node:crypto";
import {
  emailMessages,
  emailProposalRecipients,
  emailProposals,
  googleAccounts,
  notifications,
  googleWorkspaces,
  projects,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * LE PROPOSTE CONDIVISE IN LETTURA (area 6, F2, task 5). Chi le vede: SOLO i
 * destinatari registrati e con il progetto visibile — i test negativi sono il
 * cuore: un admin non destinatario, un membro non destinatario, un
 * destinatario che ha perso il progetto. E i permessi calcolati dal server.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie, adminId } = await seedUsers(app));
}, 120_000);
afterEach(async () => {
  await db.delete(notifications);
  await db.delete(emailProposals);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function person(presetKey: string | null, name: string) {
  const user = await createUserWithSession(app, `${name}-${randomUUID()}@acme.com`);
  await db.update(users).set({ displayName: name }).where((await import("drizzle-orm")).eq(users.id, user.id));
  if (presetKey) await addMember(app, projectId, user.id, presetKey);
  return user;
}

async function seed() {
  const [project] = await db.insert(projects).values({ name: "Audin", slug: `audin-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  projectId = project!.id;
  const ada = await person("developer", "Ada");
  const bruno = await person("viewer", "Bruno"); // destinatario, solo in lettura nel progetto
  const carla = await person("developer", "Carla"); // membro, NON destinataria
  const outsider = await person(null, "Dario"); // non membro
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [box] = await db.insert(googleAccounts).values({ userId: ada.id, workspaceId: ws!.id, email: `box-${randomUUID()}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const [message] = await db
    .insert(emailMessages)
    .values({ accountId: box!.id, gmailMessageId: "g1", threadId: "t1", fromAddress: "cliente@x.it", fromName: "Cliente", subject: "Export", receivedAt: new Date(), textExcerpt: "Serve l'export.", rfcMessageId: "<e@x>" })
    .returning();
  const [ticket] = await db.insert(tickets).values({ projectId, number: 12, title: "Vecchia", type: "bug", priority: "medium", source: "manual" }).returning();
  const [proposal] = await db
    .insert(emailProposals)
    .values({
      emailMessageId: message!.id,
      projectId,
      rfcMessageId: "<e@x>",
      audience: "mail_recipients",
      status: "proposed",
      classification: {
        version: 2,
        summary: "Export",
        actions: [
          { type: "create_task", args: { title: "Export CSV", description: "", assigneeId: outsider.id, dueDate: null } },
          { type: "comment_ticket", args: { ticketId: ticket!.id, body: "Visto" } },
        ],
      },
    })
    .returning();
  const card = async (userId: string) =>
    (
      await db
        .insert(notifications)
        .values({
          userId,
          kind: "google.proposal",
          projectId,
          status: "open",
          event: { kind: "google.proposal", proposalId: proposal!.id, source: "email", from: "Cliente", subject: "Export", question: "?", options: [{ label: "a" }, { label: "b" }, { label: "Non fare nulla" }], actions: [{ type: "create_task" }, { type: "comment_ticket" }, { type: "ignore" }], recommendedIndex: 0, allowFreeText: false, messageUrl: "https://mail.google.com/x", signal: "request" },
        })
        .returning()
    )[0]!.id;
  await db.insert(emailProposalRecipients).values([
    { proposalId: proposal!.id, userId: ada.id, notificationId: await card(ada.id) },
    { proposalId: proposal!.id, userId: bruno.id, notificationId: await card(bruno.id) },
  ]);
  return { ada, bruno, carla, outsider, message: message!, proposal: proposal!, ticket: ticket! };
}

function get(headers: { cookie: string }, url: string) {
  return app.inject({ method: "GET", url, headers });
}

describe("GET /api/me/mail/proposals", () => {
  it("un destinatario la vede: azioni con argomenti ed etichette, permessi calcolati, chi la condivide, l'origine", async () => {
    const { ada, outsider, message, proposal } = await seed();
    const res = await get(ada.headers, `/api/me/mail/proposals?message=${message.id}`);
    expect(res.statusCode).toBe(200);
    const [item] = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(item).toMatchObject({
      id: proposal.id,
      messageId: message.id,
      projectId,
      status: "open",
      excerpt: "Serve l'export.",
      canConfirm: true,
      canHand: false,
      blockedIndices: [],
      outsiders: [{ userId: outsider.id, name: "Dario" }],
      sharedWith: [{ name: "Bruno" }],
      origin: { threadId: "t1", from: "Cliente <cliente@x.it>", subject: "Export" },
    });
    const actions = item!.actions as { type: string; label: string; args: Record<string, unknown> }[];
    expect(actions.map((a) => a.type)).toEqual(["create_task", "comment_ticket"]);
    expect(actions[0]!.args).toMatchObject({ title: "Export CSV" });
    expect(actions[0]!.label).toContain("Export CSV");
  });

  it("un destinatario senza i permessi di un'azione: quell'indice bloccato, non conferma ma può passarla", async () => {
    const { bruno, proposal } = await seed();
    const res = await get(bruno.headers, `/api/me/mail/proposals/${proposal.id}`);
    expect(res.statusCode).toBe(200);
    const item = res.json() as { canConfirm: boolean; canHand: boolean; blockedIndices: number[]; messageId: string; origin: unknown };
    // Viewer: né `tickets.create` né `tickets.comment`.
    expect(item.blockedIndices).toEqual([0, 1]);
    expect(item.canConfirm).toBe(false);
    expect(item.canHand).toBe(true);
    // Bruno non ha la casella: niente riga d'origine (la Posta resta personale).
    expect(item.origin).toBeNull();
  });

  it("NEGATIVO: un admin non destinatario non la vede (404 per id, elenco vuoto)", async () => {
    const { message, proposal } = await seed();
    expect((await get({ cookie: adminCookie }, `/api/me/mail/proposals/${proposal.id}`)).statusCode).toBe(404);
    expect((await get({ cookie: adminCookie }, `/api/me/mail/proposals?message=${message.id}`)).json()).toEqual({ items: [] });
    expect(adminId).toBeTruthy();
  });

  it("NEGATIVO: un membro del progetto che non è destinatario non la vede", async () => {
    const { carla, proposal } = await seed();
    expect((await get(carla.headers, `/api/me/mail/proposals/${proposal.id}`)).statusCode).toBe(404);
  });

  it("NEGATIVO: un destinatario che ha perso il progetto non la vede più (la revoca vale a lettura)", async () => {
    const { bruno, proposal } = await seed();
    const { projectMembers } = await import("@stubwise/db");
    const { and, eq } = await import("drizzle-orm");
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, bruno.id)));
    expect((await get(bruno.headers, `/api/me/mail/proposals/${proposal.id}`)).statusCode).toBe(404);
  });

  it("il filtro per stato e lo stato derivato (passata, confermata)", async () => {
    const { ada, proposal } = await seed();
    const { eq } = await import("drizzle-orm");
    expect((await get(ada.headers, "/api/me/mail/proposals?status=confirmed")).json()).toEqual({ items: [] });
    await db.update(emailProposals).set({ status: "actioned", decidedByUserId: ada.id, decidedAt: new Date(), confirmedIndices: [0] }).where(eq(emailProposals.id, proposal.id));
    const [item] = (await get(ada.headers, "/api/me/mail/proposals?status=confirmed")).json().items as { status: string; canConfirm: boolean; decidedBy: { name: string }; confirmedIndices: number[] }[];
    expect(item).toMatchObject({ status: "confirmed", canConfirm: false, decidedBy: { name: "Ada" }, confirmedIndices: [0] });
  });

  it("una proposta «Quale progetto?»: una sola azione choose_project, non si conferma né si passa", async () => {
    const { ada, proposal } = await seed();
    const { eq } = await import("drizzle-orm");
    await db.update(emailProposals).set({ classification: { version: 2, summary: "", actions: [], choose: { projectIds: [projectId, randomUUID()] } } }).where(eq(emailProposals.id, proposal.id));
    const item = (await get(ada.headers, `/api/me/mail/proposals/${proposal.id}`)).json() as { actions: { type: string }[]; canConfirm: boolean; canHand: boolean; canReassign: boolean };
    expect(item.actions.map((a) => a.type)).toEqual(["choose_project"]);
    expect([item.canConfirm, item.canHand, item.canReassign]).toEqual([false, false, false]);
  });

  it("vuole una sessione", async () => {
    expect((await app.inject({ method: "GET", url: "/api/me/mail/proposals" })).statusCode).toBe(401);
  });
});

describe("decidere una proposta condivisa (F2, task 6)", () => {
  function post(headers: { cookie: string }, url: string, payload: unknown = {}) {
    return app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
  }
  async function openCards() {
    const { eq } = await import("drizzle-orm");
    return db.select({ userId: notifications.userId }).from(notifications).where(eq(notifications.status, "open"));
  }

  it("confermare: esegue le azioni (la task nasce con source email), chiude la proposta e le card di TUTTI i destinatari", async () => {
    const { ada, outsider, proposal } = await seed();
    const { eq } = await import("drizzle-orm");
    // Incaricato non membro: senza aggiungerlo, 400 invalid_assignee.
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`)).json()).toMatchObject({ code: "invalid_assignee" });
    const res = await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { edits: { "0": { assigneeId: ada.id, title: "Export CSV ordini" } } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; results: { kind: string; id: string; code: string | null }[] };
    expect(body.status).toBe("confirmed");
    expect(body.results.map((r) => r.kind)).toEqual(["task", "comment"]);
    const [task] = await db.select().from(tickets).where(eq(tickets.id, body.results[0]!.id));
    expect(task).toMatchObject({ title: "Export CSV ordini", assigneeId: ada.id, source: "email", type: "task" });
    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, proposal.id));
    expect(row).toMatchObject({ status: "actioned", decidedByUserId: ada.id, confirmedIndices: null });
    expect(await openCards()).toEqual([]);
    expect(outsider.id).toBeTruthy();
  });

  it("conferma PARZIALE: solo l'azione scelta, e confirmedIndices lo dice", async () => {
    const { ada, proposal } = await seed();
    const { eq } = await import("drizzle-orm");
    const res = await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [1] });
    expect((res.json() as { results: { kind: string }[] }).results.map((r) => r.kind)).toEqual(["comment"]);
    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, proposal.id));
    expect(row!.confirmedIndices).toEqual([1]);
    expect((await get(ada.headers, `/api/me/mail/proposals/${proposal.id}`)).json()).toMatchObject({ status: "confirmed", confirmedIndices: [1], decidedBy: { name: "Ada" } });
  });

  it("il secondo che decide: 409 already_handled con chi ha deciso, e niente nasce due volte", async () => {
    const { ada, bruno, proposal } = await seed();
    await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [1] });
    const second = await post(bruno.headers, `/api/me/mail/proposals/${proposal.id}/ignore`);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "already_handled", decidedBy: { name: "Ada" } });
  });

  it("senza il permesso di un'azione scelta: 403, e niente cambia", async () => {
    const { bruno, proposal } = await seed();
    const res = await post(bruno.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [1] });
    expect(res.statusCode).toBe(403);
    expect(await openCards()).toHaveLength(2);
  });

  it("modifiche fuori dal consentito (il bersaglio, il progetto) e selezioni non valide: 400", async () => {
    const { ada, proposal } = await seed();
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [1], edits: { "1": { ticketId: randomUUID() } } })).json()).toMatchObject({ code: "invalid_edits" });
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [5] })).json()).toMatchObject({ code: "invalid_selection" });
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [1, 1] })).json()).toMatchObject({ code: "invalid_selection" });
  });

  it("tutto o niente: se un'azione fallisce la task non nasce, la proposta è `failed` per tutti", async () => {
    const { ada, proposal, ticket } = await seed();
    const { eq } = await import("drizzle-orm");
    await db.delete(tickets).where(eq(tickets.id, ticket.id));
    const before = (await db.select().from(tickets)).length;
    const res = await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { edits: { "0": { assigneeId: ada.id } } });
    expect(res.json()).toMatchObject({ status: "failed", error: "target_gone" });
    expect((await db.select().from(tickets)).length).toBe(before);
    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, proposal.id));
    expect(row!.status).toBe("failed");
    expect(await openCards()).toEqual([]);
  });

  it("NEGATIVO: chi non è destinatario non decide (404), nemmeno un admin", async () => {
    const { carla, proposal } = await seed();
    expect((await post(carla.headers, `/api/me/mail/proposals/${proposal.id}/ignore`)).statusCode).toBe(404);
    expect((await post({ cookie: adminCookie }, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [1] })).statusCode).toBe(404);
    expect(await openCards()).toHaveLength(2);
  });

  it("dall'inbox: la card condivisa si decide dal servizio nuovo (l'ultima opzione è «Non fare nulla»)", async () => {
    const { ada, proposal } = await seed();
    const { and, eq } = await import("drizzle-orm");
    const [card] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, ada.id), eq(notifications.status, "open")));
    const res = await app.inject({ method: "POST", url: `/api/inbox/${card!.id}/actions/answer`, headers: ada.headers, payload: { optionIndex: 2 } });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, proposal.id));
    expect(row!.status).toBe("ignored");
    expect(await openCards()).toEqual([]);
  });

  it("A = (a): un destinatario SENZA casella vede l'estratto, ma il dettaglio e l'originale del messaggio gli sono 404", async () => {
    const { bruno, proposal, message } = await seed();
    const view = (await get(bruno.headers, `/api/me/mail/proposals/${proposal.id}`)).json() as { excerpt: string; origin: unknown };
    expect(view.excerpt).toBe("Serve l'export.");
    expect(view.origin).toBeNull();
    expect((await get(bruno.headers, `/api/me/mail/email/${proposal.id}`)).statusCode).toBe(404);
    expect((await get(bruno.headers, `/api/me/mail/email/${proposal.id}/original`)).statusCode).toBe(404);
    expect((await get(bruno.headers, `/api/me/mail/threads/${message.threadId}`)).statusCode).toBe(404);
  });
});
