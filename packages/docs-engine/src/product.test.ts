import { describe, expect, it } from "vitest";
import type { BriefJourney, BriefSurface } from "./brief.js";
import {
  buildProductFaqPrompt,
  buildProductGuidePrompt,
  buildProductRootPrompt,
  parseProductGuideOutput,
  parseProductPageOutput,
  type ProductPromptInput,
} from "./product.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SURFACE: BriefSurface = {
  name: "Reseller portal",
  type: "web app",
  rootPath: "apps/portal",
  audience: "resellers",
  internal: false,
};

const JOURNEY: BriefJourney = {
  actor: "Reseller",
  title: "Top up a customer line",
  summary: "The reseller searches a line and buys a top-up from their wallet.",
};

const BRIEF_CONTEXT = `PROJECT CONTEXT — use this glossary and terminology consistently:

Identity: Acme sells prepaid top-ups.

Glossary (use these exact terms):
- Top-up: adding credit to a prepaid line

NEVER disclose the following confidential facts. Do NOT state them:
- Never: never state a percentage margin or wholesale price`;

const FUNCTIONAL_SUMMARIES = [
  { title: "Top-ups", summary: "You can top up any prepaid line you manage." },
  { title: "Wallet", summary: "Your wallet holds the balance you draw from." },
];

const INPUT: ProductPromptInput = {
  surface: SURFACE,
  briefContext: BRIEF_CONTEXT,
  functionalSummaries: FUNCTIONAL_SUMMARIES,
};

// ── Prompt: root ────────────────────────────────────────────────────────────

describe("buildProductRootPrompt", () => {
  const prompt = buildProductRootPrompt(INPUT);

  it("titles the vertical after the surface and covers getting-started", () => {
    expect(prompt).toContain("Reseller portal");
    expect(prompt.toLowerCase()).toContain("getting started");
    expect(prompt.toLowerCase()).toContain("first");
  });

  it("reads the surface code read-only from its real root path", () => {
    expect(prompt).toContain("apps/portal");
    expect(prompt.toUpperCase()).toContain("READ-ONLY");
  });

  it("demands the SECOND-PERSON register for the end user", () => {
    expect(prompt.toLowerCase()).toContain("second person");
    expect(prompt.toLowerCase()).toMatch(/"you"|end user/);
  });

  it("forbids internals and requires user-visible names", () => {
    expect(prompt.toLowerCase()).toMatch(/no file|never mention|do not (mention|expose)/);
    expect(prompt.toLowerCase()).toMatch(/label|menu|button|url/);
  });

  it("renders the briefContext including the NEVER-disclose section", () => {
    expect(prompt).toContain("NEVER disclose");
    expect(prompt).toContain("never state a percentage margin");
  });

  it("renders functionalSummaries as internal domain knowledge, re-expressed", () => {
    expect(prompt).toContain("DOMAIN KNOWLEDGE");
    expect(prompt.toLowerCase()).toContain("do not copy verbatim");
    expect(prompt).toContain("Top-ups");
    expect(prompt).toContain("You can top up any prepaid line you manage.");
  });

  it("uses the product page markers in the output contract", () => {
    expect(prompt).toContain("===PAGE===");
    expect(prompt).toContain("===END PAGE===");
  });
});

// ── Prompt: guide ─────────────────────────────────────────────────────────────

describe("buildProductGuidePrompt", () => {
  const prompt = buildProductGuidePrompt({ ...INPUT, journey: JOURNEY });

  it("imposes the five required sections in order", () => {
    const goal = prompt.indexOf("### Goal");
    const prereq = prompt.indexOf("### Prerequisites");
    const steps = prompt.indexOf("### Steps");
    const result = prompt.indexOf("### Expected result");
    const issues = prompt.indexOf("### Common issues");
    expect(goal).toBeGreaterThan(-1);
    expect(prereq).toBeGreaterThan(goal);
    expect(steps).toBeGreaterThan(prereq);
    expect(result).toBeGreaterThan(steps);
    expect(issues).toBeGreaterThan(result);
  });

  it("carries the journey title and actor", () => {
    expect(prompt).toContain("Top up a customer line");
    expect(prompt).toContain("Reseller");
  });

  it("explains the mandatory NAV anchor with an example including a URL", () => {
    expect(prompt).toContain("NAV:");
    expect(prompt).toMatch(/NAV:.*→.*\[\/.*\]/);
    expect(prompt.toLowerCase()).toMatch(/mandatory|obligatory|required/);
  });

  it("derives navigation from the real surface code", () => {
    expect(prompt).toContain("apps/portal");
    expect(prompt.toLowerCase()).toMatch(/route|navigation|label/);
  });

  it("allows ===SKIP=== when the journey is not realizable on the surface", () => {
    expect(prompt).toContain("===SKIP===");
  });

  it("demands the second-person register and forbids internals", () => {
    expect(prompt.toLowerCase()).toContain("second person");
    expect(prompt.toLowerCase()).toMatch(/no file|never mention|do not (mention|expose)/);
  });

  it("renders briefContext and functionalSummaries", () => {
    expect(prompt).toContain("NEVER disclose");
    expect(prompt).toContain("DOMAIN KNOWLEDGE");
    expect(prompt).toContain("You can top up any prepaid line you manage.");
  });

  it("preserves blank separator lines even when actor/summary are absent", () => {
    const bare = buildProductGuidePrompt({
      ...INPUT,
      journey: { title: "Do a thing", actor: "", summary: "" },
    });
    // Optional actor/summary lines are dropped, but the structural blank separators must
    // remain (no collapsing of every empty line).
    expect(bare).not.toContain("- Actor:");
    expect(bare).not.toContain("- Summary:");
    expect(bare).toContain("\n\n");
    expect(bare).toContain("- Journey: Do a thing\n\n");
  });
});

