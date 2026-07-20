import {
  backlogChatMessages,
  backlogItems,
  backlogItemTickets,
  comments,
  projects,
  tickets,
  type Db,
  type EmbeddingProvider,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { BacklogIntakePayload } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunResult } from "../agent/runner.js";
import type { BacklogDeps, BacklogJob } from "./poller.js";
import { runIntake } from "./intake.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects); // tutto casca dal progetto.
});

afterAll(async () => {
  await testDb.stop();
});

const DIM = 1024;

/** Vettore 1024-dim con valori assegnati a indici scelti (resto 0). */
function vec(entries: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(entries)) v[Number(i)] = x;
  return v;
}

// vecA e vecGray hanno coseno 0.85; vecA e vecOrtho coseno 0.
const vecA = vec({ 0: 1 });
const vecGray = vec({ 0: 0.85, 1: 0.5268 });
const vecOrtho = vec({ 1: 1 });

/** Embedding client controllato: mappa testo → vettore (default: ortogonale). */
function embeddingClient(map: Record<string, number[]>): EmbeddingProvider {
  return { embed: async (inputs) => inputs.map((t) => map[t] ?? vecOrtho) };
}

/** Runner che restituisce un output fisso (default exit 0). */
function fakeRunner(output: string, exitCode = 0): AgentRunner {
  const result: AgentRunResult = { output, exitCode };
  return { run: vi.fn(async () => result) };
}

const silentLogger = { warn: () => {}, error: () => {} };

/** Mirror stub: l'intake non usa il mirror (solo il deep dive). */
const stubMirrors: BacklogDeps["mirrors"] = {
  resolveDefaultBranchHead: async () => {
    throw new Error("l'intake non deve usare il mirror");
  },
  withWorktreeAtSha: async () => {
    throw new Error("l'intake non deve usare il mirror");
  },
};

function makeDeps(db: Db, overrides: Partial<BacklogDeps>): BacklogDeps {
  return {
    db,
    embeddingClient: embeddingClient({}),
    runner: fakeRunner("{}"),
    mirrors: stubMirrors,
    serializer: { run: (_p, task) => task() },
    logger: silentLogger,
    encryptionKey: Buffer.alloc(32),
    mergeThreshold: 0.9,
    similarThreshold: 0.78,
    agentTimeoutMs: 1000,
    deepDiveMaxTurns: 30,
    workDir: "/tmp",
    ...overrides,
  };
}

