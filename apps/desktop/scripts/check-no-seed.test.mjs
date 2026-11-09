// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "check-no-seed.mjs");
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const run = (target) => spawnSync(process.execPath, [script, target], { encoding: "utf8" });

describe("check-no-seed", () => {
  it("esce con 1 se un file del bundle contiene un nome del seed", () => {
    dir = mkdtempSync(join(tmpdir(), "stubwise-seed-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index.js"), 'const a="Giulia Ferri";');
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("assets/index.js");
  });

  it("esce con 0 senza nomi del seed", () => {
    dir = mkdtempSync(join(tmpdir(), "stubwise-seed-"));
    writeFileSync(join(dir, "index.html"), "<html></html>");
    expect(run(dir).status).toBe(0);
  });
});
