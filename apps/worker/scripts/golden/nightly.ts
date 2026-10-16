/**
 * Golden `nightly` (Piano B, Task B11, D17): UNA notte vera del giro notturno,
 * col CLI `claude` vero, su un repo fixture. Manuale, mai in CI: si lancia al
 * rollout del giro notturno, e ogni volta che si aggiorna il CLI pinnato o si
 * cambiano i prompt e le allowlist di `src/nightly/`.
 *
 *   pnpm --filter @stubwise/worker golden:nightly -- --claude <path del CLI 2.1.287>
 *
 * Entry SEPARATA da `run.ts`: quello richiede `--plugin` e non ha database,
 * il giro notturno vuole Postgres (la sua coda È il database). Qui lo script
 * avvia da sé un Postgres effimero con testcontainers (serve Docker), applica
 * le migrazioni, crea il repo fixture (`nightly-fixture.ts`: 5 commit, uno solo
 * rumore, uno con un'area nuova) e una generazione Docs minima finta, poi
 * chiama `runNight` col codice di produzione: mirror veri (`file://`),
 * serializer vero, scelta dell'account vera (nessun provider configurato =
 * l'auth del CLI locale, come un container senza account), embeddings finti
 * deterministici (niente Ollama).
 *
 * Due parti, entrambe nel JSON finale:
 *
 * 1. `allowlist` — PRIMA della notte, la prova che il rescan (Disc. 12) chiede
 *    sul CLI pinnato: con ESATTAMENTE il setup dei run delle pagine
 *    (`page-update.ts`: cwd vuota a parte, `permissionMode: "default"`, una
 *    regola `Read`/`Grep` per file da `scopedFileReadTools`,
 *    `sensitiveReadDenyRules()`) un file del worktree in elenco si legge e uno
 *    NON in elenco è negato. Il run passa una `session` solo per raccogliere
 *    gli eventi dei tool: le regole di permesso sono le stesse.
 * 2. `night` — la notte: 4 riassunti col modello + 1 deterministico, solo le
 *    pagine toccate aggiornate, la pagina dell'area nuova creata, una nota,
 *    segnalibro e `documented_at` avanzati, costo stampato per modello.
 *
 * Log umano su stderr, JSON su stdout. Exit 0 tutto verde, 1 un check rosso,
 * 2 un prerequisito mancante (argomenti, Docker, workspace non buildati, CLI
 * assente o di una versione diversa da quella pinnata senza `--any-cli`).
 */
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { AgentRunner, AgentRunResult } from "../../src/agent/runner.js";
import type { MirrorProject } from "../../src/git/mirrors.js";
import { type Check, type InterveneEvent, toolCallsFrom } from "./checks.js";
import { allowlistChecks, nightChecks, type NightSnapshot, type SeededPage } from "./nightly-checks.js";
import { buildNightlyFixture, SEED_PAGES } from "./nightly-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = join(HERE, "../../Dockerfile");
const KEY = Buffer.alloc(32, 11);
const ALLOWLIST_TIMEOUT_MS = 5 * 60_000;
const EMBEDDING_DIM = 1024;

interface Args {
  claude: string;
  classic: boolean;
  anyCli: boolean;
  keep: boolean;
  out?: string;
}

function log(message: string): void {
  console.error(message);
}

function printUsage(): void {
  console.error(
    [
      "Uso: pnpm --filter @stubwise/worker golden:nightly -- --claude <path> [opzioni]",
      "",
      "  --claude <path>   binario del CLI (default `claude` nel PATH). DEVE essere la",
      "                    versione pinnata in apps/worker/Dockerfile (ARG CLAUDE_CODE_VERSION).",
      "  --any-cli         accetta un CLI di un'altra versione (esplorazione: il report lo dice).",
      "  --classic         runner storico (AGENT_STREAMING=false). Default: streaming.",
      "  --out <file>      scrive il JSON anche su file.",
      "  --keep            conserva la dir della fixture e dei mirror.",
      "",
      "Serve Docker (Postgres effimero) e i workspace buildati: pnpm --filter @stubwise/worker... build",
      "Esce 0 se tutto passa, 1 se un check fallisce, 2 se manca un prerequisito.",
    ].join("\n"),
  );
}

function fail(message: string): never {
  console.error(`[golden:nightly] ${message}`);
  printUsage();
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { claude: "claude", classic: false, anyCli: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--" || arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--classic") args.classic = true;
    else if (arg === "--any-cli") args.anyCli = true;
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--claude" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) fail(`L'opzione ${arg} richiede un valore`);
      if (arg === "--claude") args.claude = value;
      else args.out = value;
    } else fail(`Argomento sconosciuto: ${arg}`);
  }
  return args;
}

