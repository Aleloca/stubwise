import {
  agentSessions,
  backlogItemRequesters,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  comments,
  notifications,
  projects,
  ticketEvents,
  tickets,
  users,
  type Db,
  type EmbeddingProvider,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { BacklogIntakePayload } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { fakeSelect } from "../providers/select-fake.js";
import type { BacklogDeps, BacklogJob } from "./poller.js";
import { runIntake } from "./intake.js";
import { NoAccountAvailableError } from "./provider.js";

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

function makeDeps(db: Db, overrides: Partial<BacklogDeps>): BacklogDeps {
  return {
    db,
    embeddingClient: embeddingClient({}),
    runner: fakeRunner("{}"),
    serializer: { run: (_p, task) => task() },
    logger: silentLogger,
    mergeThreshold: 0.9,
    similarThreshold: 0.78,
    agentTimeoutMs: 1000,
    workDir: "/tmp",
    // Db reale senza `ai_providers`: la scelta vera dà l'auth storica.
    select: { db, encryptionKey: Buffer.alloc(32), backgroundWeeklyThreshold: 90 },
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
    resultItemId: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

/**
 * Job intake REALE in DB (a differenza di `fakeJob`, la cui riga non esiste): serve
 * quando il test deve rileggere il job per verificarne il `resultItemId` che
 * l'intake vi scrive (l'update mira `backlogJobs.id`).
 */
async function insertJob(
  db: Db,
  projectId: string,
  payload: BacklogIntakePayload,
): Promise<BacklogJob> {
  const [job] = await db
    .insert(backlogJobs)
    .values({ projectId, kind: "intake", status: "running", payload })
    .returning();
  return job!;
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

    // AUDIT: anche la chiusura verso il backlog è una transizione di stato, e
    // la timeline di progetto la vuole datata. actorId null: nessun umano.
    const events = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticket.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("status_changed");
    expect(events[0]?.payload).toEqual({ from: "open", to: "closed" });
    expect(events[0]?.actorId).toBeNull();

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

  it("(d-bis) titolo che è l'INIZIO del corpo (cattura dall'app) → trattato come assente, non come un punto troncato", async () => {
    // L'app manda come titolo i primi 300 caratteri del testo, tagliati dove
    // capita: il 19 ott 2026 l'agente l'ha letto come un punto a sé e ha
    // scritto che la richiesta era «troncata dopo "Però"». Il corpo è completo.
    const db = testDb.db;
    const projectId = await createProject(db);
    const body = "Email da Audin: la bozza si lega al contatto. Però non alla trattativa.";
    const payload: BacklogIntakePayload = { title: body.slice(0, 50), body };
    const runner = fakeRunner(INTAKE_JSON);
    const embedded: string[] = [];
    const deps = makeDeps(db, {
      embeddingClient: {
        embed: async (inputs) => {
          embedded.push(...inputs);
          return inputs.map(() => vecOrtho);
        },
      },
      runner,
    });
    await runIntake(deps, fakeJob(projectId), payload);

    const prompt = vi.mocked(runner.run).mock.calls[0]![0].prompt;
    expect(prompt).not.toContain(payload.title + "\n");
    expect(prompt).toContain("--- FEEDBACK: TITOLO ---\n(nessun titolo: deducilo dal corpo)");
    expect(prompt).toContain(`--- FEEDBACK: CORPO ---\n${body}`);
    // Embedding e retrieval vedono il solo corpo, senza il prefisso duplicato.
    expect(embedded.length).toBeGreaterThan(0);
    for (const text of embedded) expect(text).toBe(body);
  });

  it("(d-ter) titolo vero, distinto dal corpo (web) → resta nel prompt", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const payload: BacklogIntakePayload = { title: "Idea", body: "Descrizione dell'idea" };
    const runner = fakeRunner(INTAKE_JSON);
    const deps = makeDeps(db, { embeddingClient: embeddingClient({}), runner });
    await runIntake(deps, fakeJob(projectId), payload);

    const prompt = vi.mocked(runner.run).mock.calls[0]![0].prompt;
    expect(prompt).toContain("--- FEEDBACK: TITOLO ---\nIdea\n");
  });

  it("(g) collega il job del backlog alla voce creata (resultItemId)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const payload: BacklogIntakePayload = { title: "Idea", body: "Descrizione dell'idea" };
    const feedback = "Idea\n\nDescrizione dell'idea";
    const job = await insertJob(db, projectId, payload);

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    await runIntake(deps, job, payload);

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(item).toBeDefined();
    const [reloaded] = await db.select().from(backlogJobs).where(eq(backlogJobs.id, job.id));
    expect(reloaded!.resultItemId).toBe(item!.id);
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

  it("auto-merge → resultItemId punta all'item CANONICO in cui si è fuso", async () => {
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
      .returning({ id: backlogItems.id });
    const payload: BacklogIntakePayload = { title: "Stessa idea", body: "altri dettagli" };
    const feedback = "Stessa idea\n\naltri dettagli";
    const job = await insertJob(db, projectId, payload);

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [feedback]: vecA }), // similarità 1.0 → merge
      runner: fakeRunner(JSON.stringify({ document: "## Contesto\nvecchio + nuovo" })),
    });
    await runIntake(deps, job, payload);

    // Nessuna voce nuova: il job punta alla voce canonica (quella esistente).
    const items = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(items).toHaveLength(1);
    const [reloaded] = await db.select().from(backlogJobs).where(eq(backlogJobs.id, job.id));
    expect(reloaded!.resultItemId).toBe(existing!.id);
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

describe("runIntake — scelta dell'account", () => {
  const FIRST: ResolvedProvider = { id: "acc-1", kind: "account", secret: "tok-1" };
  const SECOND: ResolvedProvider = { id: "acc-2", kind: "account", secret: "tok-2" };

  it("primo account al limite → usato il secondo, la voce nasce e il ticket si chiude", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const ticket = await createTicket(db, projectId, { title: "T", body: "B" });
    const feedback = "T\n\nB";
    const runner: AgentRunner = {
      run: vi.fn(async (opts: AgentRunOptions) =>
        opts.provider?.id === FIRST.id
          ? { output: "You've hit your session limit · resets 6pm (UTC)", exitCode: 1 }
          : { output: INTAKE_JSON, exitCode: 0 },
      ),
    };

    await runIntake(
      makeDeps(db, {
        embeddingClient: embeddingClient({ [feedback]: vecOrtho }),
        runner,
        select: fakeSelect(db, [FIRST, SECOND]),
      }),
      fakeJob(projectId),
      { ticketId: ticket.id },
    );

    expect(vi.mocked(runner.run).mock.calls.map(([o]) => o.provider?.id)).toEqual(["acc-1", "acc-2"]);
    expect(await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId))).toHaveLength(1);
    const [t] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticket.id));
    expect(t!.status).toBe("closed");
  });

  it("nessun account disponibile → NoAccountAvailableError, nessuna voce, ticket aperto", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const ticket = await createTicket(db, projectId, { title: "T", body: "B" });
    const runner = fakeRunner(INTAKE_JSON);
    // Un tick a vuoto non paga né l'embedding né il retrieval.
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => vecOrtho));

    await expect(
      runIntake(
        makeDeps(db, { runner, embeddingClient: { embed }, select: fakeSelect(db, { emptyReason: "all_limited" }) }),
        fakeJob(projectId),
        { ticketId: ticket.id },
      ),
    ).rejects.toBeInstanceOf(NoAccountAvailableError);
    expect(runner.run).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId))).toHaveLength(0);
    const [t] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticket.id));
    expect(t!.status).toBe("open");
  });
});

