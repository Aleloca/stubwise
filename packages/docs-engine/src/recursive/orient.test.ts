import { describe, expect, it } from "vitest";
import {
  ORIENT_END_MARKER,
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  ORIENT_START_MARKER,
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_TECHNICAL_START_MARKER,
} from "./contract.js";
import { buildOrientPrompt, parseOrientPlan } from "./orient.js";

/** A well-formed orientation plan as a well-behaved agent would emit it. */
function plan(opts: { technical?: string[]; functional?: string[]; notes?: string } = {}) {
  const technical = opts.technical ?? [
    "- Worker :: apps/worker :: durable job loop and orchestration",
    "- Server :: apps/server :: HTTP API",
  ];
  const functional = opts.functional ?? [
    "- Documentation generation :: apps/worker/src/docs, packages/docs-engine :: builds docs",
    "- Search :: apps/server/src/routes/search.ts :: lets users search docs",
  ];
  return [
    "Preamble the parser must ignore.",
    ORIENT_START_MARKER,
    opts.notes ?? "This is a pnpm monorepo (apps/ + packages/). plans/ and docs/ are noise.",
    ORIENT_TECHNICAL_START_MARKER,
    ...technical,
    ORIENT_TECHNICAL_END_MARKER,
    ORIENT_FUNCTIONAL_START_MARKER,
    ...functional,
    ORIENT_FUNCTIONAL_END_MARKER,
    ORIENT_END_MARKER,
    "Closing remark the parser must ignore.",
  ].join("\n");
}

describe("buildOrientPrompt", () => {
  it("includes the survey and instructs stack detection, classification and the two child-lists", () => {
    const prompt = buildOrientPrompt("apps/\npackages/\nplans/\npackage.json");
    expect(prompt).toContain("apps/");
    expect(prompt).toContain("packages/");
    const lower = prompt.toLowerCase();
    // stack/framework detection
    expect(lower).toMatch(/stack|framework/);
    // architecture vs noise classification, with explanation, naming the noise folders
    expect(lower).toContain("architecture");
    expect(lower).toMatch(/noise/);
    expect(lower).toMatch(/explain/);
    expect(lower).toMatch(/plans/);
    // developer-written docs (README/ADR/docs) are now a SOURCE, no longer excluded as noise
    expect(lower).toMatch(/readme|adr|source/);
    // both lists requested
    expect(prompt).toContain(ORIENT_TECHNICAL_START_MARKER);
    expect(prompt).toContain(ORIENT_FUNCTIONAL_START_MARKER);
    // child-list format documented
    expect(prompt).toContain(" :: ");
    // no free prose outside markers + anti-meta
    expect(lower).toMatch(/no free prose outside the markers|nothing outside/);
    expect(lower).toMatch(/read-only/);
  });

  it("without briefContext the prompt has no PROJECT CONTEXT block (regression)", () => {
    const prompt = buildOrientPrompt("apps/\npackage.json");
    expect(prompt).not.toContain("PROJECT CONTEXT");
  });

  it("with briefContext injects the brief block into the prompt", () => {
    const briefContext =
      "PROJECT CONTEXT — use this glossary and terminology consistently:\n\nGlossary (use these exact terms):\n- Wallet: prepaid balance";
    const prompt = buildOrientPrompt("apps/\npackage.json", briefContext);
    expect(prompt).toContain("PROJECT CONTEXT");
    expect(prompt).toContain("Wallet: prepaid balance");
    // The survey still follows the brief block.
    expect(prompt).toContain("REPOSITORY SURVEY:");
  });
});

describe("parseOrientPlan", () => {
  it("extracts both lists with their fields, plus the classification notes", () => {
    const parsed = parseOrientPlan(plan());
    expect(parsed).not.toBeNull();
    expect(parsed!.technical.map((c) => c.title)).toEqual(["Worker", "Server"]);
    expect(parsed!.technical[0]).toEqual({
      title: "Worker",
      unitRef: "apps/worker",
      sourcePaths: ["apps/worker"],
      why: "durable job loop and orchestration",
    });
    expect(parsed!.functional.map((c) => c.title)).toEqual([
      "Documentation generation",
      "Search",
    ]);
    // functional capability with multiple implementing paths
    expect(parsed!.functional[0]!.sourcePaths).toEqual([
      "apps/worker/src/docs",
      "packages/docs-engine",
    ]);
    expect(parsed!.notes).toContain("monorepo");
  });

  it("returns null when the technical list markers are missing", () => {
    const output = [
      ORIENT_START_MARKER,
      "notes",
      ORIENT_FUNCTIONAL_START_MARKER,
      "- Cap :: p :: w",
      ORIENT_FUNCTIONAL_END_MARKER,
      ORIENT_END_MARKER,
    ].join("\n");
    expect(parseOrientPlan(output)).toBeNull();
  });

  it("returns null when the functional list markers are missing", () => {
    const output = [
      ORIENT_START_MARKER,
      "notes",
      ORIENT_TECHNICAL_START_MARKER,
      "- Unit :: p :: w",
      ORIENT_TECHNICAL_END_MARKER,
      ORIENT_END_MARKER,
    ].join("\n");
    expect(parseOrientPlan(output)).toBeNull();
  });

  it("returns null for entirely unstructured output", () => {
    expect(parseOrientPlan("the repo is a monorepo with apps and packages")).toBeNull();
  });

  it("skips malformed child lines within an otherwise valid plan", () => {
    const parsed = parseOrientPlan(
      plan({ technical: ["- Worker :: apps/worker :: ok", "*", "   "] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.technical.map((c) => c.title)).toEqual(["Worker"]);
  });
});
