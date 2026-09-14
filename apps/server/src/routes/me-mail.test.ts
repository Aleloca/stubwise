import { randomBytes, randomUUID } from "node:crypto";
import {
  calendarEvents,
  emailBodies,
  emailMessages,
  emailProposals,
  encrypt,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projects,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { GoogleApiError } from "@stubwise/google";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers, sessionCookie } from "../test/fixtures.js";
import type { MailOriginalClient } from "./me-mail.js";

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
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: ENCRYPTION_KEY.toString("base64") });
  ({ adminCookie, memberCookie, adminId, memberId } = await seedUsers(app));
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
    .values({
      name: "Acme",
      domains: ["acme.test"],
      clientId: "client-id",
      clientSecretEncrypted: encrypt("client-secret", ENCRYPTION_KEY),
    })
    .returning({ id: googleWorkspaces.id });
  const email = `mailbox-${randomUUID()}@acme.test`;
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId,
      workspaceId: workspace!.id,
      email,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: encrypt("refresh-token", ENCRYPTION_KEY),
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

/**
 * Fase 6c (fix di review, Task 3): un padre `email_messages` in stato «da
 * smistare» (`classify.ts`, `EmailTriageClassification` — marcatore
 * `triage: true`, NESSUN figlio in `email_proposals`). Di default ATTIVO
 * (`status: 'classified'`, come appena scritto da `writeClassification`,
 * prima che il poller pubblichi la notifica): gli `overrides` coprono anche
 * lo stato PUBBLICATO (`status: 'proposed'`, `proposalNotificationId`
 * valorizzato) e quello CHIUSO con «nessuno di questi» (`status: 'ignored'`,
 * `outcome: { type: 'triage_dismissed' }`).
 */
async function seedTriage(
  accountId: string,
  overrides: Partial<typeof emailMessages.$inferInsert> = {},
): Promise<string> {
  return seedEmail(accountId, {
    status: "classified",
    signal: "decision",
    classification: { triage: true, signal: "decision", summary: "riassunto", suggestedProjectIds: [] },
    ...overrides,
  });
}

function getMail(cookie: string, query = "") {
  return app.inject({ method: "GET", url: `/api/me/mail${query}`, headers: { cookie } });
}

function getSummary(cookie: string) {
  return app.inject({ method: "GET", url: "/api/me/mail/summary", headers: { cookie } });
}

function repropose(cookie: string, source: "email" | "calendar" | "email_triage", id: string) {
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

  it("filtro source=email: niente calendario, gli smistamenti restano (sono posta)", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const mail = await seedEmail(accountId, { subject: "Una email", receivedAt: new Date("2026-09-01T09:00:00.000Z") });
    await seedProposal(mail, projectId);
    await seedTriage(accountId, { subject: "Uno smistamento" });
    await seedCalendar(accountId, { title: "Un appuntamento", startsAt: new Date("2026-11-30T09:00:00.000Z") });

    const res = await getMail(adminCookie, "?source=email");
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: { title: string | null; source: string }[] }).items;
    expect(items.map((i) => i.title).sort()).toEqual(["Una email", "Uno smistamento"]);
    expect(items.every((i) => i.source === "email")).toBe(true);
  });

  it("filtro source=calendar: solo appuntamenti, nemmeno gli smistamenti", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const mail = await seedEmail(accountId, { subject: "Una email" });
    await seedProposal(mail, projectId);
    await seedTriage(accountId, { subject: "Uno smistamento" });
    await seedCalendar(accountId, { title: "Un appuntamento" });

    const res = await getMail(adminCookie, "?source=calendar");
    const items = (res.json() as { items: { title: string | null; source: string }[] }).items;
    expect(items.map((i) => i.title)).toEqual(["Un appuntamento"]);
  });

  it("senza il filtro la lista resta fusa: il web non cambia comportamento", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    const mail = await seedEmail(accountId, { subject: "Una email", receivedAt: new Date("2026-09-01T09:00:00.000Z") });
    await seedProposal(mail, projectId);
    await seedCalendar(accountId, { title: "Un appuntamento", startsAt: new Date("2026-11-30T09:00:00.000Z") });

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: { title: string | null }[] }).items;
    expect(items.map((i) => i.title)).toEqual(["Un appuntamento", "Una email"]);
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

