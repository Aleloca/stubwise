import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MirrorManager, type MirrorProject } from "../git/mirrors.js";
import { openGenerationWorktree } from "./generation-worktree.js";
import { createWorktreeReader } from "./reader.js";

// Test del worktree CONDIVISO di generazione (M5a): un mirror bare locale come
// "upstream" (pattern pipeline.test.ts), si verifica il ciclo open → read (via
// createWorktreeReader) → close. Niente DB/agent qui: è il primitivo git puro.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

/** Mirror bare locale con un manifest + un file sorgente. Ritorna il commit sha. */
async function makeUpstream(): Promise<{ url: string; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-genwt-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "upstream.git");
  await execa("git", ["init", "--bare", "-b", "main", dir]);
  const work = join(root, "seed-work");
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", dir], work);
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "demo" }) + "\n");
  await writeFile(join(work, "index.ts"), "export function hello() { return 'hi'; }\n");
  await git(["add", "."], work);
  await git(
    ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"],
    work,
  );
  const sha = await git(["rev-parse", "HEAD"], work);
  await git(["push", "origin", "main"], work);
  return { url: pathToFileURL(dir).href, sha };
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-genwt-mirrors-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new MirrorManager({ mirrorsDir: join(root, "mirrors") });
}

function projectFor(url: string): MirrorProject {
  return {
    provider: "github",
    repoUrl: url,
    defaultBranch: "main",
    credentials: { token: "tok" },
  };
}

describe("openGenerationWorktree", () => {
  it("apre un worktree leggibile (createWorktreeReader), espone il commit HEAD, poi lo chiude", async () => {
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const project = projectFor(upstream.url);

    const wt = await openGenerationWorktree(mirrors, project);

    // commitSha = HEAD effettivo del checkout (lo sha seedato nell'upstream).
    expect(wt.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(wt.commitSha).toBe(upstream.sha);
    // La directory esiste finché il worktree è aperto.
    expect(existsSync(wt.dir)).toBe(true);

    // Lettura via il reader reale: i file tracciati del repo sono visibili.
    const reader = createWorktreeReader(wt.dir);
    const files = await reader.list();
    const paths = files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("index.ts");
    const manifest = await reader.read("package.json");
    expect(manifest).toContain("demo");

    // close() smonta il worktree: la directory sparisce.
    await wt.close();
    expect(existsSync(wt.dir)).toBe(false);

    // Idempotente: una seconda close non lancia.
    await expect(wt.close()).resolves.toBeUndefined();
  });

  it("apre worktree successivi per lo stesso progetto (branch riallineato da switch -C)", async () => {
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const project = projectFor(upstream.url);

    const first = await openGenerationWorktree(mirrors, project);
    await first.close();
    // Un secondo open sullo stesso progetto/branch non deve fallire (switch -C
    // riallinea il branch effimero, niente residui bloccanti).
    const second = await openGenerationWorktree(mirrors, project);
    expect(existsSync(second.dir)).toBe(true);
    expect(second.commitSha).toBe(upstream.sha);
    await second.close();
  });
});