// ── Prompt: FAQ ───────────────────────────────────────────────────────────────

describe("buildProductFaqPrompt", () => {
  const LIMITATIONS = [
    "You cannot top up a line from a different country.",
    "Refunds are not available once a top-up is confirmed.",
  ];
  const prompt = buildProductFaqPrompt({ ...INPUT, limitations: LIMITATIONS });

  it("turns limitations into honest FAQ questions and answers", () => {
    expect(prompt.toLowerCase()).toContain("faq");
    expect(prompt.toLowerCase()).toMatch(/question/);
    expect(prompt).toContain("You cannot top up a line from a different country.");
    expect(prompt).toContain("Refunds are not available once a top-up is confirmed.");
    expect(prompt.toLowerCase()).toMatch(/honest|workaround|cannot/);
  });

  it("keeps the second-person register and renders context", () => {
    expect(prompt.toLowerCase()).toContain("second person");
    expect(prompt).toContain("NEVER disclose");
    expect(prompt).toContain("DOMAIN KNOWLEDGE");
  });

  it("uses the product page markers", () => {
    expect(prompt).toContain("===PAGE===");
    expect(prompt).toContain("===END PAGE===");
  });
});

// ── Parser: product page (root / FAQ) ─────────────────────────────────────────

describe("parseProductPageOutput", () => {
  it("extracts a valid body between the page markers", () => {
    const out = `
preamble ignored
===PAGE===
### Welcome to the Reseller portal

Here is what you can do and how to get started for the very first time. This body
is long enough to pass the minimum length check without any trouble at all here.
===END PAGE===
trailing ignored`;
    const res = parseProductPageOutput(out);
    expect("body" in res).toBe(true);
    if ("body" in res) {
      expect(res.body).toContain("### Welcome");
      expect(res.body).not.toContain("preamble");
    }
  });

  it("rejects a missing body block", () => {
    const res = parseProductPageOutput("no markers here at all");
    expect(res).toEqual({ reason: "no-markers" });
  });

  it("rejects an empty body block", () => {
    const res = parseProductPageOutput("===PAGE===\n\n===END PAGE===");
    expect(res).toEqual({ reason: "no-markers" });
  });

  it("rejects a too-short body", () => {
    const res = parseProductPageOutput("===PAGE===\nToo short.\n===END PAGE===");
    expect(res).toEqual({ reason: "too-short" });
  });

  it("rejects a meta-summary body", () => {
    const out = `===PAGE===
The documentation page is saved to the plan file. Let me know if you need anything
else about this documentation page and I will gladly help you out further today.
===END PAGE===`;
    const res = parseProductPageOutput(out);
    expect(res).toEqual({ reason: "meta-summary" });
  });
});

// ── Parser: product guide ─────────────────────────────────────────────────────

const VALID_GUIDE = `
===PAGE===
### Goal
Top up a customer's prepaid line from your wallet.

### Prerequisites
You have a funded wallet and the customer's phone number.

### Steps
1. Open the top-up form.
   NAV: Top-ups → New top-up [/topups/new]
2. Enter the phone number and amount.
   NAV: Top-ups → New top-up → Amount field
3. Confirm the purchase.
   NAV: Top-ups → New top-up → Confirm [/topups/new]

### Expected result
The line receives credit and you see a confirmation with a receipt number.

### Common issues
If the wallet balance is too low, the Confirm button stays disabled.
===END PAGE===`;

