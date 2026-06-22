import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./chunk.js";

describe("chunkMarkdown (M3.3)", () => {
  it("splits a multi-heading doc capturing the nearest heading", () => {
    const md = [
      "# Intro",
      "This is the intro paragraph.",
      "",
      "## Setup",
      "Install the thing and configure it.",
      "",
      "## Usage",
      "Run the command to use it.",
    ].join("\n");

    // target large enough that each short section stays a single chunk,
    // so the split is driven purely by headings.
    const chunks = chunkMarkdown(md, { targetTokens: 50, overlap: 0 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain("Intro");
    expect(headings).toContain("Setup");
    expect(headings).toContain("Usage");
    // each chunk's content carries its source heading
    const setup = chunks.find((c) => c.heading === "Setup");
    expect(setup?.content).toContain("Install the thing");
  });

  it("splits a long single section into multiple chunks respecting target", () => {
    const words = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
    const md = `# Big\n${words}`;
    const chunks = chunkMarkdown(md, { targetTokens: 20, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.heading).toBe("Big");
    }
  });

  it("carries an overlap between consecutive chunks of a long section", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const md = `# Big\n${words}`;
    const chunks = chunkMarkdown(md, { targetTokens: 20, overlap: 5 });

    expect(chunks.length).toBeGreaterThan(1);
    // tail words of chunk[0] reappear at the head of chunk[1]
    const firstWords = chunks[0]!.content.split(/\s+/).filter(Boolean);
    const secondWords = chunks[1]!.content.split(/\s+/).filter(Boolean);
    const tail = firstWords.slice(-5);
    expect(secondWords.slice(0, 5)).toEqual(tail);
  });

  it("returns no chunks for empty/whitespace input", () => {
    expect(chunkMarkdown("", { targetTokens: 10, overlap: 0 })).toEqual([]);
    expect(chunkMarkdown("   \n  ", { targetTokens: 10, overlap: 0 })).toEqual([]);
  });

  it("handles content before any heading (heading = null)", () => {
    const md = "leading text without a heading\n\n# Later\nbody";
    const chunks = chunkMarkdown(md, { targetTokens: 50, overlap: 0 });
    expect(chunks[0]!.heading).toBeNull();
    expect(chunks[0]!.content).toContain("leading text");
  });
});
