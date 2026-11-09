// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_CANARY, seedMarkers } from "./check-no-seed.mjs";

const script = resolve(import.meta.dirname, "check-no-seed.mjs");
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const run = (target) => spawnSync(process.execPath, [script, target], { encoding: "utf8" });

function bundle(content) {
  dir = mkdtempSync(join(tmpdir(), "stubwise-seed-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index.js"), content);
  return dir;
}

describe("check-no-seed", () => {
  it("esce con 1 se un file del bundle contiene un nome del seed", () => {
    const res = run(bundle('const a="Giulia Ferri";'));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("assets/index.js");
  });

  it("esce con 0 senza nomi del seed", () => {
    dir = mkdtempSync(join(tmpdir(), "stubwise-seed-"));
    writeFileSync(join(dir, "index.html"), "<html></html>");
    expect(run(dir).status).toBe(0);
  });

  it("il canary del seed fa fallire", () => {
    expect(run(bundle(`x="${SEED_CANARY}"`)).status).toBe(1);
  });

  it("i marcatori vengono anche dai file del seed: un titolo per file", () => {
    const markers = seedMarkers();
    expect(markers).toContain(SEED_CANARY);
    // Più dei tre nomi scritti a mano: almeno qualche decina di titoli dal seme.
    expect(markers.length).toBeGreaterThan(30);
    const generated = markers.find((m) => !["Giulia Ferri", "Laura Costa", "p-giulia", SEED_CANARY].includes(m));
    expect(run(bundle(`t="${generated}"`)).status).toBe(1);
  });
});

describe("il canary è davvero nel seme", () => {
  it("il modulo delle persone del seme lo porta", async () => {
    const people = await import("../src/renderer/data/seed/people");
    expect(people.PEOPLE.seedCanary).toBe(SEED_CANARY);
  });
});
