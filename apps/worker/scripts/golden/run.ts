/**
 * Scenari GOLDEN (manuali) del registro plugin — fase 3.
 *
 * Rispondono all'unica domanda che i test unitari non possono porre: con i
 * plugin davvero caricati nel CLI, l'agente si comporta ancora come la pipeline
 * si aspetta? La copia filtrata (skill e hook spenti esclusi, `.mcp.json`
 * omesso) è già verificata su filesystem vero da `materialize-run.test.ts`; qui
 * si guarda il COMPORTAMENTO, e per quello serve il modello reale.
 *
 *   pnpm --filter @stubwise/worker golden -- --plugin /plugins/superpowers/<sha>
 *
 * NON è un test automatico e NON gira in CI: costa chiamate al modello, ha
 * bisogno di un `claude` autenticato ed è di proposito un giudizio umano sulla
 * base di un output JSON. Si lancia quando si aggiorna un plugin del registro o
 * si cambia un prompt/contratto della pipeline. Vedi README.md accanto.
 *
 * ======================== I tre scenari (design §8) ========================
 *
 * 1. `plan-only`  run di pianificazione (read-only) sul ticket dello sconto:
 *    il piano ha la sezione delle decisioni, NESSUN file è toccato e nessun
 *    ramo/worktree/commit è nato nel repo fixture.
 * 2. `ask-user`   stesso run, ma su un ticket con un BIVIO MATERIALE (dove
 *    arrotondare: importo addebitato o solo importo mostrato): l'agente deve
 *    chiamare `ask_user` — il file-bridge esiste ed è valido — e non lasciare
 *    la domanda in chiaro nel messaggio finale, dove non la leggerebbe nessuno.
 * 3. `execute`    run di esecuzione: il fix è applicato, `STUBWISE_REPORT.md`
 *    è nella radice della working dir e NESSUN `git commit`/`push` è avvenuto.
 *
 * ============================ Come si verifica ============================
 *
 * Gli scenari 1 e 3 sono formulati nel design come «dai tool usati nel log».
 * `ClaudeCliRunner` lancia il CLI con `--output-format json`, che restituisce
 * il solo oggetto-risultato finale (messaggio, usage, session_id) e NON la
 * trascrizione dei tool: il log dei tool non esiste, per questi run. Le
 * asserzioni sono quindi sull'EFFETTO OSSERVABILE — lo stato git del repo
 * fixture e i file presenti nella working dir — che è un controllo più forte
 * di un nome di tool: un `git commit` riuscito si vede nel repo anche se il
 * modello lo ha eseguito senza dirlo. Il messaggio finale resta nell'output
 * JSON, così un umano può leggerlo.
 *
 * ATTENZIONE al limite di questo approccio: lo stato git rileva le violazioni
 * RIUSCITE, non i TENTATIVI bloccati. In `plan-only` è il permission mode
 * `plan` a negare scritture e comandi, quindi un agente che HA PROVATO a
 * committare e si è visto negare il tool passa i check esattamente come uno che
 * non ci ha mai pensato. «Più forte di un nome di tool» vale per gli ESITI:
 * questi scenari dicono che il contratto non è stato violato, non che il
 * modello lo abbia capito.
 *
 * Il plugin passato con `--plugin` viene caricato INTEGRALE, come fa lo smoke
 * run del poller: qui si chiede «come si comporta l'agente avendo questo
 * plugin», non «cosa vede un dato progetto» (quello lo copre il filtro
 * per-progetto, già testato).
 */

import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Dai package workspace e dai sorgenti del worker si importano SOLO I TIPI:
// `import type` è cancellato a compilazione e non fa risolvere nulla a runtime.
// I VALORI arrivano da `loadRuntime()`, dopo il check dei prerequisiti — il
// perché sta nel suo docblock.
import type { Language } from "@stubwise/i18n";
import type { AgentRunner, AgentRunResult } from "../../src/agent/runner.js";
import type { FixTicketInput } from "../../src/pipeline/prompts.js";

/* ------------------------------------------------------------------ *
 * Costanti
 * ------------------------------------------------------------------ */

/** Lingua dei run: come in prod su un'istanza italiana (decide le sezioni del piano). */
const LANG: Language = "it";

