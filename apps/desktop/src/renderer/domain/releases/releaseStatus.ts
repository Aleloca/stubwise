import type { CiRun, ProjectEnvironment, Release, Repository } from "../../data/model";

// Lo stato di un rilascio si DERIVA, non si salva (spec «Lo stato del
// rilascio»): legge le run della CI e il commit che l'agente riporta
// sull'ambiente di produzione, mai un'azione. Con run: in corso / riuscito /
// fallito; senza run lette entro la soglia: «senza pipeline», cioè il commit
// del merge è o non è comparso in produzione; senza un ambiente di
// produzione con un server, lo stato non è disponibile e si dice perché.

export type ReleaseStatusKind =
  | "running"
  | "succeeded"
  | "failed"
  | "not_in_production"
  | "in_production"
  | "unavailable";

export interface ReleaseStatus {
  kind: ReleaseStatusKind;
  /** Da quando è in quello stato, se lo si sa. */
  since: string | null;
  reason?: "no_production_env" | "no_server";
}

/** Minuti dal merge entro cui l'assenza di run vuol dire «non sono ancora partite». */
export const NO_PIPELINE_AFTER_MIN = 30;

/** Come `MIN_SHA_PREFIX` di `apps/server/src/services/release.ts`: le abbreviazioni di git. */
export const MIN_SHA_PREFIX = 7;

/**
 * Due sha indicano lo STESSO commit? Copia di `sameCommit` di
 * `apps/server/src/services/release.ts`: il più corto è prefisso del più
 * lungo, senza distinguere maiuscole; sotto {@link MIN_SHA_PREFIX} caratteri
 * o con uno dei due assente NON combaciano.
 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < MIN_SHA_PREFIX || y.length < MIN_SHA_PREFIX) return false;
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

/** Le run che fanno lo stato: tutte, o solo quelle coi nomi scelti nel repository. */
function countedRuns(runs: CiRun[], pipeline: Repository["releasePipeline"]): CiRun[] {
  if (pipeline?.mode !== "named") return runs;
  const names = new Set(pipeline.names);
  return runs.filter((r) => names.has(r.name));
}

const earliest = (xs: string[]) => [...xs].sort()[0] ?? null;
const latestOf = (xs: string[]) => [...xs].sort().at(-1) ?? null;

export function releaseStatus(
  r: Release,
  ctx: {
    now: string;
    production: ProjectEnvironment | null;
    pipeline: Repository["releasePipeline"];
  },
): ReleaseStatus {
  const runs = countedRuns(r.runs, ctx.pipeline);
  if (runs.length > 0) {
    // Fallito se una fallisce (anche con altre ancora in corso), in corso
    // finché una gira, riuscito quando tutte sono riuscite.
    const failed = runs.filter((x) => x.status === "failed");
    if (failed.length > 0) {
      return { kind: "failed", since: earliest(failed.map((x) => x.endedAt ?? x.startedAt)) };
    }
    const running = runs.filter((x) => x.status === "running");
    if (running.length > 0) {
      return { kind: "running", since: earliest(running.map((x) => x.startedAt)) };
    }
    return { kind: "succeeded", since: latestOf(runs.map((x) => x.endedAt ?? x.startedAt)) };
  }
  // Nessuna run letta. Un commit già comparso in produzione ci resta, anche
  // entro la soglia (R-K10), dopo un deploy più nuovo o se l'ambiente perde
  // il server: è un fatto già osservato.
  if (r.seenInProductionAt) return { kind: "in_production", since: r.seenInProductionAt };
  // Entro la soglia le run possono ancora partire.
  const elapsedMin = (Date.parse(ctx.now) - Date.parse(r.mergedAt)) / 60_000;
  if (elapsedMin < NO_PIPELINE_AFTER_MIN) return { kind: "running", since: r.mergedAt };
  // Senza pipeline: lo dice l'agente sul server dell'ambiente di produzione.
  if (!ctx.production) return { kind: "unavailable", since: null, reason: "no_production_env" };
  if (!ctx.production.serverCode) return { kind: "unavailable", since: null, reason: "no_server" };
  if (sameCommit(r.mergeSha, ctx.production.reportedSha)) {
    return { kind: "in_production", since: ctx.production.reportedAt };
  }
  return { kind: "not_in_production", since: r.mergedAt };
}
