import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  aiJobs,
  backlogItems,
  backlogItemTickets,
  notificationDeliveries,
  notifications,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { NotificationEvent } from "@stubwise/notifications";
import type { Actor } from "./jobs.js";

/**
 * Test di `proceedWithProposal` (il "Procedi con X" del pulse) su un Postgres
 * reale, come `questions.test.ts`: quello che conta qui sono un claim
 * distribuito su più righe, due transazioni in fila e la propagazione — cioè
 * cose che un fake `Db` non saprebbe raccontare.
 *
 * PERCHÉ UN MOCK PARZIALE DI `./jobs.js`: la decisione B della fase 2 dice che
 * "voce convertita ma run non partito" è uno stato reale da gestire, e va
 * testato. Su un ticket appena creato però `startRun` non PUÒ fallire nel
 * merito (nessun job in volo, ticket esistente): l'unico modo di produrre quel
 * ramo è farglielo dire. Il mock resta trasparente (`startRun` vero) finché un
 * test non alza `failStartRun`.
 */
const state = vi.hoisted(() => ({ failStartRun: false }));

vi.mock("./jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jobs.js")>();
  return {
    ...actual,
    startRun: async (db: Db, input: Parameters<typeof actual.startRun>[1]) =>
      state.failStartRun
        ? { ok: false as const, error: "job_in_flight" as const, jobStatus: "fixing" }
        : actual.startRun(db, input),
  };
});

import { executeAction } from "./inbox.js";
import { proceedWithProposal } from "./pulse.js";

let testDb: TestDb;
let db: Db;
let projectId: string;
let maintainer: Actor & { email: string };
let operator: Actor & { email: string };
let other: Actor & { email: string };

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  maintainer = await seedUser("admin");
  operator = await seedUser("member");
  other = await seedUser("member");
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Inserisce un utente col ruolo dato (id reale: serve alle FK). */
async function seedUser(role: "admin" | "member"): Promise<Actor & { email: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role })
    .returning({ id: users.id, role: users.role, email: users.email });
  return { id: row!.id, role: row!.role, email: row!.email };
}

/** Inserisce una voce di backlog candidabile nel progetto di test. */
async function seedItem(
  overrides: Partial<typeof backlogItems.$inferInsert> = {},
): Promise<typeof backlogItems.$inferSelect> {
  const [row] = await db
    .insert(backlogItems)
    .values({
      projectId,
      title: "Export CSV dello storico ordini",
      source: "manual",
      status: "ready",
      document: "# Design\n\nCorpo della voce.",
      urgency: "high",
      effort: 2,
      ...overrides,
    })
    .returning();
  return row!;
}

/** Evento `project.pulse` realistico sulle voci date (una proposta per voce). */
function pulseEvent(
  pulseId: string,
  items: { id: string; title: string }[],
): NotificationEvent & { kind: "project.pulse" } {
  return {
    kind: "project.pulse",
    pulseId,
    projectName: "negozio-web",
    projectUrl: "https://stubwise.test/projects/x/backlog",
    idleDays: 4,
    question: "Nessun lavoro in corso su negozio-web da 4 giorni. Da quale proposta partiamo?",
    options: items.map((item) => ({ label: item.title, consequence: "urgenza alta · effort 2" })),
    recommendedIndex: 0,
    allowFreeText: false,
    proposals: items.map((item) => ({
      backlogItemId: item.id,
      title: item.title,
      urgency: "high" as const,
      effort: 2,
      hasAnalysis: false,
    })),
  };
}

/**
 * Un pulse consegnato a più destinatari: una riga per utente con LO STESSO
 * payload, come lo scriverà il poller del task 7.
 */
async function seedPulse(
  recipients: Actor[],
  items: { id: string; title: string }[],
  overrides: { status?: "open" | "handled" | "snoozed"; pulseId?: string } = {},
): Promise<{ pulseId: string; ids: string[] }> {
  const pulseId = overrides.pulseId ?? randomUUID();
  const status = overrides.status ?? "open";
  const rows = await db
    .insert(notifications)
    .values(
      recipients.map((user) => ({
        userId: user.id,
        kind: "project.pulse" as const,
        event: pulseEvent(pulseId, items) as unknown as Record<string, unknown>,
        projectId,
        status,
        handledAt: status === "handled" ? new Date() : null,
        snoozedUntil: status === "snoozed" ? new Date(Date.now() + 3_600_000) : null,
      })),
    )
    .returning({ id: notifications.id });
  return { pulseId, ids: rows.map((row) => row.id) };
}

