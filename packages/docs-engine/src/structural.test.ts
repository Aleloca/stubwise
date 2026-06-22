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

  it("logga i file non-source (binari, .svg, .lock) con reason 'non-source file'", async () => {
    const map = await buildRepoMap(
      reader({
        "src/main.ts": "x",
        "assets/logo.svg": "<svg/>",
        "pnpm-lock.yaml": "x", // estensione .yaml, NON in BINARY_EXTENSIONS → tenuto
        "deps.lock": "x",
        "icon.png": "x",
      }),
      { maxModules: 50 },
    );
    const svg = map.skipped.find((s) => s.path === "assets/logo.svg");
    const lock = map.skipped.find((s) => s.path === "deps.lock");
    const png = map.skipped.find((s) => s.path === "icon.png");
    expect(svg?.reason).toBe("non-source file");
    expect(lock?.reason).toBe("non-source file");
    expect(png?.reason).toBe("non-source file");
    // il reason non è più "binary file"
    expect(map.skipped.some((s) => s.reason === "binary file")).toBe(false);
  });

  it("normalizza un './' iniziale nei path listati (./src/a.ts == src/a.ts)", async () => {
    const map = await buildRepoMap(
      reader({
        "./src/a.ts": "export const a = 1;",
        "src/b.ts": "export const b = 2;",
        "././dist/x.js": "x", // ancora escluso dopo la normalizzazione
      }),
      { maxModules: 50, moduleDepth: 1 },
    );
    // entrambi i .ts contano e finiscono nello stesso modulo `src`
    expect(map.languages[".ts"]).toBe(2);
    const src = map.modules.find((m) => m.path === "src")!;
    expect(src.files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // dist resta escluso anche con prefisso ./ ripetuto
    expect(map.skipped.some((s) => s.path === "dist/x.js")).toBe(true);
    expect(map.languages[".js"]).toBeUndefined();
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

  it("un manifest di root NON collassa tutto in un modulo: sotto-segmenta per directory", async () => {
    const map = await buildRepoMap(
      reader({
        "package.json": "{}", // manifest di root
        "src/a/x.ts": "export const x = 1;",
        "src/b/y.ts": "export const y = 1;",
      }),
      { maxModules: 50, moduleDepth: 2 },
    );
    const paths = map.modules.map((m) => m.path).sort();
    // più moduli, NON un unico modulo "" che assorbe tutto
    expect(paths).toEqual(["", "src/a", "src/b"]);
    expect(paths).not.toEqual([""]);
    // il modulo manifest "" porta il manifest e contiene solo il package.json
    const root = map.modules.find((m) => m.path === "")!;
    expect(root.manifest).toBe("package.json");
    expect(root.files).toEqual(["package.json"]);
    // i sotto-moduli non portano manifest
    expect(map.modules.find((m) => m.path === "src/a")!.manifest).toBeNull();
    expect(map.modules.find((m) => m.path === "src/a")!.files).toEqual([
      "src/a/x.ts",
    ]);
  });

  it("un manifest 'piatto' (sotto-dir singola) resta un solo modulo (caso monorepo invariato)", async () => {
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
    // nonostante src/ sia una sottodir, c'è un solo bucket → resta packages/a
    expect(Object.keys(byPath).sort()).toEqual(["packages/a", "packages/b"]);
    expect(byPath["packages/a"]!.files.sort()).toEqual([
      "packages/a/package.json",
      "packages/a/src/index.ts",
      "packages/a/src/util.ts",
    ]);
  });

  it("clampa moduleDepth a 1 (moduleDepth: 0 NON collassa tutto in root)", async () => {
    const map = await buildRepoMap(
      reader({
        "src/foo/a.ts": "x",
        "lib/bar/b.ts": "x",
      }),
      { maxModules: 50, moduleDepth: 0 },
    );
    // con depth clampato a 1 i moduli sono le top-dir, non un unico modulo ""
    expect(map.modules.map((m) => m.path).sort()).toEqual(["lib", "src"]);
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

  it("ignora gli import dentro i commenti (riga, blocco): nessun arco fantasma", async () => {
    const map = await buildRepoMap(
      reader({
        "packages/a/package.json": "{}",
        "packages/a/index.ts": [
          `// import { gone } from "../b";`,
          `/* import { also } from "../b"; */`,
          `/*`,
          ` * import { multi } from "../b";`,
          ` */`,
          `export const a = 1;`,
        ].join("\n"),
        "packages/b/package.json": "{}",
        "packages/b/index.ts": `export const x = 1;`,
      }),
      { maxModules: 50 },
    );
    const a = map.modules.find((m) => m.path === "packages/a")!;
    // l'UNICO "import ../b" è dentro i commenti → nessuna dipendenza su b
    expect(a.dependsOn).toEqual([]);
    expect(a.publicSurface).toEqual(["a"]);
  });

  it("cattura i re-export di un barrel/index in publicSurface", async () => {
    const map = await buildRepoMap(
      reader({
        "packages/lib/package.json": "{}",
        "packages/lib/foo.ts": "export const foo = 1;",
        "packages/lib/bar.ts": "export const bar = 2;",
        "packages/lib/index.ts": [
          `export { foo } from "./foo";`,
          `export { bar as renamedBar } from "./bar";`,
          `export * from "./bar";`,
          `export * as ns from "./foo";`,
        ].join("\n"),
      }),
      { maxModules: 50 },
    );
    const lib = map.modules.find((m) => m.path === "packages/lib")!;
    // foo/bar dalle dichiarazioni dirette + renamedBar (alias) + "*" e ns dai wildcard
    expect(lib.publicSurface.sort()).toEqual([
      "*",
      "bar",
      "foo",
      "ns",
      "renamedBar",
    ]);
  });
});

describe("buildRepoMap — scoring e cap moduli (M2.5)", () => {
  it("tiene i maxModules con score più alto e logga gli altri come module budget", async () => {
    // 5 moduli con dimensioni crescenti → i due più grandi vincono.
    const files: Record<string, string> = {};
    for (const name of ["a", "b", "c", "d", "e"]) {
      files[`packages/${name}/package.json`] = "{}";
    }
    files["packages/a/i.ts"] = "x".repeat(10);
    files["packages/b/i.ts"] = "x".repeat(20);
    files["packages/c/i.ts"] = "x".repeat(30);
    files["packages/d/i.ts"] = "x".repeat(40);
    files["packages/e/i.ts"] = "x".repeat(50);

    const map = await buildRepoMap(reader(files), { maxModules: 2 });

    expect(map.modules).toHaveLength(2);
    expect(map.modules.map((m) => m.path)).toEqual(["packages/e", "packages/d"]);
    // ordinati per score decrescente
    expect(map.modules[0]!.score).toBeGreaterThanOrEqual(map.modules[1]!.score);

    const budget = map.skipped.filter((s) => s.reason === "module budget");
    expect(budget.map((s) => s.path).sort()).toEqual([
      "packages/a",
      "packages/b",
      "packages/c",
    ]);
  });

  it("la centralità nel grafo aumenta lo score a parità di dimensione", async () => {
    // due moduli identici per dimensione; 'hub' è importato da molti → più centrale.
    const map = await buildRepoMap(
      reader({
        "packages/hub/package.json": "{}",
        "packages/hub/i.ts": "export const h = 1;",
        "packages/leaf/package.json": "{}",
        "packages/leaf/i.ts": "export const l = 1;",
        "packages/u1/package.json": "{}",
        "packages/u1/i.ts": `import { h } from "../hub";`,
        "packages/u2/package.json": "{}",
        "packages/u2/i.ts": `import { h } from "../hub";`,
      }),
      { maxModules: 50 },
    );
    const hub = map.modules.find((m) => m.path === "packages/hub")!;
    const leaf = map.modules.find((m) => m.path === "packages/leaf")!;
    expect(hub.score).toBeGreaterThan(leaf.score);
  });

  it("un hub piccolo ad alta centralità batte un modulo grande e isolato (tradeoff dei pesi)", async () => {
    // Pin del bilanciamento dei pesi: la centralità deve poter ribaltare la sola
    // dimensione. 'hub' è minuscolo (pochi byte) ma importato da 3 moduli;
    // 'fat' è grande (~800 byte) ma isolato (nessun import/export/centralità).
    const map = await buildRepoMap(
      reader({
        "packages/hub/package.json": "{}",
        "packages/hub/i.ts": "export const h = 1;", // piccolo, 1 export
        "packages/fat/package.json": "{}",
        "packages/fat/i.ts": "const _ = 1;".padEnd(800, " "), // grande ma 0 export/0 archi
        "packages/u1/package.json": "{}",
        "packages/u1/i.ts": `import { h } from "../hub";`,
        "packages/u2/package.json": "{}",
        "packages/u2/i.ts": `import { h } from "../hub";`,
        "packages/u3/package.json": "{}",
        "packages/u3/i.ts": `import { h } from "../hub";`,
      }),
      { maxModules: 50 },
    );
    const hub = map.modules.find((m) => m.path === "packages/hub")!;
    const fat = map.modules.find((m) => m.path === "packages/fat")!;
    // sanity: fat è davvero più grande in byte ma senza centralità né superficie
    expect(fat.dependsOn).toEqual([]);
    expect(fat.publicSurface).toEqual([]);
    expect(hub.score).toBeGreaterThan(fat.score);
    // ...e l'hub finisce davanti nell'ordinamento finale
    expect(map.modules.indexOf(hub)).toBeLessThan(map.modules.indexOf(fat));
  });
});
