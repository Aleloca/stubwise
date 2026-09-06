import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import {
  buildPlanSummaryPrompt,
  generatePlanSummary,
  PLAN_SUMMARY_INPUT_MAX_CHARS,
} from "./plan-summary.js";

/**
 * Riassunto "in breve" del piano (fase 5). È un run best-effort di solo testo:
 * quello che conta è che il prompt parli la lingua d'istanza (mai una cablata) e
 * che ogni fallimento degradi a `null` senza propagare, perché il chiamante
 * (pipeline/fix.ts) deve parcheggiare il piano comunque.
 */

const PLAN = "1. Cambia l'operatore in app.js\n2. Aggiungi un test";

describe("buildPlanSummaryPrompt", () => {
  it("include titolo del ticket e testo del piano", () => {
    const prompt = buildPlanSummaryPrompt("it", { ticketTitle: "Somma sbagliata", planText: PLAN });

    expect(prompt).toContain("Somma sbagliata");
    expect(prompt).toContain("1. Cambia l'operatore in app.js");
  });

  it("in inglese NON contiene istruzioni cablate in italiano", () => {
    const prompt = buildPlanSummaryPrompt("en", { ticketTitle: "Wrong sum", planText: PLAN });

    // Il bug che questa fase corregge: il report giornaliero ha "Scrivi in
    // ITALIANO" cablato nel prompt. Qui la lingua viene dal catalogo.
    expect(prompt).not.toMatch(/ITALIANO/i);
    expect(prompt).toMatch(/English/i);
  });

  it("in italiano contiene le istruzioni italiane", () => {
    const prompt = buildPlanSummaryPrompt("it", { ticketTitle: "Somma sbagliata", planText: PLAN });

    expect(prompt).toMatch(/ITALIANO/i);
  });

  it("un piano oltre il tetto entra troncato e marcato", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `riga ${i} del piano`).join("\n");
    expect(huge.length).toBeGreaterThan(PLAN_SUMMARY_INPUT_MAX_CHARS);

    const prompt = buildPlanSummaryPrompt("it", { ticketTitle: "T", planText: huge });

    expect(prompt.length).toBeLessThan(huge.length);
    expect(prompt).toContain("riga 0 del piano");
    expect(prompt).toMatch(/troncat/i);
  });
});

describe("generatePlanSummary", () => {
  it("run riuscito → il testo trimmato", async () => {
    const runner = new FakeAgentRunner({ output: "  Il piano corregge la somma.  " });

    const summary = await generatePlanSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", planText: PLAN },
    );

    expect(summary).toBe("Il piano corregge la somma.");
  });

  it("passa modello, provider e permissionMode 'plan' al runner", async () => {
    const runner = new FakeAgentRunner({ output: "ok" });

    await generatePlanSummary(
      { runner, timeoutMs: 1000, model: "haiku" },
      { lang: "it", ticketTitle: "Somma", planText: PLAN },
    );

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.model).toBe("haiku");
    expect(runner.calls[0]!.permissionMode).toBe("plan");
  });

  it("run crashato (exit ≠ 0) → null, nessuna eccezione", async () => {
    const runner = new FakeAgentRunner({ output: "output parziale", exitCode: 1 });

    const summary = await generatePlanSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", planText: PLAN },
    );

    expect(summary).toBeNull();
  });

  it("runner che LANCIA (timeout, limite) → null: il parcheggio del piano non deve saltare", async () => {
    const runner = new FakeAgentRunner({
      script: () => {
        throw new Error("agente in timeout");
      },
    });

    const summary = await generatePlanSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", planText: PLAN },
    );

    expect(summary).toBeNull();
  });

  it("riassunti disabilitati → null e NESSUN run", async () => {
    const runner = new FakeAgentRunner({ output: "non dovrebbe girare" });

    const summary = await generatePlanSummary(
      { runner, timeoutMs: 1000, enabled: false },
      { lang: "it", ticketTitle: "Somma", planText: PLAN },
    );

    expect(summary).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("piano vuoto → null e NESSUN run (non c'è niente da riassumere)", async () => {
    const runner = new FakeAgentRunner({ output: "non dovrebbe girare" });

    const summary = await generatePlanSummary(
      { runner, timeoutMs: 1000 },
      { lang: "it", ticketTitle: "Somma", planText: "   " },
    );

    expect(summary).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });
});
