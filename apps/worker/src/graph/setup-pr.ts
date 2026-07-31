import { repoGraphs, type Db, type GraphJob } from "@stubwise/db";
import { getProvider, type GitProvider } from "@stubwise/git";
import type { GitProviderKind } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MirrorManager } from "../git/mirrors.js";
import { loadMirrorProject, type GraphBuildDeps } from "./build.js";
import { isPlatformManagedGraphifyignore, PLATFORM_GRAPHIFYIGNORE } from "./graphifyignore.js";
import { failGraphJobOnly } from "./queue.js";

/**
 * RUNNER della PR di CONFIGURAZIONE graphify (job `graph_jobs` kind `setup_pr`,
 * già reclamato dal poller): porta nel repository del cliente il grafo appena
 * costruito e tutto ciò che serve a usarlo da Claude Code.
 *
 * Sequenza:
 *  1. precondizioni — `repo_graphs.status = 'done'` E gli artefatti presenti sul
 *     volume (`<graphsDir>/<repositoryId>/graphify-out/`). Senza grafo non c'è
 *     nulla da proporre: fallimento immediato, nessun worktree aperto.
 *  2. worktree SCRIVIBILE sul mirror, branch {@link GRAPH_SETUP_BRANCH}
 *     (`openWorktree` fa `switch -C` da HEAD del default branch: il branch viene
 *     RESETTATO se esiste già — è l'idempotenza del job, un rilancio riscrive il
 *     branch invece di accumulare commit). Chiusura SEMPRE in `finally`.
 *  3. scrittura dei file (copia degli artefatti + configurazione idempotente),
 *     più la skill project-scoped via `graphify install --project`.
 *  4. `git add` dei SOLI path scritti — mai `git add -A`: è il safeguard
 *     anti-leak della pipeline (il worktree del cliente può contenere file non
 *     tracciati che non ci riguardano) — commit, push forzato del branch.
 *  5. `openPullRequest` col provider del repo e `repo_graphs.setup_pr_url`.
 *
 * COSA NON FINISCE NEL REPO: `graphify-out/cache/` (blob dell'incrementale) e
 * `graphify-out/cost.json` (consumi) — si copiano SOLO i file elencati in
 * {@link REQUIRED_ARTIFACTS}/{@link OPTIONAL_ARTIFACTS}, e le stesse due voci
 * finiscono nel `.gitignore` per l'uso locale degli sviluppatori.
 *
 * FALLIMENTI — perché `failGraphJobOnly` e non `failGraphJob`: qui il grafo è
 * `done` e VALIDO; se salta il worktree, git o il provider, a fallire è la PR,
 * non l'estrazione. Marcare `repo_graphs.status = 'failed'` mostrerebbe in UI un
 * grafo rotto che rotto non è (e la tab Grafo perderebbe report e metadati). Il
 * fallimento resta leggibile sullo stato del JOB, che il server espone a parte.
 *
 * DIVISIONE COL CHIAMANTE (poller): identica a `runGraphBuild` — `false` = già
 * chiuso `failed` qui, `true` = successo e il poller chiude `done`.
 *
 * LINGUA: commit e PR sono in ITALIANO come il resto di ciò che la pipeline
 * scrive sui repo target (vedi il messaggio di commit del fix: "Ticket #N — fix
 * automatico di Stubwise AI"). Testi hardcoded, non i18n: come per l'intake del
 * backlog, la lingua del server è quella dell'istanza.
 */

/** Directory di output di graphify (contratto del CLI, come in build.ts). */
const GRAPHIFY_OUT_DIR = "graphify-out";

/** Branch della PR di setup: unico e stabile, resettato a ogni rilancio. */
export const GRAPH_SETUP_BRANCH = "stubwise/graphify-setup";

/** Artefatti OBBLIGATORI: senza uno di questi il setup non ha senso. */
const REQUIRED_ARTIFACTS = ["graph.json", "GRAPH_REPORT.md", "manifest.json"] as const;

/** Artefatti opzionali: copiati se presenti (l'export html può essere fallito). */
const OPTIONAL_ARTIFACTS = ["graph.html"] as const;

