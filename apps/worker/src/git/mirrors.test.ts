import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitCommandError,
  InvalidBranchNameError,
  InvalidDefaultBranchError,
  MirrorManager,
  MirrorNotFoundError,
  mirrorRemoteUrl,
  mirrorSlug,
  type MirrorProject,
} from "./mirrors.js";

// I test usano repo git locali REALI (niente rete): un bare repo in tmpdir fa
// da "origin" upstream, seedato con commit veri via execa. Gli URL file:// non
// richiedono auth: l'iniezione dell'header è unit-testata in @stubwise/git
// (getAuthHeader) e qui tramite il test di redazione (clone https verso una
// porta chiusa su localhost, che fallisce senza toccare la rete esterna).

// Ogni test spawna decine di processi git reali: quando la suite completa
// gira in parallelo (es. accanto ai test queue su Docker) i 5s di default
// non bastano sotto carico.
vi.setConfig({ testTimeout: 60_000 });

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

const COMMIT_ARGS = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

interface Upstream {
  dir: string;
  url: string;
  /** Aggiunge un commit su main nell'upstream e restituisce lo sha. */
  addCommit: (fileName: string, content: string) => Promise<string>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-mirrors-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeUpstream(root: string): Promise<Upstream> {
  const dir = join(root, "upstream.git");
  await execa("git", ["init", "--bare", "-b", "main", dir]);
  const work = join(root, "seed-work");
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", dir], work);
  const addCommit = async (fileName: string, content: string): Promise<string> => {
    await writeFile(join(work, fileName), content);
    await git(["add", "."], work);
    await git([...COMMIT_ARGS, "commit", "-m", `add ${fileName}`], work);
    await git(["push", "origin", "main"], work);
    return git(["rev-parse", "HEAD"], work);
  };
  await addCommit("README.md", "hello\n");
  return { dir, url: pathToFileURL(dir).href, addCommit };
}

function projectFor(upstream: Upstream): MirrorProject {
  return {
    provider: "github",
    repoUrl: upstream.url,
    defaultBranch: "main",
    credentials: { token: "irrelevant-for-file-urls" },
  };
}

async function makeFixture(): Promise<{ manager: MirrorManager; upstream: Upstream; mirrorsDir: string }> {
  const root = await makeRoot();
  const upstream = await makeUpstream(root);
  const mirrorsDir = join(root, "mirrors");
  return { manager: new MirrorManager({ mirrorsDir }), upstream, mirrorsDir };
}

describe("mirrorSlug", () => {
  it("deriva uno slug stabile e filesystem-safe dall'URL del repo", () => {
    const slug = mirrorSlug("https://github.com/acme/my-repo");
    expect(slug).toMatch(/^[a-z0-9._-]+$/);
    expect(slug).toContain("github.com");
    expect(slug).toContain("acme");
    expect(slug).toContain("my-repo");
    expect(mirrorSlug("https://github.com/acme/my-repo")).toBe(slug);
  });

  it("distingue URL diversi anche quando la sanitizzazione li renderebbe uguali", () => {
    expect(mirrorSlug("https://github.com/acme/my-repo")).not.toBe(
      mirrorSlug("https://github.com/acme/my_repo")
    );
    expect(mirrorSlug("https://github.com/acme/my-repo")).not.toBe(
      mirrorSlug("https://github.com/acme-my/repo")
    );
  });
});

describe("mirrorRemoteUrl", () => {
  it("restituisce un URL https privo di credenziali", () => {
    const url = mirrorRemoteUrl({
      provider: "github",
      repoUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
      credentials: { token: "sekret-token" },
    });
    expect(url).toBe("https://github.com/acme/repo.git");
    expect(url).not.toContain("sekret-token");
  });

  it("lascia invariati gli URL non-https (fixture file:// nei test)", () => {
    const repoUrl = "file:///tmp/upstream.git";
    expect(
      mirrorRemoteUrl({
        provider: "github",
        repoUrl,
        defaultBranch: "main",
        credentials: { token: "t" },
      })
    ).toBe(repoUrl);
  });
});

describe("MirrorManager.ensureMirror", () => {
  it("clona bare al primo uso, con remote credential-free", async () => {
    const { manager, upstream, mirrorsDir } = await makeFixture();
    const project = projectFor(upstream);

    const dir = await manager.ensureMirror(project);

    expect(dir.startsWith(mirrorsDir)).toBe(true);
    expect(existsSync(join(dir, "HEAD"))).toBe(true);
    expect(await git(["rev-parse", "--is-bare-repository"], dir)).toBe("true");
    // Il remote salvato nella config del mirror NON deve contenere credenziali.
    const remoteUrl = await git(["config", "remote.origin.url"], dir);
    expect(remoteUrl).toBe(upstream.url);
    expect(remoteUrl).not.toContain("irrelevant-for-file-urls");
  });

  it("crea la directory dei mirror con permessi 0700 (difesa in profondità)", async () => {
    const { manager, upstream, mirrorsDir } = await makeFixture();
    await manager.ensureMirror(projectFor(upstream));
    const mode = (await stat(mirrorsDir)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("restringe a 0700 anche una mirrorsDir preesistente con permessi larghi", async () => {
    const root = await makeRoot();
    const upstream = await makeUpstream(root);
    const mirrorsDir = join(root, "mirrors");
    await mkdir(mirrorsDir, { recursive: true, mode: 0o755 });
    const manager = new MirrorManager({ mirrorsDir });

    await manager.ensureMirror(projectFor(upstream));

    expect((await stat(mirrorsDir)).mode & 0o777).toBe(0o700);
  });

  it("ai successivi fa fetch --prune e vede i nuovi commit upstream", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);

    const dir = await manager.ensureMirror(project);
    const firstSha = await git(["rev-parse", "main"], dir);

    const newSha = await upstream.addCommit("feature.txt", "new stuff\n");
    expect(newSha).not.toBe(firstSha);

    const dirAgain = await manager.ensureMirror(project);
    expect(dirAgain).toBe(dir);
    expect(await git(["rev-parse", "main"], dir)).toBe(newSha);
  });

  it("serializza chiamate concorrenti sullo stesso repo (entrambe riescono)", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);

    const dirs = await Promise.all([
      manager.ensureMirror(project),
      manager.ensureMirror(project),
      manager.ensureMirror(project),
    ]);

    expect(new Set(dirs).size).toBe(1);
    const dir = dirs[0] as string;
    // Il mirror è integro e aggiornabile dopo le chiamate concorrenti.
    expect(await git(["rev-parse", "--is-bare-repository"], dir)).toBe("true");
    await expect(manager.ensureMirror(project)).resolves.toBe(dir);
  });

  it("ripulisce la directory se il clone fallisce e non espone le credenziali nell'errore", async () => {
    const root = await makeRoot();
    const mirrorsDir = join(root, "mirrors");
    const manager = new MirrorManager({ mirrorsDir, fetchTimeoutMs: 30_000, cloneTimeoutMs: 30_000 });
    const token = "super-secret-token";
    // Porta chiusa su localhost: il clone https fallisce subito, niente rete esterna.
    const project: MirrorProject = {
      provider: "github",
      repoUrl: "https://127.0.0.1:1/acme/repo",
      defaultBranch: "main",
      credentials: { token },
    };

    const error = await manager.ensureMirror(project).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(GitCommandError);
    const message = (error as GitCommandError).message;
    // L'auth viaggia via env (GIT_CONFIG_*), quindi il comando echeggiato
    // nell'errore non deve contenere né http.extraheader né l'header...
    expect(message).not.toContain("http.extraheader");
    expect(message).not.toContain("Authorization");
    // ...e né il token né la sua forma base64 compaiono nell'errore.
    expect(message).not.toContain(token);
    expect(message).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
    // Nessun residuo parziale: un retry ripartirà da un clone pulito.
    expect(existsSync(manager.mirrorDirFor(project))).toBe(false);
  });
});

