import { randomUUID } from "node:crypto";
import {
  calendarEvents,
  emailMessages,
  googleAccounts,
  googleWorkspaces,
  notifications,
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
 * PAGINA POSTA (fase 6, Task 12): `GET /api/me/mail` (lista UNIFICATA
 * email+calendario), `GET /api/me/mail/summary` (contatori) e
 * `POST /api/me/mail/:source/:id/repropose`.
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
    await seedEmail(accountId, { subject: "Prima", receivedAt: new Date("2026-09-01T09:00:00.000Z") });
    await seedCalendar(accountId, { title: "Seconda", startsAt: new Date("2026-09-05T09:00:00.000Z") });
    await seedEmail(accountId, { subject: "Terza", receivedAt: new Date("2026-09-10T09:00:00.000Z") });

    const res = await getMail(adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { title: string | null; source: string }[]; nextCursor: string | null };
    expect(body.items.map((i) => i.title)).toEqual(["Terza", "Seconda", "Prima"]);
    expect(body.items.map((i) => i.source)).toEqual(["email", "calendar", "email"]);
  });

  it("un utente NON vede la posta di un altro, admin compreso", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedEmail(accountId);
    await seedCalendar(accountId);

    const res = await getMail(adminCookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("il progetto risolto compare con nome, il segnale e lo stato normalizzato del calendario", async () => {
    const { accountId } = await seedAccount(adminId);
    const { projectId } = await seedRepository(db);
    await seedEmail(accountId, {
      projectId,
      status: "classified",
      signal: "decision",
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

  it("filtro status: normalizza anche il calendario (failed/ignored)", async () => {
    const { accountId } = await seedAccount(adminId);
    await seedEmail(accountId, { status: "failed", error: "boom" });
    await seedCalendar(accountId, { outcome: { type: "failed", error: "kaboom" } });
    await seedCalendar(accountId, { outcome: { type: "ignored" } });

    const res = await getMail(adminCookie, "?status=failed");
    const items = (res.json() as { items: { source: string; error: string | null; reproposable: boolean }[] }).items;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.reproposable)).toBe(true);
    expect(items.find((i) => i.source === "calendar")?.error).toBe("kaboom");
  });

  it("filtro account: limita alla sola casella indicata", async () => {
    const { accountId: a1 } = await seedAccount(adminId);
    const { accountId: a2 } = await seedAccount(adminId);
    await seedEmail(a1, { subject: "Da a1" });
    await seedEmail(a2, { subject: "Da a2" });

    const res = await getMail(adminCookie, `?account=${a1}`);
    const items = (res.json() as { items: { title: string | null }[] }).items;
    expect(items.map((i) => i.title)).toEqual(["Da a1"]);
  });

  it("paginazione: cursore keyset fra le due sorgenti", async () => {
    const { accountId } = await seedAccount(adminId);
    for (let i = 0; i < 3; i++) {
      await seedEmail(accountId, {
        subject: `E${i}`,
        receivedAt: new Date(2026, 8, 1 + i, 9, 0, 0),
      });
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

  it("conta le proposte aperte e le righe failed/ignored su entrambe le sorgenti", async () => {
    const { accountId } = await seedAccount(adminId);
    await seedEmail(accountId, { status: "failed" });
    await seedEmail(accountId, { status: "ignored" });
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

  it("un altro utente vede i propri contatori, non quelli altrui", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedEmail(accountId, { status: "failed" });

    const res = await getSummary(adminCookie);
    const body = res.json() as { failed: number };
    expect(body.failed).toBe(0);
  });
});

describe("POST /api/me/mail/:source/:id/repropose", () => {
  it("senza sessione: 401", async () => {
    expect((await repropose("", "email", randomUUID())).statusCode).toBe(401);
  });

  it("email failed → torna new, l'errore si azzera", async () => {
    const { accountId } = await seedAccount(adminId);
    const id = await seedEmail(accountId, { status: "failed", error: "boom" });

    const res = await repropose(adminCookie, "email", id);
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
    expect(row!.status).toBe("new");
    expect(row!.error).toBeNull();
  });

  it("email ignored → torna new", async () => {
    const { accountId } = await seedAccount(adminId);
    const id = await seedEmail(accountId, { status: "ignored" });

    const res = await repropose(adminCookie, "email", id);
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
    expect(row!.status).toBe("new");
  });

  it("email non riproponibile (new/classified/proposed/actioned) → 409", async () => {
    const { accountId } = await seedAccount(adminId);
    const id = await seedEmail(accountId, { status: "proposed" });

    const res = await repropose(adminCookie, "email", id);
    expect(res.statusCode).toBe(409);
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
    const id = await seedEmail(accountId, { status: "failed" });

    const res = await repropose(adminCookie, "email", id);
    expect(res.statusCode).toBe(404);

    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
    expect(row!.status).toBe("failed");
  });

  it("id inesistente: 404", async () => {
    const res = await repropose(adminCookie, "email", randomUUID());
    expect(res.statusCode).toBe(404);
  });
});
