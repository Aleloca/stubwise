import { describe, expect, it } from "vitest";
import {
  briefPromptContext,
  buildBriefPrompt,
  parseBriefOutput,
  type ProjectBrief,
} from "./brief.js";

/** Un output del documentarista completo e ben formato, per i test del parser. */
const FULL_OUTPUT = `
Some preamble prose that should be ignored.

===IDENTITY===
Acme sells prepaid mobile top-ups. Businesses pay per top-up they resell to end
users; Acme takes a margin on each transaction.
===END IDENTITY===
===ACTORS===
- Reseller :: business that resells top-ups :: false
- Operator :: internal staff running the back office :: true
- End user :: person whose phone gets topped up :: no
===END ACTORS===
===SURFACES===
- Reseller portal :: web app :: apps/portal :: resellers :: false
- Back office :: admin app :: /apps/admin/ :: operators :: internal
- Public API :: rest api :: packages/api :: integrators :: false
===END SURFACES===
===GLOSSARY===
- Top-up :: adding credit to a prepaid line
- Reseller :: a business customer that resells top-ups
- Wallet :: the reseller's prepaid balance held with Acme
===END GLOSSARY===
===INVARIANTS===
- A top-up cannot exceed the reseller's wallet balance.
- Every transaction is idempotent by client reference.
===END INVARIANTS===
===CONFIDENTIAL FACTS===
- Markup is 18% on wholesale :: reveals Acme's margin :: packages/pricing/markup.ts :: never state a percentage margin or wholesale price
- Supplier X gives 5% rebate :: supplier terms are secret :: apps/admin/suppliers :: do not name suppliers or rebate terms
===END CONFIDENTIAL FACTS===
===JOURNEYS===
- Reseller :: Top up a line :: reseller enters MSISDN and amount, confirms, gets receipt
- Operator :: Reconcile suppliers :: operator matches supplier invoices to transactions
===END JOURNEYS===
===EXISTING SOURCES===
- README.md
- docs/adr/0001-wallet.md
- packages/db/schema.sql
===END EXISTING SOURCES===

Trailing prose, ignored.
`;

describe("buildBriefPrompt", () => {
  const prompt = buildBriefPrompt({ commitSubjects: ["feat: wallet", "fix: top-up"] });

  it("contiene le otto sezioni fondanti", () => {
    expect(prompt).toContain("IDENTITY");
    expect(prompt).toContain("ACTORS");
    expect(prompt).toContain("SURFACES");
    expect(prompt).toContain("GLOSSARY");
    expect(prompt).toContain("INVARIANTS");
    expect(prompt).toContain("CONFIDENTIAL FACTS");
    expect(prompt).toContain("JOURNEYS");
    expect(prompt).toContain("EXISTING SOURCES");
  });

  it("istruisce a rispondere alle domande PRIMA della scomposizione ed è read-only", () => {
    expect(prompt).toMatch(/READ-ONLY/);
    expect(prompt).toMatch(/BEFORE anyone decomposes/i);
    expect(prompt).toMatch(/Do NOT save anything to any file/);
  });

  it("chiede rootPath REALI verificati sul codice", () => {
    expect(prompt).toMatch(/REAL root path/i);
  });

  it("elenca le euristiche esplicite dei fatti riservati", () => {
    expect(prompt).toMatch(/margins/i);
    expect(prompt).toMatch(/markup/i);
    expect(prompt).toMatch(/pricing/i);
    expect(prompt).toMatch(/exchange rate/i);
    expect(prompt).toMatch(/supplier/i);
    expect(prompt).toMatch(/competitor/i);
    expect(prompt).toMatch(/internal surface/i);
  });

  it("dichiara i cap (glossario ≤30, facts ≤30, journeys ≤15)", () => {
    expect(prompt).toContain("30 glossary");
    expect(prompt).toContain("30 confidential");
    expect(prompt).toContain("15 journeys");
  });

  it("include i commit subject e regge l'assenza di commit", () => {
    expect(prompt).toContain("feat: wallet");
    const empty = buildBriefPrompt({});
    expect(empty).toContain("(no commit subjects)");
  });
});

