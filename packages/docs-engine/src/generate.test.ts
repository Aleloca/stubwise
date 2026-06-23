import { describe, expect, it, vi } from "vitest";
import {
  buildModulePrompt,
  buildReducePrompt,
  buildCapabilityPrompt,
  runGeneration,
  TECHNICAL_MARKER,
  FUNCTIONAL_MARKER,
  CAPABILITY_START_MARKER,
  CAPABILITY_END_MARKER,
  type AgentFn,
  type ModuleDoc,
} from "./generate.js";
import type { ModuleNode, RepoMap } from "./types.js";

function moduleNode(over: Partial<ModuleNode> = {}): ModuleNode {
  return {
    path: "packages/a",
    language: ".ts",
    files: ["packages/a/index.ts", "packages/a/util.ts"],
    manifest: "packages/a/package.json",
    publicSurface: ["foo", "bar"],
    dependsOn: ["packages/b"],
    score: 10,
    ...over,
  };
}

function repoMap(modules: ModuleNode[]): RepoMap {
  const languages: Record<string, number> = {};
  for (const m of modules) {
    for (const f of m.files) {
      const ext = f.slice(f.lastIndexOf("."));
      languages[ext] = (languages[ext] ?? 0) + 1;
    }
  }
  return { languages, modules, skipped: [] };
}

/** Marker substring unique to the capability deep-pass prompt. */
const CAPABILITY_PROMPT_HINT = "DEEP page of FUNCTIONAL documentation";

/**
 * A deep functional body long enough to pass the min-length acceptance gate. Per the
 * deep-pass contract it does NOT start with a `# <title>`/`## <title>` page heading
 * (the page title is rendered separately by the UI): it starts directly with `###`
 * sub-sections, independent of the capability title.
 */
function deepCapabilityBody(): string {
  return [
    "### What you can do here",
    "This is a thorough, plain-language description of everything possible in this",
    "block, with enough words to be a real deep page rather than a one-line summary.",
    "",
    "### Limits and constraints",
    "It also explains, in plain terms, what cannot be done and which rules apply.",
  ].join("\n");
}

/**
 * Wraps a deep capability body in the start/end markers of the deep-pass output
 * contract, the way a well-behaved agent must respond. Optional `preamble`/`closing`
 * simulate meta text the agent emits OUTSIDE the markers (which the parser must strip).
 */
function markeredCapability(
  body: string,
  opts: { preamble?: string; closing?: string } = {},
): string {
  return [
    ...(opts.preamble ? [opts.preamble] : []),
    CAPABILITY_START_MARKER,
    body,
    CAPABILITY_END_MARKER,
    ...(opts.closing ? [opts.closing] : []),
  ].join("\n");
}

/** Fake agent: returns canned, parseable structured text keyed by module path. */
function cannedAgent(): AgentFn {
  return vi.fn(async ({ prompt }) => {
    if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
      return markeredCapability(deepCapabilityBody());
    }
    if (prompt.includes("REDUCE")) {
      return [
        `${TECHNICAL_MARKER}`,
        "# Architecture Overview",
        "The system is composed of modules a and b.",
        `${FUNCTIONAL_MARKER}`,
        "# Capability Map",
        "## Capability: Authentication",
        "Lets users log in.",
        "## Capability: Reporting",
        "Generates reports.",
      ].join("\n");
    }
    // map response
    const pathMatch = /Module path:\s*(\S+)/.exec(prompt);
    const path = pathMatch?.[1] ?? "unknown";
    return [
      `${TECHNICAL_MARKER}`,
      `Technical docs for ${path}.`,
      `${FUNCTIONAL_MARKER}`,
      `Functional docs for ${path}.`,
    ].join("\n");
  });
}

