import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  backlogItems,
  backlogJobs,
  calendarEvents,
  comments,
  emailMessages,
  googleAccounts,
  googleWorkspaces,
  milestones,
  notificationDeliveries,
  notifications,
  projectDecisions,
  ticketEvents,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { GoogleProposalAction, GoogleProposalEvent } from "@stubwise/notifications";
import { createTicket } from "../db/tickets.js";
import type { Actor } from "./jobs.js";
import { answerGoogleProposal } from "./google-proposal.js";

/**
 * Test di `answerGoogleProposal` (fase 6, Task 11): per ciascuna delle sette
 * azioni, claim → mutazione → stato della riga sorgente, più le guardie
 * d'ingresso e i due nuovi errori (`target_gone`, `action_failed`). Segue lo
 * stesso stile di `pulse.test.ts` — Postgres reale via testcontainers, perché
 * quello che conta è un claim guardato e una transazione, cose che un fake
 * `Db` non saprebbe raccontare.
 */

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(notificationDeliveries);
  await db.delete(notifications);
  await db.delete(ticketEvents);
  await db.delete(comments);
  await db.delete(projectDecisions);
  await db.delete(milestones);
  await db.delete(backlogJobs);
  await db.delete(backlogItems);
  await db.delete(tickets);
  await db.delete(calendarEvents);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});

afterAll(async () => {
  await testDb.stop();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Un proprietario di casella: utente + workspace + account Google, per un progetto dato. */
async function seedOwner(): Promise<{ owner: Actor; projectId: string; accountId: string; mailboxEmail: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `owner-${randomUUID()}@acme.test`, passwordHash: "x", role: "member" })
    .returning({ id: users.id, role: users.role });
  const [workspace] = await db
    .insert(googleWorkspaces)
    .values({ name: "Acme", domains: ["acme.test"], clientId: "client-id", clientSecretEncrypted: "blob" })
    .returning({ id: googleWorkspaces.id });
  const mailboxEmail = `mailbox-${randomUUID()}@acme.test`;
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId: user!.id,
      workspaceId: workspace!.id,
      email: mailboxEmail,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  const { projectId } = await seedRepository(db);
  return { owner: { id: user!.id, role: user!.role }, projectId, accountId: account!.id, mailboxEmail };
}

/** Un secondo utente, non proprietario di nessuna casella: per il test 404. */
async function seedOther(): Promise<Actor> {
  const [user] = await db
    .insert(users)
    .values({ email: `other-${randomUUID()}@acme.test`, passwordHash: "x", role: "admin" })
    .returning({ id: users.id, role: users.role });
  return { id: user!.id, role: user!.role };
}

/** Un ticket APERTO nel progetto dato. */
async function seedTicket(projectId: string, overrides: Partial<Parameters<typeof createTicket>[1]> = {}) {
  return createTicket(db, {
    projectId,
    title: "Ticket di test",
    type: "bug",
    priority: "medium",
    source: "manual",
    ...overrides,
  });
}

/** Riga `email_messages` `proposed`, per l'account dato. */
async function seedEmailRow(accountId: string, projectId: string): Promise<{ id: string; gmailMessageId: string; threadId: string }> {
  const gmailMessageId = `m-${randomUUID()}`;
  const threadId = `t-${randomUUID()}`;
  const [row] = await db
    .insert(emailMessages)
    .values({
      accountId,
      gmailMessageId,
      threadId,
      fromAddress: "laura@cliente.test",
      fromName: "Laura",
      subject: "Rinviamo il rilascio?",
      receivedAt: new Date("2026-09-07T08:14:00.000Z"),
      projectId,
      status: "proposed",
    })
    .returning({ id: emailMessages.id });
  return { id: row!.id, gmailMessageId, threadId };
}

