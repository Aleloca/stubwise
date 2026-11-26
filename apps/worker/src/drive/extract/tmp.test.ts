import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleJobTmps, withJobTmp } from "./tmp.js";

// Una tmp per job, tolta SEMPRE: su successo, su eccezione.
describe("withJobTmp", () => {
  it("la tmp esiste dentro, sparisce dopo, anche quando la funzione lancia", async () => {
    let seen = "";
    expect(await withJobTmp("11111111-1111-4111-8111-111111111111", async (dir) => ((seen = dir), existsSync(dir)))).toBe(true);
    expect(seen).toContain("stubwise-drive-11111111-1111-4111-8111-111111111111-");
    expect(existsSync(seen)).toBe(false);
    await expect(withJobTmp("x/../../etc", async (dir) => ((seen = dir), Promise.reject(new Error("boom"))))).rejects.toThrow("boom");
    expect(seen).not.toContain("..");
    expect(existsSync(seen)).toBe(false);
  });

  it("all'avvio si spazzano le tmp dei job rimaste da un worker morto, e solo quelle", async () => {
    const root = await mkdtemp(join(tmpdir(), "stubwise-sweep-test-"));
    try {
      await mkdir(join(root, "stubwise-drive-aaaa-1"));
      await mkdir(join(root, "stubwise-drive-bbbb-2"), { recursive: true });
      await mkdir(join(root, "altro-programma"));
      expect(await sweepStaleJobTmps(root)).toBe(2);
      expect(existsSync(join(root, "stubwise-drive-aaaa-1"))).toBe(false);
      expect(existsSync(join(root, "altro-programma"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

