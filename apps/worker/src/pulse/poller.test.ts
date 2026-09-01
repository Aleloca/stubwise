import {
  agentQuestions,
  aiJobs,
  backlogCodeSessions,
  backlogItems,
  backlogJobs,
  notificationDeliveries,
  notifications,
  projects,
  ticketRepositories,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import {
  seedRepositoryInProject,
  seedTicketRepository,
  startTestDb,
  type TestDb,
} from "@stubwise/db/testing";
import { inboxQuestionSchema } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isProjectIdle, listCandidates, type PulseCandidate } from "./signals.js";
import {
  buildPulseEvent,
  idleDaysFrom,
  isInSendWindow,
  MAX_PROPOSALS,
  pollPulseOnce,
  rankCandidates,
  type PulseLogger,
  type PulsePollerDeps,
} from "./poller.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  // Tutto cade in cascata dal progetto; gli utenti hanno una radice propria.
  await db.delete(projects);
  await db.delete(users);
});

afterAll(async () => {
  await testDb.stop();
});

/** Logger muto: i test non asseriscono sui log. */
const silentLogger: PulseLogger = { info: () => {}, error: () => {} };

const DAY_MS = 24 * 60 * 60 * 1000;

// Martedì 1 settembre 2026, 07:30 UTC = 09:30 a Roma (CEST, +2).
const TUE_0930_ROME = new Date("2026-09-01T07:30:00.000Z");