/** Versione di graphify pinnata nella voce MCP (allineata all'immagine worker). */
const GRAPHIFY_VERSION = "0.9.28";

/** Voce `mcpServers.graphify` scritta/aggiornata in `.mcp.json`. */
const MCP_ENTRY = {
  command: "uvx",
  args: [
    "--from",
    `graphifyy[mcp]==${GRAPHIFY_VERSION}`,
    "python",
    "-m",
    "graphify.serve",
    `${GRAPHIFY_OUT_DIR}/graph.json`,
  ],
};

/** Marcatori della sezione gestita da Stubwise dentro CLAUDE.md. */
const CLAUDE_MD_START = "<!-- graphify:start -->";
const CLAUDE_MD_END = "<!-- graphify:end -->";

/** Corpo della sezione CLAUDE.md (tra i marcatori): guida query-first. */
const CLAUDE_MD_SECTION = `## Knowledge graph (graphify)

Questo repository ha un knowledge graph del codice in \`${GRAPHIFY_OUT_DIR}/\`.
Quando esiste, PREFERISCI le query sul grafo al grep per orientarti:

- \`graphify query "<domanda>"\` — dove vive una funzionalità, chi chiama cosa, quali file toccare.
- \`graphify explain <simbolo>\` — definizione, chiamanti e dipendenze di un simbolo.

Usa grep/find quando il grafo non risponde o è più vecchio del codice.`;

/** Righe aggiunte al `.gitignore` (artefatti locali di graphify, mai versionati). */
const GITIGNORE_LINES = [`${GRAPHIFY_OUT_DIR}/cost.json`, `${GRAPHIFY_OUT_DIR}/cache/`];

/** Riga aggiunta al `.gitattributes`: merge driver del grafo. */
const GITATTRIBUTES_LINE = `${GRAPHIFY_OUT_DIR}/graph.json merge=graphify-union`;

/** Starter di `.graphifyignore`, scritto SOLO se il file non esiste: è il
 * default di piattaforma condiviso con la build del worker (vedi
 * graphifyignore.ts — devono produrre lo stesso grafo). */
const GRAPHIFYIGNORE_STARTER = PLATFORM_GRAPHIFYIGNORE;

/** Titolo della PR di setup. */
const PR_TITLE = "Configura il knowledge graph graphify";

/**
 * Segnali che il provider ha rifiutato la PR perché ne esiste già una aperta
 * sullo stesso branch (GitHub 422 "A pull request already exists", Bitbucket 400
 * "There is already an open pull request"). Non è un errore: il branch è stato
 * aggiornato dal push e la PR esistente lo riflette già.
 */
const EXISTING_PR_RE = /already exists|already an open pull request|esiste già/i;

export interface GraphSetupPrDeps extends GraphBuildDeps {
  /**
   * Serve il worktree SCRIVIBILE (`openWorktree`) e il push del branch, non il
   * worktree detached della build.
   */
  mirrors: Pick<
    MirrorManager,
    "resolveDefaultBranchHead" | "withWorktreeAtSha" | "openWorktree" | "pushBranch"
  >;
  /** Iniettabile nei test: provider FINTO senza HTTP. Default: getProvider. */
  getProviderFn?: (kind: GitProviderKind) => Pick<GitProvider, "openPullRequest">;
  /** git locale nel worktree (add/commit/status). Iniettabile nei test. */
  gitFn?: (args: string[], cwd: string) => Promise<string>;
}

/** git nel worktree: comandi locali, nessuna auth (come `gitIn` di fix.ts). */
async function defaultGitFn(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd, timeout: 120_000 });
  return stdout;
}

/** Errore di precondizione/scrittura del setup: messaggio già leggibile in UI. */
class SetupPrError extends Error {}

/**
 * Sostituisce (o appende) la sezione delimitata dai marcatori. I marcatori sono
 * riconosciuti come RIGA INTERA — stessa regola dei marker di docs-engine — così
 * una citazione a metà riga o dentro un blocco di codice non viene scambiata per
 * un delimitatore. Tutto ciò che sta fuori dalla sezione è preservato. Funzione
 * pura, esportata per i test.
 */
