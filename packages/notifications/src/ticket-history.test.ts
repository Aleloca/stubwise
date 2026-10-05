import { describe, expect, it } from "vitest";
import {
  buildTicketHistory,
  type HistoryCorrectionRow,
  type HistoryJobRow,
  type HistoryReviewRow,
  type TicketHistoryRows,
} from "./ticket-history.js";

/**
 * Il modulo puro della storia del ticket. La fixture principale è il ticket #1
 * di Stubwise Test, ricostruito dal DB nel design
 * (`docs/plans/2026-10-05-ticket-history-and-replies-design.md` §1): una PR,
 * quattro review approvate, tre correzioni chieste da tre origini diverse.
 *
 * ⚠️ Le date della fixture sono tutte DISTINTE e scritte a mano (nessun
 * `now()`): l'ordine che i test asseriscono viene dalle date, non dallo
 * spareggio per id. Lo spareggio ha un test suo.
 */

const REPO = "repo-1";
const PR_URL = "https://bitbucket.org/acme/r/pull-requests/4";
/** Un istante del 2 ott 2026, ora:minuti:secondi UTC. */
const t = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 9, 2, h, m, s));
const iso = (d: Date) => d.toISOString();

function job(over: Partial<HistoryJobRow> & Pick<HistoryJobRow, "id">): HistoryJobRow {
  return {
    status: "pr_opened",
    correctionId: null,
    prUrl: null,
    createdAt: t(8, 0),
    startedAt: null,
    finishedAt: null,
    requesterName: null,
    ...over,
  };
}

function review(over: Partial<HistoryReviewRow> & Pick<HistoryReviewRow, "id">): HistoryReviewRow {
  return {
    repositoryId: REPO,
    prNumber: 4,
    prUrl: PR_URL,
    verdict: "approve",
    status: "completed",
    createdAt: t(8, 0),
    startedAt: t(8, 0),
    finishedAt: null,
    ...over,
  };
}

function correction(
  over: Partial<HistoryCorrectionRow> & Pick<HistoryCorrectionRow, "id" | "trigger" | "createdAt">,
): HistoryCorrectionRow {
  return {
    repositoryId: REPO,
    prNumber: 4,
    status: "done",
    updatedAt: over.createdAt,
    userEmail: null,
    providerLogin: null,
    ...over,
  };
}

function emptyRows(): TicketHistoryRows {
  return {
    jobs: [],
    questions: [],
    decisions: [],
    reviews: [],
    corrections: [],
    statusEvents: [],
    prUrls: [{ repositoryId: REPO, prNumber: 4, prUrl: PR_URL }],
  };
}

/** Il ticket #1 del design, riga per riga. */
function ticketOne(): TicketHistoryRows {
  return {
    ...emptyRows(),
    jobs: [
      job({
        id: "fix",
        status: "pr_opened",
        prUrl: PR_URL,
        createdAt: t(8, 58),
        startedAt: t(9, 0),
        finishedAt: t(9, 6),
        requesterName: "ale@stubwise.test",
      }),
      job({ id: "cj1", correctionId: "c1", createdAt: t(9, 10), finishedAt: t(9, 13) }),
      job({ id: "cj2", correctionId: "c2", createdAt: t(9, 25), finishedAt: t(9, 29) }),
      job({ id: "cj3", correctionId: "c3", createdAt: t(11, 45), finishedAt: t(11, 48) }),
    ],
    reviews: [
      review({ id: "r1", finishedAt: t(9, 9) }),
      review({ id: "r2", finishedAt: t(9, 16) }),
      review({ id: "r3", finishedAt: t(9, 34) }),
      review({ id: "r4", finishedAt: t(11, 51) }),
    ],
    corrections: [
      correction({
        id: "c1",
        trigger: "stubwise",
        createdAt: t(9, 10, 30),
        userEmail: "ale@stubwise.test",
      }),
      correction({ id: "c2", trigger: "provider", createdAt: t(9, 25, 30), providerLogin: "mario" }),
      correction({
        id: "c3",
        trigger: "stubwise",
        createdAt: t(11, 45, 30),
        userEmail: "app@stubwise.test",
      }),
    ],
    statusEvents: [
      { id: "s1", from: "triaged", to: "in_progress", actorName: null, createdAt: t(9, 0, 30) },
      { id: "s2", from: "in_progress", to: "in_review", actorName: null, createdAt: t(9, 6, 30) },
    ],
  };
}

const ai = { type: "ai", name: null };

