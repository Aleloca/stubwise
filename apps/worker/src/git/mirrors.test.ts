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
  InvalidShaError,
  InvalidTargetBranchError,
  MAX_DIFF_CHARS,
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
  /**
   * Crea (o riallinea) `branch` dalla main corrente, ci committa un file, lo
   * pusha e torna su main. Restituisce lo sha del commit: simula la source
   * branch di una PR non ancora mergiata.
   */
  addCommitOnBranch: (branch: string, fileName: string, content: string) => Promise<string>;
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

async function makeUpstream(root: string, name = "upstream"): Promise<Upstream> {
  const dir = join(root, `${name}.git`);
  await execa("git", ["init", "--bare", "-b", "main", dir]);
  const work = join(root, `${name}-seed-work`);
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", dir], work);
  const addCommit = async (fileName: string, content: string): Promise<string> => {
    await writeFile(join(work, fileName), content);
    await git(["add", "."], work);
    await git([...COMMIT_ARGS, "commit", "-m", `add ${fileName}`], work);
    await git(["push", "origin", "main"], work);
    return git(["rev-parse", "HEAD"], work);
  };
  const addCommitOnBranch = async (branch: string, fileName: string, content: string): Promise<string> => {
    await git(["switch", "-C", branch, "main"], work);
    await writeFile(join(work, fileName), content);
    await git(["add", "."], work);
    await git([...COMMIT_ARGS, "commit", "-m", `add ${fileName}`], work);
    await git(["push", "origin", branch], work);
    const sha = await git(["rev-parse", "HEAD"], work);
    await git(["switch", "main"], work);
    return sha;
  };
  await addCommit("README.md", "hello\n");
  return { dir, url: pathToFileURL(dir).href, addCommit, addCommitOnBranch };
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

  it("ripulisce i worktree orfani (dir sparita) che bloccherebbero il fetch --prune", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const dir = await manager.ensureMirror(project);

    // Simula il worktree di un fix lasciato orfano: lo crea su un branch
    // stubwise/* e poi ne CANCELLA la directory (come quando il worker si riavvia
    // e la dir effimera in /tmp sparisce). La registrazione resta e tiene
    // "checked out" il branch: senza prune, il fetch --prune fallirebbe (exit 128).
    const wtDir = join(dir, "..", "orphan-wt");
    await git(["worktree", "add", "--quiet", "-b", "stubwise/ticket-1", wtDir, "main"], dir);
    await rm(wtDir, { recursive: true, force: true });

    const newSha = await upstream.addCommit("post-orphan.txt", "x\n");
    // Deve riuscire (prune + fetch) e vedere i nuovi commit upstream.
    await expect(manager.ensureMirror(project)).resolves.toBe(dir);
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

describe("MirrorManager.withWorktreeAtSha", () => {
  it("monta un worktree detached allo sha e lo rimuove alla fine", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const shaA = await upstream.addCommit("a.txt", "alpha\n");
    await upstream.addCommit("b.txt", "beta\n");

    let seenDir = "";
    let seenHead = "";
    let seenA = false;
    let seenB = true;
    const result = await manager.withWorktreeAtSha(project, shaA, async (dir) => {
      seenDir = dir;
      seenHead = await git(["rev-parse", "HEAD"], dir);
      seenA = existsSync(join(dir, "a.txt"));
      seenB = existsSync(join(dir, "b.txt"));
      return 7;
    });

    expect(result).toBe(7);
    // HEAD è ESATTAMENTE lo sha richiesto (detached), non la punta di main...
    expect(seenHead).toBe(shaA);
    expect(seenA).toBe(true);
    // ...quindi il file del commit successivo non esiste nel worktree.
    expect(seenB).toBe(false);
    // Il worktree è stato rimosso e deregistrato dal mirror.
    expect(existsSync(seenDir)).toBe(false);
    const mirrorDir = manager.mirrorDirFor(project);
    expect(await git(["worktree", "list", "--porcelain"], mirrorDir)).not.toContain(seenDir);
  });

  it("rifiuta uno sha malformato con InvalidShaError senza eseguire alcun comando git", async () => {
    const root = await makeRoot();
    const mirrorsDir = join(root, "mirrors");
    const manager = new MirrorManager({ mirrorsDir });
    const project: MirrorProject = {
      provider: "github",
      repoUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
      credentials: { token: "t" },
    };

    let called = false;
    for (const sha of ["not-a-sha; rm -rf /", "", "--all", "HEAD", "abc123"]) {
      await expect(
        manager.withWorktreeAtSha(project, sha, async () => {
          called = true;
        })
      ).rejects.toBeInstanceOf(InvalidShaError);
    }
    expect(called).toBe(false);
    // Nessun ensureMirror (quindi nessun comando git): la mirrorsDir non esiste.
    expect(existsSync(mirrorsDir)).toBe(false);
  });

  it("rimuove il worktree anche se fn lancia", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const sha = await upstream.addCommit("a.txt", "alpha\n");

    let seenDir = "";
    const boom = new Error("fn esplosa");
    await expect(
      manager.withWorktreeAtSha(project, sha, async (dir) => {
        seenDir = dir;
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(seenDir).not.toBe("");
    expect(existsSync(seenDir)).toBe(false);
    const mirrorDir = manager.mirrorDirFor(project);
    expect(await git(["worktree", "list", "--porcelain"], mirrorDir)).not.toContain(seenDir);
  });
});

describe("MirrorManager.getPrDiff", () => {
  it("ritorna il diff dal merge-base col branch target", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    // feature parte dalla main corrente (seed); poi main avanza da sola.
    const shaC = await upstream.addCommitOnBranch("feature", "feature.txt", "nuova feature\n");
    await upstream.addCommit("main-only.txt", "solo main\n");

    const { diff, truncated } = await manager.getPrDiff(project, shaC, "main");

    // Il diff è dal merge-base (il seed), non dalla punta di main: contiene la
    // feature ma NON i commit successivi di main.
    expect(diff).toContain("feature.txt");
    expect(diff).not.toContain("main-only.txt");
    expect(truncated).toBe(false);
  });

  it("tronca i diff enormi e segnala truncated", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const shaBig = await upstream.addCommitOnBranch(
      "big",
      "big.txt",
      `${"x".repeat(MAX_DIFF_CHARS + 50_000)}\n`
    );

    const { diff, truncated } = await manager.getPrDiff(project, shaBig, "main");

    expect(truncated).toBe(true);
    expect(diff.length).toBe(MAX_DIFF_CHARS);
  });

  it("rifiuta sha e target branch malformati con errori tipati, senza comandi git", async () => {
    const root = await makeRoot();
    const mirrorsDir = join(root, "mirrors");
    const manager = new MirrorManager({ mirrorsDir });
    const project: MirrorProject = {
      provider: "github",
      repoUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
      credentials: { token: "t" },
    };
    const validSha = "a".repeat(40);

    for (const target of ["-evil", "a..b", "", "spazio no", "a//b", "-"]) {
      await expect(manager.getPrDiff(project, validSha, target)).rejects.toBeInstanceOf(
        InvalidTargetBranchError
      );
    }
    await expect(manager.getPrDiff(project, "not-a-sha", "main")).rejects.toBeInstanceOf(InvalidShaError);
    // Nessun ensureMirror (quindi nessun comando git): la mirrorsDir non esiste.
    expect(existsSync(mirrorsDir)).toBe(false);
  });
});

describe("MirrorManager.getCommitDiff", () => {
  it("ritorna il diff del singolo commit (header + righe modificate) non troncato", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const sha = await upstream.addCommit("greeting.txt", "ciao mondo\n");

    const { diff, truncated } = await manager.getCommitDiff(project, sha);

    // `git show` include l'header del commit (sha completo) e il diff.
    expect(diff).toContain(sha);
    expect(diff).toContain("greeting.txt");
    expect(diff).toContain("+ciao mondo");
    expect(truncated).toBe(false);
  });

  it("tronca i commit enormi a MAX_DIFF_CHARS e segnala truncated", async () => {
    const { manager, upstream } = await makeFixture();
    const project = projectFor(upstream);
    const shaBig = await upstream.addCommit("big.txt", `${"x".repeat(MAX_DIFF_CHARS + 50_000)}\n`);

    const { diff, truncated } = await manager.getCommitDiff(project, shaBig);

    expect(truncated).toBe(true);
    expect(diff.length).toBe(MAX_DIFF_CHARS);
  });

  it("rifiuta uno sha malformato con InvalidShaError senza eseguire alcun comando git", async () => {
    const root = await makeRoot();
    const mirrorsDir = join(root, "mirrors");
    const manager = new MirrorManager({ mirrorsDir });
    const project: MirrorProject = {
      provider: "github",
      repoUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
      credentials: { token: "t" },
    };

    await expect(manager.getCommitDiff(project, "not-a-sha")).rejects.toBeInstanceOf(InvalidShaError);
    // Nessun ensureMirror (quindi nessun comando git): la mirrorsDir non esiste.
    expect(existsSync(mirrorsDir)).toBe(false);
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

describe("MirrorManager.getCommitsInRange", () => {
  // Setup dedicato: un upstream con commit ad author-date/autori CONTROLLATI
  // (via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE), così da poter asserire la finestra.
  async function commitWithDate(
    work: string,
    opts: { file: string; content: string | Buffer; name: string; email: string; date: string; message: string }
  ): Promise<string> {
    await writeFile(join(work, opts.file), opts.content);
    await git(["add", "."], work);
    await execa(
      "git",
      ["-c", `user.name=${opts.name}`, "-c", `user.email=${opts.email}`, "commit", "-m", opts.message],
      { cwd: work, env: { GIT_AUTHOR_DATE: opts.date, GIT_COMMITTER_DATE: opts.date } }
    );
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: work });
    return stdout;
  }

  async function makeDatedUpstream(): Promise<{ manager: MirrorManager; project: MirrorProject; work: string }> {
    const root = await makeRoot();
    const bare = join(root, "up.git");
    await execa("git", ["init", "--bare", "-b", "main", bare]);
    const work = join(root, "work");
    await execa("git", ["init", "-b", "main", work]);
    await git(["remote", "add", "origin", bare], work);
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const project: MirrorProject = {
      provider: "github",
      repoUrl: pathToFileURL(bare).href,
      defaultBranch: "main",
      credentials: { token: "t" },
    };
    return { manager, project, work };
  }

  const SINCE = new Date("2026-07-10T00:00:00Z");
  const UNTIL = new Date("2026-07-11T00:00:00Z");

  it("ritorna solo i commit dentro la finestra, con autore/email/data/subject e additions", async () => {
    const { manager, project, work } = await makeDatedUpstream();
    // Fuori finestra (prima di SINCE).
    await commitWithDate(work, {
      file: "old.txt",
      content: "old\n",
      name: "Old Dev",
      email: "old@x.it",
      date: "2026-07-09T12:00:00Z",
      message: "chore: vecchio",
    });
    // Dentro la finestra.
    const inSha = await commitWithDate(work, {
      file: "new.txt",
      content: "line1\nline2\nline3\n",
      name: "Dev X",
      email: "dev@x.it",
      date: "2026-07-10T12:00:00Z",
      message: "feat: nuova feature",
    });
    await git(["push", "origin", "main"], work);

    const commits = await manager.getCommitsInRange(project, SINCE, UNTIL);

    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe(inSha);
    expect(commits[0]!.authorName).toBe("Dev X");
    expect(commits[0]!.authorEmail).toBe("dev@x.it");
    expect(commits[0]!.subject).toBe("feat: nuova feature");
    expect(commits[0]!.date).toContain("2026-07-10");
    expect(commits[0]!.isMerge).toBe(false);
    expect(commits[0]!.additions).toBe(3);
    expect(commits[0]!.deletions).toBe(0);
  });

  it("marca isMerge sui merge commit (più di un parent)", async () => {
    const { manager, project, work } = await makeDatedUpstream();
    await commitWithDate(work, {
      file: "base.txt",
      content: "base\n",
      name: "Dev",
      email: "dev@x.it",
      date: "2026-07-10T08:00:00Z",
      message: "base",
    });
    await git(["switch", "-C", "feature", "main"], work);
    await commitWithDate(work, {
      file: "feat.txt",
      content: "feat\n",
      name: "Dev",
      email: "dev@x.it",
      date: "2026-07-10T09:00:00Z",
      message: "on feature",
    });
    await git(["switch", "main"], work);
    // Merge non fast-forward: genera un commit con due parent. Data controllata.
    await execa(
      "git",
      ["-c", "user.name=Dev", "-c", "user.email=dev@x.it", "merge", "--no-ff", "-m", "merge feature", "feature"],
      { cwd: work, env: { GIT_AUTHOR_DATE: "2026-07-10T10:00:00Z", GIT_COMMITTER_DATE: "2026-07-10T10:00:00Z" } }
    );
    await git(["push", "origin", "main"], work);

    const commits = await manager.getCommitsInRange(project, SINCE, UNTIL);
    const merge = commits.find((c) => c.subject === "merge feature");
    expect(merge).toBeDefined();
    expect(merge!.isMerge).toBe(true);
    // I commit non-merge nella finestra non sono flaggati.
    expect(commits.filter((c) => c.subject !== "merge feature").every((c) => !c.isMerge)).toBe(true);
  });

  it("conta 0 righe per i file binari (numstat '-') ma include comunque il commit", async () => {
    const { manager, project, work } = await makeDatedUpstream();
    // Un file con byte NUL è rilevato binario da git → numstat "-\t-".
    await commitWithDate(work, {
      file: "blob.bin",
      content: Buffer.from([0, 1, 2, 0, 255, 0, 42]),
      name: "Dev",
      email: "dev@x.it",
      date: "2026-07-10T12:00:00Z",
      message: "add binary",
    });
    await git(["push", "origin", "main"], work);

    const commits = await manager.getCommitsInRange(project, SINCE, UNTIL);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe("add binary");
    expect(commits[0]!.additions).toBe(0);
    expect(commits[0]!.deletions).toBe(0);
  });

  // Commit con author-date e committer-date DISTINTE: fissa la semantica del
  // filtro (git usa la committer date) e del campo `date` riportato.
  async function commitWithSplitDate(
    work: string,
    opts: {
      file: string;
      content: string;
      name: string;
      email: string;
      authorDate: string;
      committerDate: string;
      message: string;
    }
  ): Promise<string> {
    await writeFile(join(work, opts.file), opts.content);
    await git(["add", "."], work);
    await execa(
      "git",
      ["-c", `user.name=${opts.name}`, "-c", `user.email=${opts.email}`, "commit", "-m", opts.message],
      { cwd: work, env: { GIT_AUTHOR_DATE: opts.authorDate, GIT_COMMITTER_DATE: opts.committerDate } }
    );
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: work });
    return stdout;
  }

  it("filtra e riporta la COMMITTER date: author fuori finestra, committer dentro ⇒ incluso", async () => {
    const { manager, project, work } = await makeDatedUpstream();
    // Author date PRIMA della finestra, committer date DENTRO: git filtra sulla
    // committer date, quindi il commit deve essere incluso.
    const sha = await commitWithSplitDate(work, {
      file: "rebased.txt",
      content: "x\n",
      name: "Dev X",
      email: "dev@x.it",
      authorDate: "2026-07-09T12:00:00Z", // fuori (prima di SINCE)
      committerDate: "2026-07-10T12:00:00Z", // dentro
      message: "feat: cherry-picked",
    });
    await git(["push", "origin", "main"], work);

    const commits = await manager.getCommitsInRange(project, SINCE, UNTIL);

    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe(sha);
    // Il campo `date` è la COMMITTER date (dentro finestra), non l'author date.
    expect(commits[0]!.date).toContain("2026-07-10");
    expect(commits[0]!.date).not.toContain("2026-07-09");
  });

  it("caso simmetrico: author dentro, committer fuori ⇒ escluso", async () => {
    const { manager, project, work } = await makeDatedUpstream();
    // Author date DENTRO la finestra ma committer date PRIMA: il filtro sulla
    // committer date lo esclude.
    await commitWithSplitDate(work, {
      file: "amended.txt",
      content: "y\n",
      name: "Dev Y",
      email: "y@x.it",
      authorDate: "2026-07-10T12:00:00Z", // dentro
      committerDate: "2026-07-09T12:00:00Z", // fuori (prima di SINCE)
      message: "feat: author dentro committer fuori",
    });
    await git(["push", "origin", "main"], work);

    expect(await manager.getCommitsInRange(project, SINCE, UNTIL)).toEqual([]);
  });

  it("ritorna lista vuota quando nessun commit cade nella finestra", async () => {
    const { manager, project, work } = await makeDatedUpstream();
    await commitWithDate(work, {
      file: "old.txt",
      content: "old\n",
      name: "Dev",
      email: "dev@x.it",
      date: "2026-07-09T12:00:00Z",
      message: "prima della finestra",
    });
    await git(["push", "origin", "main"], work);

    expect(await manager.getCommitsInRange(project, SINCE, UNTIL)).toEqual([]);
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

describe("MirrorManager.withProjectWorktrees", () => {
  it("materializza un worktree per repo sotto la stessa parent dir, ognuno sul branch dato", async () => {
    const root = await makeRoot();
    const upA = await makeUpstream(root, "repo-a");
    const upB = await makeUpstream(root, "repo-b");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const repos = [projectFor(upA), projectFor(upB)];

    let seenParent = "";
    const seen: { dir: string; branch: string; readme: boolean; underParent: boolean }[] = [];
    await manager.withProjectWorktrees(repos, "stubwise/ticket-42", async ({ parentDir, worktrees }) => {
      seenParent = parentDir;
      expect(worktrees).toHaveLength(2);
      // La lista rispecchia l'ordine dei repo passati.
      expect(worktrees.map((w) => w.project.repoUrl)).toEqual([upA.url, upB.url]);
      for (const wt of worktrees) {
        // Sottocartella deterministica per-repo (lo stesso slug del mirror).
        expect(wt.dir).toBe(join(parentDir, mirrorSlug(wt.project.repoUrl)));
        seen.push({
          dir: wt.dir,
          branch: await git(["rev-parse", "--abbrev-ref", "HEAD"], wt.dir),
          readme: existsSync(join(wt.dir, "README.md")),
          underParent: wt.dir.startsWith(parentDir + "/"),
        });
      }
    });

    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.branch).toBe("stubwise/ticket-42");
      expect(s.readme).toBe(true);
      expect(s.underParent).toBe(true);
    }
    // I due worktree stanno in sottocartelle distinte della stessa parent.
    expect(seen[0]?.dir).not.toBe(seen[1]?.dir);
    expect(seenParent).not.toBe("");
  });

  it("un commit in un worktree e pushBranch di quel repo pubblica sul suo upstream", async () => {
    const root = await makeRoot();
    const upA = await makeUpstream(root, "repo-a");
    const upB = await makeUpstream(root, "repo-b");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const projA = projectFor(upA);
    const projB = projectFor(upB);

    let pushedSha = "";
    await manager.withProjectWorktrees([projA, projB], "stubwise/ticket-77", async ({ worktrees }) => {
      const wtA = worktrees.find((w) => w.project.repoUrl === upA.url)!;
      await writeFile(join(wtA.dir, "fix.txt"), "fixed\n");
      await git(["add", "."], wtA.dir);
      await git([...COMMIT_ARGS, "commit", "-m", "fix: bug in A"], wtA.dir);
      pushedSha = await git(["rev-parse", "HEAD"], wtA.dir);
      await manager.pushBranch(projA, "stubwise/ticket-77");
    });

    // Il branch vive nel mirror di A e il push l'ha portato sul suo upstream.
    expect(pushedSha).not.toBe("");
    expect(await git(["rev-parse", "refs/heads/stubwise/ticket-77"], upA.dir)).toBe(pushedSha);
    // L'upstream di B NON ha il branch (push è per-repo).
    expect(await git(["branch", "--list", "stubwise/ticket-77"], upB.dir)).toBe("");
  });

  it("rimuove tutti i worktree, i branch effimeri e la parent dir dopo fn", async () => {
    const root = await makeRoot();
    const upA = await makeUpstream(root, "repo-a");
    const upB = await makeUpstream(root, "repo-b");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const projA = projectFor(upA);
    const projB = projectFor(upB);

    let parent = "";
    const dirs: string[] = [];
    await manager.withProjectWorktrees([projA, projB], "stubwise/ticket-88", async (ctx) => {
      parent = ctx.parentDir;
      for (const wt of ctx.worktrees) dirs.push(wt.dir);
    });

    // Parent dir e worktree rimossi.
    expect(existsSync(parent)).toBe(false);
    for (const d of dirs) expect(existsSync(d)).toBe(false);
    // Branch effimeri ripuliti da entrambi i mirror, nessun worktree registrato.
    for (const p of [projA, projB]) {
      const mirrorDir = manager.mirrorDirFor(p);
      expect(await git(["branch", "--list", "stubwise/ticket-88"], mirrorDir)).toBe("");
      expect(await git(["worktree", "list", "--porcelain"], mirrorDir)).not.toContain(parent);
    }
  });

  it("pulisce worktree e parent dir anche se fn lancia", async () => {
    const root = await makeRoot();
    const upA = await makeUpstream(root, "repo-a");
    const upB = await makeUpstream(root, "repo-b");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const repos = [projectFor(upA), projectFor(upB)];

    let parent = "";
    const boom = new Error("fn esplosa");
    await expect(
      manager.withProjectWorktrees(repos, "stubwise/ticket-99", async (ctx) => {
        parent = ctx.parentDir;
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(parent).not.toBe("");
    expect(existsSync(parent)).toBe(false);
    for (const p of repos) {
      const mirrorDir = manager.mirrorDirFor(p);
      expect(await git(["branch", "--list", "stubwise/ticket-99"], mirrorDir)).toBe("");
    }
  });

  it("se un repo non si aggancia a metà setup, smonta i worktree già creati, rimuove la parent dir e rilancia", async () => {
    const root = await makeRoot();
    const upA = await makeUpstream(root, "repo-a");
    const upB = await makeUpstream(root, "repo-b");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const projA = projectFor(upA);
    // Il secondo repo ha un defaultBranch inesistente: il `worktree add` su
    // refs/heads/<default> fallisce → setup fallito dopo aver aperto il 1°.
    const projBad: MirrorProject = { ...projectFor(upB), defaultBranch: "does-not-exist" };

    let fnCalled = false;
    let openedDirA = "";
    const error = await manager
      .withProjectWorktrees([projA, projBad], "stubwise/ticket-mid", async ({ worktrees }) => {
        fnCalled = true;
        openedDirA = worktrees[0]?.dir ?? "";
      })
      .then(
        () => null,
        (e: unknown) => e
      );

    // fn non è mai stata invocata (setup incompleto) e l'errore è propagato.
    expect(fnCalled).toBe(false);
    expect(error).toBeInstanceOf(GitCommandError);
    // La parent dir non deve sopravvivere: la ricaviamo dal mirror di A, il cui
    // worktree già aperto deve essere stato smontato.
    expect(openedDirA).toBe("");
    const mirrorA = manager.mirrorDirFor(projA);
    // Nessun worktree residuo registrato nel mirror di A e branch ripulito.
    expect(await git(["worktree", "list", "--porcelain"], mirrorA)).not.toContain("stubwise-proj-");
    expect(await git(["branch", "--list", "stubwise/ticket-mid"], mirrorA)).toBe("");
  });
});