describe("parseBriefOutput — output completo valido", () => {
  const brief = parseBriefOutput(FULL_OUTPUT);

  it("non è un {reason}", () => {
    expect("reason" in brief).toBe(false);
  });

  it("estrae l'identità come prosa", () => {
    const b = brief as ProjectBrief;
    expect(b.identity).toContain("prepaid mobile top-ups");
    expect(b.identity).not.toContain("===");
  });

  it("estrae gli attori col flag internal robusto (false/true/no)", () => {
    const b = brief as ProjectBrief;
    expect(b.actors).toEqual([
      { name: "Reseller", description: "business that resells top-ups", internal: false },
      { name: "Operator", description: "internal staff running the back office", internal: true },
      { name: "End user", description: "person whose phone gets topped up", internal: false },
    ]);
  });

  it("estrae le superfici e normalizza il rootPath (slash iniziali/finali)", () => {
    const b = brief as ProjectBrief;
    expect(b.surfaces).toEqual([
      { name: "Reseller portal", type: "web app", rootPath: "apps/portal", audience: "resellers", internal: false },
      { name: "Back office", type: "admin app", rootPath: "apps/admin", audience: "operators", internal: true },
      { name: "Public API", type: "rest api", rootPath: "packages/api", audience: "integrators", internal: false },
    ]);
  });

  it("estrae glossario, invarianti, fatti, journey, fonti", () => {
    const b = brief as ProjectBrief;
    expect(b.glossary).toHaveLength(3);
    expect(b.glossary[0]).toEqual({ term: "Top-up", definition: "adding credit to a prepaid line" });
    expect(b.invariants).toEqual([
      "A top-up cannot exceed the reseller's wallet balance.",
      "Every transaction is idempotent by client reference.",
    ]);
    expect(b.confidentialFacts).toHaveLength(2);
    expect(b.confidentialFacts[0]).toEqual({
      fact: "Markup is 18% on wholesale",
      reason: "reveals Acme's margin",
      source: "packages/pricing/markup.ts",
      avoid: "never state a percentage margin or wholesale price",
    });
    expect(b.journeys).toHaveLength(2);
    expect(b.journeys[0]).toEqual({
      actor: "Reseller",
      title: "Top up a line",
      summary: "reseller enters MSISDN and amount, confirms, gets receipt",
    });
    expect(b.existingSources).toEqual([
      "README.md",
      "docs/adr/0001-wallet.md",
      "packages/db/schema.sql",
    ]);
  });
});

describe("parseBriefOutput — robustezza best-effort per sezione", () => {
  it("una sezione mancante → array vuoto (o stringa vuota), le altre restano", () => {
    // Solo identity + glossary, nessun altro blocco.
    const out = `
===IDENTITY===
A product.
===END IDENTITY===
===GLOSSARY===
- Foo :: a foo
===END GLOSSARY===
`;
    const b = parseBriefOutput(out) as ProjectBrief;
    expect(b.identity).toBe("A product.");
    expect(b.glossary).toHaveLength(1);
    expect(b.actors).toEqual([]);
    expect(b.surfaces).toEqual([]);
    expect(b.invariants).toEqual([]);
    expect(b.confidentialFacts).toEqual([]);
    expect(b.journeys).toEqual([]);
    expect(b.existingSources).toEqual([]);
  });

  it("marcatori annidati/rotti → non lancia, best-effort", () => {
    const out = `
===ACTORS===
- A :: desc :: false
===GLOSSARY===
- Term :: def
===END GLOSSARY===
`;
    // ACTORS non è chiuso: il blocco actors è "assente" → []. GLOSSARY è valido.
    expect(() => parseBriefOutput(out)).not.toThrow();
    const b = parseBriefOutput(out) as ProjectBrief;
    expect(b.actors).toEqual([]);
    expect(b.glossary).toHaveLength(1);
  });

  it("rootPath con `..` (traversal) → superficie scartata", () => {
    const out = `
===SURFACES===
- Bad :: web :: apps/../etc :: x :: false
- Good :: web :: apps/portal :: users :: false
- NoPath :: web ::  :: users :: false
===END SURFACES===
`;
    const b = parseBriefOutput(out) as ProjectBrief;
    expect(b.surfaces).toHaveLength(1);
    expect(b.surfaces[0]?.name).toBe("Good");
  });

  it("righe vuote / bullet nudo → saltate, non lanciano", () => {
    // Riga vuota e bullet "nudo" (`-` da solo, che collassa a nome vuoto) → saltati.
    const out = `
===ACTORS===

-
- Real :: ok :: true
===END ACTORS===
`;
    const b = parseBriefOutput(out) as ProjectBrief;
    expect(b.actors).toEqual([{ name: "Real", description: "ok", internal: true }]);
  });

  it("cap rispettati (glossario 40, facts 30, journeys 15, surfaces 12, actors 10)", () => {
    const glossary = Array.from({ length: 60 }, (_, i) => `- t${i} :: d${i}`).join("\n");
    const facts = Array.from({ length: 60 }, (_, i) => `- f${i} :: r :: s :: a`).join("\n");
    const journeys = Array.from({ length: 60 }, (_, i) => `- act :: j${i} :: s`).join("\n");
    const surfaces = Array.from(
      { length: 60 },
      (_, i) => `- s${i} :: web :: apps/p${i} :: aud :: false`,
    ).join("\n");
    const actors = Array.from({ length: 60 }, (_, i) => `- a${i} :: d :: false`).join("\n");
    const out = [
      "===GLOSSARY===", glossary, "===END GLOSSARY===",
      "===CONFIDENTIAL FACTS===", facts, "===END CONFIDENTIAL FACTS===",
      "===JOURNEYS===", journeys, "===END JOURNEYS===",
      "===SURFACES===", surfaces, "===END SURFACES===",
      "===ACTORS===", actors, "===END ACTORS===",
    ].join("\n");
    const b = parseBriefOutput(out) as ProjectBrief;
    expect(b.glossary).toHaveLength(40);
    expect(b.confidentialFacts).toHaveLength(30);
    expect(b.journeys).toHaveLength(15);
    expect(b.surfaces).toHaveLength(12);
    expect(b.actors).toHaveLength(10);
  });

  it("output tutto-prosa (nessun marcatore) → {reason}", () => {
    const res = parseBriefOutput("Just some prose, no markers at all.\nMore prose.");
    expect("reason" in res).toBe(true);
    expect((res as { reason: string }).reason).toBeTruthy();
  });

  it("stringa vuota → {reason}", () => {
    expect("reason" in parseBriefOutput("")).toBe(true);
  });
});

