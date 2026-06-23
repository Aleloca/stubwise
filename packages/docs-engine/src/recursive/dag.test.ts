import { describe, expect, it } from "vitest";
import type { ChildSpec } from "./contract.js";
import {
  cosineSimilarity,
  dedupeChildren,
  pathCovers,
  resolveImplementsLinks,
  selectRelatedLinks,
  slugForNode,
  type LinkableNode,
  type RelatedCandidate,
} from "./dag.js";

/** Typed child-list literal helper so excess `title` is allowed by inference. */
function specs(list: ChildSpec[]): ChildSpec[] {
  return list;
}

describe("pathCovers", () => {
  it("treats equal paths as covered", () => {
    expect(pathCovers("apps/web", "apps/web")).toBe(true);
  });

  it("covers a nested child path (segment boundary)", () => {
    expect(pathCovers("apps/web", "apps/web/src/main.ts")).toBe(true);
  });

  it("does NOT cover a sibling sharing a string prefix but not a segment", () => {
    expect(pathCovers("apps/web", "apps/website")).toBe(false);
  });

  it("does not cover upward (child does not cover ancestor)", () => {
    expect(pathCovers("apps/web/src/main.ts", "apps/web")).toBe(false);
  });

  it("normalizes trailing/leading slashes", () => {
    expect(pathCovers("apps/web/", "/apps/web/src")).toBe(true);
  });

  it("empty paths cover nothing", () => {
    expect(pathCovers("", "apps/web")).toBe(false);
    expect(pathCovers("apps/web", "")).toBe(false);
  });
});