describe("buildTicketHistory — il ticket #1", () => {
  it("ordine e contenuto esatti, dal più recente", () => {
    const { events, total } = buildTicketHistory(ticketOne(), { limit: 200 });
    expect(total).toBe(14);
    expect(events).toEqual([
      { id: "review_completed:r4", kind: "review_completed", at: iso(t(11, 51)), actor: ai, prNumber: 4, prUrl: PR_URL, round: null, detail: "approve", fromStatus: null },
      { id: "correction_pushed:cj3", kind: "correction_pushed", at: iso(t(11, 48)), actor: ai, prNumber: 4, prUrl: PR_URL, round: 3, detail: null, fromStatus: null },
      { id: "changes_requested:c3", kind: "changes_requested", at: iso(t(11, 45, 30)), actor: { type: "user", name: "app@stubwise.test" }, prNumber: 4, prUrl: PR_URL, round: 3, detail: null, fromStatus: null },
      { id: "review_completed:r3", kind: "review_completed", at: iso(t(9, 34)), actor: ai, prNumber: 4, prUrl: PR_URL, round: null, detail: "approve", fromStatus: null },
      { id: "correction_pushed:cj2", kind: "correction_pushed", at: iso(t(9, 29)), actor: ai, prNumber: 4, prUrl: PR_URL, round: 2, detail: null, fromStatus: null },
      { id: "changes_requested:c2", kind: "changes_requested", at: iso(t(9, 25, 30)), actor: { type: "provider", name: "mario" }, prNumber: 4, prUrl: PR_URL, round: 2, detail: null, fromStatus: null },
      { id: "review_completed:r2", kind: "review_completed", at: iso(t(9, 16)), actor: ai, prNumber: 4, prUrl: PR_URL, round: null, detail: "approve", fromStatus: null },
      { id: "correction_pushed:cj1", kind: "correction_pushed", at: iso(t(9, 13)), actor: ai, prNumber: 4, prUrl: PR_URL, round: 1, detail: null, fromStatus: null },
      { id: "changes_requested:c1", kind: "changes_requested", at: iso(t(9, 10, 30)), actor: { type: "user", name: "ale@stubwise.test" }, prNumber: 4, prUrl: PR_URL, round: 1, detail: null, fromStatus: null },
      { id: "review_completed:r1", kind: "review_completed", at: iso(t(9, 9)), actor: ai, prNumber: 4, prUrl: PR_URL, round: null, detail: "approve", fromStatus: null },
      { id: "status_changed:s2", kind: "status_changed", at: iso(t(9, 6, 30)), actor: null, prNumber: null, prUrl: null, round: null, detail: "in_review", fromStatus: "in_progress" },
      { id: "pr_opened:fix", kind: "pr_opened", at: iso(t(9, 6)), actor: ai, prNumber: 4, prUrl: PR_URL, round: null, detail: null, fromStatus: null },
      { id: "status_changed:s1", kind: "status_changed", at: iso(t(9, 0, 30)), actor: null, prNumber: null, prUrl: null, round: null, detail: "in_progress", fromStatus: "triaged" },
      { id: "run_started:fix", kind: "run_started", at: iso(t(9, 0)), actor: { type: "user", name: "ale@stubwise.test" }, prNumber: null, prUrl: null, round: null, detail: null, fromStatus: null },
    ]);
  });
});

describe("buildTicketHistory — round", () => {
  it("una correzione cancelled fra due altre non sposta la numerazione, e non ha round", () => {
    const rows = emptyRows();
    rows.corrections = [
      correction({ id: "a", trigger: "review", createdAt: t(10, 0) }),
      correction({ id: "b", trigger: "stubwise", status: "cancelled", createdAt: t(10, 1) }),
      correction({ id: "c", trigger: "review", createdAt: t(10, 2) }),
    ];
    const { events } = buildTicketHistory(rows, { limit: 200 });
    const byId = new Map(events.map((e) => [e.id, e]));
    expect(byId.get("changes_requested:a")?.round).toBe(1);
    expect(byId.get("changes_requested:b")).toMatchObject({ round: null, detail: "cancelled" });
    expect(byId.get("changes_requested:c")?.round).toBe(2);
  });

  it("si numera PER PR: due PR dello stesso ticket ripartono da 1", () => {
    const rows = emptyRows();
    rows.prUrls.push({ repositoryId: "repo-2", prNumber: 9, prUrl: "https://x.test/pull/9" });
    rows.corrections = [
      correction({ id: "a", trigger: "review", createdAt: t(10, 0) }),
      correction({ id: "b", trigger: "review", createdAt: t(10, 1), repositoryId: "repo-2", prNumber: 9 }),
      correction({ id: "c", trigger: "review", createdAt: t(10, 2) }),
    ];
    const byId = new Map(buildTicketHistory(rows, { limit: 200 }).events.map((e) => [e.id, e]));
    expect(byId.get("changes_requested:a")?.round).toBe(1);
    expect(byId.get("changes_requested:b")).toMatchObject({ round: 1, prNumber: 9, prUrl: "https://x.test/pull/9" });
    expect(byId.get("changes_requested:c")?.round).toBe(2);
  });

  it("una pending compare come richiesta (alla sua ora di richiesta), il suo job no", () => {
    const rows = emptyRows();
    rows.corrections = [
      correction({ id: "p", trigger: "stubwise", status: "pending", createdAt: t(10, 0), updatedAt: t(10, 5), userEmail: "a@x.test" }),
    ];
    const { events } = buildTicketHistory(rows, { limit: 200 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "changes_requested:p", at: iso(t(10, 5)), round: 1 });
  });
});