/** Riga `calendar_events` pronta per una proposta di milestone. */
async function seedCalendarRow(accountId: string, projectId: string): Promise<{ id: string; googleEventId: string }> {
  const googleEventId = `e-${randomUUID()}`;
  const [row] = await db
    .insert(calendarEvents)
    .values({
      accountId,
      googleEventId,
      title: "Demo col cliente",
      startsAt: new Date("2026-09-20T10:00:00.000Z"),
      status: "confirmed",
      projectId,
      fingerprint: "2026-09-20 demo col cliente",
    })
    .returning({ id: calendarEvents.id });
  return { id: row!.id, googleEventId };
}

/** Un evento `google.proposal` realistico, con le opzioni/azioni date. */
function proposalEvent(
  proposalId: string,
  source: "email" | "calendar",
  options: { label: string }[],
  actions: GoogleProposalAction[],
): GoogleProposalEvent {
  return {
    kind: "google.proposal",
    proposalId,
    source,
    messageUrl: "https://mail.google.com/mail/u/x/#all/t",
    signal: "request",
    from: "Laura <laura@cliente.test>",
    subject: "Rinviamo il rilascio?",
    question: "Laura scrive a proposito di «Rinviamo il rilascio?». Come diamo seguito?",
    options,
    actions,
    recommendedIndex: 0,
    allowFreeText: false,
  };
}

/**
 * Pubblica una notifica `google.proposal` per il proprietario, GIÀ legata
 * alla riga sorgente data (come fa `publishProposal` nella stessa
 * transazione, Task 10) — qui in due passi separati perché il test compone
 * le azioni a mano, senza passare dal builder del worker.
 */
async function seedProposal(args: {
  ownerId: string;
  sourceId: string;
  source: "email" | "calendar";
  actions: GoogleProposalAction[];
  options?: { label: string }[];
  status?: "open" | "handled" | "snoozed";
}): Promise<{ notificationId: string; proposalId: string }> {
  const proposalId = randomUUID();
  const options = args.options ?? args.actions.map((a) => ({ label: a.type }));
  const status = args.status ?? "open";
  const [row] = await db
    .insert(notifications)
    .values({
      userId: args.ownerId,
      kind: "google.proposal",
      status,
      handledAt: status === "handled" ? new Date() : null,
      event: proposalEvent(proposalId, args.source, options, args.actions) as unknown as Record<string, unknown>,
    })
    .returning({ id: notifications.id });
  if (args.source === "email") {
    await db
      .update(emailMessages)
      .set({ proposalNotificationId: row!.id })
      .where(eq(emailMessages.id, args.sourceId));
  } else {
    await db
      .update(calendarEvents)
      .set({ proposalNotificationId: row!.id })
      .where(eq(calendarEvents.id, args.sourceId));
  }
  return { notificationId: row!.id, proposalId };
}

async function readNotification(id: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row;
}

async function readEmailMessage(id: string) {
  const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
  return row;
}

async function readCalendarEvent(id: string) {
  const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
  return row;
}

/** Note `slack_update` accodate per la notifica data (vedi `pulse.test.ts`). */
async function readNotes(notificationId: string): Promise<string[]> {
  const rows = await db
    .select({ event: notificationDeliveries.event })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.notificationId, notificationId),
        eq(notificationDeliveries.channel, "slack_update"),
      ),
    );
  return rows.map((row) => String((row.event as { note?: unknown }).note ?? ""));
}