describe("MirrorManager.withWorktree", () => {
  it("crea un worktree sul default branch con il nuovo branch attivo e restituisce il risultato di fn", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);

    let seenDir = "";
    let seenBranch = "";
    let seenReadme = false;
    const result = await manager.withWorktree(project, "stubwise/ticket-7", async (dir) => {
      seenDir = dir;
      seenBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
      seenReadme = existsSync(join(dir, "README.md"));
      return 42;
    });

    expect(result).toBe(42);
    expect(seenBranch).toBe("stubwise/ticket-7");
    expect(seenReadme).toBe(true);
    // Il worktree è stato rimosso...
    expect(existsSync(seenDir)).toBe(false);
    // ...e anche il branch effimero nel mirror è stato ripulito.
    const mirrorDir = manager.mirrorDirFor(project);
    expect(await git(["branch", "--list", "stubwise/ticket-7"], mirrorDir)).toBe("");
    expect(await git(["worktree", "list", "--porcelain"], mirrorDir)).not.toContain(seenDir);
  });

  it("rimuove sempre il worktree e il branch anche se fn lancia", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);

    let seenDir = "";
    const boom = new Error("fn esplosa");
    await expect(
      manager.withWorktree(project, "stubwise/ticket-8", async (dir) => {
        seenDir = dir;
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(seenDir).not.toBe("");
    expect(existsSync(seenDir)).toBe(false);
    const mirrorDir = manager.mirrorDirFor(project);
    expect(await git(["branch", "--list", "stubwise/ticket-8"], mirrorDir)).toBe("");
    expect(await git(["worktree", "list", "--porcelain"], mirrorDir)).not.toContain(seenDir);
  });

  it("rifiuta un defaultBranch malevolo che inizia con '-' senza passarlo a git", async () => {
    const { manager, upstream } = await makeFixture();
    let called = false;
    for (const defaultBranch of ["--orphan", "-b", ""]) {
      const project: MirrorProject = { ...projectFor(upstream), defaultBranch };
      await expect(
        manager.withWorktree(project, "stubwise/ticket-evil", async () => {
          called = true;
        })
      ).rejects.toBeInstanceOf(InvalidDefaultBranchError);
    }
    expect(called).toBe(false);
  });

  it("rifiuta nomi branch non stubwise/ senza eseguire fn", async () => {
    const { manager, upstream } = await makeFixture();
    let called = false;
    await expect(
      manager.withWorktree(projectFor(upstream), "feature/x", async () => {
        called = true;
      })
    ).rejects.toBeInstanceOf(InvalidBranchNameError);
    expect(called).toBe(false);
  });
});

