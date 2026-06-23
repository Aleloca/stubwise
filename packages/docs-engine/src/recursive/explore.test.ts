import { describe, expect, it } from "vitest";
import {
  EXPLORE_BODY_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  SOURCE_PATHS_END_MARKER,
  SOURCE_PATHS_START_MARKER,
} from "./contract.js";
import {
  buildExplorePrompt,
  parseExploreOutput,
  type ExploreInput,
} from "./explore.js";

const DEEP_BODY = [
  "### What this is",
  "A thorough, real description of the unit with enough words to comfortably clear the",
  "minimum-length acceptance gate so it counts as a genuine deep page, not a stub.",
  "",
  "### How it works",
  "More detail about the mechanism and the flows involved.",
].join("\n");

/** Assembles a well-formed explore output from a body + child/path lines. */
function exploreOutput(opts: {
  body?: string;
  children?: string[];
  paths?: string[];
  preamble?: string;
}): string {
  return [
    ...(opts.preamble ? [opts.preamble] : []),
    EXPLORE_BODY_START_MARKER,
    opts.body ?? DEEP_BODY,
    EXPLORE_BODY_END_MARKER,
    EXPLORE_CHILDREN_START_MARKER,
    ...(opts.children ?? []),
    EXPLORE_CHILDREN_END_MARKER,
    SOURCE_PATHS_START_MARKER,
    ...(opts.paths ?? []),
    SOURCE_PATHS_END_MARKER,
  ].join("\n");
}

function input(over: Partial<ExploreInput> = {}): ExploreInput {
  return {
    tree: "technical",
    unitRef: "apps/worker",
    title: "Worker",
    parentContext: "The architecture overview of the system.",
    ancestorTitles: ["Architecture Overview"],
    ...over,
  };
}

describe("buildExplorePrompt (technical)", () => {
  it("instructs deep code documentation, sub-units and the three output blocks", () => {
    const prompt = buildExplorePrompt(input());
    expect(prompt).toContain("apps/worker");
    expect(prompt).toContain("Worker");
    expect(prompt).toContain("Architecture Overview");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("technical");
    expect(lower).toMatch(/read-only/);
    expect(lower).toMatch(/responsibilities/);
    expect(lower).toMatch(/how it works/);
    // sub-units that deserve their own page
    expect(lower).toMatch(/deserve their own page/);
    expect(lower).toMatch(/leaf/);
    // three blocks present
    expect(prompt).toContain(EXPLORE_BODY_START_MARKER);
    expect(prompt).toContain(EXPLORE_CHILDREN_START_MARKER);
    expect(prompt).toContain(SOURCE_PATHS_START_MARKER);
    // anti-meta
    expect(lower).toContain("the plan file");
    expect(lower).toMatch(/let me know if/);
  });
});

describe("buildExplorePrompt (functional)", () => {
  it("mirrors the strong plain-language / exhaustive / grounding instructions", () => {
    const prompt = buildExplorePrompt(
      input({ tree: "functional", unitRef: "Search", title: "Search" }),
    );
    const lower = prompt.toLowerCase();
    // strong plain-language rule
    expect(lower).toContain("plain");
    expect(lower).toContain("non-technical");
    expect(lower).toMatch(/no file paths|file paths/);
    expect(lower).toMatch(/absolute language rule/);
    // exhaustive enumeration incl. what is NOT possible
    expect(lower).toContain("exhaustive");
    expect(lower).toMatch(/everything a user can do/);
    expect(lower).toContain("not possible");
    // grounding + translate
    expect(lower).toContain("read-only");
    expect(lower).toContain("translate");
    // sub-capabilities deserve a page
    expect(lower).toMatch(/deserve their own page/);
    // still the three-block contract + anti-meta
    expect(prompt).toContain(EXPLORE_CHILDREN_START_MARKER);
    expect(lower).toContain("the plan file");
  });
});

