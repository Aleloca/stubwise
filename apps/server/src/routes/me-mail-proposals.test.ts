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
      editable: true,
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

describe("passare, spostare, scegliere il progetto, aggiungere Contributor (F2, task 6, seconda parte)", () => {
  const post = (headers: { cookie: string }, url: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
  async function row(id: string) {
    const { eq } = await import("drizzle-orm");
    return (await db.select().from(emailProposals).where(eq(emailProposals.id, id)))[0];
  }
  async function secondProject(memberIds: string[]) {
    const [p] = await db.insert(projects).values({ name: "Beta", slug: `beta-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
    for (const id of memberIds) await addMember(app, p!.id, id, "developer");
    return p!.id;
  }
  async function onlyTask(proposalId: string, assigneeId: string | null) {
    const { eq } = await import("drizzle-orm");
    await db
      .update(emailProposals)
      .set({ classification: { version: 2, summary: "s", actions: [{ type: "create_task", args: { title: "Export CSV", description: "", assigneeId, dueDate: null } }] } })
      .where(eq(emailProposals.id, proposalId));
  }

  it("passare: chi non può confermarla la passa; la vede e la decide chi nel progetto ha i permessi di ogni azione, non destinatario", async () => {
    const { ada, bruno, carla, proposal } = await seed();
    // Ada può confermarla: non la passa.
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/hand`)).json()).toMatchObject({ code: "invalid_selection" });
    // Carla (membro, non destinataria) prima non la vede.
    expect((await get(carla.headers, `/api/me/mail/proposals/${proposal.id}`)).statusCode).toBe(404);
    const res = await post(bruno.headers, `/api/me/mail/proposals/${proposal.id}/hand`);
    expect(res.json()).toEqual({ status: "handed" });
    const seen = (await get(carla.headers, `/api/me/mail/proposals/${proposal.id}`)).json() as { status: string; canConfirm: boolean; handedBy: { name: string } };
    expect(seen).toMatchObject({ status: "handed", canConfirm: true, handedBy: { name: "Bruno" } });
    expect((await post(carla.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [1] })).json()).toMatchObject({ status: "confirmed" });
  });

  it("NEGATIVO: una proposta passata resta invisibile a chi nel progetto NON ha i permessi di ogni azione, e a un admin non destinatario senza membership no — vede tutto, ma non è destinatario: la vede solo perché ha i permessi", async () => {
    const { bruno, outsider, proposal } = await seed();
    await post(bruno.headers, `/api/me/mail/proposals/${proposal.id}/hand`);
    expect((await get(outsider.headers, `/api/me/mail/proposals/${proposal.id}`)).statusCode).toBe(404);
    // Un membro NON destinatario senza i permessi di ogni azione: né la vede né la decide.
    const gino = await person("viewer", "Gino");
    expect((await get(gino.headers, `/api/me/mail/proposals/${proposal.id}`)).statusCode).toBe(404);
    expect((await post(gino.headers, `/api/me/mail/proposals/${proposal.id}/ignore`)).statusCode).toBe(404);
  });

  it("spostare: una proposta nuova sul progetto scelto (in analisi), questa chiusa per tutti; le azioni non spostabili no", async () => {
    const { ada, proposal } = await seed();
    const beta = await secondProject([ada.id]);
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/reassign`, { projectId: beta })).json()).toMatchObject({ code: "invalid_selection" });
    await onlyTask(proposal.id, null);
    const res = await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/reassign`, { projectId: beta });
    expect(res.json()).toEqual({ status: "moved", projectId: beta });
    expect(await row(proposal.id)).toMatchObject({ status: "ignored", outcome: { type: "reassigned_to", projectId: beta } });
    const { and, eq } = await import("drizzle-orm");
    const [moved] = await db.select().from(emailProposals).where(and(eq(emailProposals.projectId, beta), eq(emailProposals.rfcMessageId, "<e@x>")));
    expect(moved).toMatchObject({ status: "classified", audience: "mail_recipients" });
    expect((await db.select().from(notifications).where(eq(notifications.status, "open")))).toEqual([]);
  });

  it("spostare su un progetto che chi sposta non vede: 400 invalid_target", async () => {
    const { ada, proposal } = await seed();
    await onlyTask(proposal.id, null);
    const hidden = await secondProject([]);
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/reassign`, { projectId: hidden })).json()).toMatchObject({ code: "invalid_target" });
  });

  it("«Quale progetto?»: la domanda se ne va e l'email torna da classificare per il progetto scelto", async () => {
    const { ada, proposal, message } = await seed();
    const beta = await secondProject([ada.id]);
    const { eq } = await import("drizzle-orm");
    await db.update(emailProposals).set({ classification: { version: 2, summary: "", actions: [], choose: { projectIds: [projectId, beta] } } }).where(eq(emailProposals.id, proposal.id));
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/choose-project`, { projectId: randomUUID() })).json()).toMatchObject({ code: "invalid_target" });
    // Un progetto che Ada vede, ma che non era fra quelli incerti.
    const gamma = await secondProject([ada.id]);
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/choose-project`, { projectId: gamma })).json()).toMatchObject({ code: "invalid_target" });
    const res = await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/choose-project`, { projectId: beta });
    expect(res.json()).toEqual({ status: "moved", projectId: beta });
    expect(await row(proposal.id)).toBeUndefined();
    const [m] = await db.select().from(emailMessages).where(eq(emailMessages.id, message.id));
    expect(m).toMatchObject({ classificationState: null, status: "new", projectId: beta, scopeProjectIds: [beta] });
  });

  it("review F2, punto 2: «Quale progetto?» dall'inbox — l'opzione i è il progetto i della card, l'ultima è «Non fare nulla»", async () => {
    const { ada, proposal } = await seed();
    const beta = await secondProject([ada.id]);
    const { and, eq } = await import("drizzle-orm");
    await db.update(emailProposals).set({ classification: { version: 2, summary: "", actions: [], choose: { projectIds: [projectId, beta] } } }).where(eq(emailProposals.id, proposal.id));
    const chooseEvent = (n: string) => ({
      kind: "google.proposal", proposalId: proposal.id, source: "email", from: "Cliente", subject: "Export", question: "Quale progetto?",
      options: [{ label: "Audin" }, { label: "Beta" }, { label: "Non fare nulla" }],
      actions: [{ type: "choose_project", projectId }, { type: "choose_project", projectId: beta }, { type: "ignore" }],
      recommendedIndex: 0, allowFreeText: false, messageUrl: `https://mail.google.com/${n}`, signal: "request",
    });
    const [card] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, ada.id), eq(notifications.status, "open")));
    await db.update(notifications).set({ event: chooseEvent("a") }).where(eq(notifications.id, card!.id));
    const answer = (optionIndex: number) => app.inject({ method: "POST", url: `/api/inbox/${card!.id}/actions/answer`, headers: ada.headers, payload: { optionIndex } });
    // Un indice oltre l'ultima opzione.
    expect((await answer(3)).statusCode).toBe(400);
    // L'opzione 1 è Beta: la domanda se ne va, l'email torna da classificare per Beta.
    const res = await answer(1);
    expect(res.statusCode).toBe(200);
    expect(await row(proposal.id)).toBeUndefined();
    const [m] = await db.select().from(emailMessages).where(eq(emailMessages.id, proposal.emailMessageId));
    expect(m).toMatchObject({ projectId: beta });
  });

  it("review F2, punto 2: «Non fare nulla» su una «Quale progetto?» dall'inbox la ignora", async () => {
    const { ada, proposal } = await seed();
    const beta = await secondProject([ada.id]);
    const { and, eq } = await import("drizzle-orm");
    await db.update(emailProposals).set({ classification: { version: 2, summary: "", actions: [], choose: { projectIds: [projectId, beta] } } }).where(eq(emailProposals.id, proposal.id));
    const [card] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, ada.id), eq(notifications.status, "open")));
    await db
      .update(notifications)
      .set({ event: { kind: "google.proposal", proposalId: proposal.id, source: "email", from: "C", subject: "E", question: "?", options: [{ label: "Audin" }, { label: "Beta" }, { label: "Non fare nulla" }], actions: [{ type: "choose_project", projectId }, { type: "choose_project", projectId: beta }, { type: "ignore" }], recommendedIndex: 0, allowFreeText: false, messageUrl: "https://mail.google.com/x", signal: "request" } })
      .where(eq(notifications.id, card!.id));
    const res = await app.inject({ method: "POST", url: `/api/inbox/${card!.id}/actions/answer`, headers: ada.headers, payload: { optionIndex: 2 } });
    expect(res.statusCode).toBe(200);
    expect((await row(proposal.id))!.status).toBe("ignored");
  });

  it("review F2, punto 3: A fallisce mentre B conferma — il `failed` di A non scrive sopra l'`actioned` di B", async () => {
    const { ada, proposal, ticket } = await seed();
    const { eq } = await import("drizzle-orm");
    const { confirmMailProposal } = await import("../services/mail-proposals-decide.js");
    // L'azione 1 di A (comment_ticket) fallirà: il ticket non c'è più.
    await db.delete(tickets).where(eq(tickets.id, ticket.id));
    let first = true;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return async (fn: Parameters<Db["transaction"]>[0]) => {
          try {
            return await target.transaction(fn);
          } catch (err) {
            // Fra il rollback di A e il suo `failed`: B ha confermato.
            if (first) {
              first = false;
              await target.update(emailProposals).set({ status: "actioned", results: [] }).where(eq(emailProposals.id, proposal.id));
            }
            throw err;
          }
        };
      },
    }) as Db;
    const out = await confirmMailProposal(racing, { id: ada.id }, proposal.id, { indices: [1] }, "it");
    expect(out).toMatchObject({ ok: false, error: "already_handled" });
    expect((await row(proposal.id))!.status).toBe("actioned");
  });

  it("review F2, punto 5: una patch del modello con uno stato inventato fallisce pulita (failed, mai 500), e non tocca la task", async () => {
    const { ada, proposal, ticket } = await seed();
    const { eq } = await import("drizzle-orm");
    await db
      .update(emailProposals)
      .set({ classification: { version: 2, summary: "s", actions: [{ type: "update_ticket", args: { ticketId: ticket.id, patch: { status: "inventato", priority: "high" } } }] } })
      .where(eq(emailProposals.id, proposal.id));
    const res = await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [0] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", error: "invalid_action" });
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(t!.priority).toBe("medium");
  });

  it("review F2, punto 5: la patch si modifica solo su status/priority/assigneeId validi — title o un enum inventato sono invalid_edits", async () => {
    const { ada, proposal, ticket } = await seed();
    const { eq } = await import("drizzle-orm");
    await db
      .update(emailProposals)
      .set({ classification: { version: 2, summary: "s", actions: [{ type: "update_ticket", args: { ticketId: ticket.id, patch: { priority: "high" } } }] } })
      .where(eq(emailProposals.id, proposal.id));
    const confirm = (patch: Record<string, unknown>) => post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm`, { indices: [0], edits: { "0": { patch } } });
    expect((await confirm({ title: "rinominata" })).json()).toMatchObject({ code: "invalid_edits" });
    // Un campo fuori elenco insieme a uno valido: rifiutata lo stesso, non «ripulita».
    expect((await confirm({ priority: "high", title: "rinominata" })).json()).toMatchObject({ code: "invalid_edits" });
    expect((await confirm({ priority: "altissima" })).json()).toMatchObject({ code: "invalid_edits" });
    expect((await confirm({ priority: "urgent" })).json()).toMatchObject({ status: "confirmed" });
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(t!.priority).toBe("urgent");
  });

  it("aggiungere Contributor: senza project.members.manage 403; con, l'incaricato entra e la task nasce assegnata a lui", async () => {
    const { ada, outsider, proposal } = await seed();
    await onlyTask(proposal.id, outsider.id);
    expect((await post(ada.headers, `/api/me/mail/proposals/${proposal.id}/confirm-with-members`, { addOutsiders: [outsider.id] })).statusCode).toBe(403);
    const lead = await person("project_lead", "Lea");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: lead.id });
    const res = await post(lead.headers, `/api/me/mail/proposals/${proposal.id}/confirm-with-members`, { addOutsiders: [outsider.id] });
    expect(res.json()).toMatchObject({ status: "confirmed" });
    const { and, eq } = await import("drizzle-orm");
    const { projectMembers } = await import("@stubwise/db");
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsider.id)))).toHaveLength(1);
  });

  it("aggiungere Contributor: se la conferma non riesce, chi è stato aggiunto se ne va", async () => {
    const { outsider, proposal } = await seed();
    await onlyTask(proposal.id, outsider.id);
    const lead = await person("project_lead", "Lea");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: lead.id });
    // Un'altra persona decide prima: la conferma non riesce.
    const { eq } = await import("drizzle-orm");
    await db.update(emailProposals).set({ status: "ignored" }).where(eq(emailProposals.id, proposal.id));
    const res = await post(lead.headers, `/api/me/mail/proposals/${proposal.id}/confirm-with-members`, { addOutsiders: [outsider.id] });
    expect(res.statusCode).toBe(409);
    const { and } = await import("drizzle-orm");
    const { projectMembers } = await import("@stubwise/db");
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsider.id)))).toEqual([]);
  });
});

describe("Contributor: si toglie solo chi questa chiamata ha creato (review della seconda parte)", () => {
  it("un incaricato GIÀ membro non viene tolto dopo un fallimento", async () => {
    const { outsider, proposal } = await seed();
    const { and, eq } = await import("drizzle-orm");
    const { projectMembers } = await import("@stubwise/db");
    // Dario è già membro (Contributor, aggiunto da qualcun altro prima).
    await addMember(app, projectId, outsider.id, "contributor");
    await db
      .update(emailProposals)
      .set({ status: "ignored", classification: { version: 2, summary: "s", actions: [{ type: "create_task", args: { title: "X", description: "", assigneeId: outsider.id, dueDate: null } }] } })
      .where(eq(emailProposals.id, proposal.id));
    const lead = await person("project_lead", "Lea");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: lead.id });
    const res = await app.inject({ method: "POST", url: `/api/me/mail/proposals/${proposal.id}/confirm-with-members`, headers: lead.headers, payload: { addOutsiders: [outsider.id] } });
    expect(res.statusCode).toBe(409);
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsider.id)))).toHaveLength(1);
  });
});

describe("le proposte di PRIMA in /proposals (una fonte sola)", () => {
  async function legacy() {
    const { ada, carla, message: shared } = await seed();
    const [message] = await db
      .insert(emailMessages)
      .values({ accountId: shared.accountId, gmailMessageId: `g-old-${randomUUID()}`, threadId: "t-old", fromAddress: "cliente@x.it", subject: "Export", receivedAt: new Date(), textExcerpt: "Vecchia." })
      .returning();
    const [card] = await db
      .insert(notifications)
      .values({
        userId: ada.id,
        kind: "google.proposal",
        projectId,
        status: "open",
        event: {
          kind: "google.proposal",
          proposalId: randomUUID(),
          source: "email",
          from: "Cliente",
          subject: "Export",
          question: "?",
          options: [{ label: "Apri la richiesta «Export»" }, { label: "Sposta" }, { label: "Non fare nulla" }],
          actions: [{ type: "create_backlog_item", projectId, title: "Export", body: "corpo" }, { type: "reassign_project" }, { type: "ignore" }],
          recommendedIndex: 0,
          allowFreeText: false,
          messageUrl: "https://mail.google.com/x",
          signal: "request",
        },
      })
      .returning();
    const [old] = await db
      .insert(emailProposals)
      .values({ emailMessageId: message!.id, projectId, status: "proposed", classification: { summary: "s", proposals: [], recommendedIndex: 0 }, proposalNotificationId: card!.id })
      .returning();
    return { ada, carla, message: message!, old: old!, card: card! };
  }

  it("il proprietario della casella la vede nella stessa forma, con le azioni del modello e le loro etichette", async () => {
    const { ada, old } = await legacy();
    const item = (await get(ada.headers, `/api/me/mail/proposals/${old.id}`)).json() as { actions: { type: string; label: string; args: Record<string, unknown> }[]; sharedWith: unknown[]; canReassign: boolean; status: string; editable: boolean };
    expect(item.status).toBe("open");
    expect(item.editable).toBe(false);
    expect(item.actions).toEqual([{ type: "create_backlog_item", label: "Apri la richiesta «Export»", args: expect.objectContaining({ title: "Export", description: "corpo" }) }]);
    expect(item.sharedWith).toEqual([]);
    expect(item.canReassign).toBe(true);
  });

  it("NEGATIVO: un altro, anche membro del progetto, non la vede", async () => {
    const { carla, old } = await legacy();
    expect((await get(carla.headers, `/api/me/mail/proposals/${old.id}`)).statusCode).toBe(404);
  });

  it("si decide dalle rotte nuove, passando dal servizio di prima: ignorare chiude la card", async () => {
    const { ada, old, card } = await legacy();
    const { eq } = await import("drizzle-orm");
    expect((await app.inject({ method: "POST", url: `/api/me/mail/proposals/${old.id}/confirm`, headers: ada.headers, payload: { edits: { "0": { title: "Y" } } } })).json()).toMatchObject({ code: "invalid_edits" });
    const res = await app.inject({ method: "POST", url: `/api/me/mail/proposals/${old.id}/ignore`, headers: ada.headers, payload: {} });
    expect(res.json()).toEqual({ status: "ignored" });
    const [n] = await db.select().from(notifications).where(eq(notifications.id, card.id));
    expect(n!.status).toBe("handled");
  });
});

describe("Contributor: la guardia «cambiato nel frattempo» (review della seconda parte, b)", () => {
  it("una riga promossa da un altro fra l'aggiunta e la conferma NON si toglie, anche se la conferma fallisce", async () => {
    const { outsider, proposal, ticket } = await seed();
    const { and, eq } = await import("drizzle-orm");
    const { projectMembers, roles } = await import("@stubwise/db");
    const { confirmMailProposalWithMembers } = await import("../services/mail-proposals-decide.js");
    // Una proposta che FALLIRÀ: la task del commento non c'è più.
    await db
      .update(emailProposals)
      .set({ classification: { version: 2, summary: "s", actions: [{ type: "create_task", args: { title: "X", description: "", assigneeId: outsider.id, dueDate: null } }, { type: "comment_ticket", args: { ticketId: ticket.id, body: "b" } }] } })
      .where(eq(emailProposals.id, proposal.id));
    await db.delete(tickets).where(eq(tickets.id, ticket.id));
    const lead = await person("project_lead", "Lea");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: lead.id });
    const [developer] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    const result = await confirmMailProposalWithMembers(
      db,
      { id: lead.id, instancePermissions: new Set() },
      proposal.id,
      { addOutsiders: [outsider.id] },
      "it",
      () => {},
      // Un'altra persona promuove Dario a Developer mentre la conferma è in corso.
      async () => {
        await db.update(projectMembers).set({ roleId: developer!.id }).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsider.id)));
      },
    );
    expect(result).toMatchObject({ ok: true, status: "failed" });
    const rows = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsider.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.roleId).toBe(developer!.id);
  });
});

describe("review F2, punto 6 e review del renderer F2: outsiders e Contributor", () => {
  const post = (headers: { cookie: string }, url: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
  async function taskFor(proposalId: string, assigneeId: string) {
    const { eq } = await import("drizzle-orm");
    await db
      .update(emailProposals)
      .set({ classification: { version: 2, summary: "s", actions: [{ type: "create_task", args: { title: "X", description: "", assigneeId, dueDate: null } }] } })
      .where(eq(emailProposals.id, proposalId));
  }

  it("un full admin incaricato NON è un esterno (membro implicito): niente outsiders, si conferma senza aggiungere nessuno", async () => {
    const { ada, proposal } = await seed();
    await taskFor(proposal.id, adminId);
    const view = (await get(ada.headers, `/api/me/mail/proposals/${proposal.id}`)).json() as { outsiders: unknown[] };
    expect(view.outsiders).toEqual([]);
    // E un client che lo manda lo stesso in addOutsiders non lo fa Contributor.
    const lead = await person("project_lead", "Lea");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: lead.id });
    const res = await post(lead.headers, `/api/me/mail/proposals/${proposal.id}/confirm-with-members`, { addOutsiders: [adminId] });
    expect(res.json()).toMatchObject({ status: "confirmed" });
    const { and, eq } = await import("drizzle-orm");
    const { projectMembers } = await import("@stubwise/db");
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, adminId)))).toEqual([]);
  });

  it("addOutsiders accetta SOLO gli esterni veri della proposta: un altro id è invalid_selection, e nessuno entra", async () => {
    const { outsider, proposal } = await seed();
    await taskFor(proposal.id, outsider.id);
    const lead = await person("project_lead", "Lea");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: lead.id });
    const stranger = await person(null, "Zeno");
    const res = await post(lead.headers, `/api/me/mail/proposals/${proposal.id}/confirm-with-members`, { addOutsiders: [outsider.id, stranger.id] });
    expect(res.json()).toMatchObject({ code: "invalid_selection" });
    const { and, eq } = await import("drizzle-orm");
    const { projectMembers } = await import("@stubwise/db");
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, stranger.id)))).toEqual([]);
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsider.id)))).toEqual([]);
  });

  it("se la conferma LANCIA, i Contributor appena aggiunti si tolgono (finally)", async () => {
    const { outsider, proposal } = await seed();
    await taskFor(proposal.id, outsider.id);
    const lead = await person("project_lead", "Lea");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: lead.id });
    const { and, eq } = await import("drizzle-orm");
    const { projectMembers } = await import("@stubwise/db");
    const { confirmMailProposalWithMembers } = await import("../services/mail-proposals-decide.js");
    await expect(
      confirmMailProposalWithMembers(db, { id: lead.id, instancePermissions: new Set() }, proposal.id, { addOutsiders: [outsider.id] }, "it", () => {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsider.id)))).toEqual([]);
  });
});

describe("review F2, punto 7, lato server: «Quale progetto?» per chi vede solo un progetto incerto", () => {
  it("Zoe, destinataria e membro SOLO del secondo progetto incerto, la vede (coi soli suoi progetti) e sceglie il suo", async () => {
    const { proposal } = await seed();
    const { eq } = await import("drizzle-orm");
    const [beta] = await db.insert(projects).values({ name: "Beta", slug: `beta-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
    const zoe = await person(null, "Zoe");
    await addMember(app, beta!.id, zoe.id, "developer");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: zoe.id });
    await db.update(emailProposals).set({ classification: { version: 2, summary: "", actions: [], choose: { projectIds: [projectId, beta!.id] } } }).where(eq(emailProposals.id, proposal.id));
    const res = await get(zoe.headers, `/api/me/mail/proposals/${proposal.id}`);
    expect(res.statusCode).toBe(200);
    const view = res.json() as { projectId: string; actions: { type: string; args: { projectIds: string[] } }[] };
    expect(view.actions[0]!.args.projectIds).toEqual([beta!.id]);
    // Nemmeno l'id del progetto che Zoe non vede.
    expect(view.projectId).toBe(beta!.id);
    expect(JSON.stringify(view)).not.toContain(projectId);
    const chosen = await app.inject({ method: "POST", url: `/api/me/mail/proposals/${proposal.id}/choose-project`, headers: zoe.headers, payload: { projectId: beta!.id } });
    expect(chosen.json()).toEqual({ status: "moved", projectId: beta!.id });
  });

  it("NEGATIVO: chi non vede NESSUNO dei progetti incerti non la vede", async () => {
    const { proposal } = await seed();
    const { eq } = await import("drizzle-orm");
    const outsiderToAll = await person(null, "Ugo");
    await db.insert(emailProposalRecipients).values({ proposalId: proposal.id, userId: outsiderToAll.id });
    await db.update(emailProposals).set({ classification: { version: 2, summary: "", actions: [], choose: { projectIds: [projectId] } } }).where(eq(emailProposals.id, proposal.id));
    expect((await get(outsiderToAll.headers, `/api/me/mail/proposals/${proposal.id}`)).statusCode).toBe(404);
  });
});

