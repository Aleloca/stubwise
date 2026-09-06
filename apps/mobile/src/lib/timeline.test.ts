import { UNKNOWN } from "@stubwise/shared";
import type { AiJob, AiJobStatus, Reader, TicketQuestion } from "@stubwise/shared";
import { buildTimeline, resolveWorkState } from "./timeline";

const TICKET = { createdAt: "2026-08-12T09:00:00.000Z" };
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";

function job(overrides: Partial<Reader<AiJob>> & { status: AiJobStatus | typeof UNKNOWN }): Reader<AiJob> {
  return {
    id: JOB_ID,
    ticketId: "ticket-1",
    log: "",
    prUrl: null,
    error: null,
    createdAt: "2026-08-12T09:05:00.000Z",
    startedAt: null,
    finishedAt: null,
    providerLabel: null,
    providerKind: null,
    requestedByUserId: null,
    ...overrides,
  } as Reader<AiJob>;
}

function question(overrides: Partial<Reader<TicketQuestion>> = {}): Reader<TicketQuestion> {
  return {
    questionId: "question-1",
    round: 1,
    jobId: JOB_ID,
    question: "Il reso può superare il pagato?",
    options: [],
    allowFreeText: true,
    askedAt: "2026-08-12T11:00:00.000Z",
    answer: null,
    answeredAt: null,
    answeredBy: null,
    ...overrides,
  } as Reader<TicketQuestion>;
}

function statuses(steps: ReturnType<typeof buildTimeline>): string[] {
  return steps.map((step) => step.status);
}

describe("buildTimeline — i due scenari del piano", () => {
  test("awaiting_input: passo 1 done, passo 2 current, resto future", () => {
    const steps = buildTimeline({ ticket: TICKET, jobs: [job({ status: "awaiting_input" })], questions: [] });
    expect(statuses(steps)).toEqual(["done", "current", "future", "future", "future", "future"]);
  });

  test("done (pr_merged) con PR: passi 1-5 done, 6 future — il rilascio non è mai 'done' in v1", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "pr_merged", prUrl: "https://example.com/pr/1", finishedAt: "2026-08-12T14:00:00.000Z" })],
      questions: [],
    });
    expect(statuses(steps)).toEqual(["done", "done", "done", "done", "done", "future"]);
    expect(steps.find((s) => s.id === "release")!.status).toBe("future");
  });
});

describe("buildTimeline — nessun job", () => {
  test("ticket senza job: passo 1 current con la data del ticket, resto future", () => {
    const steps = buildTimeline({ ticket: TICKET, jobs: [], questions: [] });
    expect(statuses(steps)).toEqual(["current", "future", "future", "future", "future", "future"]);
    expect(steps[0]!.at).toBe(TICKET.createdAt);
  });
});

describe("buildTimeline — checkpoint per stato", () => {
  test("queued: passo 1 current", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "queued" })], questions: [] }))).toEqual([
      "current",
      "future",
      "future",
      "future",
      "future",
      "future",
    ]);
  });

  test("triaging: passo 1 current (non ha ancora posto una domanda né generato un piano)", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "triaging" })], questions: [] }))).toEqual([
      "current",
      "future",
      "future",
      "future",
      "future",
      "future",
    ]);
  });

  test("held: passo 1 current — gate di automazione, non un piano da approvare", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "held" })], questions: [] }))).toEqual([
      "current",
      "future",
      "future",
      "future",
      "future",
      "future",
    ]);
  });

  test("awaiting_plan_approval: passi 1-2 done, 3 current", () => {
    expect(
      statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "awaiting_plan_approval" })], questions: [] })),
    ).toEqual(["done", "done", "current", "future", "future", "future"]);
  });

  test("fixing: passi 1-3 done, 4 current, 'at' = startedAt del job", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "fixing", startedAt: "2026-08-12T13:00:00.000Z" })],
      questions: [],
    });
    expect(statuses(steps)).toEqual(["done", "done", "done", "current", "future", "future"]);
    expect(steps.find((s) => s.id === "working")!.at).toBe("2026-08-12T13:00:00.000Z");
  });

  test("pr_opened: passi 1-4 done, 5 current", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "pr_opened" })], questions: [] }))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "current",
      "future",
    ]);
  });

  test("failed: passi 1-4 done (terminale, nessun passo 'current'), 5-6 future", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "failed" })], questions: [] }))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "future",
      "future",
    ]);
  });

  test("skipped: solo il passo 1 done (terminale), mai andato oltre la proposta", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "skipped" })], questions: [] }))).toEqual([
      "done",
      "future",
      "future",
      "future",
      "future",
      "future",
    ]);
  });

  test("pr_closed (rifiutata): passi 1-5 done (terminale), 6 future", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: "pr_closed" })], questions: [] }))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "future",
    ]);
  });
});

