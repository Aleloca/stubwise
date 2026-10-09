import { describe, expect, it } from "vitest";
import {
  deriveAgentSessionOutcome,
  deriveAgentSessionPaused,
  deriveAgentSessionState,
  type PausedDerivationInput,
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

describe("deriveAgentSessionPaused", () => {
  const d = new Date("2026-10-10T10:00:00Z");
  const before = new Date("2026-10-10T09:59:59Z");
  const after = new Date("2026-10-10T10:00:01Z");
  const stop = {
    text: "",
    interrupt: true,
    status: "delivered" as const,
    createdAt: before,
    deliveredAt: d,
  };
  const pausedBase: PausedDerivationInput = {
    live: true,
    inputs: [stop],
    lastActivity: { id: 10n, at: before },
    lastTurnEnd: { id: 12n, at: after },
    lastSegmentEnd: null,
  };
  const paused = (p: Partial<PausedDerivationInput>) =>
    deriveAgentSessionPaused({ ...pausedBase, ...p });

  it("«Ferma» senza testo consegnato, nessuna attività dopo il suo turn_end: in pausa", () => {
    expect(paused({})).toBe(true);
  });

  it("nessun turn_end ancora e nessuna attività dopo la consegna: in pausa", () => {
    expect(paused({ lastTurnEnd: null })).toBe(true);
  });

  it("sessione non viva: mai in pausa", () => {
    expect(paused({ live: false })).toBe(false);
  });

  it("l'ultimo consegnato è un messaggio con testo («Ferma e scrivi»): non in pausa", () => {
    expect(paused({ inputs: [{ ...stop, text: "fai X" }] })).toBe(false);
  });

  it("l'ultimo consegnato non è un'interruzione: non in pausa", () => {
    expect(paused({ inputs: [{ ...stop, text: "x", interrupt: false }] })).toBe(false);
  });

  it("un intervento successivo, consegnato: non in pausa", () => {
    const later = { ...stop, text: "riprendi da Y", interrupt: false, createdAt: after, deliveredAt: after };
    expect(paused({ inputs: [stop, later] })).toBe(false);
  });

  it("un intervento successivo ancora in attesa di consegna: non in pausa", () => {
    const later = { ...stop, text: "riprendi", interrupt: false, status: "pending" as const, createdAt: after, deliveredAt: null };
    expect(paused({ inputs: [stop, later] })).toBe(false);
  });

  it("un intervento successivo NON consegnato non toglie la pausa (l'agente non l'ha mai letto)", () => {
    const later = { ...stop, text: "x", status: "undelivered" as const, createdAt: after, deliveredAt: null };
    expect(paused({ inputs: [stop, later] })).toBe(true);
  });

  it("lo «Ferma» stesso non ancora consegnato: non in pausa", () => {
    expect(paused({ inputs: [{ ...stop, status: "pending", deliveredAt: null }] })).toBe(false);
  });

  it("attività dell'agente DOPO il turn_end dell'interruzione: non in pausa", () => {
    expect(paused({ lastActivity: { id: 13n, at: after } })).toBe(false);
  });

  it("coda del turno interrotto registrata dopo la consegna ma prima del suo turn_end: in pausa", () => {
    expect(paused({ lastActivity: { id: 11n, at: after } })).toBe(true);
  });

  it("attività dopo la consegna e nessun turn_end successivo: non (ancora) in pausa", () => {
    expect(
      paused({ lastActivity: { id: 11n, at: after }, lastTurnEnd: { id: 5n, at: before } }),
    ).toBe(false);
  });

  it("un segmento finito dopo la consegna: non in pausa", () => {
    expect(paused({ lastSegmentEnd: { at: after } })).toBe(false);
  });

  it("nessun intervento: non in pausa", () => {
    expect(paused({ inputs: [] })).toBe(false);
  });
});
