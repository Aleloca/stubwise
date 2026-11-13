// Lo stato di un rilascio si DERIVA, non si salva (area 8, F1; era
// `domain/releases/releaseStatus.ts` del prototipo, spostato qui perché lo
// usino prototipo, server e worker con la stessa regola). Legge le run della
// CI e il commit che l'agente riporta sull'ambiente di produzione, mai
// un'azione. Con run: in corso / riuscito / fallito; senza run lette entro la
// soglia: «senza pipeline», cioè il commit del merge è o non è comparso in
// produzione; senza un ambiente di produzione con un server, lo stato non è
// disponibile e si dice perché. Una lettura illeggibile delle run (`unknown`
// dal provider) non è MAI «riuscito»: è `unknown`, salvo un fatto già
// osservato (il commit in produzione).

export type ReleaseStatusKind =
  | "running"
  | "succeeded"
  | "failed"
  | "not_in_production"
  | "in_production"
  | "unavailable"
  /** Le run non si sono potute leggere: nessuna affermazione. */
  | "unknown";

export interface ReleaseStatus {
  kind: ReleaseStatusKind;
  /** Da quando è in quello stato, se lo si sa. */
  since: string | null;
  /**
   * `no_server`: la produzione non ha server; `no_server_for_repository`: ne
   * ha, ma nessuno per la repository del rilascio (R-L2).
   */
  reason?: "no_production_env" | "no_server" | "no_server_for_repository";
}

/** Una run di CI come la legge lo stato. */
export interface ReleaseRunLike {
  name: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  endedAt: string | null;
}

/** La pipeline del repository: tutte le run, o quelle coi nomi dati. */
export type ReleasePipeline =
  | { mode: "auto" }
  | { mode: "named"; names: readonly string[] }
  | null
  | undefined;

export interface ReleaseStatusInput {
  /** Le run lette; `"unknown"` se il provider non si è potuto leggere (mai «nessuna run»). */
  runs: readonly ReleaseRunLike[] | "unknown";
  mergedAt: string;
  mergeSha: string;
  /** Il commit è già stato visto in produzione: un fatto osservato, resta. */
  seenInProductionAt: string | null;
  now: string;
  pipeline: ReleasePipeline;
  /**
   * L'ambiente di produzione del progetto, già risolto per la repository del
   * rilascio (R-L2): `null` se non c'è; `server` è quello della repository
   * (o di tutto il progetto), `null` se non ce n'è uno.
   */
  production: {
    hasServers: boolean;
    server: { reportedSha: string | null; reportedAt: string | null } | null;
  } | null;
}

/** Minuti dal merge entro cui l'assenza di run vuol dire «non sono ancora partite». */
export const NO_PIPELINE_AFTER_MIN = 30;

/** Come `MIN_SHA_PREFIX` di `apps/server/src/services/release.ts`: le abbreviazioni di git. */
export const MIN_SHA_PREFIX = 7;

/**
 * Due sha indicano lo STESSO commit? La forma di `sameCommit` di
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

function countedRuns(
  runs: readonly ReleaseRunLike[],
  pipeline: ReleasePipeline,
): readonly ReleaseRunLike[] {
  if (pipeline?.mode !== "named") return runs;
  const names = new Set(pipeline.names);
  return runs.filter((r) => names.has(r.name));
}

const earliest = (xs: string[]) => [...xs].sort()[0] ?? null;
const latestOf = (xs: string[]) => [...xs].sort().at(-1) ?? null;

/** Il commit del merge sul server di produzione della repository, se c'è. */
function onProductionServer(input: ReleaseStatusInput): ReleaseStatus | null {
  const server = input.production?.server;
  if (server && sameCommit(input.mergeSha, server.reportedSha)) {
    return { kind: "in_production", since: server.reportedAt };
  }
  return null;
}

export function releaseStatusOf(input: ReleaseStatusInput): ReleaseStatus {
  if (input.runs === "unknown") {
    // Nessuna affermazione sulle run; i soli fatti osservati restano.
    if (input.seenInProductionAt) return { kind: "in_production", since: input.seenInProductionAt };
    return onProductionServer(input) ?? { kind: "unknown", since: null };
  }
  const runs = countedRuns(input.runs, input.pipeline);
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
  if (input.seenInProductionAt) return { kind: "in_production", since: input.seenInProductionAt };
  // Entro la soglia le run possono ancora partire.
  const elapsedMin = (Date.parse(input.now) - Date.parse(input.mergedAt)) / 60_000;
  if (elapsedMin < NO_PIPELINE_AFTER_MIN) return { kind: "running", since: input.mergedAt };
  // Senza pipeline: lo dice l'agente sul server della repository del
  // rilascio nell'ambiente di produzione (R-L2), non quello di un'altra.
  if (!input.production) return { kind: "unavailable", since: null, reason: "no_production_env" };
  if (!input.production.server) {
    const reason = input.production.hasServers ? "no_server_for_repository" : "no_server";
    return { kind: "unavailable", since: null, reason };
  }
  return onProductionServer(input) ?? { kind: "not_in_production", since: input.mergedAt };
}
