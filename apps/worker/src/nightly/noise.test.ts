import { describe, expect, it } from "vitest";
import {
  isNoise,
  NOISE_CI_PREFIXES,
  NOISE_DIR_SEGMENTS,
  NOISE_DOC_PREFIXES,
  NOISE_LOCKFILES,
  NOISE_SUFFIXES,
  noiseCategory,
} from "./noise.js";

describe("regola del rumore (D16): la lista è dichiarata", () => {
  it("fissa esattamente le liste: allargarle è una modifica esplicita", () => {
    expect(NOISE_LOCKFILES).toEqual(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
    expect(NOISE_DOC_PREFIXES).toEqual(["plans/", "docs/", "manual/", "guides/"]);
    expect(NOISE_CI_PREFIXES).toEqual([".github/"]);
    expect(NOISE_DIR_SEGMENTS).toEqual(["vendor", "node_modules", "dist"]);
    expect(NOISE_SUFFIXES).toEqual([".min.js", ".min.css", ".map", ".snap"]);
  });
});

describe("isNoise", () => {
  it("1. lockfile per basename, a ogni profondità", () => {
    expect(isNoise("pnpm-lock.yaml")).toBe(true);
    expect(isNoise("apps/web/package-lock.json")).toBe(true);
    expect(isNoise("packages/x/yarn.lock")).toBe(true);
    expect(noiseCategory("pnpm-lock.yaml")).toBe("lockfile");
  });

  it("2. cartelle di processo e CI, per prefisso", () => {
    expect(isNoise("plans/2026-x.md")).toBe(true);
    expect(isNoise("docs/foo.md")).toBe(true);
    expect(isNoise("manual/a.md")).toBe(true);
    expect(isNoise("guides/b.md")).toBe(true);
    expect(isNoise(".github/workflows/ci.yml")).toBe(true);
    expect(isNoise("/docs/foo.md")).toBe(true);
    expect(noiseCategory("docs/foo.md")).toBe("docs");
    expect(noiseCategory(".github/workflows/ci.yml")).toBe("ci");
    // Solo come PREFISSO: una cartella `docs/` annidata è sorgente (es. apps/docs).
    expect(isNoise("apps/docs/src/index.md")).toBe(false);
  });

  it("3. segmenti vendor/, node_modules/, dist/ a qualunque profondità", () => {
    expect(isNoise("vendor/lib/a.go")).toBe(true);
    expect(isNoise("packages/x/node_modules/y/index.js")).toBe(true);
    expect(isNoise("packages/db/dist/index.js")).toBe(true);
    expect(noiseCategory("dist/a.js")).toBe("generated");
  });

  it("4. suffissi .min.js, .min.css, .map, .snap", () => {
    expect(isNoise("public/app.min.js")).toBe(true);
    expect(isNoise("public/app.min.css")).toBe(true);
    expect(isNoise("src/app.js.map")).toBe(true);
    expect(isNoise("src/__snapshots__/a.test.ts.snap")).toBe(true);
    expect(noiseCategory("src/app.js.map")).toBe("generated");
  });

  it("NON è rumore: build/, nomi che somigliano ai segmenti, sorgente", () => {
    expect(isNoise("src/build/x.ts")).toBe(false);
    expect(isNoise("build/script.ts")).toBe(false);
    expect(isNoise("lib/distance.ts")).toBe(false);
    expect(isNoise("src/app.mapper.ts")).toBe(false);
    expect(isNoise("src/vendors/a.ts")).toBe(false);
    expect(isNoise("src/dist")).toBe(false);
    expect(isNoise("src/app.ts")).toBe(false);
    expect(isNoise("apps/server/src/routes/x.ts")).toBe(false);
    expect(noiseCategory("src/app.ts")).toBeNull();
  });

  it("un percorso vuoto è rumore (come prima dello spostamento)", () => {
    expect(isNoise("")).toBe(true);
    expect(isNoise("  ")).toBe(true);
  });
});
