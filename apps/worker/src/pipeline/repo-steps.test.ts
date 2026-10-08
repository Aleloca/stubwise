import type { Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { execa } from "execa";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  commitAsStubwise,
  materializeEnvAndInstall,
  newRepoState,
  NoChangesError,
  REPORT_EXCLUDE_PATHSPEC,
  runSelfRepairLoop,
  type RepoStepsDeps,
  type TestRunResult,
} from "./repo-steps.js";
import type { TestCommand } from "./test-command.js";

// I passi per-repo sono coperti end-to-end da fix.test.ts; qui solo ciò che il
// fix non può esercitare da solo: un `beforeRepair` ASINCRONO (la correzione
// post-PR controlla il budget leggendo il DB).

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let workDir: string;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

/** Un worktree git REALE con una modifica non committata: il loop la vede. */
async function repoWithChange(): Promise<string> {
  workDir = await mkdtemp(join(tmpdir(), "repo-steps-"));
  await execa("git", ["init", "-q"], { cwd: workDir });
  await writeFile(join(workDir, "app.js"), "export const x = 1;\n");
  return workDir;
}

function stepsFor(db: Db, runTestCommand: RepoStepsDeps["runTestCommand"]): RepoStepsDeps {
  const testCmd: TestCommand = { cmd: "npm", args: ["test"] };
  return {
    db,
    jobId: randomUUID(),
    encryptionKey: randomBytes(32),
    logPrefix: "[fix]",
    loadEnvFilesFn: async () => [],
    materializeEnvFilesFn: async () => ({ writtenPaths: [], env: {} }),
    resolveInstallCommandFn: async () => null,
    runInstallCommand: async (): Promise<TestRunResult> => ({ exitCode: 0, output: "" }),
    installTimeoutMs: 1_000,
    resolveTestCommandFn: async () => testCmd,
    runTestCommand,
    testTimeoutMs: 1_000,
  };
}

describe("runSelfRepairLoop", () => {
  it("un beforeRepair ASINCRONO che lancia blocca la riparazione: il runner non parte", async () => {
    const dir = await repoWithChange();
    // Test sempre rossi: il loop arriva a una riparazione.
    const runTestCommand = vi.fn(
      async (): Promise<TestRunResult> => ({ exitCode: 1, output: "1 failed" }),
    );
    const repair = vi.fn(async () => "riparato");
    const loop = runSelfRepairLoop(stepsFor(testDb.db, runTestCommand), {
      states: [
        newRepoState(
          { repositoryId: randomUUID(), name: "app", installCommand: null, testCommand: null },
          dir,
        ),
      ],
      maxAttempts: 2,
      initialOutput: "output iniziale",
      beforeRepair: async () => {
        await Promise.resolve();
        throw new BudgetExceededError("ticket", 1, 2);
      },
      repair,
    });

    await expect(loop).rejects.toBeInstanceOf(BudgetExceededError);
    expect(runTestCommand).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
  });
});