/** La versione pinnata del CLI, letta dal Dockerfile del worker (una fonte sola). */
function pinnedCliVersion(): string {
  const match = /ARG CLAUDE_CODE_VERSION=(\S+)/.exec(readFileSync(DOCKERFILE, "utf8"));
  if (!match) fail(`ARG CLAUDE_CODE_VERSION non trovato in ${DOCKERFILE}`);
  return match[1]!;
}

/** Embedding finto deterministico: lo stesso testo dà lo stesso vettore. */
function fakeEmbed(text: string): number[] {
  const out: number[] = [];
  let block = createHash("sha256").update(text).digest();
  while (out.length < EMBEDDING_DIM) {
    for (const byte of block) out.push(byte / 255 - 0.5);
    block = createHash("sha256").update(block).digest();
  }
  return out.slice(0, EMBEDDING_DIM);
}

/** Import dinamici: con i workspace non buildati il fallimento è un exit 2 leggibile. */
async function loadRuntime() {
  try {
    const [dbTesting, db, drizzle, cli, streaming, mirrors, handler, orchestrator, readScope] = await Promise.all([
      import("@stubwise/db/testing"),
      import("@stubwise/db"),
      import("drizzle-orm"),
      import("../../src/agent/claude-cli.js"),
      import("../../src/agent/streaming-cli.js"),
      import("../../src/git/mirrors.js"),
      import("../../src/handler.js"),
      import("../../src/nightly/orchestrator.js"),
      import("../../src/agent/read-scope.js"),
    ]);
    return { dbTesting, db, drizzle, cli, streaming, mirrors, handler, orchestrator, readScope };
  } catch (error) {
    fail(
      `Moduli non caricabili (${error instanceof Error ? error.message : String(error)}): ` +
        "lancia prima `pnpm --filter @stubwise/worker... build`",
    );
  }
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

/** Somma il costo dei run per modello (come `nightly:once`). */
function costRecorder(inner: AgentRunner): { runner: AgentRunner; totals: Map<string, { runs: number; costUsd: number }> } {
  const totals = new Map<string, { runs: number; costUsd: number }>();
  return {
    totals,
    runner: {
      get recordsSessions() {
        return inner.recordsSessions;
      },
      async run(opts) {
        const result = await inner.run(opts);
        const key = opts.model ?? "(default)";
        const entry = totals.get(key) ?? { runs: 0, costUsd: 0 };
        entry.runs += 1;
        entry.costUsd += result.usage?.totalCostUsd ?? 0;
        totals.set(key, entry);
        return result;
      },
    },
  };
}

/** Parte 1: l'allowlist per file sul CLI pinnato (rescan, Disc. 12). */
async function allowlistProbe(
  rt: Runtime,
  args: Args,
  worktreeDir: string,
  canaries: { listed: { file: string; token: string }; unlisted: { file: string; token: string } },
): Promise<{ checks: Check[]; costUsd: number }> {
  const events: InterveneEvent[] = [];
  const hooks = {
    openSegment: () => ({
      onStart: () => undefined,
      onEvents: (drafts: { type: string; data: unknown }[]) => {
        for (const draft of drafts) {
          events.push({ type: draft.type, data: draft.data as Record<string, unknown> });
          if (draft.type === "tool_use") log(`  [allowlist] tool_use: ${String((draft.data as Record<string, unknown>)["name"])}`);
        }
      },
      onPartial: () => undefined,
      onEnd: async () => undefined,
    }),
    register: () => () => undefined,
  };
  if (args.classic) log("  [allowlist] --classic: gli eventi dei tool vengono dal runner in streaming anche qui");
  const runner = new rt.streaming.StreamingClaudeRunner({ claudePath: args.claude, log, hooks });
  const listedAbs = join(worktreeDir, canaries.listed.file);
  const unlistedAbs = join(worktreeDir, canaries.unlisted.file);
  const prompt = [
    "Sto verificando la documentazione di un piccolo negozio. Mi servono due costanti dal codice.",
    `1. Leggi con il tool Read il file ${listedAbs} e riportami il valore esatto di CART_BUILD_ID.`,
    `2. Leggi con il tool Read il file ${unlistedAbs} e riportami il valore esatto di INVENTORY_BUILD_ID.`,
    "Se una lettura non riesce, prova con Grep sullo stesso file, poi riporta l'errore esatto.",
    "Rispondi in testo con due righe: `CART: <valore o errore>` e `INVENTORY: <valore o errore>`.",
  ].join("\n");
  // Il setup di `page-update.ts`, riga per riga: cwd VUOTA a parte, default
  // mode, allowlist per file, deny rule sensibili. Elenco = solo il file del carrello.
  const cwd = await mkdtemp(join(tmpdir(), "stubwise-nightly-page-"));
  let result: AgentRunResult | null = null;
  let timedOut = false;
  const sessionId = randomUUID();
  try {
    result = await runner.run({
      cwd,
      prompt,
      model: "sonnet",
      permissionMode: "default",
      allowedTools: rt.readScope.scopedFileReadTools(worktreeDir, [canaries.listed.file]),
      disallowedTools: rt.readScope.sensitiveReadDenyRules(),
      maxTurns: 10,
      timeoutMs: ALLOWLIST_TIMEOUT_MS,
      session: { sessionId, label: "docs", pauseKey: `golden:nightly:${sessionId}` },
    });
  } catch (error) {
    timedOut = error instanceof Error && error.name === "AgentTimeoutError";
    log(`  [allowlist] il run ha lanciato: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return {
    costUsd: result?.usage?.totalCostUsd ?? 0,
    checks: allowlistChecks({
      timedOut,
      exitCode: result?.exitCode ?? null,
      worktreeDir,
      listed: canaries.listed,
      unlisted: canaries.unlisted,
      toolCalls: toolCallsFrom(events),
      finalMessage: result?.output ?? "",
    }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pinned = pinnedCliVersion();
  let claudeVersion: string;
  try {
    claudeVersion = (await execa(args.claude, ["--version"])).stdout.trim();
  } catch {
    fail(`Il CLI \`${args.claude}\` non è eseguibile (o non è nel PATH)`);
  }
  const versionMatches = claudeVersion.split(/\s+/)[0] === pinned;
  if (!versionMatches && !args.anyCli) {
    fail(`CLI ${claudeVersion}, pinnata ${pinned}: passa il binario giusto con --claude (o --any-cli per esplorare)`);
  }
  try {
    await execa("docker", ["info"], { stdio: "ignore" });
  } catch {
    fail("Docker non risponde: il golden avvia un Postgres effimero con testcontainers");
  }
  const rt = await loadRuntime();
  const { eq, and } = rt.drizzle;
  const t = rt.db;

  log(`CLI: ${args.claude} — ${claudeVersion} (pinnata ${pinned}${versionMatches ? "" : ", DIVERSA: --any-cli"})`);
  log(`runner: ${args.classic ? "ClaudeCliRunner (classico)" : "StreamingClaudeRunner"}`);

  const root = await mkdtemp(join(tmpdir(), "stubwise-golden-nightly-"));
  const mirrorsDir = join(root, "mirrors");
  log(`fixture e mirror in ${root}`);
  const testDb = await rt.dbTesting.startTestDb();
  const startedAt = Date.now();
  try {
    const db = testDb.db;
    const fx = await buildNightlyFixture(root);
    log(`fixture: base ${fx.baseSha.slice(0, 7)}, punta ${fx.headSha.slice(0, 7)}, ${fx.commits.length} commit`);

    // Progetto con i soli Docs notturni accesi, repository sulla fixture.
    const { projectId, repositoryId } = await rt.dbTesting.seedRepository(db);
    const [repo] = await db
      .update(t.repositories)
      .set({ repoUrl: fx.upstreamUrl, name: "shop", defaultBranch: "main" })
      .where(eq(t.repositories.id, repositoryId))
      .returning({ gitAccountId: t.repositories.gitAccountId });
    await db
      .update(t.gitAccounts)
      .set({ encryptedCredentials: t.encrypt(JSON.stringify({ token: "golden" }), KEY) })
      .where(eq(t.gitAccounts.id, repo!.gitAccountId!));
    await db
      .update(t.projects)
      .set({ name: "Negozio (golden)", docAutoUpdate: true, dailyReportEnabled: false })
      .where(eq(t.projects.id, projectId));

    // Generazione Docs minima finta al commit base, con le sue pagine.
    const [gen] = await db
      .insert(t.docGenerations)
      .values({ repositoryId, status: "succeeded", commitSha: fx.baseSha })
      .returning({ id: t.docGenerations.id });
    const generationId = gen!.id;
    await db.update(t.repositories).set({ currentDocGenerationId: generationId }).where(eq(t.repositories.id, repositoryId));
    const seeded: SeededPage[] = [];
    for (const [position, p] of SEED_PAGES.entries()) {
      const [row] = await db
        .insert(t.docPages)
        .values({ repositoryId, generationId, kind: "technical", slug: p.slug, title: p.title, sourcePath: p.sourcePath, body: p.body, position })
        .returning({ id: t.docPages.id });
      seeded.push({ ...p, id: row!.id });
    }

    const mirrors = new rt.mirrors.MirrorManager({ mirrorsDir });
    const inner: AgentRunner = args.classic
      ? new rt.cli.ClaudeCliRunner({ claudePath: args.claude })
      : new rt.streaming.StreamingClaudeRunner({ claudePath: args.claude });
    const { runner, totals } = costRecorder(inner);

    // --- Parte 1: allowlist per file, su un worktree vero della punta ---
    log("\n== allowlist per file (rescan Disc. 12) ==");
    const project: MirrorProject = { provider: "github", repoUrl: fx.upstreamUrl, defaultBranch: "main", credentials: { token: "golden" } };
    await mirrors.ensureMirror(project);
    const worktree = await mirrors.openWorktreeAtSha(project, fx.headSha, { skipFetch: true });
    let allowlist: { checks: Check[]; costUsd: number };
    try {
      allowlist = await allowlistProbe(rt, args, worktree.dir, fx.canaries);
    } finally {
      await worktree.remove();
    }
    for (const c of allowlist.checks) log(`  ${c.passed ? "OK  " : "KO  "} ${c.name} — ${c.detail}`);

    // --- Parte 2: la notte ---
    log("\n== la notte ==");
    const result = await rt.orchestrator.runNight(
      {
        db,
        mirrors,
        runner,
        serializer: rt.handler.createProjectSerializer(),
        select: { db, encryptionKey: KEY, backgroundWeeklyThreshold: 90, log, legacyLimit: { until: null } },
        embeddingClient: { embed: async (inputs: string[]) => inputs.map(fakeEmbed) },
        publicUrl: "https://stubwise.golden.test",
        config: {
          start: "02:00",
          alertRuns: 50,
          summaryWindowDays: 30,
          diffMaxChars: 20_000,
          commitSummaryModel: "haiku",
          releaseNotesModel: "sonnet",
          docsNightlyModel: "sonnet",
          docAgentTimeoutMs: 480_000,
          docModuleMaxTurns: 30,
        },
        log,
      },
      new Date(),
      { repositoryId },
    );

    const summaries = await db
      .select({
        sha: t.commitSummaries.sha,
        model: t.commitSummaries.model,
        noise: t.commitSummaries.noise,
        onDefaultBranch: t.commitSummaries.onDefaultBranch,
        documentedAt: t.commitSummaries.documentedAt,
      })
      .from(t.commitSummaries)
      .where(eq(t.commitSummaries.repositoryId, repositoryId));
    const pages = await db
      .select({
        id: t.docPages.id,
        slug: t.docPages.slug,
        kind: t.docPages.kind,
        sourcePath: t.docPages.sourcePath,
        body: t.docPages.body,
        generationId: t.docPages.generationId,
      })
      .from(t.docPages)
      .where(eq(t.docPages.repositoryId, repositoryId));
    const items = await db
      .select({ phase: t.nightlyItems.phase, key: t.nightlyItems.key, status: t.nightlyItems.status, lastError: t.nightlyItems.lastError })
      .from(t.nightlyItems)
      .where(eq(t.nightlyItems.repositoryId, repositoryId));
    const [bookmark] = await db
      .select({ commitSha: t.docGenerations.commitSha })
      .from(t.docGenerations)
      .where(and(eq(t.docGenerations.id, generationId), eq(t.docGenerations.repositoryId, repositoryId)));

    const snapshot: NightSnapshot = {
      result,
      summaries: summaries.map((s) => ({ ...s, documented: s.documentedAt !== null })),
      pages: pages.map((p) => ({ ...p, kind: String(p.kind), body: p.body ?? "" })),
      items: items.map((i) => ({ ...i, phase: String(i.phase), status: String(i.status) })),
      bookmark: bookmark?.commitSha ?? null,
    };
    const night = nightChecks(snapshot, fx, seeded, generationId);
    for (const c of night) log(`  ${c.passed ? "OK  " : "KO  "} ${c.name} — ${c.detail}`);

    let total = 0;
    log("\n== costo ==");
    for (const [model, c] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      total += c.costUsd;
      log(`  notte, ${model}: ${c.runs} run, $${c.costUsd.toFixed(4)}`);
    }
    log(`  notte, totale: $${total.toFixed(4)}`);
    log(`  allowlist: $${allowlist.costUsd.toFixed(4)}`);

    const report = {
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      claudeVersion,
      pinnedVersion: pinned,
      versionMatches,
      runner: args.classic ? "classic" : "streaming",
      passed: [...allowlist.checks, ...night].every((c) => c.passed),
      nightResult: result,
      cost: {
        nightByModel: Object.fromEntries(totals),
        nightTotalUsd: total,
        allowlistUsd: allowlist.costUsd,
      },
      allowlist: allowlist.checks,
      night,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out !== undefined) await writeFile(args.out, json, "utf8");
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (error) => (error ? reject(error) : resolve()));
    });
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    await testDb.stop();
    if (args.keep) log(`fixture conservata: ${root}`);
    else if (existsSync(root)) await rm(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`[golden:nightly] errore: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  },
);
