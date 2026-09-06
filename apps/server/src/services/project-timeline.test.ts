import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityReports,
  aiJobs,
  milestones,
  prReviews,
  projectBriefs,
  projectDecisions,
  projectFollows,
  ticketEvents,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import {
  TIMELINE_MAX_DAYS,
  buildProjectTimeline,
  canViewProject,
  listProjectReviews,
  resolveTimelineWindow,
} from "./project-timeline.js";

/**
 * Timeline di progetto (Fase 5) su un Postgres reale: quello che conta qui
 * sono SEI sorgenti diverse fuse in un unico ordine, e nessun fake `Db`
 * saprebbe raccontare né il `payload->>'to'` di `ticket_events` né il join
 * delle review sulla PR.
 */
let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Istante fisso al centro della finestra di default, per date deterministiche. */
const NOW = new Date("2026-09-06T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const WINDOW = { from: ago(28), to: NOW };

/** Utente di comodo (le decisioni hanno un attore). */
async function seedUser(email: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return row!.id;
}

describe("resolveTimelineWindow", () => {
  it("senza parametri: finestra di 28 giorni che finisce adesso", () => {
    const result = resolveTimelineWindow({}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.to.toISOString()).toBe(NOW.toISOString());
    expect(result.window.from.toISOString()).toBe(ago(28).toISOString());
  });

  it("rispetta from/to espliciti", () => {
    const result = resolveTimelineWindow(
      { from: "2026-08-01T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(result.window.to.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("solo `from`: `to` resta adesso", () => {
    const result = resolveTimelineWindow({ from: ago(5).toISOString() }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.to.toISOString()).toBe(NOW.toISOString());
  });

  it("solo `to`: `from` è 28 giorni prima di QUEL `to`, non di adesso", () => {
    const result = resolveTimelineWindow({ to: "2026-08-10T00:00:00.000Z" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.from.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("finestra oltre 180 giorni: rifiutata", () => {
    const result = resolveTimelineWindow(
      { from: ago(TIMELINE_MAX_DAYS + 1).toISOString(), to: NOW.toISOString() },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "window_too_large" });
  });

  it("esattamente 180 giorni: ammessa (il limite è incluso)", () => {
    const result = resolveTimelineWindow(
      { from: ago(TIMELINE_MAX_DAYS).toISOString(), to: NOW.toISOString() },
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it("`from` dopo `to`: intervallo invertito, rifiutato", () => {
    const result = resolveTimelineWindow(
      { from: "2026-08-10T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_range" });
  });
});

describe("buildProjectTimeline", () => {
  /**
   * Un progetto con UNA voce per ogni sorgente, tutte dentro la finestra:
   * è il caso che verifica che nessuna sorgente sia stata dimenticata.
   */
  async function seedFullProject() {
    const { projectId, repositoryId } = await seedRepository(db);
    const userId = await seedUser(`decisore-${projectId}@example.com`);

    // Ticket aperto 20 giorni fa e chiuso 3 giorni fa (evento di sistema).
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
        createdAt: ago(20),
      })
      .returning();
    // L'evento di chiusura nella forma che scrive `recordTicketStatusChange`
    // (kind `status_changed`, `actor_id` null = sistema), datato a mano: qui
    // conta DOVE la timeline lo colloca, non chi l'ha scritto.
    const [doneEvent] = await db
      .insert(ticketEvents)
      .values({
        ticketId: ticket!.id,
        actorId: null,
        kind: "status_changed",
        payload: { from: "in_review", to: "done" },
        createdAt: ago(3),
      })
      .returning();

    // Milestone con scadenza fra la finestra e chiusura dentro la finestra.
    const [milestone] = await db
      .insert(milestones)
      .values({
        projectId,
        name: "Rilascio autunno",
        dueDate: ago(10),
        status: "closed",
        closedAt: ago(8),
      })
      .returning();

    // Job che ha aperto una PR 15 giorni fa, mergiata 5 giorni fa.
    const [job] = await db
      .insert(aiJobs)
      .values({
        ticketId: ticket!.id,
        status: "pr_merged",
        prUrl: "https://git.example.com/pr/42",
        finishedAt: ago(15),
        lastActivityAt: ago(5),
      })
      .returning();

    // Review AI di quella stessa PR, con verdetto e riassunto in breve.
    await db.insert(prReviews).values({
      repositoryId,
      prNumber: 42,
      prUrl: "https://git.example.com/pr/42",
      prTitle: "Fix login",
      headSha: "abc123",
      ticketId: ticket!.id,
      status: "completed",
      verdict: "approve",
      summary: "analisi lunga",
      prSummary: "Sistema il login. La review non ha trovato problemi.",
      finishedAt: ago(14),
    });

    // Report giornaliero completato.
    const [report] = await db
      .insert(activityReports)
      .values({
        projectId,
        date: isoDay(ago(2)),
        status: "done",
        summary: "Giornata di rifiniture.",
      })
      .returning();

    // Decisione umana registrata.
    const [decision] = await db
      .insert(projectDecisions)
      .values({
        projectId,
        source: "plan_review",
        sourceKey: `plan_review:${job!.id}:1`,
        title: "Approvato il piano del ticket #7",
        decision: "Procedere con il fix proposto",
        decidedByUserId: userId,
        decidedAt: ago(6),
      })
      .returning();

    // Brief settimanale completato.
    const [brief] = await db
      .insert(projectBriefs)
      .values({
        projectId,
        periodStart: isoDay(ago(14)),
        periodEnd: isoDay(ago(8)),
        status: "done",
        summary: "Il progetto avanza.",
        sections: { whereWeAre: "Siamo a metà del rilascio." },
        finishedAt: ago(7),
      })
      .returning();

    return {
      projectId,
      repositoryId,
      userId,
      ticketId: ticket!.id,
      doneEventId: doneEvent!.id,
      milestoneId: milestone!.id,
      jobId: job!.id,
      reportId: report!.id,
      decisionId: decision!.id,
      briefId: brief!.id,
    };
  }

  it("fonde tutte le sorgenti in un unico elenco ordinato per `at` crescente", async () => {
    const seed = await seedFullProject();
    const entries = await buildProjectTimeline(db, seed.projectId, WINDOW);

    // 9 voci: ticket aperto, PR aperta, milestone scaduta, milestone chiusa,
    // brief, decisione, PR mergiata, ticket chiuso, report.
    expect(entries.map((entry) => entry.kind)).toEqual([
      "ticket_opened",
      "pr_opened",
      "milestone_due",
      "milestone_closed",
      "brief",
      "decision",
      "pr_merged",
      "ticket_done",
      "report_day",
    ]);
    // Ordine crescente, senza eccezioni.
    const times = entries.map((entry) => entry.at);
    expect([...times].sort()).toEqual(times);
  });

  it("la voce PR porta verdetto e riassunto della review di quella PR", async () => {
    const seed = await seedFullProject();
    const entries = await buildProjectTimeline(db, seed.projectId, WINDOW);
    const merged = entries.find((entry) => entry.kind === "pr_merged");
    expect(merged).toMatchObject({
      kind: "pr_merged",
      prUrl: "https://git.example.com/pr/42",
      ticketNumber: 7,
      ticketTitle: "Login rotto",
      reviewVerdict: "approve",
      prSummary: "Sistema il login. La review non ha trovato problemi.",
    });
  });

  it("una PR senza review non porta né verdetto né riassunto (campi ASSENTI, non null)", async () => {
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
        createdAt: ago(9),
      })
      .returning();
    await db.insert(aiJobs).values({
      ticketId: ticket!.id,
      status: "pr_opened",
      prUrl: "https://git.example.com/pr/999",
      finishedAt: ago(9),
      lastActivityAt: ago(9),
    });

    const entries = await buildProjectTimeline(db, projectId, WINDOW);
    const opened = entries.find((entry) => entry.kind === "pr_opened")!;
    expect(opened).not.toHaveProperty("reviewVerdict");
    expect(opened).not.toHaveProperty("prSummary");
  });

  it("la finestra filtra: ciò che sta fuori non compare", async () => {
    const seed = await seedFullProject();
    const entries = await buildProjectTimeline(db, seed.projectId, {
      from: ago(4),
      to: NOW,
    });
    // Restano solo ticket chiuso (3g) e report (2g).
    expect(entries.map((entry) => entry.kind)).toEqual(["ticket_done", "report_day"]);
  });

  it("`kinds` filtra per tipo di voce", async () => {
    const seed = await seedFullProject();
    const entries = await buildProjectTimeline(db, seed.projectId, WINDOW, new Set(["pr_merged"]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("pr_merged");
  });

  it("il report ancora in corso non entra: solo i report `done`", async () => {
    const { projectId } = await seedRepository(db);
    await db
      .insert(activityReports)
      .values({ projectId, date: isoDay(ago(2)), status: "running" });
    expect(await buildProjectTimeline(db, projectId, WINDOW)).toEqual([]);
  });

  it("il brief ancora in corso non entra: solo i brief `done`", async () => {
    const { projectId } = await seedRepository(db);
    await db.insert(projectBriefs).values({
      projectId,
      periodStart: isoDay(ago(14)),
      periodEnd: isoDay(ago(8)),
      status: "running",
    });
    expect(await buildProjectTimeline(db, projectId, WINDOW)).toEqual([]);
  });

  it("un altro progetto non contamina la timeline", async () => {
    const seed = await seedFullProject();
    const other = await seedRepository(db);
    const entries = await buildProjectTimeline(db, other.projectId, WINDOW);
    expect(entries).toEqual([]);
    expect(await buildProjectTimeline(db, seed.projectId, WINDOW)).not.toEqual([]);
  });

  it("la decisione porta titolo, testo e attore; il brief la sua prima sezione", async () => {
    const seed = await seedFullProject();
    const entries = await buildProjectTimeline(db, seed.projectId, WINDOW);
    expect(entries.find((entry) => entry.kind === "decision")).toMatchObject({
      title: "Approvato il piano del ticket #7",
      decision: "Procedere con il fix proposto",
      decidedBy: { id: seed.userId },
    });
    expect(entries.find((entry) => entry.kind === "brief")).toMatchObject({
      headline: "Siamo a metà del rilascio.",
    });
  });
});

describe("listProjectReviews", () => {
  it("elenca le review del progetto, senza mai l'errore interno", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    await db.insert(prReviews).values({
      repositoryId,
      prNumber: 3,
      prUrl: "https://git.example.com/pr/3",
      prTitle: "Titolo",
      headSha: "sha",
      status: "failed",
      error: "/worker/tmp/segreto: boom",
    });
    const reviews = await listProjectReviews(db, projectId, 50);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ prNumber: 3, verdict: null, prSummary: null });
    expect(JSON.stringify(reviews)).not.toContain("segreto");
  });

  it("non vede le review di un altro progetto", async () => {
    const { repositoryId } = await seedRepository(db);
    const other = await seedRepository(db);
    await db.insert(prReviews).values({
      repositoryId,
      prNumber: 4,
      prUrl: "https://git.example.com/pr/4",
      prTitle: "T",
      headSha: "s",
      status: "completed",
      verdict: "request_changes",
    });
    expect(await listProjectReviews(db, other.projectId, 50)).toEqual([]);
  });
});

describe("canViewProject", () => {
  it("l'admin vede qualunque progetto, anche non seguito", async () => {
    const { projectId } = await seedRepository(db);
    const adminId = await seedUser(`admin-${projectId}@example.com`);
    expect(await canViewProject(db, projectId, { userId: adminId, role: "admin" })).toBe(true);
  });

  it("il member vede solo i progetti che segue", async () => {
    const { projectId } = await seedRepository(db);
    const memberId = await seedUser(`member-${projectId}@example.com`);
    expect(await canViewProject(db, projectId, { userId: memberId, role: "member" })).toBe(false);
    await db.insert(projectFollows).values({ projectId, userId: memberId });
    expect(await canViewProject(db, projectId, { userId: memberId, role: "member" })).toBe(true);
  });
});

// --- utilità locali -------------------------------------------------------

/** `YYYY-MM-DD` di una data (le colonne `date` di Postgres). */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