async function createProject(db: Db): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ name: "Backlog", slug: `bl-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  return project!.id;
}

async function createTicket(
  db: Db,
  projectId: string,
  opts: { title: string; body: string; status?: "open" | "closed" | "done"; number?: number },
): Promise<{ id: string; number: number }> {
  const [ticket] = await db
    .insert(tickets)
    .values({
      projectId,
      number: opts.number ?? 1,
      title: opts.title,
      body: opts.body,
      type: "feature",
      priority: "medium",
      status: opts.status ?? "open",
      source: "manual",
    })
    .returning({ id: tickets.id, number: tickets.number });
  return ticket!;
}

/** Job fittizio (il poller ha già reclamato: qui conta solo projectId/kind). */
function fakeJob(projectId: string): BacklogJob {
  return {
    id: randomUUID(),
    projectId,
    kind: "intake",
    status: "running",
    payload: { ticketId: randomUUID() },
    attempts: 1,
    error: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

const INTAKE_JSON = JSON.stringify({
  title: "Voce generata",
  document: "## Contesto\nx\n## Cosa fare\ny\n## Punti aperti\nz",
  effort: 3,
  risk: "medium",
  riskNote: "qualche incognita",
  urgency: "high",
});

describe("runIntake — nuova voce", () => {
  it("(a) crea la voce coi metadati diretti, chiude il ticket e ci lascia commento+link", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const ticket = await createTicket(db, projectId, { title: "Titolo", body: "Corpo del feedback" });
    const feedback = "Titolo\n\nCorpo del feedback";

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(item).toBeDefined();
    expect(item!.title).toBe("Voce generata");
    expect(item!.effort).toBe(3);
    expect(item!.risk).toBe("medium");
    expect(item!.riskNote).toBe("qualche incognita");
    expect(item!.urgency).toBe("high");
    expect(item!.source).toBe("ticket");
    expect(item!.similarToId).toBeNull();
    expect(item!.suggested).toBeNull(); // metadati DIRETTI, non in suggested

    const [closed] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticket.id));
    expect(closed!.status).toBe("closed");

    // Commento AI nella lingua d'istanza (default 'en'), via catalogo i18n.
    const [comment] = await db.select().from(comments).where(eq(comments.ticketId, ticket.id));
    expect(comment!.authorType).toBe("ai");
    expect(comment!.body).toContain("Moved to the discovery backlog");
    expect(comment!.body).toContain("Voce generata");

    const [link] = await db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.ticketId, ticket.id));
    expect(link!.role).toBe("origin");
    expect(link!.itemId).toBe(item!.id);
  });

  it("(c) zona grigia (similarità tra le due soglie) → nuova voce con similarToId", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const [existing] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Simile", document: "d", source: "manual", embedding: vecA })
      .returning({ id: backlogItems.id });
    const ticket = await createTicket(db, projectId, { title: "Nuovo", body: "quasi uguale" });
    const feedback = "Nuovo\n\nquasi uguale";

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecGray }),
      runner: fakeRunner(INTAKE_JSON),
    });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });

    const items = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(items).toHaveLength(2); // la simile + la nuova
    const created = items.find((i) => i.id !== existing!.id)!;
    expect(created.similarToId).toBe(existing!.id);
  });

  it("(d) intake manuale (title/body) senza ticket → source manual, nessun ticket toccato", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const payload: BacklogIntakePayload = { title: "Idea", body: "Descrizione dell'idea" };
    const feedback = "Idea\n\nDescrizione dell'idea";

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    await runIntake(deps, fakeJob(projectId), payload);

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(item!.source).toBe("manual");
    expect(item!.similarToId).toBeNull();
    // Nessun ticket creato/collegato.
    expect(await db.select().from(backlogItemTickets)).toHaveLength(0);
  });
});

describe("runIntake — merge (dedup sopra soglia)", () => {
  it("(b) fonde nel documento, incrementa requestCount, aggiunge system message e chiude il ticket", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const [existing] = await db
      .insert(backlogItems)
      .values({
        projectId,
        title: "Idea esistente",
        document: "## Contesto\nvecchio",
        source: "manual",
        embedding: vecA,
      })
      .returning({ id: backlogItems.id, requestCount: backlogItems.requestCount });
    const ticket = await createTicket(db, projectId, { title: "Stessa idea", body: "altri dettagli", number: 7 });
    const feedback = "Stessa idea\n\naltri dettagli";

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecA }), // similarità 1.0 → merge
      runner: fakeRunner(JSON.stringify({ document: "## Contesto\nvecchio + nuovo" })),
    });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });

    // Nessuna voce nuova: si è fuso in quella esistente.
    const items = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(items).toHaveLength(1);
    expect(items[0]!.document).toBe("## Contesto\nvecchio + nuovo");
    expect(items[0]!.requestCount).toBe(existing!.requestCount + 1);

    // L'embedding della voce NON è stato ricalcolato: resta il nucleo dell'idea
    // (i valori 0/1 di vecA sono esatti in float4, il confronto è stabile).
    expect(items[0]!.embedding).toEqual(vecA);

    // Messaggio di sistema nella chat della voce (i18n, lingua d'istanza 'en'),
    // col numero del ticket.
    const [msg] = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, existing!.id));
    expect(msg!.role).toBe("system");
    expect(msg!.content).toContain("#7");
    expect(msg!.content).toContain("New feedback integrated");

    // Ticket chiuso + collegato alla voce esistente.
    const [closed] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticket.id));
    expect(closed!.status).toBe("closed");
    const [link] = await db
      .select()
      .from(backlogItemTickets)
      .where(and(eq(backlogItemTickets.itemId, existing!.id), eq(backlogItemTickets.ticketId, ticket.id)));
    expect(link!.role).toBe("origin");
  });

  it("una voce ARCHIVED con embedding identico è esclusa dal dedup → nasce una voce nuova", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const [archived] = await db
      .insert(backlogItems)
      .values({
        projectId,
        title: "Idea scartata",
        document: "d",
        source: "manual",
        status: "archived",
        embedding: vecA,
      })
      .returning({ id: backlogItems.id });
    const ticket = await createTicket(db, projectId, { title: "Ci riprovo", body: "stessa idea" });
    const feedback = "Ci riprovo\n\nstessa idea";

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecA }), // identico all'archiviata
      runner: fakeRunner(INTAKE_JSON),
    });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });

    // Niente merge sull'archiviata: voce NUOVA, senza nemmeno similarToId
    // (l'archiviata è fuori dalla similarity search del tutto).
    const items = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(items).toHaveLength(2);
    const created = items.find((i) => i.id !== archived!.id)!;
    expect(created.title).toBe("Voce generata");
    expect(created.similarToId).toBeNull();
    // L'archiviata è intatta (requestCount invariato, nessun system message).
    const old = items.find((i) => i.id === archived!.id)!;
    expect(old.requestCount).toBe(1);
    expect(old.document).toBe("d");
  });

  it("similarità ESATTAMENTE = mergeThreshold → merge (frontiera del >=)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await db.insert(backlogItems).values({
      projectId,
      title: "Idea",
      document: "d",
      source: "manual",
      embedding: vecA,
    });
    const ticket = await createTicket(db, projectId, { title: "Frontiera", body: "al limite" });
    const feedback = "Frontiera\n\nal limite";

    // Similarità MISURATA dalla stessa query pgvector dell'intake (1 - distanza):
    // usarla come soglia garantisce l'uguaglianza esatta alla frontiera, senza
    // dipendere dall'aritmetica float del coseno.
    const literal = `[${vecGray.join(",")}]`;
    const [row] = await db
      .select({ distance: sql<number>`(${backlogItems.embedding} <=> ${literal}::vector)` })
      .from(backlogItems)
      .where(eq(backlogItems.projectId, projectId));
    const measured = 1 - row!.distance;

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecGray }),
      runner: fakeRunner(JSON.stringify({ document: "fuso" })),
      mergeThreshold: measured, // frontiera esatta: similarity >= threshold deve fondere
    });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });

    const items = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(items).toHaveLength(1); // merge, nessuna voce nuova
    expect(items[0]!.document).toBe("fuso");
    expect(items[0]!.requestCount).toBe(2);
  });
});

describe("runIntake — fail-safe e no-op", () => {
  it("(e) output agente non-JSON → lancia e il ticket resta aperto (nessuna voce)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const ticket = await createTicket(db, projectId, { title: "T", body: "B" });
    const feedback = "T\n\nB";

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecOrtho }),
      runner: fakeRunner("non è affatto JSON"),
    });

    await expect(runIntake(deps, fakeJob(projectId), { ticketId: ticket.id })).rejects.toThrow(
      /non parsabile/,
    );
    // Fail-safe: nessuna voce, ticket ancora aperto.
    expect(await db.select().from(backlogItems)).toHaveLength(0);
    const [t] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticket.id));
    expect(t!.status).toBe("open");
  });

  it("(e-bis) agente exit ≠ 0 → lancia, ticket aperto", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const ticket = await createTicket(db, projectId, { title: "T", body: "B" });
    const feedback = "T\n\nB";

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecOrtho }),
      runner: fakeRunner(INTAKE_JSON, 1),
    });

    await expect(runIntake(deps, fakeJob(projectId), { ticketId: ticket.id })).rejects.toThrow(
      /exit 1/,
    );
    expect(await db.select().from(backlogItems)).toHaveLength(0);
  });

  it("(f) ticket già chiuso → no-op (done), nessuna voce e agente mai invocato", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const ticket = await createTicket(db, projectId, { title: "T", body: "B", status: "closed" });

    const runner = fakeRunner(INTAKE_JSON);
    const deps = makeDeps(db, { runner });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });

    expect(await db.select().from(backlogItems)).toHaveLength(0);
    expect(runner.run).not.toHaveBeenCalled();
  });
});