describe("runIntake — sessioni", () => {
  it("voce nuova: sessione del JOB (la voce non esiste ancora), label intake", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const payload: BacklogIntakePayload = { title: "Idea", body: "Descrizione dell'idea" };
    const job = await insertJob(db, projectId, payload);
    const runner = Object.assign(fakeRunner(INTAKE_JSON), { recordsSessions: true });

    await runIntake(
      makeDeps(db, { embeddingClient: embeddingClient({}), runner }),
      job,
      payload,
    );

    const opts = vi.mocked(runner.run).mock.calls[0]![0] as AgentRunOptions;
    expect(opts.session!.label).toBe("intake");
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, opts.session!.sessionId));
    expect(row!.ownerKey).toBe(`backlog_job:${job.id}`);
    expect(row!.kind).toBe("backlog_job");
    expect(row!.backlogJobId).toBe(job.id);
    expect(row!.projectId).toBe(projectId);
  });

  it("merge: sessione della voce di DESTINAZIONE, label intake", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const [existing] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Idea esistente", document: "## Contesto\nv", source: "manual", embedding: vecA })
      .returning({ id: backlogItems.id });
    const payload: BacklogIntakePayload = { title: "Stessa", body: "idea" };
    const runner = Object.assign(fakeRunner(JSON.stringify({ document: "## Contesto\nv + n" })), {
      recordsSessions: true,
    });

    await runIntake(
      makeDeps(db, { embeddingClient: embeddingClient({ "Stessa\n\nidea": vecA }), runner }),
      fakeJob(projectId),
      payload,
    );

    const opts = vi.mocked(runner.run).mock.calls[0]![0] as AgentRunOptions;
    expect(opts.session!.label).toBe("intake");
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, opts.session!.sessionId));
    expect(row!.ownerKey).toBe(`backlog_item:${existing!.id}`);
    expect(row!.title).toBe("Idea esistente");
  });

  it("runner storico: nessuna sessione per l'intake", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const payload: BacklogIntakePayload = { title: "Idea", body: "Descrizione" };
    const job = await insertJob(db, projectId, payload);
    const runner = fakeRunner(INTAKE_JSON);

    await runIntake(makeDeps(db, { embeddingClient: embeddingClient({}), runner }), job, payload);

    const opts = vi.mocked(runner.run).mock.calls[0]![0] as AgentRunOptions;
    expect("session" in opts).toBe(false);
    expect(await db.select().from(agentSessions).where(eq(agentSessions.backlogJobId, job.id))).toHaveLength(0);
  });
});

