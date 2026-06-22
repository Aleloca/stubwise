import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstallCommand } from "./install-command.js";

// Puro fs su tmpdir reali (mkdtemp/writeFile/rm): nessun mock di node:fs.
// Ogni test costruisce un worktree finto e lo pulisce dopo.

const dirs: string[] = [];

async function makeWorktree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stubwise-install-cmd-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveInstallCommand", () => {
  describe("override (project.installCommand valorizzato)", () => {
    it("parsa cmd + args, anche senza package.json nel worktree", async () => {
      // Worktree vuoto: l'override deve comunque vincere.
      const dir = await makeWorktree({});
      expect(
        await resolveInstallCommand({ installCommand: "pnpm install --frozen-lockfile" }, dir),
      ).toEqual({
        cmd: "pnpm",
        args: ["install", "--frozen-lockfile"],
      });
    });

    it("collassa spazi interni multipli (nessun token vuoto)", async () => {
      const dir = await makeWorktree({});
      expect(
        await resolveInstallCommand({ installCommand: "   pnpm   install   --frozen-lockfile   " }, dir),
      ).toEqual({
        cmd: "pnpm",
        args: ["install", "--frozen-lockfile"],
      });
    });
  });

  describe("auto-detect (installCommand null/vuoto)", () => {
    it("package.json + pnpm-lock.yaml → pnpm install --frozen-lockfile", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ name: "foo" }),
        "pnpm-lock.yaml": "",
      });
      expect(await resolveInstallCommand({ installCommand: null }, dir)).toEqual({
        cmd: "pnpm",
        args: ["install", "--frozen-lockfile"],
      });
    });

    it("package.json + yarn.lock → yarn install --frozen-lockfile", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ name: "foo" }),
        "yarn.lock": "",
      });
      expect(await resolveInstallCommand({ installCommand: null }, dir)).toEqual({
        cmd: "yarn",
        args: ["install", "--frozen-lockfile"],
      });
    });

    it("package.json + package-lock.json → npm ci", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ name: "foo" }),
        "package-lock.json": "",
      });
      expect(await resolveInstallCommand({ installCommand: null }, dir)).toEqual({
        cmd: "npm",
        args: ["ci"],
      });
    });

    it("package.json senza lockfile → npm install", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ name: "foo" }),
      });
      expect(await resolveInstallCommand({ installCommand: null }, dir)).toEqual({
        cmd: "npm",
        args: ["install"],
      });
    });

    it("pnpm-lock.yaml ha precedenza su yarn.lock", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ name: "foo" }),
        "pnpm-lock.yaml": "",
        "yarn.lock": "",
      });
      expect(await resolveInstallCommand({ installCommand: null }, dir)).toEqual({
        cmd: "pnpm",
        args: ["install", "--frozen-lockfile"],
      });
    });

    it("installCommand stringa vuota/whitespace → cade nell'auto-detect", async () => {
      const dir = await makeWorktree({
        "package.json": JSON.stringify({ name: "foo" }),
        "pnpm-lock.yaml": "",
      });
      expect(await resolveInstallCommand({ installCommand: "   " }, dir)).toEqual({
        cmd: "pnpm",
        args: ["install", "--frozen-lockfile"],
      });
    });
  });

  describe("null (niente da installare)", () => {
    it("nessun package.json → null", async () => {
      const dir = await makeWorktree({});
      expect(await resolveInstallCommand({ installCommand: null }, dir)).toBeNull();
    });

    it("solo lockfile senza package.json → null", async () => {
      // Senza package.json non c'è nulla da installare, anche con un lockfile.
      const dir = await makeWorktree({ "pnpm-lock.yaml": "" });
      expect(await resolveInstallCommand({ installCommand: null }, dir)).toBeNull();
    });
  });
});
