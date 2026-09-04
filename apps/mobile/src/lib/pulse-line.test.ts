import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { pulseLineFor } from "./pulse-line";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_ID = "33333333-3333-4333-8333-333333333333";

function summary(overrides: Partial<Reader<ProjectPulseSummary>> = {}): Reader<ProjectPulseSummary> {
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
  test("aspetta te vince quando SIA waitingForYou SIA running sono popolati", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION], running: [RUNNING] }), VIEWER_ID);
    expect(line.tone).toBe("signal");
    expect(line.key).toBe("mobile.projects.pulse.waitingQuestion");
  });

  test("sta lavorando vince quando running è popolato e waitingForYou è vuoto, anche con idleDays alto", () => {
    const line = pulseLineFor(summary({ running: [RUNNING], idleDays: 6 }), VIEWER_ID);
    expect(line.tone).toBe("sky");
    expect(line.key).toBe("mobile.projects.pulse.runningOne");
  });

  test("fermo vince su tranquillo quando idleDays >= 2 e nessuna attività", () => {
    const line = pulseLineFor(summary({ idleDays: 2 }), VIEWER_ID);
    expect(line.tone).toBe("faint");
    expect(line.key).toBe("mobile.projects.pulse.idle");
    expect(line.params).toEqual({ count: 2 });
  });

  test("idleDays === 1 NON è 'fermo': resta tranquillo (confine esplicito)", () => {
    const line = pulseLineFor(summary({ idleDays: 1 }), VIEWER_ID);
    expect(line.tone).toBe("ok");
    expect(line.key).toBe("mobile.projects.pulse.ok");
  });

  test("tutto vuoto e idleDays a 0 → tranquillo", () => {
    const line = pulseLineFor(summary(), VIEWER_ID);
    expect(line.tone).toBe("ok");
    expect(line.key).toBe("mobile.projects.pulse.ok");
    expect(line.params).toEqual({});
  });
});

describe("pulseLineFor — testo di 'aspetta te'", () => {
  test("una sola domanda dell'agente", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION] }), VIEWER_ID);
    expect(line).toEqual({ tone: "signal", key: "mobile.projects.pulse.waitingQuestion", params: { count: 1 } });
  });

  test("un solo piano da approvare", () => {
    const line = pulseLineFor(summary({ waitingForYou: [PLAN] }), VIEWER_ID);
    expect(line).toEqual({ tone: "signal", key: "mobile.projects.pulse.waitingPlan", params: { count: 1 } });
  });

  test("più domande dello stesso tipo: stessa chiave, count aggiornato", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION, { ...QUESTION, ticketId: "x" }] }), VIEWER_ID);
    expect(line).toEqual({ tone: "signal", key: "mobile.projects.pulse.waitingQuestion", params: { count: 2 } });
  });

  test("kind misti (una domanda + un piano): chiave generica 'decisioni'", () => {
    const line = pulseLineFor(summary({ waitingForYou: [QUESTION, PLAN] }), VIEWER_ID);
    expect(line).toEqual({ tone: "signal", key: "mobile.projects.pulse.waitingMixed", params: { count: 2 } });
  });

  test("un kind ignoto dal server (UNKNOWN, app vecchia) NON crolla: chiave generica", () => {
    const unknownItem = { ...QUESTION, kind: "UNKNOWN" as unknown as "question" };
    const line = pulseLineFor(summary({ waitingForYou: [unknownItem] }), VIEWER_ID);
    expect(line.tone).toBe("signal");
    expect(line.key).toBe("mobile.projects.pulse.waitingMixed");
  });
});

describe("pulseLineFor — testo di 'sta lavorando'", () => {
  test("un solo lavoro: il titolo entra nei params", () => {
    const line = pulseLineFor(summary({ running: [RUNNING] }), VIEWER_ID);
    expect(line).toEqual({
      tone: "sky",
      key: "mobile.projects.pulse.runningOne",
      params: { title: "Export CSV degli ordini" },
    });
  });

  test("più lavori: chiave generica col conteggio, niente titolo singolo", () => {
    const line = pulseLineFor(summary({ running: [RUNNING, { ...RUNNING, ticketId: "x" }] }), VIEWER_ID);
    expect(line).toEqual({ tone: "sky", key: "mobile.projects.pulse.runningMany", params: { count: 2 } });
  });
});

describe("pulseLineFor — 'fermo da N giorni'", () => {
  test("il conteggio dei giorni è nei params", () => {
    const line = pulseLineFor(summary({ idleDays: 6 }), VIEWER_ID);
    expect(line).toEqual({ tone: "faint", key: "mobile.projects.pulse.idle", params: { count: 6 } });
  });
});
