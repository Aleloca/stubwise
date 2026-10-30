import { describe, expect, it } from "vitest";
import type { ConversationEvent, TaskRun, TaskWork } from "../../data/types";
import { correctionsFromRecords, countedRound } from "../releases/prState";
import {
  correctionHeld,
  correctionsOf,
  latestCorrection,
  openCard,
  prCycles,
  pullRequestsOf,
  statusOf,
  workStory,
} from "./taskWork";

type Draft = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? Omit<E, "id">
    : never
  : never;

let n = 0;
const ev = (e: Draft): ConversationEvent => ({ ...e, id: `e${(n += 1)}` }) as ConversationEvent;

const run = (id: string, over: Partial<TaskRun>, events: ConversationEvent[]): TaskRun => ({
  id,
  ownerId: "p-marco",
  createdAt: events[0]?.at ?? "2026-10-20T09:00:00Z",
  state: "finished",
  outcome: "ok",
  events,
  provider: null,
  failureSummary: null,
  model: null,
  waiting: null,
  queued: null,
  executionModel: null,
  ...over,
});

const work = (runs: TaskRun[], over: Partial<TaskWork> = {}): TaskWork => ({
  runs,
  pullRequests: [],
  software: true,
  openPr: false,
  planDecisions: [],
  waitsOnViewer: false,
  hiddenRuns: false,
  actions: {
    start: "unavailable",
    relaunch: "unavailable",
    resume: "unavailable",
    requestChanges: "unavailable",
  },
  prFacts: [],
  correctionCap: 3,
  usage: [],
  blocked: null,
  ...over,
});

const prEvent = (n: number, at: string, text = `Pull request #${n} opened`) =>
  ev({ at, type: "work_result", kind: "pr_opened", text });