export function upsertMarkerSection(existing: string, body: string): string {
  const section = `${CLAUDE_MD_START}\n${body}\n${CLAUDE_MD_END}`;
  const lines = existing.split("\n");
  const start = lines.findIndex((l) => l.trim() === CLAUDE_MD_START);
  const end = lines.findIndex((l, i) => i > start && l.trim() === CLAUDE_MD_END);
  if (start !== -1 && end !== -1) {
    return [...lines.slice(0, start), section, ...lines.slice(end + 1)].join("\n");
  }
  if (existing.trim().length === 0) return `${section}\n`;
  // Append in fondo, separato da una riga vuota.
  return `${existing.replace(/\n*$/, "")}\n\n${section}\n`;
}

/**
 * Append delle sole righe MANCANTI (confronto per riga trimmata: un file con la
 * riga già presente non viene toccato), preservando il contenuto esistente e
 * garantendo il newline finale. Funzione pura, esportata per i test.
 */
export function appendMissingLines(existing: string, lines: string[]): string {
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = lines.filter((line) => !present.has(line.trim()));
  if (missing.length === 0) return existing;
  const base = existing.length === 0 ? "" : existing.replace(/\n*$/, "\n");
  return `${base}${missing.join("\n")}\n`;
}

/**
 * MERGE del `.mcp.json`: aggiunge/aggiorna SOLO `mcpServers.graphify` lasciando
 * intatto tutto il resto (altri server, chiavi di primo livello). `existing` null
 * = file assente, si crea da zero. Un JSON non parsabile (o con `mcpServers` non
 * oggetto) lancia: meglio fallire il job che sovrascrivere la configurazione MCP
 * del cliente. Funzione pura, esportata per i test.
 */
export function mergeMcpConfig(existing: string | null): string {
  let root: Record<string, unknown> = {};
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new SetupPrError(
        ".mcp.json del repository non è JSON valido: correggilo prima di rigenerare la PR di setup (il file NON è stato modificato)",
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SetupPrError(".mcp.json del repository non contiene un oggetto JSON: PR di setup interrotta");
    }
    root = parsed as Record<string, unknown>;
    const servers = root.mcpServers;
    if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
      throw new SetupPrError(".mcp.json del repository ha un campo mcpServers non valido: PR di setup interrotta");
    }
  }
  const servers = (root.mcpServers as Record<string, unknown> | undefined) ?? {};
  return `${JSON.stringify({ ...root, mcpServers: { ...servers, graphify: MCP_ENTRY } }, null, 2)}\n`;
}

/** Contenuto del file, o null se non esiste. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Verifica le precondizioni e restituisce la riga di stato del grafo: `done` più
 * TUTTI gli artefatti obbligatori sul volume. Lancia con un messaggio d'azione
 * ("genera prima il grafo") altrimenti.
 */
async function checkPreconditions(
  db: Db,
  repositoryId: string,
  outDir: string,
): Promise<{ setupPrUrl: string | null }> {
  const [graph] = await db.select().from(repoGraphs).where(eq(repoGraphs.repositoryId, repositoryId));
  if (!graph || graph.status !== "done") {
    throw new SetupPrError(
      `il grafo del repository non è pronto (stato: ${graph?.status ?? "assente"}): genera prima il grafo`,
    );
  }
  for (const name of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(outDir, name))) {
      throw new SetupPrError(
        `artefatto ${name} assente in ${outDir}: genera prima il grafo (il volume potrebbe essere stato ricreato)`,
      );
    }
  }
  return { setupPrUrl: graph.setupPrUrl };
}

/**
 * Copia gli artefatti dal volume nel worktree e scrive/aggiorna i file di
 * configurazione. Restituisce i path RELATIVI scritti, che sono anche gli unici
 * path passati a `git add`.
 */