/** Sottocartella del repo dentro la working dir: i run di fix girano SEMPRE
 * sulla parent dir dei worktree, anche con un repo solo. */
const REPO_DIR = "shop";

/** Turni del run di pianificazione: allineato a `DEFAULT_PLAN_MAX_TURNS` (fix.ts, non esportato). */
const PLAN_MAX_TURNS = 40;

/** Turni del run di esecuzione: allineato al default della pipeline. */
const EXECUTE_MAX_TURNS = 80;

/** Modello di default degli scenari: quello dell'esecuzione, non della pianificazione.
 * I golden misurano la DISCIPLINA (git, sezioni, `ask_user`), non la profondità
 * dell'analisi: pagare `opus` a ogni giro non aggiungerebbe segnale. */
const DEFAULT_MODEL = "sonnet";

/** Nome del report che il run di esecuzione deve produrre (come `REPORT_FILENAME`). */
const REPORT_FILENAME = "STUBWISE_REPORT.md";

/** Tetto del messaggio finale riportato nel JSON: il resto è rumore da leggere a video. */
const FINAL_MESSAGE_MAX_CHARS = 4000;

const SCENARIO_NAMES = ["plan-only", "ask-user", "execute"] as const;
type ScenarioName = (typeof SCENARIO_NAMES)[number];

/* ------------------------------------------------------------------ *
 * Argomenti
 * ------------------------------------------------------------------ */

interface Args {
  /** Directory dei plugin da caricare dopo il base, nell'ordine dato. */
  plugins: string[];
  scenarios: ScenarioName[];
  model: string;
  /** Non rimuovere le working dir a fine run (per ispezionarle). */
  keep: boolean;
  /** File su cui scrivere il JSON, oltre allo stdout. */
  out?: string;
}