// ---------------------------------------------------------------------------
// Guardie d'ingresso
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — guardie d'ingresso", () => {
  it("notifica inesistente → not_found", async () => {
    const { owner } = await seedOwner();
    const result = await answerGoogleProposal(db, {
      notificationId: randomUUID(),
      actor: owner,
      optionIndex: 0,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("notifica di un altro kind → not_found (il servizio è solo di google.proposal)", async () => {
    const { owner } = await seedOwner();
    const [row] = await db
      .insert(notifications)
      .values({ userId: owner.id, kind: "job.failed", status: "open", event: { kind: "job.failed" } })
      .returning({ id: notifications.id });
    const result = await answerGoogleProposal(db, { notificationId: row!.id, actor: owner, optionIndex: 0 });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("utente diverso dal proprietario (admin incluso) → not_found, mai forbidden", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "ignore" }],
    });
    const other = await seedOther();

    const result = await answerGoogleProposal(db, { notificationId, actor: other, optionIndex: 0 });
    expect(result).toEqual({ ok: false, error: "not_found" });
    // Nessun claim è avvenuto: la riga resta aperta per il vero proprietario.
    expect((await readNotification(notificationId))!.status).toBe("open");
  });

  it("indice fuori range → invalid_answer, niente claim", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "ignore" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 5 });
    expect(result).toEqual({ ok: false, error: "invalid_answer" });
    expect((await readNotification(notificationId))!.status).toBe("open");
  });

  it("indice assente → invalid_answer", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "ignore" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner });
    expect(result).toEqual({ ok: false, error: "invalid_answer" });
  });

  it("riga già gestita → already_handled con chi l'ha gestita", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "ignore" }],
    });
    await db
      .update(notifications)
      .set({ status: "handled", handledAt: new Date(), handledByUserId: owner.id })
      .where(eq(notifications.id, notificationId));

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result).toEqual({
      ok: false,
      error: "already_handled",
      handledBy: expect.objectContaining({ id: owner.id }),
    });
  });

  it("claim perso fra il pre-check e il claim → already_handled (corsa simulata)", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "ignore" }],
    });
    // La riga passa aperta il pre-check; qualcun altro (un secondo tab) la
    // chiude fra il pre-check e il claim vero e proprio non è simulabile senza
    // un secondo processo — qui si verifica lo stesso ESITO chiudendo la riga
    // subito prima della chiamata: il claim (guardato su `status <> handled`)
    // non trova nulla da chiudere.
    await db
      .update(notifications)
      .set({ status: "handled", handledAt: new Date(), handledByUserId: owner.id })
      .where(eq(notifications.id, notificationId));

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("already_handled");
  });
});

// ---------------------------------------------------------------------------
// create_backlog_item
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — create_backlog_item", () => {
  it("accoda il job intake e chiude la riga actioned", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [
        { type: "create_backlog_item", projectId, title: "Export CSV", body: "Da un'email di Laura." },
        { type: "ignore" },
      ],
      options: [{ label: "Apri una voce di backlog: Export CSV" }, { label: "Non fare nulla" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result).toEqual({ ok: true, changedNotificationIds: [notificationId] });

    const jobs = await db.select().from(backlogJobs).where(eq(backlogJobs.projectId, projectId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("intake");

    const msg = await readEmailMessage(email.id);
    expect(msg!.status).toBe("actioned");
    expect(msg!.outcome).toMatchObject({ type: "backlog_item" });

    expect((await readNotification(notificationId))!.status).toBe("handled");
    const notes = await readNotes(notificationId);
    expect(notes[0]).toContain("Apri una voce di backlog: Export CSV");
  });

  it("progetto sparito → target_gone, riga failed e riproponibile", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const ghostProjectId = randomUUID();
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "create_backlog_item", projectId: ghostProjectId, title: "X" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result).toEqual({ ok: false, error: "target_gone" });

    const msg = await readEmailMessage(email.id);
    expect(msg!.status).toBe("failed");
    expect(msg!.error).toContain("target_gone");
    // La notifica resta chiusa (il claim è avvenuto): non si ripropone da sola.
    expect((await readNotification(notificationId))!.status).toBe("handled");
  });
});

