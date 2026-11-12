import { randomUUID } from "node:crypto";
import {
  emailMessages,
  emailProposalRecipients,
  emailProposals,
  googleAccounts,
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
  await db.insert(emailProposalRecipients).values([
    { proposalId: proposal!.id, userId: ada.id },
    { proposalId: proposal!.id, userId: bruno.id },
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