describe("parseProductGuideOutput", () => {
  it("accepts a well-formed guide with NAV anchors and counts them", () => {
    const res = parseProductGuideOutput(VALID_GUIDE);
    expect("body" in res).toBe(true);
    if ("body" in res) {
      expect(res.body).toContain("### Goal");
      expect(res.navAnchors).toBe(3);
    }
  });

  it("returns skip with a reason when the agent emits ===SKIP===", () => {
    const out = "===SKIP===\nThis journey happens only in the admin app.";
    const res = parseProductGuideOutput(out);
    expect(res).toEqual({ skip: "This journey happens only in the admin app." });
  });

  it("rejects a guide missing a required section", () => {
    const out = VALID_GUIDE.replace("### Common issues", "### Notes");
    const res = parseProductGuideOutput(out);
    expect(res).toEqual({ reason: "missing-sections" });
  });

  it("rejects a guide with zero navigation anchors", () => {
    const out = VALID_GUIDE.replace(/\s*NAV:.*$/gm, "");
    const res = parseProductGuideOutput(out);
    expect(res).toEqual({ reason: "no navigation anchors" });
  });

  it("rejects a guide with anchors below the half-of-steps threshold", () => {
    // Four numbered steps, only one NAV → below threshold (needs >= 2).
    const out = `===PAGE===
### Goal
Do the thing.

### Prerequisites
You are signed in and ready to proceed with this walkthrough right away.

### Steps
1. First step of the flow.
   NAV: Menu → One [/one]
2. Second step of the flow that also touches the interface here.
3. Third step of the flow that also touches the interface here.
4. Fourth step of the flow that also touches the interface here.

### Expected result
Everything works out and you land on a clear confirmation screen at the end.

### Common issues
Nothing unusual is expected to happen during this particular walkthrough today.
===END PAGE===`;
    const res = parseProductGuideOutput(out);
    expect(res).toEqual({ reason: "insufficient navigation anchors" });
  });

  it("counts steps/NAV only in the Steps section (numbered list elsewhere is ignored)", () => {
    // Two numbered steps WITH NAV in ### Steps + a 4-item numbered list in Common issues.
    // If counting were body-wide, the list would inflate steps to 6 (need >=3 NAV) and the
    // 2 NAV would fail the threshold — a false positive. Scoped to Steps: 2 steps, 2 NAV → OK.
    const out = `===PAGE===
### Goal
Do the thing.

### Prerequisites
You are signed in and ready to proceed with this walkthrough right away.

### Steps
1. Open the form.
   NAV: Menu → One [/one]
2. Confirm the action.
   NAV: Menu → Two [/two]

### Expected result
Everything works out and you land on a clear confirmation screen at the end.

### Common issues
Here are things that can go wrong:
1. The button is disabled — top up your wallet first.
2. The page does not load — refresh and try again in a moment.
3. The amount is rejected — enter a value above the minimum.
4. The receipt is missing — check your email after a short delay.
===END PAGE===`;
    const res = parseProductGuideOutput(out);
    expect("body" in res).toBe(true);
    if ("body" in res) expect(res.navAnchors).toBe(2);
  });

  it("does not count NAV lines outside the Steps section as anchors", () => {
    // Four numbered steps in ### Steps with NO NAV; two NAV lines in Common issues.
    // Body-wide counting would see 2 anchors; scoped to Steps there are 0 → rejected.
    const out = `===PAGE===
### Goal
Do the thing.

### Prerequisites
You are signed in and ready to proceed with this walkthrough right away.

### Steps
1. First step of the flow you follow closely here today.
2. Second step of the flow you follow closely here today.
3. Third step of the flow you follow closely here today.
4. Fourth step of the flow you follow closely here today.

### Expected result
Everything works out and you land on a clear confirmation screen at the end.

### Common issues
If you get stuck, here is where the relevant screens live:
   NAV: Menu → One [/one]
   NAV: Menu → Two [/two]
===END PAGE===`;
    const res = parseProductGuideOutput(out);
    expect(res).toEqual({ reason: "no navigation anchors" });
  });

  it("truncates a mid-body ===SKIP=== reason at the next marker line", () => {
    // ===SKIP=== appears inside a body; the reason must stop at the next `===` line
    // (===END PAGE=== here), not swallow the rest of the body.
    const out = `===PAGE===
### Goal
Something.
===SKIP===
This belongs to the admin app.
===END PAGE===`;
    const res = parseProductGuideOutput(out);
    expect(res).toEqual({ skip: "This belongs to the admin app." });
  });

  it("caps a runaway skip reason at 300 characters", () => {
    const long = "x".repeat(500);
    const res = parseProductGuideOutput(`===SKIP===\n${long}`);
    expect(res).toEqual({ skip: "x".repeat(300) });
  });

  it("rejects a guide with no body block", () => {
    const res = parseProductGuideOutput("no markers");
    expect(res).toEqual({ reason: "no-markers" });
  });

  it("never throws on garbage input", () => {
    expect(() => parseProductGuideOutput("")).not.toThrow();
    expect(() => parseProductGuideOutput("===SKIP===")).not.toThrow();
  });

  it("treats a bare ===SKIP=== with no reason as a skip with empty reason", () => {
    const res = parseProductGuideOutput("===SKIP===");
    expect(res).toEqual({ skip: "" });
  });
});
