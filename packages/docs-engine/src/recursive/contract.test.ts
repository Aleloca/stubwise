import { describe, expect, it } from "vitest";
import {
  CHILD_FIELD_SEP,
  EXPLORE_BODY_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  extractBlock,
  parseChildBlock,
  parseChildList,
  parsePathList,
  validateBody,
} from "./contract.js";

/** Builds a well-formed child-list line in the documented `title :: ref :: why` format. */
function childLine(title: string, ref: string, why: string): string {
  return `- ${title}${CHILD_FIELD_SEP}${ref}${CHILD_FIELD_SEP}${why}`;
}

describe("parseChildList", () => {
  it("parses well-formed lines into title/unitRef/sourcePaths/why", () => {
    const body = [
      childLine("Queue", "apps/worker/src/queue.ts", "core loop"),
      childLine("Mirrors", "apps/worker/src/git/mirrors.ts", "git mirrors"),
    ].join("\n");
    const { children, malformed } = parseChildList(body);
    expect(malformed).toBe(0);
    expect(children).toEqual([
      {
        title: "Queue",
        unitRef: "apps/worker/src/queue.ts",
        sourcePaths: ["apps/worker/src/queue.ts"],
        why: "core loop",
      },
      {
        title: "Mirrors",
        unitRef: "apps/worker/src/git/mirrors.ts",
        sourcePaths: ["apps/worker/src/git/mirrors.ts"],
        why: "git mirrors",
      },
    ]);
  });

  it("parses multiple comma-separated source paths for a functional capability", () => {
    const body = childLine(
      "Login",
      "apps/server/src/auth.ts, apps/web/src/login.tsx",
      "lets users sign in",
    );
    const { children } = parseChildList(body);
    expect(children[0]!.sourcePaths).toEqual([
      "apps/server/src/auth.ts",
      "apps/web/src/login.tsx",
    ]);
    // unitRef is the first path (handy for single-ref technical nodes).
    expect(children[0]!.unitRef).toBe("apps/server/src/auth.ts");
  });

  it("tolerates a missing why and a missing ref", () => {
    const body = ["- Title only", `Just a title${CHILD_FIELD_SEP}some/path`].join(
      "\n",
    );
    const { children, malformed } = parseChildList(body);
    expect(malformed).toBe(0);
    expect(children[0]).toEqual({ title: "Title only" });
    expect(children[1]).toEqual({
      title: "Just a title",
      unitRef: "some/path",
      sourcePaths: ["some/path"],
    });
  });

  it("skips blank lines and counts malformed (title-less) lines", () => {
    const body = [
      "",
      childLine("Good", "p", "w"),
      "*", // bare bullet → empty title after strip
      "   ",
      "- ", // bullet with nothing after it → empty title
    ].join("\n");
    const { children, malformed } = parseChildList(body);
    expect(children).toHaveLength(1);
    expect(children[0]!.title).toBe("Good");
    expect(malformed).toBe(2);
  });
});

describe("parseChildBlock", () => {
  it("extracts and parses a delimited child-list, stripping preamble/closing", () => {
    const output = [
      "Here are the children I found:",
      EXPLORE_CHILDREN_START_MARKER,
      childLine("A", "a/x.ts", "why a"),
      childLine("B", "b/y.ts", "why b"),
      EXPLORE_CHILDREN_END_MARKER,
      "That's all, let me know if you need more.",
    ].join("\n");
    const res = parseChildBlock(
      output,
      EXPLORE_CHILDREN_START_MARKER,
      EXPLORE_CHILDREN_END_MARKER,
    );
    expect(res).not.toBeNull();
    expect(res!.children.map((c) => c.title)).toEqual(["A", "B"]);
    expect(res!.malformed).toBe(0);
  });

  it("returns null when the block markers are missing", () => {
    expect(
      parseChildBlock(
        "no markers at all",
        EXPLORE_CHILDREN_START_MARKER,
        EXPLORE_CHILDREN_END_MARKER,
      ),
    ).toBeNull();
  });

  it("distinguishes an empty (present) block from a missing one", () => {
    const output = [
      EXPLORE_CHILDREN_START_MARKER,
      "",
      EXPLORE_CHILDREN_END_MARKER,
    ].join("\n");
    const res = parseChildBlock(
      output,
      EXPLORE_CHILDREN_START_MARKER,
      EXPLORE_CHILDREN_END_MARKER,
    );
    expect(res).not.toBeNull();
    expect(res!.children).toEqual([]); // leaf: present but empty
  });
});

