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
    expect(map.modules).toEqual([]);
    expect(map.skipped).toEqual([]);
  });
});