describe("buildModulePrompt (M3.1)", () => {
  it("includes module path, files and the two section markers", () => {
    const m = moduleNode();
    const prompt = buildModulePrompt(m, repoMap([m]));
    expect(prompt).toContain("packages/a");
    expect(prompt).toContain("packages/a/index.ts");
    expect(prompt).toContain("packages/a/util.ts");
    expect(prompt).toContain(TECHNICAL_MARKER);
    expect(prompt).toContain(FUNCTIONAL_MARKER);
    // public surface and deps surfaced for context
    expect(prompt).toContain("foo");
    expect(prompt).toContain("packages/b");
  });
});

describe("buildReducePrompt (M3.1)", () => {
  it("instructs synthesis of technical overview + functional capability map", () => {
    const docs: ModuleDoc[] = [
      {
        modulePath: "packages/a",
        technicalMarkdown: "tech a",
        functionalMarkdown: "func a",
      },
    ];
    const prompt = buildReducePrompt(docs);
    expect(prompt).toContain("REDUCE");
    expect(prompt).toContain("packages/a");
    expect(prompt).toContain(TECHNICAL_MARKER);
    expect(prompt).toContain(FUNCTIONAL_MARKER);
    expect(prompt.toLowerCase()).toContain("architecture");
    expect(prompt.toLowerCase()).toContain("capabilit");
  });
});

describe("buildCapabilityPrompt (deep pass)", () => {
  it("forcefully demands plain language, exhaustive enumeration and code-grounding", () => {
    const docs: ModuleDoc[] = [
      {
        modulePath: "packages/a",
        technicalMarkdown: "tech a",
        functionalMarkdown: "func summary for a",
      },
    ];
    const prompt = buildCapabilityPrompt(
      { title: "Authentication", summary: "Lets users log in." },
      docs,
    );
    expect(prompt).toContain("Authentication");
    expect(prompt).toContain("Lets users log in.");
    // plain-language rule, forcefully stated
    const lower = prompt.toLowerCase();
    expect(lower).toContain("plain");
    expect(lower).toContain("non-technical");
    expect(lower).toMatch(/no file paths|file paths/);
    // exhaustive enumeration
    expect(lower).toContain("exhaustive");
    expect(lower).toMatch(/everything a user can do/);
    expect(lower).toContain("not possible");
    // code grounding (read-only inspection) but translate
    expect(lower).toContain("read-only");
    expect(lower).toContain("translate");
    // the page title is rendered separately by the UI: the body must NOT start with a
    // `# <title>`/`## <title>` page heading (it would duplicate the title). The prompt
    // explicitly tells the model not to, and never instructs a leading `# Authentication`.
    expect(prompt).not.toContain("# Authentication");
    expect(lower).toMatch(/do not start the page with a top-level page title/);
    // OUTPUT CONTRACT: the prompt must instruct the marker pair, forbid meta-summary
    // phrasing, files/plans and saving — exactly the failure modes seen in production.
    expect(prompt).toContain(CAPABILITY_START_MARKER);
    expect(prompt).toContain(CAPABILITY_END_MARKER);
    expect(lower).toContain("the plan file");
    expect(lower).toMatch(/the documentation page is/);
    expect(lower).toMatch(/let me know if/);
    expect(lower).toMatch(/i now have|here is the markdown/);
    expect(lower).toMatch(/outside the markers is ignored/);
    expect(lower).toMatch(/no preamble/);
    // module hints use a friendly LAST-SEGMENT label, not the full identifier-shaped
    // path, for orientation.
    expect(prompt).toContain("- a:");
    expect(prompt).not.toContain("packages/a");
  });

  it("truncates and caps module hints to keep the prompt bounded", () => {
    const docs: ModuleDoc[] = Array.from({ length: 100 }, (_, i) => ({
      modulePath: `packages/m${i}`,
      technicalMarkdown: "t",
      functionalMarkdown: "x".repeat(2000),
    }));
    const prompt = buildCapabilityPrompt({ title: "C", summary: "s" }, docs);
    // first module surfaces (friendly last-segment label), far-past-cap module does not
    expect(prompt).toContain("- m0:");
    expect(prompt).not.toContain("m99");
    // the 2000-char functional summary is truncated (no 700-long run of 'x')
    expect(prompt).not.toMatch(/x{700}/);
  });
});