async function writeSetupFiles(outDir: string, worktreeDir: string): Promise<string[]> {
  const paths: string[] = [];
  await mkdir(join(worktreeDir, GRAPHIFY_OUT_DIR), { recursive: true });
  for (const name of [...REQUIRED_ARTIFACTS, ...OPTIONAL_ARTIFACTS]) {
    const source = join(outDir, name);
    if (!existsSync(source)) continue; // solo gli opzionali possono mancare
    await copyFile(source, join(worktreeDir, GRAPHIFY_OUT_DIR, name));
    paths.push(`${GRAPHIFY_OUT_DIR}/${name}`);
  }

  const gitignorePath = join(worktreeDir, ".gitignore");
  const gitignore = (await readOrNull(gitignorePath)) ?? "";
  await writeFile(gitignorePath, appendMissingLines(gitignore, GITIGNORE_LINES));
  paths.push(".gitignore");

  const gitattributesPath = join(worktreeDir, ".gitattributes");
  const gitattributes = (await readOrNull(gitattributesPath)) ?? "";
  await writeFile(gitattributesPath, appendMissingLines(gitattributes, [GITATTRIBUTES_LINE]));
  paths.push(".gitattributes");

  // .graphifyignore: SOLO se assente — un file già presente è una scelta del
  // cliente, non va sovrascritta con lo starter.
  // Scritto se assente O se quello committato è un nostro starter di versione
  // precedente (mai personalizzato → la PR lo aggiorna al default corrente).
  // Un file personalizzato dal team non viene toccato (vedi graphifyignore.ts).
  const graphifyignorePath = join(worktreeDir, ".graphifyignore");
  if (
    !existsSync(graphifyignorePath) ||
    isPlatformManagedGraphifyignore(await readFile(graphifyignorePath, "utf8"))
  ) {
    await writeFile(graphifyignorePath, GRAPHIFYIGNORE_STARTER);
  }
  paths.push(".graphifyignore");

  // .mcp.json: merge (lancia se il file esistente è malformato, PRIMA di
  // qualunque scrittura su di esso).
  const mcpPath = join(worktreeDir, ".mcp.json");
  await writeFile(mcpPath, mergeMcpConfig(await readOrNull(mcpPath)));
  paths.push(".mcp.json");

  const claudeMdPath = join(worktreeDir, "CLAUDE.md");
  const claudeMd = (await readOrNull(claudeMdPath)) ?? "";
  await writeFile(claudeMdPath, upsertMarkerSection(claudeMd, CLAUDE_MD_SECTION));
  paths.push("CLAUDE.md");

  return paths;
}

/**
 * Installa la skill project-scoped (`.claude/skills/graphify/`) nel worktree. NON
 * bloccante: senza skill la PR vale comunque (MCP + sezione CLAUDE.md ci sono).
 * Restituisce il path da aggiungere al commit, o null.
 */
async function installSkill(
  deps: GraphSetupPrDeps,
  job: GraphJob,
  worktreeDir: string,
): Promise<string | null> {
  const skillPath = ".claude/skills/graphify";
  const result = await deps.graphify({
    args: ["install", "--project", "--platform", "claude"],
    cwd: worktreeDir,
    timeoutMs: deps.timeoutMs,
  });
  if (result.exitCode !== 0) {
    deps.logger.warn(
      { jobId: job.id, repositoryId: job.repositoryId, output: result.output },
      "[graph] installazione della skill graphify fallita: la PR di setup prosegue senza",
    );
    return null;
  }
  // Difensivo: se il CLI cambiasse la destinazione, `git add` di un path
  // inesistente fallirebbe il job per un accessorio.
  return existsSync(join(worktreeDir, skillPath)) ? skillPath : null;
}

