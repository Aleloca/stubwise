import { getProvider, parseRepoUrl, type ProjectGitConfig } from "@stubwise/git";
import type { GitProviderKind } from "@stubwise/shared";
import { execa } from "execa";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
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
 * Sicurezza credenziali (requisito review Task 20/21) — strategia scelta:
 * iniezione per-invocazione dell'header Authorization via variabili
 * d'ambiente `GIT_CONFIG_COUNT=1` + `GIT_CONFIG_KEY_0=http.extraheader` +
 * `GIT_CONFIG_VALUE_0=Authorization: ...` (git ≥ 2.31), calcolato da
 * GitProvider.getAuthHeader. L'env NON è visibile in `ps` (a differenza di
 * `-c http.extraheader=...` in argv, world-readable per tutta la durata di
 * un clone), non richiede uno script helper su disco come GIT_ASKPASS e
 * copre clone/fetch/push in modo uniforme. Il remote URL salvato nella
 * config del mirror è SEMPRE credential-free (mirrorRemoteUrl): nessun
 * token finisce su disco né in `git config`.
 * Difesa in profondità: `mirrorsDir` è creata (e ri-chmod-ata se preesiste)
 * con mode 0700, e ogni errore git viene redatto: token/header mai nei
 * messaggi o nei log, anche se git dovesse echeggiare pezzi di env.
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
  /**
   * Timeout per le invocazioni git "veloci" — fetch, push, worktree, switch
   * (default 120s). Il clone iniziale usa cloneTimeoutMs.
   */
  fetchTimeoutMs?: number;
  /**
   * Timeout dedicato al `git clone --mirror` iniziale (default 600s): un
   * primo clone di un repo grande può legittimamente durare minuti, mentre i
   * fetch incrementali devono restare stretti per non appendere il worker.
   */
  cloneTimeoutMs?: number;
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

/** Errore tipato per default branch rifiutati (mai passati come opzione a git). */
export class InvalidDefaultBranchError extends Error {
  constructor(defaultBranch: string) {
    super(
      `defaultBranch non valido: "${defaultBranch}" — non può essere vuoto né iniziare con "-" (verrebbe interpretato come opzione da git)`
    );
    this.name = "InvalidDefaultBranchError";
  }
}

