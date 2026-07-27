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

/** Un commit restituito da `getCommitsInRange` (git log su finestra temporale). */
export interface RangeCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 (committer date, coerente col filtro della finestra). */
  date: string;
  subject: string;
  isMerge: boolean;
  additions: number;
  deletions: number;
}

/**
 * Ref LEGGERO di un commit restituito da `getCommitRefsInRange`: solo i campi
 * che servono al recount (confronto degli sha), senza il costo del `--numstat`
 * (un diff per ogni commit) di `getCommitsInRange`.
 */
export interface RangeCommitRef {
  sha: string;
  /** ISO 8601 (committer date, coerente col filtro della finestra). */
  date: string;
  isMerge: boolean;
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

/** Opzioni di `openWorktree`. */
export interface OpenWorktreeOptions {
  /**
   * Directory in cui materializzare il worktree. Se assente, openWorktree crea
   * (e possiede) una propria directory temporanea in /tmp e la cancella alla
   * remove(). Se presente, il chiamante è responsabile della parent dir: la
   * remove() smonta il worktree e ne rimuove SOLO questa sottocartella. Usata da
   * withProjectWorktrees per collocare N worktree sotto una parent comune.
   */
  dir?: string;
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

/** Errore tipato per sha rifiutati (head di una PR arrivata da webhook). */
export class InvalidShaError extends Error {
  constructor(sha: string) {
    super(`SHA non valido: "${sha}" — atteso esadecimale di 7-40 caratteri`);
    this.name = "InvalidShaError";
  }
}

/** Errore tipato per branch target di una PR rifiutati (mai passati a git). */
export class InvalidTargetBranchError extends Error {
  constructor(branch: string) {
    super(
      `Branch target non valido: "${branch}" — segmenti [A-Za-z0-9._-] separati da "/", senza "..", segmenti vuoti o iniziali con "-"`
    );
    this.name = "InvalidTargetBranchError";
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

/**
 * Cap del diff passato al prompt della review: oltre, si tronca (l'agente ha
 * comunque il worktree completo per approfondire).
 */
export const MAX_DIFF_CHARS = 150_000;

/**
 * Tronca un diff a MAX_DIFF_CHARS per non esplodere sui prompt dell'agente.
 * Condiviso da getPrDiff e getCommitDiff: stessa strategia (taglio per
 * caratteri) e stessa costante.
 */
function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
  return { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true };
}

/** Sha abbreviato o completo (hex 7-40): tutto il resto è rifiutato a monte. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

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

/**
 * Validazione GENERICA di un branch (il target di una PR è scelto dall'utente
 * sull'hosting, es. "main" o "release/1.2"): stessi vincoli per-segmento di
 * assertBranchName ma senza il prefisso stubwise/. Niente "..", segmenti vuoti
 * o inizianti con "-": mai interpretabile come range o opzione da git.
 */
function assertTargetBranch(branch: string): void {
  if (branch.includes("..")) throw new InvalidTargetBranchError(branch);
  const segments = branch.split("/");
  if (segments.length === 0 || segments.some((s) => !BRANCH_SEGMENT.test(s))) {
    throw new InvalidTargetBranchError(branch);
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
        // Worktree orfani (es. la dir effimera in /tmp sparisce al riavvio del
        // worker mentre un fix era aperto) restano registrati e tengono "checked
        // out" il loro branch: `fetch --prune` rifiuterebbe di toccarlo (exit 128,
        // "refusing to fetch into branch ... checked out at ..."). `worktree prune`
        // rimuove SOLO le registrazioni la cui directory non esiste più — i
        // worktree VIVI (es. quello di una generazione in corso) restano intatti,
        // preservando l'invariante "niente fetch --prune con un worktree aperto".
        await this.git(["worktree", "prune"], { cwd: dir });
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
    branchName: string,
    options?: OpenWorktreeOptions
  ): Promise<{ dir: string; remove: () => Promise<void> }> {
    assertBranchName(branchName);
    assertDefaultBranch(project.defaultBranch);
    const mirrorDir = await this.ensureMirror(project);
    // La directory del worktree può essere imposta dal chiamante (es.
    // withProjectWorktrees, che vuole N worktree sotto una parent comune). Se
    // non lo è, ci creiamo una parent temporanea in /tmp E la possediamo:
    // remove() la cancella. Se invece è imposta dall'esterno, il chiamante è
    // responsabile della sua parent — noi rimuoviamo solo la sottocartella.
    const externalDir = options?.dir;
    const parent = externalDir ? undefined : await mkdtemp(join(tmpdir(), "stubwise-wt-"));
    const worktreeDir = externalDir ?? join(parent as string, "wt");
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
   * Monta un worktree DETACHED a uno sha arbitrario (la head di una PR) e lo
   * rimuove alla fine (anche se `fn` lancia). A differenza di openWorktree non
   * crea alcun branch: la review è read-only, nessun push. Lo sha deve essere
   * raggiungibile dal mirror — GitHub: il `clone --mirror` porta anche i
   * refs/pull/*; Bitbucket: la source branch di una PR same-repo è un branch
   * normale. Le PR da fork Bitbucket NON sono raggiungibili: l'errore git
   * (GitCommandError sullo sha sconosciuto) emerge chiaro qui.
   *
   * ensureMirror fa SEMPRE `fetch --prune` quando il mirror esiste già (nessun
   * caching): lo sha appena pushato dal webhook è quindi visibile.
   */
  async withWorktreeAtSha<T>(
    project: MirrorProject,
    sha: string,
    fn: (dir: string) => Promise<T>
  ): Promise<T> {
    if (!SHA_RE.test(sha)) throw new InvalidShaError(sha);
    const mirrorDir = await this.ensureMirror(project);
    // Stesso schema path di openWorktree: parent temporanea posseduta da noi.
    const parent = await mkdtemp(join(tmpdir(), "stubwise-wt-"));
    const worktreeDir = join(parent, "wt");
    try {
      // Sha validato da SHA_RE (mai interpretabile come opzione da git).
      await this.git(["worktree", "add", "--force", "--detach", worktreeDir, sha], { cwd: mirrorDir });
      return await fn(worktreeDir);
    } finally {
      // Rimozione best-effort come openWorktree; nessun branch da cancellare.
      await this.removeWorktree(mirrorDir, worktreeDir, parent, undefined);
    }
  }

  /**
   * Materializza N worktree — uno per repo del progetto — SOTTO una parent dir
   * temporanea comune, ognuno su `git switch -C <branchName>` (lo STESSO branch
   * in ogni repo). Esegue `fn` con `{ parentDir, worktrees }`: l'agente `claude`
   * girerà con `cwd = parentDir` e vedrà i repo come sottocartelle. In `finally`
   * smonta TUTTI i worktree (dai rispettivi mirror), i loro branch effimeri e la
   * parent dir — best-effort e idempotente come removeWorktree.
   *
   * Ogni repo finisce in una sottocartella deterministica `mirrorSlug(repoUrl)`
   * (stabile e filesystem-safe, la stessa usata per la dir del mirror): due repo
   * distinti non collidono mai (suffisso sha256), lo stesso repo mappa sempre
   * sulla stessa sottocartella.
   *
   * È "N openWorktree coordinati sotto una root": riusa lo stesso primitivo (con
   * la dir target imposta) e quindi le stesse invarianti — validazione
   * branch/defaultBranch, worktree `--force --detach` su refs/heads/<default>,
   * poi `switch -C`. Se il setup fallisce a metà (es. il 3° repo non si aggancia)
   * smonta i worktree GIÀ aperti e la parent dir, poi rilancia.
   *
   * INVARIANTE mirror (come openWorktree): niente `fetch --prune` finché un
   * worktree su un branch stubwise/* è aperto; garantita a monte dalla
   * serializzazione per-progetto (l'esclusione fix↔generazione copre TUTTI i
   * repo del progetto).
   *
   * Nota: `pushBranch` resta per-repo e va chiamato DENTRO `fn` (dopo i commit)
   * sul singolo `project` del worktree.
   */
  async withProjectWorktrees<T>(
    repos: MirrorProject[],
    branchName: string,
    fn: (ctx: {
      parentDir: string;
      worktrees: { project: MirrorProject; dir: string }[];
    }) => Promise<T>
  ): Promise<T> {
    // Valida il branch prima di creare qualunque directory: fail-fast simmetrico
    // a openWorktree (che valida branch/defaultBranch a monte di ensureMirror).
    assertBranchName(branchName);
    const parentDir = await mkdtemp(join(tmpdir(), "stubwise-proj-"));
    const opened: { project: MirrorProject; dir: string; remove: () => Promise<void> }[] = [];
    try {
      for (const project of repos) {
        const dir = join(parentDir, mirrorSlug(project.repoUrl));
        // openWorktree con dir imposta: crea/aggancia il worktree SOTTO parentDir.
        // La sua pulizia (worktree + branch effimero) è gestita dalla remove()
        // che ci restituisce; la parent dir la possediamo noi (finally sotto).
        const handle = await this.openWorktree(project, branchName, { dir });
        opened.push({ project, dir: handle.dir, remove: handle.remove });
      }
      return await fn({
        parentDir,
        worktrees: opened.map(({ project, dir }) => ({ project, dir })),
      });
    } finally {
      // Smonta i worktree GIÀ aperti (best-effort per ciascuno: un errore su uno
      // non blocca gli altri) e poi rimuove la parent dir comune.
      for (const handle of opened) {
        await handle.remove().catch(() => undefined);
      }
      await rm(parentDir, { recursive: true, force: true });
    }
  }

  /**
   * Smonta un worktree: rimozione del worktree dal mirror (con fallback manuale
   * + prune dei metadati orfani), cancellazione del branch effimero (se il
   * worktree ne aveva uno — quelli detached di withWorktreeAtSha no) e della
   * directory temporanea che lo conteneva. Tutto best-effort: un residuo viene
   * comunque riallineato dal prossimo `switch -C` o ripulito dal `fetch --prune`.
   */
  private async removeWorktree(
    mirrorDir: string,
    worktreeDir: string,
    parent: string | undefined,
    branchName: string | undefined
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
    if (branchName !== undefined) {
      await this.git(["branch", "-D", branchName], { cwd: mirrorDir }).catch(() => undefined);
    }
    // Rimuoviamo la parent dir SOLO se la possediamo (dir temporanea creata da
    // openWorktree). Quando la dir del worktree è imposta dal chiamante
    // (withProjectWorktrees) la parent è condivisa da più worktree ed è di
    // proprietà del chiamante: ci limitiamo alla sottocartella del worktree.
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true });
    } else {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  }