describe("runIntake — chi ha chiesto", () => {
  async function createUser(db: Db): Promise<string> {
    const [u] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, passwordHash: "hash", role: "member" })
      .returning({ id: users.id });
    return u!.id;
  }

  afterEach(async () => {
    await testDb.db.delete(users);
  });

  it("voce nuova da payload manuale con requestedByUserId → una riga richiedente", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const userId = await createUser(db);
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Titolo\n\nCorpo": vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    const job = await insertJob(db, projectId, { title: "Titolo", body: "Corpo", requestedByUserId: userId });
    await runIntake(deps, job, { title: "Titolo", body: "Corpo", requestedByUserId: userId });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    const rows = await db.select().from(backlogItemRequesters);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: item!.id, userId });
  });

  it("MERGE in una voce esistente → il richiedente va sulla voce di DESTINAZIONE", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const first = await createUser(db);
    const second = await createUser(db);
    const [existing] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Idea", document: "d", source: "manual", embedding: vecA })
      .returning({ id: backlogItems.id });
    await db.insert(backlogItemRequesters).values({ itemId: existing!.id, userId: first });

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Idea bis\n\naltro": vecA }),
      runner: fakeRunner(JSON.stringify({ document: "fuso" })),
    });
    const payload = { title: "Idea bis", body: "altro", requestedByUserId: second };
    await runIntake(deps, await insertJob(db, projectId, payload), payload);

    const items = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    expect(items).toHaveLength(1);
    const rows = await db.select().from(backlogItemRequesters);
    expect(rows.map((r) => [r.itemId, r.userId]).sort()).toEqual(
      [[existing!.id, first], [existing!.id, second]].sort(),
    );
  });

  it("intake da ticket con requested_by_user_id → l'autore del ticket diventa richiedente", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const userId = await createUser(db);
    const ticket = await createTicket(db, projectId, { title: "Titolo", body: "Corpo" });
    await db.update(tickets).set({ requestedByUserId: userId }).where(eq(tickets.id, ticket.id));
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Titolo\n\nCorpo": vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    const rows = await db.select().from(backlogItemRequesters);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: item!.id, userId });
  });

  /** Utente con ruolo e email scelti (il richiedente `member` o un admin). */
  async function createUserWith(
    db: Db,
    role: "admin" | "member",
  ): Promise<{ id: string; email: string }> {
    const email = `${randomUUID()}@example.com`;
    const [u] = await db
      .insert(users)
      .values({ email, passwordHash: "hash", role })
      .returning({ id: users.id });
    return { id: u!.id, email };
  }

  async function requestNotifications(db: Db, projectId: string) {
    const rows = await db
      .select({ userId: notifications.userId, event: notifications.event })
      .from(notifications)
      .where(eq(notifications.kind, "request.created"));
    return rows.filter((r) => (r.event as { projectId?: string }).projectId === projectId);
  }

  it("voce NUOVA con richiedente member → avviso agli admin con backlogItemId", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const admin = await createUserWith(db, "admin");
    const member = await createUserWith(db, "member");
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Titolo\n\nCorpo": vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
      publicUrl: "https://stubwise.test/",
    });
    const payload = { title: "Titolo", body: "Corpo", requestedByUserId: member.id };
    await runIntake(deps, await insertJob(db, projectId, payload), payload);

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    const rows = await requestNotifications(db, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(admin.id);
    expect(rows[0]!.event).toMatchObject({
      kind: "request.created",
      requestKind: "backlog",
      backlogItemId: item!.id,
      title: "Voce generata",
      requesterEmail: member.email,
      merged: false,
      url: `https://stubwise.test/backlog/${item!.id}`,
    });
  });

  it("MERGE con richiedente member → avviso con merged: true sulla voce di destinazione", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await createUserWith(db, "admin");
    const member = await createUserWith(db, "member");
    const [existing] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Idea", document: "d", source: "manual", embedding: vecA })
      .returning({ id: backlogItems.id });
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Idea bis\n\naltro": vecA }),
      runner: fakeRunner(JSON.stringify({ document: "fuso" })),
    });
    const payload = { title: "Idea bis", body: "altro", requestedByUserId: member.id };
    await runIntake(deps, await insertJob(db, projectId, payload), payload);

    const rows = await requestNotifications(db, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({
      requestKind: "backlog",
      backlogItemId: existing!.id,
      title: "Idea",
      merged: true,
    });
  });

  it("richiedente preso dal ticket d'origine (member) → avviso", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await createUserWith(db, "admin");
    const member = await createUserWith(db, "member");
    const ticket = await createTicket(db, projectId, { title: "Titolo", body: "Corpo" });
    await db.update(tickets).set({ requestedByUserId: member.id }).where(eq(tickets.id, ticket.id));
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Titolo\n\nCorpo": vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    await runIntake(deps, fakeJob(projectId), { ticketId: ticket.id });
    const rows = await requestNotifications(db, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({ requesterEmail: member.email, merged: false });
  });

  it("richiedente ADMIN → nessun avviso", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const admin = await createUserWith(db, "admin");
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Titolo\n\nCorpo": vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    const payload = { title: "Titolo", body: "Corpo", requestedByUserId: admin.id };
    await runIntake(deps, await insertJob(db, projectId, payload), payload);
    expect(await requestNotifications(db, projectId)).toHaveLength(0);
  });

  it("senza richiedente → nessun avviso", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await createUserWith(db, "admin");
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Titolo\n\nCorpo": vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    const payload = { title: "Titolo", body: "Corpo" };
    await runIntake(deps, await insertJob(db, projectId, payload), payload);
    expect(await requestNotifications(db, projectId)).toHaveLength(0);
  });

  it("payload senza autore → nessuna riga", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ "Titolo\n\nCorpo": vecOrtho }),
      runner: fakeRunner(INTAKE_JSON),
    });
    const payload = { title: "Titolo", body: "Corpo" };
    await runIntake(deps, await insertJob(db, projectId, payload), payload);
    expect(await db.select().from(backlogItemRequesters)).toHaveLength(0);
  });
});