// ---------------------------------------------------------------------------
// create_milestone
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — create_milestone", () => {
  it("crea la milestone (fonte calendario) e chiude l'outcome, mai lo `status`", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const event = await seedCalendarRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: event.id,
      source: "calendar",
      actions: [
        { type: "create_milestone", projectId, name: "Demo col cliente", dueDate: "2026-09-20" },
        { type: "ignore" },
      ],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(true);

    const [ms] = await db.select().from(milestones).where(eq(milestones.projectId, projectId));
    expect(ms!.name).toBe("Demo col cliente");

    const row = await readCalendarEvent(event.id);
    expect(row!.outcome).toMatchObject({ type: "milestone" });
    // `calendar_events.status` è quello di GOOGLE: non viene mai toccato da
    // un'azione confermata (il CHECK lo rifiuterebbe comunque).
    expect(row!.status).toBe("confirmed");
  });

  it("milestone già esistente → outcome «exists», NESSUN errore", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    await db.insert(milestones).values({ projectId, name: "Demo col cliente" });
    const event = await seedCalendarRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: event.id,
      source: "calendar",
      actions: [{ type: "create_milestone", projectId, name: "Demo col cliente" }, { type: "ignore" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(true);

    const rows = await db.select().from(milestones).where(eq(milestones.projectId, projectId));
    expect(rows).toHaveLength(1); // nessuna seconda milestone creata

    const row = await readCalendarEvent(event.id);
    expect(row!.outcome).toEqual({ type: "exists" });
  });
});

// ---------------------------------------------------------------------------
// update_ticket
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — update_ticket", () => {
  it("applica la patch con l'attore giusto e registra l'evento", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const ticket = await seedTicket(projectId);
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [
        { type: "update_ticket", ticketId: ticket.id, status: "in_progress", priority: "high" },
        { type: "ignore" },
      ],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(true);

    const [updated] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(updated!.status).toBe("in_progress");
    expect(updated!.priority).toBe("high");

    const events = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticket.id));
    expect(events.every((e) => e.actorId === owner.id)).toBe(true);
    expect(events.map((e) => e.kind).sort()).toEqual(["priority_changed", "status_changed"]);
  });

  it("ticket sparito → target_gone", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const ghostTicketId = randomUUID();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "update_ticket", ticketId: ghostTicketId, status: "done" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result).toEqual({ ok: false, error: "target_gone" });
    expect((await readEmailMessage(email.id))!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// comment_ticket
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — comment_ticket", () => {
  it("aggiunge un commento di sistema col link al thread Gmail", async () => {
    const { owner, projectId, accountId, mailboxEmail } = await seedOwner();
    const ticket = await seedTicket(projectId);
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [
        { type: "comment_ticket", ticketId: ticket.id, body: "Laura chiede conferma della data." },
        { type: "ignore" },
      ],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(true);

    const [comment] = await db.select().from(comments).where(eq(comments.ticketId, ticket.id));
    expect(comment!.authorType).toBe("system");
    expect(comment!.authorId).toBeNull();
    expect(comment!.body).toContain("Laura chiede conferma della data.");
    expect(comment!.body).toContain(encodeURIComponent(mailboxEmail));
    expect(comment!.body).toContain(email.threadId);
  });

  it("ticket sparito → target_gone", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const ghostTicketId = randomUUID();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "comment_ticket", ticketId: ghostTicketId, body: "x" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result).toEqual({ ok: false, error: "target_gone" });
  });
});