describe("commitAsStubwise: il report non finisce mai in un commit", () => {
  /** Un repo git REALE con un commit iniziale, così `git show` ha una base. */
  async function repoForCommit(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "repo-steps-commit-"));
    await execa("git", ["init", "-q"], { cwd: dir });
    await writeFile(join(dir, "app.js"), "export const x = 1;\n");
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
      { cwd: dir },
    );
    return dir;
  }

  async function committedFiles(dir: string): Promise<string[]> {
    const { stdout } = await execa("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });
    return stdout.split("\n").filter((l) => l !== "").sort();
  }

  const repo = { repositoryId: randomUUID(), name: "r", installCommand: null, testCommand: null };

  it("il pathspec è UNO, condiviso con lo stage: STUBWISE_REPORT* a ogni profondità, senza maiuscole", () => {
    expect(REPORT_EXCLUDE_PATHSPEC).toBe(":(exclude,icase,glob)**/STUBWISE_REPORT*");
  });

  for (const [label, reportPath] of [
    ["il nome esatto nella radice del repo", "STUBWISE_REPORT.md"],
    ["minuscolo nella radice del repo", "stubwise_report.md"],
    ["in una sottocartella", "docs/STUBWISE_REPORT.md"],
    ["con un suffisso scelto dall'agente", "STUBWISE_REPORT-final.md"],
  ] as const) {
    it(`un report scritto per errore dentro il repo non entra nel commit: ${label}`, async () => {
      const dir = await repoForCommit();
      try {
        await writeFile(join(dir, "app.js"), "export const x = 2;\n");
        await mkdir(join(dir, "docs"), { recursive: true });
        await writeFile(join(dir, reportPath), "## Report\n");
        await commitAsStubwise(newRepoState(repo, dir), "fix: x");
        // Il file normale entra, il report no (e resta lì, non tracciato).
        expect(await committedFiles(dir)).toEqual(["app.js"]);
        const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: dir });
        expect(stdout).toContain(reportPath.split("/")[0]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("un file che contiene il nome ma non comincia così entra, come ogni altro", async () => {
    const dir = await repoForCommit();
    try {
      await writeFile(join(dir, "MY_STUBWISE_REPORT.md"), "x\n");
      await commitAsStubwise(newRepoState(repo, dir), "fix: x");
      expect(await committedFiles(dir)).toEqual(["MY_STUBWISE_REPORT.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("lockfile creato dall'install: mai nel commit (8 ott 2026)", () => {
  // Il caso di produzione: una correzione su un repo SENZA lockfile ha
  // committato il `package-lock.json` scritto da `npm install` nel worktree.
  async function repoWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "repo-steps-lock-"));
    await execa("git", ["init", "-q"], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: dir });
    return dir;
  }

  async function committedFiles(dir: string): Promise<string[]> {
    const { stdout } = await execa("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });
    return stdout.split("\n").filter((l) => l !== "").sort();
  }

  const repo = { repositoryId: randomUUID(), name: "r", installCommand: null, testCommand: null };

  /** Un install VERO nel senso che conta: scrive i lockfile nel worktree, come npm/pnpm/yarn. */
  function installWriting(paths: string[]): RepoStepsDeps {
    return {
      ...stepsFor(testDb.db, async () => ({ exitCode: 0, output: "" })),
      resolveInstallCommandFn: async () => ({ cmd: "npm", args: ["install"] }),
      runInstallCommand: async (_cmd, dir) => {
        for (const p of paths) {
          await mkdir(join(dir, p, ".."), { recursive: true });
          await writeFile(join(dir, p), "{}\n");
        }
        return { exitCode: 0, output: "" };
      },
    };
  }

  it("repo senza lockfile → install → commit SENZA i lockfile creati (npm, pnpm, yarn, anche in un pacchetto)", async () => {
    const dir = await repoWith({ "package.json": "{}\n", "app.js": "x\n" });
    try {
      const state = newRepoState(repo, dir);
      await materializeEnvAndInstall(
        installWriting(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "packages/a/package-lock.json"]),
        [state],
      );
      await writeFile(join(dir, "app.js"), "y\n");
      const { changed } = await runSelfRepairLoop(stepsFor(testDb.db, async () => ({ exitCode: 0, output: "" })), {
        states: [state],
        maxAttempts: 0,
        initialOutput: "",
        beforeRepair: () => {},
        repair: async () => "",
      });
      expect(changed[0]!.changedFiles).toEqual(["app.js"]);
      await commitAsStubwise(state, "fix: x");
      expect(await committedFiles(dir)).toEqual(["app.js"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("se l'unica differenza è il lockfile creato dall'install, non c'è niente da committare", async () => {
    const dir = await repoWith({ "package.json": "{}\n" });
    try {
      const state = newRepoState(repo, dir);
      await materializeEnvAndInstall(installWriting(["package-lock.json"]), [state]);
      await expect(
        runSelfRepairLoop(stepsFor(testDb.db, async () => ({ exitCode: 0, output: "" })), {
          states: [state],
          maxAttempts: 0,
          initialOutput: "",
          beforeRepair: () => {},
          repair: async () => "",
        }),
      ).rejects.toBeInstanceOf(NoChangesError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("repo con lockfile TRACCIATO: modificato (dall'agente o dall'install) resta nel commit", async () => {
    const dir = await repoWith({ "package.json": "{}\n", "package-lock.json": "{\"v\":1}\n" });
    try {
      const state = newRepoState(repo, dir);
      await materializeEnvAndInstall(installWriting([]), [state]);
      await writeFile(join(dir, "package.json"), '{"dependencies":{"a":"1"}}\n');
      await writeFile(join(dir, "package-lock.json"), '{"v":2}\n');
      await commitAsStubwise(state, "fix: x");
      expect(await committedFiles(dir)).toEqual(["package-lock.json", "package.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