/** Stato attuale delle righe d'inbox date. */
async function readNotifications(ids: string[]) {
  return db
    .select({
      id: notifications.id,
      status: notifications.status,
      handledByUserId: notifications.handledByUserId,
    })
    .from(notifications)
    .where(inArray(notifications.id, ids));
}

/** Note `slack_update` accodate per la notifica data. */
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

/** L'ultimo job del ticket, per verificare come è nato il run. */
async function readJob(ticketId: string) {
  const [row] = await db
    .select({
      id: aiJobs.id,
      status: aiJobs.status,
      planApprovalRequired: aiJobs.planApprovalRequired,
      requestedByUserId: aiJobs.requestedByUserId,
    })
    .from(aiJobs)
    .where(eq(aiJobs.ticketId, ticketId));
  return row;
}

describe("proceedWithProposal — guardie d'ingresso", () => {
  it("notifica inesistente → not_found", async () => {
    const result = await proceedWithProposal(db, {
      notificationId: randomUUID(),
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("notifica di un altro kind → not_found (il servizio è solo del pulse)", async () => {
    const [row] = await db
      .insert(notifications)
      .values({
        userId: maintainer.id,
        kind: "job.failed",
        event: { kind: "job.failed" } as unknown as Record<string, unknown>,
        projectId,
      })
      .returning({ id: notifications.id });
    const result = await proceedWithProposal(db, {
      notificationId: row!.id,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("indice fuori dalle proposte persistite → invalid_answer (niente conversione)", async () => {
    const item = await seedItem();
    const { ids } = await seedPulse([maintainer], [item]);

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 5,
    });
    expect(result).toEqual({ ok: false, error: "invalid_answer" });

    const [after] = await db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(after!.status).toBe("ready");
    // La riga resta aperta: una richiesta malformata non consuma il pulse.
    expect((await readNotifications(ids))[0]!.status).toBe("open");
  });

  it("indice assente (risposta a testo libero) → invalid_answer", async () => {
    const item = await seedItem();
    const { ids } = await seedPulse([maintainer], [item]);
    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
    });
    expect(result).toEqual({ ok: false, error: "invalid_answer" });
  });

  it("riga rinviata → already_handled (senza nome: nessuno l'ha gestita)", async () => {
    // Comportamento FISSATO, con la sua imprecisione: `already_handled` su una
    // riga solo rinviata dice più di quel che è successo. Non è raggiungibile
    // in pratica (lo snooze toglie i bottoni dal DM e la riga sparisce
    // dall'inbox aperta; quando riemerge il lazy-reopen l'ha già rimessa
    // `open`), ma se un giorno lo diventasse questo test lo farà notare.
    const item = await seedItem({ title: "Voce rinviata" });
    const { ids } = await seedPulse([maintainer], [item], { status: "snoozed" });

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result).toEqual({ ok: false, error: "already_handled" });

    // NIENTE è stato consumato: la riga resta rinviata e la voce candidabile.
    expect((await readNotifications(ids))[0]!.status).toBe("snoozed");
    const [after] = await db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(after!.status).toBe("ready");
  });

  it("riga già gestita → already_handled con chi l'ha gestita", async () => {
    const item = await seedItem();
    const { ids } = await seedPulse([maintainer], [item]);
    await db
      .update(notifications)
      .set({ status: "handled", handledAt: new Date(), handledByUserId: operator.id })
      .where(eq(notifications.id, ids[0]!));

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: "already_handled",
      handledBy: { id: operator.id, email: operator.email },
    });
  });
});

describe("proceedWithProposal — successo", () => {
  it("voce con piano: ticket creato, job in awaiting_plan_approval, copie chiuse, nota", async () => {
    const item = await seedItem({
      title: "Voce con piano",
      implementationPlan: "## Piano\n1. Step",
    });
    const { ids } = await seedPulse([maintainer, operator], [item]);

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
      publicUrl: "https://stubwise.test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("awaiting_plan_approval");
    expect(result.ticketNumber).toBeGreaterThan(0);
    expect(result.changedNotificationIds.sort()).toEqual([...ids].sort());

    // Il ticket esiste e la voce è collegata.
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result.ticketId));
    expect(ticket!.title).toBe("Voce con piano");
    const links = await db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, item.id));
    expect(links).toHaveLength(1);

    // Il run nasce parcheggiato sul gate, intestato a chi ha premuto.
    const job = await readJob(result.ticketId);
    expect(job!.id).toBe(result.jobId);
    expect(job!.status).toBe("awaiting_plan_approval");
    expect(job!.planApprovalRequired).toBe(true);
    expect(job!.requestedByUserId).toBe(maintainer.id);

    // TUTTE le copie sono chiuse e attribuite a chi ha deciso.
    const rows = await readNotifications(ids);
    expect(rows.every((row) => row.status === "handled")).toBe(true);
    expect(rows.every((row) => row.handledByUserId === maintainer.id)).toBe(true);

    // La nota nomina attore e titolo e dice che si aspetta l'approvazione.
    const notes = await readNotes(ids[1]!);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(maintainer.email);
    expect(notes[0]).toContain("Voce con piano");
    expect(notes[0]).toMatch(/approval/i);
  });

  it("voce senza piano: job queued con planApprovalRequired e nota diversa", async () => {
    const item = await seedItem({ title: "Voce senza piano", implementationPlan: null });
    const { ids } = await seedPulse([maintainer], [item]);

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("queued");

    const job = await readJob(result.ticketId);
    expect(job!.status).toBe("queued");
    // Il gate resta: sarà il worker a fermarsi a piano pronto.
    expect(job!.planApprovalRequired).toBe(true);

    // Due esperienze diverse, due note diverse: qui la pianificazione parte.
    const notes = await readNotes(ids[0]!);
    expect(notes[0]).toContain("Voce senza piano");
    expect(notes[0]).toMatch(/planning/i);
  });

  it("un member destinatario può procedere (il pulse è una proposta, non un gate)", async () => {
    const item = await seedItem({ title: "Voce dell'operatore" });
    const { ids } = await seedPulse([operator], [item]);

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: operator,
      optionIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const job = await readJob(result.ticketId);
    expect(job!.requestedByUserId).toBe(operator.id);
    expect(job!.planApprovalRequired).toBe(true);
  });

  it("sceglie la proposta all'indice dato, non la prima", async () => {
    const first = await seedItem({ title: "Prima proposta" });
    const second = await seedItem({ title: "Seconda proposta" });
    const { ids } = await seedPulse([maintainer], [first, second]);

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result.ticketId));
    expect(ticket!.title).toBe("Seconda proposta");
    const [untouched] = await db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, first.id));
    expect(untouched!.status).toBe("ready");
  });
});