/** Candidato sintetico per i test delle funzioni pure. */
function candidate(over: Partial<PulseCandidate> = {}): PulseCandidate {
  return {
    id: randomUUID(),
    title: "Una proposta",
    urgency: "medium",
    effort: 3,
    status: "new",
    hasAnalysis: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Funzioni pure: finestra oraria
// ---------------------------------------------------------------------------

describe("isInSendWindow", () => {
  const utc9 = { timezone: "UTC", hour: 9, weekdaysOnly: true };
  const rome9 = { timezone: "Europe/Rome", hour: 9, weekdaysOnly: true };

  it("apre la finestra nell'ora locale scelta e la chiude subito dopo", () => {
    expect(isInSendWindow(new Date("2026-09-01T09:00:00.000Z"), utc9)).toBe(true);
    expect(isInSendWindow(new Date("2026-09-01T09:59:59.000Z"), utc9)).toBe(true);
    expect(isInSendWindow(new Date("2026-09-01T08:59:59.000Z"), utc9)).toBe(false);
    expect(isInSendWindow(new Date("2026-09-01T10:00:00.000Z"), utc9)).toBe(false);
  });

  it("legge l'ora nel FUSO configurato, non in UTC (Europe/Rome: 9:30 locali = 7:30 UTC)", () => {
    expect(isInSendWindow(TUE_0930_ROME, rome9)).toBe(true);
    // Le 9:30 UTC a Roma sono le 11:30: fuori finestra.
    expect(isInSendWindow(new Date("2026-09-01T09:30:00.000Z"), rome9)).toBe(false);
  });

  it("segue l'ora legale del fuso (inverno: 9:30 a Roma = 8:30 UTC)", () => {
    // 1 dicembre 2026 (martedì), CET (+1).
    expect(isInSendWindow(new Date("2026-12-01T08:30:00.000Z"), rome9)).toBe(true);
    expect(isInSendWindow(new Date("2026-12-01T07:30:00.000Z"), rome9)).toBe(false);
  });

  it("tace nel weekend quando weekdaysOnly è acceso, e parla quando è spento", () => {
    const sat = new Date("2026-09-05T07:30:00.000Z"); // sabato 9:30 a Roma
    const sun = new Date("2026-09-06T07:30:00.000Z"); // domenica 9:30 a Roma
    expect(isInSendWindow(sat, rome9)).toBe(false);
    expect(isInSendWindow(sun, rome9)).toBe(false);
    expect(isInSendWindow(sat, { ...rome9, weekdaysOnly: false })).toBe(true);
    expect(isInSendWindow(sun, { ...rome9, weekdaysOnly: false })).toBe(true);
  });

  it("gestisce la mezzanotte (ora 0): l'ora locale è 0, non 24", () => {
    const midnight = { timezone: "UTC", hour: 0, weekdaysOnly: true };
    expect(isInSendWindow(new Date("2026-09-01T00:30:00.000Z"), midnight)).toBe(true);
    expect(isInSendWindow(new Date("2026-09-01T23:30:00.000Z"), midnight)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Funzioni pure: ranking
// ---------------------------------------------------------------------------

describe("rankCandidates", () => {
  it("mette l'urgenza prima di tutto (urgent > high > medium > low)", () => {
    const ranked = rankCandidates([
      candidate({ title: "low", urgency: "low" }),
      candidate({ title: "urgent", urgency: "urgent" }),
      candidate({ title: "medium", urgency: "medium" }),
      candidate({ title: "high", urgency: "high" }),
    ]);
    expect(ranked.map((c) => c.title)).toEqual(["urgent", "high", "medium", "low"]);
  });

  it("tratta l'urgenza mancante come `medium`", () => {
    const ranked = rankCandidates([
      candidate({ title: "low", urgency: "low" }),
      candidate({ title: "senza", urgency: null }),
      candidate({ title: "high", urgency: "high" }),
    ]);
    expect(ranked.map((c) => c.title)).toEqual(["high", "senza", "low"]);
  });

  it("a parità di urgenza preferisce l'effort minore, e l'effort mancante vale 3", () => {
    const ranked = rankCandidates([
      candidate({ title: "e5", effort: 5 }),
      candidate({ title: "e1", effort: 1 }),
      candidate({ title: "senza", effort: null }),
      candidate({ title: "e2", effort: 2 }),
    ]);
    expect(ranked.map((c) => c.title)).toEqual(["e1", "e2", "senza", "e5"]);
  });

  it("a parità di urgenza ed effort preferisce le voci `ready`", () => {
    const ranked = rankCandidates([
      candidate({ title: "new", status: "new" }),
      candidate({ title: "ready", status: "ready" }),
      candidate({ title: "refining", status: "refining" }),
    ]);
    expect(ranked[0]!.title).toBe("ready");
  });

  it("poi preferisce chi ha già l'analisi tecnica", () => {
    const ranked = rankCandidates([
      candidate({ title: "senza analisi", hasAnalysis: false }),
      candidate({ title: "con analisi", hasAnalysis: true }),
    ]);
    expect(ranked.map((c) => c.title)).toEqual(["con analisi", "senza analisi"]);
  });

  it("a parità di tutto vince la più VECCHIA (createdAt crescente)", () => {
    const ranked = rankCandidates([
      candidate({ title: "nuova", createdAt: new Date("2026-05-01T00:00:00.000Z") }),
      candidate({ title: "vecchia", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
    ]);
    expect(ranked.map((c) => c.title)).toEqual(["vecchia", "nuova"]);
  });

  it("non muta l'array in ingresso", () => {
    const items = [
      candidate({ title: "b", urgency: "low" }),
      candidate({ title: "a", urgency: "urgent" }),
    ];
    rankCandidates(items);
    expect(items.map((c) => c.title)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// Funzioni pure: idleDays e payload
// ---------------------------------------------------------------------------

describe("idleDaysFrom", () => {
  const now = new Date("2026-09-01T09:00:00.000Z");

  it("conta i giorni interi dall'ultima attività", () => {
    expect(idleDaysFrom(now, new Date("2026-08-28T09:00:00.000Z"))).toBe(4);
    expect(idleDaysFrom(now, new Date("2026-08-31T20:00:00.000Z"))).toBe(0);
  });

  it("vale 0 quando l'attività non esiste o è nel futuro (orologi sfasati)", () => {
    expect(idleDaysFrom(now, null)).toBe(0);
    expect(idleDaysFrom(now, new Date("2026-09-02T00:00:00.000Z"))).toBe(0);
  });
});

describe("buildPulseEvent", () => {
  const proposals = [
    candidate({
      title: "Export CSV",
      urgency: "high",
      effort: 2,
      hasAnalysis: true,
      status: "ready",
    }),
    candidate({ title: "Filtro per stato", urgency: "medium", effort: 1 }),
    candidate({ title: "Senza metadati", urgency: null, effort: null }),
  ];
  const pulseId = randomUUID();
  const projectId = randomUUID();
  const event = buildPulseEvent({
    pulseId,
    projectId,
    projectName: "negozio-web",
    publicUrl: "https://stubwise.example.com",
    idleDays: 4,
    proposals,
  });

  it("REQUISITO DI ALLINEAMENTO: options[i] descrive proposals[i], indice per indice", () => {
    // L'indice cliccato viaggia su `options` e agisce su `proposals`: un
    // disallineamento farebbe partire la voce sbagliata.
    expect(event.options).toHaveLength(event.proposals.length);
    event.options.forEach((option, i) => {
      expect(option.label).toBe(event.proposals[i]!.title);
    });
    expect(event.proposals.map((p) => p.backlogItemId)).toEqual(proposals.map((c) => c.id));
  });

  it("porta i metadati che hanno deciso l'ordine, dentro `proposals`", () => {
    expect(event.proposals[0]).toEqual({
      backlogItemId: proposals[0]!.id,
      title: "Export CSV",
      urgency: "high",
      effort: 2,
      hasAnalysis: true,
    });
    expect(event.proposals[2]).toMatchObject({ urgency: null, effort: null, hasAnalysis: false });
  });

  it("mette nel contesto dell'opzione solo i metadati che esistono", () => {
    expect(event.options[0]!.consequence).toBe("urgenza alta · effort 2 · analisi pronta");
    expect(event.options[1]!.consequence).toBe("urgenza media · effort 1");
    // Senza urgenza né effort né analisi non resta niente da dire.
    expect(event.options[2]!.consequence).toBeUndefined();
  });

  it("è una domanda a scelta chiusa, con la prima proposta consigliata", () => {
    expect(event.recommendedIndex).toBe(0);
    expect(event.allowFreeText).toBe(false);
    expect(event.pulseId).toBe(pulseId);
    expect(event.idleDays).toBe(4);
  });

  it("il link porta al backlog FILTRATO sul progetto", () => {
    expect(event.projectUrl).toBe(`https://stubwise.example.com/backlog?projectId=${projectId}`);
  });

  it("il payload regge `inboxQuestionSchema` con pulseId al posto di questionId", () => {
    // È la validazione che `renderItem` fa sulla card: se cade, la card degrada
    // a testo e le proposte non sono più cliccabili.
    const parsed = inboxQuestionSchema.safeParse({ ...event, questionId: event.pulseId });
    expect(parsed.success).toBe(true);
  });

  it("il testo della domanda regge 0 e 1 giorno senza sbagliare il plurale", () => {
    for (const idleDays of [0, 1, 2]) {
      const built = buildPulseEvent({
        pulseId: randomUUID(),
        projectId: randomUUID(),
        projectName: "negozio-web",
        publicUrl: "",
        idleDays,
        proposals: [proposals[0]!],
      });
      // Forma `etichetta: N`, la stessa del catalogo i18n: nessun plurale da
      // accordare, quindi nessun "da 1 giorni".
      expect(built.question).toContain(`giorni di fermo: ${idleDays}`);
      expect(built.question).not.toMatch(/da 1 giorni|da 0 giorni/);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper di seeding
// ---------------------------------------------------------------------------

interface SeedProjectOpts {
  pulseEnabled?: boolean;
  backlogEnabled?: boolean;
  pulseEveryDays?: number;
  pulseLastSentAt?: Date | null;
  name?: string;
}

async function seedProject(opts: SeedProjectOpts = {}): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      name: opts.name ?? "Pulse",
      slug: `pulse-${randomUUID()}`,
      ingestionKey: randomUUID(),
      pulseEnabled: opts.pulseEnabled ?? true,
      backlogEnabled: opts.backlogEnabled ?? true,
      ...(opts.pulseEveryDays !== undefined ? { pulseEveryDays: opts.pulseEveryDays } : {}),
      ...(opts.pulseLastSentAt !== undefined ? { pulseLastSentAt: opts.pulseLastSentAt } : {}),
    })
    .returning({ id: projects.id });
  return project!.id;
}

async function seedAdmin(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.com`,
      passwordHash: "hash",
      role: "admin",
      language: "it",
    })
    .returning({ id: users.id });
  return user!.id;
}

interface SeedItemOpts {
  projectId: string;
  title?: string;
  status?: "new" | "refining" | "ready" | "converted" | "archived";
  document?: string;
  urgency?: "low" | "medium" | "high" | "urgent" | null;
  effort?: number | null;
  createdAt?: Date;
}

async function seedItem(opts: SeedItemOpts): Promise<string> {
  const [item] = await db
    .insert(backlogItems)
    .values({
      projectId: opts.projectId,
      title: opts.title ?? "Voce",
      document: opts.document ?? "Un corpo qualsiasi.",
      status: opts.status ?? "new",
      source: "manual",
      ...(opts.urgency !== undefined ? { urgency: opts.urgency } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: backlogItems.id });
  return item!.id;
}

/** Ticket + job AI: la coppia che serve a simulare "lavoro in corso". */
async function seedTicket(projectId: string, number = 1): Promise<string> {
  const [ticket] = await db
    .insert(tickets)
    .values({
      projectId,
      number,
      title: "Ticket",
      type: "bug",
      priority: "medium",
      source: "manual",
    })
    .returning({ id: tickets.id });
  return ticket!.id;
}

async function seedJob(
  ticketId: string,
  status: "queued" | "fixing" | "pr_merged" | "failed" | "awaiting_input",
  lastActivityAt?: Date,
): Promise<string> {
  const [job] = await db
    .insert(aiJobs)
    .values({ ticketId, status, ...(lastActivityAt ? { lastActivityAt } : {}) })
    .returning({ id: aiJobs.id });
  return job!.id;
}

function deps(over: Partial<PulsePollerDeps> = {}): PulsePollerDeps {
  return {
    db,
    publicUrl: "https://stubwise.example.com",
    sendWindow: { timezone: "Europe/Rome", hour: 9, weekdaysOnly: true },
    now: () => TUE_0930_ROME,
    logger: silentLogger,
    ...over,
  };
}

async function pulseRows(projectId?: string) {
  return await db
    .select({
      id: notifications.id,
      status: notifications.status,
      userId: notifications.userId,
      projectId: notifications.projectId,
      event: notifications.event,
    })
    .from(notifications)
    .where(
      projectId
        ? and(eq(notifications.kind, "project.pulse"), eq(notifications.projectId, projectId))
        : eq(notifications.kind, "project.pulse"),
    );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Segnali
// ---------------------------------------------------------------------------

describe("isProjectIdle", () => {
  it("un progetto senza nulla in corso è fermo", async () => {
    const projectId = await seedProject();
    const idleness = await isProjectIdle(db, projectId);
    expect(idleness).toMatchObject({ idle: true, blocker: null });
  });

  it("un job AI IN VOLO blocca il ping (uno per stato in volo)", async () => {
    for (const status of ["queued", "fixing", "awaiting_input"] as const) {
      const projectId = await seedProject();
      const ticketId = await seedTicket(projectId);
      await seedJob(ticketId, status);
      expect(await isProjectIdle(db, projectId)).toMatchObject({
        idle: false,
        blocker: "job_in_flight",
      });
      await db.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("un job CHIUSO non blocca nulla", async () => {
    const projectId = await seedProject();
    const ticketId = await seedTicket(projectId);
    await seedJob(ticketId, "pr_merged");
    expect(await isProjectIdle(db, projectId)).toMatchObject({ idle: true });
  });

  it("una domanda dell'agente ancora APERTA blocca il ping", async () => {
    const projectId = await seedProject();
    const ticketId = await seedTicket(projectId);
    const jobId = await seedJob(ticketId, "pr_merged");
    await db.insert(agentQuestions).values({
      jobId,
      ticketId,
      round: 1,
      question: "Come procediamo?",
      options: [{ label: "A" }, { label: "B" }],
    });
    expect(await isProjectIdle(db, projectId)).toMatchObject({
      idle: false,
      blocker: "open_question",
    });
  });

  it("una domanda già RISPOSTA non blocca nulla", async () => {
    const projectId = await seedProject();
    const ticketId = await seedTicket(projectId);
    const jobId = await seedJob(ticketId, "pr_merged");
    await db.insert(agentQuestions).values({
      jobId,
      ticketId,
      round: 1,
      question: "Come procediamo?",
      options: [{ label: "A" }],
      answer: { optionIndex: 0 },
      answeredAt: new Date(),
    });
    expect(await isProjectIdle(db, projectId)).toMatchObject({ idle: true });
  });

  it("una PR ancora APERTA blocca il ping, una chiusa no", async () => {
    const projectId = await seedProject();
    const ticketId = await seedTicket(projectId);
    const repositoryId = await seedRepositoryInProject(db, projectId);
    await seedTicketRepository(db, { ticketId, repositoryId });
    expect(await isProjectIdle(db, projectId)).toMatchObject({ idle: false, blocker: "open_pr" });

    await db
      .update(ticketRepositories)
      .set({ prState: "merged" })
      .where(eq(ticketRepositories.ticketId, ticketId));
    expect(await isProjectIdle(db, projectId)).toMatchObject({ idle: true });
  });

  it("un backlog_job queued o running blocca il ping", async () => {
    for (const status of ["queued", "running"] as const) {
      const projectId = await seedProject();
      await db
        .insert(backlogJobs)
        .values({ projectId, kind: "intake", status, payload: { ticketId: randomUUID() } });
      expect(await isProjectIdle(db, projectId)).toMatchObject({
        idle: false,
        blocker: "backlog_job",
      });
      await db.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("una sessione di analisi codice ATTIVA blocca il ping", async () => {
    const projectId = await seedProject();
    const itemId = await seedItem({ projectId });
    const repositoryId = await seedRepositoryInProject(db, projectId);
    await db.insert(backlogCodeSessions).values({ itemId, repositoryId, status: "active" });
    expect(await isProjectIdle(db, projectId)).toMatchObject({
      idle: false,
      blocker: "code_session",
    });

    await db
      .update(backlogCodeSessions)
      .set({ status: "closed" })
      .where(eq(backlogCodeSessions.itemId, itemId));
    expect(await isProjectIdle(db, projectId)).toMatchObject({ idle: true });
  });

  it("i segnali di un ALTRO progetto non contano", async () => {
    const projectId = await seedProject();
    const otherId = await seedProject();
    const otherTicket = await seedTicket(otherId);
    await seedJob(otherTicket, "fixing");
    await db.insert(backlogJobs).values({
      projectId: otherId,
      kind: "intake",
      status: "queued",
      payload: { ticketId: randomUUID() },
    });
    expect(await isProjectIdle(db, projectId)).toMatchObject({ idle: true });
  });

  it("riporta l'ultima attività AI del progetto (la base di idleDays)", async () => {
    const projectId = await seedProject();
    const ticketId = await seedTicket(projectId);
    await seedJob(ticketId, "pr_merged", new Date("2026-08-20T10:00:00.000Z"));
    await seedJob(ticketId, "failed", new Date("2026-08-28T10:00:00.000Z"));
    const idleness = await isProjectIdle(db, projectId);
    expect(idleness.lastJobActivityAt?.toISOString()).toBe("2026-08-28T10:00:00.000Z");
  });

  it("senza job mai eseguiti l'ultima attività è null", async () => {
    const projectId = await seedProject();
    expect((await isProjectIdle(db, projectId)).lastJobActivityAt).toBeNull();
  });
});

describe("listCandidates", () => {
  it("prende solo new/refining/ready con un documento non vuoto", async () => {
    const projectId = await seedProject();
    await seedItem({ projectId, title: "new", status: "new" });
    await seedItem({ projectId, title: "refining", status: "refining" });
    await seedItem({ projectId, title: "ready", status: "ready" });
    await seedItem({ projectId, title: "converted", status: "converted" });
    await seedItem({ projectId, title: "archived", status: "archived" });
    await seedItem({ projectId, title: "vuota", document: "" });
    await seedItem({ projectId, title: "solo spazi", document: "   \n  " });

    const found = await listCandidates(db, projectId);
    expect(found.map((c) => c.title).sort()).toEqual(["new", "ready", "refining"]);
  });

  it("segnala l'analisi tecnica quando la sezione c'è", async () => {
    const projectId = await seedProject();
    await seedItem({
      projectId,
      title: "con",
      document: "Testo\n\n## Analisi tecnica\n\nDettagli.",
    });
    await seedItem({ projectId, title: "senza", document: "Testo e basta." });
    const byTitle = new Map((await listCandidates(db, projectId)).map((c) => [c.title, c]));
    expect(byTitle.get("con")!.hasAnalysis).toBe(true);
    expect(byTitle.get("senza")!.hasAnalysis).toBe(false);
  });

  it("esclude la voce con un backlog_job ATTIVO su di lei", async () => {
    const projectId = await seedProject();
    const busy = await seedItem({ projectId, title: "occupata" });
    await seedItem({ projectId, title: "libera" });
    await db.insert(backlogJobs).values({
      projectId,
      kind: "deep_dive",
      status: "running",
      payload: { itemId: busy, repositoryId: randomUUID() },
    });
    expect((await listCandidates(db, projectId)).map((c) => c.title)).toEqual(["libera"]);
  });

  it("un backlog_job già CHIUSO non esclude nulla", async () => {
    const projectId = await seedProject();
    const itemId = await seedItem({ projectId, title: "voce" });
    await db.insert(backlogJobs).values({
      projectId,
      kind: "deep_dive",
      status: "done",
      payload: { itemId, repositoryId: randomUUID() },
    });
    expect((await listCandidates(db, projectId)).map((c) => c.title)).toEqual(["voce"]);
  });

  it("non guarda le voci di altri progetti", async () => {
    const projectId = await seedProject();
    const otherId = await seedProject();
    await seedItem({ projectId: otherId, title: "altrui" });
    expect(await listCandidates(db, projectId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Il poller
// ---------------------------------------------------------------------------

describe("pollPulseOnce — finestra e abilitazioni", () => {
  it("fuori dalla finestra oraria non guarda nemmeno i progetti", async () => {
    await seedAdmin();
    const projectId = await seedProject();
    await seedItem({ projectId });
    const published = await pollPulseOnce(
      deps({ now: () => new Date("2026-09-01T12:00:00.000Z") }),
    );
    expect(published).toBe(0);
    expect(await pulseRows()).toHaveLength(0);
  });

  it("nel weekend non manda nulla", async () => {
    await seedAdmin();
    const projectId = await seedProject();
    await seedItem({ projectId });
    expect(await pollPulseOnce(deps({ now: () => new Date("2026-09-05T07:30:00.000Z") }))).toBe(0);
  });

  it("ignora i progetti senza pulseEnabled o senza backlogEnabled", async () => {
    await seedAdmin();
    const noPulse = await seedProject({ pulseEnabled: false });
    const noBacklog = await seedProject({ backlogEnabled: false });
    await seedItem({ projectId: noPulse });
    await seedItem({ projectId: noBacklog });
    expect(await pollPulseOnce(deps())).toBe(0);
    expect(await pulseRows()).toHaveLength(0);
  });
});

describe("pollPulseOnce — candidati e proposte", () => {
  it("senza candidati non manda nulla e non consuma la cadenza", async () => {
    await seedAdmin();
    const projectId = await seedProject();
    expect(await pollPulseOnce(deps())).toBe(0);
    const [row] = await db
      .select({ pulseLastSentAt: projects.pulseLastSentAt })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(row!.pulseLastSentAt).toBeNull();
  });

  it("con UNA sola voce propone quella", async () => {
    await seedAdmin();
    const projectId = await seedProject();
    await seedItem({ projectId, title: "L'unica" });
    expect(await pollPulseOnce(deps())).toBe(1);
    const [row] = await pulseRows(projectId);
    const event = row!.event as { options: { label: string }[]; proposals: unknown[] };
    expect(event.options.map((o) => o.label)).toEqual(["L'unica"]);
    expect(event.proposals).toHaveLength(1);
  });

  it(`con più voci ne propone al massimo ${MAX_PROPOSALS}, nell'ordine del ranking`, async () => {
    await seedAdmin();
    const projectId = await seedProject();
    await seedItem({ projectId, title: "bassa", urgency: "low" });
    await seedItem({ projectId, title: "urgente", urgency: "urgent" });
    await seedItem({ projectId, title: "alta", urgency: "high" });
    await seedItem({ projectId, title: "media", urgency: "medium" });
    await seedItem({ projectId, title: "altra bassa", urgency: "low" });

    expect(await pollPulseOnce(deps())).toBe(1);
    const [row] = await pulseRows(projectId);
    const event = row!.event as {
      options: { label: string }[];
      proposals: { title: string }[];
    };
    expect(event.options.map((o) => o.label)).toEqual(["urgente", "alta", "media"]);
    // Allineamento indice per indice, anche sul payload PERSISTITO.
    event.options.forEach((option, i) => {
      expect(option.label).toBe(event.proposals[i]!.title);
    });
  });

  it("un progetto FERMO ma con un segnale acceso non riceve nulla", async () => {
    await seedAdmin();
    const projectId = await seedProject();
    await seedItem({ projectId });
    const ticketId = await seedTicket(projectId);
    await seedJob(ticketId, "queued");
    expect(await pollPulseOnce(deps())).toBe(0);
  });

  it("il payload persistito porta idleDays e l'url del backlog del progetto", async () => {
    await seedAdmin();
    const projectId = await seedProject({ name: "negozio-web" });
    await seedItem({ projectId });
    const ticketId = await seedTicket(projectId);
    // Ultima attività AI: 4 giorni prima di `now`.
    await seedJob(ticketId, "pr_merged", new Date(TUE_0930_ROME.getTime() - 4 * DAY_MS - 1000));

    await pollPulseOnce(deps());
    const [row] = await pulseRows(projectId);
    const event = row!.event as {
      idleDays: number;
      projectUrl: string;
      projectName: string;
      question: string;
    };
    expect(event.idleDays).toBe(4);
    expect(event.projectName).toBe("negozio-web");
    expect(event.projectUrl).toBe(`https://stubwise.example.com/backlog?projectId=${projectId}`);
    expect(event.question).toContain("giorni di fermo: 4");
  });
});

describe("pollPulseOnce — cadenza", () => {
  it("un secondo tick nello stesso giorno non manda un secondo pulse", async () => {
    await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 3 });
    await seedItem({ projectId });

    expect(await pollPulseOnce(deps())).toBe(1);
    expect(await pollPulseOnce(deps())).toBe(0);
    expect(await pulseRows(projectId)).toHaveLength(1);
  });

  it("dopo `pulseEveryDays` giorni ne manda un altro", async () => {
    await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 3 });
    await seedItem({ projectId });

    expect(await pollPulseOnce(deps())).toBe(1);
    // Due giorni dopo (stessa ora locale): ancora presto.
    const plus = (days: number) => new Date(TUE_0930_ROME.getTime() + days * DAY_MS);
    expect(await pollPulseOnce(deps({ now: () => plus(2) }))).toBe(0);
    // Quattro giorni dopo è sabato: fuori dai giorni ammessi.
    expect(await pollPulseOnce(deps({ now: () => plus(4) }))).toBe(0);
    // Sette giorni dopo (martedì): la cadenza è scaduta da un pezzo.
    expect(await pollPulseOnce(deps({ now: () => plus(7) }))).toBe(1);
  });

  it("misura la cadenza sulla FINESTRA, non al secondo (un tick poco prima dell'orario esatto manda)", async () => {
    await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 1 });
    await seedItem({ projectId });

    // Primo pulse alle 9:50 locali (tardi nella finestra).
    const late = new Date("2026-09-01T07:50:00.000Z");
    expect(await pollPulseOnce(deps({ now: () => late }))).toBe(1);

    // Il giorno dopo alle 9:05: sono passate 23h15', meno di 24h esatte. Senza
    // la tolleranza pari alla finestra il ping slitterebbe di un giorno.
    const nextMorning = new Date("2026-09-02T07:05:00.000Z");
    expect(await pollPulseOnce(deps({ now: () => nextMorning }))).toBe(1);
  });

  it("non manda due pulse nella stessa finestra", async () => {
    await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 1 });
    await seedItem({ projectId });

    expect(await pollPulseOnce(deps({ now: () => new Date("2026-09-01T07:05:00.000Z") }))).toBe(1);
    expect(await pollPulseOnce(deps({ now: () => new Date("2026-09-01T07:50:00.000Z") }))).toBe(0);
  });
});

describe("pollPulseOnce — sostituzione dei ping precedenti", () => {
  it("chiude le copie del pulse precedente e ne accoda l'aggiornamento su Slack", async () => {
    const adminId = await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 1 });
    await seedItem({ projectId, title: "Prima proposta" });

    expect(await pollPulseOnce(deps())).toBe(1);
    const [first] = await pulseRows(projectId);
    expect(first!.status).toBe("open");

    const tomorrow = new Date(TUE_0930_ROME.getTime() + DAY_MS);
    expect(await pollPulseOnce(deps({ now: () => tomorrow }))).toBe(1);

    const rows = await pulseRows(projectId);
    expect(rows).toHaveLength(2);
    const previous = rows.find((r) => r.id === first!.id)!;
    expect(previous.status).toBe("handled");
    const current = rows.find((r) => r.id !== first!.id)!;
    expect(current.status).toBe("open");
    expect(current.userId).toBe(adminId);

    // La chiusura è di SISTEMA: nessun attore l'ha decisa.
    const [closed] = await db
      .select({
        handledByUserId: notifications.handledByUserId,
        handledAt: notifications.handledAt,
      })
      .from(notifications)
      .where(eq(notifications.id, first!.id));
    expect(closed!.handledByUserId).toBeNull();
    expect(closed!.handledAt).not.toBeNull();

    // Il DM già inviato va riscritto: una consegna `slack_update` con la nota.
    const updates = await db
      .select({ event: notificationDeliveries.event })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.channel, "slack_update"),
          eq(notificationDeliveries.notificationId, first!.id),
        ),
      );
    expect(updates).toHaveLength(1);
    expect(String((updates[0]!.event as { note: string }).note)).toContain("Sostituita");
  });

  it("non tocca i pulse di ALTRI progetti", async () => {
    await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 1 });
    const otherId = await seedProject({ pulseEveryDays: 1 });
    await seedItem({ projectId });
    await seedItem({ projectId: otherId });

    expect(await pollPulseOnce(deps())).toBe(2);
    const tomorrow = new Date(TUE_0930_ROME.getTime() + DAY_MS);
    // Il secondo progetto non ha più candidati: solo il primo rimanda.
    await db.delete(backlogItems).where(eq(backlogItems.projectId, otherId));
    expect(await pollPulseOnce(deps({ now: () => tomorrow }))).toBe(1);

    const otherRows = await pulseRows(otherId);
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]!.status).toBe("open");
  });

  it("un pulse chiuso SENZA esito non impedisce il successivo (recovery del 'Procedi' a vuoto)", async () => {
    const adminId = await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 1 });
    await seedItem({ projectId });

    await pollPulseOnce(deps());
    // Simula il claim del "Procedi" andato a vuoto: la copia è chiusa, ma non
    // è successo nulla (nessun ticket, nessun run).
    await db
      .update(notifications)
      .set({ status: "handled", handledAt: new Date(), handledByUserId: adminId })
      .where(eq(notifications.kind, "project.pulse"));

    const tomorrow = new Date(TUE_0930_ROME.getTime() + DAY_MS);
    expect(await pollPulseOnce(deps({ now: () => tomorrow }))).toBe(1);
    expect((await pulseRows(projectId)).filter((r) => r.status === "open")).toHaveLength(1);
  });
});