/** Errore tipato: pushBranch chiamato senza un mirror esistente. */
export class MirrorNotFoundError extends Error {
  constructor(remoteUrl: string) {
    super(
      `Mirror inesistente per ${remoteUrl}: pushBranch va chiamato dentro withWorktree (dopo ensureMirror)`
    );
    this.name = "MirrorNotFoundError";
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

function assertDefaultBranch(defaultBranch: string): void {
  if (defaultBranch.length === 0 || defaultBranch.startsWith("-")) {
    throw new InvalidDefaultBranchError(defaultBranch);
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
  // Auth iniettata via env (git ≥ 2.31), MAI in argv: gli argomenti di un
  // processo sono leggibili da chiunque via `ps` per tutta la sua durata.
  const env: Record<string, string> = {
    // Mai prompt interattivi: meglio fallire subito che un worker appeso.
    GIT_TERMINAL_PROMPT: "0",
  };
  if (opts.auth && opts.auth.repoUrl.startsWith("https://")) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${getProvider(opts.auth.provider).getAuthHeader(opts.auth)}`;
  }
  try {
    const { stdout } = await execa("git", args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      env,
    });
    return stdout;
  } catch (error) {
    const e = error as { exitCode?: number; stderr?: unknown; timedOut?: boolean };
    // La redazione copre anche l'eventualità che git echeggi pezzi di env
    // (GIT_CONFIG_VALUE_0 contiene l'header completo) nello stderr.
    const stderr = redactSecrets(typeof e.stderr === "string" ? e.stderr.slice(-500) : "", secrets);
    const command = redactSecrets(["git", ...args].join(" "), secrets);
    const reason = e.timedOut === true ? `timeout dopo ${opts.timeoutMs}ms` : `exit ${e.exitCode ?? "?"}`;
    throw new GitCommandError(`Comando fallito (${reason}): ${command}\n${stderr}`, e.exitCode, stderr);
  }
}

/**
 * Gestisce i mirror bare e i worktree effimeri (vedi docblock del modulo).
 * ATTENZIONE: il lock per-repo è solo in-process — più processi worker che
 * condividono la stessa mirrorsDir NON sono supportati (l'assunzione di
 * deployment è un singolo worker).
 */
export class MirrorManager {
  private readonly mirrorsDir: string;
  private readonly fetchTimeoutMs: number;
  private readonly cloneTimeoutMs: number;
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
    this.cloneTimeoutMs = options.cloneTimeoutMs ?? 600_000;
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
      // Belt-and-braces: il mode di mkdir vale solo alla creazione; se la
      // directory preesisteva (o l'umask l'ha allargata) la stringiamo comunque.
      await chmod(this.mirrorsDir, 0o700);
      if (!existsSync(join(dir, "HEAD"))) {
        await rm(dir, { recursive: true, force: true });
        try {
          // Il primo clone di un repo grande può durare minuti: timeout dedicato.
          await this.git(["clone", "--mirror", mirrorRemoteUrl(project), dir], {
            auth: project,
            timeoutMs: this.cloneTimeoutMs,
          });
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
   *
   * Implementato sopra `openWorktree`/`removeWorktree`, gli stessi primitivi
   * usati dal worktree di generazione (apps/worker/src/docs/generation-worktree.ts):
   * la differenza è solo il ciclo di vita — qui scoped alla callback, là vivo
   * per l'intera generazione del DAG.
   */
  async withWorktree<T>(
    project: MirrorProject,
    branchName: string,
    fn: (dir: string) => Promise<T>
  ): Promise<T> {
    const handle = await this.openWorktree(project, branchName);
    try {
      return await fn(handle.dir);
    } finally {
      await handle.remove();
    }
  }

  /**
   * Apre un worktree e lo lascia VIVO: mirror aggiornato, worktree detached sul
   * default branch, poi `git switch -C <branchName>`. Ritorna la directory del
   * worktree + una `remove()` idempotente che lo smonta (worktree + branch
   * effimero + directory temporanea). A differenza di `withWorktree` il ciclo di
   * vita è in mano al chiamante: serve al worktree di generazione del DAG, che
   * deve restare aperto (read-only) per molti job-nodo, fino alla finalizzazione.
   *
   * INVARIANTE (come per withWorktree): finché un worktree su un branch
   * stubwise/* è aperto NON va fatto `fetch --prune` del mirror (cancellerebbe il
   * ref checked-out). La serializzazione verso i fix-job è garantita a monte
   * dalla catena per-progetto (M7): nessun ensureMirror concorrente mentre il
   * worktree di generazione è aperto.
   */
  async openWorktree(
    project: MirrorProject,
    branchName: string
  ): Promise<{ dir: string; remove: () => Promise<void> }> {
    assertBranchName(branchName);
    assertDefaultBranch(project.defaultBranch);
    const mirrorDir = await this.ensureMirror(project);
    const parent = await mkdtemp(join(tmpdir(), "stubwise-wt-"));
    const worktreeDir = join(parent, "wt");
    try {
      // refs/heads/<branch>: forma non ambigua, mai interpretabile come
      // opzione da git (oltre alla validazione di assertDefaultBranch).
      await this.git(
        ["worktree", "add", "--force", "--detach", worktreeDir, `refs/heads/${project.defaultBranch}`],
        { cwd: mirrorDir }
      );
      // -C (force): un branch residuo di un run precedente viene riallineato.
      await this.git(["switch", "-C", branchName], { cwd: worktreeDir });
    } catch (error) {
      // Setup fallito a metà: smonta quel che è stato creato e rilancia.
      await this.removeWorktree(mirrorDir, worktreeDir, parent, branchName);
      throw error;
    }
    let removed = false;
    return {
      dir: worktreeDir,
      remove: async () => {
        if (removed) return; // idempotente: una doppia close non fa danni.
        removed = true;
        await this.removeWorktree(mirrorDir, worktreeDir, parent, branchName);
      },
    };
  }

  /**
   * Smonta un worktree: rimozione del worktree dal mirror (con fallback manuale
   * + prune dei metadati orfani), cancellazione del branch effimero e della
   * directory temporanea che lo conteneva. Tutto best-effort: un residuo viene
   * comunque riallineato dal prossimo `switch -C` o ripulito dal `fetch --prune`.
   */
  private async removeWorktree(
    mirrorDir: string,
    worktreeDir: string,
    parent: string,
    branchName: string
  ): Promise<void> {
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
    await rm(parent, { recursive: true, force: true });
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
      throw new MirrorNotFoundError(mirrorRemoteUrl(project));
    }
    await this.git(
      ["-c", "remote.origin.mirror=false", "push", "origin", `${branchName}:refs/heads/${branchName}`],
      { cwd: mirrorDir, auth: project }
    );
  }

  /**
   * File cambiati tra due commit nel mirror (`git diff --name-only
   * <fromSha> <toSha>`), dal mirror aggiornato. Il path è relativo alla root
   * del repo. Righe vuote filtrate.
   *
   * Robustezza: se `fromSha`/`toSha` non sono raggiungibili nel mirror (es.
   * history non disponibile o sha sconosciuto) `runGit` fallisce con
   * GitCommandError — l'errore viene propagato, NON inghiottito: il chiamante
   * (worker) decide come gestirlo (es. fallback a generazione completa).
   */
  async getChangedFiles(project: MirrorProject, fromSha: string, toSha: string): Promise<string[]> {
    const mirrorDir = await this.ensureMirror(project);
    // `--` separa esplicitamente revisioni da pathspec: i due sha non possono
    // essere reinterpretati come opzioni o path. Passati come argv (no shell).
    const out = await this.git(["diff", "--name-only", fromSha, toSha, "--"], { cwd: mirrorDir });
    return out.split("\n").filter((line) => line.length > 0);
  }

  /**
   * Commit nel range `<fromSha>..<toSha>` nel mirror aggiornato, dal più
   * recente (default di `git log`). Output `git log --format=%H%x09%s`
   * (sha TAB subject, una riga per commit): parsato in `{ sha, subject }`.
   * Righe vuote filtrate.
   *
   * Robustezza: come getChangedFiles, errori git propagati (non inghiottiti).
   */
  async getCommitMessages(
    project: MirrorProject,
    fromSha: string,
    toSha: string
  ): Promise<{ sha: string; subject: string }[]> {
    const mirrorDir = await this.ensureMirror(project);
    // %H = sha completo, %x09 = TAB (separatore impossibile in uno sha),
    // %s = subject. Il subject può contenere spazi ma mai un TAB né newline,
    // quindi split sul primo TAB è sempre corretto.
    const out = await this.git(["log", "--format=%H%x09%s", `${fromSha}..${toSha}`], { cwd: mirrorDir });
    return out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const tab = line.indexOf("\t");
        return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
  }

  private git(
    args: string[],
    opts: Omit<RunGitOptions, "timeoutMs"> & { timeoutMs?: number }
  ): Promise<string> {
    return runGit(args, { ...opts, timeoutMs: opts.timeoutMs ?? this.fetchTimeoutMs });
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