describe("proceedWithProposal — corse e proposte scadute", () => {
  it("due Procedi concorrenti su proposte DIVERSE: uno vince, l'altro already_handled", async () => {
    const first = await seedItem({ title: "Corsa A" });
    const second = await seedItem({ title: "Corsa B" });
    const { ids } = await seedPulse([maintainer, operator], [first, second]);

    const [a, b] = await Promise.all([
      proceedWithProposal(db, { notificationId: ids[0]!, actor: maintainer, optionIndex: 0 }),
      proceedWithProposal(db, { notificationId: ids[1]!, actor: operator, optionIndex: 1 }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, error: "already_handled" });

    // UN solo run: il perdente non ne ha avviato un secondo.
    const jobs = await db
      .select({ id: aiJobs.id })
      .from(aiJobs)
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .where(inArray(tickets.title, ["Corsa A", "Corsa B"]));
    expect(jobs).toHaveLength(1);

    // E una sola voce convertita.
    const converted = await db
      .select({ id: backlogItems.id })
      .from(backlogItems)
      .where(
        and(inArray(backlogItems.id, [first.id, second.id]), eq(backlogItems.status, "converted")),
      );
    expect(converted).toHaveLength(1);
  });

  it("voce già convertita da altrove → proposal_stale, copie chiuse con nota", async () => {
    const item = await seedItem({ title: "Voce già convertita", status: "converted" });
    const { ids } = await seedPulse([maintainer, operator], [item]);

    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result).toMatchObject({ ok: false, error: "proposal_stale" });

    // La card non deve restare a invitare a un'azione impossibile.
    const rows = await readNotifications(ids);
    expect(rows.every((row) => row.status === "handled")).toBe(true);
    const notes = await readNotes(ids[1]!);
    expect(notes[0]).toContain("Voce già convertita");
    expect(notes[0]).toMatch(/already/i);

    // Nessun ticket è nato dalla voce.
    const links = await db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, item.id));
    expect(links).toHaveLength(0);
  });

  it("voce archiviata → proposal_stale (stessa causa per chi guarda la card)", async () => {
    const item = await seedItem({ title: "Voce archiviata", status: "archived" });
    const { ids } = await seedPulse([maintainer], [item]);
    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result).toMatchObject({ ok: false, error: "proposal_stale" });
    expect((await readNotifications(ids))[0]!.status).toBe("handled");
  });

  it("voce sparita → proposal_stale", async () => {
    const { ids } = await seedPulse([maintainer], [{ id: randomUUID(), title: "Voce sparita" }]);
    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result).toMatchObject({ ok: false, error: "proposal_stale" });
  });
});