describe("pollPulseOnce — idempotenza e isolamento", () => {
  it("due tick concorrenti pubblicano UN solo pulse (UPDATE guardato)", async () => {
    await seedAdmin();
    const projectId = await seedProject();
    await seedItem({ projectId });

    const [a, b] = await Promise.all([pollPulseOnce(deps()), pollPulseOnce(deps())]);
    expect([a, b].sort()).toEqual([0, 1]);
    expect(await pulseRows(projectId)).toHaveLength(1);
  });

  it("un tick che perde la corsa DOPO la lettura non pubblica nulla (re-check sotto lock)", async () => {
    await seedAdmin();
    const projectId = await seedProject({ pulseEveryDays: 3 });
    await seedItem({ projectId });

    // Scrittore concorrente: consuma la cadenza del progetto ma tiene la
    // transazione APERTA. Il poller legge quindi un progetto ancora "dovuto"
    // (l'UPDATE non è committato) e arriva alla sua scrittura convinto di poter
    // mandare: è l'unico modo per mettere alla prova il re-check del WHERE dopo
    // il lock di riga, che il test con Promise.all non raggiunge.
    let release!: () => void;
    const holdOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({ pulseLastSentAt: TUE_0930_ROME })
        .where(eq(projects.id, projectId));
      await holdOpen;
    });

    try {
      await delay(150);
      const running = pollPulseOnce(deps());
      // Finché il writer non committa, la scrittura resta bloccata sul lock.
      const pending = Symbol("pending");
      expect(await Promise.race([running, delay(250).then(() => pending)])).toBe(pending);

      release();
      await writer;

      await expect(running).resolves.toBe(0);
    } finally {
      release();
      await writer.catch(() => undefined);
    }

    expect(await pulseRows(projectId)).toHaveLength(0);
  });

  it("un progetto che esplode non ferma gli altri, e non consuma la sua cadenza", async () => {
    await seedAdmin();
    const boom = await seedProject({ name: "esplode" });
    const fine = await seedProject({ name: "sano" });
    await seedItem({ projectId: boom });
    await seedItem({ projectId: fine });

    const errors: string[] = [];
    const published = await pollPulseOnce(
      deps({
        logger: { info: () => {}, error: (msg) => errors.push(msg) },
        publish: async (_db, event, opts) => {
          if (opts.projectId === boom) throw new Error("publish rotta");
          const real = (await import("@stubwise/notifications")).publishNotification;
          return await real(_db, event, opts);
        },
      }),
    );

    expect(published).toBe(1);
    expect(errors.some((msg) => msg.includes(boom))).toBe(true);
    expect(await pulseRows(boom)).toHaveLength(0);
    expect(await pulseRows(fine)).toHaveLength(1);
    // La transazione è rotolata indietro: la cadenza del progetto rotto è intatta.
    const [row] = await db
      .select({ pulseLastSentAt: projects.pulseLastSentAt })
      .from(projects)
      .where(eq(projects.id, boom));
    expect(row!.pulseLastSentAt).toBeNull();
  });

  it("senza destinatari non lascia notifiche ma consuma comunque la cadenza", async () => {
    // Nessun admin, nessun follower: il pulse non raggiunge nessuno.
    const projectId = await seedProject();
    await seedItem({ projectId });
    expect(await pollPulseOnce(deps())).toBe(0);
    const [row] = await db
      .select({ pulseLastSentAt: projects.pulseLastSentAt })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(row!.pulseLastSentAt).not.toBeNull();
  });
});

