import { aiJobs, comments, projects, tickets, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import { AgentRunError, AgentTimeoutError } from "../agent/runner.js";
import type { AiJob } from "../queue.js";
import { buildTriagePrompt, parseTriageDecision } from "./prompts.js";
import { runTriage, type TriageDeps } from "./triage.js";

// Un container Postgres per file (l'avvio costa secondi). Ogni test crea i
// propri ticket+job; afterEach svuota i tickets (comments e aiJobs cadono in
// cascata). Il triage non tocca il repo: il runner riceve come cwd una
// tmpdir vuota e innocua (workDir).

let testDb: TestDb;
let projectId: string;
let workDir: string;
let nextNumber = 1;

beforeAll(async () => {
  testDb = await startTestDb();
  workDir = await mkdtemp(join(tmpdir(), "stubwise-triage-test-"));
  const [project] = await testDb.db
    .insert(projects)
    .values({
      name: "Triage",
      slug: "triage",
      provider: "github",
      repoUrl: "https://github.com/acme/triage",
      defaultBranch: "main",
      encryptedCredentials: "irrilevante",
      ingestionKey: "ingestion-triage",
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  projectId = project.id;
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(tickets);
});

afterAll(async () => {
  await testDb.stop();
  await rm(workDir, { recursive: true, force: true });
});

type Ticket = typeof tickets.$inferSelect;

interface TicketOverrides {
  title?: string;
  body?: string;
  status?: Ticket["status"];
  technicalPayload?: unknown;
  createdAt?: Date;
  occurrences?: number;
}

async function createTicket(db: Db, overrides: TicketOverrides = {}): Promise<Ticket> {
  const [ticket] = await db
    .insert(tickets)
    .values({
      projectId,
      number: nextNumber++,
      title: overrides.title ?? "Errore in produzione",
      type: "bug",
      priority: "high",
      source: "sdk_error",
      ...overrides,
    })
    .returning();
  if (!ticket) throw new Error("insert del ticket non ha restituito la riga");
  return ticket;
}

/** Crea un job già reclamato (`triaging`), come lo consegna claimNextJob. */
async function createTriagingJob(db: Db, ticketId: string): Promise<AiJob> {
  const [job] = await db
    .insert(aiJobs)
    .values({ ticketId, status: "triaging", startedAt: new Date() })
    .returning();
  if (!job) throw new Error("insert del job non ha restituito la riga");
  return job;
}

async function getJob(db: Db, id: string): Promise<AiJob> {
  const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
  if (!job) throw new Error(`job ${id} non trovato`);
  return job;
}

async function getTicket(db: Db, id: string): Promise<Ticket> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!ticket) throw new Error(`ticket ${id} non trovato`);
  return ticket;
}

function makeDeps(runner: FakeAgentRunner, overrides: Partial<TriageDeps> = {}): TriageDeps {
  return { db: testDb.db, runner, workDir, ...overrides };
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

describe("parseTriageDecision", () => {
  it("estrae l'ULTIMO oggetto JSON anche se preceduto da prosa", () => {
    const output = `Sto analizzando il ticket.\nIl bug sembra riproducibile.\n{"decision":"fix"}`;
    expect(parseTriageDecision(output)).toEqual({ decision: "fix" });
  });

  it("riconosce skip con motivo e duplicate con numero", () => {
    expect(parseTriageDecision(`{"decision":"skip","reason":"troppo vago"}`)).toEqual({
      decision: "skip",
      reason: "troppo vago",
    });
    expect(parseTriageDecision(`{"decision":"duplicate","of":12}`)).toEqual({
      decision: "duplicate",
      of: 12,
    });
  });

  it("tollera fence markdown e prosa sulla stessa riga", () => {
    expect(parseTriageDecision('```json\n{"decision":"fix"}\n```')).toEqual({ decision: "fix" });
    expect(parseTriageDecision('Risposta finale: {"decision":"fix"}')).toEqual({
      decision: "fix",
    });
  });

  it("restituisce null per output non-JSON o decisioni non valide", () => {
    expect(parseTriageDecision("nessun JSON qui")).toBeNull();
    expect(parseTriageDecision("")).toBeNull();
    expect(parseTriageDecision(`{"decision":"banana"}`)).toBeNull();
    expect(parseTriageDecision(`{"decision":"skip"}`)).toBeNull(); // reason mancante
    expect(parseTriageDecision(`{"decision":"duplicate","of":0}`)).toBeNull();
    expect(parseTriageDecision(`{"decision":"duplicate","of":1.5}`)).toBeNull();
    expect(parseTriageDecision(`{"decision":"duplicate","of":"12"}`)).toBeNull();
  });
});

describe("buildTriagePrompt", () => {
  const baseTicket = {
    number: 42,
    title: "TypeError: cannot read foo",
    body: "Succede al login",
    type: "bug",
    priority: "high",
    source: "sdk_error",
    occurrences: 7,
    technicalPayload: null as unknown,
  };

  it("elenca i ticket recenti come `#N [status] titolo`", () => {
    const prompt = buildTriagePrompt({
      ticket: baseTicket,
      recentTickets: [
        { number: 12, title: "Crash al checkout", status: "open" },
        { number: 11, title: "Footer storto", status: "closed" },
      ],
    });
    expect(prompt).toContain("#12 [open] Crash al checkout");
    expect(prompt).toContain("#11 [closed] Footer storto");
  });

  it("delimita il contenuto del ticket come dato NON fidato", () => {
    const prompt = buildTriagePrompt({ ticket: baseTicket, recentTickets: [] });
    // Il tag di apertura vero sta su una riga propria (l'istruzione che lo
    // precede può citarlo nella prosa).
    const open = prompt.indexOf("\n<ticket_content>\n");
    const close = prompt.indexOf("</ticket_content>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    // Titolo, body e metadati stanno DENTRO i delimitatori.
    const inside = prompt.slice(open, close);
    expect(inside).toContain("TypeError: cannot read foo");
    expect(inside).toContain("Succede al login");
    expect(inside).toContain("bug");
    expect(inside).toContain("high");
    expect(inside).toContain("sdk_error");
    expect(inside).toContain("7");
    // L'istruzione anti prompt-injection sta FUORI, prima del contenuto.
    expect(prompt.slice(0, open)).toMatch(/UNTRUSTED/i);
    expect(prompt.slice(0, open)).toMatch(/do not follow/i);
  });

  it("include il payload tecnico e tronca lo stack a ~3000 caratteri", () => {
    const prompt = buildTriagePrompt({
      ticket: {
        ...baseTicket,
        technicalPayload: {
          message: "cannot read foo of undefined",
          stack: "x".repeat(10_000),
          url: "https://app.example.com/login",
          release: "1.2.3",
        },
      },
      recentTickets: [],
    });
    expect(prompt).toContain("cannot read foo of undefined");
    expect(prompt).toContain("https://app.example.com/login");
    expect(prompt).toContain("1.2.3");
    expect(prompt).toContain("x".repeat(3000));
    expect(prompt).not.toContain("x".repeat(3001));
    expect(prompt).toContain("[truncated]");
  });

  it("richiede il formato di output JSON stretto", () => {
    const prompt = buildTriagePrompt({ ticket: baseTicket, recentTickets: [] });
    expect(prompt).toContain(`{"decision":"fix"}`);
    expect(prompt).toContain(`"skip"`);
    expect(prompt).toContain(`"duplicate"`);
  });
});

describe("runTriage", () => {
  it("decision fix → markFixing e outcome 'fixing'; il runner riceve haiku e il workDir", async () => {
    const { db } = testDb;
    const ticket = await createTicket(db);
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({ output: `{"decision":"fix"}` });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("fixing");
    const after = await getJob(db, job.id);
    expect(after.status).toBe("fixing");
    expect(after.log).toContain("[triage]");

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.model).toBe("haiku");
    expect(runner.calls[0]?.cwd).toBe(workDir);
    expect(runner.calls[0]?.maxTurns).toBe(10);
    expect(runner.calls[0]?.timeoutMs).toBe(120_000);
  });

  it("il prompt include gli ultimi 30 ticket del progetto (escluso quello in triage)", async () => {
    const { db } = testDb;
    // 32 ticket storici: i 2 più vecchi devono restare fuori dalla lista.
    const historic: Ticket[] = [];
    for (let i = 1; i <= 32; i++) {
      historic.push(
        await createTicket(db, { title: `Ticket storico ${i}`, createdAt: minutesAgo(100 - i) }),
      );
    }
    const ticket = await createTicket(db, { title: "Ticket in triage adesso" });
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({ output: `{"decision":"fix"}` });

    await runTriage(makeDeps(runner), job);

    const prompt = runner.calls[0]?.prompt ?? "";
    expect(prompt).toContain(`#${historic[31]?.number} [open] Ticket storico 32`);
    expect(prompt).toContain(`#${historic[2]?.number} [open] Ticket storico 3\n`);
    // I due più vecchi restano fuori (limit 30): i numeri sono univoci.
    expect(prompt).not.toContain(`#${historic[1]?.number} [`);
    expect(prompt).not.toContain(`#${historic[0]?.number} [`);
    // Il ticket in triage non compare tra i recenti.
    expect(prompt).not.toContain(`#${ticket.number} [open]`);
  });

  it("decision skip → job 'skipped', commento AI col motivo, ticket invariato", async () => {
    const { db } = testDb;
    const ticket = await createTicket(db);
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","reason":"descrizione troppo vaga per un fix automatico"}`,
    });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("skipped");
    const after = await getJob(db, job.id);
    expect(after.status).toBe("skipped");
    expect(after.finishedAt).not.toBeNull();
    expect(after.log).toContain("skip");

    const ticketComments = await db.select().from(comments).where(eq(comments.ticketId, ticket.id));
    expect(ticketComments).toHaveLength(1);
    expect(ticketComments[0]?.authorType).toBe("ai");
    expect(ticketComments[0]?.authorId).toBeNull();
    expect(ticketComments[0]?.body).toContain("descrizione troppo vaga per un fix automatico");

    // Lo stato del ticket NON cambia: la decisione resta a un umano.
    expect((await getTicket(db, ticket.id)).status).toBe("open");
  });

  it("decision duplicate → ticket 'closed', commento col riferimento al duplicato, job 'skipped'", async () => {
    const { db } = testDb;
    const original = await createTicket(db, { title: "Crash originale al checkout" });
    const ticket = await createTicket(db, { title: "Crash al checkout (di nuovo)" });
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({
      output: `Sembra già noto.\n{"decision":"duplicate","of":${original.number}}`,
    });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("closed_duplicate");
    expect((await getTicket(db, ticket.id)).status).toBe("closed");
    // Il ticket originale non viene toccato.
    expect((await getTicket(db, original.id)).status).toBe("open");

    const ticketComments = await db.select().from(comments).where(eq(comments.ticketId, ticket.id));
    expect(ticketComments).toHaveLength(1);
    expect(ticketComments[0]?.authorType).toBe("ai");
    expect(ticketComments[0]?.body).toContain(`#${original.number}`);

    const after = await getJob(db, job.id);
    expect(after.status).toBe("skipped");
    expect(after.log).toContain(`#${original.number}`);
  });

  it("output non-JSON → un retry, poi job 'failed' con entrambi gli output nel log", async () => {
    const { db } = testDb;
    const ticket = await createTicket(db);
    const job = await createTriagingJob(db, ticket.id);
    let call = 0;
    const runner = new FakeAgentRunner({
      script: () => ({ output: `output spazzatura numero ${++call}`, exitCode: 0 }),
    });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("failed");
    expect(runner.calls).toHaveLength(2);
    // Stesso prompt per il retry: l'output invalido è colpa del modello.
    expect(runner.calls[1]?.prompt).toBe(runner.calls[0]?.prompt);

    const after = await getJob(db, job.id);
    expect(after.status).toBe("failed");
    expect(after.error).toBe("triage output non valido");
    expect(after.log).toContain("output spazzatura numero 1");
    expect(after.log).toContain("output spazzatura numero 2");
  });

  it("duplicate verso un numero inesistente → trattato come output non valido (retry, poi failed)", async () => {
    const { db } = testDb;
    const ticket = await createTicket(db);
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({ output: `{"decision":"duplicate","of":99999}` });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("failed");
    expect(runner.calls).toHaveLength(2);
    const after = await getJob(db, job.id);
    expect(after.status).toBe("failed");
    expect(after.error).toBe("triage output non valido");
    // Nessun commento e ticket intatto.
    expect(await db.select().from(comments).where(eq(comments.ticketId, ticket.id))).toHaveLength(
      0,
    );
    expect((await getTicket(db, ticket.id)).status).toBe("open");
  });

  it("ownership persa (markFixing false) → outcome 'failed' senza sovrascrivere il job", async () => {
    const { db } = testDb;
    const ticket = await createTicket(db);
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({
      script: async () => {
        // Mentre l'agente "gira", requeueStale riporta il job in coda (worker
        // creduto morto): la ownership è persa.
        await db.update(aiJobs).set({ status: "queued" }).where(eq(aiJobs.id, job.id));
        return { output: `{"decision":"fix"}`, exitCode: 0 };
      },
    });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("failed");
    // Il job resta `queued`: l'altro worker procede, qui non si tocca nulla.
    expect((await getJob(db, job.id)).status).toBe("queued");
  });

  it("timeout dell'agente → job 'failed' con l'output parziale nel log", async () => {
    const { db } = testDb;
    const ticket = await createTicket(db);
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({
      script: () => {
        throw new AgentTimeoutError(120_000, "output parziale prima del kill");
      },
    });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("failed");
    const after = await getJob(db, job.id);
    expect(after.status).toBe("failed");
    expect(after.log).toContain("output parziale prima del kill");
    expect(after.error).toContain("timeout");
  });

  it("errore di spawn dell'agente → job 'failed'", async () => {
    const { db } = testDb;
    const ticket = await createTicket(db);
    const job = await createTriagingJob(db, ticket.id);
    const runner = new FakeAgentRunner({
      script: () => {
        throw new AgentRunError("binario claude non trovato");
      },
    });

    const outcome = await runTriage(makeDeps(runner), job);

    expect(outcome).toBe("failed");
    const after = await getJob(db, job.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("binario claude non trovato");
  });
});