/** Corpo della PR: cosa contiene e cosa deve fare lo sviluppatore in locale. */
function prBody(): string {
  return [
    "Questa PR configura il **knowledge graph** del repository generato da Stubwise con",
    "[graphify](https://github.com/Graphify-Labs/graphify): un indice dei simboli e delle",
    "loro relazioni, interrogabile dagli agenti AI al posto del grep.",
    "",
    "**Cosa aggiunge**",
    "",
    `- \`${GRAPHIFY_OUT_DIR}/\`: grafo (\`graph.json\`), report delle comunità e manifest.`,
    "- `.mcp.json`: server MCP `graphify` (le altre voci restano invariate).",
    "- `CLAUDE.md`: sezione query-first tra i marcatori `graphify:start`/`graphify:end`.",
    "- `.gitignore`, `.gitattributes`, `.graphifyignore`: esclusioni e merge driver del grafo.",
    "",
    "**Per gli sviluppatori (una volta, in locale)**",
    "",
    "```sh",
    "uv tool install graphifyy",
    "graphify hook install",
    "```",
    "",
    "`graphify hook install` registra l'hook post-commit (rebuild locale del grafo) e il",
    "merge driver `graphify-union`: la riga in `.gitattributes` da sola NON lo attiva.",
    "",
    "**Se avvii Claude Code da una cartella sopra il repo (workspace multi-repo)**",
    "",
    "Claude Code carica `.mcp.json` (e le skill di progetto) solo dalla cartella in cui",
    "viene avviato: partendo dal workspace, il file dentro al repo non viene visto. La",
    "soluzione è registrare il server MCP una volta a livello UTENTE — vale in ogni",
    "sessione, da qualunque cartella:",
    "",
    "```sh",
    `claude mcp add -s user graphify -- uvx --from "graphifyy[mcp]==${GRAPHIFY_VERSION}" python -m graphify.serve`,
    `uvx --from "graphifyy[mcp]==${GRAPHIFY_VERSION}" python -c "import graphify"`,
    "graphify install",
    "```",
    "",
    "Le tre righe: registrazione del server, **pre-warm** della cache uvx, e skill",
    "`/graphify` a livello utente (opzionale). Niente commenti inline nel blocco, di",
    "proposito: zsh di default li passa al comando come argomenti quando incolli.",
    "",
    "Il pre-warm evita il falso \"failed\" al primo avvio: la prima risoluzione di `uvx`",
    "scarica e compila l'ambiente (minuti), mentre Claude Code dà ~30s a un server MCP",
    "per partire. Dalla cache in poi l'avvio è ~1s.",
    "",
    "Avviato fuori da un repo, il server è multi-progetto: i tool accettano",
    "`project_path` (la cartella del repo, che contiene `graphify-out/`) a ogni chiamata.",
    "Dal terminale, cross-repo: `graphify query \"<domanda>\" --graph <repo>/graphify-out/graph.json`.",
    "",
    "---",
    "PR generata automaticamente da Stubwise.",
  ].join("\n");
}

/** Salva l'URL della PR di setup (`updated_at` esplicito: nessun trigger). */
async function saveSetupPrUrl(db: Db, repositoryId: string, url: string): Promise<void> {
  await db
    .update(repoGraphs)
    .set({ setupPrUrl: url, updatedAt: sql`now()` })
    .where(eq(repoGraphs.repositoryId, repositoryId));
}

/**
 * Esegue il job `setup_pr`. Vedi il commento di modulo per sequenza, idempotenza
 * e trattamento dei fallimenti.
 *
 * @returns true = PR aperta (o già esistente e riusata), il chiamante chiude il
 * job con `completeGraphJob`; false = fallita e GIÀ chiusa `failed` dal runner —
 * SOLO il job, `repo_graphs` NON viene toccata.
 */
