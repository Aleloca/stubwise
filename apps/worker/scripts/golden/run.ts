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
 * ============================== Gli scenari ==============================
 *
 * 1. `plan-only`  run di pianificazione (read-only) sul ticket dello sconto:
 *    il piano ha la sezione delle decisioni, NESSUN file è toccato e nessun
 *    ramo/worktree/commit è nato nel repo fixture. `ask_user` NON è cablato:
 *    questo scenario non misura le domande, in nessuno dei due versi.
 * 2. `ask-user`   stesso run con `ask_user` cablato, su un ticket con un BIVIO
 *    DI POLICY che nessun file del repo decide (la soglia della spedizione
 *    gratuita va sul subtotale prima o dopo il coupon?): l'agente deve chiamare
 *    `ask_user` — il file-bridge esiste ed è valido — e non lasciare la domanda
 *    in chiaro nel messaggio finale, dove non la leggerebbe nessuno.
 * 3. `no-ask`     stesso cablaggio di `ask-user`, ma su un ticket la cui
 *    risposta SI RICAVA dal repo (i centesimi tagliati dal gateway): l'agente
 *    NON deve chiamare `ask_user`. È il verso opposto, e si valuta insieme al 2.
 * 4. `execute`    run di esecuzione: il fix è applicato, `STUBWISE_REPORT.md`
 *    è nella radice della working dir e NESSUN `git commit`/`push` è avvenuto.
 * 5. `correction` run di correzione post-PR sul branch della PR, col primo
 *    giro già committato: il test chiesto dalla review è aggiunto, il codice
 *    del primo giro NON è riprogettato, il report è nella radice della working
 *    dir e nessun commit/ramo nuovo è nato oltre a quelli preparati.
 * 6. `intervene`  sessioni degli agenti (design 2026-10-08 §7.1): due run in
 *    streaming col runner VERO e un relay in memoria. (a) un messaggio scritto
 *    a metà turno SENZA interruzione viene assorbito nello stesso turno (un
 *    solo `result`) e il file ne tiene conto; (b) «Ferma e scrivi»: un
 *    `result` error_during_execution, il processo resta vivo, il turno dopo
 *    cambia direzione (`add`, non `sum`) e il run finisce in success.
 *    Il commento sul ticket (template `comment.agentIntervention*`) NON è
 *    coperto qui: lo scrive `SessionInputRelay` sul database, che i golden
 *    non hanno — lo coprono i test di `src/sessions/relay.test.ts`.
 * 7. `intervene-plan` un intervento non sostituisce il PIANO (design §12):
 *    due pianificazioni read-only (segmento `plan`, ticket dello sconto).
 *    (a) `plan-absorb`: un messaggio a metà turno viene assorbito e il
 *    messaggio finale ha ancora la sezione delle decisioni (il promemoria
 *    `DELIVERABLE_REMINDER` accodato su stdin fa il suo lavoro); (b)
 *    `plan-grace`: un messaggio subito DOPO il primo `result`, nella grazia,
 *    viene RIFIUTATO dal runner (`deliver` → false, il relay lo segnerebbe
 *    `undelivered`), nessun turno nuovo parte e l'output è il piano. Il
 *    verso (b) è deterministico (lo decide il runner, non il modello); il
 *    controllo a valle della pipeline — piano senza la sua forma dopo un
 *    intervento → job fallito — vuole il database e lo coprono i test di
 *    `src/pipeline/fix.test.ts` («plan-only con un intervento del
 *    maintainer»), quello del relay `src/sessions/relay.test.ts`.
 * 8. `stop-pause` «Ferma» senza testo (design queue-stop §2), due run in
 *    streaming col runner VERO. (a) `pause-resume`: al primo `tool_use` lo
 *    «Ferma» manda il solo interrupt (nessun messaggio, nessun evento
 *    `input`), il processo resta vivo in pausa per più della grazia, poi un
 *    messaggio fa ripartire il run, preso DOPO il result del turno fermato
 *    (error_during_execution, o success se il CLI l'aveva già chiuso: in un
 *    segmento coi file la pausa resta su un CLI fermo), che cambia strada
 *    (`add`, non `sum`) e finisce in success; (b) `pause-expire`: nessun messaggio, la pausa
 *    scade (tetto CORTO, solo qui: in produzione è `AGENT_PAUSE_BUDGET_MS`)
 *    e il run è ANNULLATO con `AgentRunCancelledError`, non un timeout. Cosa
 *    ne fa la pipeline (job `skipped`, ticket, commento) lo coprono i test di
 *    `src/pipeline/fix.test.ts` e `correction.test.ts`.
 *
 * Il runner degli scenari è quello di PRODUZIONE: `StreamingClaudeRunner`
 * (`AGENT_STREAMING=true`, il default). `--classic` usa `ClaudeCliRunner`
 * (`AGENT_STREAMING=false`, il rollback); `intervene` è sempre in streaming.
 * Il binario del CLI si sceglie con `--claude <path>`: i golden vanno girati
 * con la STESSA versione pinnata nel Dockerfile del worker.
 *
 * ============================ Come si verifica ============================
 *
 * `plan-only` ed `execute` sono formulati nel design (§8) come «dai tool usati nel log».
 * Nessuno dei due runner dà qui un log dei tool: `ClaudeCliRunner`
 * (`--classic`) lancia il CLI con `--output-format json`, che restituisce il
 * solo oggetto-risultato finale (messaggio, usage, session_id) e NON la
 * trascrizione; `StreamingClaudeRunner` la trascrizione la legge dallo
 * stream-json, ma la consegna solo agli hook di una sessione, e gli scenari
 * diversi da `intervene`/`intervene-plan` lo costruiscono SENZA hook (niente
 * database, niente sessione: nessun evento registrato). Le
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
import type { LiveProcessHandle } from "../../src/agent/streaming-cli.js";
import type { FixTicketInput } from "../../src/pipeline/prompts.js";

