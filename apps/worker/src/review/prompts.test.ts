import { describe, expect, it } from "vitest";

import { buildReviewPrompt, parseReviewOutput } from "./prompts.js";

describe("parseReviewOutput", () => {
  it("JSON puro → verdict + summary", () => {
    const out = parseReviewOutput('{"verdict":"approve","summary":"Tutto ok"}');
    expect(out).toEqual({ verdict: "approve", summary: "Tutto ok" });
  });

  it("JSON in fence markdown → estratto e parsato", () => {
    const raw =
      'Ecco la review:\n```json\n{"verdict":"request_changes","summary":"- bug a riga 3"}\n```\n';
    expect(parseReviewOutput(raw)?.verdict).toBe("request_changes");
  });

  it("JSON con testo attorno (senza fence) → prima {…} bilanciata", () => {
    const raw = 'Premessa.\n{"verdict":"approve","summary":"ok"}\nCoda.';
    expect(parseReviewOutput(raw)?.verdict).toBe("approve");
  });

  it("verdetto sconosciuto o JSON assente → null", () => {
    expect(parseReviewOutput('{"verdict":"maybe","summary":"x"}')).toBeNull();
    expect(parseReviewOutput("nessun json")).toBeNull();
    expect(parseReviewOutput('{"verdict":"approve"}')).toBeNull(); // summary mancante
    expect(parseReviewOutput('{"verdict":"approve","summary":""}')).toBeNull(); // summary vuota
  });
});

describe("buildReviewPrompt", () => {
  it("contiene titolo, corpo, branch, diff, nota di troncamento e lingua", () => {
    const prompt = buildReviewPrompt({
      prTitle: "Add login",
      prBody: "desc",
      sourceBranch: "feature/login",
      targetBranch: "main",
      diff: "diff --git a/x b/x",
      diffTruncated: true,
      language: "it",
    });
    expect(prompt).toContain("Add login");
    expect(prompt).toContain("desc");
    expect(prompt).toContain("feature/login");
    expect(prompt).toContain("main");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("TRUNCATED");
    expect(prompt).toContain('"verdict"');
    expect(prompt.toLowerCase()).toContain("italian"); // languageName("it") = "Italian"
  });

  it("senza descrizione → segnaposto; senza troncamento → niente nota", () => {
    const prompt = buildReviewPrompt({
      prTitle: "Fix typo",
      prBody: "",
      sourceBranch: "fix/typo",
      targetBranch: "main",
      diff: "diff --git a/y b/y",
      diffTruncated: false,
      language: "en",
    });
    expect(prompt).toContain("(no description)");
    expect(prompt).not.toContain("TRUNCATED");
    expect(prompt.toLowerCase()).toContain("english");
  });
});
