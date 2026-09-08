import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { aiJobs, notifications, users, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { createTicket } from "../db/tickets.js";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { propagateHandled, type PropagationTarget } from "./notifications-propagation.js";

/**
 * Test di `propagateHandled` — in particolare della generalizzazione
 * `{ eventKey }` (fase 6, Task 11): `pulseId` non è più un caso a parte, ma
 * UNA istanza di `eventKey` (`kind: "pulse"`) accanto a `google_proposal`. Il
 * comportamento OSSERVATO del pulse deve restare identico: questo file lo
 * verifica direttamente su `propagateHandled` (i test di `pulse.test.ts`
 * continuano a coprirlo indirettamente, via `proceedWithProposal`).
 */

let testDb: TestDb;
let db: Db;
let projectId: string;
let userA: string;
let userB: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  const [a] = await db
    .insert(users)
    .values({ email: `a-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: `b-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  userA = a!.id;
  userB = b!.id;
}, 120_000);

afterEach(async () => {
  await db.delete(notifications);
});

afterAll(async () => {
  await testDb.stop();
});

/** Una riga `project.pulse` col `pulseId` dato, per l'utente dato. */
async function seedPulseRow(userId: string, pulseId: string): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      projectId,
      kind: "project.pulse",
      status: "open",
      event: { kind: "project.pulse", pulseId, proposals: [] },
    })
    .returning({ id: notifications.id });
  return row!.id;
}

/** Una riga `google.proposal` col `proposalId` dato, per l'utente dato. */
async function seedGoogleProposalRow(userId: string, proposalId: string): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      projectId,
      kind: "google.proposal",
      status: "open",
      event: {
        kind: "google.proposal",
        proposalId,
        source: "email",
        messageUrl: "https://mail.google.com/mail/u/x/#all/t",
        signal: "request",
        from: "a@example.com",
        subject: "Oggetto",
        question: "Domanda?",
        options: [{ label: "Opzione" }],
        actions: [{ type: "ignore" }],
        allowFreeText: false,
      },
    })
    .returning({ id: notifications.id });
  return row!.id;
}

/** Stato attuale delle righe date. */
async function statusesOf(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ status: notifications.status })
    .from(notifications)
    .where(inArray(notifications.id, ids));
  return rows.map((r) => r.status);
}

describe("propagateHandled — eventKey generalizza pulseId (fase 6, Task 11)", () => {
  it("kind: pulse chiude TUTTE le copie con lo stesso pulseId, di destinatari diversi", async () => {
    const pulseId = randomUUID();
    const idA = await seedPulseRow(userA, pulseId);
    const idB = await seedPulseRow(userB, pulseId);

    const changed = await propagateHandled(
      db,
      { eventKey: { kind: "pulse", field: "pulseId", value: pulseId } },
      userA,
    );
    expect(changed.sort()).toEqual([idA, idB].sort());
    expect(await statusesOf([idA, idB])).toEqual(["handled", "handled"]);
  });

  it("kind: pulse NON tocca un pulseId diverso", async () => {
    const idKeep = await seedPulseRow(userA, randomUUID());
    const pulseId = randomUUID();
    const idTarget = await seedPulseRow(userA, pulseId);

    const changed = await propagateHandled(
      db,
      { eventKey: { kind: "pulse", field: "pulseId", value: pulseId } },
      userA,
    );
    expect(changed).toEqual([idTarget]);
    expect((await statusesOf([idKeep]))[0]).toBe("open");
  });

  it("è IDEMPOTENTE: una seconda chiamata sullo stesso pulseId non trova più righe da chiudere", async () => {
    const pulseId = randomUUID();
    await seedPulseRow(userA, pulseId);
    const target: PropagationTarget = { eventKey: { kind: "pulse", field: "pulseId", value: pulseId } };

    const first = await propagateHandled(db, target, userA);
    expect(first).toHaveLength(1);
    const second = await propagateHandled(db, target, userA);
    expect(second).toEqual([]);
  });

  it("kind: google_proposal chiude la copia con lo stesso proposalId", async () => {
    const proposalId = randomUUID();
    const id = await seedGoogleProposalRow(userA, proposalId);

    const changed = await propagateHandled(
      db,
      { eventKey: { kind: "google_proposal", field: "proposalId", value: proposalId } },
      userA,
    );
    expect(changed).toEqual([id]);
    expect((await statusesOf([id]))[0]).toBe("handled");
  });

  it("ISOLAMENTO PER KIND: un pulseId e un proposalId dallo stesso valore non si scavalcano", async () => {
    const sharedValue = randomUUID();
    const pulseRowId = await seedPulseRow(userA, sharedValue);
    const proposalRowId = await seedGoogleProposalRow(userA, sharedValue);

    const changed = await propagateHandled(
      db,
      { eventKey: { kind: "google_proposal", field: "proposalId", value: sharedValue } },
      userA,
    );
    expect(changed).toEqual([proposalRowId]);
    // La riga del pulse, che porta lo STESSO valore ma sotto `pulseId` e kind
    // `project.pulse`, resta intatta: il filtro su `kind` nella query è la
    // CORRETTEZZA, non un'ottimizzazione.
    expect((await statusesOf([pulseRowId]))[0]).toBe("open");
  });

  it("attribuisce la chiusura all'attore passato (handled_by_user_id)", async () => {
    const pulseId = randomUUID();
    const id = await seedPulseRow(userB, pulseId);

    await propagateHandled(db, { eventKey: { kind: "pulse", field: "pulseId", value: pulseId } }, userA);

    const [row] = await db
      .select({ handledByUserId: notifications.handledByUserId })
      .from(notifications)
      .where(eq(notifications.id, id));
    expect(row!.handledByUserId).toBe(userA);
  });

  it("un eventKey.kind sconosciuto fa fallire in modo esplicito, non in silenzio", async () => {
    await expect(
      propagateHandled(db, { eventKey: { kind: "boh", field: "x", value: "y" } }, userA),
    ).rejects.toThrow(/eventKey\.kind/);
  });
});

describe("propagateHandled — i target preesistenti restano invariati", () => {
  it("{ jobId, kind } chiude solo le copie di quel job e quel kind", async () => {
    const ticket = await createTicket(db, {
      projectId,
      title: "Ticket di test",
      type: "bug",
      priority: "medium",
      source: "manual",
    });
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId: ticket.id, status: "awaiting_plan_approval" })
      .returning({ id: aiJobs.id });
    const [row] = await db
      .insert(notifications)
      .values({
        userId: userA,
        ticketId: ticket.id,
        jobId: job!.id,
        kind: "job.plan_review",
        status: "open",
        event: { kind: "job.plan_review", ticketNumber: 1, ticketTitle: "x", ticketUrl: "https://x" },
      })
      .returning({ id: notifications.id });

    const changed = await propagateHandled(db, { jobId: job!.id, kind: "job.plan_review" }, userA);
    expect(changed).toEqual([row!.id]);
  });

  it("{ notificationId } chiude solo quella riga", async () => {
    const pulseId = randomUUID();
    const idA = await seedPulseRow(userA, pulseId);
    const idB = await seedPulseRow(userB, pulseId);

    const changed = await propagateHandled(db, { notificationId: idA }, userA);
    expect(changed).toEqual([idA]);
    expect((await statusesOf([idB]))[0]).toBe("open");
  });
});