describe("MirrorManager.getChangedFiles", () => {
  it("ritorna i file cambiati tra due commit (mirror aggiornato via ensureMirror)", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);

    // README.md è già nel seed (primo commit di makeUpstream).
    const fromSha = await upstream.addCommit("a.txt", "alpha\n");
    await upstream.addCommit("b.txt", "beta\n");
    const toSha = await upstream.addCommit("c.txt", "gamma\n");

    const changed = await manager.getChangedFiles(project, fromSha, toSha);

    // ensureMirror ha fatto fetch: i nuovi commit upstream sono visibili.
    expect(changed.sort()).toEqual(["b.txt", "c.txt"]);
    // Nessuna riga vuota nel risultato.
    expect(changed.every((f) => f.length > 0)).toBe(true);
  });

  it("propaga l'errore se uno degli sha non è raggiungibile nel mirror", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const realSha = await git(["rev-parse", "main"], await manager.ensureMirror(project));

    const error = await manager.getChangedFiles(project, "0".repeat(40), realSha).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(GitCommandError);
  });
});

describe("MirrorManager.getCommitMessages", () => {
  it("ritorna sha+subject dei commit nel range, dal più recente", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);

    const fromSha = await upstream.addCommit("a.txt", "alpha\n");
    const midSha = await upstream.addCommit("b.txt", "beta\n");
    const toSha = await upstream.addCommit("c.txt", "gamma\n");

    const commits = await manager.getCommitMessages(project, fromSha, toSha);

    // Range esclusivo su fromSha: solo i due commit successivi, recente prima.
    expect(commits).toEqual([
      { sha: toSha, subject: "add c.txt" },
      { sha: midSha, subject: "add b.txt" },
    ]);
  });

  it("ritorna lista vuota quando from==to (nessun commit nel range)", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const sha = await upstream.addCommit("a.txt", "alpha\n");

    expect(await manager.getCommitMessages(project, sha, sha)).toEqual([]);
  });

  it("preserva subject con spazi (split solo sul primo TAB)", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const fromSha = await git(["rev-parse", "main"], await manager.ensureMirror(project));
    // Commit con un subject che contiene spazi multipli.
    const toSha = await upstream.addCommit("multi word.txt", "x\n");

    const commits = await manager.getCommitMessages(project, fromSha, toSha);
    expect(commits).toEqual([{ sha: toSha, subject: "add multi word.txt" }]);
  });

  it("propaga l'errore se uno degli sha non è raggiungibile nel mirror", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const realSha = await git(["rev-parse", "main"], await manager.ensureMirror(project));

    const error = await manager.getCommitMessages(project, "0".repeat(40), realSha).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(GitCommandError);
  });
});

