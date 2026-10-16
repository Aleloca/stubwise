import { pathToFileURL } from "node:url";
import { commitSummaries, createDb } from "@stubwise/db";
import { createEmbeddingClient } from "@stubwise/embeddings";
import { and, eq, gte, sql } from "drizzle-orm";
import { ClaudeCliRunner } from "../agent/claude-cli.js";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import { loadWorkerConfig } from "../config.js";
import { MirrorManager } from "../git/mirrors.js";
import { createProjectSerializer } from "../handler.js";
import type { SelectDeps } from "../providers/select.js";
import { runNight } from "./orchestrator.js";
import type { NightResult } from "./types.js";

/**
 * Script di ROLLOUT del giro notturno (Piano B, Task B11): una notte su UN
 * repository, subito, con lo stesso codice del worker (`runNight` con
 * `opts.repositoryId`). Stampa il `NightResult` e il costo REALE dei run.
 *
 *   pnpm --filter @stubwise/worker nightly:once -- --repository <id>
 *   docker compose exec worker node dist/nightly/once.js --repository <id>   # in produzione
 *
 * Il repository deve stare in un progetto con almeno un interruttore acceso
 * («Docs aggiornati ogni notte» o il daily report): `runNight` ignora gli altri,
 * e lo script lo dice invece di stampare un giro vuoto.
 *
 * ⚠️ È un processo A PARTE dal worker: il suo serializer per-progetto non vede
 * quello del worker. Lancialo quando sul progetto non gira nient'altro (fix,
 * generazione Docs, review), o il fetch del mirror può incrociarsi con un job.
 * Il flag «un giro alla volta» è in memoria per processo: non lanciarlo mentre
 * il worker sta facendo il SUO giro notturno (la lease della coda evita il
 * doppio claim di un elemento, non l'incrocio sui mirror).
 *
 * Il costo si misura avvolgendo il runner (`costRecordingRunner`): conta OGNI
 * run `claude` del giro — riassunti, nota, pagine, mini-orient, audit — anche
 * quelli il cui costo non finisce in tabella (la nota e gli aggiornamenti di
 * pagina non lo salvano). In più legge i riassunti scritti dal giro
 * (`commit_summaries.cost_usd`), come controllo incrociato.
 */

export interface RunCost {
  runs: number;
  costUsd: number;
}

/** Avvolge un runner e somma `usage.totalCostUsd` per modello. */
export function costRecordingRunner(inner: AgentRunner): {
  runner: AgentRunner;
  byModel: () => Map<string, RunCost>;
} {
  const totals = new Map<string, RunCost>();
  const runner: AgentRunner = {
    get recordsSessions() {
      return inner.recordsSessions;
    },
    async run(opts: AgentRunOptions): Promise<AgentRunResult> {
      const result = await inner.run(opts);
      const key = opts.model ?? "(default)";
      const entry = totals.get(key) ?? { runs: 0, costUsd: 0 };
      entry.runs += 1;
      entry.costUsd += result.usage?.totalCostUsd ?? 0;
      totals.set(key, entry);
      return result;
    },
  };
  return { runner, byModel: () => new Map(totals) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--repository <uuid>` (accetta anche `--repository=<uuid>`; ignora un `--` di pnpm). */
export function parseOnceArgs(argv: string[]): { repositoryId: string } {
  let repositoryId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--repository") {
      repositoryId = argv[++i];
    } else if (arg.startsWith("--repository=")) {
      repositoryId = arg.slice("--repository=".length);
    } else {
      throw new Error(`argomento sconosciuto: ${arg}`);
    }
  }
  if (repositoryId === undefined || !UUID_RE.test(repositoryId)) {
    throw new Error("uso: nightly:once -- --repository <id del repository (uuid)>");
  }
  return { repositoryId };
}

/** Il resoconto stampato a fine giro. */
export function formatOnceReport(
  result: NightResult,
  runs: Map<string, RunCost>,
  summaries: { model: string | null; count: number; costUsd: number }[],
): string {
  const lines: string[] = [];
  lines.push(`NightResult: ${JSON.stringify(result, null, 2)}`);
  if (result.repositories === 0) {
    lines.push(
      "Nessun repository nel giro: id sconosciuto, o il suo progetto ha entrambi gli interruttori spenti («Docs aggiornati ogni notte», daily report).",
    );
  }
  let total = 0;
  lines.push("Run claude del giro (costo dal runner):");
  if (runs.size === 0) lines.push("  nessuno");
  for (const [model, c] of [...runs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    total += c.costUsd;
    lines.push(`  ${model}: ${c.runs} run, $${c.costUsd.toFixed(4)}`);
  }
  lines.push(`  totale: $${total.toFixed(4)}`);
  lines.push("Riassunti dei commit scritti dal giro (commit_summaries):");
  if (summaries.length === 0) lines.push("  nessuno");
  for (const s of summaries) {
    lines.push(`  ${s.model ?? "deterministico (rumore)"}: ${s.count}, $${s.costUsd.toFixed(4)}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { repositoryId } = parseOnceArgs(process.argv.slice(2));
  const config = loadWorkerConfig();
  const { db, client } = createDb(config.databaseUrl, { poolMax: 4 });
  try {
    const { runner, byModel } = costRecordingRunner(new ClaudeCliRunner());
    const select: SelectDeps = {
      db,
      encryptionKey: config.encryptionKey,
      backgroundWeeklyThreshold: config.backgroundWeeklyThreshold,
      log: (m) => console.warn(m),
      legacyLimit: { until: null },
    };
    const startedAt = new Date();
    const result = await runNight(
      {
        db,
        mirrors: new MirrorManager({ mirrorsDir: config.mirrorsDir }),
        runner,
        serializer: createProjectSerializer(),
        select,
        embeddingClient: createEmbeddingClient({
          baseUrl: config.embeddingBaseUrl,
          model: config.embeddingModel,
          ...(config.embeddingApiKey !== undefined ? { apiKey: config.embeddingApiKey } : {}),
        }),
        publicUrl: config.publicUrl,
        config: {
          start: config.nightlyStart,
          alertRuns: config.nightlyAlertRuns,
          summaryWindowDays: config.commitSummaryWindowDays,
          diffMaxChars: config.commitDiffMaxChars,
          commitSummaryModel: config.commitSummaryModel,
          releaseNotesModel: config.releaseNotesModel,
          docsNightlyModel: config.docsNightlyModel,
          docAgentTimeoutMs: config.docAgentTimeoutMs,
          docModuleMaxTurns: config.docModuleMaxTurns,
        },
        log: (m) => console.warn(m),
      },
      startedAt,
      { repositoryId },
    );
    const summaries = await db
      .select({
        model: commitSummaries.model,
        count: sql<number>`count(*)::int`,
        costUsd: sql<number>`coalesce(sum(${commitSummaries.costUsd}), 0)::float8`,
      })
      .from(commitSummaries)
      .where(and(eq(commitSummaries.repositoryId, repositoryId), gte(commitSummaries.createdAt, startedAt)))
      .groupBy(commitSummaries.model);
    console.log(formatOnceReport(result, byModel(), summaries));
  } finally {
    await client.end();
  }
}

// Solo da linea di comando: importato (nei test) non parte.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