describe("GET /api/me/mail — smistamento (fase 6c, fix di review Task 3)", () => {
  it("un messaggio in smistamento ATTIVO compare con kind 'triage', nessun progetto", async () => {
    const { accountId } = await seedAccount(adminId);
    const messageId = await seedTriage(accountId, { subject: "Rinnovo contratto?" });

    const res = await getMail(adminCookie);
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: messageId,
      source: "email",
      kind: "triage",
      projectId: null,
      projectName: null,
      status: "classified",
      signal: "decision",
    });
  });

  it("un messaggio in smistamento PUBBLICATO (status: proposed) compare comunque", async () => {
    const { accountId } = await seedAccount(adminId);
    const [notification] = await db
      .insert(notifications)
      .values({
        userId: adminId,
        kind: "google.proposal",
        status: "open",
        event: { kind: "google.proposal", proposalId: randomUUID() },
      })
      .returning({ id: notifications.id });
    await seedTriage(accountId, { status: "proposed", proposalNotificationId: notification!.id });

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: { kind: string; status: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "triage", status: "proposed" });
  });

  it("un messaggio riaccodato da choose_project (status: new) NON compare, anche con classification.triage stantia", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    await seedTriage(accountId, {
      status: "new",
      projectId,
      scopeProjectIds: [projectId],
      proposalNotificationId: null,
    });

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: unknown[] }).items;
    expect(items).toEqual([]);
  });

  it("uno smistamento CHIUSO con «nessuno di questi» compare (stato archiviato)", async () => {
    const { accountId } = await seedAccount(adminId);
    await seedTriage(accountId, { status: "ignored", outcome: { type: "triage_dismissed" } });

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: { kind: string; status: string; outcome: unknown }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("triage");
    expect(items[0]!.status).toBe("ignored");
    expect(items[0]!.outcome).toEqual({ type: "triage_dismissed" });
  });

  it("un ignored GENERICO (nessun segnale, non smistamento) non compare come triage", async () => {
    const { accountId } = await seedAccount(adminId);
    await seedTriage(accountId, {
      status: "ignored",
      classification: { signal: "none", summary: "nulla di rilevante", proposals: [], recommendedIndex: 0 },
      outcome: null,
    });

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: unknown[] }).items;
    expect(items).toEqual([]);
  });

  it("filtro project: uno smistamento non ha mai progetto, quindi non compare mai", async () => {
    const { accountId } = await seedAccount(adminId);
    const projectId = await seedProject();
    await seedTriage(accountId);

    const res = await getMail(adminCookie, `?project=${projectId}`);
    const items = (res.json() as { items: { kind: string }[] }).items;
    expect(items.filter((i) => i.kind === "triage")).toEqual([]);
  });

  it("un altro utente non vede lo smistamento di qualcun altro (ACL invariata)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedTriage(accountId);

    const res = await getMail(adminCookie);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("il calendario resta esattamente come prima: nessuna riga di calendario diventa 'triage'", async () => {
    const { accountId } = await seedAccount(adminId);
    await seedCalendar(accountId);

    const res = await getMail(adminCookie);
    const items = (res.json() as { items: { source: string; kind: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "calendar", kind: "calendar" });
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

  describe("fase 6c (fix di review Task 3): coerenza col contenuto della lista", () => {
    it("il contatore openProposals coincide con la riga di smistamento ATTIVA mostrata dalla lista", async () => {
      const { accountId } = await seedAccount(adminId);
      const [notification] = await db
        .insert(notifications)
        .values({
          userId: adminId,
          kind: "google.proposal",
          status: "open",
          event: { kind: "google.proposal", proposalId: randomUUID() },
        })
        .returning({ id: notifications.id });
      await seedTriage(accountId, { status: "proposed", proposalNotificationId: notification!.id });

      const [summaryRes, mailRes] = await Promise.all([getSummary(adminCookie), getMail(adminCookie)]);
      const summary = summaryRes.json() as { openProposals: number };
      const items = (mailRes.json() as { items: { kind: string; status: string }[] }).items;
      expect(summary.openProposals).toBe(1);
      expect(items.filter((i) => i.kind === "triage" && i.status === "proposed")).toHaveLength(1);
    });

    it("failed conta anche uno smistamento FALLITO", async () => {
      const { accountId } = await seedAccount(adminId);
      await seedTriage(accountId, { status: "failed", error: "target_gone" });

      const res = await getSummary(adminCookie);
      const body = res.json() as { failed: number };
      expect(body.failed).toBe(1);
    });

    it("ignored conta anche uno smistamento CHIUSO con «nessuno di questi»", async () => {
      const { accountId } = await seedAccount(adminId);
      await seedTriage(accountId, { status: "ignored", outcome: { type: "triage_dismissed" } });

      const res = await getSummary(adminCookie);
      const body = res.json() as { ignored: number };
      expect(body.ignored).toBe(1);
    });

    it("un ignored generico (nessun segnale) non gonfia il contatore di smistamento", async () => {
      const { accountId } = await seedAccount(adminId);
      await seedTriage(accountId, {
        status: "ignored",
        classification: { signal: "none", summary: "nulla", proposals: [], recommendedIndex: 0 },
        outcome: null,
      });

      const res = await getSummary(adminCookie);
      const body = res.json() as { ignored: number };
      expect(body.ignored).toBe(0);
    });
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

describe("POST /api/me/mail/email_triage/:id/repropose (fase 6c, fix di review Task 3)", () => {
  it("uno smistamento CHIUSO con «nessuno di questi» → torna classified, outcome/errore azzerati, notifica non riaperta", async () => {
    const { accountId } = await seedAccount(adminId);
    const [notification] = await db
      .insert(notifications)
      .values({
        userId: adminId,
        kind: "google.proposal",
        status: "handled",
        handledAt: new Date(),
        event: { kind: "google.proposal", proposalId: randomUUID() },
      })
      .returning({ id: notifications.id });
    const messageId = await seedTriage(accountId, {
      status: "ignored",
      outcome: { type: "triage_dismissed" },
      proposalNotificationId: notification!.id,
    });

    const res = await repropose(adminCookie, "email_triage", messageId);
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(row!.status).toBe("classified");
    expect(row!.outcome).toBeNull();
    expect(row!.error).toBeNull();
    // Il prossimo tick del poller deve poter riclamare la riga: la
    // condizione di claim (`status = 'classified' AND
    // proposal_notification_id IS NULL`) deve tornare vera.
    expect(row!.proposalNotificationId).toBeNull();

    const [notificationRow] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, notification!.id));
    expect(notificationRow!.status).toBe("handled");
  });

  it("uno smistamento ATTIVO (classified/proposed) → 409, non riproponibile", async () => {
    const { accountId } = await seedAccount(adminId);
    const messageId = await seedTriage(accountId, { status: "classified" });

    const res = await repropose(adminCookie, "email_triage", messageId);
    expect(res.statusCode).toBe(409);
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(row!.status).toBe("classified");
  });

  it("uno smistamento FALLITO (status: failed) → 409, riproponibile solo se dismissed", async () => {
    const { accountId } = await seedAccount(adminId);
    const messageId = await seedTriage(accountId, { status: "failed", error: "target_gone" });

    const res = await repropose(adminCookie, "email_triage", messageId);
    expect(res.statusCode).toBe(409);
  });

  it("un ignored generico (nessun triage_dismissed) → 409: non è uno smistamento chiuso", async () => {
    const { accountId } = await seedAccount(adminId);
    const messageId = await seedTriage(accountId, {
      status: "ignored",
      classification: { signal: "none", summary: "nulla", proposals: [], recommendedIndex: 0 },
      outcome: null,
    });

    const res = await repropose(adminCookie, "email_triage", messageId);
    expect(res.statusCode).toBe(409);
  });

  it("id di un altro utente (admin compreso): 404, nessuna riga toccata", async () => {
    const { accountId } = await seedAccount(memberId);
    const messageId = await seedTriage(accountId, { status: "ignored", outcome: { type: "triage_dismissed" } });

    const res = await repropose(adminCookie, "email_triage", messageId);
    expect(res.statusCode).toBe(404);

    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(row!.status).toBe("ignored");
  });

  it("id inesistente: 404", async () => {
    const res = await repropose(adminCookie, "email_triage", randomUUID());
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Fase 7b, Task 6-7: il dettaglio di un'email e la rilettura dell'originale.
// ---------------------------------------------------------------------------

/** Un GmailMessage finto, con corpo e allegati a scelta. */
function fakeGmailMessage(
  overrides: {
    headers?: Record<string, string>;
    text?: string;
    html?: string;
    attachments?: { filename: string; mimeType: string }[];
  } = {},
) {
  const parts: { mimeType: string; filename?: string; body: { data?: string; attachmentId?: string; size?: number } }[] = [];
  if (overrides.text) parts.push({ mimeType: "text/plain", body: { data: Buffer.from(overrides.text).toString("base64url") } });
  if (overrides.html) parts.push({ mimeType: "text/html", body: { data: Buffer.from(overrides.html).toString("base64url") } });
  for (const attachment of overrides.attachments ?? []) {
    parts.push({ mimeType: attachment.mimeType, filename: attachment.filename, body: { attachmentId: "a1", size: 1000 } });
  }
  return {
    id: "gmail-msg-1",
    threadId: "t1",
    labelIds: [],
    snippet: "",
    historyId: null,
    internalDate: null,
    headers: { from: "laura@cliente.test", to: "me@acme.test", subject: "Oggetto originale", ...overrides.headers },
    payload: { mimeType: "multipart/mixed", parts },
  };
}

const FAKE_TOKENS = { accessToken: "at", expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null };

describe("GET /api/me/mail/:source/:id (fase 7b, Task 6)", () => {
  function getDetail(cookie: string, source: "email" | "email_triage", id: string) {
    return app.inject({ method: "GET", url: `/api/me/mail/${source}/${id}`, headers: { cookie } });
  }

  it("senza sessione: 401", async () => {
    expect((await getDetail("", "email", randomUUID())).statusCode).toBe(401);
  });

  it("source: email — l'estratto viene dal PADRE, condiviso fra proposte sorelle", async () => {
    const { accountId, email } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId, {
      subject: "Rinviamo il rilascio?",
      fromAddress: "laura@cliente.test",
      fromName: "Laura",
      toAddresses: ["me@acme.test"],
      textExcerpt: "Possiamo spostare il rilascio di una settimana?",
    });
    const proposalId = await seedProposal(messageId, projectId);

    const res = await getDetail(memberCookie, "email", proposalId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: proposalId,
      source: "email",
      accountId,
      accountEmail: email,
      from: "Laura <laura@cliente.test>",
      subject: "Rinviamo il rilascio?",
      textExcerpt: "Possiamo spostare il rilascio di una settimana?",
    });
    expect(body.url).toContain(encodeURIComponent(email));
  });

  it("un messaggio senza text_excerpt (NULL) non rompe la risposta", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId, { textExcerpt: null });
    const proposalId = await seedProposal(messageId, projectId);

    const res = await getDetail(memberCookie, "email", proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().textExcerpt).toBeNull();
  });

  it("source: email_triage — l'id è già email_messages.id, nessun figlio", async () => {
    const { accountId } = await seedAccount(memberId);
    const messageId = await seedTriage(accountId, { subject: "Rinnovo contratto?" });

    const res = await getDetail(memberCookie, "email_triage", messageId);
    expect(res.statusCode).toBe(200);
    expect(res.json().subject).toBe("Rinnovo contratto?");
  });

  it("ACL: un admin non vede il dettaglio della posta di un member (404, non 403)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId);

    const res = await getDetail(adminCookie, "email", proposalId);
    expect(res.statusCode).toBe(404);
  });

  it("id inesistente: 404", async () => {
    expect((await getDetail(memberCookie, "email", randomUUID())).statusCode).toBe(404);
  });
});

describe("GET /api/me/mail/:source/:id/original (fase 7b, Task 7)", () => {
  const fakeGoogleClient: MailOriginalClient = {
    refreshAccessToken: async () => FAKE_TOKENS,
    getMessageFull: async () => fakeGmailMessage(),
  };
  let appOriginal: FastifyInstance;
  let memberCookieOriginal: string;
  let adminCookieOriginal: string;

  // Nessun `seedUsers(appOriginal)`: il setup dell'admin è un passo UNA
  // TANTUM a livello di database (`instance_settings`), già consumato dal
  // `beforeAll` in cima al file — sullo STESSO `db`. Qui basta un login coi
  // due utenti già creati, per un cookie valido su QUESTA app.
  beforeAll(async () => {
    appOriginal = buildApp({
      db,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      mailGoogleClient: fakeGoogleClient,
    });
    const memberLogin = await appOriginal.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "member@example.com", password: "password-member" },
    });
    memberCookieOriginal = sessionCookie(memberLogin);
    const adminLogin = await appOriginal.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "password-sicura" },
    });
    adminCookieOriginal = sessionCookie(adminLogin);
  }, 60_000);

  afterAll(async () => {
    await appOriginal.close();
  });

  // Ogni test riparte dal client finto DI DEFAULT: senza questo, un test che
  // fa fallire `refreshAccessToken`/`getMessageFull` lascerebbe quella
  // funzione rotta anche per il test successivo (`fakeGoogleClient` è UN
  // oggetto condiviso, mutato in place — non ricreato a ogni `it`).
  beforeEach(() => {
    fakeGoogleClient.refreshAccessToken = async () => FAKE_TOKENS;
    fakeGoogleClient.getMessageFull = async () => fakeGmailMessage();
  });

  function getOriginal(cookie: string, source: "email" | "email_triage", id: string) {
    return appOriginal.inject({ method: "GET", url: `/api/me/mail/${source}/${id}/original`, headers: { cookie } });
  }

  it("senza sessione: 401", async () => {
    expect((await getOriginal("", "email", randomUUID())).statusCode).toBe(401);
  });

  it("successo: corpo grezzo (non ripulito) e allegati, e l'ESTRATTO non si tocca", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId, { subject: "Rinviamo il rilascio?" });
    const proposalId = await seedProposal(messageId, projectId);
    fakeGoogleClient.getMessageFull = async () =>
      fakeGmailMessage({
        text: "Corpo completo.\n--\nLaura, Cliente SRL",
        attachments: [{ filename: "contratto.pdf", mimeType: "application/pdf" }],
      });

    const res = await getOriginal(memberCookieOriginal, "email", proposalId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bodyText).toContain("Laura, Cliente SRL");
    expect(body.attachments).toEqual([{ filename: "contratto.pdf", mimeType: "application/pdf" }]);

    // Dalla 0076 il corpo SI conserva (in `email_bodies`), ma `text_excerpt`
    // no: è ciò che la CLASSIFICAZIONE ha letto, e questa rilettura non deve
    // riscriverlo. I due non vanno sullo stesso piano — è la ragione per cui
    // la cache vive in una tabella a sé.
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(row?.textExcerpt ?? "").not.toContain("Laura, Cliente SRL");
  });

  it("il corpo HTML si legge SANIFICATO — <script> sparisce, la formattazione resta (fase 9, Task 4)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId);
    fakeGoogleClient.getMessageFull = async () =>
      fakeGmailMessage({
        html: '<p><b>Ciao</b></p><script>alert(document.cookie)</script><img src="https://tracker.example/pixel.gif" onerror="alert(1)">',
      });

    const res = await getOriginal(memberCookieOriginal, "email", proposalId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bodyHtml).toContain("<b>Ciao</b>");
    expect(body.bodyHtml).not.toContain("<script");
    expect(body.bodyHtml).not.toContain("onerror");
    // L'immagine remota non deve partire da sola.
    expect(body.bodyHtml).not.toMatch(/\ssrc="https:\/\/tracker\.example/);
  });

  it("nessuna parte HTML nel messaggio: bodyHtml null, mai una stringa vuota", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId);
    fakeGoogleClient.getMessageFull = async () => fakeGmailMessage({ text: "Solo testo." });

    const res = await getOriginal(memberCookieOriginal, "email", proposalId);
    expect(res.json().bodyHtml).toBeNull();
  });

  it("messaggio cancellato su Gmail (404/410): 409 message_gone, l'estratto resta intatto", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId, { textExcerpt: "estratto originale" });
    const proposalId = await seedProposal(messageId, projectId);
    fakeGoogleClient.getMessageFull = async () => {
      throw new GoogleApiError({ api: "gmail.messages.get.full", status: 404, code: "not_found", reason: "notFound" });
    };

    const res = await getOriginal(memberCookieOriginal, "email", proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("message_gone");

    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(row!.textExcerpt).toBe("estratto originale");
  });

  it("token scaduto (invalid_grant sul refresh): 409 token_expired", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId);
    fakeGoogleClient.refreshAccessToken = async () => {
      throw new GoogleApiError({ api: "oauth.token.refresh_token", status: 400, code: "invalid_grant", reason: "invalid_grant" });
    };

    const res = await getOriginal(memberCookieOriginal, "email", proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("token_expired");
  });

  it("Google irraggiungibile: 502 google_unavailable", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId);
    fakeGoogleClient.getMessageFull = async () => {
      throw new Error("network unreachable");
    };

    const res = await getOriginal(memberCookieOriginal, "email", proposalId);
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("google_unavailable");
  });

  it("ACL: un admin non può rileggere la posta di un member (404 prima di qualunque chiamata a Google)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId);
    let called = false;
    fakeGoogleClient.getMessageFull = async () => {
      called = true;
      return fakeGmailMessage();
    };

    const res = await getOriginal(adminCookieOriginal, "email", proposalId);
    expect(res.statusCode).toBe(404);
    expect(called).toBe(false);
  });
});

