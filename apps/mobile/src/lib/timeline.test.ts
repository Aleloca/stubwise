import { UNKNOWN } from "@stubwise/shared";
import type {
  AiJob,
  AiJobStatus,
  PrReviewSummary,
  Reader,
  TicketActivityEntry,
  TicketQuestion,
} from "@stubwise/shared";
import { buildTimeline, resolveWorkState } from "./timeline";

const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TICKET_ID = "44444444-4444-4444-8444-444444444444";
const TICKET = { id: TICKET_ID, createdAt: "2026-08-12T09:00:00.000Z" };
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

function statusEvent(to: string, at: string, id = "55555555-5555-4555-8555-555555555555"): Reader<TicketActivityEntry> {
  return {
    kind: "event",
    id,
    eventKind: "status_changed",
    payload: { from: "triaged", to },
    createdAt: at,
  } as Reader<TicketActivityEntry>;
}

function review(overrides: Partial<Reader<PrReviewSummary>> = {}): Reader<PrReviewSummary> {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    repositoryId: "77777777-7777-4777-8777-777777777777",
    repositoryName: "shop",
    ticketId: TICKET_ID,
    prNumber: 12,
    prUrl: "https://example.com/pr/12",
    prTitle: "Export CSV",
    status: "completed",
    verdict: "approve",
    prSummary: null,
    createdAt: "2026-08-12T15:00:00.000Z",
    finishedAt: "2026-08-12T15:10:00.000Z",
    ...overrides,
  } as Reader<PrReviewSummary>;
}

/**
 * Le DATE REALI dei due passi che non ne avevano nessuna (fase 5). Nessun campo
 * di `AiJob` dice quando il gate del piano è stato sbloccato o quando la PR è
 * nata: lo dicono gli eventi `status_changed` del feed del ticket.
 */
describe("buildTimeline — date dagli eventi del ticket", () => {
  const JOBS = [job({ status: "pr_opened", startedAt: "2026-08-12T10:00:00.000Z" })];

  test("'piano approvato' prende la data del passaggio a in_progress", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: JOBS,
      questions: [],
      activity: [statusEvent("in_progress", "2026-08-12T12:00:00.000Z")],
    });
    expect(steps.find((s) => s.id === "planApproved")!.at).toBe("2026-08-12T12:00:00.000Z");
  });

  test("'PR e review' prende la data del passaggio a in_review", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: JOBS,
      questions: [],
      activity: [
        statusEvent("in_progress", "2026-08-12T12:00:00.000Z", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        statusEvent("in_review", "2026-08-12T14:30:00.000Z", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      ],
    });
    expect(steps.find((s) => s.id === "prReview")!.at).toBe("2026-08-12T14:30:00.000Z");
  });

  test("più passaggi allo stesso stato (rilancio): vince il PIÙ RECENTE, non il primo", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: JOBS,
      questions: [],
      // Il feed arriva ordinato per createdAt CRESCENTE (contratto della rotta).
      activity: [
        statusEvent("in_progress", "2026-08-10T09:00:00.000Z", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        statusEvent("in_progress", "2026-08-12T12:00:00.000Z", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      ],
    });
    expect(steps.find((s) => s.id === "planApproved")!.at).toBe("2026-08-12T12:00:00.000Z");
  });

  test("eventi di altro tipo o verso altri stati non datano nulla", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: JOBS,
      questions: [],
      activity: [
        { kind: "comment", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", createdAt: "2026-08-12T11:00:00.000Z" } as Reader<TicketActivityEntry>,
        {
          kind: "event",
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          eventKind: "priority_changed",
          payload: null,
          createdAt: "2026-08-12T11:30:00.000Z",
        } as Reader<TicketActivityEntry>,
        statusEvent("done", "2026-08-12T16:00:00.000Z", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
      ],
    });
    expect(steps.find((s) => s.id === "planApproved")!.at).toBeNull();
    expect(steps.find((s) => s.id === "prReview")!.at).toBeNull();
  });

  test("senza feed (query assente o fallita) i due passi restano senza data, come prima", () => {
    const steps = buildTimeline({ ticket: TICKET, jobs: JOBS, questions: [] });
    expect(steps.find((s) => s.id === "planApproved")!.at).toBeNull();
    expect(steps.find((s) => s.id === "prReview")!.at).toBeNull();
  });
});

describe("buildTimeline — verdetto della review", () => {
  test("il verdetto della review di QUESTO ticket sta sul passo 'PR e review'", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "pr_opened" })],
      questions: [],
      reviews: [review({ verdict: "request_changes" })],
    });
    expect(steps.find((s) => s.id === "prReview")!.verdict).toBe("request_changes");
    // Su nessun altro passo: è un fatto della PR, non del lavoro in generale.
    expect(steps.filter((s) => s.id !== "prReview").every((s) => s.verdict === null)).toBe(true);
  });

  test("le review di ALTRI ticket del progetto sono ignorate", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "pr_opened" })],
      questions: [],
      reviews: [review({ ticketId: OTHER_TICKET_ID, verdict: "approve" })],
    });
    expect(steps.find((s) => s.id === "prReview")!.verdict).toBeNull();
  });

  test("review ancora in corso (verdetto null) o nessuna review: nessun verdetto mostrato", () => {
    const running = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "pr_opened" })],
      questions: [],
      reviews: [review({ status: "running", verdict: null })],
    });
    expect(running.find((s) => s.id === "prReview")!.verdict).toBeNull();

    const none = buildTimeline({ ticket: TICKET, jobs: [job({ status: "pr_opened" })], questions: [], reviews: [] });
    expect(none.find((s) => s.id === "prReview")!.verdict).toBeNull();
  });

  test("più review sulla stessa PR: vince la più recente COMPLETATA", () => {
    const steps = buildTimeline({
      ticket: TICKET,
      jobs: [job({ status: "pr_opened" })],
      questions: [],
      reviews: [
        review({ id: "88888888-8888-4888-8888-888888888888", verdict: "approve", createdAt: "2026-08-12T15:00:00.000Z" }),
        review({
          id: "99999999-9999-4999-8999-999999999999",
          verdict: "request_changes",
          createdAt: "2026-08-13T09:00:00.000Z",
        }),
      ],
    });
    expect(steps.find((s) => s.id === "prReview")!.verdict).toBe("request_changes");
  });
});