describe("workStory", () => {
  it("racconta in ordine solo ciò che il flusso e la piattaforma dimostrano", () => {
    const first = run("r1", { state: "finished", outcome: "stopped" }, [
      ev({ at: "2026-10-10T10:00:00Z", type: "phase", phase: "execution", outcome: null }),
      ev({ at: "2026-10-10T10:02:00Z", type: "assistant", text: "Reading", done: true }),
      ev({
        at: "2026-10-10T10:12:00Z",
        type: "phase",
        phase: "execution",
        outcome: "stopped",
        stoppedById: "p-marco",
      }),
    ]);
    const second = run("r2", { ownerId: "p-laura" }, [
      ev({ at: "2026-10-19T09:00:00Z", type: "phase", phase: "plan", outcome: null }),
      ev({
        at: "2026-10-19T09:05:00Z",
        type: "question",
        questionId: "q1",
        text: "CSV or XLSX?",
        options: [{ label: "CSV" }, { label: "XLSX" }],
        answer: { optionIndex: 0, text: null, byId: "p-laura", at: "2026-10-19T09:30:00Z" },
      }),
      ev({
        at: "2026-10-19T09:40:00Z",
        type: "plan",
        planText: "p",
        summary: "s",
        status: "approved",
        decidedById: "p-laura",
      }),
      ev({
        at: "2026-10-19T11:00:00Z",
        type: "work_result",
        kind: "pr_opened",
        text: "Pull request #405 opened",
        link: "https://git.example.com/acme/web/pull/405",
      }),
      ev({ at: "2026-10-19T12:00:00Z", type: "work_result", kind: "review", text: "Review: changes requested" }),
      ev({ at: "2026-10-20T09:00:00Z", type: "phase", phase: "correction", outcome: null }),
      ev({ at: "2026-10-20T09:30:00Z", type: "work_result", kind: "correction", text: "Correction 1 pushed to #405" }),
    ]);
    const story = workStory(
      work([first, second], {
        pullRequests: [
          { id: "pr1", projectId: "x", taskId: "t", kind: "pr_opened", at: "2026-10-19T11:00:00Z", number: 405, repo: "acme/web" },
          { id: "pr2", projectId: "x", taskId: "t", kind: "pr_merged", at: "2026-10-22T08:00:00Z", number: 405, repo: "acme/web" },
        ],
      }),
    );
    expect(story.map((s) => s.kind)).toEqual([
      "run_started",
      "ended",
      "run_started",
      "question",
      "answer",
      "plan",
      "result",
      "result",
      "correction_started",
      "result",
      "pr",
    ]);
    expect(story[0]).toMatchObject({ byId: "p-marco" });
    expect(story[1]).toMatchObject({ outcome: "stopped", byId: "p-marco" });
    expect(story[2]).toMatchObject({ byId: "p-laura" });
    expect(story[4]).toMatchObject({ label: "CSV", byId: "p-laura", at: "2026-10-19T09:30:00Z" });
    // Nessuna riga nel registro: la decisione sta nella voce del piano, senza un'ora sua.
    expect(story[5]).toMatchObject({ status: "approved", decidedById: "p-laura", folded: true });
    expect(story[8]).toMatchObject({ ordinal: 1 });
    // L'apertura #405 della piattaforma è già nel flusso: c'è solo il merge.
    expect(story[10]).toMatchObject({ event: "pr_merged", number: 405 });
  });

  it("una sessione nata da «Request changes» è la correzione chiesta da chi l'ha chiesta", () => {
    const story = workStory(
      work([
        run("r1", {}, [ev({ at: "2026-10-19T09:00:00Z", type: "phase", phase: "execution", outcome: "ok" })]),
        run("r2", { ownerId: "p-laura", state: "working", outcome: null }, [
          ev({ at: "2026-10-21T09:00:00Z", type: "phase", phase: "correction", outcome: null }),
        ]),
      ]),
    );
    expect(story.at(-1)).toMatchObject({ kind: "correction_requested", byId: "p-laura", ordinal: 1 });
  });

  it("una correzione ripresa dopo la pausa resta la stessa", () => {
    const events = [
      ev({ at: "2026-10-21T09:00:00Z", type: "phase", phase: "correction", outcome: null }),
      ev({ at: "2026-10-21T09:10:00Z", type: "phase", phase: "correction", outcome: "stopped", stoppedById: "p-laura" }),
      ev({ at: "2026-10-21T10:00:00Z", type: "phase", phase: "correction", outcome: null }),
    ];
    const story = workStory(work([run("r1", { state: "working", outcome: null }, events)]));
    expect(story.filter((s) => s.kind.startsWith("correction"))).toMatchObject([
      { kind: "correction_requested", ordinal: 1 },
      { kind: "correction_resumed", ordinal: 1 },
    ]);
  });

  it("la decisione sul piano ha la data del registro, a parte dal piano scritto", () => {
    const plan = ev({
      at: "2026-10-19T09:40:00Z",
      type: "plan",
      planText: "p",
      summary: "s",
      status: "approved",
      decidedById: "p-laura",
    });
    const story = workStory(
      work([run("r", {}, [plan])], {
        planDecisions: [
          { decidedById: "p-laura", decidedAt: "2026-10-19T14:05:00Z", decision: "Approved", status: "approved" },
        ],
      }),
    );
    expect(story.slice(1)).toMatchObject([
      { kind: "plan", at: "2026-10-19T09:40:00Z", folded: false },
      { kind: "plan_decision", at: "2026-10-19T14:05:00Z", status: "approved", byId: "p-laura" },
    ]);
  });

  it("le correzioni si numerano per PR: una PR nuova riparte da 1", () => {
    const story = workStory(
      work(
        [
          run("r1", {}, [
            ev({ at: "2026-10-10T09:00:00Z", type: "phase", phase: "execution", outcome: "ok" }),
            prEvent(401, "2026-10-10T10:00:00Z"),
            ev({ at: "2026-10-11T09:00:00Z", type: "phase", phase: "correction", outcome: null }),
            ev({ at: "2026-10-11T10:00:00Z", type: "phase", phase: "correction", outcome: "ok" }),
          ]),
          // La #401 è chiusa; il rilancio apre la #402.
          run("r2", { createdAt: "2026-10-15T09:00:00Z" }, [
            ev({ at: "2026-10-15T09:00:00Z", type: "phase", phase: "execution", outcome: null }),
            prEvent(402, "2026-10-15T11:00:00Z"),
          ]),
          run("r3", { ownerId: "p-laura", createdAt: "2026-10-16T09:00:00Z", state: "working", outcome: null }, [
            ev({ at: "2026-10-16T09:00:00Z", type: "phase", phase: "correction", outcome: null }),
          ]),
        ],
        {
          pullRequests: [
            { id: "c", projectId: "x", taskId: "t", kind: "pr_closed", at: "2026-10-12T08:00:00Z", number: 401, repo: "acme/web" },
          ],
        },
      ),
    );
    expect(story.filter((s) => s.kind.startsWith("correction"))).toMatchObject([
      { kind: "correction_started", ordinal: 1 },
      { kind: "correction_requested", byId: "p-laura", ordinal: 1 },
    ]);
  });

  it("una correzione fermata in una sessione chiusa è annullata e non prende numero", () => {
    const story = workStory(
      work([
        run("r1", {}, [prEvent(401, "2026-10-10T10:00:00Z")]),
        run("r2", { createdAt: "2026-10-11T09:00:00Z", outcome: "stopped" }, [
          ev({ at: "2026-10-11T09:00:00Z", type: "phase", phase: "correction", outcome: null }),
          ev({ at: "2026-10-11T09:05:00Z", type: "phase", phase: "correction", outcome: "stopped" }),
        ]),
        run("r3", { createdAt: "2026-10-12T09:00:00Z", state: "working", outcome: null }, [
          ev({ at: "2026-10-12T09:00:00Z", type: "phase", phase: "correction", outcome: null }),
        ]),
      ]),
    );
    expect(story.filter((s) => s.kind === "correction_requested")).toMatchObject([
      { ordinal: null },
      { ordinal: 1 },
    ]);
  });
});