function printUsage(): void {
  console.error(
    [
      "Uso: pnpm --filter @stubwise/worker golden -- --plugin <dir> [opzioni]",
      "",
      "  --plugin <dir>      directory di UN plugin da caricare (ripetibile, nell'ordine).",
      "                      Tipicamente la dir materializzata: /plugins/<slug>/<sha>.",
      "                      Il plugin base di Stubwise è sempre caricato per primo.",
      "  --scenario <nome>   solo questo scenario (ripetibile). Default: tutti e tre.",
      `                      Nomi: ${SCENARIO_NAMES.join(", ")}.`,
      `  --model <nome>      modello dei run. Default: ${DEFAULT_MODEL}.`,
      "  --out <file>        scrive il JSON anche su file (lo stdout resta il JSON).",
      "  --keep              non rimuovere le working dir a fine run.",
      "",
      "Esce 0 se tutti gli scenari passano, 1 se almeno uno fallisce,",
      "2 se manca un prerequisito (argomenti, `claude`, build del worker).",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Args {
  const plugins: string[] = [];
  const scenarios: ScenarioName[] = [];
  let model = DEFAULT_MODEL;
  let keep = false;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm può inoltrare il separatore `--` come argomento letterale: ignoralo.
    if (arg === "--" || arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--keep") {
      keep = true;
    } else if (arg === "--plugin" || arg === "--scenario" || arg === "--model" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        fail(`L'opzione ${arg} richiede un valore`);
      }
      if (arg === "--plugin") plugins.push(value);
      else if (arg === "--model") model = value;
      else if (arg === "--out") out = value;
      else {
        if (!(SCENARIO_NAMES as readonly string[]).includes(value)) {
          fail(`Scenario sconosciuto: ${value} (attesi: ${SCENARIO_NAMES.join(", ")})`);
        }
        scenarios.push(value as ScenarioName);
      }
    } else {
      fail(`Argomento sconosciuto: ${arg}`);
    }
  }

  if (plugins.length === 0) fail("Serve almeno un --plugin <dir>");
  return {
    plugins,
    scenarios: scenarios.length > 0 ? scenarios : [...SCENARIO_NAMES],
    model,
    keep,
    ...(out !== undefined ? { out } : {}),
  };
}

/** Prerequisito mancante: messaggio, uso, exit 2. Mai exit 0 — un golden che
 * non ha girato NON è un golden verde. */
function fail(message: string): never {
  console.error(`[golden] ${message}`);
  printUsage();
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * Runtime: i moduli veri, caricati dopo i prerequisiti
 * ------------------------------------------------------------------ */

/**
 * Carica i moduli del worker e dei package workspace, e li restituisce in un
 * unico oggetto che gli scenari ricevono dentro il loro contesto.
 *
 * Sono import DINAMICI, non statici, per un motivo solo: `../../src/...` tira
 * dentro `@stubwise/db`, `@stubwise/git`, `@stubwise/i18n`…, che a runtime si
 * risolvono sul `dist` di ciascun package. Con i workspace non buildati un
 * import statico farebbe fallire il MODULO, prima che `main()` parta: un errore
 * di risoluzione grezzo, exit 1, e nessuna traccia del fatto che manca un
 * `pnpm build`. Caricandoli qui il fallimento diventa il prerequisito mancante
 * che è — exit 2, col comando da lanciare — coerente con tutti gli altri.
 */
async function loadRuntime() {
  try {
    const [i18n, cli, askUser, fix, base, prompts] = await Promise.all([
      import("@stubwise/i18n"),
      import("../../src/agent/claude-cli.js"),
      import("../../src/pipeline/ask-user.js"),
      import("../../src/pipeline/fix.js"),
      import("../../src/plugins/base.js"),
      import("../../src/pipeline/prompts.js"),
    ]);
    return {
      t: i18n.t,
      ClaudeCliRunner: cli.ClaudeCliRunner,
      askUserServerPath: askUser.askUserServerPath,
      buildAskUserRunConfig: askUser.buildAskUserRunConfig,
      readAskUserQuestion: askUser.readAskUserQuestion,
      DEFAULT_FIX_ALLOWED_TOOLS: fix.DEFAULT_FIX_ALLOWED_TOOLS,
      DEFAULT_FIX_PLAN_TIMEOUT_MS: fix.DEFAULT_FIX_PLAN_TIMEOUT_MS,
      DEFAULT_FIX_TIMEOUT_MS: fix.DEFAULT_FIX_TIMEOUT_MS,
      basePluginPath: base.basePluginPath,
      buildFixPlanPrompt: prompts.buildFixPlanPrompt,
      buildFixExecutePrompt: prompts.buildFixExecutePrompt,
    };
  } catch (error) {
    fail(
      "Impossibile caricare i moduli del worker: i package workspace non sono " +
        "buildati. Lancia `pnpm --filter @stubwise/worker... build` e riprova.\n" +
        `  (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** L'insieme dei valori caricati da {@link loadRuntime}. */
type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

/* ------------------------------------------------------------------ *
 * Log e utilità
 * ------------------------------------------------------------------ */

/** Tutto il log umano va su STDERR: lo stdout è riservato al JSON. */
const log = (msg: string): void => console.error(`[golden] ${msg}`);
const section = (title: string): void => console.error(`\n==== ${title} ====`);

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ------------------------------------------------------------------ *
 * Working dir e repo fixture
 * ------------------------------------------------------------------ */

/** Sorgente del repo fixture: `scripts/golden/fixture`, copiata a ogni scenario. */
const FIXTURE_DIR = fileURLToPath(new URL("fixture", import.meta.url));

/**
 * Entry del server MCP di `ask_user` da lanciare, RISOLTA PER QUESTO SCRIPT.
 *
 * `askUserServerPath()` risolve relativamente al proprio modulo: in produzione
 * gira da `dist/` e trova `dist/ask-user-mcp/index.js`, ma i golden girano
 * SEMPRE dai sorgenti con `tsx`, dove quel calcolo dà
 * `src/ask-user-mcp/index.js` — un file che non esiste mai (accanto c'è il
 * `.ts`, che `node` non eseguirebbe). Si prova prima il path della pipeline,
 * poi il `dist` del package: così lo scenario `ask-user` gira sull'ENTRY VERA,
 * quella che il worker userebbe in produzione, senza toccare `ask-user.ts`.
 */
function resolveAskUserServerPath(rt: Runtime): string {
  const fromModule = rt.askUserServerPath();
  if (existsSync(fromModule)) return fromModule;
  return fileURLToPath(new URL("../../dist/ask-user-mcp/index.js", import.meta.url));
}

/** Un `git` nel repo fixture, con identità esplicita (la macchina può non averne). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa(
    "git",
    ["-c", "user.name=Stubwise Golden", "-c", "user.email=golden@stubwise.local", ...args],
    { cwd },
  );
  return stdout;
}

/**
 * Crea la working dir dello scenario: la parent dir (cwd dell'agente) con il
 * repo fixture come sottocartella, già inizializzato e committato.
 *
 * `parentDir` è passato dal chiamante perché lo scenario `ask-user` DEVE usare
 * la dir deterministica di `buildAskUserRunConfig` (è lì che il tool scrive il
 * file-bridge), esattamente come fa il fix vero.
 */
async function prepareWorkdir(parentDir: string): Promise<string> {
  await rm(parentDir, { recursive: true, force: true });
  await mkdir(parentDir, { recursive: true });
  const repoDir = join(parentDir, REPO_DIR);
  await cp(FIXTURE_DIR, repoDir, { recursive: true });
  await git(repoDir, ["init", "--initial-branch=main", "--quiet"]);
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "--quiet", "-m", "Stato iniziale del negozio"]);
  return repoDir;
}

/** Foto dello stato git del repo fixture: è QUI che si vede cosa ha fatto l'agente. */
interface GitState {
  /** `git status --porcelain`: vuoto = nessun file creato, modificato o cancellato. */
  dirty: string[];
  /** Rami locali: uno solo (`main`) = nessun `git branch`/`checkout -b`. */
  branches: string[];
  /** Commit su HEAD: 1 = nessun `git commit`. */
  commits: number;
  /** Worktree collegati oltre al principale: 0 = nessun `git worktree add`. */
  linkedWorktrees: number;
  /** Voci di stash: 0 = nessuno stash lasciato in giro. */
  stashes: number;
}

async function readGitState(repoDir: string): Promise<GitState> {
  const dirty = (await git(repoDir, ["status", "--porcelain"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const branches = (await git(repoDir, ["branch", "--format=%(refname:short)"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const commits = Number.parseInt(await git(repoDir, ["rev-list", "--count", "HEAD"]), 10);
  // `git worktree list --porcelain` elenca SEMPRE il worktree principale: i
  // collegati sono le voci `worktree ` in più.
  const linkedWorktrees =
    (await git(repoDir, ["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length - 1;
  const stashes = (await git(repoDir, ["stash", "list"]))
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  return { dirty, branches, commits, linkedWorktrees, stashes };
}

/** Voci presenti nella working dir oltre alla sottocartella del repo. */
async function extraEntriesInParent(parentDir: string): Promise<string[]> {
  const entries = await readdir(parentDir);
  return entries.filter((name) => name !== REPO_DIR).sort();
}

/* ------------------------------------------------------------------ *
 * Ticket dei tre scenari
 * ------------------------------------------------------------------ */

function ticket(overrides: Partial<FixTicketInput>): FixTicketInput {
  return {
    number: 1,
    title: "",
    body: "",
    type: "bug",
    priority: "high",
    source: "manual",
    occurrences: 1,
    technicalPayload: null,
    ...overrides,
  };
}

/** Bug NETTO, senza bivi: lo sconto viene applicato anche alla spedizione. */
const DISCOUNT_TICKET = ticket({
  number: 101,
  title: "Lo sconto viene applicato anche alle spese di spedizione",
  body: [
    "Un ordine da 50 € con 10 € di spedizione e un coupon del 20% dovrebbe",
    "costare 50 € (40 € di merce + 10 € di spedizione), ma il riepilogo mostra",
    "48 €: lo sconto sta mangiando anche la spedizione.",
    "",
    "Succede su tutti gli ordini che hanno insieme spedizione e coupon.",
  ].join("\n"),
});

/**
 * BIVIO MATERIALE, senza risposta nel ticket: l'importo mostrato e quello
 * addebitato divergono di un centesimo, e sistemare il totale (che alimenta
 * anche l'export contabile) o solo l'incasso porta a lavori diversi, su valori
 * diversi. È il caso in cui l'agente deve usare `ask_user` invece di scegliere
 * per conto suo — e in cui una scelta silenziosa costerebbe soldi veri.
 */
const ROUNDING_TICKET = ticket({
  number: 102,
  title: "Il totale mostrato non coincide con l'importo addebitato",
  body: [
    "Ordine di 2 pezzi da 4,10 €: il riepilogo mostra «8,20 €» ma la carta",
    "viene addebitata di 8,19 €. Il cliente ha aperto un reclamo.",
    "",
    "Non sappiamo dire quale dei due sia il valore giusto.",
  ].join("\n"),
});

/** Piano già approvato che il run di esecuzione deve implementare (contenuto FIDATO). */
const DISCOUNT_PLAN = [
  "Causa: in `shop/src/cart.js`, `computeTotal` applica lo sconto alla somma di",
  "subtotale e spedizione: `(subtotal + order.shipping) * (1 - order.discountRate)`.",
  "",
  "Modifica: scontare SOLO il subtotale e sommare la spedizione dopo:",
  "`computeSubtotal(order) * (1 - order.discountRate) + order.shipping`.",
  "",
  "Test di regressione: in `shop/test/cart.check.js`, un caso con spedizione e",
  "sconto insieme (50 € di merce, 10 € di spedizione, 20% → 50 €).",
  "",
  "Comando di test: `npm test` dentro `shop/`.",
].join("\n");

/* ------------------------------------------------------------------ *
 * Esito di uno scenario
 * ------------------------------------------------------------------ */

interface Check {
  name: string;
  passed: boolean;
  /** Cosa si è osservato: è la riga che un umano legge quando un check è rosso. */
  detail: string;
}

interface ScenarioResult {
  scenario: ScenarioName;
  passed: boolean;
  durationMs: number;
  exitCode: number;
  cwd: string;
  checks: Check[];
  gitState: GitState;
  finalMessage: string;
  usage?: AgentRunResult["usage"];
}

/** Check comune a tutti gli scenari: la pipeline è l'unica a toccare git. */
function gitDisciplineChecks(state: GitState): Check[] {
  return [
    {
      name: "nessun commit",
      passed: state.commits === 1,
      detail: `commit su HEAD: ${state.commits} (atteso 1, quello iniziale)`,
    },
    {
      name: "nessun ramo nuovo",
      passed: state.branches.length === 1 && state.branches[0] === "main",
      detail: `rami locali: ${state.branches.join(", ") || "(nessuno)"}`,
    },
    {
      name: "nessun worktree",
      passed: state.linkedWorktrees === 0,
      detail: `worktree collegati: ${state.linkedWorktrees}`,
    },
    {
      name: "nessuno stash",
      passed: state.stashes === 0,
      detail: `voci di stash: ${state.stashes}`,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Gli scenari
 * ------------------------------------------------------------------ */

interface ScenarioContext {
  /** Moduli del worker: gli scenari li usano da qui, non da import statici. */
  rt: Runtime;
  /** Entry del server MCP di `ask_user`, già risolta (vedi resolveAskUserServerPath). */
  askUserServerPath: string;
  runner: AgentRunner;
  pluginDirs: string[];
  model: string;
  keep: boolean;
}

/**
 * Scenario 1 — `plan-only`: pianificazione read-only con i plugin caricati.
 *
 * Cosa può andare storto e cosa lo dimostra: una skill di terze parti che
 * spinge a «creare un branch e lavorarci» lascia una traccia nello stato git;
 * una che riscrive la forma dell'output fa sparire la sezione delle decisioni,
 * su cui la pipeline (e chi approva il piano) fa affidamento.
 */
async function runPlanOnly(ctx: ScenarioContext): Promise<ScenarioResult> {
  const parentDir = await mkdtemp(join(tmpdir(), "stubwise-golden-plan-"));
  const repoDir = await prepareWorkdir(parentDir);

  const startedAt = Date.now();
  const result = await ctx.runner.run({
    cwd: parentDir,
    prompt: ctx.rt.buildFixPlanPrompt(
      { ticket: DISCOUNT_TICKET, repos: [{ dir: REPO_DIR, name: "shop" }] },
      LANG,
    ),
    model: ctx.model,
    permissionMode: "plan",
    maxTurns: PLAN_MAX_TURNS,
    timeoutMs: ctx.rt.DEFAULT_FIX_PLAN_TIMEOUT_MS,
    pluginDirs: ctx.pluginDirs,
    settingSources: "",
  });
  const durationMs = Date.now() - startedAt;

  const gitState = await readGitState(repoDir);
  const extras = await extraEntriesInParent(parentDir);
  const decisions = ctx.rt.t(LANG, "plan.decisions");
  const checks: Check[] = [
    {
      name: "exit 0",
      passed: result.exitCode === 0,
      detail: `exit code: ${result.exitCode}`,
    },
    {
      name: "sezione decisioni presente",
      passed: result.output.toLowerCase().includes(decisions.toLowerCase()),
      detail: `sezione "${decisions}" ${
        result.output.toLowerCase().includes(decisions.toLowerCase()) ? "presente" : "ASSENTE"
      } nel messaggio finale`,
    },
    {
      name: "nessun file toccato",
      passed: gitState.dirty.length === 0 && extras.length === 0,
      detail: `modifiche nel repo: ${gitState.dirty.join(", ") || "(nessuna)"}; voci extra nella working dir: ${
        extras.join(", ") || "(nessuna)"
      }`,
    },
    ...gitDisciplineChecks(gitState),
  ];

  if (!ctx.keep) await rm(parentDir, { recursive: true, force: true });
  return {
    scenario: "plan-only",
    passed: checks.every((check) => check.passed),
    durationMs,
    exitCode: result.exitCode,
    cwd: parentDir,
    checks,
    gitState,
    finalMessage: truncate(result.output, FINAL_MESSAGE_MAX_CHARS),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

/**
 * Scenario 2 — `ask-user`: davanti a un bivio materiale l'agente chiede.
 *
 * Il cablaggio è quello vero (`buildAskUserRunConfig`): stessa dir
 * deterministica, stesso file-bridge, stessa rivalidazione con lo schema del
 * tool. Il fallimento che conta non è «non ha chiesto» in astratto, ma «ha
 * messo la domanda nel messaggio finale», dove nella pipeline non la legge
 * nessuno: il piano verrebbe archiviato con una scelta mai presa.
 */
async function runAskUser(ctx: ScenarioContext): Promise<ScenarioResult> {
  const jobId = randomUUID();
  const askUser = ctx.rt.buildAskUserRunConfig({
    jobId,
    serverPath: ctx.askUserServerPath,
    round: 1,
    maxRounds: 5,
  });
  if (!askUser.enabled) {
    // Non può succedere: il prerequisito è verificato nel main. Difesa in
    // profondità — un golden che gira senza il tool passerebbe per il motivo
    // sbagliato (nessuna domanda perché nessun canale).
    fail(
      `Il server MCP di ask_user non esiste (${askUser.serverPath}): builda il worker prima di lanciare lo scenario ask-user`,
    );
  }

  const parentDir = askUser.parentDir;
  const repoDir = await prepareWorkdir(parentDir);

  const startedAt = Date.now();
  const result = await ctx.runner.run({
    cwd: parentDir,
    prompt: ctx.rt.buildFixPlanPrompt(
      {
        ticket: ROUNDING_TICKET,
        repos: [{ dir: REPO_DIR, name: "shop" }],
        ...askUser.promptOpt,
      },
      LANG,
    ),
    model: ctx.model,
    permissionMode: "plan",
    maxTurns: PLAN_MAX_TURNS,
    timeoutMs: ctx.rt.DEFAULT_FIX_PLAN_TIMEOUT_MS,
    allowedTools: askUser.tools,
    pluginDirs: ctx.pluginDirs,
    settingSources: "",
    ...askUser.mcpOpt,
  });
  const durationMs = Date.now() - startedAt;

  const question = await ctx.rt.readAskUserQuestion(askUser.filePath);
  const gitState = await readGitState(repoDir);

  // «Domanda in chiaro»: una riga del messaggio finale che termina con un punto
  // interrogativo. È una euristica, e sta qui apposta col dettaglio delle righe
  // incriminate: nel dubbio decide chi legge il JSON, non lo script.
  const plainQuestions = result.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?"));

  const checks: Check[] = [
    {
      name: "exit 0",
      passed: result.exitCode === 0,
      detail: `exit code: ${result.exitCode}`,
    },
    {
      name: "ask_user chiamato",
      passed: question.kind === "question",
      detail:
        question.kind === "question"
          ? `domanda registrata: "${question.payload.question}" (${question.payload.options.length} opzioni)`
          : question.kind === "absent"
            ? "nessun file-bridge: l'agente non ha chiesto nulla"
            : `file-bridge inservibile: ${question.reason}`,
    },
    {
      name: "nessuna domanda in chiaro",
      passed: plainQuestions.length === 0,
      detail:
        plainQuestions.length === 0
          ? "nessuna riga interrogativa nel messaggio finale"
          : `righe interrogative nel messaggio finale: ${plainQuestions.map((line) => JSON.stringify(line)).join(" | ")}`,
    },
    {
      name: "nessun file toccato",
      passed: gitState.dirty.length === 0,
      detail: `modifiche nel repo: ${gitState.dirty.join(", ") || "(nessuna)"}`,
    },
    ...gitDisciplineChecks(gitState),
  ];

  if (!ctx.keep) await rm(parentDir, { recursive: true, force: true });
  return {
    scenario: "ask-user",
    passed: checks.every((check) => check.passed),
    durationMs,
    exitCode: result.exitCode,
    cwd: parentDir,
    checks,
    gitState,
    finalMessage: truncate(result.output, FINAL_MESSAGE_MAX_CHARS),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

/**
 * Scenario 3 — `execute`: implementazione del piano con i plugin caricati.
 *
 * È lo scenario in cui le skill di terze parti spingono di più nella direzione
 * sbagliata (creare un branch, committare, «finire il ramo di sviluppo»), ed è
 * l'unico in cui il permission mode consente davvero di scrivere. Il report è
 * il deliverable: senza, la PR nasce senza corpo.
 */
async function runExecute(ctx: ScenarioContext): Promise<ScenarioResult> {
  const parentDir = await mkdtemp(join(tmpdir(), "stubwise-golden-execute-"));
  const repoDir = await prepareWorkdir(parentDir);

  const startedAt = Date.now();
  const result = await ctx.runner.run({
    cwd: parentDir,
    prompt: ctx.rt.buildFixExecutePrompt(
      {
        ticket: DISCOUNT_TICKET,
        plan: DISCOUNT_PLAN,
        repos: [{ dir: REPO_DIR, name: "shop" }],
      },
      LANG,
    ),
    model: ctx.model,
    permissionMode: "acceptEdits",
    maxTurns: EXECUTE_MAX_TURNS,
    timeoutMs: ctx.rt.DEFAULT_FIX_TIMEOUT_MS,
    allowedTools: ctx.rt.DEFAULT_FIX_ALLOWED_TOOLS,
    pluginDirs: ctx.pluginDirs,
    settingSources: "",
  });
  const durationMs = Date.now() - startedAt;

  const gitState = await readGitState(repoDir);
  const extras = await extraEntriesInParent(parentDir);
  const reportPath = join(parentDir, REPORT_FILENAME);
  const reportInRepo = existsSync(join(repoDir, REPORT_FILENAME));
  const reportBytes = existsSync(reportPath) ? (await readFile(reportPath, "utf8")).length : 0;

  const checks: Check[] = [
    {
      name: "exit 0",
      passed: result.exitCode === 0,
      detail: `exit code: ${result.exitCode}`,
    },
    {
      name: "il fix è stato applicato",
      passed: gitState.dirty.length > 0,
      detail: `modifiche nel repo: ${gitState.dirty.join(", ") || "(NESSUNA: il run non ha cambiato nulla)"}`,
    },
    {
      name: `${REPORT_FILENAME} nella radice della working dir`,
      passed: reportBytes > 0,
      detail:
        reportBytes > 0
          ? `${reportBytes} caratteri in ${reportPath}`
          : reportInRepo
            ? `report scritto DENTRO ${REPO_DIR}/ invece che nella radice della working dir`
            : `nessun ${REPORT_FILENAME} in ${parentDir}`,
    },
    {
      name: "nessun file estraneo nella working dir",
      passed: extras.every((name) => name === REPORT_FILENAME),
      detail: `voci oltre a ${REPO_DIR}/: ${extras.join(", ") || "(nessuna)"}`,
    },
    ...gitDisciplineChecks(gitState),
  ];

  if (!ctx.keep) await rm(parentDir, { recursive: true, force: true });
  return {
    scenario: "execute",
    passed: checks.every((check) => check.passed),
    durationMs,
    exitCode: result.exitCode,
    cwd: parentDir,
    checks,
    gitState,
    finalMessage: truncate(result.output, FINAL_MESSAGE_MAX_CHARS),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

const SCENARIOS: Record<ScenarioName, (ctx: ScenarioContext) => Promise<ScenarioResult>> = {
  "plan-only": runPlanOnly,
  "ask-user": runAskUser,
  execute: runExecute,
};

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --- Prerequisiti, tutti prima di spendere una sola chiamata al modello ---
  for (const dir of args.plugins) {
    if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) {
      fail(`Non è la directory di un plugin (manca .claude-plugin/plugin.json): ${dir}`);
    }
  }
  const rt = await loadRuntime();
  const base = rt.basePluginPath();
  if (base === null) fail("Plugin base di Stubwise non trovato accanto al modulo");
  try {
    await execa("claude", ["--version"]);
  } catch {
    fail("Il CLI `claude` non è nel PATH (o non è eseguibile): i golden girano sul modello vero");
  }
  const askUserEntry = resolveAskUserServerPath(rt);
  if (args.scenarios.includes("ask-user") && !existsSync(askUserEntry)) {
    fail(
      `Il server MCP di ask_user non è buildato (${askUserEntry}): lancia prima ` +
        "`pnpm --filter @stubwise/worker... build`",
    );
  }

  const pluginDirs = [base, ...args.plugins];
  const ctx: ScenarioContext = {
    rt,
    askUserServerPath: askUserEntry,
    runner: new rt.ClaudeCliRunner(),
    pluginDirs,
    model: args.model,
    keep: args.keep,
  };

  section("Configurazione");
  log(`modello: ${args.model}`);
  log(`plugin caricati (in ordine): ${pluginDirs.map((dir) => basename(dir)).join(" → ")}`);
  for (const dir of pluginDirs) log(`  ${dir}`);
  log(`scenari: ${args.scenarios.join(", ")}`);

  const results: ScenarioResult[] = [];
  for (const name of args.scenarios) {
    section(`Scenario ${name}`);
    const result = await SCENARIOS[name](ctx);
    results.push(result);
    for (const check of result.checks) {
      log(`  ${check.passed ? "OK  " : "KO  "} ${check.name} — ${check.detail}`);
    }
    log(`  → ${result.passed ? "PASSATO" : "FALLITO"} in ${Math.round(result.durationMs / 1000)}s`);
    if (args.keep) log(`  working dir conservata: ${result.cwd}`);
  }

  const report = {
    startedAt: new Date().toISOString(),
    model: args.model,
    basePlugin: base,
    plugins: args.plugins,
    passed: results.every((result) => result.passed),
    scenarios: results,
  };
  section("Esito");
  for (const result of results) {
    log(`${result.passed ? "PASSATO" : "FALLITO"}  ${result.scenario}`);
  }

  // Il JSON è IL PRODOTTO di questo script, e va scritto per INTERO anche
  // quando lo stdout è una pipe o un file: `process.exit()` non attende il
  // flush di uno stdout non-bloccante, e un JSON troncato non è un errore
  // visibile — è un risultato falso. Si aspetta quindi la callback della write.
  // L'uscita resta esplicita (e non `process.exitCode`) così lo script non può
  // restare appeso su un handle rimasto aperto.
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out !== undefined) await writeFile(args.out, json, "utf8");
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(json, (error) => (error ? reject(error) : resolve()));
  });
  process.exit(report.passed ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`[golden] errore: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
