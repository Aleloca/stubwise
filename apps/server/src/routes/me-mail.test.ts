import { randomUUID } from "node:crypto";
import {
  calendarEvents,
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projects,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * PAGINA POSTA (fase 6, Task 12; fase 6b, Task 8): `GET /api/me/mail` (lista
 * UNIFICATA email+calendario), `GET /api/me/mail/summary` (contatori) e
 * `POST /api/me/mail/:source/:id/repropose`.
 *
 * Fase 6b: le righe EMAIL vengono ora da `email_proposals` (il FIGLIO, una
 * riga per progetto), non più da `email_messages` (il padre) da sola — un
 * messaggio con tre proposte produce TRE righe. `id` per una riga email è
 * `email_proposals.id`; il calendario resta uno a uno, invariato.
 *
 * Il filo conduttore di questi test è lo stesso di `me-google.test.ts`:
 * **`user_id` è nel WHERE di ogni rotta**, verificato guardando che l'admin —
 * NON solo un membro qualunque — non veda né tocchi la posta del member.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie, adminId, memberId } = await seedUsers(app));
}, 120_000);

afterEach(async () => {
  // `email_proposals` cascata da `email_messages` (ON DELETE CASCADE su
  // entrambe le FK): non va ripulita a sé.
  await db.delete(notifications);
  await db.delete(calendarEvents);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Un Workspace + una casella Google collegata dall'utente dato. */
async function seedAccount(userId: string): Promise<{ accountId: string; email: string }> {
  const [workspace] = await db
    .insert(googleWorkspaces)
    .values({ name: "Acme", domains: ["acme.test"], clientId: "client-id", clientSecretEncrypted: "blob" })
    .returning({ id: googleWorkspaces.id });
  const email = `mailbox-${randomUUID()}@acme.test`;
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId,
      workspaceId: workspace!.id,
      email,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  return { accountId: account!.id, email };
}

/** Un progetto minimo, senza repository: basta come FK per `email_proposals.project_id`. */
async function seedProject(name = "Progetto di test"): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `slug-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedEmail(
  accountId: string,
  overrides: Partial<typeof emailMessages.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(emailMessages)
    .values({
      accountId,
      gmailMessageId: `m-${randomUUID()}`,
      threadId: `t-${randomUUID()}`,
      fromAddress: "laura@cliente.test",
      subject: "Rinviamo il rilascio?",
      receivedAt: new Date("2026-09-07T08:14:00.000Z"),
      status: "new",
      ...overrides,
    })
    .returning({ id: emailMessages.id });
  return row!.id;
}

/**
 * Un FIGLIO `email_proposals`: la riga che ora alimenta la pagina Posta lato
 * email. `classification` porta almeno `signal`, come scrive
 * `writeClassification` (`apps/worker/src/google/classify.ts`).
 */
async function seedProposal(
  emailMessageId: string,
  projectId: string,
  overrides: Partial<typeof emailProposals.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(emailProposals)
    .values({
      emailMessageId,
      projectId,
      status: "classified",
      classification: { signal: "decision", summary: "riassunto", proposals: [], recommendedIndex: 0 },
      ...overrides,
    })
    .returning({ id: emailProposals.id });
  return row!.id;
}

async function seedCalendar(
  accountId: string,
  overrides: Partial<typeof calendarEvents.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(calendarEvents)
    .values({
      accountId,
      googleEventId: `e-${randomUUID()}`,
      title: "Demo col cliente",
      startsAt: new Date("2026-09-20T10:00:00.000Z"),
      status: "confirmed",
      fingerprint: "2026-09-20 demo col cliente",
      ...overrides,
    })
    .returning({ id: calendarEvents.id });
  return row!.id;
}

function getMail(cookie: string, query = "") {
  return app.inject({ method: "GET", url: `/api/me/mail${query}`, headers: { cookie } });
}

function getSummary(cookie: string) {
  return app.inject({ method: "GET", url: "/api/me/mail/summary", headers: { cookie } });
}

function repropose(cookie: string, source: "email" | "calendar", id: string) {
  return app.inject({
    method: "POST",
    url: `/api/me/mail/${source}/${id}/repropose`,
    headers: { cookie },
  });
}

describe("GET /api/me/mail", () => {
  it("senza sessione: 401", async () => {
    expect((await getMail("")).statusCode).toBe(401);
  });

  it("fonde posta e calendario in una lista sola, ordinata per data desc", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const first = await seedEmail(accountId, { subject: "Prima", receivedAt: new Date("2026-09-01T09:00:00.000Z") });
    await seedProposal(first, projectId);
    await seedCalendar(accountId, { title: "Seconda", startsAt: new Date("2026-09-05T09:00:00.000Z") });
    const third = await seedEmail(accountId, { subject: "Terza", receivedAt: new Date("2026-09-10T09:00:00.000Z") });
    await seedProposal(third, projectId);

    const res = await getMail(adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { title: string | null; source: string }[]; nextCursor: string | null };
    expect(body.items.map((i) => i.title)).toEqual(["Terza", "Seconda", "Prima"]);
    expect(body.items.map((i) => i.source)).toEqual(["email", "calendar", "email"]);
  });

  it("un messaggio email senza proposte figlie non compare (nessuna riga senza email_proposals)", async () => {
    const { accountId } = await seedAccount(adminId);
    await seedEmail(accountId, { subject: "Ancora da classificare" });

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: { source: string }[] }).items;
    expect(items.filter((i) => i.source === "email")).toEqual([]);
  });

  it("un utente NON vede la posta di un altro, admin compreso", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    await seedProposal(messageId, projectId);
    await seedCalendar(accountId);

    const res = await getMail(adminCookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("il progetto risolto compare con nome, il segnale e lo stato normalizzato del calendario", async () => {
    const { accountId } = await seedAccount(adminId);
    const { projectId } = await seedRepository(db);
    const messageId = await seedEmail(accountId);
    await seedProposal(messageId, projectId, {
      status: "classified",
      classification: { signal: "decision", summary: "x", proposals: [], recommendedIndex: 0 },
    });
    await seedCalendar(accountId, { projectId, outcome: { type: "milestone", milestoneId: randomUUID() } });

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: Record<string, unknown>[] }).items;
    const emailItem = items.find((i) => i.source === "email")!;
    const calendarItem = items.find((i) => i.source === "calendar")!;
    expect(emailItem.projectName).toBe("Progetto di test");
    expect(emailItem.signal).toBe("decision");
    expect(emailItem.status).toBe("classified");
    expect(calendarItem.status).toBe("actioned");
    expect(calendarItem.reproposable).toBe(false);
  });

  it("un messaggio con TRE proposte produce TRE righe, ciascuna col proprio progetto", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectA = await seedProject("Alpha");
    const projectB = await seedProject("Bravo");
    const projectC = await seedProject("Charlie");
    const messageId = await seedEmail(accountId, { subject: "Recap multi-progetto" });
    await seedProposal(messageId, projectA);
    await seedProposal(messageId, projectB);
    await seedProposal(messageId, projectC);

    const res = await getMail(adminCookie);
    expect(res.statusCode).toBe(200);
    const items = (
      res.json() as { items: { id: string; title: string | null; projectId: string; projectName: string }[] }
    ).items;
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.title === "Recap multi-progetto")).toBe(true);
    expect(new Set(items.map((i) => i.projectId))).toEqual(new Set([projectA, projectB, projectC]));
    expect(new Set(items.map((i) => i.projectName))).toEqual(new Set(["Alpha", "Bravo", "Charlie"]));
    // Ogni riga ha un id diverso (quello del FIGLIO, non del messaggio padre).
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(items.every((i) => i.id !== messageId)).toBe(true);
  });

  it("filtro project: solo le righe di quel progetto, fra le proposte dello stesso messaggio", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectA = await seedProject("Alpha");
    const projectB = await seedProject("Bravo");
    const messageId = await seedEmail(accountId, { subject: "Recap" });
    const proposalA = await seedProposal(messageId, projectA);
    await seedProposal(messageId, projectB);

    const res = await getMail(adminCookie, `?project=${projectA}`);
    const items = (res.json() as { items: { id: string; projectId: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(proposalA);
    expect(items[0]!.projectId).toBe(projectA);
  });

  it("filtro status: normalizza anche il calendario (failed/ignored)", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const failedMessage = await seedEmail(accountId);
    await seedProposal(failedMessage, projectId, { status: "failed", error: "boom" });
    await seedCalendar(accountId, { outcome: { type: "failed", error: "kaboom" } });
    await seedCalendar(accountId, { outcome: { type: "ignored" } });

    const res = await getMail(adminCookie, "?status=failed");
    const items = (res.json() as { items: { source: string; error: string | null; reproposable: boolean }[] }).items;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.reproposable)).toBe(true);
    expect(items.find((i) => i.source === "calendar")?.error).toBe("kaboom");
  });

  it("filtro status=new: nessuna riga email (i figli nascono già `classified`)", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    await seedProposal(messageId, projectId);

    const res = await getMail(adminCookie, "?status=new");
    const items = (res.json() as { items: { source: string }[] }).items;
    expect(items.filter((i) => i.source === "email")).toEqual([]);
  });

  it("filtro account: limita alla sola casella indicata", async () => {
    const { accountId: a1 } = await seedAccount(adminId);
    const { accountId: a2 } = await seedAccount(adminId);
    const projectId = await seedProject();
    const m1 = await seedEmail(a1, { subject: "Da a1" });
    await seedProposal(m1, projectId);
    const m2 = await seedEmail(a2, { subject: "Da a2" });
    await seedProposal(m2, projectId);

    const res = await getMail(adminCookie, `?account=${a1}`);
    const items = (res.json() as { items: { title: string | null }[] }).items;
    expect(items.map((i) => i.title)).toEqual(["Da a1"]);
  });

  it("paginazione: cursore keyset fra le due sorgenti", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    for (let i = 0; i < 3; i++) {
      const messageId = await seedEmail(accountId, {
        subject: `E${i}`,
        receivedAt: new Date(2026, 8, 1 + i, 9, 0, 0),
      });
      await seedProposal(messageId, projectId);
    }
    for (let i = 0; i < 3; i++) {
      await seedCalendar(accountId, {
        title: `C${i}`,
        startsAt: new Date(2026, 8, 1 + i, 10, 0, 0),
      });
    }

    const first = await getMail(adminCookie, "?limit=3");
    const firstBody = first.json() as { items: { title: string | null }[]; nextCursor: string | null };
    expect(firstBody.items).toHaveLength(3);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await getMail(adminCookie, `?limit=3&cursor=${encodeURIComponent(firstBody.nextCursor!)}`);
    const secondBody = second.json() as { items: { title: string | null }[]; nextCursor: string | null };
    expect(secondBody.items).toHaveLength(3);

    const seenTitles = new Set([...firstBody.items, ...secondBody.items].map((i) => i.title));
    expect(seenTitles.size).toBe(6);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("cursore malformato: 400", async () => {
    const res = await getMail(adminCookie, "?cursor=not-a-cursor");
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/me/mail/summary", () => {
  it("senza sessione: 401", async () => {
    expect((await getSummary("")).statusCode).toBe(401);
  });

  it("conta i FIGLI (email_proposals) e le righe failed/ignored del calendario", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const failedMessage = await seedEmail(accountId);
    await seedProposal(failedMessage, projectId, { status: "failed" });
    const ignoredMessage = await seedEmail(accountId);
    await seedProposal(ignoredMessage, projectId, { status: "ignored" });
    await seedCalendar(accountId, { outcome: { type: "failed", error: "x" } });
    await db.insert(notifications).values({
      userId: adminId,
      kind: "google.proposal",
      status: "open",
      event: { kind: "google.proposal", proposalId: randomUUID() },
    });

    const res = await getSummary(adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { openProposals: number; failed: number; ignored: number };
    expect(body.openProposals).toBe(1);
    expect(body.failed).toBe(2);
    expect(body.ignored).toBe(1);
  });

  it("un messaggio con più figli failed conta ognuno separatamente", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectA = await seedProject("Alpha");
    const projectB = await seedProject("Bravo");
    const messageId = await seedEmail(accountId);
    await seedProposal(messageId, projectA, { status: "failed" });
    await seedProposal(messageId, projectB, { status: "failed" });

    const res = await getSummary(adminCookie);
    const body = res.json() as { failed: number };
    expect(body.failed).toBe(2);
  });

  it("un altro utente vede i propri contatori, non quelli altrui", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    await seedProposal(messageId, projectId, { status: "failed" });

    const res = await getSummary(adminCookie);
    const body = res.json() as { failed: number };
    expect(body.failed).toBe(0);
  });
});

describe("POST /api/me/mail/:source/:id/repropose", () => {
  it("senza sessione: 401", async () => {
    expect((await repropose("", "email", randomUUID())).statusCode).toBe(401);
  });

  it("email failed → torna classified, errore/outcome/notifica azzerati", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId, { status: "failed", error: "boom" });

    const res = await repropose(adminCookie, "email", proposalId);
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, proposalId));
    expect(row!.status).toBe("classified");
    expect(row!.error).toBeNull();
    expect(row!.outcome).toBeNull();
    expect(row!.proposalNotificationId).toBeNull();
  });

  it("email ignored → torna classified", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId, { status: "ignored" });

    const res = await repropose(adminCookie, "email", proposalId);
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, proposalId));
    expect(row!.status).toBe("classified");
  });

  it("email non riproponibile (classified/proposed/actioned) → 409", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId, { status: "proposed" });

    const res = await repropose(adminCookie, "email", proposalId);
    expect(res.statusCode).toBe(409);
  });

  it("riproponi UNA proposta non tocca le sorelle dello stesso messaggio", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectA = await seedProject("Alpha");
    const projectB = await seedProject("Bravo");
    const messageId = await seedEmail(accountId);
    const proposalA = await seedProposal(messageId, projectA, { status: "failed", error: "boom" });
    const proposalB = await seedProposal(messageId, projectB, { status: "proposed" });

    const before = await db.select().from(emailProposals).where(eq(emailProposals.id, proposalB));

    const res = await repropose(adminCookie, "email", proposalA);
    expect(res.statusCode).toBe(200);

    const after = await db.select().from(emailProposals).where(eq(emailProposals.id, proposalB));
    expect(after[0]!.status).toBe(before[0]!.status);
    expect(after[0]!.updatedAt).toEqual(before[0]!.updatedAt);
  });

  it("calendario failed → outcome e proposal_notification_id azzerati", async () => {
    const { accountId } = await seedAccount(adminId);
    const { projectId } = await seedRepository(db);
    const id = await seedCalendar(accountId, {
      projectId,
      outcome: { type: "failed", error: "boom" },
      proposalNotificationId: null,
    });

    const res = await repropose(adminCookie, "calendar", id);
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
    expect(row!.outcome).toBeNull();
    expect(row!.proposalNotificationId).toBeNull();
  });

  it("calendario cancellato da Google → non riproponibile, 409", async () => {
    const { accountId } = await seedAccount(adminId);
    const id = await seedCalendar(accountId, { status: "cancelled", outcome: { type: "cancelled" } });

    const res = await repropose(adminCookie, "calendar", id);
    expect(res.statusCode).toBe(409);
  });

  it("id di un altro utente (admin compreso): 404, nessuna riga toccata", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId, { status: "failed" });

    const res = await repropose(adminCookie, "email", proposalId);
    expect(res.statusCode).toBe(404);

    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, proposalId));
    expect(row!.status).toBe("failed");
  });

  it("id inesistente: 404", async () => {
    const res = await repropose(adminCookie, "email", randomUUID());
    expect(res.statusCode).toBe(404);
  });
});
