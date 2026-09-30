import type { Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { execa } from "execa";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  newRepoState,
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