describe("buildTicketHistory — attori", () => {
  it("provider → login, review → ai, utente cancellato → name null", () => {
    const rows = emptyRows();
    rows.corrections = [
      correction({ id: "p", trigger: "provider", createdAt: t(10, 0), providerLogin: "mario" }),
      correction({ id: "r", trigger: "review", createdAt: t(10, 1) }),
      correction({ id: "u", trigger: "stubwise", createdAt: t(10, 2) }),
    ];
    const byId = new Map(buildTicketHistory(rows, { limit: 200 }).events.map((e) => [e.id, e]));
    expect(byId.get("changes_requested:p")?.actor).toEqual({ type: "provider", name: "mario" });
    expect(byId.get("changes_requested:r")?.actor).toEqual({ type: "ai", name: null });
    expect(byId.get("changes_requested:u")?.actor).toEqual({ type: "user", name: null });
  });
});

describe("buildTicketHistory — review", () => {
  it("una review in attesa (startedAt null) e una failed restano fuori", () => {
    const rows = emptyRows();
    rows.reviews = [
      review({ id: "waiting", startedAt: null, finishedAt: t(10, 0) }),
      review({ id: "failed", status: "failed", verdict: null, finishedAt: t(10, 1) }),
      review({ id: "ok", finishedAt: t(10, 2), verdict: "request_changes" }),
    ];
    const { events } = buildTicketHistory(rows, { limit: 200 });
    expect(events.map((e) => e.id)).toEqual(["review_completed:ok"]);
    expect(events[0]?.detail).toBe("request_changes");
  });
});

describe("buildTicketHistory — piano", () => {
  it("mode fix → plan_rejected; digest → plan_approved pre_approved; execute → plan_approved", () => {
    const rows = emptyRows();
    rows.decisions = [
      { id: "d1", sourceRef: { jobId: "j", mode: "fix" }, decidedAt: t(10, 0), decidedByName: "boss@x.test" },
      { id: "d2", sourceRef: { ticketId: "t", digest: "abc" }, decidedAt: t(10, 1), decidedByName: "boss@x.test" },
      { id: "d3", sourceRef: { jobId: "j", mode: "execute" }, decidedAt: t(10, 2), decidedByName: null },
      { id: "d4", sourceRef: null, decidedAt: t(10, 3), decidedByName: null },
    ];
    const { events } = buildTicketHistory(rows, { limit: 200 });
    expect(events.map((e) => [e.id, e.kind, e.detail])).toEqual([
      ["plan_approved:d3", "plan_approved", null],
      ["plan_approved:d2", "plan_approved", "pre_approved"],
      ["plan_rejected:d1", "plan_rejected", null],
    ]);
    expect(events[1]?.actor).toEqual({ type: "user", name: "boss@x.test" });
    expect(events[0]?.actor).toBeNull();
  });

  it("nessuna decisione → nessuna riga di piano", () => {
    const { events } = buildTicketHistory(emptyRows(), { limit: 200 });
    expect(events).toEqual([]);
  });
});

describe("buildTicketHistory — domande", () => {
  it("domanda fatta dall'AI, risposta da una persona", () => {
    const rows = emptyRows();
    rows.questions = [
      { id: "q", askedAt: t(10, 0), answeredAt: t(10, 4), answeredByName: "ale@x.test" },
      { id: "open", askedAt: t(10, 5), answeredAt: null, answeredByName: null },
    ];
    const { events } = buildTicketHistory(rows, { limit: 200 });
    expect(events.map((e) => [e.id, e.actor])).toEqual([
      ["question_asked:open", ai],
      ["question_answered:q", { type: "user", name: "ale@x.test" }],
      ["question_asked:q", ai],
    ]);
  });
});