describe("MirrorManager.pushBranch", () => {
  it("pubblica il branch sull'upstream (push eseguito nel mirror, object store condiviso col worktree)", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);

    let pushedSha = "";
    await manager.withWorktree(project, "stubwise/ticket-9", async (dir) => {
      await writeFile(join(dir, "fix.txt"), "fixed\n");
      await git(["add", "."], dir);
      await git([...COMMIT_ARGS, "commit", "-m", "fix: il bug"], dir);
      pushedSha = await git(["rev-parse", "HEAD"], dir);
      await manager.pushBranch(project, "stubwise/ticket-9");
    });

    expect(pushedSha).not.toBe("");
    expect(await git(["rev-parse", "refs/heads/stubwise/ticket-9"], upstream.dir)).toBe(pushedSha);
    // main upstream non è stato toccato dal push (niente push --mirror).
    expect(await git(["rev-parse", "main"], upstream.dir)).not.toBe(pushedSha);
  });

  it("rifiuta branch che non iniziano con stubwise/ prima di qualunque invocazione git", async () => {
    const root = await makeRoot();
    // mirrorsDir vuota e nessun ensureMirror: se la validazione non venisse
    // prima di tutto, otterremmo un errore "mirror inesistente", non
    // InvalidBranchNameError.
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const project: MirrorProject = {
      provider: "github",
      repoUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
      credentials: { token: "t" },
    };

    for (const branch of ["main", "feature/stubwise", "stubwise", ""]) {
      await expect(manager.pushBranch(project, branch)).rejects.toBeInstanceOf(InvalidBranchNameError);
    }
  });

  it("rifiuta nomi branch con caratteri pericolosi anche se col prefisso giusto", async () => {
    const root = await makeRoot();
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const project: MirrorProject = {
      provider: "github",
      repoUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
      credentials: { token: "t" },
    };

    for (const branch of ["stubwise/a..b", "stubwise/-evil", "stubwise/spazio no", "stubwise/x;rm"]) {
      await expect(manager.pushBranch(project, branch)).rejects.toBeInstanceOf(InvalidBranchNameError);
    }
  });

  it("fallisce con MirrorNotFoundError se il mirror non esiste ancora", async () => {
    const root = await makeRoot();
    const mirrorsDir = join(root, "mirrors");
    await mkdir(mirrorsDir, { recursive: true });
    const manager = new MirrorManager({ mirrorsDir });
    const project: MirrorProject = {
      provider: "github",
      repoUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
      credentials: { token: "t" },
    };

    const error = await manager.pushBranch(project, "stubwise/ticket-1").then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(MirrorNotFoundError);
    expect((error as Error).message).toMatch(/mirror/i);
  });
});
