import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeDisallowedTools,
  scopedFileReadTools,
  scopedReadTools,
  sensitiveReadDenyRules,
  sensitiveReadPaths,
} from "./read-scope.js";

describe("scopedReadTools", () => {
  it("Read/Grep/Glob SOLO sotto la directory, con la sintassi assoluta `//` del CLI, mai nudi", () => {
    const rules = scopedReadTools("/srv/none/stubwise-refine/s1");
    expect(rules).toEqual([
      "Read(//srv/none/stubwise-refine/s1/**)",
      "Grep(//srv/none/stubwise-refine/s1/**)",
      "Glob(//srv/none/stubwise-refine/s1/**)",
    ]);
    for (const bare of ["Read", "Grep", "Glob"]) expect(rules).not.toContain(bare);
  });

  it("uno slash finale non raddoppia il separatore", () => {
    expect(scopedReadTools("/srv/none/x/")[0]).toBe("Read(//srv/none/x/**)");
  });

  it("una directory dietro un symlink entra anche nella sua forma reale", async () => {
    const base = await mkdtemp(join(tmpdir(), "read-scope-"));
    try {
      const real = await realpath(base);
      const link = join(real, "link");
      await symlink(join(real), link);
      const rules = scopedReadTools(link);
      expect(rules).toContain(`Read(/${link}/**)`);
      expect(rules).toContain(`Read(/${real}/**)`);
      expect(rules).toHaveLength(6);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("sensitiveReadDenyRules", () => {
  const env = { CLAUDE_CONFIG_DIR: "/home/worker/.claude-cfg", HOME: "/home/worker" };

  it("/proc, CLAUDE_CONFIG_DIR (dall'env), ~/.claude, il volume dei plugin e le config MCP effimere", () => {
    const paths = sensitiveReadPaths({ env, pluginsDir: "/plugins" });
    expect(paths).toEqual(
      expect.arrayContaining([
        "/proc",
        "/home/worker/.claude-cfg",
        "/home/worker/.claude",
        "/plugins",
        join(tmpdir(), "stubwise-mcp-*"),
      ]),
    );
  });

  it("ogni percorso ha la deny rule per Read, Grep e Glob", () => {
    const rules = sensitiveReadDenyRules({ env, pluginsDir: "/plugins" });
    for (const tool of ["Read", "Grep", "Glob"]) {
      expect(rules).toContain(`${tool}(//proc/**)`);
      expect(rules).toContain(`${tool}(//home/worker/.claude-cfg/**)`);
      expect(rules).toContain(`${tool}(//plugins/**)`);
      expect(rules).toContain(`${tool}(/${join(tmpdir(), "stubwise-mcp-*")}/**)`);
    }
  });

  it("senza CLAUDE_CONFIG_DIR né plugin: restano /proc, ~/.claude e le config MCP", () => {
    const paths = sensitiveReadPaths({ env: { HOME: "/home/w" } });
    expect(paths).toContain("/proc");
    expect(paths).toContain("/home/w/.claude");
    expect(paths.some((p) => p.endsWith("stubwise-mcp-*"))).toBe(true);
    expect(paths).not.toContain("");
  });
});

describe("mergeDisallowedTools", () => {
  it("unisce senza sostituire le deny rule dei plugin, senza doppioni", () => {
    expect(mergeDisallowedTools(["Skill(demo:alpha)"], ["Read(//proc/**)", "Skill(demo:alpha)"], undefined)).toEqual([
      "Skill(demo:alpha)",
      "Read(//proc/**)",
    ]);
  });
});

describe("scopedFileReadTools", () => {
  it("una regola Read e una Grep PER FILE, assolute, senza `/**`, mai nude, niente Glob", () => {
    const rules = scopedFileReadTools("/srv/none/wt/", ["src/auth/a.ts", "./src/b.ts"]);
    expect(rules).toEqual([
      "Read(//srv/none/wt/src/auth/a.ts)",
      "Grep(//srv/none/wt/src/auth/a.ts)",
      "Read(//srv/none/wt/src/b.ts)",
      "Grep(//srv/none/wt/src/b.ts)",
    ]);
    for (const r of rules) expect(r).not.toContain("**");
    for (const bare of ["Read", "Grep", "Glob"]) expect(rules).not.toContain(bare);
    expect(rules.some((r) => r.startsWith("Glob("))).toBe(false);
  });

  it("nessun file → nessuna regola (mai un Read nudo di ripiego)", () => {
    expect(scopedFileReadTools("/srv/none/wt", [])).toEqual([]);
  });

  it("scarta i percorsi che allargherebbero la regola: `..`, glob, parentesi, assoluti", () => {
    const rules = scopedFileReadTools("/srv/none/wt", [
      "../etc/passwd",
      "src/../../x",
      "src/*.ts",
      "src/[a].ts",
      "src/a?.ts",
      "src/{a,b}.ts",
      "src/(x).ts",
      "src/a b.ts",
      "src/a,b.ts",
      "/etc/passwd",
      "src/ok.ts",
    ]);
    expect(rules).toEqual(["Read(//srv/none/wt/src/ok.ts)", "Grep(//srv/none/wt/src/ok.ts)"]);
  });

  it("una directory dietro un symlink entra anche nella sua forma reale", async () => {
    const base = await mkdtemp(join(tmpdir(), "read-scope-"));
    try {
      const real = await realpath(base);
      const link = join(real, "link");
      await symlink(join(real), link);
      const rules = scopedFileReadTools(link, ["a.ts"]);
      expect(rules).toContain(`Read(/${link}/a.ts)`);
      expect(rules).toContain(`Read(/${real}/a.ts)`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

