import type { Db } from "@stubwise/db";
import type { EmbeddingClient } from "@stubwise/embeddings";
import type { AgentRunner, AgentRunSession } from "../agent/runner.js";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import type { PublishFn } from "../pipeline/notify.js";
import type { SelectDeps } from "../providers/select.js";

/**
 * Tipi del contratto del giro notturno (Piano B). Li dichiara il Task B2,
 * li usano le fasi B3–B9; `NightlyDeps` si completa col Task B9.
 */

/** Un repository del giro, con la configurazione git già decifrata. */
export interface NightlyRepo {
  repositoryId: string;
  repositoryName: string;
  projectId: string;
  projectName: string;
  /** Configurazione git con le credenziali decifrate. */
  project: MirrorProject;
  /** `projects.daily_report_enabled`. */
  dailyReport: boolean;
  /** `projects.doc_auto_update` («Docs aggiornati ogni notte»). */
  docsNightly: boolean;
  /** `repositories.current_doc_generation_id`. */
  currentGenerationId: string | null;
}

export interface NightlyConfig {
  /** NIGHTLY_START, "HH:MM" Europe/Rome. */
  start: string;
  /** NIGHTLY_ALERT_RUNS. */
  alertRuns: number;
  /** COMMIT_SUMMARY_WINDOW_DAYS. */
  summaryWindowDays: number;
  /** COMMIT_DIFF_MAX_CHARS. */
  diffMaxChars: number;
  commitSummaryModel: string;
  releaseNotesModel: string;
  docsNightlyModel: string;
  /** DOC_AGENT_TIMEOUT_MS esistente. */
  docAgentTimeoutMs: number;
  /** Esistente, per i run delle pagine. */
  docModuleMaxTurns: number;
}

/** Il sottoinsieme che serve a riassumere un commit: lo usano il giro E il poller del daily report. */
export interface CommitSummaryDeps {
  db: Db;
  /** Solo il diff: i commit arrivano già coi file (giro notturno e daily report). */
  mirrors: Pick<MirrorManager, "getCommitDiff">;
  runner: AgentRunner;
  select: SelectDeps;
  model: string;
  diffMaxChars: number;
  log: (m: string) => void;
  /** Timeout del run del riassunto (default `DEFAULT_COMMIT_SUMMARY_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Sessione a cui appartiene il run (es. quella del daily report, B4). */
  session?: AgentRunSession;
}

export interface NightlyDeps {
  db: Db;
  mirrors: MirrorManager;
  runner: AgentRunner;
  serializer: ProjectSerializer;
  /** Piano A (contiene encryptionKey). */
  select: SelectDeps;
  embeddingClient: EmbeddingClient;
  /** `pipeline/notify.ts`, iniettabile nei test. */
  publish?: PublishFn;
  publicUrl: string;
  config: NightlyConfig;
  log: (m: string) => void;
  now?: () => Date;
}

export interface NightResult {
  /** YYYY-MM-DD Europe/Rome. */
  night: string;
  repositories: number;
  itemsDone: number;
  itemsPending: number;
  stoppedForQuota: boolean;
  /**
   * `provider_quota` (R3): progetto «solo questo» col suo account al limite o
   * oltre soglia, saltato da solo; come lo stop per quota, la ripresa ogni 15′
   * lo riprova.
   */
  skipped: {
    repositoryId: string;
    reason: "unreachable" | "provider_config" | "provider_quota" | "generation_running";
  }[];
  /** Un altro giro era già in corso: questo non ha fatto nulla. */
  busy?: boolean;
}

/** La notte va ripresa (ogni 15′ fino al prossimo `NIGHTLY_START`)? */
export function nightNeedsResume(result: NightResult): boolean {
  return result.stoppedForQuota || result.skipped.some((s) => s.reason === "provider_quota");
}