  /**
   * Pubblica `branchName` sull'upstream. Va chiamato DENTRO la callback di
   * withWorktree, dopo i commit: il push gira nel mirror (dove vive il ref)
   * con refspec esplicito. `clone --mirror` imposta remote.origin.mirror=true,
   * che trasformerebbe ogni push in un `push --mirror` (tutti i ref, con
   * delete inclusi): lo disattiviamo per-invocazione con -c.
   *
   * `force`: push forzato, per i branch a nome FISSO ricreati da capo a ogni run
   * (es. `stubwise/graphify-setup` della PR di setup del grafo), che non sono mai
   * fast-forward rispetto al remoto. Non si usa `--force-with-lease` perché in un
   * clone `--mirror` il refspec `+refs/*:refs/*` mappa il branch su sé stesso:
   * non esiste un remote-tracking ref indipendente su cui il lease possa dire
   * qualcosa. La protezione è il namespace `stubwise/` (imposto da
   * assertBranchName), di proprietà esclusiva di Stubwise.
   */
  async pushBranch(
    project: MirrorProject,
    branchName: string,
    opts?: { force?: boolean }
  ): Promise<void> {
    assertBranchName(branchName);
    const mirrorDir = this.mirrorDirFor(project);
    if (!existsSync(join(mirrorDir, "HEAD"))) {
      throw new MirrorNotFoundError(mirrorRemoteUrl(project));
    }
    await this.git(
      [
        "-c",
        "remote.origin.mirror=false",
        "push",
        ...(opts?.force === true ? ["--force"] : []),
        "origin",
        `${branchName}:refs/heads/${branchName}`,
      ],
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

  /**
   * Commit su tutti i BRANCH (refs/heads, non su tutti i ref: così restano
   * fuori le head di PR non mergiate come refs/pull/* di GitHub e simili) con
   * committer-date nella finestra [since, until) (`git log --branches --since
   * --until --numstat`), dal mirror aggiornato. `since` incluso, `until` escluso
   * (implementato come until-1s, granularità git al secondo): passa istanti UTC.
   * Ogni commit riporta autore, email, data ISO (committer date, coerente col
   * filtro), subject, flag merge e righe aggiunte/rimosse (somma del numstat; i
   * file binari, marcati "-", contano 0).
   */
  async getCommitsInRange(project: MirrorProject, since: Date, until: Date): Promise<RangeCommit[]> {
    const mirrorDir = await this.ensureMirror(project);
    // `git log --until` è INCLUSIVO: per una finestra half-open [since, until)
    // escludiamo l'istante `until` sottraendo 1s (la granularità di git).
    const untilExclusive = new Date(until.getTime() - 1000);
    // Record separato da NUL; header dei campi separati da TAB; poi le righe
    // numstat. %P non vuoto con più di un parent ⇒ merge. %cI = committer date
    // (coerente col filtro --since/--until, che git applica sulla committer date).
    const format = "%x00%H%x09%an%x09%ae%x09%cI%x09%P%x09%s";
    const out = await this.git(
      [
        "log",
        "--branches",
        `--since=${since.toISOString()}`,
        `--until=${untilExclusive.toISOString()}`,
        "--numstat",
        `--pretty=format:${format}`,
      ],
      { cwd: mirrorDir }
    );
    const commits: RangeCommit[] = [];
    for (const record of out.split("\x00")) {
      // `--pretty=format:` antepone il format a ogni record senza newline finale:
      // il primo split produce una stringa vuota iniziale, gestita dal check sotto.
      // I record successivi al primo iniziano con il "\n" che segue il numstat
      // del record precedente: lo togliamo prima di parsare l'header.
      const trimmed = record.replace(/^\n+/, "");
      if (trimmed.length === 0) continue;
      const [header, ...statLines] = trimmed.split("\n");
      // %s è l'ultimo campo del format: teniamo il subject come "resto" (slice+join)
      // così un eventuale TAB nel subject non lo tronca (come in getCommitMessages).
      const parts = (header ?? "").split("\t");
      const sha = parts[0] ?? "";
      const authorName = parts[1] ?? "";
      const authorEmail = parts[2] ?? "";
      const dateIso = parts[3] ?? "";
      const parents = parts[4] ?? "";
      const subject = parts.slice(5).join("\t");
      let additions = 0;
      let deletions = 0;
      for (const line of statLines) {
        if (line.length === 0) continue;
        const [add, del] = line.split("\t");
        // I file binari sono marcati "-" dal numstat: contano 0.
        additions += add === "-" ? 0 : Number(add);
        deletions += del === "-" ? 0 : Number(del);
      }
      commits.push({
        sha,
        authorName,
        authorEmail,
        date: dateIso,
        subject,
        isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
        additions,
        deletions,
      });
    }
    return commits;
  }

  /**
   * Variante LEGGERA di getCommitsInRange per il RECOUNT: gli stessi commit
   * (branch, stessa finestra half-open [since, until) sulla committer date) ma
   * SENZA `--numstat` — che calcolerebbe un diff per OGNI commit dell'intera
   * finestra di retention (~90 giorni), la parte di gran lunga più costosa. Al
   * recount servono solo `sha`, committer date e `isMerge` (per confrontare gli
   * sha con quelli già registrati), non additions/deletions/autore/subject.
   *
   * Output `git log --branches --since --until --pretty=format:%H%x09%cI%x09%P`
   * (sha TAB committer-date TAB parents, una riga per commit): %P con più di un
   * parent ⇒ merge. Righe vuote filtrate. Errori git propagati (come le altre).
   */
  async getCommitRefsInRange(project: MirrorProject, since: Date, until: Date): Promise<RangeCommitRef[]> {
    const mirrorDir = await this.ensureMirror(project);
    // Stessa finestra half-open di getCommitsInRange: `--until` è INCLUSIVO,
    // quindi escludiamo l'istante `until` sottraendo 1s (la granularità di git).
    const untilExclusive = new Date(until.getTime() - 1000);
    // %H = sha completo, %x09 = TAB, %cI = committer date (coerente col filtro
    // --since/--until), %P = parents. NESSUN --numstat: una riga per commit.
    const out = await this.git(
      [
        "log",
        "--branches",
        `--since=${since.toISOString()}`,
        `--until=${untilExclusive.toISOString()}`,
        "--pretty=format:%H%x09%cI%x09%P",
      ],
      { cwd: mirrorDir }
    );
    return out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha = "", date = "", parents = ""] = line.split("\t");
        return {
          sha,
          date,
          isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
        };
      });
  }