describe("buildTicketHistory — cambi di stato (D3)", () => {
  it("verso done o closed è una CHIUSURA (ticket_closed), senza stato di partenza", () => {
    const rows = emptyRows();
    rows.statusEvents = [
      { id: "m", from: "in_review", to: "done", actorName: null, createdAt: t(10, 0) },
      { id: "x", from: "triaged", to: "closed", actorName: "boss@x.test", createdAt: t(10, 1) },
    ];
    const { events } = buildTicketHistory(rows, { limit: 200 });
    expect(events).toEqual([
      { id: "ticket_closed:x", kind: "ticket_closed", at: iso(t(10, 1)), actor: { type: "user", name: "boss@x.test" }, prNumber: null, prUrl: null, round: null, detail: "closed", fromStatus: null },
      { id: "ticket_closed:m", kind: "ticket_closed", at: iso(t(10, 0)), actor: null, prNumber: null, prUrl: null, round: null, detail: "done", fromStatus: null },
    ]);
  });

  it("in_review → triaged senza attore resta un cambio di stato, NON «PR chiusa senza merge»", () => {
    // Lo stesso evento lo scrive anche il triage che parcheggia un rilancio su
    // un ticket in revisione (`triage.ts`): il dato non dice che la PR è stata
    // chiusa, quindi la storia non lo afferma.
    const rows = emptyRows();
    rows.statusEvents = [
      { id: "s", from: "in_review", to: "triaged", actorName: null, createdAt: t(10, 0) },
    ];
    const { events } = buildTicketHistory(rows, { limit: 200 });
    expect(events).toEqual([
      { id: "status_changed:s", kind: "status_changed", at: iso(t(10, 0)), actor: null, prNumber: null, prUrl: null, round: null, detail: "triaged", fromStatus: "in_review" },
    ]);
  });

  it("un evento senza stato di arrivo (payload malformato) resta fuori", () => {
    const rows = emptyRows();
    rows.statusEvents = [{ id: "s", from: null, to: null, actorName: null, createdAt: t(10, 0) }];
    expect(buildTicketHistory(rows, { limit: 200 }).events).toEqual([]);
  });
});

describe("buildTicketHistory — job", () => {
  it("una correzione fallita è correction_failed; una skipped non è un evento; un fix senza PR non ha pr_opened", () => {
    const rows = emptyRows();
    rows.corrections = [
      correction({ id: "c1", trigger: "review", createdAt: t(10, 0) }),
      correction({ id: "c2", trigger: "review", createdAt: t(10, 2) }),
    ];
    rows.jobs = [
      job({ id: "f", correctionId: "c1", status: "failed", createdAt: t(10, 0), finishedAt: t(10, 1) }),
      job({ id: "s", correctionId: "c2", status: "skipped", createdAt: t(10, 2), finishedAt: t(10, 3) }),
      job({ id: "fix", status: "failed", createdAt: t(9, 0), startedAt: t(9, 1), finishedAt: t(9, 2) }),
    ];
    const ids = buildTicketHistory(rows, { limit: 200 }).events.map((e) => e.id);
    expect(ids).toEqual([
      "changes_requested:c2",
      "correction_failed:f",
      "changes_requested:c1",
      "run_started:fix",
    ]);
  });

  it("un fix in coda mai partito usa la data di creazione", () => {
    const rows = emptyRows();
    rows.jobs = [job({ id: "q", status: "queued", createdAt: t(10, 0) })];
    expect(buildTicketHistory(rows, { limit: 200 }).events).toMatchObject([
      { id: "run_started:q", at: iso(t(10, 0)) },
    ]);
  });
});

describe("buildTicketHistory — tetto e ordine", () => {
  it("205 eventi → 200 in events (i più recenti), total 205", () => {
    const rows = emptyRows();
    rows.statusEvents = Array.from({ length: 205 }, (_, i) => ({
      id: `s${String(i).padStart(3, "0")}`,
      from: "a",
      to: "b",
      actorName: null,
      createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, i)),
    }));
    const { events, total } = buildTicketHistory(rows, { limit: 200 });
    expect(total).toBe(205);
    expect(events).toHaveLength(200);
    expect(events[0]?.id).toBe("status_changed:s204");
    expect(events[199]?.id).toBe("status_changed:s005");
  });

  it("due eventi alla stessa data → ordine stabile per id, qualunque sia l'ordine d'ingresso", () => {
    const same = t(10, 0);
    const a = { id: "aaa", from: "x", to: "y", actorName: null, createdAt: same };
    const b = { id: "bbb", from: "x", to: "y", actorName: null, createdAt: same };
    const one = emptyRows();
    one.statusEvents = [a, b];
    const two = emptyRows();
    two.statusEvents = [b, a];
    const ids1 = buildTicketHistory(one, { limit: 200 }).events.map((e) => e.id);
    const ids2 = buildTicketHistory(two, { limit: 200 }).events.map((e) => e.id);
    expect(ids1).toEqual(["status_changed:aaa", "status_changed:bbb"]);
    expect(ids2).toEqual(ids1);
  });
});