describe("parseExploreOutput", () => {
  it("parses body + children + source paths (branch node)", () => {
    const out = exploreOutput({
      children: [
        "- Queue :: apps/worker/src/queue.ts :: core loop",
        "- Git mirrors :: apps/worker/src/git/mirrors.ts :: substantial subsystem",
      ],
      paths: ["- apps/worker/src/queue.ts", "- apps/worker/src/git/mirrors.ts"],
      preamble: "I now have a thorough understanding. Here is the page.",
    });
    const res = parseExploreOutput(out);
    expect("reason" in res).toBe(false);
    if ("reason" in res) throw new Error("unexpected reason");
    expect(res.body).toBe(DEEP_BODY);
    expect(res.children.map((c) => c.title)).toEqual(["Queue", "Git mirrors"]);
    expect(res.children[0]!.unitRef).toBe("apps/worker/src/queue.ts");
    expect(res.sourcePaths).toEqual([
      "apps/worker/src/queue.ts",
      "apps/worker/src/git/mirrors.ts",
    ]);
    // preamble/markers stripped from the body
    expect(res.body).not.toContain("I now have a thorough");
    expect(res.body).not.toContain(EXPLORE_BODY_START_MARKER);
  });

  it("parses a LEAF: present-but-empty children block → no children", () => {
    const out = exploreOutput({ children: [], paths: ["- apps/worker/src/x.ts"] });
    const res = parseExploreOutput(out);
    if ("reason" in res) throw new Error("unexpected reason");
    expect(res.children).toEqual([]);
    expect(res.sourcePaths).toEqual(["apps/worker/src/x.ts"]);
  });

  it("rejects a missing body block as no-markers", () => {
    const out = [
      EXPLORE_CHILDREN_START_MARKER,
      "- A :: p :: w",
      EXPLORE_CHILDREN_END_MARKER,
    ].join("\n");
    const res = parseExploreOutput(out);
    expect(res).toEqual({ reason: "no-markers" });
  });

  it("rejects an empty/too-short body", () => {
    const out = exploreOutput({ body: "### Tiny\nshort" });
    const res = parseExploreOutput(out);
    expect(res).toEqual({ reason: "too-short" });
  });

  it("rejects a body that opens with a meta-summary", () => {
    const out = exploreOutput({
      body:
        "The documentation page is written and saved to the plan file. It covers everything " +
        "you could possibly need about this unit in full detail, end to end, comprehensively.",
    });
    const res = parseExploreOutput(out);
    expect(res).toEqual({ reason: "meta-summary" });
  });

  it("rejects when the children block is entirely missing (contract violated)", () => {
    const out = [
      EXPLORE_BODY_START_MARKER,
      DEEP_BODY,
      EXPLORE_BODY_END_MARKER,
      SOURCE_PATHS_START_MARKER,
      "- p",
      SOURCE_PATHS_END_MARKER,
    ].join("\n");
    const res = parseExploreOutput(out);
    expect(res).toEqual({ reason: "no-children-block" });
  });

  it("skips malformed child lines but keeps the valid ones", () => {
    const out = exploreOutput({
      children: ["- Good :: p :: w", "*", "   ", "- Also :: q :: w2"],
    });
    const res = parseExploreOutput(out);
    if ("reason" in res) throw new Error("unexpected reason");
    expect(res.children.map((c) => c.title)).toEqual(["Good", "Also"]);
  });

  it("tolerates a missing source-paths block (body stays publishable)", () => {
    const out = [
      EXPLORE_BODY_START_MARKER,
      DEEP_BODY,
      EXPLORE_BODY_END_MARKER,
      EXPLORE_CHILDREN_START_MARKER,
      EXPLORE_CHILDREN_END_MARKER,
    ].join("\n");
    const res = parseExploreOutput(out);
    if ("reason" in res) throw new Error("unexpected reason");
    expect(res.sourcePaths).toEqual([]);
    expect(res.children).toEqual([]);
  });
});