describe("runGeneration (M3.2)", () => {
  it("maps each module + reduces once, wiring parentSlug and sourcePath", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"] });
    const b = moduleNode({
      path: "packages/b",
      files: ["packages/b/i.ts"],
      manifest: "packages/b/package.json",
      dependsOn: [],
    });
    const agent = cannedAgent();
    const onProgress = vi.fn();
    const { pages, moduleFailures, capabilityFailures, cappedCapabilities } =
      await runGeneration({
        repoMap: repoMap([a, b]),
        agent,
        onProgress,
      });

    // 2 map calls + 1 reduce call + 2 capability deep-pass calls (the reduce map
    // declares two `## Capability:` blocks).
    expect((agent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
    expect(moduleFailures).toEqual([]);
    expect(capabilityFailures).toEqual([]);
    expect(cappedCapabilities).toEqual([]);

    const technical = pages.filter((p) => p.kind === "technical");
    const functional = pages.filter((p) => p.kind === "functional");

    // overview (root) + one technical page per module
    const overview = technical.find((p) => p.parentSlug === null);
    expect(overview).toBeDefined();
    expect(overview!.sourcePath).toBeNull();

    const moduleTech = technical.filter((p) => p.parentSlug !== null);
    expect(moduleTech).toHaveLength(2);
    for (const p of moduleTech) {
      expect(p.parentSlug).toBe(overview!.slug);
      expect(p.sourcePath).not.toBeNull();
    }
    expect(moduleTech.map((p) => p.sourcePath).sort()).toEqual([
      "packages/a",
      "packages/b",
    ]);

    // at least one functional page produced from the capability map
    expect(functional.length).toBeGreaterThanOrEqual(1);

    // progress fired per module + reduce
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(3);

    // all slugs unique
    const slugs = pages.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("is best-effort: a throwing module is skipped and recorded, others succeed", async () => {
    const a = moduleNode({
      path: "packages/a",
      files: ["packages/a/i.ts"],
      dependsOn: [],
    });
    const b = moduleNode({
      path: "packages/b",
      files: ["packages/b/i.ts"],
      dependsOn: [],
    });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes("REDUCE")) {
        return `${TECHNICAL_MARKER}\noverview\n${FUNCTIONAL_MARKER}\n## Capability: X\nbody`;
      }
      if (/Module path:\s*packages\/b/.test(prompt)) {
        throw new Error("agent boom on b");
      }
      return `${TECHNICAL_MARKER}\ntech a\n${FUNCTIONAL_MARKER}\nfunc a`;
    });

    const { pages, moduleFailures } = await runGeneration({
      repoMap: repoMap([a, b]),
      agent,
    });

    expect(moduleFailures).toEqual(["packages/b"]);
    const techSources = pages
      .filter((p) => p.kind === "technical" && p.parentSlug !== null)
      .map((p) => p.sourcePath);
    expect(techSources).toEqual(["packages/a"]);
    // generation still produced an overview + functional pages
    expect(pages.some((p) => p.kind === "technical" && p.parentSlug === null)).toBe(
      true,
    );
  });

  it("is best-effort: a module with unparseable output is recorded as a failure", async () => {
    const a = moduleNode({
      path: "packages/a",
      files: ["packages/a/i.ts"],
      dependsOn: [],
    });
    const b = moduleNode({
      path: "packages/b",
      files: ["packages/b/i.ts"],
      dependsOn: [],
    });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes("REDUCE")) {
        return `${TECHNICAL_MARKER}\noverview\n${FUNCTIONAL_MARKER}\n## Capability: X\nbody`;
      }
      if (/Module path:\s*packages\/b/.test(prompt)) {
        return "garbage output with no markers at all";
      }
      return `${TECHNICAL_MARKER}\ntech a\n${FUNCTIONAL_MARKER}\nfunc a`;
    });

    const { pages, moduleFailures } = await runGeneration({
      repoMap: repoMap([a, b]),
      agent,
    });

    expect(moduleFailures).toEqual(["packages/b"]);
    const techSources = pages
      .filter((p) => p.kind === "technical" && p.parentSlug !== null)
      .map((p) => p.sourcePath);
    expect(techSources).toEqual(["packages/a"]);
  });

  it("derives distinct slugs when two module base slugs genuinely collide", async () => {
    // `a/core` and `a-core` both slugify to the same base `a-core`, so the second
    // page must get the `-2` suffix branch of makeUniqueSlug.
    const a = moduleNode({ path: "a/core", files: ["a/core/i.ts"], dependsOn: [] });
    const b = moduleNode({ path: "a-core", files: ["a-core/i.ts"], dependsOn: [] });
    const { pages } = await runGeneration({
      repoMap: repoMap([a, b]),
      agent: cannedAgent(),
    });
    const moduleSlugs = pages
      .filter((p) => p.kind === "technical" && p.parentSlug !== null)
      .map((p) => p.slug);
    expect(moduleSlugs).toHaveLength(2);
    expect(new Set(moduleSlugs).size).toBe(2);
    expect(moduleSlugs).toContain("a-core");
    expect(moduleSlugs).toContain("a-core-2");
  });

  it("suffixes a module slug that collides with a reserved root slug", async () => {
    // A module whose base slug equals the reserved `overview` root must be suffixed,
    // confirming the reserved-slug seeding of the `used` set works.
    const m = moduleNode({ path: "overview", files: ["overview/i.ts"], dependsOn: [] });
    const { pages } = await runGeneration({
      repoMap: repoMap([m]),
      agent: cannedAgent(),
    });
    const root = pages.find((p) => p.kind === "technical" && p.parentSlug === null);
    const moduleTech = pages.find(
      (p) => p.kind === "technical" && p.parentSlug !== null,
    );
    expect(root!.slug).toBe("overview");
    expect(moduleTech!.slug).toBe("overview-2");
  });

  it("derives the root module title from the first heading and removes it from the body", async () => {
    // The repo-root module has path "" → moduleTitle is empty (blank tree label). The
    // title must be taken from the body's first markdown heading and that heading line
    // removed from the body so it is not rendered twice.
    const root = moduleNode({ path: "", files: ["i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes("REDUCE")) {
        return `${TECHNICAL_MARKER}\noverview\n${FUNCTIONAL_MARKER}\n## Capability: X\nbody`;
      }
      // map response for the root module: technical body starts with a top-level H1.
      return [
        TECHNICAL_MARKER,
        "# Root Configuration",
        "Root-level wiring and entry points of the repository.",
        FUNCTIONAL_MARKER,
        "func",
      ].join("\n");
    });

    const { pages } = await runGeneration({ repoMap: repoMap([root]), agent });
    const moduleTech = pages.find(
      (p) => p.kind === "technical" && p.parentSlug !== null,
    );
    expect(moduleTech).toBeDefined();
    expect(moduleTech!.sourcePath).toBe("");
    expect(moduleTech!.title).toBe("Root Configuration");
    // the consumed heading no longer leads the body (no double heading).
    expect(moduleTech!.body.startsWith("# Root Configuration")).toBe(false);
    expect(moduleTech!.body).toContain("Root-level wiring and entry points");
  });

  it("falls back to 'Root' when the root module body has no leading heading", async () => {
    const root = moduleNode({ path: "", files: ["i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes("REDUCE")) {
        return `${TECHNICAL_MARKER}\noverview\n${FUNCTIONAL_MARKER}\n## Capability: X\nbody`;
      }
      return `${TECHNICAL_MARKER}\nNo heading here, just prose.\n${FUNCTIONAL_MARKER}\nfunc`;
    });
    const { pages } = await runGeneration({ repoMap: repoMap([root]), agent });
    const moduleTech = pages.find(
      (p) => p.kind === "technical" && p.parentSlug !== null,
    );
    expect(moduleTech!.title).toBe("Root");
    expect(moduleTech!.body).toBe("No heading here, just prose.");
  });
});

