import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import {
  buildPrSummaryPrompt,
  generatePrSummary,
  PR_SUMMARY_INPUT_MAX_CHARS,
} from "./pr-summary.js";

/**
 * Riassunto "in breve" della PR (fase 5): due frasi — cosa fa la PR e cosa dice
 * la review, in parole. Stesso contratto best-effort del riassunto del piano:
 * ogni fallimento è `null` e la review si completa comunque.
 */

const INPUT = {
  prTitle: "fix: somma sbagliata",
  prBody: "Corregge l'operatore in app.js.",
  verdict: "approve" as const,
  analysis: "Il diff è minimale e coperto da un test di regressione.",
};

describe("buildPrSummaryPrompt", () => {
  it("include titolo, descrizione, verdetto e analisi della review", () => {
    const prompt = buildPrSummaryPrompt("it", INPUT);

    expect(prompt).toContain("fix: somma sbagliata");
    expect(prompt).toContain("Corregge l'operatore in app.js.");
    expect(prompt).toContain("approve");
    expect(prompt).toContain("Il diff è minimale e coperto da un test di regressione.");
  });

  it("in inglese NON contiene istruzioni cablate in italiano", () => {
    const prompt = buildPrSummaryPrompt("en", INPUT);

    expect(prompt).not.toMatch(/ITALIANO/i);
    expect(prompt).toMatch(/English/i);
  });

  it("in italiano contiene le istruzioni italiane", () => {
    expect(buildPrSummaryPrompt("it", INPUT)).toMatch(/ITALIANO/i);
  });

  it("descrizione e analisi oltre il tetto entrano troncate e marcate", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `riga ${i}`).join("\n");
    expect(huge.length).toBeGreaterThan(PR_SUMMARY_INPUT_MAX_CHARS);

    const prompt = buildPrSummaryPrompt("it", { ...INPUT, prBody: huge, analysis: huge });

    expect(prompt.length).toBeLessThan(huge.length * 2);
    expect(prompt).toMatch(/troncat/i);
  });
});

describe("generatePrSummary", () => {
  it("run riuscito → il testo trimmato", async () => {
    const runner = new FakeAgentRunner({ output: " La PR corregge la somma. La review approva. " });

    const summary = await generatePrSummary({ runner, timeoutMs: 1000 }, { lang: "it", ...INPUT });

    expect(summary).toBe("La PR corregge la somma. La review approva.");
  });

  it("run crashato → null", async () => {
    const runner = new FakeAgentRunner({ output: "parziale", exitCode: 1 });

    expect(
      await generatePrSummary({ runner, timeoutMs: 1000 }, { lang: "it", ...INPUT }),
    ).toBeNull();
  });

  it("runner che LANCIA → null: la review deve completarsi comunque", async () => {
    const runner = new FakeAgentRunner({
      script: () => {
        throw new Error("agente in timeout");
      },
    });

    expect(
      await generatePrSummary({ runner, timeoutMs: 1000 }, { lang: "it", ...INPUT }),
    ).toBeNull();
  });

  it("riassunti disabilitati → null e NESSUN run", async () => {
    const runner = new FakeAgentRunner({ output: "non dovrebbe girare" });

    expect(
      await generatePrSummary({ runner, timeoutMs: 1000, enabled: false }, { lang: "it", ...INPUT }),
    ).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });
});