export async function runGraphSetupPr(deps: GraphSetupPrDeps, job: GraphJob): Promise<boolean> {
  const gitFn = deps.gitFn ?? defaultGitFn;
  const getProviderFn = deps.getProviderFn ?? getProvider;
  // Path costruito da GRAPHS_DIR + repositoryId (uuid dal DB): nessun segmento
  // arbitrario, nessun traversal possibile (come in build.ts).
  const outDir = join(deps.graphsDir, job.repositoryId, GRAPHIFY_OUT_DIR);
  try {
    const { setupPrUrl } = await checkPreconditions(deps.db, job.repositoryId, outDir);
    const project = await loadMirrorProject(deps, job.repositoryId);
    // Worktree SCRIVIBILE: `switch -C` resetta il branch se esiste già.
    const worktree = await deps.mirrors.openWorktree(project, GRAPH_SETUP_BRANCH);
    let prUrl: string;
    try {
      const paths = await writeSetupFiles(outDir, worktree.dir);
      const skillPath = await installSkill(deps, job, worktree.dir);
      if (skillPath) paths.push(skillPath);

      // `--` separa i path da eventuali opzioni: nessun `-A`, solo i nostri file.
      // `--force`: un repo che aveva già `graphify-out/` (o `.claude/`) nel
      // proprio .gitignore — perché qualcuno aveva usato graphify in locale —
      // farebbe fallire l'add e con esso l'intera PR. Versionare quei file È lo
      // scopo della PR, e i path sono comunque solo i nostri.
      await gitFn(["add", "--force", "--", ...paths], worktree.dir);
      // Nulla di staged = il setup è già sul branch di default (PR precedente
      // mergiata) e il branch non differirebbe da esso: `git commit` fallirebbe
      // con un errore oscuro e la PR sarebbe vuota. Se una PR è già nota il job è
      // semplicemente un no-op riuscito, altrimenti è un errore leggibile.
      const staged = (await gitFn(["diff", "--cached", "--name-only"], worktree.dir)).trim();
      if (staged.length === 0) {
        if (setupPrUrl) {
          deps.logger.warn(
            { jobId: job.id, repositoryId: job.repositoryId },
            "[graph] configurazione graphify già presente sul branch di default: PR esistente riusata",
          );
          return true;
        }
        throw new SetupPrError(
          "la configurazione graphify è già presente sul branch di default: nessuna modifica da proporre",
        );
      }
      await gitFn(
        [
          "-c",
          "user.name=Stubwise AI",
          "-c",
          "user.email=ai@stubwise",
          "commit",
          "-m",
          `${PR_TITLE}\n\nConfigurazione generata automaticamente da Stubwise.`,
        ],
        worktree.dir,
      );
      // Push FORZATO: il branch è ricreato da HEAD del default branch a ogni
      // rilancio, quindi non è mai fast-forward rispetto al remoto. Il namespace
      // `stubwise/` è di proprietà esclusiva di Stubwise (assertBranchName lo
      // impone), quindi non si sovrascrive mai lavoro altrui.
      // Niente `--force-with-lease`: in un clone `--mirror` il refspec
      // `+refs/*:refs/*` mappa il branch su sé stesso, quindi non esiste un
      // remote-tracking ref indipendente su cui il lease possa dire qualcosa.
      await deps.mirrors.pushBranch(project, GRAPH_SETUP_BRANCH, { force: true });
    } finally {
      // SEMPRE: worktree smontato e branch effimero rimosso dal mirror (il ref
      // pushato vive ormai sull'upstream).
      await worktree.remove();
    }

    try {
      ({ url: prUrl } = await getProviderFn(project.provider).openPullRequest(project, {
        branch: GRAPH_SETUP_BRANCH,
        title: PR_TITLE,
        body: prBody(),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // PR già aperta sullo stesso branch: il push l'ha appena aggiornata. Né
      // Bitbucket né GitHub restituiscono l'URL della PR esistente in questo
      // errore, quindi si riusa quello salvato; senza, non c'è nulla da mostrare
      // in UI e il job fallisce con l'errore del provider.
      if (EXISTING_PR_RE.test(message) && setupPrUrl) {
        deps.logger.warn(
          { jobId: job.id, repositoryId: job.repositoryId, error: message },
          "[graph] PR di setup già aperta: branch aggiornato, URL esistente riusato",
        );
        return true;
      }
      throw error;
    }
    await saveSetupPrUrl(deps.db, job.repositoryId, prUrl);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.error(
      { jobId: job.id, repositoryId: job.repositoryId, error: message },
      "[graph] PR di setup graphify fallita",
    );
    // SOLO il job: il grafo resta `done` e valido (vedi il commento di modulo).
    await failGraphJobOnly(deps.db, job.id, message);
    return false;
  }
}
