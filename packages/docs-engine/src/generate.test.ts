import { describe, expect, it, vi } from "vitest";
import {
  buildModulePrompt,
  buildReducePrompt,
  runGeneration,
  TECHNICAL_MARKER,
  FUNCTIONAL_MARKER,
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

/** Fake agent: returns canned, parseable structured text keyed by module path. */
function cannedAgent(): AgentFn {
  return vi.fn(async ({ prompt }) => {
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
    const { pages, moduleFailures } = await runGeneration({
      repoMap: repoMap([a, b]),
      agent,
      onProgress,
    });

    // 2 map calls + 1 reduce call
    expect((agent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(moduleFailures).toEqual([]);

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

  it("derives stable, unique slugs even on colliding module basenames", async () => {
    const a = moduleNode({ path: "packages/a/core", files: ["packages/a/core/i.ts"] });
    const b = moduleNode({ path: "packages/b/core", files: ["packages/b/core/i.ts"] });
    const { pages } = await runGeneration({
      repoMap: repoMap([a, b]),
      agent: cannedAgent(),
    });
    const slugs = pages.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
