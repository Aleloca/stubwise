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
  const later = new Date("2026-10-10T10:00:02Z");
  const stop = {
    text: "",
    interrupt: true,
    status: "delivered" as const,
    createdAt: before,
    deliveredAt: d,
  };
  const pausedBase: PausedDerivationInput = {
    live: true,
    interactive: true,
    inputs: [stop],
    lastActivity: { id: 10n, at: before },
    turnEndBeforeLastActivity: null,
    lastSegmentEnd: null,
  };
  const paused = (p: Partial<PausedDerivationInput>) =>
    deriveAgentSessionPaused({ ...pausedBase, ...p });

  it("«Ferma» senza testo consegnato, nessuna attività dopo: in pausa", () => {
    expect(paused({})).toBe(true);
    expect(paused({ lastActivity: null })).toBe(true);
  });

  it("MONOTONA fra la consegna e il turn_end del turno interrotto: nessun true→false→true", () => {
    // 1. Appena consegnato: in pausa.
    expect(paused({})).toBe(true);
    // 2. La CODA del turno interrotto arriva dopo la consegna, prima del suo
    //    turn_end: resta in pausa (prima diventava false per un batch).
    expect(paused({ lastActivity: { id: 11n, at: after } })).toBe(true);
    // 3. Arriva il turn_end del turno interrotto, dopo la coda: in pausa.
    //    (L'ultimo turn_end PRIMA dell'ultima attività è ancora quello vecchio.)
    expect(
      paused({ lastActivity: { id: 11n, at: after }, turnEndBeforeLastActivity: { at: before } }),
    ).toBe(true);
    // 4. Attività di un turno NUOVO (dopo quel turn_end): fine della pausa.
    expect(
      paused({ lastActivity: { id: 13n, at: later }, turnEndBeforeLastActivity: { at: after } }),
    ).toBe(false);
  });

  it("segmento non più interattivo (il result RIUSCITO di un deliverable nell'output ha chiuso gli interventi): non in pausa", () => {
    expect(paused({ interactive: false })).toBe(false);
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
    const next = { ...stop, text: "riprendi da Y", interrupt: false, createdAt: after, deliveredAt: after };
    expect(paused({ inputs: [stop, next] })).toBe(false);
  });

  it("un intervento successivo ancora in attesa di consegna: non in pausa", () => {
    const next = { ...stop, text: "riprendi", interrupt: false, status: "pending" as const, createdAt: after, deliveredAt: null };
    expect(paused({ inputs: [stop, next] })).toBe(false);
  });

  it("un intervento successivo NON consegnato non toglie la pausa (l'agente non l'ha mai letto)", () => {
    const next = { ...stop, text: "x", status: "undelivered" as const, createdAt: after, deliveredAt: null };
    expect(paused({ inputs: [stop, next] })).toBe(true);
  });

  it("lo «Ferma» stesso non ancora consegnato: non in pausa", () => {
    expect(paused({ inputs: [{ ...stop, status: "pending", deliveredAt: null }] })).toBe(false);
  });

  it("un segmento finito dopo la consegna: non in pausa", () => {
    expect(paused({ lastSegmentEnd: { at: after } })).toBe(false);
  });

  it("nessun intervento: non in pausa", () => {
    expect(paused({ inputs: [] })).toBe(false);
  });
});