describe("briefPromptContext", () => {
  const brief: ProjectBrief = {
    identity: "Acme sells prepaid top-ups.",
    actors: [
      { name: "Reseller", description: "resells", internal: false },
      { name: "Operator", description: "staff", internal: true },
    ],
    surfaces: [],
    glossary: [
      { term: "Top-up", definition: "adding credit to a prepaid line" },
      { term: "Wallet", definition: "prepaid balance" },
    ],
    invariants: ["A top-up cannot exceed the wallet balance."],
    confidentialFacts: [
      { fact: "Markup is 18%", reason: "margin", source: "pricing.ts", avoid: "no percentage margins" },
    ],
    journeys: [],
    existingSources: [],
  };

  it("senza segreti di default: identità, attori, glossario, invarianti; NIENTE fatti", () => {
    const ctx = briefPromptContext(brief);
    expect(ctx).toContain("Identity: Acme sells prepaid top-ups.");
    expect(ctx).toContain("Reseller");
    expect(ctx).toContain("Operator (internal)");
    expect(ctx).toContain("Top-up: adding credit to a prepaid line");
    expect(ctx).toContain("A top-up cannot exceed the wallet balance.");
    // Nessun segreto trapelato.
    expect(ctx).not.toContain("Markup");
    expect(ctx).not.toContain("NEVER disclose");
  });

  it("con includeSecrets: aggiunge la sezione NEVER-disclose coi fatti + avoid", () => {
    const ctx = briefPromptContext(brief, { includeSecrets: true });
    expect(ctx).toContain("NEVER disclose");
    expect(ctx).toContain("Markup is 18%");
    expect(ctx).toContain("no percentage margins");
    expect(ctx).toMatch(/neither confirm nor deny/i);
  });

  it("glossario presente reso come `term: definition`", () => {
    const ctx = briefPromptContext(brief);
    expect(ctx).toContain("Wallet: prepaid balance");
  });

  it("tronca definizioni lunghe oltre 200 char", () => {
    const long = "x".repeat(500);
    const ctx = briefPromptContext({
      ...brief,
      glossary: [{ term: "Big", definition: long }],
    });
    const line = ctx.split("\n").find((l) => l.startsWith("- Big:")) ?? "";
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(230);
  });

  it("brief vuoto → solo l'intestazione, nessuna sezione", () => {
    const empty: ProjectBrief = {
      identity: "",
      actors: [],
      surfaces: [],
      glossary: [],
      invariants: [],
      confidentialFacts: [],
      journeys: [],
      existingSources: [],
    };
    const ctx = briefPromptContext(empty, { includeSecrets: true });
    expect(ctx).toContain("PROJECT CONTEXT");
    expect(ctx).not.toContain("Identity:");
    expect(ctx).not.toContain("Glossary");
    expect(ctx).not.toContain("NEVER disclose");
  });
});