describe("dedupeChildren", () => {
  it("drops a child whose path equals an ancestor path (anti-cycle)", () => {
    const { kept, dropped } = dedupeChildren(
      [{ title: "Web", sourcePaths: ["apps/web"] }],
      ["apps/web"],
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("drops a child nested under an ancestor path", () => {
    const { kept, dropped } = dedupeChildren(
      [{ title: "Routes", sourcePaths: ["apps/web/src/routes"] }],
      ["apps/web"],
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("keeps a child not covered by any ancestor", () => {
    const { kept, dropped } = dedupeChildren(
      [{ title: "Server", sourcePaths: ["apps/server"] }],
      ["apps/web"],
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("dedupes siblings with the same path, keeping the first", () => {
    const { kept, dropped } = dedupeChildren(
      specs([
        { title: "First", sourcePaths: ["apps/api"] },
        { title: "Second", sourcePaths: ["apps/api"] },
      ]),
      [],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.title).toBe("First");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.title).toBe("Second");
  });

  it("drops a sibling nested under an earlier sibling's path", () => {
    const { kept, dropped } = dedupeChildren(
      specs([
        { title: "Pkg", sourcePaths: ["packages/core"] },
        { title: "Sub", sourcePaths: ["packages/core/src/util.ts"] },
      ]),
      [],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.title).toBe("Pkg");
    expect(dropped).toHaveLength(1);
  });

  it("uses unitRef when sourcePaths is absent", () => {
    const { kept, dropped } = dedupeChildren(
      [{ title: "Web", unitRef: "apps/web" }],
      ["apps/web"],
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("always keeps a child with no paths at all", () => {
    const { kept } = dedupeChildren(specs([{ title: "Concept" }]), ["apps/web"]);
    expect(kept).toHaveLength(1);
  });

  it("does not mutate inputs", () => {
    const children = [{ title: "A", sourcePaths: ["x"] }];
    const ancestors = ["y"];
    dedupeChildren(children, ancestors);
    expect(children).toHaveLength(1);
    expect(ancestors).toEqual(["y"]);
  });
});

describe("slugForNode", () => {
  it("produces a kebab slug from the title", () => {
    const used = new Set<string>();
    expect(slugForNode("Documentation Generation", used)).toBe(
      "documentation-generation",
    );
  });

  it("suffixes on collision", () => {
    const used = new Set<string>();
    expect(slugForNode("Worker", used)).toBe("worker");
    expect(slugForNode("Worker", used)).toBe("worker-2");
    expect(slugForNode("Worker", used)).toBe("worker-3");
  });

  it("is stable for the same title given the same used set state", () => {
    const a = new Set<string>();
    const b = new Set<string>();
    expect(slugForNode("My Page", a)).toBe(slugForNode("My Page", b));
  });

  it("tracks emitted slugs in used", () => {
    const used = new Set<string>();
    slugForNode("Search", used);
    expect(used.has("search")).toBe(true);
  });
});

describe("resolveImplementsLinks", () => {
  const tech = (
    id: string,
    paths: string[],
    title = id,
  ): LinkableNode => ({
    id,
    tree: "technical",
    slug: id,
    title,
    sourcePaths: paths,
  });
  const func = (
    id: string,
    paths: string[],
    title = id,
  ): LinkableNode => ({
    id,
    tree: "functional",
    slug: id,
    title,
    sourcePaths: paths,
  });

  it("links a functional node to a technical node sharing a path, bidirectionally", () => {
    const links = resolveImplementsLinks([
      tech("t1", ["apps/worker"], "Worker"),
      func("f1", ["apps/worker/src/docs"], "Docs generation"),
    ]);
    expect(links.get("f1")).toEqual([
      { type: "implements", slug: "t1", title: "Worker" },
    ]);
    expect(links.get("t1")).toEqual([
      { type: "implemented_by", slug: "f1", title: "Docs generation" },
    ]);
  });

  it("produces no links when paths do not overlap", () => {
    const links = resolveImplementsLinks([
      tech("t1", ["apps/worker"]),
      func("f1", ["apps/server"]),
    ]);
    expect(links.get("f1")).toBeUndefined();
    expect(links.get("t1")).toBeUndefined();
  });

  it("links a functional node to multiple covering technical nodes", () => {
    const links = resolveImplementsLinks([
      tech("t1", ["apps/worker"], "Worker"),
      tech("t2", ["packages/docs-engine"], "Docs engine"),
      func("f1", ["apps/worker/src/docs", "packages/docs-engine/src"], "Docs"),
    ]);
    expect(links.get("f1")).toEqual([
      { type: "implements", slug: "t1", title: "Worker" },
      { type: "implements", slug: "t2", title: "Docs engine" },
    ]);
  });

  it("dedupes links when multiple functional paths hit the same technical node", () => {
    const links = resolveImplementsLinks([
      tech("t1", ["apps/worker"], "Worker"),
      func("f1", ["apps/worker/src/a.ts", "apps/worker/src/b.ts"], "Cap"),
    ]);
    expect(links.get("f1")).toEqual([
      { type: "implements", slug: "t1", title: "Worker" },
    ]);
    expect(links.get("t1")).toEqual([
      { type: "implemented_by", slug: "f1", title: "Cap" },
    ]);
  });

  it("does not link technical-to-technical or functional-to-functional", () => {
    const links = resolveImplementsLinks([
      tech("t1", ["apps/worker"]),
      tech("t2", ["apps/worker/src"]),
      func("f1", ["apps/x"]),
      func("f2", ["apps/x/y"]),
    ]);
    expect(links.size).toBe(0);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical direction", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 for mismatched lengths or zero vectors", () => {
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("selectRelatedLinks", () => {
  const cand = (id: string, vector: number[]): RelatedCandidate => ({
    id,
    vector,
    slug: id,
    title: id,
  });

  it("returns the top-K most similar candidates", () => {
    const target = { id: "self", vector: [1, 0] };
    const candidates = [
      cand("near", [0.9, 0.1]),
      cand("mid", [0.5, 0.5]),
      cand("far", [0, 1]),
    ];
    const links = selectRelatedLinks(target, candidates, {
      k: 2,
      exclude: new Set(),
    });
    expect(links.map((l) => l.slug)).toEqual(["near", "mid"]);
    expect(links.every((l) => l.type === "related")).toBe(true);
  });

  it("respects the exclude set (and self)", () => {
    const target = { id: "self", vector: [1, 0] };
    const candidates = [
      cand("self", [1, 0]),
      cand("excluded", [0.99, 0.01]),
      cand("ok", [0.8, 0.2]),
    ];
    const links = selectRelatedLinks(target, candidates, {
      k: 5,
      exclude: new Set(["excluded"]),
    });
    expect(links.map((l) => l.slug)).toEqual(["ok"]);
  });

  it("handles fewer than K candidates", () => {
    const target = { id: "self", vector: [1, 0] };
    const links = selectRelatedLinks(target, [cand("only", [1, 0])], {
      k: 3,
      exclude: new Set(),
    });
    expect(links).toHaveLength(1);
  });

  it("returns nothing for k <= 0", () => {
    const target = { id: "self", vector: [1, 0] };
    const links = selectRelatedLinks(target, [cand("a", [1, 0])], {
      k: 0,
      exclude: new Set(),
    });
    expect(links).toHaveLength(0);
  });

  it("breaks similarity ties by input order (stable)", () => {
    const target = { id: "self", vector: [1, 0] };
    const candidates = [cand("a", [1, 0]), cand("b", [1, 0])];
    const links = selectRelatedLinks(target, candidates, {
      k: 1,
      exclude: new Set(),
    });
    expect(links[0]?.slug).toBe("a");
  });

  it("accepts an injected similarity function", () => {
    const target = { id: "self", vector: [1] };
    const candidates = [cand("a", [1]), cand("b", [2]), cand("c", [3])];
    // injected: similarity = the candidate's single component → c > b > a
    const links = selectRelatedLinks(
      target,
      candidates,
      { k: 2, exclude: new Set() },
      (_a, b) => b[0] ?? 0,
    );
    expect(links.map((l) => l.slug)).toEqual(["c", "b"]);
  });
});