describe("stato, scheda aperta, PR", () => {
  it("una domanda senza risposta è la scheda aperta e lo stato dice da quando", () => {
    const q = ev({
      at: "2026-10-24T10:00:00Z",
      type: "question",
      questionId: "q",
      text: "?",
      options: [{ label: "A" }],
      answer: null,
    });
    const r = run("r", { state: "awaiting_answer", outcome: null }, [q]);
    expect(openCard(r.events)).toBe(q);
    expect(statusOf(r)).toEqual({ kind: "awaiting_answer", at: "2026-10-24T10:00:00Z" });
  });

  it("al lavoro: l'azione in corso", () => {
    const r = run("r", { state: "working", outcome: null }, [
      ev({ at: "2026-10-24T10:00:00Z", type: "action", tool: "repo.edit", label: "Edits src/a.ts", state: "running" }),
    ]);
    expect(statusOf(r)).toMatchObject({ kind: "working", action: "Edits src/a.ts" });
  });

  it("ferma nella correzione: si riprende", () => {
    const r = run("r", { state: "paused", outcome: null }, [
      ev({ at: "2026-10-24T10:00:00Z", type: "phase", phase: "correction", outcome: "stopped", stoppedById: "p-laura" }),
    ]);
    expect(correctionHeld(r)).toBe(true);
    expect(statusOf(r)).toMatchObject({ kind: "paused", phase: "correction", byId: "p-laura" });
    expect(latestCorrection(work([r]))).toMatchObject({ ordinal: 1, state: "paused" });
  });

  it("una riga per PR, con lo stato della piattaforma e il repository dal link", () => {
    const r = run("r", {}, [
      ev({
        at: "2026-10-19T11:00:00Z",
        type: "work_result",
        kind: "pr_opened",
        text: "Pull request #405 opened",
        link: "https://git.example.com/acme/web/pull/405",
      }),
    ]);
    const lines = pullRequestsOf(
      work([r], {
        pullRequests: [
          { id: "a", projectId: "x", taskId: "t", kind: "pr_merged", at: "2026-10-22T08:00:00Z", number: 405, repo: "acme/web" },
        ],
      }),
    );
    expect(lines).toEqual([
      {
        key: "acme/web#405",
        number: 405,
        repo: "acme/web",
        link: "https://git.example.com/acme/web/pull/405",
        text: "Pull request #405 opened",
        state: "merged",
        closedAt: "2026-10-22T08:00:00Z",
        openedAt: "2026-10-19T11:00:00Z",
      },
    ]);
  });

  it("una chiusura più vecchia di una riapertura dal flusso non chiude la PR", () => {
    const r = run("r", {}, [
      ev({
        at: "2026-10-22T11:00:00Z",
        type: "work_result",
        kind: "pr_opened",
        text: "Pull request #405 opened",
        link: "https://git.example.com/acme/web/pull/405",
      }),
    ]);
    const lines = pullRequestsOf(
      work([r], {
        pullRequests: [
          { id: "a", projectId: "x", taskId: "t", kind: "pr_closed", at: "2026-10-22T08:00:00Z", number: 405, repo: "acme/web" },
        ],
      }),
    );
    expect(lines).toMatchObject([{ key: "acme/web#405", state: "open", closedAt: null }]);
  });

  it("una PR che conosce solo la piattaforma prende il repository dalla piattaforma", () => {
    const lines = pullRequestsOf(
      work([run("r", {}, [])], {
        pullRequests: [
          { id: "a", projectId: "x", taskId: "t", kind: "pr_opened", at: "2026-10-22T08:00:00Z", number: 58, repo: "acme/guide" },
        ],
      }),
    );
    expect(lines).toMatchObject([{ number: 58, repo: "acme/guide", state: "open" }]);
  });

  it("la storia dice con quale account o chiave è partita ogni sessione", () => {
    const story = workStory(
      work([
        run("r1", { provider: { kind: "api_key", name: "Billing key" } }, [
          ev({ at: "2026-10-20T09:00:00Z", type: "phase", phase: "plan", outcome: null }),
        ]),
        run("r2", {}, [ev({ at: "2026-10-21T09:00:00Z", type: "phase", phase: "plan", outcome: null })]),
      ]),
    );
    expect(story.filter((e) => e.kind === "run_started")).toMatchObject([
      { provider: { kind: "api_key", name: "Billing key" } },
      { provider: null },
    ]);
  });
});

