import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import {
  buildFailureSummaryPrompt,
  FAILURE_SUMMARY_INPUT_MAX_CHARS,
  generateFailureSummary,
} from "./failure-summary.js";

/**
 * Riassunto "in breve" di un job FALLITO (fase 7, Task 9). Stessa forma di
 * `plan-summary.test.ts`: prompt che parla la lingua d'istanza (mai cablata)
 * e degrado a `null` senza propagare — qui in più perché il fallimento è già
 * registrato e notificato quando questo modulo gira, e non deve mai tornare
 * indietro a comprometterlo.
 */

const LOG = "[fix] output agente:\nnpm test\nFAIL app.test.js";

describe("buildFailureSummaryPrompt", () => {
  it("include titolo del ticket, errore e log", () => {
    const prompt = buildFailureSummaryPrompt("it", {
      ticketTitle: "Somma sbagliata",
      error: "test rossi dopo i tentativi di riparazione",
      log: LOG,
    });

    expect(prompt).toContain("Somma sbagliata");
    expect(prompt).toContain("test rossi dopo i tentativi di riparazione");
    expect(prompt).toContain("FAIL app.test.js");
  });

  it("in inglese NON contiene istruzioni cablate in italiano", () => {
    const prompt = buildFailureSummaryPrompt("en", {
      ticketTitle: "Wrong sum",
      error: "tests still red",
      log: LOG,
    });

    expect(prompt).not.toMatch(/ITALIANO/i);
    expect(prompt).toMatch(/English/i);
  });

  it("in italiano contiene le istruzioni italiane", () => {
    const prompt = buildFailureSummaryPrompt("it", {
      ticketTitle: "Somma sbagliata",
      error: "test rossi",
      log: LOG,
    });

    expect(prompt).toMatch(/ITALIANO/i);
  });

  it("un log oltre il tetto entra troncato e marcato", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `riga ${i} del log`).join("\n");
    expect(huge.length).toBeGreaterThan(FAILURE_SUMMARY_INPUT_MAX_CHARS);

    const prompt = buildFailureSummaryPrompt("it", { ticketTitle: "T", error: "E", log: huge });

    expect(prompt.length).toBeLessThan(huge.length);
    expect(prompt).toContain("riga 0 del log");
    expect(prompt).toMatch(/troncat/i);
  });
});

describe("generateFailureSummary", () => {
  it("run riuscito → il testo trimmato", async () => {
    const runner = new FakeAgentRunner({ output: "  L'agente non è riuscito a far passare i test.  " });

    const summary = await generateFailureSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", error: "test rossi", log: LOG },
    );

    expect(summary).toBe("L'agente non è riuscito a far passare i test.");
  });

  it("passa modello, provider e permissionMode 'plan' al runner", async () => {
    const runner = new FakeAgentRunner({ output: "ok" });

    await generateFailureSummary(
      { runner, timeoutMs: 1000, model: "haiku" },
      { lang: "it", ticketTitle: "Somma", error: "test rossi", log: LOG },
    );

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.model).toBe("haiku");
    expect(runner.calls[0]!.permissionMode).toBe("plan");
  });

  it("run crashato (exit ≠ 0) → null, nessuna eccezione", async () => {
    const runner = new FakeAgentRunner({ output: "output parziale", exitCode: 1 });

    const summary = await generateFailureSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", error: "test rossi", log: LOG },
    );

    expect(summary).toBeNull();
  });

  it("runner che LANCIA (timeout, limite) → null: il fallimento è già registrato e non deve saltare nulla", async () => {
    const runner = new FakeAgentRunner({
      script: () => {
        throw new Error("agente in timeout");
      },
    });

    const summary = await generateFailureSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", error: "test rossi", log: LOG },
    );

    expect(summary).toBeNull();
  });

  it("riassunti disabilitati → null e NESSUN run", async () => {
    const runner = new FakeAgentRunner({ output: "non dovrebbe girare" });

    const summary = await generateFailureSummary(
      { runner, timeoutMs: 1000, enabled: false },
      { lang: "it", ticketTitle: "Somma", error: "test rossi", log: LOG },
    );

    expect(summary).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  // A differenza di `generatePlanSummary` (che salta il run su un piano
  // vuoto), qui NON c'è un caso "input vuoto → nessun run": un job fallito ha
  // SEMPRE un `error` (lo scrive `failJob`), quindi non esiste il caso limite
  // simmetrico. Un log vuoto è comunque un input legittimo (fallimento prima
  // di produrre output) e il run parte lo stesso.
  it("log vuoto: il run parte comunque (l'errore basta a dare contesto)", async () => {
    const runner = new FakeAgentRunner({ output: "Il job è fallito prima di produrre output." });

    const summary = await generateFailureSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", error: "agente non eseguibile", log: "" },
    );

    expect(summary).toBe("Il job è fallito prima di produrre output.");
    expect(runner.calls).toHaveLength(1);
  });
});