/**
 * La CACHE del corpo originale (migrazione 0076, «la posta si legge per
 * conversazione» §1, Task 2). Il fastidio da cui nasce: ogni tap su «Mostra
 * l'originale» ri-scaricava il messaggio da Gmail — si usciva dalla
 * schermata, si rientrava, e lo ri-scaricava.
 */
describe("GET /api/me/mail/:source/:id/original — la cache (Task 2)", () => {
  const fakeGoogleClient: MailOriginalClient = {
    refreshAccessToken: async () => FAKE_TOKENS,
    getMessageFull: async () => fakeGmailMessage(),
  };
  let appCache: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    appCache = buildApp({
      db,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      mailGoogleClient: fakeGoogleClient,
    });
    const login = await appCache.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "member@example.com", password: "password-member" },
    });
    cookie = sessionCookie(login);
  }, 60_000);

  afterAll(async () => {
    await appCache.close();
  });

  beforeEach(() => {
    fakeGoogleClient.refreshAccessToken = async () => FAKE_TOKENS;
    fakeGoogleClient.getMessageFull = async () => fakeGmailMessage();
  });

  function getOriginal(id: string) {
    return appCache.inject({ method: "GET", url: `/api/me/mail/email/${id}/original`, headers: { cookie } });
  }

  /** Un messaggio con la sua proposta, pronto da rileggere. */
  async function seedReadable(): Promise<{ messageId: string; proposalId: string }> {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const messageId = await seedEmail(accountId);
    const proposalId = await seedProposal(messageId, projectId);
    return { messageId, proposalId };
  }

  it("la PRIMA lettura chiama Gmail e scrive la cache; la SECONDA non lo chiama affatto", async () => {
    const { messageId, proposalId } = await seedReadable();
    let calls = 0;
    fakeGoogleClient.getMessageFull = async () => {
      calls += 1;
      return fakeGmailMessage({ text: "Corpo completo.", html: "<p>Corpo completo.</p>" });
    };

    const first = await getOriginal(proposalId);
    expect(first.statusCode).toBe(200);
    expect(first.json().bodySource).toBe("google");
    expect(calls).toBe(1);

    const [cached] = await db
      .select()
      .from(emailBodies)
      .where(eq(emailBodies.emailMessageId, messageId));
    expect(cached?.bodyText).toBe("Corpo completo.");

    const second = await getOriginal(proposalId);
    expect(second.statusCode).toBe(200);
    // La spia resta a 1: la seconda lettura non ha toccato Google.
    expect(calls).toBe(1);
    expect(second.json().bodySource).toBe("cache");
    expect(second.json().bodyText).toBe("Corpo completo.");
    expect(second.json().fetchedAt).toBe(cached!.fetchedAt.toISOString());
  });

  it("una lettura servita dalla cache non rinfresca nemmeno il token", async () => {
    // Il refresh è a monte della chiamata: guardare la cache DOPO averlo
    // fatto avrebbe risparmiato solo metà del lavoro.
    const { proposalId } = await seedReadable();
    await getOriginal(proposalId);

    let refreshes = 0;
    fakeGoogleClient.refreshAccessToken = async () => {
      refreshes += 1;
      return FAKE_TOKENS;
    };
    const res = await getOriginal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(refreshes).toBe(0);
  });

  it("in cache l'HTML sta GREZZO, e ne esce SANIFICATO a ogni lettura", async () => {
    // Il punto del design §1: se si conservasse il sanificato, ogni riga
    // resterebbe congelata alla versione del filtro che l'ha scritta.
    const { messageId, proposalId } = await seedReadable();
    fakeGoogleClient.getMessageFull = async () =>
      fakeGmailMessage({
        html: '<p><b>Ciao</b></p><script>alert(document.cookie)</script><img src="https://tracker.example/pixel.gif" onerror="alert(1)">',
      });

    await getOriginal(proposalId);

    const [cached] = await db
      .select()
      .from(emailBodies)
      .where(eq(emailBodies.emailMessageId, messageId));
    // GREZZO in colonna: lo `<script>` è ancora lì, ed è voluto.
    expect(cached?.bodyHtml).toContain("<script>");
    expect(cached?.bodyHtml).toContain("onerror");

    // SANIFICATO in risposta, sia al primo giro sia servito da cache.
    const res = await getOriginal(proposalId);
    expect(res.json().bodySource).toBe("cache");
    expect(res.json().bodyHtml).toContain("<b>Ciao</b>");
    expect(res.json().bodyHtml).not.toContain("<script");
    expect(res.json().bodyHtml).not.toContain("onerror");
    expect(res.json().bodyHtml).not.toMatch(/\ssrc="https:\/\/tracker\.example/);
  });

  it("una cache scritta con HTML ostile esce sanificata anche se la riga c'era già", async () => {
    // La riga può essere stata scritta da una versione precedente del
    // filtro, o a mano: la difesa non è nel momento della scrittura.
    const { messageId, proposalId } = await seedReadable();
    await db.insert(emailBodies).values({
      emailMessageId: messageId,
      bodyHtml: '<p>Ciao</p><script>alert(1)</script><a href="javascript:alert(2)">link</a>',
    });

    const res = await getOriginal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().bodyHtml).toContain("<p>Ciao</p>");
    expect(res.json().bodyHtml).not.toContain("<script");
    expect(res.json().bodyHtml).not.toContain("javascript:");
  });

  it("cancellare il messaggio porta via la cache (CASCADE): la lettura dopo torna a Gmail", async () => {
    const { messageId, proposalId } = await seedReadable();
    await getOriginal(proposalId);
    expect(
      await db.select().from(emailBodies).where(eq(emailBodies.emailMessageId, messageId)),
    ).toHaveLength(1);

    await db.delete(emailMessages).where(eq(emailMessages.id, messageId));
    expect(
      await db.select().from(emailBodies).where(eq(emailBodies.emailMessageId, messageId)),
    ).toHaveLength(0);
  });

  it("una riga di cache già presente vince sulla chiamata a Google", async () => {
    const { messageId, proposalId } = await seedReadable();
    await db.insert(emailBodies).values({ emailMessageId: messageId, bodyText: "riga preesistente" });

    let called = false;
    fakeGoogleClient.getMessageFull = async () => {
      called = true;
      return fakeGmailMessage();
    };

    const res = await getOriginal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().bodyText).toBe("riga preesistente");
    expect(called).toBe(false);
  });

  it("se la SCRITTURA in cache FALLISCE, la risposta arriva lo stesso (una riga di log, non un 502)", async () => {
    // La cache è un'ottimizzazione: a quel punto il corpo è già in mano, e
    // far fallire la risposta per un problema della copia sarebbe il baratto
    // sbagliato. Il fallimento si produce DAVVERO — un `db` che rifiuta
    // l'insert su `email_bodies` e inoltra tutto il resto — invece di
    // simularlo con un conflitto che `onConflictDoNothing` assorbirebbe
    // senza mai entrare nel `catch`.
    const brokenDb = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === emailBodies) {
              return {
                values: () => ({
                  onConflictDoNothing: () => Promise.reject(new Error("disco pieno")),
                }),
              };
            }
            return (Reflect.get(target, prop, receiver) as (t: unknown) => unknown).call(target, table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    const appBroken = buildApp({
      db: brokenDb,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      mailGoogleClient: fakeGoogleClient,
    });
    try {
      const login = await appBroken.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "member@example.com", password: "password-member" },
      });
      const brokenCookie = sessionCookie(login);
      const { messageId, proposalId } = await seedReadable();
      fakeGoogleClient.getMessageFull = async () => fakeGmailMessage({ text: "Corpo completo." });

      const res = await appBroken.inject({
        method: "GET",
        url: `/api/me/mail/email/${proposalId}/original`,
        headers: { cookie: brokenCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().bodyText).toBe("Corpo completo.");
      // Ha risposto da Google, e la cache è rimasta vuota: la prossima
      // lettura ritenterà, che è il degrado giusto.
      expect(res.json().bodySource).toBe("google");
      expect(
        await db.select().from(emailBodies).where(eq(emailBodies.emailMessageId, messageId)),
      ).toHaveLength(0);
    } finally {
      await appBroken.close();
    }
  });

  it("il messaggio cancellato su Gmail resta un 409, e NON scrive una riga di cache vuota", async () => {
    const { messageId, proposalId } = await seedReadable();
    fakeGoogleClient.getMessageFull = async () => {
      throw new GoogleApiError({ api: "gmail.messages.get.full", status: 404, code: "not_found", reason: "notFound" });
    };

    const res = await getOriginal(proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("message_gone");
    expect(
      await db.select().from(emailBodies).where(eq(emailBodies.emailMessageId, messageId)),
    ).toHaveLength(0);
  });

  it("casella DA RICOLLEGARE con la cache piena: 200 dalla copia, non 409 (fix di review)", async () => {
    // È il caso in cui la copia serve DI PIÙ, ed era l'unico in cui non
    // funzionava: la lettura della cache stava dopo
    // `loadGoogleAccountCredentials`, quindi un token revocato o un blob non
    // decifrabile faceva rispondere `account_unavailable` anche con il corpo
    // già in mano. Senza il fix questo test dà 409.
    const { messageId, proposalId } = await seedReadable();
    fakeGoogleClient.getMessageFull = async () => fakeGmailMessage({ text: "Corpo completo." });
    await getOriginal(proposalId); // riempie la cache

    // Ora la casella diventa inutilizzabile: il refresh token non è più
    // decifrabile con la chiave d'istanza (è ciò che
    // `loadGoogleAccountCredentials` restituisce `null`).
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    await db
      .update(googleAccounts)
      .set({ refreshTokenEncrypted: "blob-non-decifrabile" })
      .where(eq(googleAccounts.id, row!.accountId));

    let called = false;
    fakeGoogleClient.getMessageFull = async () => {
      called = true;
      return fakeGmailMessage();
    };

    const res = await getOriginal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().bodySource).toBe("cache");
    expect(res.json().bodyText).toBe("Corpo completo.");
    expect(called).toBe(false);
  });

  it("casella da ricollegare SENZA cache: resta 409 account_unavailable", async () => {
    // L'altra metà del fix: senza una copia da servire, il cancello delle
    // credenziali è ancora quello di prima.
    const { messageId, proposalId } = await seedReadable();
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    await db
      .update(googleAccounts)
      .set({ refreshTokenEncrypted: "blob-non-decifrabile" })
      .where(eq(googleAccounts.id, row!.accountId));

    const res = await getOriginal(proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("account_unavailable");
  });

  it("messaggio CANCELLATO da Gmail con la cache piena: si risponde dalla copia, non `message_gone`", async () => {
    // Cambio di comportamento DELIBERATO su un errore che era documentato
    // (vedi il docblock della rotta): la copia non mente su cosa è —
    // `bodySource: "cache"` e la data — e negare un testo che abbiamo,
    // perché qualcuno ha cancellato il messaggio DOPO che era arrivato,
    // sarebbe il baratto sbagliato.
    const { proposalId } = await seedReadable();
    fakeGoogleClient.getMessageFull = async () => fakeGmailMessage({ text: "Corpo completo." });
    await getOriginal(proposalId);

    fakeGoogleClient.getMessageFull = async () => {
      throw new GoogleApiError({ api: "gmail.messages.get.full", status: 404, code: "not_found", reason: "notFound" });
    };

    const res = await getOriginal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().bodySource).toBe("cache");
  });

  it("due proposte SORELLE dello stesso messaggio condividono la cache", async () => {
    // La chiave è il MESSAGGIO, non la proposta: il testo di un'email non
    // cambia da un figlio all'altro (fase 6b).
    const { accountId } = await seedAccount(memberId);
    const projectA = await seedProject();
    const projectB = await seedProject();
    const messageId = await seedEmail(accountId);
    const first = await seedProposal(messageId, projectA);
    const second = await seedProposal(messageId, projectB);

    let calls = 0;
    fakeGoogleClient.getMessageFull = async () => {
      calls += 1;
      return fakeGmailMessage({ text: "Una sola lettura." });
    };

    expect((await getOriginal(first)).json().bodySource).toBe("google");
    const fromSibling = await getOriginal(second);
    expect(fromSibling.json().bodySource).toBe("cache");
    expect(fromSibling.json().bodyText).toBe("Una sola lettura.");
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// «La posta si legge per conversazione» §4, Task 13 — le rotte per thread,
// ACCANTO a quelle per messaggio
// ---------------------------------------------------------------------------

describe("GET /api/me/mail/threads", () => {
  function getThreads(cookie: string, query = "") {
    return app.inject({ method: "GET", url: `/api/me/mail/threads${query}`, headers: { cookie } });
  }

  it("senza sessione: 401", async () => {
    expect((await getThreads("")).statusCode).toBe(401);
  });

  it("una riga per CONVERSAZIONE, con l'ultimo mittente, la sua data e quanti messaggi contiene", async () => {
    const { accountId, email } = await seedAccount(memberId);
    const threadId = `t-${randomUUID()}`;
    await seedEmail(accountId, {
      threadId,
      fromAddress: "laura@cliente.test",
      subject: "Rilascio",
      receivedAt: new Date("2026-09-01T08:00:00.000Z"),
    });
    await seedEmail(accountId, {
      threadId,
      fromAddress: "marco@cliente.test",
      subject: "Re: Rilascio",
      receivedAt: new Date("2026-09-03T08:00:00.000Z"),
      admitted: false,
    });

    const res = await getThreads(memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      threadId,
      accountEmail: email,
      // Dell'ULTIMO messaggio: è quello a cui si risponde.
      subject: "Re: Rilascio",
      lastFrom: "marco@cliente.test",
      lastReceivedAt: "2026-09-03T08:00:00.000Z",
      // Conta TUTTI i messaggi, contesto compreso: è la dimensione della
      // conversazione, non quanti hanno prodotto una proposta.
      messageCount: 2,
    });
  });

  it("un messaggio di CONTESTO non è una riga della lista: è dentro la conversazione", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedEmail(accountId, { threadId: `t-${randomUUID()}`, admitted: false });

    const res = await getThreads(memberCookie);
    // Un solo thread, non due righe.
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].messageCount).toBe(1);
  });

  it("le proposte APERTE si contano, quelle chiuse no", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const threadId = `t-${randomUUID()}`;
    const messageId = await seedEmail(accountId, { threadId });
    await seedProposal(messageId, projectId, { status: "proposed" });
    const other = await seedProject("Altro progetto");
    await seedProposal(messageId, other, { status: "actioned" });

    const res = await getThreads(memberCookie);
    expect(res.json().items[0].openProposals).toBe(1);
    // I progetti toccati ci sono entrambi: servono a non dedurli dall'oggetto.
    expect(res.json().items[0].projectNames.sort()).toEqual(["Altro progetto", "Progetto di test"]);
  });

  it("ACL: un admin non vede i thread di un member", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedEmail(accountId, { threadId: `t-${randomUUID()}` });

    expect((await getThreads(adminCookie)).json().items).toHaveLength(0);
  });

  it("paginazione: ordina per data dell'ULTIMO messaggio, e il cursore non salta né ripete", async () => {
    const { accountId } = await seedAccount(memberId);
    // Date MISTE apposta: il thread più vecchio ha il messaggio più recente.
    const vecchio = `t-vecchio-${randomUUID()}`;
    const recente = `t-recente-${randomUUID()}`;
    await seedEmail(accountId, { threadId: vecchio, receivedAt: new Date("2026-01-01T08:00:00.000Z") });
    await seedEmail(accountId, { threadId: vecchio, receivedAt: new Date("2026-09-10T08:00:00.000Z") });
    await seedEmail(accountId, { threadId: recente, receivedAt: new Date("2026-09-05T08:00:00.000Z") });

    const first = await getThreads(memberCookie, "?limit=1");
    expect(first.json().items[0].threadId).toBe(vecchio);
    expect(first.json().nextCursor).not.toBeNull();

    const second = await getThreads(
      memberCookie,
      `?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );
    expect(second.json().items[0].threadId).toBe(recente);
    expect(second.json().nextCursor).toBeNull();
  });

  it("cursore illeggibile: 400, non una pagina a caso", async () => {
    const res = await getThreads(memberCookie, "?cursor=non-un-cursore");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_cursor");
  });
});

describe("GET /api/me/mail/threads/:threadId", () => {
  function getThread(cookie: string, threadId: string) {
    return app.inject({
      method: "GET",
      url: `/api/me/mail/threads/${encodeURIComponent(threadId)}`,
      headers: { cookie },
    });
  }

  it("i messaggi in ORDINE, ciascuno con la sua provenienza — ammesso o contesto", async () => {
    const { accountId, email } = await seedAccount(memberId);
    const projectId = await seedProject();
    const threadId = `t-${randomUUID()}`;
    const primo = await seedEmail(accountId, {
      threadId,
      fromAddress: "laura@cliente.test",
      textExcerpt: "Prima email",
      receivedAt: new Date("2026-09-01T08:00:00.000Z"),
      admitted: false,
    });
    const ultimo = await seedEmail(accountId, {
      threadId,
      fromAddress: "marco@cliente.test",
      subject: "Re: Rilascio",
      textExcerpt: "Ultima email",
      receivedAt: new Date("2026-09-03T08:00:00.000Z"),
    });
    const proposalId = await seedProposal(ultimo, projectId);

    const res = await getThread(memberCookie, threadId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountEmail).toBe(email);
    expect(body.subject).toBe("Re: Rilascio");
    expect(body.url).toContain(encodeURIComponent(email));
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([primo, ultimo]);
    expect(body.messages[0]).toMatchObject({ admitted: false, textExcerpt: "Prima email", proposalIds: [] });
    expect(body.messages[1]).toMatchObject({ admitted: true, proposalIds: [proposalId] });
    // Una proposta ancora APERTA non si ripropone: non c'è niente da cui
    // ripartire. `reproposals` vuoto è il caso normale, non un difetto.
    expect(body.messages[0].reproposals).toEqual([]);
    expect(body.messages[1].reproposals).toEqual([]);
  });

  it("una proposta FALLITA si può riproporre dal suo messaggio; il contesto no", async () => {
    // È l'unica via di recupero da un dispatch fallito: senza questa voce,
    // per chi non apre una console la proposta è persa.
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject("Apollo");
    const threadId = `t-${randomUUID()}`;
    const contesto = await seedEmail(accountId, {
      threadId,
      receivedAt: new Date("2026-09-01T08:00:00.000Z"),
      admitted: false,
    });
    const ammesso = await seedEmail(accountId, {
      threadId,
      receivedAt: new Date("2026-09-03T08:00:00.000Z"),
    });
    const fallita = await seedProposal(ammesso, projectId, { status: "failed", error: "boom" });

    const body = (await getThread(memberCookie, threadId)).json();
    const byId = new Map<string, { reproposals: unknown[] }>(
      body.messages.map((m: { id: string; reproposals: unknown[] }) => [m.id, m]),
    );

    expect(byId.get(contesto)!.reproposals).toEqual([]);
    // Il nome del progetto c'è: col fan-out della 6b un messaggio può avere
    // più proposte, e senza il nome non si saprebbe quale si sta riaprendo.
    expect(byId.get(ammesso)!.reproposals).toEqual([
      { source: "email", id: fallita, projectName: "Apollo" },
    ]);
  });

  it("uno smistamento chiuso con «nessuno di questi» si può riaprire dal messaggio", async () => {
    // Il messaggio non ha figli: la riproposizione è sul messaggio stesso,
    // ed è la stessa condizione del ramo `email_triage` della rotta.
    const { accountId } = await seedAccount(memberId);
    const threadId = `t-${randomUUID()}`;
    const scartato = await seedEmail(accountId, {
      threadId,
      status: "ignored",
      outcome: { type: "triage_dismissed" },
    });

    const body = (await getThread(memberCookie, threadId)).json();
    expect(body.messages[0].reproposals).toEqual([
      { source: "email_triage", id: scartato, projectName: null },
    ]);
  });

  it("un messaggio ignorato SENZA smistamento non offre niente da riaprire", async () => {
    // La distinzione che il ramo `email_triage` della rotta fa e che qui
    // dev'essere identica: `ignored` per mancanza di segnale (`outcome`
    // nullo) non è uno smistamento scartato, e riaprirlo darebbe 409.
    const { accountId } = await seedAccount(memberId);
    const threadId = `t-${randomUUID()}`;
    await seedEmail(accountId, { threadId, status: "ignored", outcome: null });

    const body = (await getThread(memberCookie, threadId)).json();
    expect(body.messages[0].reproposals).toEqual([]);
  });

  it("ACL: il thread di un altro utente non esiste — 404, non 403", async () => {
    const { accountId } = await seedAccount(memberId);
    const threadId = `t-${randomUUID()}`;
    await seedEmail(accountId, { threadId });

    expect((await getThread(adminCookie, threadId)).statusCode).toBe(404);
  });

  it("thread inesistente: 404", async () => {
    expect((await getThread(memberCookie, "t-che-non-esiste")).statusCode).toBe(404);
  });

  it("⚠️ `/threads` NON viene catturata da `/:source/:id`: è registrata prima", async () => {
    // La trappola di CLAUDE.md: con l'ordine sbagliato, "threads" sarebbe
    // letto come `source` e la risposta sarebbe un errore di validazione.
    const res = await app.inject({
      method: "GET",
      url: "/api/me/mail/threads",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });
});
