import type { ProjectPulseSummary } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { pulseLineFor } from "./pulse-line";

/**
 * Stesso test di `apps/mobile/src/lib/pulse-line.test.ts`, adattato: qui
 * `summary` non passa da `Reader<>` (server e web si deployano insieme,
 * niente client non aggiornabile da tollerare) e non c'è il caso "kind
 * ignoto" — per lo stesso motivo.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "22222222-2222-4222-8222-222222222222";

function summary(overrides: Partial<ProjectPulseSummary> = {}): ProjectPulseSummary {
  return {
    projectId: PROJECT_ID,
    projectName: "Portale B2B",
    waitingForYou: [],
    waitingForOthers: [],
    running: [],
    failedCount: 0,
    backlogReadyCount: 0,
    idleDays: 0,
    lastReportDate: null,
    ...overrides,
  };
}

const QUESTION = {
  kind: "question" as const,
  ticketId: TICKET_ID,
  ticketNumber: 245,
  title: "Cache immagini",
  notificationId: "44444444-4444-4444-8444-444444444444",
};

const PLAN = {
  kind: "plan_approval" as const,
  ticketId: TICKET_ID,
  ticketNumber: 246,
  title: "Piano cache immagini",
  notificationId: "55555555-5555-4555-8555-555555555555",
};

const RUNNING = {
  ticketId: TICKET_ID,
  ticketNumber: 247,
  title: "Export CSV degli ordini",
  sinceMinutes: 18,
};

describe("pulseLineFor — priorità", () => {
  it("aspetta te vince quando SIA waitingForYou SIA running sono popolati", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION], running: [RUNNING] }));
    expect(line.tone).toBe("signal");
    expect(line.key).toBe("projects:pulse.waitingQuestion");
  });

  it("sta lavorando vince quando running è popolato e waitingForYou è vuoto, anche con idleDays alto", () => {
    const line = pulseLineFor(summary({ running: [RUNNING], idleDays: 6 }));
    expect(line.tone).toBe("sky");
    expect(line.key).toBe("projects:pulse.runningOne");
  });

  it("fermo vince su tranquillo quando idleDays >= 2 e nessuna attività", () => {
    const line = pulseLineFor(summary({ idleDays: 2 }));
    expect(line.tone).toBe("faint");
    expect(line.key).toBe("projects:pulse.idle");
    expect(line.params).toEqual({ count: 2 });
  });

  it("idleDays === 1 NON è 'fermo': resta tranquillo (confine esplicito)", () => {
    const line = pulseLineFor(summary({ idleDays: 1 }));
    expect(line.tone).toBe("ok");
    expect(line.key).toBe("projects:pulse.ok");
  });

  it("tutto vuoto e idleDays a 0 → tranquillo", () => {
    const line = pulseLineFor(summary());
    expect(line.tone).toBe("ok");
    expect(line.key).toBe("projects:pulse.ok");
    expect(line.params).toEqual({});
  });
});

describe("pulseLineFor — testo di 'aspetta te'", () => {
  it("una sola domanda dell'agente", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION] }));
    expect(line).toEqual({ tone: "signal", key: "projects:pulse.waitingQuestion", params: { count: 1 } });
  });

  it("un solo piano da approvare", () => {
    const line = pulseLineFor(summary({ waitingForYou: [PLAN] }));
    expect(line).toEqual({ tone: "signal", key: "projects:pulse.waitingPlan", params: { count: 1 } });
  });

  it("più domande dello stesso tipo: stessa chiave, count aggiornato", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION, { ...QUESTION, ticketId: "x" }] }));
    expect(line).toEqual({ tone: "signal", key: "projects:pulse.waitingQuestion", params: { count: 2 } });
  });

  it("kind misti (una domanda + un piano): chiave generica 'decisioni'", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION, PLAN] }));
    expect(line).toEqual({ tone: "signal", key: "projects:pulse.waitingMixed", params: { count: 2 } });
  });
});

describe("pulseLineFor — testo di 'sta lavorando'", () => {
  it("un solo lavoro: il titolo entra nei params", () => {
    const line = pulseLineFor(summary({ running: [RUNNING] }));
    expect(line).toEqual({
      tone: "sky",
      key: "projects:pulse.runningOne",
      params: { title: "Export CSV degli ordini" },
    });
  });

  it("più lavori: chiave generica col conteggio, niente titolo singolo", () => {
    const line = pulseLineFor(summary({ running: [RUNNING, { ...RUNNING, ticketId: "x" }] }));
    expect(line).toEqual({ tone: "sky", key: "projects:pulse.runningMany", params: { count: 2 } });
  });
});

describe("pulseLineFor — 'fermo da N giorni'", () => {
  it("il conteggio dei giorni è nei params", () => {
    const line = pulseLineFor(summary({ idleDays: 6 }));
    expect(line).toEqual({ tone: "faint", key: "projects:pulse.idle", params: { count: 6 } });
  });
});
