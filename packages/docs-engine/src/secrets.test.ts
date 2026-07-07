import { describe, expect, it } from "vitest";
import type { BriefConfidentialFact } from "./brief.js";
import {
  buildSecretsAuditPrompt,
  buildSecretsRewritePrompt,
  parseSecretsAuditOutput,
} from "./secrets.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FACTS: BriefConfidentialFact[] = [
  {
    fact: "The markup on token top-ups is 18%",
    reason: "It is the company's margin and must stay private",
    source: "apps/admin/pricing.ts computes retail = cost * 1.18",
    avoid: "never state a percentage margin or a wholesale price",
  },
  {
    fact: "Wholesale cost per SMS is 0.021 EUR from Acme Telecom",
    reason: "Supplier terms are confidential",
    source: "apps/admin/suppliers.ts",
    avoid: "never reveal supplier names or wholesale unit costs",
  },
];

const PAGE_BODY = `### Overview
You can buy top-ups for any prepaid line you manage.

### Pricing
Your price is shown at checkout before you confirm.`;

// ── parseSecretsAuditOutput ─────────────────────────────────────────────────

describe("parseSecretsAuditOutput", () => {
  it("accepts an explicit CLEAN verdict", () => {
    const output = `===VERDICT===
CLEAN
===DETAIL===
`;
    expect(parseSecretsAuditOutput(output)).toEqual({ verdict: "clean" });
  });

  it("accepts CLEAN case-insensitively and with surrounding whitespace", () => {
    const output = `blah blah
===VERDICT===
   clean
===DETAIL===`;
    expect(parseSecretsAuditOutput(output)).toEqual({ verdict: "clean" });
  });

  it("returns a VIOLATION with the detail text", () => {
    const output = `===VERDICT===
VIOLATION
===DETAIL===
The page states the 18% markup in "Pricing": "your margin is 18%".`;
    const res = parseSecretsAuditOutput(output);
    expect(res).toEqual({
      verdict: "violation",
      detail: 'The page states the 18% markup in "Pricing": "your margin is 18%".',
    });
  });

  it("reads VIOLATION case-insensitively", () => {
    const output = `===VERDICT===
violation
===DETAIL===
leaked the wholesale price`;
    const res = parseSecretsAuditOutput(output);
    expect(res).toEqual({ verdict: "violation", detail: "leaked the wholesale price" });
  });

  it("fails closed on prose output with no markers", () => {
    const output = "This page looks fine to me, nothing confidential here.";
    expect(parseSecretsAuditOutput(output)).toEqual({
      verdict: "violation",
      detail: "unparseable audit output",
    });
  });

  it("fails closed on an empty output", () => {
    expect(parseSecretsAuditOutput("")).toEqual({
      verdict: "violation",
      detail: "unparseable audit output",
    });
  });

  it("fails closed on an unrecognized verdict token (e.g. 'ok')", () => {
    const output = `===VERDICT===
ok
===DETAIL===
looks fine`;
    expect(parseSecretsAuditOutput(output)).toEqual({
      verdict: "violation",
      detail: "unparseable audit output",
    });
  });

  it("fails closed on a fuzzy verdict token (e.g. 'MAYBE')", () => {
    const output = `===VERDICT===
MAYBE
===DETAIL===`;
    expect(parseSecretsAuditOutput(output)).toEqual({
      verdict: "violation",
      detail: "unparseable audit output",
    });
  });

  it("fails closed when the VERDICT marker is missing", () => {
    const output = `CLEAN
===DETAIL===
nothing`;
    expect(parseSecretsAuditOutput(output)).toEqual({
      verdict: "violation",
      detail: "unparseable audit output",
    });
  });

  it("marks a violation even when the DETAIL is empty", () => {
    const output = `===VERDICT===
VIOLATION
===DETAIL===`;
    expect(parseSecretsAuditOutput(output)).toEqual({
      verdict: "violation",
      detail: "",
    });
  });

  it("truncates a very long detail to 500 characters", () => {
    const long = "x".repeat(900);
    const output = `===VERDICT===
VIOLATION
===DETAIL===
${long}`;
    const res = parseSecretsAuditOutput(output);
    expect(res.verdict).toBe("violation");
    if (res.verdict === "violation") {
      expect(res.detail).toHaveLength(500);
    }
  });
});

// ── buildSecretsAuditPrompt ─────────────────────────────────────────────────

describe("buildSecretsAuditPrompt", () => {
  const prompt = buildSecretsAuditPrompt({
    pageTitle: "Top-ups guide",
    body: PAGE_BODY,
    confidentialFacts: FACTS,
  });

  it("frames the auditor as a red-teamer for a public website", () => {
    expect(prompt.toLowerCase()).toContain("public");
    expect(prompt.toLowerCase()).toMatch(/red.?team|audit/);
  });

  it("includes the COMPLETE facts, value included (not only the avoid rule)", () => {
    // The auditor must know the literal value to recognize it.
    expect(prompt).toContain("The markup on token top-ups is 18%");
    expect(prompt).toContain("Wholesale cost per SMS is 0.021 EUR from Acme Telecom");
    // reason and avoid are present too.
    expect(prompt).toContain("It is the company's margin and must stay private");
    expect(prompt).toContain("never state a percentage margin or a wholesale price");
  });

  it("renders the page body inside a delimited block", () => {
    expect(prompt).toContain(PAGE_BODY);
    expect(prompt).toContain("Top-ups guide");
  });

  it("instructs to flag inference / derivation / conspicuous omission", () => {
    const low = prompt.toLowerCase();
    expect(low).toMatch(/infer|imply|derive/);
    expect(low).toContain("omission");
  });

  it("states the VERDICT/DETAIL output contract", () => {
    expect(prompt).toContain("===VERDICT===");
    expect(prompt).toContain("===DETAIL===");
    expect(prompt).toContain("CLEAN");
    expect(prompt).toContain("VIOLATION");
  });
});

// ── buildSecretsRewritePrompt ───────────────────────────────────────────────

describe("buildSecretsRewritePrompt", () => {
  const prompt = buildSecretsRewritePrompt({
    pageTitle: "Top-ups guide",
    body: PAGE_BODY,
    detail: 'The page states the 18% markup in "Pricing".',
  });

  it("includes the flagged detail and the page body", () => {
    expect(prompt).toContain('The page states the 18% markup in "Pricing".');
    expect(prompt).toContain(PAGE_BODY);
    expect(prompt).toContain("Top-ups guide");
  });

  it("instructs a targeted rewrite that keeps the rest intact", () => {
    const low = prompt.toLowerCase();
    expect(low).toMatch(/remov|neutraliz/);
    expect(low).toContain("intact");
  });

  it("reuses the product ===PAGE=== markers", () => {
    expect(prompt).toContain("===PAGE===");
    expect(prompt).toContain("===END PAGE===");
  });
});
