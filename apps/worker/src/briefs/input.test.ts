import {
  activityReports,
  agentQuestions,
  aiJobs,
  projectBriefs,
  projectDecisions,
  projects,
  ticketEvents,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRIEF_INPUT_MAX_CHARS,
  collectBriefInput,
  renderTimelineEntry,
} from "./input.js";

/**
 * L'INPUT del brief settimanale: cinque sorgenti raccolte sotto un tetto.
 *
 * Su un Postgres vero perché tre delle cinque (report, timeline, decisioni) sono
 * query, e la quarta — i blocchi — passa dai segnali condivisi del pulse, che di
 * `EXISTS` ne fanno sei in una query sola.
 */
let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(projects);
  await db.delete(users);
});

afterAll(async () => {
  await testDb.stop();
});

const PERIOD = { periodStart: "2026-08-31", periodEnd: "2026-09-06" };

describe("collectBriefInput", () => {
  it("prende i report della settimana dal loro `summary`, MAI dai commit", async () => {
    const { projectId } = await seedRepository(db);
    await db.insert(activityReports).values([
      {
        projectId,
        date: "2026-09-01",
        status: "done",
        summary: "Il team ha sistemato il login.",

      },
      // Fuori periodo: non deve entrare.
      { projectId, date: "2026-08-20", status: "done", summary: "Vecchio" },
      // Non completato: non deve entrare.
      { projectId, date: "2026-09-02", status: "running", summary: "A metà" },
    ]);

    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(input.reports).toEqual([
      { date: "2026-09-01", summary: "Il team ha sistemato il login." },
    ]);
  });

  it("il report `done` SENZA riassunto non entra (nessuna riga vuota nel prompt)", async () => {
    const { projectId } = await seedRepository(db);
    await db
      .insert(activityReports)
      .values({ projectId, date: "2026-09-01", status: "done", summary: null });
    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(input.reports).toEqual([]);
  });

  it("porta gli eventi della timeline del periodo, resi in righe leggibili", async () => {
    const { projectId } = await seedRepository(db);
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 7,
        title: "Login rotto",
        body: "corpo",
        type: "bug",
        priority: "medium",
        source: "manual",
        status: "done",
        createdAt: new Date("2026-09-01T10:00:00Z"),
      })
      .returning();
    await db.insert(ticketEvents).values({
      ticketId: ticket!.id,
      actorId: null,
      kind: "status_changed",
      payload: { from: "in_review", to: "done" },
      createdAt: new Date("2026-09-03T10:00:00Z"),
    });

    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(input.timeline.some((line) => line.includes("ticket_opened"))).toBe(true);
    expect(input.timeline.some((line) => line.includes("ticket_done"))).toBe(true);
    expect(input.timeline.join("\n")).toContain("Login rotto");
    // L'ordine è quello della timeline: cronologico crescente.
    const opened = input.timeline.findIndex((l) => l.includes("ticket_opened"));
    const done = input.timeline.findIndex((l) => l.includes("ticket_done"));
    expect(opened).toBeLessThan(done);
  });

  it("i BLOCCHI correnti arrivano dai segnali condivisi, non da una query nuova", async () => {
    const { projectId } = await seedRepository(db);
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "T",
        body: "b",
        type: "bug",
        priority: "medium",
        source: "manual",
        status: "in_progress",
      })
      .returning();
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId: ticket!.id, status: "awaiting_input" })
      .returning();
    await db.insert(agentQuestions).values({
      jobId: job!.id,
      ticketId: ticket!.id,
      question: "Quale strada?",
      options: [{ label: "A" }, { label: "B" }],
      round: 1,
    });

    const input = await collectBriefInput(db, projectId, PERIOD);
    // TUTTI i segnali accesi, non solo il primo: il job è in volo (parcheggiato
    // su una domanda) E la domanda è aperta. Al lettore del brief serve la
    // seconda, che è l'unica che può sbloccare lui.
    expect(input.blocks.join("\n")).toContain("job_in_flight");
    expect(input.blocks.join("\n")).toContain("open_question");
  });

  it("progetto senza niente: tutte le sezioni vuote, nessun errore", async () => {
    const { projectId } = await seedRepository(db);
    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(input.reports).toEqual([]);
    expect(input.timeline).toEqual([]);
    expect(input.decisions).toEqual([]);
    expect(input.previousBrief).toBeNull();
    expect(input.truncated).toBe(false);
  });

  it("porta il brief PRECEDENTE `done` per continuità, e solo quello", async () => {
    const { projectId } = await seedRepository(db);
    await db.insert(projectBriefs).values([
      {
        projectId,
        periodStart: "2026-08-24",
        periodEnd: "2026-08-30",
        status: "done",
        summary: "La settimana scorsa.",
      },
      // Il brief del periodo IN CORSO non è "il precedente".
      { projectId, periodStart: PERIOD.periodStart, periodEnd: PERIOD.periodEnd, status: "queued" },
    ]);
    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(input.previousBrief).toBe("La settimana scorsa.");
  });

  it("le decisioni del periodo entrano con titolo e testo", async () => {
    const { projectId } = await seedRepository(db);
    await db.insert(projectDecisions).values({
      projectId,
      source: "manual",
      sourceKey: "manual:1",
      title: "Rimandare il refactoring",
      decision: "Se ne riparla a ottobre",
      decidedAt: new Date("2026-09-02T09:00:00Z"),
    });
    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(input.decisions.join("\n")).toContain("Rimandare il refactoring");
    expect(input.decisions.join("\n")).toContain("Se ne riparla a ottobre");
  });

  it("sopra il tetto tronca e lo DICHIARA (`truncated`), senza mai spezzare a metà riga", async () => {
    const { projectId } = await seedRepository(db);
    // Un solo report gigantesco: da solo supera il tetto.
    const huge = Array.from({ length: 4_000 }, (_, i) => `riga ${i} di un report molto lungo`).join(" ");
    await db.insert(activityReports).values({
      projectId,
      date: "2026-09-01",
      status: "done",
      summary: huge,

    });
    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(input.truncated).toBe(true);
    const total = input.reports.reduce((n, r) => n + r.summary.length, 0);
    expect(total).toBeLessThanOrEqual(BRIEF_INPUT_MAX_CHARS);
  });

  it("non guarda gli altri progetti", async () => {
    const { projectId } = await seedRepository(db);
    const other = await seedRepository(db);
    await db.insert(activityReports).values({
      projectId: other.projectId,
      date: "2026-09-01",
      status: "done",
      summary: "Roba d'altri",

    });
    const input = await collectBriefInput(db, projectId, PERIOD);
    expect(JSON.stringify(input)).not.toContain("Roba d'altri");
  });
});

describe("renderTimelineEntry", () => {
  it("rende il kind grezzo come etichetta: è un protocollo, non testo da leggere", () => {
    const line = renderTimelineEntry({
      kind: "pr_merged",
      id: "j1",
      at: "2026-09-02T10:00:00.000Z",
      ticketId: "t1",
      ticketNumber: 7,
      ticketTitle: "Login rotto",
      prUrl: "https://git.example.com/pr/1",
      reviewVerdict: "approve",
    });
    expect(line).toContain("[pr_merged]");
    expect(line).toContain("2026-09-02");
    expect(line).toContain("Login rotto");
    expect(line).toContain("approve");
    // Nessun url: non serve al modello e allunga l'input.
    expect(line).not.toContain("https://");
  });

  it("il report giornaliero NON entra nella timeline del prompt (è già una sezione a sé)", () => {
    expect(
      renderTimelineEntry({
        kind: "report_day",
        id: "r1",
        at: "2026-09-01T00:00:00.000Z",
        date: "2026-09-01",
        summary: "Testo",
      }),
    ).toBeNull();
  });
});
