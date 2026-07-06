import { describe, expect, it } from "vitest";
import {
  aggregateNewAreas,
  buildGrowOrientPrompt,
  GROW_PROPOSAL_START_MARKER,
  GROW_PROPOSAL_END_MARKER,
  parseGrowOrientOutput,
  type NewArea,
} from "./grow.js";

describe("aggregateNewAreas", () => {
  it("lista vuota → []", () => {
    expect(aggregateNewAreas([])).toEqual([]);
  });

  it("accorpa 30 file sotto admin-app/src/** in un'unica area admin-app/src", () => {
    const files: string[] = [];
    const subdirs = ["billing", "users", "reports", "settings", "auth", "dashboard"];
    for (const d of subdirs) {
      for (let i = 0; i < 5; i++) files.push(`admin-app/src/${d}/file${i}.ts`);
    }
    expect(files).toHaveLength(30);
    const areas = aggregateNewAreas(files);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("admin-app/src");
    const files0 = areas[0]?.files ?? [];
    expect(files0).toHaveLength(30);
    // ordinamento lessicografico dei file
    expect(files0).toEqual([...files0].sort());
  });

  it("file isolato in cartella profonda risale finché la profondità è ≤ maxDepth", () => {
    // admin-app/src/billing/invoice.ts: 1 file, depth cartella = 3 > 2 → risale a
    // admin-app/src (depth 2, stop). Un solo file isolato → area = admin-app/src.
    const areas = aggregateNewAreas(["admin-app/src/billing/invoice.ts"]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("admin-app/src");
    expect(areas[0]?.files).toEqual(["admin-app/src/billing/invoice.ts"]);
  });

  it("file isolato in cartella già a profondità ≤ maxDepth resta lì", () => {
    // src/lib/util.ts: cartella src/lib depth 2 (non > maxDepth 2) → non risale.
    const areas = aggregateNewAreas(["src/lib/util.ts"]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("src/lib");
    expect(areas[0]?.files).toEqual(["src/lib/util.ts"]);
  });

  it("file nella radice del repo → area col path del file", () => {
    const areas = aggregateNewAreas(["README.md"]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("README.md");
    expect(areas[0]?.files).toEqual(["README.md"]);
  });

  it("due gruppi distinti → due aree disgiunte, ordinate lessicograficamente", () => {
    const areas = aggregateNewAreas([
      "app-b/src/x/a.ts",
      "app-b/src/y/b.ts",
      "app-a/src/x/a.ts",
      "app-a/src/y/b.ts",
    ]);
    expect(areas).toHaveLength(2);
    expect(areas.map((a) => a.path)).toEqual(["app-a/src", "app-b/src"]);
  });

  it("normalizza slash iniziali/finali e ripetuti", () => {
    const areas = aggregateNewAreas(["/admin-app//src/billing/a.ts", "admin-app/src/users/b.ts"]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("admin-app/src");
    expect(areas[0]?.files).toEqual([
      "admin-app/src/billing/a.ts",
      "admin-app/src/users/b.ts",
    ]);
  });

  it("una cartella più profonda di maxDepth tronca a maxDepth segmenti", () => {
    // 3 file in admin-app/src/billing (depth 3 > maxDepth 2) → area troncata a
    // admin-app/src.
    const areas = aggregateNewAreas([
      "admin-app/src/billing/a.ts",
      "admin-app/src/billing/b.ts",
      "admin-app/src/billing/c.ts",
    ]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("admin-app/src");
    expect(areas[0]?.files).toHaveLength(3);
  });

  it("aree annidate risultanti vengono fuse (nessuna area contenuta in un'altra)", () => {
    // src/lib (depth 2, resta) e src/lib/deep (depth 3 → tronca a src/lib): stesso path,
    // una sola area src/lib; nessuna area contenuta in un'altra.
    const areas = aggregateNewAreas([
      "src/lib/a.ts",
      "src/lib/deep/b.ts",
    ]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("src/lib");
    const files0 = areas[0]?.files ?? [];
    expect(files0).toHaveLength(2);
    expect(files0).toEqual([...files0].sort());
  });

  it("aree sorelle piccole (< minGroup) sotto lo stesso genitore vengono fuse nel genitore", () => {
    // a/x/one.ts e a/y/one.ts: due sorelle da 1 file (< minGroup 2) sotto `a` → fuse in `a`.
    const areas = aggregateNewAreas(["a/x/one.ts", "a/y/one.ts"]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("a");
    expect(areas[0]?.files).toEqual(["a/x/one.ts", "a/y/one.ts"]);
  });

  it("deduplica i file identici", () => {
    const areas = aggregateNewAreas([
      "src/lib/a.ts",
      "src/lib/a.ts",
      "src/lib/b.ts",
    ]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.files).toEqual(["src/lib/a.ts", "src/lib/b.ts"]);
  });

  it("rispetta opts.minGroup e opts.maxDepth custom", () => {
    // maxDepth 1: src/lib (depth 2 > 1) con 1 file risale a src (depth 1, stop).
    const areas = aggregateNewAreas(["src/lib/util.ts"], { maxDepth: 1 });
    expect(areas).toHaveLength(1);
    expect(areas[0]?.path).toBe("src");
  });
});

describe("buildGrowOrientPrompt", () => {
  const areas: NewArea[] = [
    { path: "admin-app/src", files: ["admin-app/src/billing/a.ts", "admin-app/src/users/b.ts"] },
  ];

  it("elenca aree con i loro file, pagine esistenti, commit e il tetto", () => {
    const prompt = buildGrowOrientPrompt({
      areas,
      existingPages: [{ slug: "overview", title: "Overview", kind: "functional" }],
      maxPages: 3,
      commitSubjects: ["feat: admin app"],
    });
    expect(prompt).toContain("admin-app/src");
    expect(prompt).toContain("admin-app/src/billing/a.ts");
    expect(prompt).toContain("overview :: Overview :: functional");
    expect(prompt).toContain("feat: admin app");
    expect(prompt).toContain("3");
    expect(prompt).toContain(GROW_PROPOSAL_START_MARKER);
    expect(prompt).toContain(GROW_PROPOSAL_END_MARKER);
  });

  it("gestisce liste vuote senza rompersi", () => {
    const prompt = buildGrowOrientPrompt({
      areas: [],
      existingPages: [],
      maxPages: 5,
      commitSubjects: [],
    });
    expect(prompt).toContain("(no new areas)");
    expect(prompt).toContain("(no existing pages)");
    expect(prompt).toContain("(no commit subjects)");
  });

  it("limita il numero di file elencati per area (tetto ~50)", () => {
    const many: NewArea[] = [
      { path: "big", files: Array.from({ length: 120 }, (_, i) => `big/f${i}.ts`) },
    ];
    const prompt = buildGrowOrientPrompt({
      areas: many,
      existingPages: [],
      maxPages: 5,
      commitSubjects: [],
    });
    expect(prompt).toContain("big/f0.ts");
    expect(prompt).not.toContain("big/f119.ts");
  });
});

describe("parseGrowOrientOutput", () => {
  function proposal(opts: {
    title?: string;
    kind?: string;
    parent?: string;
    paths?: string;
  }): string {
    const lines = [GROW_PROPOSAL_START_MARKER];
    if (opts.title !== undefined) lines.push(`title: ${opts.title}`);
    if (opts.kind !== undefined) lines.push(`kind: ${opts.kind}`);
    if (opts.parent !== undefined) lines.push(`parent: ${opts.parent}`);
    if (opts.paths !== undefined) lines.push(`paths: ${opts.paths}`);
    lines.push(GROW_PROPOSAL_END_MARKER);
    return lines.join("\n");
  }

  it("parsa più proposte valide", () => {
    const out = [
      proposal({ title: "Billing", kind: "functional", parent: "overview", paths: "admin-app/src/billing" }),
      proposal({ title: "Auth Module", kind: "technical", parent: "", paths: "admin-app/src/auth, admin-app/src/session" }),
    ].join("\n\n");
    const proposals = parseGrowOrientOutput(out);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toEqual({
      title: "Billing",
      kind: "functional",
      parentSlug: "overview",
      sourcePaths: ["admin-app/src/billing"],
    });
    expect(proposals[1]).toEqual({
      title: "Auth Module",
      kind: "technical",
      parentSlug: null,
      sourcePaths: ["admin-app/src/auth", "admin-app/src/session"],
    });
  });

  it("parent vuoto/mancante → null", () => {
    const out = proposal({ title: "X", kind: "technical", paths: "src/x" });
    expect(parseGrowOrientOutput(out)[0]?.parentSlug).toBeNull();
  });

  it("output vuoto → []", () => {
    expect(parseGrowOrientOutput("")).toEqual([]);
    expect(parseGrowOrientOutput("prosa libera")).toEqual([]);
  });

  it("proposta senza title → scartata", () => {
    const out = proposal({ kind: "technical", paths: "src/x" });
    expect(parseGrowOrientOutput(out)).toEqual([]);
  });

  it("kind invalido → proposta scartata", () => {
    const out = proposal({ title: "X", kind: "weird", paths: "src/x" });
    expect(parseGrowOrientOutput(out)).toEqual([]);
  });

  it("kind mancante → proposta scartata", () => {
    const out = proposal({ title: "X", paths: "src/x" });
    expect(parseGrowOrientOutput(out)).toEqual([]);
  });

  it("una proposta buona + una rotta → solo la buona", () => {
    const out = [
      proposal({ title: "Good", kind: "functional", paths: "src/good" }),
      proposal({ kind: "technical", paths: "src/bad" }), // senza title
    ].join("\n\n");
    const proposals = parseGrowOrientOutput(out);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.title).toBe("Good");
  });

  it("normalizza i paths (trim, senza slash iniziali/finali), scarta i vuoti", () => {
    const out = proposal({
      title: "X",
      kind: "technical",
      paths: "  /src/a/ ,  src/b ,, /src/c",
    });
    expect(parseGrowOrientOutput(out)[0]?.sourcePaths).toEqual(["src/a", "src/b", "src/c"]);
  });

  it("proposta senza paths → sourcePaths vuoto (non scartata)", () => {
    const out = proposal({ title: "X", kind: "technical" });
    const proposals = parseGrowOrientOutput(out);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.sourcePaths).toEqual([]);
  });

  it("kind case-insensitive e con spazi extra", () => {
    const out = proposal({ title: "X", kind: "  Functional  ", paths: "src/x" });
    expect(parseGrowOrientOutput(out)[0]?.kind).toBe("functional");
  });

  it("non lancia mai su marcatori annidati/spezzati", () => {
    const weird = [
      GROW_PROPOSAL_START_MARKER,
      "title: X",
      GROW_PROPOSAL_START_MARKER, // annidato/spezzato
      "kind: technical",
      GROW_PROPOSAL_END_MARKER,
    ].join("\n");
    expect(() => parseGrowOrientOutput(weird)).not.toThrow();
  });

  it("tronca difensivamente a un cap alto (20)", () => {
    const out = Array.from({ length: 25 }, (_, i) =>
      proposal({ title: `P${i}`, kind: "technical", paths: `src/p${i}` }),
    ).join("\n\n");
    expect(parseGrowOrientOutput(out)).toHaveLength(20);
  });
});
