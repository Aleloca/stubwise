import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunInstallCommand } from "./fix.js";

/**
 * Verifica REALE (senza mock di execa, path di produzione) che il sottoprocesso
 * spawnato per install/test NON erediti NODE_ENV=production dal worker. Il worker
 * gira con NODE_ENV=production (apps/worker/Dockerfile), ma install e test del repo
 * target devono includere le devDependencies (vitest/jest) e girare come un normale
 * checkout di CI: per questo runCommandCaptured neutralizza NODE_ENV. Eseguendo un
 * vero Node con NODE_ENV=production nel processo padre, il figlio deve vedere
 * NODE_ENV assente (UNSET), non "production".
 */
describe("runCommandCaptured: neutralizza NODE_ENV per il sottoprocesso", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "run-cmd-captured-"));
    process.env.NODE_ENV = "production";
  });

  afterEach(async () => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("il sottoprocesso non vede NODE_ENV=production anche se il worker è in production", async () => {
    const result = await defaultRunInstallCommand(
      {
        cmd: process.execPath,
        args: ["-e", "console.log('NODE_ENV=' + (process.env.NODE_ENV ?? 'UNSET'))"],
      },
      dir,
      30_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("NODE_ENV=production");
    expect(result.output).toContain("NODE_ENV=UNSET");
  });
});
