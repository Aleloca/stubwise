import { getProvider, parseRepoUrl, type ProjectGitConfig } from "@stubwise/git";
import type { GitProviderKind } from "@stubwise/shared";
import { execa } from "execa";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mirror bare locali + worktree effimeri per la pipeline AI.
 *
 * Modello: per ogni progetto teniamo un `git clone --mirror` persistente in
 * `mirrorsDir` (clone una volta, poi `git fetch --prune`). Ogni job lavora in
 * un worktree temporaneo agganciato al mirror: i worktree CONDIVIDONO
 * l'object store e i ref del mirror, quindi un commit fatto nel worktree e il
 * branch creato con `git switch -C` vivono nel mirror anche dopo la rimozione
 * del worktree. È per questo che `pushBranch` viene eseguito DENTRO il mirror
 * (`git push origin <branch>:refs/heads/<branch>`): il branch ref sta lì.
 *
 * Sicurezza credenziali (requisito review Task 20) — strategia scelta:
 * iniezione per-invocazione dell'header Authorization via
 * `git -c http.extraheader=...`, calcolato da GitProvider.getAuthHeader.
 * Il remote URL salvato nella config del mirror è SEMPRE credential-free
 * (mirrorRemoteUrl): nessun token finisce su disco né in `git config`.
 * Abbiamo preferito `-c http.extraheader` a GIT_ASKPASS perché non richiede
 * uno script helper su disco e copre clone/fetch/push in modo uniforme.
 * Difesa in profondità: `mirrorsDir` è creata con mode 0700 comunque, e ogni
 * errore git viene redatto (token/header mai nei messaggi o nei log).
 *
 * Limite noto (documentato per Task 24): due job CONCORRENTI sullo stesso
 * progetto si serializzano solo su ensureMirror; un `fetch --prune` mentre un
 * altro job ha un worktree aperto su un branch stubwise/* non ancora pushato
 * CANCELLA quel ref (verificato: il refspec mirror +refs/*:refs/* pruna anche
 * i branch checked-out nei worktree). Finché il worker processa al più un job
 * per progetto alla volta non è un problema; in caso contrario serializzare i
 * job per progetto a monte.
 */

export interface MirrorProject extends ProjectGitConfig {
  provider: GitProviderKind;
}

export interface MirrorManagerOptions {
  /** Directory che contiene tutti i mirror bare (creata con mode 0700). */
  mirrorsDir: string;
  /** Timeout per le singole invocazioni git (default 120s). */
  fetchTimeoutMs?: number;
}

/** Errore tipato per nomi branch rifiutati (deve essere `stubwise/<safe>`). */
export class InvalidBranchNameError extends Error {
  constructor(branch: string) {
    super(
      `Nome branch non valido: "${branch}" — deve iniziare con "stubwise/" e contenere solo [A-Za-z0-9._/-] senza "..", segmenti vuoti o iniziali con "-"`
    );
    this.name = "InvalidBranchNameError";
  }
}

/**
 * Errore di un comando git: include il comando (con i segreti redatti) e lo
 * stderr troncato/redatto. MAI il valore dell'header di auth o il token.
 */
export class GitCommandError extends Error {
  readonly exitCode: number | undefined;
  /** stderr redatto e troncato agli ultimi 500 caratteri. */
  readonly stderr: string;