// ---------------------------------------------------------------------------
// record_decision
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — record_decision", () => {
  it("registra la decisione da un TEMPLATE (mai la prosa dell'azione), sourceKey email:<messageId>", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const ticket = await seedTicket(projectId);
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [
        {
          type: "record_decision",
          projectId,
          ticketId: ticket.id,
          title: "Titolo scritto dal modello",
          decision: "Testo generato dal modello, non deve comparire nel registro.",
        },
        { type: "ignore" },
      ],
      options: [{ label: "Registra la decisione: Rinviare il rilascio" }, { label: "Non fare nulla" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(true);

    const rows = await db.select().from(projectDecisions).where(eq(projectDecisions.projectId, projectId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe("email");
    expect(row.sourceKey).toBe(`email:${email.gmailMessageId}`);
    expect(row.ticketId).toBe(ticket.id);
    expect(row.decidedByUserId).toBe(owner.id);
    // Il TEMPLATE porta l'etichetta dell'opzione (già composta), non la prosa
    // libera dell'azione.
    expect(row.decision).toContain("Registra la decisione: Rinviare il rilascio");
    expect(JSON.stringify(row)).not.toContain("Testo generato dal modello");
  });

  it("sourceKey idempotente: una seconda `recordDecision` con la stessa chiave non duplica", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "record_decision", projectId, title: "T", decision: "D" }],
    });
    await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });

    // La notifica è già chiusa: una seconda `answerGoogleProposal` sullo
    // stesso claim non è possibile (è esattamente il punto del claim). Qui si
    // verifica l'idempotenza dello STESSO scrittore (`recordDecision`, mai
    // ridichiarato) con la stessa chiave, come farebbe un secondo tick di un
    // ipotetico retry.
    const { recordDecision } = await import("@stubwise/db");
    const again = await recordDecision(db, {
      projectId,
      source: "email",
      sourceKey: `email:${email.gmailMessageId}`,
      title: "Titolo diverso",
      decision: "Decisione diversa",
    });
    expect(again).toBeNull();

    const rows = await db.select().from(projectDecisions).where(eq(projectDecisions.projectId, projectId));
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// choose_project
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — choose_project", () => {
  it("riassegna il progetto e riporta status a new (riclassificazione)", async () => {
    const { owner, projectId: originalProjectId, accountId } = await seedOwner();
    const { projectId: chosenProjectId } = await seedRepository(db);
    const email = await seedEmailRow(accountId, originalProjectId);
    // Ambiguo: `project_id` nullo, due candidati.
    await db.update(emailMessages).set({ projectId: null }).where(eq(emailMessages.id, email.id));
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [
        { type: "choose_project", projectId: chosenProjectId },
        { type: "choose_project", projectId: originalProjectId },
        { type: "ignore" },
      ],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(true);

    const msg = await readEmailMessage(email.id);
    expect(msg!.projectId).toBe(chosenProjectId);
    expect(msg!.status).toBe("new");
    // Nessun'altra mutazione: nessuna decisione, nessun job, nessun outcome.
    expect(msg!.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ignore
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — ignore", () => {
  it("email: status → ignored", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      actions: [{ type: "ignore" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result.ok).toBe(true);
    expect((await readEmailMessage(email.id))!.status).toBe("ignored");
  });

  it("calendario: outcome → ignored, status di Google intatto", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const event = await seedCalendarRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: event.id,
      source: "calendar",
      actions: [{ type: "create_milestone", projectId, name: "X" }, { type: "ignore" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 1 });
    expect(result.ok).toBe(true);
    const row = await readCalendarEvent(event.id);
    expect(row!.outcome).toEqual({ type: "ignored" });
    expect(row!.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// action_failed — imprevisto DOPO il claim
// ---------------------------------------------------------------------------

describe("answerGoogleProposal — action_failed", () => {
  it("un imprevisto durante l'azione marca la riga failed e riproponibile (mai un crash)", async () => {
    const { owner, projectId, accountId } = await seedOwner();
    const email = await seedEmailRow(accountId, projectId);
    const { notificationId } = await seedProposal({
      ownerId: owner.id,
      sourceId: email.id,
      source: "email",
      // Una data non valida fa esplodere `new Date(...).toISOString()`
      // DENTRO `createMilestone`, dopo il claim: l'imprevisto che
      // `action_failed` esiste per coprire.
      actions: [{ type: "create_milestone", projectId, name: "X", dueDate: "non-una-data" }],
    });

    const result = await answerGoogleProposal(db, { notificationId, actor: owner, optionIndex: 0 });
    expect(result).toEqual({ ok: false, error: "action_failed" });

    const msg = await readEmailMessage(email.id);
    expect(msg!.status).toBe("failed");
    expect(msg!.error).toBeTruthy();
    // Nessuna milestone è stata creata: la transazione dell'azione è rientrata.
    expect(await db.select().from(milestones).where(eq(milestones.projectId, projectId))).toHaveLength(0);
    // La notifica resta comunque CHIUSA (claim avvenuto): non riparte da sola.
    expect((await readNotification(notificationId))!.status).toBe("handled");
  });
});