describe("buildTimeline — stato ignoto (server più nuovo dell'app)", () => {
  test("con finishedAt: si assume concluso, checkpoint 5 terminale", () => {
    expect(
      statuses(
        buildTimeline({
          ticket: TICKET,
          jobs: [job({ status: UNKNOWN, finishedAt: "2026-08-12T15:00:00.000Z" })],
          questions: [],
        }),
      ),
    ).toEqual(["done", "done", "done", "done", "done", "future"]);
  });

  test("con solo startedAt: si assume ancora in esecuzione, checkpoint 4 current", () => {
    expect(
      statuses(
        buildTimeline({
          ticket: TICKET,
          jobs: [job({ status: UNKNOWN, startedAt: "2026-08-12T13:00:00.000Z" })],
          questions: [],
        }),
      ),
    ).toEqual(["done", "done", "done", "current", "future", "future"]);
  });

  test("senza né startedAt né finishedAt: resta al passo 1 current", () => {
    expect(statuses(buildTimeline({ ticket: TICKET, jobs: [job({ status: UNKNOWN })], questions: [] }))).toEqual([
      "current",
      "future",
      "future",
      "future",
      "future",
      "future",
    ]);
  });
});

describe("buildTimeline — domanda risposta", () => {
  test("la nota del passo 2 usa solo la domanda del job PIÙ RECENTE, anche se risposta", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ id: OTHER_JOB_ID, status: "triaging" }), job({ id: JOB_ID, status: "awaiting_input" })],
      questions: [question({ jobId: JOB_ID, answeredAt: "2026-08-12T11:20:00.000Z" })],
    });
    // jobs[0] è OTHER_JOB_ID (triaging): la domanda risposta appartiene a un
    // job PRECEDENTE, quindi non conta per il checkpoint del job corrente.
    expect(statuses(steps)).toEqual(["current", "future", "future", "future", "future", "future"]);
    expect(steps.find((s) => s.id === "questionAnswered")!.at).toBeNull();
  });

  test("'at' del passo 2 è la data della risposta, quando la domanda appartiene al job più recente", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "fixing", startedAt: "2026-08-12T13:00:00.000Z" })],
      questions: [question({ jobId: JOB_ID, answeredAt: "2026-08-12T11:20:00.000Z" })],
    });
    expect(steps.find((s) => s.id === "questionAnswered")!.at).toBe("2026-08-12T11:20:00.000Z");
  });

  test("domanda ancora aperta (answeredAt null) sullo stesso job: 'at' resta null", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "awaiting_input" })],
      questions: [question({ jobId: JOB_ID, answeredAt: null })],
    });
    expect(steps.find((s) => s.id === "questionAnswered")!.at).toBeNull();
  });
});

describe("resolveWorkState", () => {
  test("nessun job: null", () => {
    expect(resolveWorkState(undefined)).toBeNull();
  });

  test("job noto: lo stato in parole", () => {
    expect(resolveWorkState(job({ status: "fixing" }))).toBe("working");
  });

  test("job con stato ignoto: il segnaposto UNKNOWN, mai il valore grezzo del server", () => {
    expect(resolveWorkState(job({ status: UNKNOWN }))).toBe(UNKNOWN);
  });
});