import {
  askUserCheck,
  type AskUserExpectation,
  type Check,
  interveneChecks,
  stopPauseChecks,
  type InterveneEvent,
  isScenarioName,
  planInterveneChecks,
  SCENARIO_NAMES,
  type ScenarioName,
} from "./checks.js";

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
  /** Binario del CLI `claude` (default: quello nel PATH). */
  claude: string;
  /** Runner storico (`AGENT_STREAMING=false`) invece di quello in streaming. */
  classic: boolean;
}

function printUsage(): void {
  console.error(
    [
      "Uso: pnpm --filter @stubwise/worker golden -- --plugin <dir> [opzioni]",
      "",
      "  --plugin <dir>      directory di UN plugin da caricare (ripetibile, nell'ordine).",
      "                      Tipicamente la dir materializzata: /plugins/<slug>/<sha>.",
      "                      Il plugin base di Stubwise è sempre caricato per primo.",
      "  --scenario <nome>   solo questo scenario (ripetibile). Default: tutti.",
      `                      Nomi: ${SCENARIO_NAMES.join(", ")}.`,
      `  --model <nome>      modello dei run. Default: ${DEFAULT_MODEL}.`,
      "  --claude <path>     binario del CLI. Default: `claude` nel PATH. Usa la versione",
      "                      pinnata in apps/worker/Dockerfile (ARG CLAUDE_CODE_VERSION).",
      "  --classic           runner storico (AGENT_STREAMING=false). Default: streaming.",
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
  let claude = "claude";
  let classic = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm può inoltrare il separatore `--` come argomento letterale: ignoralo.
    if (arg === "--" || arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--keep") {
      keep = true;
    } else if (arg === "--classic") {
      classic = true;
    } else if (
      arg === "--plugin" ||
      arg === "--scenario" ||
      arg === "--model" ||
      arg === "--out" ||
      arg === "--claude"
    ) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        fail(`L'opzione ${arg} richiede un valore`);
      }
      if (arg === "--plugin") plugins.push(value);
      else if (arg === "--model") model = value;
      else if (arg === "--out") out = value;
      else if (arg === "--claude") claude = value;
      else {
        if (!isScenarioName(value)) {
          fail(`Scenario sconosciuto: ${value} (attesi: ${SCENARIO_NAMES.join(", ")})`);
        }
        scenarios.push(value);
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
    claude,
    classic,
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
    const [i18n, cli, streaming, askUser, fix, base, prompts] = await Promise.all([
      import("@stubwise/i18n"),
      import("../../src/agent/claude-cli.js"),
      import("../../src/agent/streaming-cli.js"),
      import("../../src/pipeline/ask-user.js"),
      import("../../src/pipeline/fix.js"),
      import("../../src/plugins/base.js"),
      import("../../src/pipeline/prompts.js"),
    ]);
    return {
      t: i18n.t,
      ClaudeCliRunner: cli.ClaudeCliRunner,
      StreamingClaudeRunner: streaming.StreamingClaudeRunner,
      askUserServerPath: askUser.askUserServerPath,
      buildAskUserRunConfig: askUser.buildAskUserRunConfig,
      readAskUserQuestion: askUser.readAskUserQuestion,
      DEFAULT_FIX_ALLOWED_TOOLS: fix.DEFAULT_FIX_ALLOWED_TOOLS,
      DEFAULT_FIX_PLAN_TIMEOUT_MS: fix.DEFAULT_FIX_PLAN_TIMEOUT_MS,
      DEFAULT_FIX_TIMEOUT_MS: fix.DEFAULT_FIX_TIMEOUT_MS,
      basePluginPath: base.basePluginPath,
      buildFixPlanPrompt: prompts.buildFixPlanPrompt,
      buildFixExecutePrompt: prompts.buildFixExecutePrompt,
      buildCorrectionPrompt: prompts.buildCorrectionPrompt,
      planHasRequiredShape: prompts.planHasRequiredShape,
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
  /** Ramo su cui sta HEAD a fine run: diverso da quello preparato = l'agente ha cambiato ramo. */
  head: string;
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
  const head = (await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
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
  return { dirty, branches, head, commits, linkedWorktrees, stashes };
}

/** Voci presenti nella working dir oltre alla sottocartella del repo. */
async function extraEntriesInParent(parentDir: string): Promise<string[]> {
  const entries = await readdir(parentDir);
  return entries.filter((name) => name !== REPO_DIR).sort();
}

/* ------------------------------------------------------------------ *
 * Ticket degli scenari
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
 * BIVIO DI POLICY non ricavabile: soglia sul subtotale prima o dopo il coupon.
 * Ramo A: cambia `buildOrder` e i test, più clienti avranno la spedizione
 * gratis. Ramo B: il codice è già corretto, il lavoro è sul testo del banner o
 * sul riepilogo. Nessun file del repo decide.
 *
 * È il ticket di `ask-user`: qui l'agente deve chiedere invece di scegliere.
 */
const SHIPPING_THRESHOLD_TICKET = ticket({
  number: 103,
  title: "Spedizione gratuita negata con il coupon",
  body: [
    'Il banner dice "spedizione gratuita sopra i 60 €". Un cliente aveva 65 € di',
    "prodotti nel carrello e ha usato il coupon BENVENUTO15: ha pagato 55,25 € più",
    "6,90 € di spedizione, e ha aperto un reclamo perché il suo carrello valeva più",
    "di 60 €. L'assistenza gli dà ragione, il marketing dice che la soglia si",
    "riferisce a quanto si spende davvero. La regola non è scritta da nessuna parte.",
  ].join("\n"),
});

/**
 * Bivio APPARENTE, con la risposta nel repo: l'importo mostrato (8,20) e quello
 * addebitato (8,19) divergono di un centesimo, ma 2 × 4,10 fa 8,20, il README
 * della fixture dice che il totale è il valore autorevole, e l'unica correzione
 * possibile è il `Math.trunc` di `payment.js`. Un agente che chiede qui fa una
 * domanda inutile.
 *
 * È il ticket di `no-ask`: l'agente deve pianificare senza chiamare `ask_user`.
 * Era il ticket di `ask-user`, finché i run non hanno mostrato che il modello
 * che non chiedeva aveva ragione.
 */
const ROUNDING_NO_ASK_TICKET = ticket({
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

/** Lo stato git che lo scenario ha PREPARATO prima del run: è il confronto dei check. */
interface ExpectedGit {
  /** Commit su HEAD preparati dallo scenario (1 = solo quello iniziale). */
  commits: number;
  /** Rami locali preparati dallo scenario (ordine indifferente). */
  branches: string[];
  /** Ramo su cui lo scenario ha lasciato HEAD. */
  head: string;
}

const DEFAULT_EXPECTED_GIT: ExpectedGit = { commits: 1, branches: ["main"], head: "main" };

/** Check comune a tutti gli scenari: la pipeline è l'unica a toccare git. */
function gitDisciplineChecks(state: GitState, expected: ExpectedGit = DEFAULT_EXPECTED_GIT): Check[] {
  const sameBranches =
    state.branches.length === expected.branches.length &&
    [...state.branches].sort().every((name, i) => name === [...expected.branches].sort()[i]);
  return [
    {
      name: "nessun commit",
      passed: state.commits === expected.commits,
      detail: `commit su HEAD: ${state.commits} (atteso ${expected.commits}: ${
        expected.commits === 1 ? "quello iniziale" : "quelli preparati dallo scenario"
      })`,
    },
    {
      name: "nessun ramo nuovo",
      passed: sameBranches && state.head === expected.head,
      detail: `rami locali: ${state.branches.join(", ") || "(nessuno)"}; HEAD su ${state.head} (attesi: ${expected.branches.join(", ")}; HEAD su ${expected.head})`,
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
  /** Binario del CLI, per i runner che lo scenario costruisce da sé (`intervene`). */
  claudePath: string;
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
  // Lo STESSO controllo che la pipeline fa dopo un intervento (pipeline/prompts.ts).
  const decisions = ctx.rt.t(LANG, "plan.decisions");
  const hasDecisions = ctx.rt.planHasRequiredShape(result.output, LANG);
  const checks: Check[] = [
    {
      name: "exit 0",
      passed: result.exitCode === 0,
      detail: `exit code: ${result.exitCode}`,
    },
    {
      name: "sezione decisioni presente",
      passed: hasDecisions,
      detail: `sezione "${decisions}" ${hasDecisions ? "presente" : "ASSENTE"} nel messaggio finale`,
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
 * Cablaggio comune a `ask-user` e `no-ask`: un run di pianificazione con il
 * tool `ask_user` disponibile, come lo prepara la pipeline vera
 * (`buildAskUserRunConfig`): stessa dir deterministica, stesso file-bridge,
 * stessa rivalidazione con lo schema del tool. I due scenari cambiano solo il
 * ticket e il verso del check su `ask_user` (vedi `askUserCheck`).
 */
async function runWithAskUser(
  ctx: ScenarioContext,
  opts: { scenario: ScenarioName; ticket: FixTicketInput; expectation: AskUserExpectation },
): Promise<ScenarioResult> {
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
    // sbagliato (in `ask-user` rosso perché nessun canale, in `no-ask` VERDE
    // per la stessa ragione: nessuna domanda perché nessun canale).
    fail(
      `Il server MCP di ask_user non esiste (${askUser.serverPath}): builda il worker prima di lanciare lo scenario ${opts.scenario}`,
    );
  }

  const parentDir = askUser.parentDir;
  const repoDir = await prepareWorkdir(parentDir);

  const startedAt = Date.now();
  const result = await ctx.runner.run({
    cwd: parentDir,
    prompt: ctx.rt.buildFixPlanPrompt(
      {
        ticket: opts.ticket,
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
  // incriminate: nel dubbio decide chi legge il JSON, non lo script. Vale nei
  // due versi: in `no-ask` una domanda in chiaro è la domanda inutile che il
  // tool non ha visto, e nella pipeline non la leggerebbe nessuno.
  const plainQuestions = result.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?"));

  // In `no-ask` il run arriva a un piano, quindi la sezione delle decisioni
  // deve esserci come in `plan-only`. In `ask-user` no: il run si ferma sulla
  // domanda, e il piano lo scrive la ripresa.
  const decisions = ctx.rt.t(LANG, "plan.decisions");
  const hasDecisions = ctx.rt.planHasRequiredShape(result.output, LANG);

  const checks: Check[] = [
    {
      name: "exit 0",
      passed: result.exitCode === 0,
      detail: `exit code: ${result.exitCode}`,
    },
    askUserCheck(question, opts.expectation),
    {
      name: "nessuna domanda in chiaro",
      passed: plainQuestions.length === 0,
      detail:
        plainQuestions.length === 0
          ? "nessuna riga interrogativa nel messaggio finale"
          : `righe interrogative nel messaggio finale: ${plainQuestions.map((line) => JSON.stringify(line)).join(" | ")}`,
    },
    ...(opts.expectation === "does-not-ask"
      ? [
          {
            name: "sezione decisioni presente",
            passed: hasDecisions,
            detail: `sezione "${decisions}" ${hasDecisions ? "presente" : "ASSENTE"} nel messaggio finale`,
          },
        ]
      : []),
    {
      name: "nessun file toccato",
      passed: gitState.dirty.length === 0,
      detail: `modifiche nel repo: ${gitState.dirty.join(", ") || "(nessuna)"}`,
    },
    ...gitDisciplineChecks(gitState),
  ];

  if (!ctx.keep) await rm(parentDir, { recursive: true, force: true });
  return {
    scenario: opts.scenario,
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
 * Scenario 2 — `ask-user`: davanti a un bivio di policy che nessun file del
 * repo decide, l'agente chiede.
 *
 * Il fallimento che conta non è «non ha chiesto» in astratto, ma «ha scelto da
 * sé» o «ha messo la domanda nel messaggio finale», dove nella pipeline non la
 * legge nessuno: il piano verrebbe archiviato con una scelta mai presa.
 */
function runAskUser(ctx: ScenarioContext): Promise<ScenarioResult> {
  return runWithAskUser(ctx, {
    scenario: "ask-user",
    ticket: SHIPPING_THRESHOLD_TICKET,
    expectation: "asks",
  });
}

/**
 * Scenario 3 — `no-ask`: con `ask_user` disponibile, su un ticket la cui
 * risposta si ricava dal repo, l'agente NON chiede.
 *
 * È la prima guardia contro le domande inutili: `plan-only` non cabla
 * `ask_user` e quindi non le può misurare, e `ask-user` misura solo il verso
 * opposto. Una guida che spinge a chiedere di più fa diventare verde
 * `ask-user` e rosso questo: per questo i due si valutano insieme.
 */
function runNoAsk(ctx: ScenarioContext): Promise<ScenarioResult> {
  return runWithAskUser(ctx, {
    scenario: "no-ask",
    ticket: ROUNDING_NO_ASK_TICKET,
    expectation: "does-not-ask",
  });
}

/**
 * Scenario 4 — `execute`: implementazione del piano con i plugin caricati.
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

/** Branch della PR dello scenario `correction`: la forma che la pipeline usa (`stubwise/ticket-N`). */
const CORRECTION_BRANCH = `stubwise/ticket-${DISCOUNT_TICKET.number}`;

/**
 * Scenario 5 — `correction`: la correzione post-PR applica il feedback di una
 * review sulla PR già aperta. Il primo giro (sconto sistemato, test mancante) è
 * già committato sul branch della PR, come lo trova il worker; la review chiede
 * il test di regressione. Il deliverable è il test + il report; la cosa da NON
 * fare è riprogettare (`src/cart.js` era già giusto), committare o cambiare
 * ramo.
 *
 * Prompt e opzioni del run sono quelli di `runCorrection` (correction.ts):
 * `buildCorrectionPrompt`, cwd sulla parent dir, `acceptEdits`, gli allowedTools
 * del fix. Il loop di self-repair (e il suo prompt, `buildCorrectionRepairPrompt`)
 * non è simulato, come non lo è per `execute`: qui si guarda la disciplina del
 * primo run, non la riparazione dei test.
 */
async function runCorrection(ctx: ScenarioContext): Promise<ScenarioResult> {
  const parentDir = await mkdtemp(join(tmpdir(), "stubwise-golden-correction-"));
  const repoDir = await prepareWorkdir(parentDir);
  // Il branch della PR, con dentro il PRIMO GIRO: il fix giusto, senza test.
  // Il worker fa lavorare l'agente su quel branch e il prompt lo nomina: un repo
  // rimasto su `main` contraddirebbe il prompt e inviterebbe a «sistemare» il ramo.
  await git(repoDir, ["checkout", "--quiet", "-b", CORRECTION_BRANCH]);
  const cartPath = join(repoDir, "src", "cart.js");
  const cart = await readFile(cartPath, "utf8");
  const firstRound = cart.replace(
    "return (subtotal + order.shipping) * (1 - order.discountRate);",
    "return subtotal * (1 - order.discountRate) + order.shipping;",
  );
  if (firstRound === cart) {
    // La fixture è cambiata sotto lo scenario: senza il primo giro il run
    // misurerebbe un'altra cosa (il fix intero), e passerebbe per il motivo sbagliato.
    throw new Error("scenario correction: la riga del bug non è più in fixture/src/cart.js");
  }
  await writeFile(cartPath, firstRound);
  await git(repoDir, ["commit", "--quiet", "-am", `fix: lo sconto non tocca la spedizione (#${DISCOUNT_TICKET.number})`]);

  const startedAt = Date.now();
  const result = await ctx.runner.run({
    cwd: parentDir,
    prompt: ctx.rt.buildCorrectionPrompt(
      {
        ticket: DISCOUNT_TICKET,
        prUrl: `https://example.com/shop/pull/${DISCOUNT_TICKET.number}`,
        branch: CORRECTION_BRANCH,
        repo: { dir: REPO_DIR, name: "shop" },
        review: {
          verdict: "request_changes",
          summary:
            "- `shop/src/cart.js:22`: il calcolo ora è corretto.\n" +
            "- Manca il test di regressione chiesto dal ticket: spedizione e sconto insieme (50 € di merce, 10 € di spedizione, 20% → 50 €) in `shop/test/cart.check.js`.",
        },
        note: null,
        providerFeedback: [
          {
            authorLogin: "revisore",
            body: "Qui serve un caso con spedizione E sconto insieme.",
            path: "test/cart.check.js",
            line: 26,
          },
        ],
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
  const cartUnchanged = (await readFile(cartPath, "utf8")) === firstRound;

  const checks: Check[] = [
    { name: "exit 0", passed: result.exitCode === 0, detail: `exit code: ${result.exitCode}` },
    {
      name: "il test chiesto dalla review è stato aggiunto",
      passed: gitState.dirty.some((line) => line.endsWith("test/cart.check.js")),
      detail: `modifiche nel repo: ${gitState.dirty.join(", ") || "(NESSUNA)"}`,
    },
    {
      name: "nessuna riprogettazione (src/cart.js intatto)",
      passed: cartUnchanged,
      detail: cartUnchanged
        ? "src/cart.js uguale al primo giro"
        : `src/cart.js modificato rispetto al primo giro:\n${await git(repoDir, ["diff", "HEAD", "--", "src/cart.js"])}`,
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
    // Due commit preparati (l'iniziale + il primo giro), due rami (`main` e
    // quello della PR) e HEAD rimasto sul ramo della PR.
    ...gitDisciplineChecks(gitState, {
      commits: 2,
      branches: ["main", CORRECTION_BRANCH],
      head: CORRECTION_BRANCH,
    }),
  ];

  if (!ctx.keep) await rm(parentDir, { recursive: true, force: true });
  return {
    scenario: "correction",
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

/* ------------------------------------------------------------------ *
 * Scenario 6 — `intervene`
 * ------------------------------------------------------------------ */

/** File che lo scenario `intervene` fa scrivere all'agente, dentro il repo. */
const INTERVENE_FILE = "src/math.ts";

/** Tetto di ciascun run di `intervene`: è un compito di due righe. */
const INTERVENE_TIMEOUT_MS = 10 * 60 * 1000;
const INTERVENE_MAX_TURNS = 30;

const INTERVENE_PROMPT = [
  `Lavori nel repository \`${REPO_DIR}/\` (la tua working directory ne è la cartella padre).`,
  `Prima leggi \`${REPO_DIR}/README.md\` e \`${REPO_DIR}/src/cart.js\` per capire lo stile del codice.`,
  `Poi crea il file \`${REPO_DIR}/${INTERVENE_FILE}\` con una funzione TypeScript esportata`,
  "`sum(a: number, b: number): number` che restituisce la somma dei due numeri.",
  "Non fare commit, non creare rami, non scrivere test né altri file.",
].join("\n");

/** Cosa scrive il maintainer, nei due versi dello scenario. */
const INTERVENE_MESSAGES = {
  absorb: "Aggiungi anche, nello stesso file, una funzione esportata `mul(a: number, b: number): number` che restituisce il prodotto.",
  interrupt: "Ferma: la funzione chiamala `add`, non `sum`. Nel file non deve esserci nessuna funzione `sum`.",
} as const;

/**
 * Un run dello scenario `intervene` col runner in streaming VERO e un relay in
 * memoria: al primo `tool_use` (l'agente sta lavorando, il turno è aperto)
 * consegna il messaggio dal `LiveProcessHandle` registrato, come farebbe
 * `SessionInputRelay` — ma senza database, quindi senza il commento sul
 * ticket (coperto da `src/sessions/relay.test.ts`).
 */
async function runInterveneOnce(
  ctx: ScenarioContext,
  mode: "absorb" | "interrupt",
): Promise<{
  checks: Check[];
  parentDir: string;
  repoDir: string;
  result: AgentRunResult | null;
  durationMs: number;
  gitState: GitState;
}> {
  const parentDir = await mkdtemp(join(tmpdir(), `stubwise-golden-intervene-${mode}-`));
  const repoDir = await prepareWorkdir(parentDir);
  const inputId = randomUUID();
  const events: InterveneEvent[] = [];
  let handle: LiveProcessHandle | null = null;
  let delivered: boolean | null = null;

  const deliverOnce = () => {
    if (delivered !== null || handle === null) return;
    // Fuori dal callback del sink. L'evento input arriva poi all'ECO del CLI.
    delivered = false;
    setImmediate(() => {
      delivered = handle!.deliver(INTERVENE_MESSAGES[mode], mode === "interrupt", { inputId, authorUserId: null });
      log(`  [${mode}] intervento consegnato: ${delivered}`);
    });
  };

  const runner = new ctx.rt.StreamingClaudeRunner({
    claudePath: ctx.claudePath,
    log,
    hooks: {
      openSegment: () => ({
        onStart: (capabilities) => log(`  [${mode}] capabilities: ${capabilities.join(", ") || "(nessuna)"}`),
        onEvents: (drafts) => {
          for (const draft of drafts) {
            events.push({ type: draft.type, data: draft.data as Record<string, unknown> });
            if (draft.type === "turn_end") log(`  [${mode}] result: ${String(draft.data["subtype"])}`);
            if (draft.type === "tool_use") deliverOnce();
          }
        },
        onPartial: () => undefined,
        onEnd: async () => undefined,
      }),
      register: (_sessionId, h) => {
        handle = h;
        return () => {
          handle = null;
        };
      },
    },
  });

  const startedAt = Date.now();
  let result: AgentRunResult | null = null;
  let timedOut = false;
  try {
    result = await runner.run({
      cwd: parentDir,
      prompt: INTERVENE_PROMPT,
      model: ctx.model,
      permissionMode: "acceptEdits",
      maxTurns: INTERVENE_MAX_TURNS,
      timeoutMs: INTERVENE_TIMEOUT_MS,
      allowedTools: ctx.rt.DEFAULT_FIX_ALLOWED_TOOLS,
      pluginDirs: ctx.pluginDirs,
      settingSources: "",
      session: { sessionId: randomUUID(), label: "execute" },
    });
  } catch (error) {
    timedOut = error instanceof Error && error.name === "AgentTimeoutError";
    log(`  [${mode}] il run ha lanciato: ${error instanceof Error ? error.message : String(error)}`);
  }
  const durationMs = Date.now() - startedAt;

  const filePath = join(repoDir, INTERVENE_FILE);
  const source = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const gitState = await readGitState(repoDir);
  const checks = [
    ...interveneChecks({
      mode,
      inputId,
      exitCode: result?.exitCode ?? -1,
      timedOut,
      delivered,
      source,
      events,
    }),
    ...gitDisciplineChecks(gitState),
  ].map((check) => ({ ...check, name: `[${mode}] ${check.name}` }));
  return { checks, parentDir, repoDir, result, durationMs, gitState };
}

async function runIntervene(ctx: ScenarioContext): Promise<ScenarioResult> {
  const absorb = await runInterveneOnce(ctx, "absorb");
  const interrupt = await runInterveneOnce(ctx, "interrupt");
  const gitState = interrupt.gitState;
  const checks = [...absorb.checks, ...interrupt.checks];
  if (!ctx.keep) {
    await rm(absorb.parentDir, { recursive: true, force: true });
    await rm(interrupt.parentDir, { recursive: true, force: true });
  }
  const last = interrupt.result;
  return {
    scenario: "intervene",
    passed: checks.every((check) => check.passed),
    durationMs: absorb.durationMs + interrupt.durationMs,
    exitCode: last?.exitCode ?? -1,
    cwd: `${absorb.parentDir} ; ${interrupt.parentDir}`,
    checks,
    gitState,
    finalMessage: truncate(last?.output ?? "", FINAL_MESSAGE_MAX_CHARS),
    ...(last?.usage !== undefined ? { usage: last.usage } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Scenario 7 — `intervene-plan`
 * ------------------------------------------------------------------ */

/** Cosa scrive il maintainer alla pianificazione, nei due versi dello scenario. */
const PLAN_INTERVENE_MESSAGES = {
  // A metà turno: un'informazione in più, che il piano deve assorbire.
  "plan-absorb":
    "Tieni conto anche dei coupon a importo fisso: lo sconto non deve mai rendere negativo il subtotale.",
  // Nella grazia: proprio il tipo di messaggio che, accettato, sostituirebbe il piano.
  "plan-grace": "Rispondimi soltanto «ok».",
} as const;

/**
 * Una pianificazione dello scenario `intervene-plan` col runner in streaming
 * VERO e un relay in memoria, sul segmento `plan` (deliverable nell'output).
 * `plan-absorb` consegna al primo `tool_use`; `plan-grace` subito dopo il
 * primo `result` (fuori dal callback del sink, come in `intervene`), quando il
 * runner deve già aver smesso di accettare interventi.
 */
async function runPlanInterveneOnce(
  ctx: ScenarioContext,
  mode: "plan-absorb" | "plan-grace",
): Promise<{
  checks: Check[];
  parentDir: string;
  result: AgentRunResult | null;
  durationMs: number;
  gitState: GitState;
}> {
  const parentDir = await mkdtemp(join(tmpdir(), `stubwise-golden-${mode}-`));
  const repoDir = await prepareWorkdir(parentDir);
  const inputId = randomUUID();
  const events: InterveneEvent[] = [];
  let handle: LiveProcessHandle | null = null;
  let delivered: boolean | null = null;
  let attempted = false;
  const trigger = mode === "plan-absorb" ? "tool_use" : "turn_end";

  const deliverOnce = () => {
    if (attempted || handle === null) return;
    attempted = true;
    const h = handle;
    setImmediate(() => {
      delivered = h.deliver(PLAN_INTERVENE_MESSAGES[mode], false, { inputId, authorUserId: null });
      log(`  [${mode}] intervento: deliver → ${delivered}`);
    });
  };

  const runner = new ctx.rt.StreamingClaudeRunner({
    claudePath: ctx.claudePath,
    log,
    hooks: {
      openSegment: () => ({
        onStart: () => undefined,
        onEvents: (drafts) => {
          for (const draft of drafts) {
            events.push({ type: draft.type, data: draft.data as Record<string, unknown> });
            if (draft.type === "turn_end") log(`  [${mode}] result: ${String(draft.data["subtype"])}`);
            if (draft.type === trigger) deliverOnce();
          }
        },
        onPartial: () => undefined,
        onEnd: async () => undefined,
      }),
      register: (_sessionId, h) => {
        handle = h;
        return () => {
          handle = null;
        };
      },
    },
  });

  const startedAt = Date.now();
  let result: AgentRunResult | null = null;
  let timedOut = false;
  try {
    result = await runner.run({
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
      session: { sessionId: randomUUID(), label: "plan" },
    });
  } catch (error) {
    timedOut = error instanceof Error && error.name === "AgentTimeoutError";
    log(`  [${mode}] il run ha lanciato: ${error instanceof Error ? error.message : String(error)}`);
  }
  const durationMs = Date.now() - startedAt;
  const gitState = await readGitState(repoDir);
  const extras = await extraEntriesInParent(parentDir);
  const checks = [
    ...planInterveneChecks({
      mode,
      inputId,
      exitCode: result?.exitCode ?? -1,
      timedOut,
      delivered,
      hasPlanShape: result !== null && ctx.rt.planHasRequiredShape(result.output, LANG),
      events,
    }),
    {
      name: "nessun file toccato",
      passed: gitState.dirty.length === 0 && extras.length === 0,
      detail: `modifiche nel repo: ${gitState.dirty.join(", ") || "(nessuna)"}; voci extra: ${
        extras.join(", ") || "(nessuna)"
      }`,
    },
    ...gitDisciplineChecks(gitState),
  ].map((check) => ({ ...check, name: `[${mode}] ${check.name}` }));
  return { checks, parentDir, result, durationMs, gitState };
}

async function runInterveneOnPlan(ctx: ScenarioContext): Promise<ScenarioResult> {
  const absorb = await runPlanInterveneOnce(ctx, "plan-absorb");
  const grace = await runPlanInterveneOnce(ctx, "plan-grace");
  const checks = [...absorb.checks, ...grace.checks];
  if (!ctx.keep) {
    await rm(absorb.parentDir, { recursive: true, force: true });
    await rm(grace.parentDir, { recursive: true, force: true });
  }
  const last = grace.result;
  return {
    scenario: "intervene-plan",
    passed: checks.every((check) => check.passed),
    durationMs: absorb.durationMs + grace.durationMs,
    exitCode: last?.exitCode ?? -1,
    cwd: `${absorb.parentDir} ; ${grace.parentDir}`,
    checks,
    gitState: grace.gitState,
    finalMessage: truncate(
      `[plan-absorb]\n${absorb.result?.output ?? ""}\n\n[plan-grace]\n${last?.output ?? ""}`,
      FINAL_MESSAGE_MAX_CHARS,
    ),
    ...(last?.usage !== undefined ? { usage: last.usage } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Scenario 8 — `stop-pause`
 * ------------------------------------------------------------------ */

/** Quanto resta in pausa `pause-resume` prima del messaggio: più della grazia (2 s). */
const STOP_PAUSE_WAIT_MS = 20_000;
/** Il tetto della pausa: lungo per `pause-resume`, CORTO per `pause-expire`. */
const STOP_PAUSE_BUDGET_MS = { "pause-resume": 120_000, "pause-expire": 20_000 } as const;
const STOP_PAUSE_MESSAGE =
  "Riprendi: la funzione chiamala `add`, non `sum`. Nel file non deve esserci nessuna funzione `sum`.";

async function runStopPauseOnce(
  ctx: ScenarioContext,
  mode: "pause-resume" | "pause-expire",
): Promise<{
  checks: Check[];
  parentDir: string;
  result: AgentRunResult | null;
  durationMs: number;
  gitState: GitState;
}> {
  const parentDir = await mkdtemp(join(tmpdir(), `stubwise-golden-${mode}-`));
  const repoDir = await prepareWorkdir(parentDir);
  const stopId = randomUUID();
  const messageId = mode === "pause-resume" ? randomUUID() : null;
  const events: InterveneEvent[] = [];
  let handle: LiveProcessHandle | null = null;
  let stopDelivered: boolean | null = null;
  let messageDelivered: boolean | null = null;

  const stopOnce = () => {
    if (stopDelivered !== null || handle === null) return;
    stopDelivered = false;
    setImmediate(() => {
      stopDelivered = handle!.deliver("", true, { inputId: stopId, authorUserId: null });
      log(`  [${mode}] «Ferma» senza testo: ${stopDelivered}`);
      if (messageId === null) return;
      setTimeout(() => {
        if (handle === null) return;
        messageDelivered = handle.deliver(STOP_PAUSE_MESSAGE, false, { inputId: messageId, authorUserId: null });
        log(`  [${mode}] messaggio dopo ${STOP_PAUSE_WAIT_MS} ms di pausa: ${messageDelivered}`);
      }, STOP_PAUSE_WAIT_MS);
    });
  };

  const runner = new ctx.rt.StreamingClaudeRunner({
    claudePath: ctx.claudePath,
    log,
    pauseBudgetMs: STOP_PAUSE_BUDGET_MS[mode],
    hooks: {
      openSegment: () => ({
        onStart: () => undefined,
        onEvents: (drafts) => {
          for (const draft of drafts) {
            events.push({ type: draft.type, data: draft.data as Record<string, unknown> });
            if (draft.type === "turn_end") log(`  [${mode}] result: ${String(draft.data["subtype"])}`);
            if (draft.type === "tool_use") stopOnce();
          }
        },
        onPartial: () => undefined,
        onEnd: async () => undefined,
      }),
      register: (_sessionId, h) => {
        handle = h;
        return () => {
          handle = null;
        };
      },
    },
  });

  const startedAt = Date.now();
  let result: AgentRunResult | null = null;
  let errorName: string | null = null;
  try {
    result = await runner.run({
      cwd: parentDir,
      prompt: INTERVENE_PROMPT,
      model: ctx.model,
      permissionMode: "acceptEdits",
      maxTurns: INTERVENE_MAX_TURNS,
      timeoutMs: INTERVENE_TIMEOUT_MS,
      allowedTools: ctx.rt.DEFAULT_FIX_ALLOWED_TOOLS,
      pluginDirs: ctx.pluginDirs,
      settingSources: "",
      session: { sessionId: randomUUID(), label: "execute", pauseKey: `golden:${mode}:${stopId}` },
    });
  } catch (error) {
    errorName = error instanceof Error ? error.name : String(error);
    log(`  [${mode}] il run ha lanciato: ${error instanceof Error ? error.message : String(error)}`);
  }
  const durationMs = Date.now() - startedAt;
  const filePath = join(repoDir, INTERVENE_FILE);
  const source = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const gitState = await readGitState(repoDir);
  const checks = [
    ...stopPauseChecks({
      mode,
      stopId,
      messageId,
      stopDelivered,
      messageDelivered,
      exitCode: result?.exitCode ?? -1,
      timedOut: errorName === "AgentTimeoutError",
      errorName,
      source,
      events,
    }),
    ...gitDisciplineChecks(gitState),
  ].map((check) => ({ ...check, name: `[${mode}] ${check.name}` }));
  return { checks, parentDir, result, durationMs, gitState };
}

async function runStopPause(ctx: ScenarioContext): Promise<ScenarioResult> {
  const resume = await runStopPauseOnce(ctx, "pause-resume");
  const expire = await runStopPauseOnce(ctx, "pause-expire");
  const checks = [...resume.checks, ...expire.checks];
  if (!ctx.keep) {
    await rm(resume.parentDir, { recursive: true, force: true });
    await rm(expire.parentDir, { recursive: true, force: true });
  }
  const last = resume.result;
  return {
    scenario: "stop-pause",
    passed: checks.every((check) => check.passed),
    durationMs: resume.durationMs + expire.durationMs,
    exitCode: last?.exitCode ?? -1,
    cwd: `${resume.parentDir} ; ${expire.parentDir}`,
    checks,
    gitState: expire.gitState,
    finalMessage: truncate(last?.output ?? "", FINAL_MESSAGE_MAX_CHARS),
    ...(last?.usage !== undefined ? { usage: last.usage } : {}),
  };
}

const SCENARIOS: Record<ScenarioName, (ctx: ScenarioContext) => Promise<ScenarioResult>> = {
  "plan-only": runPlanOnly,
  "ask-user": runAskUser,
  "no-ask": runNoAsk,
  execute: runExecute,
  correction: runCorrection,
  intervene: runIntervene,
  "intervene-plan": runInterveneOnPlan,
  "stop-pause": runStopPause,
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
  let claudeVersion: string;
  try {
    claudeVersion = (await execa(args.claude, ["--version"])).stdout.trim();
  } catch {
    fail(`Il CLI \`${args.claude}\` non è eseguibile (o non è nel PATH): i golden girano sul modello vero`);
  }
  const askUserEntry = resolveAskUserServerPath(rt);
  const needsAskUser = args.scenarios.some((name) => name === "ask-user" || name === "no-ask");
  if (needsAskUser && !existsSync(askUserEntry)) {
    fail(
      `Il server MCP di ask_user non è buildato (${askUserEntry}): lancia prima ` +
        "`pnpm --filter @stubwise/worker... build`",
    );
  }

  const pluginDirs = [base, ...args.plugins];
  const ctx: ScenarioContext = {
    rt,
    askUserServerPath: askUserEntry,
    runner: args.classic
      ? new rt.ClaudeCliRunner({ claudePath: args.claude })
      : new rt.StreamingClaudeRunner({ claudePath: args.claude }),
    claudePath: args.claude,
    pluginDirs,
    model: args.model,
    keep: args.keep,
  };

  section("Configurazione");
  log(`modello: ${args.model}`);
  log(`CLI: ${args.claude} — ${claudeVersion}`);
  log(`runner: ${args.classic ? "ClaudeCliRunner (classico)" : "StreamingClaudeRunner"}`);
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
    claudeVersion,
    runner: args.classic ? "classic" : "streaming",
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