describe("runGeneration capability deep pass", () => {
  /** Reduce with exactly two `## Capability:` blocks. */
  function reduceWithTwoCaps(): string {
    return [
      TECHNICAL_MARKER,
      "overview",
      FUNCTIONAL_MARKER,
      "## Capability: Authentication",
      "Short summary: lets users log in.",
      "## Capability: Reporting",
      "Short summary: generates reports.",
    ].join("\n");
  }

  it("calls the agent once per module + once for reduce + once per capability, and the functional pages carry the DEEP bodies", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const b = moduleNode({ path: "packages/b", files: ["packages/b/i.ts"], dependsOn: [] });
    const agent = cannedAgent();
    const onProgress = vi.fn();
    const { pages, capabilityFailures, cappedCapabilities } = await runGeneration({
      repoMap: repoMap([a, b]),
      agent,
      onProgress,
    });

    // 2 map + 1 reduce + 2 capabilities
    expect((agent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
    expect(capabilityFailures).toEqual([]);
    expect(cappedCapabilities).toEqual([]);

    // capability pages (children of the capability map root) carry the DEEP output,
    // NOT the short index summary.
    const capRoot = pages.find((p) => p.kind === "functional" && p.parentSlug === null);
    expect(capRoot).toBeDefined();
    const capPages = pages.filter(
      (p) => p.kind === "functional" && p.parentSlug === capRoot!.slug,
    );
    expect(capPages.map((p) => p.title).sort()).toEqual(["Authentication", "Reporting"]);
    for (const p of capPages) {
      expect(p.sourcePath).toBeNull();
      expect(p.body).toContain("### What you can do here");
      expect(p.body).not.toContain("Short summary");
      // The body is the content BETWEEN the markers: the markers themselves must NOT
      // leak into the published page.
      expect(p.body).not.toContain(CAPABILITY_START_MARKER);
      expect(p.body).not.toContain(CAPABILITY_END_MARKER);
      // ...nor any meta-summary phrasing.
      expect(p.body.toLowerCase()).not.toContain("the documentation page is");
      expect(p.body.toLowerCase()).not.toContain("let me know if");
      // The page title is rendered separately by the UI: the deep body must NOT begin
      // with a markdown H1/H2 equal to the title (no double heading).
      const firstLine = p.body.split("\n")[0]!.trim();
      expect(firstLine).not.toBe(`# ${p.title}`);
      expect(firstLine).not.toBe(`## ${p.title}`);
    }

    // heartbeat fired for capabilities
    const progressMsgs = onProgress.mock.calls.map((c) => String(c[0]));
    expect(progressMsgs.some((m) => m.startsWith("capability 1/2"))).toBe(true);
    expect(progressMsgs.some((m) => m.includes("done"))).toBe(true);
  });

  it("is best-effort: a throwing capability falls back to the index summary and is recorded", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        if (/Capability title:\s*Reporting/.test(prompt)) {
          throw new Error("deep pass boom on Reporting");
        }
        return markeredCapability(deepCapabilityBody());
      }
      if (prompt.includes("REDUCE")) return reduceWithTwoCaps();
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, capabilityFailures } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
    });

    // recorded WITH the rejection reason (a thrown call counts as `no-markers`).
    expect(capabilityFailures).toEqual(["Reporting: no-markers"]);
    expect(capabilityFailures[0]).toMatch(/: (no-markers|too-short|meta-summary)$/);
    const reporting = pages.find((p) => p.title === "Reporting");
    expect(reporting).toBeDefined();
    // fallback body = index SUMMARY (the short description, WITHOUT the
    // `## Capability: Reporting` heading line — the title is rendered separately and an
    // included heading would duplicate it), not the deep body.
    expect(reporting!.body).toContain("generates reports");
    expect(reporting!.body).not.toContain("### What you can do here");
    // no duplicated page-title heading in the fallback body either.
    expect(reporting!.body).not.toMatch(/^#{1,2}\s+Reporting/);
    // the other capability still got its deep body; generation succeeded overall.
    const auth = pages.find((p) => p.title === "Authentication");
    expect(auth!.body).toContain("### What you can do here");
  });

  it("is best-effort: an empty/too-short capability output falls back and is recorded", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        if (/Capability title:\s*Reporting/.test(prompt)) return "   "; // too short
        return markeredCapability(deepCapabilityBody());
      }
      if (prompt.includes("REDUCE")) return reduceWithTwoCaps();
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, capabilityFailures } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
    });

    // "   " has no markers at all → rejected as `no-markers` (parse fails before the
    // length check), recorded with the reason suffix.
    expect(capabilityFailures).toEqual(["Reporting: no-markers"]);
    expect(capabilityFailures[0]).toMatch(/: (no-markers|too-short|meta-summary)$/);
    const reporting = pages.find((p) => p.title === "Reporting");
    expect(reporting!.body).toContain("generates reports");
    expect(reporting!.body).not.toContain("### What you can do here");
    // fallback summary carries no duplicated page-title heading.
    expect(reporting!.body).not.toMatch(/^#{1,2}\s+Reporting/);
  });

  it("records `too-short` when a markered body is below the min length", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        // Markered but the body between the markers is far below MIN_CAPABILITY_BODY_CHARS.
        if (/Capability title:\s*Reporting/.test(prompt)) {
          return markeredCapability("### Tiny\nshort");
        }
        return markeredCapability(deepCapabilityBody());
      }
      if (prompt.includes("REDUCE")) return reduceWithTwoCaps();
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, capabilityFailures } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
    });

    expect(capabilityFailures).toEqual(["Reporting: too-short"]);
    expect(capabilityFailures[0]).toMatch(/: (no-markers|too-short|meta-summary)$/);
    const reporting = pages.find((p) => p.title === "Reporting");
    expect(reporting!.body).toContain("generates reports");
  });

  it("does NOT reject a long legitimate page whose body merely CONTAINS meta-ish phrases mid-text", async () => {
    // Regression: the meta-summary check is anchored to the OPENING of the body, so a
    // real markered page that starts with a `###` heading must PASS even if it contains
    // "is complete and", "let me know if your build fails" and "the documentation page
    // for each module" mid-body. It must be used as-is and NOT recorded as a failure.
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const legitBody = [
      "### What you can do here",
      "This block lets you manage reports and exports across the whole workspace, with",
      "a thorough plain-language walkthrough of every action available to you here.",
      "",
      "### Saving and finishing",
      "Once your configuration is complete and saved, the workspace becomes active.",
      "If something breaks, let me know if your build fails so you can retry the run.",
      "",
      "### Per-module documentation",
      "The product can render the documentation page for each module independently,",
      "with plenty of additional plain-language detail to make this a real deep page.",
    ].join("\n");
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        if (/Capability title:\s*Reporting/.test(prompt)) {
          return markeredCapability(legitBody);
        }
        return markeredCapability(deepCapabilityBody());
      }
      if (prompt.includes("REDUCE")) return reduceWithTwoCaps();
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, capabilityFailures } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
    });

    // The legit page passed validation: NOT recorded, body used verbatim.
    expect(capabilityFailures).toEqual([]);
    const reporting = pages.find((p) => p.title === "Reporting");
    expect(reporting!.body).toBe(legitBody);
    // mid-text meta-ish phrases survive because they are not at the opening.
    expect(reporting!.body).toContain("is complete and");
    expect(reporting!.body).toContain("let me know if your build fails");
    expect(reporting!.body).toContain("the documentation page for each module");
    // it is NOT the fallback index summary.
    expect(reporting!.body).not.toContain("generates reports");
  });

  it("logs capabilities beyond maxCapabilities instead of dropping them silently", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        return markeredCapability(deepCapabilityBody());
      }
      if (prompt.includes("REDUCE")) {
        return [
          TECHNICAL_MARKER,
          "overview",
          FUNCTIONAL_MARKER,
          "## Capability: One",
          "first",
          "## Capability: Two",
          "second",
          "## Capability: Three",
          "third",
        ].join("\n");
      }
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, cappedCapabilities } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
      limits: { maxCapabilities: 1 },
    });

    // 1 map + 1 reduce + 1 capability deep call (only the first, within budget).
    expect((agent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    // exactly one deep capability page produced...
    const capRoot = pages.find((p) => p.kind === "functional" && p.parentSlug === null);
    const capPages = pages.filter(
      (p) => p.kind === "functional" && p.parentSlug === capRoot!.slug,
    );
    expect(capPages.map((p) => p.title)).toEqual(["One"]);
    // ...and the other two are surfaced (logged), not silently dropped.
    expect(cappedCapabilities).toEqual(["Two", "Three"]);
  });

  it("strips a preamble before the start marker: body is only the content between the markers", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        // The agent emits a meta preamble BEFORE the start marker (and a closing AFTER
        // the end marker). Both are outside the markers and must be stripped: only the
        // delimited content is published.
        return markeredCapability(deepCapabilityBody(), {
          preamble:
            "I now have a thorough understanding of the code. Here is the complete markdown body. ---",
          closing: "Let me know if you'd like adjustments.",
        });
      }
      if (prompt.includes("REDUCE")) return reduceWithTwoCaps();
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, capabilityFailures } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
    });

    expect(capabilityFailures).toEqual([]);
    const auth = pages.find((p) => p.title === "Authentication");
    expect(auth!.body).toBe(deepCapabilityBody());
    // preamble/closing meta text stripped; markers stripped.
    expect(auth!.body).not.toContain("I now have a thorough");
    expect(auth!.body).not.toContain("Let me know if");
    expect(auth!.body).not.toContain(CAPABILITY_START_MARKER);
    expect(auth!.body).not.toContain(CAPABILITY_END_MARKER);
  });

  it("retries once, then falls back to the index summary when both attempts are meta-summaries", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const onProgress = vi.fn();
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        if (/Capability title:\s*Reporting/.test(prompt)) {
          // First a markered body whose content is itself a meta-summary (must be
          // rejected despite being inside the markers); on the retry, raw meta with no
          // markers at all. Both invalid → fallback.
          return markeredCapability(
            "The documentation page is written and saved to the plan file. It covers everything.",
          );
        }
        return markeredCapability(deepCapabilityBody());
      }
      if (prompt.includes("REDUCE")) return reduceWithTwoCaps();
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, capabilityFailures } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
      onProgress,
    });

    // Reporting was retried (one extra call) and still bad → fallback + recorded WITH
    // the reason. Both attempts open with a genuine meta-summary → `meta-summary`.
    expect(capabilityFailures).toEqual(["Reporting: meta-summary"]);
    expect(capabilityFailures[0]).toMatch(/: (no-markers|too-short|meta-summary)$/);
    const reporting = pages.find((p) => p.title === "Reporting");
    expect(reporting!.body).toContain("generates reports");
    expect(reporting!.body).not.toContain("saved to the plan file");
    expect(reporting!.body).not.toContain(CAPABILITY_START_MARKER);
    // calls: 1 map + 1 reduce + Authentication(1) + Reporting(2 = attempt + retry) = 5
    expect((agent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
    // heartbeat fired for the retry too.
    const msgs = onProgress.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("Reporting") && m.includes("retry"))).toBe(true);
    // the rejection reason is logged for auditability (per attempt).
    expect(
      msgs.some((m) => m.includes('"Reporting" rejected: meta-summary')),
    ).toBe(true);
  });

  it("uses the retry's content when the first attempt is invalid but the second is valid (not recorded as failure)", async () => {
    const a = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const reportingCalls = { n: 0 };
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes(CAPABILITY_PROMPT_HINT)) {
        if (/Capability title:\s*Reporting/.test(prompt)) {
          reportingCalls.n += 1;
          // First attempt: invalid (no markers). Second attempt: valid markered body.
          if (reportingCalls.n === 1) return "no markers here, just a stray line";
          return markeredCapability(deepCapabilityBody());
        }
        return markeredCapability(deepCapabilityBody());
      }
      if (prompt.includes("REDUCE")) return reduceWithTwoCaps();
      return `${TECHNICAL_MARKER}\ntech\n${FUNCTIONAL_MARKER}\nfunc`;
    });

    const { pages, capabilityFailures } = await runGeneration({
      repoMap: repoMap([a]),
      agent,
    });

    expect(reportingCalls.n).toBe(2); // first invalid, second valid
    expect(capabilityFailures).toEqual([]); // retry succeeded → not a failure
    const reporting = pages.find((p) => p.title === "Reporting");
    expect(reporting!.body).toContain("### What you can do here");
    expect(reporting!.body).not.toContain("generates reports"); // not the fallback summary
  });
});

