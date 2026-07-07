import { describe, expect, it } from "vitest";
import {
  SYNTH_BODY_END_MARKER,
  SYNTH_BODY_START_MARKER,
} from "./contract.js";
import {
  buildSynthesizePrompt,
  parseSynthesisOutput,
  type SynthesizeInput,
} from "./synthesize.js";

const OVERVIEW_BODY = [
  "### Overview",
  "This area covers the worker subsystem with a thorough, real introduction that is long",
  "enough to comfortably clear the minimum-length acceptance gate for a genuine page.",
  "",
  "### Contents",
  "- Queue: the durable job loop.",
  "- Mirrors: git mirror management.",
].join("\n");

function input(over: Partial<SynthesizeInput> = {}): SynthesizeInput {
  return {
    tree: "technical",
    title: "Worker",
    intro: "The worker orchestrates durable jobs.",
    children: [
      { title: "Queue", summary: "The durable job loop." },
      { title: "Mirrors", summary: "Git mirror management." },
    ],
    ...over,
  };
}

describe("buildSynthesizePrompt", () => {
  it("instructs a linked overview/index of the children with the body markers", () => {
    const prompt = buildSynthesizePrompt(input());
    expect(prompt).toContain("Worker");
    expect(prompt).toContain("Queue");
    expect(prompt).toContain("The durable job loop.");
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/overview|index/);
    expect(lower).toMatch(/children|sub-pages/);
    // body markers + anti-meta
    expect(prompt).toContain(SYNTH_BODY_START_MARKER);
    expect(prompt).toContain(SYNTH_BODY_END_MARKER);
    expect(lower).toContain("the plan file");
    expect(lower).toMatch(/let me know if/);
  });

  it("uses a plain-language register for the functional tree", () => {
    const prompt = buildSynthesizePrompt(input({ tree: "functional" }));
    const lower = prompt.toLowerCase();
    expect(lower).toContain("non-technical");
    expect(lower).toMatch(/file paths|jargon/);
  });

  it("bounds the prompt by truncating long child summaries", () => {
    const prompt = buildSynthesizePrompt(
      input({ children: [{ title: "Big", summary: "x".repeat(2000) }] }),
    );
    expect(prompt).not.toMatch(/x{700}/);
  });
});

describe("buildSynthesizePrompt (briefContext)", () => {
  const BRIEF = "PROJECT CONTEXT — use this glossary and terminology consistently:\nGlossary:\n- Ticket: a unit of work.";

  it("prepends the brief context BEFORE the overview instructions", () => {
    const prompt = buildSynthesizePrompt(input(), BRIEF);
    expect(prompt).toContain(BRIEF);
    expect(prompt.indexOf(BRIEF)).toBeLessThan(
      prompt.indexOf("You are writing the OVERVIEW"),
    );
    expect(prompt).toContain("keep names canonical");
  });

  it("without briefContext the prompt is unchanged and has no context block", () => {
    const prompt = buildSynthesizePrompt(input());
    expect(prompt.startsWith("You are writing the OVERVIEW")).toBe(true);
    expect(prompt).not.toContain("PROJECT CONTEXT");
    expect(prompt).not.toContain("keep names canonical");
    expect(buildSynthesizePrompt(input(), undefined)).toBe(prompt);
  });
});

describe("parseSynthesisOutput", () => {
  it("parses the overview body between the markers, stripping outside text", () => {
    const out = [
      "I now have a thorough understanding. Here it is.",
      SYNTH_BODY_START_MARKER,
      OVERVIEW_BODY,
      SYNTH_BODY_END_MARKER,
      "Let me know if you need changes.",
    ].join("\n");
    const res = parseSynthesisOutput(out);
    if ("reason" in res) throw new Error("unexpected reason");
    expect(res.body).toBe(OVERVIEW_BODY);
    expect(res.body).not.toContain("I now have a thorough");
    expect(res.body).not.toContain(SYNTH_BODY_START_MARKER);
  });

  it("rejects missing markers as no-markers", () => {
    expect(parseSynthesisOutput("just prose, no markers")).toEqual({
      reason: "no-markers",
    });
  });

  it("rejects a too-short body", () => {
    const out = [SYNTH_BODY_START_MARKER, "### Tiny\nx", SYNTH_BODY_END_MARKER].join(
      "\n",
    );
    expect(parseSynthesisOutput(out)).toEqual({ reason: "too-short" });
  });

  it("rejects a body that opens with a meta-summary", () => {
    const out = [
      SYNTH_BODY_START_MARKER,
      "The documentation page is written and saved to the plan file. It indexes all the " +
        "children of this area in full and complete detail for the reader to navigate.",
      SYNTH_BODY_END_MARKER,
    ].join("\n");
    expect(parseSynthesisOutput(out)).toEqual({ reason: "meta-summary" });
  });
});