describe("proceedWithProposal — convertito ma run non partito", () => {
  it("il ticket resta, l'esito lo dice e la nota non promette un run", async () => {
    const item = await seedItem({ title: "Run mancato" });
    const { ids } = await seedPulse([maintainer], [item]);

    state.failStartRun = true;
    const result = await proceedWithProposal(db, {
      notificationId: ids[0]!,
      actor: maintainer,
      optionIndex: 0,
    }).finally(() => {
      state.failStartRun = false;
    });

    expect(result).toMatchObject({
      ok: false,
      error: "run_not_started",
      ticketNumber: expect.any(Number),
    });
    // Il ticket c'è davvero: l'esito NON è un fallimento totale.
    const ticketId = result.ok ? "" : (result.ticketId ?? "");
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.title).toBe("Run mancato");
    expect(await readJob(ticketId)).toBeUndefined();

    const notes = await readNotes(ids[0]!);
    expect(notes[0]).toContain("Run mancato");
    expect(notes[0]).toMatch(/did not start/i);
  });
});

describe("executeAction — dispatch del pulse", () => {
  it("answer su un pulse converte e avvia (stesso esito del servizio)", async () => {
    const item = await seedItem({ title: "Dal dispatch" });
    const { ids } = await seedPulse([maintainer], [item]);

    const result = await executeAction(db, {
      notificationId: ids[0]!,
      action: "answer",
      actor: maintainer,
      payload: { answer: { optionIndex: 0 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("project.pulse");
    expect(result.ticketNumber).toBeGreaterThan(0);
    expect(result.jobId).toBeTruthy();
    expect(result.changedNotificationIds).toEqual(ids);
  });

  it("chi non è destinatario della riga → not_found (non ne rivela l'esistenza)", async () => {
    const item = await seedItem({ title: "Non mia" });
    const { ids } = await seedPulse([maintainer], [item]);

    const result = await executeAction(db, {
      notificationId: ids[0]!,
      action: "answer",
      actor: other,
      payload: { answer: { optionIndex: 0 } },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });

    // Nulla è successo: la voce è ancora candidabile.
    const [after] = await db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(after!.status).toBe("ready");
  });

  it("proposta scaduta dal dispatch → proposal_stale", async () => {
    const item = await seedItem({ title: "Scaduta dal dispatch", status: "converted" });
    const { ids } = await seedPulse([maintainer], [item]);

    const result = await executeAction(db, {
      notificationId: ids[0]!,
      action: "answer",
      actor: maintainer,
      payload: { answer: { optionIndex: 0 } },
    });
    expect(result).toMatchObject({ ok: false, error: "proposal_stale" });
  });
});
