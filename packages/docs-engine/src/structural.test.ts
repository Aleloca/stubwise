import { describe, expect, it } from "vitest";
import { buildRepoMap } from "./structural.js";
import type { RepoFile, RepoReader } from "./fs.js";

function reader(files: Record<string, string>): RepoReader {
  const list: RepoFile[] = Object.keys(files).map((p) => ({
    path: p,
    size: files[p]!.length,
  }));
  return { list: async () => list, read: async (p) => files[p] ?? "" };
}

describe("buildRepoMap — linguaggi ed esclusioni (M2.2)", () => {
  it("conta i linguaggi per estensione ed esclude build/dist", async () => {
    const map = await buildRepoMap(
      reader({
        "src/a.ts": "export const a = 1;",
        "src/b.ts": "export const b = 2;",
        "dist/a.js": "x", // escluso
        "README.md": "# hi",
      }),
      { maxModules: 50 },
    );
    expect(map.languages[".ts"]).toBe(2);
    expect(map.languages[".js"]).toBeUndefined(); // dist escluso
    expect(map.skipped.some((s) => s.path.startsWith("dist"))).toBe(true);
  });

  it("esclude node_modules, vendor, .git e file binari, loggandoli in skipped", async () => {
    const map = await buildRepoMap(
      reader({
        "src/main.ts": "x",
        "node_modules/dep/index.js": "x",
        "vendor/lib.php": "x",
        ".git/config": "x",
        "assets/logo.png": "x",
        "build/out.js": "x",
      }),
      { maxModules: 50 },
    );
    expect(map.languages[".ts"]).toBe(1);
    expect(map.languages[".js"]).toBeUndefined();
    expect(map.languages[".php"]).toBeUndefined();
    expect(map.languages[".png"]).toBeUndefined();
    for (const prefix of ["node_modules", "vendor", ".git", "build"]) {
      expect(map.skipped.some((s) => s.path.startsWith(prefix))).toBe(true);
    }
    expect(map.skipped.some((s) => s.path === "assets/logo.png")).toBe(true);
  });

  it("gestisce un repo vuoto e file senza estensione", async () => {
    const map = await buildRepoMap(
      reader({ Makefile: "all:\n\techo hi" }),
      { maxModules: 50 },
    );
    expect(map.languages).toEqual({});
    // un file senza estensione forma comunque un modulo (root), ma senza linguaggio
    expect(map.modules.map((m) => m.path)).toEqual([""]);
    expect(map.modules[0]!.language).toBeNull();
    expect(map.skipped).toEqual([]);
  });
});

describe("buildRepoMap — moduli e manifest (M2.3)", () => {
  it("usa i manifest come confine di modulo con files e linguaggio dominante", async () => {
    const map = await buildRepoMap(
      reader({
        "packages/a/package.json": "{}",
        "packages/a/src/index.ts": "export const a = 1;",
        "packages/a/src/util.ts": "export const u = 2;",
        "packages/b/package.json": "{}",
        "packages/b/main.py": "x = 1",
      }),
      { maxModules: 50 },
    );
    const byPath = Object.fromEntries(map.modules.map((m) => [m.path, m]));
    expect(Object.keys(byPath).sort()).toEqual(["packages/a", "packages/b"]);

    expect(byPath["packages/a"]!.manifest).toBe("packages/a/package.json");
    expect(byPath["packages/a"]!.language).toBe(".ts");
    expect(byPath["packages/a"]!.files.sort()).toEqual([
      "packages/a/package.json",
      "packages/a/src/index.ts",
      "packages/a/src/util.ts",
    ]);

    expect(byPath["packages/b"]!.manifest).toBe("packages/b/package.json");
    expect(byPath["packages/b"]!.language).toBe(".py");
  });

  it("in assenza di manifest segmenta per directory a moduleDepth", async () => {
    const map = await buildRepoMap(
      reader({
        "src/foo/a.ts": "x",
        "src/foo/b.ts": "x",
        "src/bar/c.ts": "x",
        "top.ts": "x", // file in root → modulo root
      }),
      { maxModules: 50, moduleDepth: 2 },
    );
    expect(map.modules.map((m) => m.path).sort()).toEqual([
      "",
      "src/bar",
      "src/foo",
    ]);
    const foo = map.modules.find((m) => m.path === "src/foo")!;
    expect(foo.manifest).toBeNull();
    expect(foo.files.sort()).toEqual(["src/foo/a.ts", "src/foo/b.ts"]);
  });
});

describe("buildRepoMap — superficie pubblica e dependency graph (M2.4)", () => {
  it("estrae export TS/JS in publicSurface e risolve import relativi in dependsOn", async () => {
    const map = await buildRepoMap(
      reader({
        "packages/a/package.json": "{}",
        "packages/a/index.ts": [
          `import { x } from "../b";`,
          `export function foo() { return x; }`,
          `export const bar = 1;`,
          `export class Baz {}`,
        ].join("\n"),
        "packages/b/package.json": "{}",
        "packages/b/index.ts": `export const x = 1;`,
      }),
      { maxModules: 50 },
    );
    const a = map.modules.find((m) => m.path === "packages/a")!;
    expect(a.publicSurface.sort()).toEqual(["Baz", "bar", "foo"]);
    expect(a.dependsOn).toEqual(["packages/b"]);

    const b = map.modules.find((m) => m.path === "packages/b")!;
    expect(b.publicSurface).toEqual(["x"]);
    expect(b.dependsOn).toEqual([]);
  });

  it("un modulo senza export ha publicSurface vuota e non auto-dipende", async () => {
    const map = await buildRepoMap(
      reader({
        "packages/a/package.json": "{}",
        "packages/a/index.ts": [
          `import { helper } from "./util";`,
          `const internal = helper();`,
        ].join("\n"),
        "packages/a/util.ts": `export function helper() { return 1; }`,
      }),
      { maxModules: 50 },
    );
    const a = map.modules.find((m) => m.path === "packages/a")!;
    expect(a.publicSurface).toEqual(["helper"]);
    // import "./util" resta interno al modulo a → nessuna dipendenza esterna
    expect(a.dependsOn).toEqual([]);
  });
});
