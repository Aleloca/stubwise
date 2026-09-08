import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlogJobs,
  comments,
  ticketEvents,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedRepositoryInProject, startTestDb } from "@stubwise/db/testing";
import { createTicket } from "../db/tickets.js";
import { enqueueBacklogIntake } from "./backlog-intake.js";
import { addComment, addSystemComment } from "./comments.js";
import { createMilestone } from "./milestones.js";
import { diffTicketEvents, patchTicket } from "./tickets.js";

/**
 * Test dei servizi estratti dalle rotte (fase 6, task 3): le mutazioni che
 * backlog, milestone, ticket e commenti condividono con l'esecuzione delle
 * proposte Google.
 *
 * UN SOLO FILE PER QUATTRO SERVIZI, e quindi un solo Postgres effimero: la
 * suite del server ne avvia già uno per file con `maxForks: 2` (vedi
 * `vitest.config.ts`), e questi quattro moduli sono nati insieme dallo stesso
 * refactor. Le rotte che li chiamano hanno i propri test end-to-end; qui si
 * verifica quello che le rotte NON possono verificare: che i servizi funzionino
 * con un `tx` e un attore forniti dal chiamante.
 */

let testDb: TestDb;
let db: Db;
let projectId: string;
let repositoryId: string;
let otherProjectId: string;
let actorId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId, repositoryId } = await seedRepository(db));
  ({ projectId: otherProjectId } = await seedRepository(db));
  actorId = await seedUser();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function seedUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `u-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return row!.id;
}

async function seedTicket(overrides: { projectId?: string } = {}): Promise<string> {
  const ticket = await createTicket(db, {
    projectId: overrides.projectId ?? projectId,
    title: "Ticket di test",
    type: "bug",
    priority: "medium",
    source: "manual",
  });
  return ticket.id;
}

// --- enqueueBacklogIntake ---------------------------------------------------

describe("enqueueBacklogIntake", () => {
  it("accoda un job intake col payload manuale", async () => {
    const result = await enqueueBacklogIntake(db, {
      projectId,
      title: "Idea nuova",
      body: "Il corpo dell'idea",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [job] = await db.select().from(backlogJobs).where(eq(backlogJobs.id, result.jobId));
    expect(job?.projectId).toBe(projectId);
    expect(job?.kind).toBe("intake");
    // Il payload deve restare ESATTAMENTE {title, body}: lo schema del worker è
    // una union di oggetti strict, un campo in più lo farebbe fallire.
    expect(job?.payload).toEqual({ title: "Idea nuova", body: "Il corpo dell'idea" });
  });

  it("non accoda nulla se il progetto non esiste", async () => {
    const before = await db.select({ id: backlogJobs.id }).from(backlogJobs);
    const result = await enqueueBacklogIntake(db, {
      projectId: randomUUID(),
      title: "t",
      body: "b",
    });
    expect(result).toEqual({ ok: false, error: "project_not_found" });
    const after = await db.select({ id: backlogJobs.id }).from(backlogJobs);
    expect(after.length).toBe(before.length);
  });

  it("scritto dentro la transazione del chiamante: un rollback lo annulla", async () => {
    const before = await db.select({ id: backlogJobs.id }).from(backlogJobs);
    await expect(
      db.transaction(async (tx) => {
        const result = await enqueueBacklogIntake(tx, {
          projectId,
          title: "Da annullare",
          body: "corpo",
        });
        expect(result.ok).toBe(true);
        throw new Error("rollback voluto");
      }),
    ).rejects.toThrow("rollback voluto");
    const after = await db.select({ id: backlogJobs.id }).from(backlogJobs);
    expect(after.length).toBe(before.length);
  });
});

// --- createMilestone --------------------------------------------------------

describe("createMilestone", () => {
  it("crea la milestone con scadenza e descrizione", async () => {
    const result = await createMilestone(db, {
      projectId,
      name: `M-${randomUUID()}`,
      description: "descrizione",
      dueDate: "2026-12-31T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.milestone.projectId).toBe(projectId);
    expect(result.milestone.description).toBe("descrizione");
    expect(result.milestone.dueDate?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(result.milestone.status).toBe("open");
    expect(result.milestone.closedAt).toBeNull();
    expect(result.milestone.repositoryId).toBeNull();
  });

  it("una milestone creata già chiusa ha una data di chiusura", async () => {
    const result = await createMilestone(db, {
      projectId,
      name: `M-${randomUUID()}`,
      status: "closed",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.milestone.status).toBe("closed");
    expect(result.milestone.closedAt).not.toBeNull();
  });

  it("accetta un repository d'origine del progetto", async () => {
    const result = await createMilestone(db, {
      projectId,
      name: `M-${randomUUID()}`,
      repositoryId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.milestone.repositoryId).toBe(repositoryId);
  });

  it("rifiuta un repository di un altro progetto", async () => {
    const foreignRepo = await seedRepositoryInProject(db, otherProjectId);
    const result = await createMilestone(db, {
      projectId,
      name: `M-${randomUUID()}`,
      repositoryId: foreignRepo,
    });
    expect(result).toEqual({ ok: false, error: "repository_not_in_project" });
  });

  it("rifiuta un progetto inesistente", async () => {
    const result = await createMilestone(db, { projectId: randomUUID(), name: "M" });
    expect(result).toEqual({ ok: false, error: "project_not_found" });
  });

  it("un nome già usato nel progetto è milestone_exists, e NON aborta la transazione", async () => {
    const name = `M-${randomUUID()}`;
    const first = await createMilestone(db, { projectId, name });
    expect(first.ok).toBe(true);

    // Il punto del pre-check: dentro una transazione del chiamante il duplicato
    // deve essere un esito, non un errore Postgres che rende la tx inutilizzabile.
    const stillUsable = await db.transaction(async (tx) => {
      const dup = await createMilestone(tx, { projectId, name });
      expect(dup).toEqual({ ok: false, error: "milestone_exists" });
      return createMilestone(tx, { projectId, name: `${name}-bis` });
    });
    expect(stillUsable.ok).toBe(true);
  });

  it("lo stesso nome in un ALTRO progetto è lecito", async () => {
    const name = `M-${randomUUID()}`;
    expect((await createMilestone(db, { projectId, name })).ok).toBe(true);
    expect((await createMilestone(db, { projectId: otherProjectId, name })).ok).toBe(true);
  });
});

// --- patchTicket ------------------------------------------------------------

describe("diffTicketEvents", () => {
  const base = {
    title: "t",
    body: "b",
    type: "bug",
    priority: "medium",
    status: "open",
    assigneeId: null,
    labels: ["a", "b"],
    milestoneId: null,
  } as unknown as Parameters<typeof diffTicketEvents>[0];

  it("non produce eventi se nulla cambia", () => {
    expect(diffTicketEvents(base, { title: "t", priority: "medium" })).toEqual([]);
  });

  it("riordinare le label non è una modifica; duplicarle sì", () => {
    expect(diffTicketEvents(base, { labels: ["b", "a"] })).toEqual([]);
    expect(diffTicketEvents(base, { labels: ["a", "a", "b"] })).toHaveLength(1);
  });

  it("title/body segnano solo che sono cambiati, mai il testo", () => {
    const events = diffTicketEvents(base, { title: "nuovo", body: "nuovo corpo" });
    expect(events).toEqual([
      { kind: "title_changed", payload: { changed: true } },
      { kind: "body_changed", payload: { changed: true } },
    ]);
  });

  it("gli altri campi portano { from, to }", () => {
    expect(diffTicketEvents(base, { priority: "high" })).toEqual([
      { kind: "priority_changed", payload: { from: "medium", to: "high" } },
    ]);
  });
});

describe("patchTicket", () => {
  it("applica la patch e scrive un evento per campo, con l'attore passato", async () => {
    const ticketId = await seedTicket();
    const result = await db.transaction(async (tx) =>
      patchTicket(tx, {
        ticketId,
        actorId,
        patch: { title: "Nuovo titolo", priority: "high" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ticket.title).toBe("Nuovo titolo");
    expect(result.ticket.priority).toBe("high");

    const events = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticketId))
      .orderBy(asc(ticketEvents.createdAt), asc(ticketEvents.id));
    expect(events.map((e) => e.kind).sort()).toEqual(["priority_changed", "title_changed"]);
    expect(events.every((e) => e.actorId === actorId)).toBe(true);
  });

  it("una patch vuota è una pura lettura: nessun evento", async () => {
    const ticketId = await seedTicket();
    const result = await db.transaction(async (tx) =>
      patchTicket(tx, { ticketId, actorId, patch: {} }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([]);
    const events = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId));
    expect(events).toHaveLength(0);
  });

  it("una patch che non cambia nulla aggiorna la riga ma non produce eventi", async () => {
    const ticketId = await seedTicket();
    const result = await db.transaction(async (tx) =>
      patchTicket(tx, { ticketId, actorId, patch: { priority: "medium" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([]);
  });

  it("un ticket inesistente è ticket_not_found", async () => {
    const result = await db.transaction(async (tx) =>
      patchTicket(tx, { ticketId: randomUUID(), actorId, patch: { priority: "high" } }),
    );
    expect(result).toEqual({ ok: false, error: "ticket_not_found" });
  });

  it("un assegnatario inesistente vince sul ticket inesistente", async () => {
    const result = await db.transaction(async (tx) =>
      patchTicket(tx, {
        ticketId: randomUUID(),
        actorId,
        patch: { assigneeId: randomUUID() },
      }),
    );
    expect(result).toEqual({ ok: false, error: "assignee_not_found" });
  });

  it("una milestone di un altro progetto è milestone_cross_project e non scrive nulla", async () => {
    const ticketId = await seedTicket();
    const foreign = await createMilestone(db, { projectId: otherProjectId, name: `M-${randomUUID()}` });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;

    const result = await db.transaction(async (tx) =>
      patchTicket(tx, {
        ticketId,
        actorId,
        patch: { milestoneId: foreign.milestone.id, priority: "high" },
      }),
    );
    expect(result).toEqual({ ok: false, error: "milestone_cross_project" });

    const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(row?.priority).toBe("medium");
    expect(row?.milestoneId).toBeNull();
  });

  it("azzerare la milestone è sempre lecito", async () => {
    const ticketId = await seedTicket();
    const own = await createMilestone(db, { projectId, name: `M-${randomUUID()}` });
    expect(own.ok).toBe(true);
    if (!own.ok) return;

    await db.transaction(async (tx) =>
      patchTicket(tx, { ticketId, actorId, patch: { milestoneId: own.milestone.id } }),
    );
    const cleared = await db.transaction(async (tx) =>
      patchTicket(tx, { ticketId, actorId, patch: { milestoneId: null } }),
    );
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.ticket.milestoneId).toBeNull();
    expect(cleared.events).toEqual([
      { kind: "milestone_changed", payload: { from: own.milestone.id, to: null } },
    ]);
  });

  it("un rollback del chiamante annulla update ed eventi insieme", async () => {
    const ticketId = await seedTicket();
    await expect(
      db.transaction(async (tx) => {
        await patchTicket(tx, { ticketId, actorId, patch: { title: "Mai visto" } });
        throw new Error("rollback voluto");
      }),
    ).rejects.toThrow("rollback voluto");

    const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(row?.title).toBe("Ticket di test");
    const events = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId));
    expect(events).toHaveLength(0);
  });
});

// --- commenti ---------------------------------------------------------------

describe("addComment / addSystemComment", () => {
  it("addComment scrive un commento utente con il suo autore", async () => {
    const ticketId = await seedTicket();
    const created = await addComment(db, {
      ticketId,
      authorType: "user",
      authorId: actorId,
      body: "commento umano",
    });
    expect(created.authorType).toBe("user");
    expect(created.authorId).toBe(actorId);
    expect(created.body).toBe("commento umano");
  });

  it("addSystemComment non ha autore ed è marcato system", async () => {
    const ticketId = await seedTicket();
    const created = await addSystemComment(db, { ticketId, body: "chiuso al merge" });
    expect(created.authorType).toBe("system");
    expect(created.authorId).toBeNull();

    const rows = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("chiuso al merge");
  });

  it("vive nella transazione del chiamante", async () => {
    const ticketId = await seedTicket();
    await expect(
      db.transaction(async (tx) => {
        await addSystemComment(tx, { ticketId, body: "da annullare" });
        throw new Error("rollback voluto");
      }),
    ).rejects.toThrow("rollback voluto");
    const rows = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(rows).toHaveLength(0);
  });
});