  constructor(message: string, exitCode: number | undefined, stderr: string) {
    super(message);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Slug stabile e filesystem-safe per la directory del mirror: parte
 * leggibile (URL sanitizzato) + suffisso sha256 dell'URL originale. Il
 * suffisso garantisce l'assenza di collisioni anche quando la sanitizzazione
 * appiattirebbe URL diversi sulla stessa stringa (es. `my_repo` vs `my-repo`,
 * o trattini che si confondono con i separatori host/owner/repo).
 */
export function mirrorSlug(repoUrl: string): string {
  const hash = createHash("sha256").update(repoUrl).digest("hex").slice(0, 12);
  const readable = repoUrl
    .replace(/^[a-z+.-]+:\/\//i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase()
    .slice(0, 100);
  return readable.length > 0 ? `${readable}-${hash}` : hash;
}

/**
 * URL remoto credential-free da salvare nella config del mirror. Per https
 * normalizza in `https://host/owner/repo.git` (le credenziali NON vengono mai
 * embeddate nell'URL: l'auth viaggia per-invocazione via http.extraheader).
 * Gli URL non-https (file:// nelle fixture di test) passano invariati.
 */
export function mirrorRemoteUrl(project: MirrorProject): string {
  if (!project.repoUrl.startsWith("https://")) return project.repoUrl;
  const { host, owner, repo } = parseRepoUrl(project.repoUrl);
  return `https://${host}/${owner}/${repo}.git`;
}

const BRANCH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertBranchName(branch: string): void {
  const prefix = "stubwise/";
  if (!branch.startsWith(prefix)) throw new InvalidBranchNameError(branch);
  if (branch.includes("..")) throw new InvalidBranchNameError(branch);
  const segments = branch.slice(prefix.length).split("/");
  if (segments.length === 0 || segments.some((s) => !BRANCH_SEGMENT.test(s))) {
    throw new InvalidBranchNameError(branch);
  }
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Segreti da redarre in qualunque messaggio d'errore relativo al progetto. */
function secretsOf(project: MirrorProject): string[] {
  const secrets: string[] = [project.credentials.token];
  if (project.credentials.username) secrets.push(project.credentials.username);
  try {
    secrets.push(getProvider(project.provider).getAuthHeader(project));
  } catch {
    // es. credenziali incomplete: il token nudo è comunque in lista.
  }
  return secrets.filter((s) => s.length > 0);
}

interface RunGitOptions {
  cwd?: string;
  /** Se presente, inietta l'auth per-invocazione e redige i suoi segreti. */
  auth?: MirrorProject;
  timeoutMs: number;
}

async function runGit(args: string[], opts: RunGitOptions): Promise<string> {
  const secrets = opts.auth ? secretsOf(opts.auth) : [];
  const authArgs =
    opts.auth && opts.auth.repoUrl.startsWith("https://")
      ? ["-c", `http.extraheader=Authorization: ${getProvider(opts.auth.provider).getAuthHeader(opts.auth)}`]
      : [];
  const fullArgs = [...authArgs, ...args];
  try {
    const { stdout } = await execa("git", fullArgs, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      // Mai prompt interattivi: meglio fallire subito che un worker appeso.
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const e = error as { exitCode?: number; stderr?: unknown; timedOut?: boolean };
    const stderr = redactSecrets(typeof e.stderr === "string" ? e.stderr.slice(-500) : "", secrets);
    const command = redactSecrets(["git", ...fullArgs].join(" "), secrets);
    const reason = e.timedOut === true ? `timeout dopo ${opts.timeoutMs}ms` : `exit ${e.exitCode ?? "?"}`;
    throw new GitCommandError(`Comando fallito (${reason}): ${command}\n${stderr}`, e.exitCode, stderr);
  }
}

export class MirrorManager {
  private readonly mirrorsDir: string;
  private readonly fetchTimeoutMs: number;
  /**
   * Lock per-repo in-process: catena di promise per directory di mirror.
   * Serializza le ensureMirror concorrenti sullo stesso repo (un solo
   * clone/fetch alla volta); repo diversi procedono in parallelo perché
   * hanno chiavi (e quindi catene) indipendenti.
   */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: MirrorManagerOptions) {
    this.mirrorsDir = options.mirrorsDir;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 120_000;
  }

  /** Path (deterministico) della directory del mirror per il progetto. */
  mirrorDirFor(project: MirrorProject): string {
    return join(this.mirrorsDir, mirrorSlug(project.repoUrl));
  }

  /**
   * Garantisce un mirror bare aggiornato: clona al primo uso (`clone
   * --mirror` con URL credential-free), altrimenti `fetch --prune`. Un clone
   * parziale (HEAD mancante, es. processo killato) viene rimosso e rifatto.
   */
  async ensureMirror(project: MirrorProject): Promise<string> {
    const dir = this.mirrorDirFor(project);
    return this.withRepoLock(dir, async () => {
      await mkdir(this.mirrorsDir, { recursive: true, mode: 0o700 });
      if (!existsSync(join(dir, "HEAD"))) {
        await rm(dir, { recursive: true, force: true });
        try {
          await this.git(["clone", "--mirror", mirrorRemoteUrl(project), dir], { auth: project });
        } catch (error) {
          // Niente residui parziali: il prossimo tentativo riparte da zero.
          await rm(dir, { recursive: true, force: true });
          throw error;
        }
      } else {
        await this.git(["fetch", "--prune", "origin"], { cwd: dir, auth: project });
      }
      return dir;
    });
  }

  /**
   * Esegue `fn` in un worktree temporaneo: mirror aggiornato, worktree
   * detached sul default branch, poi `git switch -C <branchName>` (il branch
   * vive nei ref del mirror, condivisi). Il worktree viene SEMPRE rimosso
   * (anche se `fn` lancia) e il branch effimero cancellato dal mirror: il
   * push verso l'upstream deve avvenire dentro `fn` (vedi pushBranch).
   */
  async withWorktree<T>(
    project: MirrorProject,
    branchName: string,
    fn: (dir: string) => Promise<T>
  ): Promise<T> {
    assertBranchName(branchName);
    const mirrorDir = await this.ensureMirror(project);
    const parent = await mkdtemp(join(tmpdir(), "stubwise-wt-"));
    const worktreeDir = join(parent, "wt");
    let worktreeAdded = false;
    try {
      await this.git(["worktree", "add", "--force", "--detach", worktreeDir, project.defaultBranch], {
        cwd: mirrorDir,
      });
      worktreeAdded = true;
      // -C (force): un branch residuo di un run precedente viene riallineato.
      await this.git(["switch", "-C", branchName], { cwd: worktreeDir });
      return await fn(worktreeDir);
    } finally {
      if (worktreeAdded) {
        try {
          await this.git(["worktree", "remove", "--force", worktreeDir], { cwd: mirrorDir });
        } catch {
          // Fallback: rimozione manuale + prune dei metadati orfani.
          await rm(worktreeDir, { recursive: true, force: true });
          await this.git(["worktree", "prune"], { cwd: mirrorDir }).catch(() => undefined);
        }
        // Branch effimero: best effort, un eventuale residuo viene comunque
        // riallineato da switch -C o ripulito dal fetch --prune successivo.
        await this.git(["branch", "-D", branchName], { cwd: mirrorDir }).catch(() => undefined);
      }
      await rm(parent, { recursive: true, force: true });
    }
  }

  /**
   * Pubblica `branchName` sull'upstream. Va chiamato DENTRO la callback di
   * withWorktree, dopo i commit: il push gira nel mirror (dove vive il ref)
   * con refspec esplicito. `clone --mirror` imposta remote.origin.mirror=true,
   * che trasformerebbe ogni push in un `push --mirror` (tutti i ref, con
   * delete inclusi): lo disattiviamo per-invocazione con -c.
   */
  async pushBranch(project: MirrorProject, branchName: string): Promise<void> {
    assertBranchName(branchName);
    const mirrorDir = this.mirrorDirFor(project);
    if (!existsSync(join(mirrorDir, "HEAD"))) {
      throw new Error(
        `Mirror inesistente per ${mirrorRemoteUrl(project)}: pushBranch va chiamato dentro withWorktree (dopo ensureMirror)`
      );
    }
    await this.git(
      ["-c", "remote.origin.mirror=false", "push", "origin", `${branchName}:refs/heads/${branchName}`],
      { cwd: mirrorDir, auth: project }
    );
  }

  private git(args: string[], opts: Omit<RunGitOptions, "timeoutMs">): Promise<string> {
    return runGit(args, { ...opts, timeoutMs: this.fetchTimeoutMs });
  }

  private async withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    // La catena memorizzata non rigetta mai: un fallimento non blocca i
    // chiamanti successivi (che ripartiranno con il proprio tentativo).
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }
}
