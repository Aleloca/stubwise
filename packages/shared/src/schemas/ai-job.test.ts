import { describe, expect, it } from "vitest";
import { aiJobSchema } from "./ai-job.js";

/**
 * `aiJobSchema` alimenta le risposte lette anche dall'app mobile (fase 4):
 * ogni campo nuovo nasce `.optional()`/`.nullable()`, mai obbligatorio, con
 * un test che parsa una risposta SENZA quel campo — vedi "Invarianti e
 * trappole" in CLAUDE.md. `planSummary` (fase 5) e `failureSummary` (fase 7)
 * sono entrambi in questa categoria.
 */

const BASE = {
  id: "11111111-1111-4111-8111-111111111111",
  ticketId: "22222222-2222-4222-8222-222222222222",
  status: "failed" as const,
  log: "",
  prUrl: null,
  error: "boom",
  createdAt: "2026-09-01T10:00:00.000Z",
  startedAt: null,
  finishedAt: "2026-09-01T10:05:00.000Z",
  providerLabel: null,
  providerKind: null,
  requestedByUserId: null,
};

describe("aiJobSchema", () => {
  it("parsa una risposta SENZA planSummary né failureSummary (client vecchio)", () => {
    const parsed = aiJobSchema.parse(BASE);

    expect(parsed.planSummary).toBeUndefined();
    expect(parsed.failureSummary).toBeUndefined();
  });

  it("parsa failureSummary valorizzato", () => {
    const parsed = aiJobSchema.parse({
      ...BASE,
      failureSummary: "L'agente non è riuscito a completare il fix.",
    });

    expect(parsed.failureSummary).toBe("L'agente non è riuscito a completare il fix.");
  });

  it("parsa failureSummary null (job fallito senza riassunto generato)", () => {
    const parsed = aiJobSchema.parse({ ...BASE, failureSummary: null });

    expect(parsed.failureSummary).toBeNull();
  });
});