describe("parseSections via runGeneration (M3, marker per-riga)", () => {
  /** Runs a single module whose map output is fully controlled. */
  async function mapOutput(out: string) {
    const m = moduleNode({ path: "packages/a", files: ["packages/a/i.ts"], dependsOn: [] });
    const agent: AgentFn = vi.fn(async ({ prompt }) => {
      if (prompt.includes("REDUCE")) {
        return `${TECHNICAL_MARKER}\noverview\n${FUNCTIONAL_MARKER}\n## Capability: X\nbody`;
      }
      return out;
    });
    return runGeneration({ repoMap: repoMap([m]), agent });
  }

  it("ignores a marker that is not alone on its line and parses the real sections", async () => {
    // The literal TECHNICAL_MARKER appears inside a fenced code block but NOT alone
    // on its line (e.g. quoted as documentation source, like generate.ts itself does)
    // BEFORE the real marker line. Only the full-line marker is a delimiter, so the
    // parser must use the real one, not the fenced occurrence.
    const out = [
      "```ts",
      `const TECHNICAL_MARKER = "${TECHNICAL_MARKER}"; // not a delimiter`,
      "```",
      TECHNICAL_MARKER, // the REAL technical marker line (alone on its own line)
      "REAL technical body",
      FUNCTIONAL_MARKER,
      "REAL functional body",
    ].join("\n");
    const { pages, moduleFailures } = await mapOutput(out);
    expect(moduleFailures).toEqual([]);
    const tech = pages.find(
      (p) => p.kind === "technical" && p.sourcePath === "packages/a",
    );
    expect(tech).toBeDefined();
    // technical section is exactly the text between the REAL full-line markers.
    expect(tech!.body).toBe("REAL technical body");
    expect(tech!.body).not.toContain("not a delimiter");
  });

  it("does not treat a marker embedded mid-line as a delimiter", async () => {
    // `prefix===TECHNICAL===` is not a marker line → no valid technical marker →
    // the whole output is unparseable → module recorded as a failure.
    const out = [
      `prefix${TECHNICAL_MARKER}`,
      "body that is not a real technical section",
      FUNCTIONAL_MARKER,
      "functional body",
    ].join("\n");
    const { moduleFailures } = await mapOutput(out);
    expect(moduleFailures).toEqual(["packages/a"]);
  });

  it("treats out-of-order markers (functional before technical) as unparseable", async () => {
    const out = [
      FUNCTIONAL_MARKER,
      "functional first",
      TECHNICAL_MARKER,
      "technical second",
    ].join("\n");
    const { moduleFailures } = await mapOutput(out);
    expect(moduleFailures).toEqual(["packages/a"]);
  });
});
