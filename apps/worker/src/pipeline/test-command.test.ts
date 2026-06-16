import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestCommand } from "./test-command.js";

// Puro fs su tmpdir reali (mkdtemp/writeFile/rm): nessun mock di node:fs.
// Ogni test costruisce un worktree finto e lo pulisce dopo.

const dirs: string[] = [];

async function makeWorktree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stubwise-test-cmd-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveTestCommand", () => {
  describe("override (project.testCommand valorizzato)", () => {
    it("parsa cmd + args con split sugli spazi", async () => {
      const dir = await makeWorktree({});
      expect(await resolveTestCommand({ testCommand: "pnpm run test:ci" }, dir)).toEqual({
        cmd: "pnpm",
        args: ["run", "test:ci"],
      });
    });

    it("comando a un solo token → args vuoti", async () => {
      const dir = await makeWorktree({});
      expect(await resolveTestCommand({ testCommand: "make test-all" }, dir)).toEqual({
        cmd: "make",
        args: ["test-all"],
      });
    });

    it("ignora l'auto-detect anche senza package.json", async () => {
      // Worktree completamente vuoto: l'override deve comunque vincere.
      const dir = await makeWorktree({});
      expect(await resolveTestCommand({ testCommand: "vitest run" }, dir)).toEqual({
        cmd: "vitest",
        args: ["run"],
      });
    });

    it("trimma spazi esterni e collassa spazi interni multipli", async () => {
      const dir = await makeWorktree({});
      expect(await resolveTestCommand({ testCommand: "   pnpm   run   test:ci   " }, dir)).toEqual({
        cmd: "pnpm",
        args: ["run", "test:ci"],
      });
    });

    it("override vince anche su un package.json con scripts.test + lockfile", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "pnpm-lock.yaml": "",
      });
      expect(await resolveTestCommand({ testCommand: "yarn test:custom" }, dir)).toEqual({
        cmd: "yarn",
        args: ["test:custom"],
      });
    });
  });

  describe("auto-detect (testCommand null/vuoto)", () => {
    it("package.json con scripts.test + pnpm-lock.yaml → pnpm test", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "pnpm-lock.yaml": "",
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toEqual({
        cmd: "pnpm",
        args: ["test"],
      });
    });

    it("package.json con scripts.test + yarn.lock → yarn test", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "yarn.lock": "",
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toEqual({
        cmd: "yarn",
        args: ["test"],
      });
    });

    it("solo package-lock.json → npm test", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "package-lock.json": "",
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toEqual({
        cmd: "npm",
        args: ["test"],
      });
    });

    it("nessun lockfile → npm test", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toEqual({
        cmd: "npm",
        args: ["test"],
      });
    });

    it("pnpm-lock.yaml ha precedenza su yarn.lock", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "pnpm-lock.yaml": "",
        "yarn.lock": "",
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toEqual({
        cmd: "pnpm",
        args: ["test"],
      });
    });

    it("testCommand stringa vuota/whitespace → cade nell'auto-detect", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        "pnpm-lock.yaml": "",
      });
      expect(await resolveTestCommand({ testCommand: "   " }, dir)).toEqual({
        cmd: "pnpm",
        args: ["test"],
      });
    });
  });

  describe("null (niente da risolvere)", () => {
    it("package.json SENZA scripts.test → null", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toBeNull();
    });

    it("package.json con scripts.test vuoto → null", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ scripts: { test: "   " } }),
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toBeNull();
    });

    it("package.json senza chiave scripts → null", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ name: "foo" }),
      });
      expect(await resolveTestCommand({ testCommand: null }, dir)).toBeNull();
    });

    it("nessun package.json → null", async () => {
      const dir = await makeWorktree({});
      expect(await resolveTestCommand({ testCommand: null }, dir)).toBeNull();
    });

    it("package.json malformato → null (non lancia)", async () => {
      const dir = await makeWorktree({ "package.json": "{ not valid json," });
      await expect(resolveTestCommand({ testCommand: null }, dir)).resolves.toBeNull();
    });

    it("testCommand null + no package.json → null", async () => {
      const dir = await makeWorktree({});
      expect(await resolveTestCommand({ testCommand: null }, dir)).toBeNull();
    });
  });
});