describe("parsePathList", () => {
  it("parses one path per line, strips bullets, dedupes preserving order", () => {
    const body = ["- a/x.ts", "b/y.ts", "", "- a/x.ts", "* c/z.ts"].join("\n");
    expect(parsePathList(body)).toEqual(["a/x.ts", "b/y.ts", "c/z.ts"]);
  });

  it("returns an empty array for an empty block", () => {
    expect(parsePathList("")).toEqual([]);
  });
});

describe("extractBlock", () => {
  it("returns '' for a present-but-empty block and null for a missing one", () => {
    const present = [EXPLORE_BODY_START_MARKER, "", EXPLORE_BODY_END_MARKER].join(
      "\n",
    );
    expect(
      extractBlock(present, EXPLORE_BODY_START_MARKER, EXPLORE_BODY_END_MARKER),
    ).toBe("");
    expect(
      extractBlock("nope", EXPLORE_BODY_START_MARKER, EXPLORE_BODY_END_MARKER),
    ).toBeNull();
  });

  it("recognises markers only as a full line, not mid-line", () => {
    const output = [
      `prefix${EXPLORE_BODY_START_MARKER}`, // mid-line, not a delimiter
      "body",
      EXPLORE_BODY_END_MARKER,
    ].join("\n");
    expect(
      extractBlock(output, EXPLORE_BODY_START_MARKER, EXPLORE_BODY_END_MARKER),
    ).toBeNull();
  });
});

describe("validateBody", () => {
  const longBody =
    "### Heading\n" +
    "A thorough, real body with enough characters to comfortably clear the minimum " +
    "length gate so it is accepted as a genuine page rather than a degenerate stub.";

  it("accepts a long, non-meta body between the markers", () => {
    const output = [
      "preamble outside markers",
      EXPLORE_BODY_START_MARKER,
      longBody,
      EXPLORE_BODY_END_MARKER,
      "closing outside markers",
    ].join("\n");
    const res = validateBody(
      output,
      EXPLORE_BODY_START_MARKER,
      EXPLORE_BODY_END_MARKER,
    );
    expect(res.body).toBe(longBody);
    expect(res.reason).toBeUndefined();
  });

  it("rejects missing markers as no-markers", () => {
    const res = validateBody(
      "just prose, no markers",
      EXPLORE_BODY_START_MARKER,
      EXPLORE_BODY_END_MARKER,
    );
    expect(res.reason).toBe("no-markers");
  });

  it("rejects a too-short body", () => {
    const output = [
      EXPLORE_BODY_START_MARKER,
      "### Tiny\nshort",
      EXPLORE_BODY_END_MARKER,
    ].join("\n");
    const res = validateBody(
      output,
      EXPLORE_BODY_START_MARKER,
      EXPLORE_BODY_END_MARKER,
    );
    expect(res.reason).toBe("too-short");
  });

  it("rejects a body that OPENS with a meta-summary", () => {
    const output = [
      EXPLORE_BODY_START_MARKER,
      "The documentation page is written and saved to the plan file. It covers everything in detail.",
      EXPLORE_BODY_END_MARKER,
    ].join("\n");
    const res = validateBody(
      output,
      EXPLORE_BODY_START_MARKER,
      EXPLORE_BODY_END_MARKER,
    );
    expect(res.reason).toBe("meta-summary");
  });

  it("does NOT reject a long body that merely contains meta-ish phrases mid-text", () => {
    const body =
      "### What this does\n" +
      "This unit coordinates a lot of behaviour across the system, with plenty of genuine " +
      "plain-language detail describing the real responsibilities and flows so this clears " +
      "the opening window of the anti-meta heuristic before any meta-ish wording appears. " +
      "Once your configuration is complete and saved it activates; let me know if your " +
      "build fails so you can retry. The documentation page for each unit is separate.";
    const output = [EXPLORE_BODY_START_MARKER, body, EXPLORE_BODY_END_MARKER].join(
      "\n",
    );
    const res = validateBody(
      output,
      EXPLORE_BODY_START_MARKER,
      EXPLORE_BODY_END_MARKER,
    );
    expect(res.body).toBe(body);
  });
});
