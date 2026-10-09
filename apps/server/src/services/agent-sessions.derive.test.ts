import { describe, expect, it } from "vitest";
import {
  deriveAgentSessionOutcome,
  deriveAgentSessionState,
  type SessionDerivationInput,
} from "./agent-sessions.js";

const base: SessionDerivationInput = {
  live: false,
  aiJobStatus: null,
  prReviewStatus: null,
  docGenerationStatus: null,
  backlogJobStatus: null,
  openBacklogQuestion: false,
  lastSegmentEnd: null,
};
const state = (p: Partial<SessionDerivationInput>) => deriveAgentSessionState({ ...base, ...p });
const outcome = (p: Partial<SessionDerivationInput>) => {
  const input = { ...base, ...p };
  return deriveAgentSessionOutcome(deriveAgentSessionState(input), input);
};

describe("deriveAgentSessionState", () => {
  it("un segmento vivo vince su tutto", () => {
    expect(state({ live: true, aiJobStatus: "awaiting_input" })).toBe("working");
  });
  it("domanda, approvazione, parcheggio, pausa Docs", () => {
    expect(state({ aiJobStatus: "awaiting_input" })).toBe("waiting_input");
    expect(state({ openBacklogQuestion: true })).toBe("waiting_input");
    expect(state({ aiJobStatus: "awaiting_plan_approval" })).toBe("awaiting_approval");
    expect(state({ aiJobStatus: "held" })).toBe("held");
    expect(state({ docGenerationStatus: "paused" })).toBe("held");
  });
  it("lavoro in corso fra due segmenti è working, in coda è queued", () => {
    expect(state({ aiJobStatus: "fixing" })).toBe("working");
    expect(state({ prReviewStatus: "running" })).toBe("working");
    expect(state({ backlogJobStatus: "running" })).toBe("working");
    expect(state({ aiJobStatus: "queued" })).toBe("queued");
    expect(state({ docGenerationStatus: "pending" })).toBe("queued");
  });
  it("nient'altro: ended", () => {
    expect(state({})).toBe("ended");
    expect(state({ aiJobStatus: "pr_opened" })).toBe("ended");
  });
});

describe("deriveAgentSessionOutcome", () => {
  it("null finché la sessione non è finita", () => {
    expect(outcome({ aiJobStatus: "fixing" })).toBeNull();
    expect(outcome({ live: true, lastSegmentEnd: { exitCode: 0, timedOut: false } })).toBeNull();
  });
  it("dalla riga proprietaria", () => {
    expect(outcome({ aiJobStatus: "pr_merged" })).toBe("completed");
    expect(outcome({ aiJobStatus: "failed" })).toBe("failed");
    expect(outcome({ aiJobStatus: "skipped" })).toBe("skipped");
    expect(outcome({ prReviewStatus: "failed" })).toBe("failed");
    expect(outcome({ docGenerationStatus: "succeeded" })).toBe("completed");
    expect(outcome({ backlogJobStatus: "done" })).toBe("completed");
  });
  it("senza riga proprietaria: dall'ultimo segment_end", () => {
    expect(outcome({ lastSegmentEnd: { exitCode: 0, timedOut: false } })).toBe("completed");
    expect(outcome({ lastSegmentEnd: { exitCode: 1, timedOut: false } })).toBe("failed");
    expect(outcome({ lastSegmentEnd: { exitCode: null, timedOut: true } })).toBe("failed");
    expect(outcome({})).toBeNull();
  });
});