describe("costo delle query dei segnali", () => {
  it("EXPLAIN ANALYZE di isProjectIdle su un progetto carico", async () => {
    const projectId = await seedProject();
    const ticketIds: string[] = [];
    for (let i = 0; i < 200; i++) ticketIds.push(await seedTicket(projectId, i + 1));
    // 1000 job chiusi su 200 ticket, più rumore su un secondo progetto.
    for (let i = 0; i < 1000; i++) {
      await seedJob(ticketIds[i % ticketIds.length]!, "pr_merged");
    }
    const noiseProject = await seedProject();
    const noiseTicket = await seedTicket(noiseProject);
    for (let i = 0; i < 1000; i++) await seedJob(noiseTicket, "pr_merged");

    // Voci di backlog e job del backlog: il rumore che serve agli ultimi due
    // segnali (`backlog_jobs` non ha un indice su project_id/status).
    for (let i = 0; i < 300; i++) await seedItem({ projectId, title: `voce ${i}` });
    for (let i = 0; i < 500; i++) {
      await db.insert(backlogJobs).values({
        projectId: i % 2 === 0 ? projectId : noiseProject,
        kind: "intake",
        status: "done",
        payload: { ticketId: randomUUID() },
      });
    }

    // La query è la STESSA di `isProjectIdle`: cinque exists più il max.
    const plan = await db.execute(sql`
      explain (analyze, buffers, format text)
      select
        exists (
          select 1 from ai_jobs j join tickets t on t.id = j.ticket_id
          where t.project_id = ${projectId}
            and j.status in ('queued','triaging','fixing','awaiting_plan_approval','awaiting_input')
        ) as jobs_in_flight,
        exists (
          select 1 from agent_questions q join tickets t on t.id = q.ticket_id
          where t.project_id = ${projectId} and q.answered_at is null
        ) as open_question,
        exists (
          select 1 from ticket_repositories tr join tickets t on t.id = tr.ticket_id
          where t.project_id = ${projectId} and tr.pr_state = 'open'
        ) as open_pr,
        exists (
          select 1 from backlog_jobs bj
          where bj.project_id = ${projectId} and bj.status in ('queued','running')
        ) as active_backlog_job,
        exists (
          select 1 from backlog_code_sessions cs join backlog_items bi on bi.id = cs.item_id
          where bi.project_id = ${projectId} and cs.status = 'active'
        ) as active_code_session,
        (select max(j.last_activity_at) from ai_jobs j join tickets t on t.id = j.ticket_id
          where t.project_id = ${projectId}) as last_activity
    `);
    const text = (plan as unknown as { "QUERY PLAN": string }[])
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    // Il test non è un'asserzione di performance: stampa il piano perché la
    // misura resti riproducibile (vedi il docblock di `signals.ts`).
    console.log(text);
    expect(text).toContain("Execution Time");
  });
});