describe("prCycles: il ciclo di una PR si DERIVA dalle sessioni", () => {
  const REPO = "acme/web";
  const PR = { repo: REPO, number: 7 };
  const opened = { id: "o", projectId: "x", taskId: "t", kind: "pr_opened" as const, at: "2026-10-18T10:00:00Z", number: 7, repo: REPO };
  /** Una sessione di correzione sulla PR #7: apre, poi (se dato) invia e chiude con `outcome`. */
  const correctionRun = (
    id: string,
    day: number,
    end: "running" | "pushed" | "failed" | "stopped",
  ): TaskRun => {
    const at = (h: string) => `2026-10-${day}T${h}:00Z`;
    const events = [ev({ at: at("09:00"), type: "phase", phase: "correction", outcome: null, pr: PR })];
    if (end === "pushed") {
      events.push(ev({ at: at("09:30"), type: "work_result", kind: "correction", text: "Correction pushed to #7" }));
      events.push(ev({ at: at("09:31"), type: "phase", phase: "correction", outcome: "ok" }));
    } else if (end !== "running") {
      events.push(ev({ at: at("09:30"), type: "phase", phase: "correction", outcome: end }));
    }
    return run(id, { state: end === "running" ? "working" : end === "stopped" ? "paused" : "finished", outcome: end === "failed" ? "failed" : end === "pushed" ? "ok" : null }, events);
  };
  const cycleOf = (runs: TaskRun[], over: Partial<TaskWork> = {}) => {
    const w = work(runs, { pullRequests: [opened], ...over });
    return prCycles(w, pullRequestsOf(w)).get("acme/web#7")!;
  };
  const review = (verdict: "pending" | "approved" | "changes_requested", at: string, byId: string | null = null) => ({
    repo: REPO,
    number: 7,
    review: { verdict, at, byId, on: byId ? ("stubwise" as const) : null },
    branchProtected: false,
    queued: false,
  });

  it("nessuna review né correzione: idle; review in corso: reviewing; approvata: approved", () => {
    expect(cycleOf([])).toMatchObject({ state: "idle", round: 0 });
    expect(cycleOf([], { prFacts: [review("pending", "2026-10-19T08:00:00Z")] }).state).toBe("reviewing");
    expect(cycleOf([], { prFacts: [review("approved", "2026-10-19T08:00:00Z")] }).state).toBe("approved");
  });

  it("il giro sale con le correzioni sulla PR; in corso, inviata (aspetta la review), fallita, in pausa", () => {
    expect(cycleOf([correctionRun("a", 19, "running")])).toMatchObject({ state: "correcting", round: 1 });
    expect(cycleOf([correctionRun("a", 19, "pushed")])).toMatchObject({ state: "reviewing", round: 1 });
    expect(cycleOf([correctionRun("a", 19, "pushed"), correctionRun("b", 20, "running")])).toMatchObject({
      state: "correcting",
      round: 2,
    });
    expect(cycleOf([correctionRun("a", 19, "failed")]).state).toBe("correction_failed");
    expect(cycleOf([correctionRun("a", 19, "stopped")]).state).toBe("paused");
  });

  it("una review vecchia non conta dopo una correzione; al tetto le modifiche chieste fermano il ciclo", () => {
    const before = review("changes_requested", "2026-10-18T12:00:00Z");
    expect(cycleOf([correctionRun("a", 19, "pushed")], { prFacts: [before] }).state).toBe("reviewing");
    const after = review("changes_requested", "2026-10-19T12:00:00Z", "p-laura");
    expect(cycleOf([correctionRun("a", 19, "pushed")], { prFacts: [after] })).toMatchObject({
      state: "changes_requested",
      requestedById: "p-laura",
    });
    expect(cycleOf([correctionRun("a", 19, "pushed")], { prFacts: [after], correctionCap: 1 })).toMatchObject({
      state: "capped",
      round: 1,
      maxRounds: 1,
    });
  });

  it("R-K2/R-K8: una correzione fallita non conta nel giro, come nel motore delle PR dei Rilasci", () => {
    const after = review("changes_requested", "2026-10-21T12:00:00Z", "p-laura");
    const runs = [correctionRun("a", 19, "failed"), correctionRun("b", 20, "pushed")];
    const w = work(runs, { pullRequests: [opened], prFacts: [after], correctionCap: 2 });
    const cycle = prCycles(w, pullRequestsOf(w)).get("acme/web#7")!;
    expect(cycle).toMatchObject({ state: "changes_requested", round: 1 });
    const corrections = correctionsFromRecords(correctionsOf(w), "acme/web#7");
    expect(countedRound(corrections)).toBe(cycle.round);
  });

  it("in coda e branch protetto vengono dai fatti esterni", () => {
    expect(cycleOf([], { prFacts: [{ ...review("pending", "2026-10-19T08:00:00Z"), queued: true }] }).state).toBe("queued");
    expect(cycleOf([], { prFacts: [{ ...review("pending", "2026-10-19T08:00:00Z"), branchProtected: true }] }).branchProtected).toBe(true);
  });

  it("le PR sono per repository: una correzione su un'altra PR con lo stesso numero non conta", () => {
    const other = ev({ at: "2026-10-19T09:00:00Z", type: "phase", phase: "correction", outcome: null, pr: { repo: "acme/guide", number: 7 } });
    expect(cycleOf([run("x", { state: "working", outcome: null }, [other])])).toMatchObject({ state: "idle", round: 0 });
  });
});