  /**
   * Diff della PR: merge-base tra la head e il branch target, poi `git diff`
   * troncato a MAX_DIFF_CHARS (l'agente ha comunque il worktree per il resto).
   * Se il merge-base non è calcolabile (storia riscritta sul target), fallback
   * al diff diretto contro il target: meno preciso ma utilizzabile.
   */
  async getPrDiff(
    project: MirrorProject,
    headSha: string,
    targetBranch: string
  ): Promise<{ diff: string; truncated: boolean }> {
    if (!SHA_RE.test(headSha)) throw new InvalidShaError(headSha);
    assertTargetBranch(targetBranch);
    const mirrorDir = await this.ensureMirror(project);
    // refs/heads/<branch>: forma non ambigua (come openWorktree), oltre alla
    // validazione di assertTargetBranch.
    let base = `refs/heads/${targetBranch}`;
    try {
      base = (await this.git(["merge-base", headSha, base], { cwd: mirrorDir })).trim();
    } catch {
      // Fallback: diff diretto contro il target.
    }
    // `--` separa revisioni da pathspec, come getChangedFiles.
    const diff = await this.git(["diff", base, headSha, "--"], { cwd: mirrorDir });
    return truncateDiff(diff);
  }

  /**
   * Diff di un singolo commit (`git show <sha>`), dal mirror, troncato allo
   * stesso tetto di getPrDiff (MAX_DIFF_CHARS, via truncateDiff) per non
   * esplodere su commit enormi. Ritorna il testo del diff e se è stato troncato.
   * Read-only. Lo sha è validato da SHA_RE (mai reinterpretabile come opzione).
   *
   * `skipFetch`: quando true NON chiama ensureMirror (che farebbe un
   * `git fetch --prune`) e legge direttamente dal mirror GIÀ montato via
   * mirrorDirFor. Gli sha sono immutabili: se un chiamante ha appena fatto
   * girare getCommitsInRange/ensureMirror per lo stesso repo, il commit è già
   * presente e ogni fetch aggiuntivo per-commit è sprecato (N+1 fetch). Con
   * skipFetch assente/false il comportamento resta quello storico (fetch).
   */
  async getCommitDiff(
    project: MirrorProject,
    sha: string,
    opts?: { skipFetch?: boolean }
  ): Promise<{ diff: string; truncated: boolean }> {
    if (!SHA_RE.test(sha)) throw new InvalidShaError(sha);
    const mirrorDir = opts?.skipFetch ? this.mirrorDirFor(project) : await this.ensureMirror(project);
    // `git show`: header del commit (--format=medium) + diff. -M rileva i rename
    // (come un diff leggibile), --no-color per un testo pulito nel prompt.
    // `--` separa la revisione da eventuali pathspec: lo sha non è ambiguo.
    const out = await this.git(["show", "--no-color", "-M", "--format=medium", sha, "--"], {
      cwd: mirrorDir,
    });
    return truncateDiff(out);
  }

  /**
   * Risolve lo sha di HEAD del default branch del repo dal mirror aggiornato
   * (ensureMirror fa il `fetch --prune`, quindi lo sha è fresco). Usa
   * `git rev-parse refs/heads/<default>`, la STESSA forma non ambigua con cui
   * openWorktree/getPrDiff referenziano il default branch (validato da
   * assertDefaultBranch: mai reinterpretabile come opzione). Serve al deep dive
   * del backlog, che monta un worktree read-only a questo sha (pattern PR
   * review): la review riceve lo sha dal webhook della PR, qui non c'è una PR e
   * lo si risolve dal branch. L'output è ri-validato da SHA_RE per sicurezza.
   */
  async resolveDefaultBranchHead(project: MirrorProject): Promise<string> {
    assertDefaultBranch(project.defaultBranch);
    const mirrorDir = await this.ensureMirror(project);
    const sha = (
      await this.git(["rev-parse", `refs/heads/${project.defaultBranch}`], { cwd: mirrorDir })
    ).trim();
    if (!SHA_RE.test(sha)) throw new InvalidShaError(sha);
    return sha;
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
