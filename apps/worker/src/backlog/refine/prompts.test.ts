import { describe, expect, it } from "vitest";
import { buildRefinePrimingPrompt, buildRefineResumePrompt, type RefinePromptContext } from "./prompts.js";

const ctx = (over: Partial<RefinePromptContext> = {}): RefinePromptContext => ({
  language: "it",
  item: {
    title: "Esportare in CSV", document: "Serve l'export", implementationPlan: null, originContent: null,
    effort: null, risk: null, riskNote: null, urgency: "high",
  },
  repos: [{ name: "api", dir: "/tmp/stubwise-refine/s/api-1" }, { name: "web", dir: "/tmp/stubwise-refine/s/web-2" }],
  graphHint: "",
  decisions: [],
  recentTranscript: [],
  ...over,
});

describe("prompt della sessione di refinement", () => {
  it("contiene voce, repository coi percorsi, mandato e il messaggio in fondo", () => {
    const p = buildRefinePrimingPrompt(ctx(), "partiamo dal formato");
    for (const needle of ["Esportare in CSV", "Serve l'export", "/tmp/stubwise-refine/s/api-1", "web", "set_design", "set_plan", "update_item", "non esiste ask_user"]) {
      expect(p).toContain(needle);
    }
    expect(p.trimEnd().endsWith("partiamo dal formato")).toBe(true);
    expect(p).toContain("Italian");
  });

  it("design e piano attuali e testo originale preservato compaiono quando ci sono", () => {
    const p = buildRefinePrimingPrompt(
      ctx({ item: { ...ctx().item, document: "# Design v1", originContent: "richiesta originale", implementationPlan: "# Piano v1" } }),
      "x",
    );
    expect(p).toContain("# Design v1");
    expect(p).toContain("richiesta originale");
    expect(p).toContain("# Piano v1");
  });

  it("decisioni e ultimi messaggi (ripartenza senza --resume) quando ci sono, assenti altrimenti", () => {
    const empty = buildRefinePrimingPrompt(ctx(), "x");
    expect(empty).not.toContain("DECISIONI");
    expect(empty).not.toContain("CONVERSAZIONE FINORA");
    const full = buildRefinePrimingPrompt(
      ctx({
        decisions: [{ title: "Niente XLSX", decision: "Solo CSV", decidedAt: new Date("2026-10-01T00:00:00Z") }],
        recentTranscript: [{ role: "user", text: "e il separatore?" }, { role: "agent", text: "punto e virgola" }],
      }),
      "x",
    );
    expect(full).toContain("Niente XLSX");
    expect(full).toContain("e il separatore?");
    expect(full).toContain("punto e virgola");
  });

  it("il turno ripreso con --resume riceve SOLO il messaggio", () => {
    expect(buildRefineResumePrompt("e adesso il piano")).toBe("e adesso il piano");
  });
});
