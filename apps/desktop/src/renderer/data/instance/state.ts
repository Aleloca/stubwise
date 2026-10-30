import type { AiModelChoice, AiOperation } from "@stubwise/shared";
import type { TaskType } from "../model";

// Lo stato d'istanza dell'area 9b (Amministrazione → istanza): i provider
// dell'AI, i modelli per operazione, l'automazione, il budget, gli account
// git, i plugin, l'archiviazione, il webhook in uscita, le pause della coda,
// i consumi e il giro notturno. Sta in `state.instance` (`store.ts`): il seme
// lo dà `seed.ts`, l'istanza vuota `emptyInstanceState()`. Le app Google
// restano in `state.googleWorkspaces`, la stessa riga che leggono le
// Preferenze.
//
// Un segreto scritto da chi amministra (chiave API, setup-token, token git,
// chiave S3) qui non c'è mai: solo il suo id nel caveau (`secretId`, vedi
// `admin/secrets.ts`) e le ultime 4 cifre.

export type TestOutcome = "ok" | "invalid_credentials" | "unreachable";

export interface AiProvider {
  id: string;
  name: string;
  kind: "subscription" | "api_key";
  enabled: boolean;
  secretId: string;
  last4: string;
  /** Solo `subscription`: l'ultima lettura della quota. */
  quota: {
    fiveHourPct: number;
    weeklyPct: number;
    readAt: string;
    limitedUntil: string | null;
  } | null;
  lastTest: { at: string; outcome: TestOutcome } | null;
  createdAt: string;
}

export interface AutomationRule {
  taskType: TaskType;
  autoFix: boolean;
  maxEffort: 1 | 2 | 3 | 4 | 5;
  planApprovalMinEffort: 1 | 2 | 3 | 4 | 5 | null;
  maxCostUsd: number | null;
}

export interface GitAccount {
  id: string;
  name: string;
  provider: "bitbucket" | "github";
  workspace: string | null;
  secretId: string;
  last4: string;
  defaultReviewer: boolean;
  lastValidation: { at: string; outcome: TestOutcome } | null;
  createdAt: string;
}

export interface RegisteredPlugin {
  id: string;
  slug: string;
  name: string;
  url: string;
  ref: string;
  sha: string | null;
  subdir: string | null;
  status: "materializing" | "ready" | "failed";
  smoke: "running" | "passed" | "failed" | null;
  error: string | null;
  inventory: {
    skills: { name: string; description: string }[];
    /** `key` è `<Evento>#<indice>`, es. `SessionStart#0`. */
    hooks: { key: string; event: string; command: string }[];
  } | null;
  registeredById: string;
  /** Chi l'ha toccato per ultimo (registrato o aggiornato a un ref), con `updatedAt`. */
  updatedById: string;
  updatedAt: string;
}

export interface StorageSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretId: string | null;
  last4: string | null;
  attachmentsEnabled: boolean;
  lastTest: { at: string; outcome: TestOutcome } | null;
}

export interface OutgoingWebhook {
  enabled: boolean;
  format: "slack" | "discord" | "generic";
  /** In chiaro: non è un segreto (maintainer, 30 ott 2026). */
  url: string | null;
  events: Record<string, boolean>;
  lastTest: { at: string; outcome: TestOutcome } | null;
}

export interface QueuePause {
  projectId: string;
  byId: string;
  at: string;
}

/** Una riga di consumo (letta dal Task 2, scritta anche dal Task 6). */
export interface UsageRecord {
  id: string;
  at: string;
  operation: AiOperation;
  model: string;
  projectId: string | null;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  conversationId: string | null;
}

/** Una riga del giro notturno, solo da guardare (Task 5). */
export interface NightlyRow {
  id: string;
  projectId: string;
  repositoryName: string;
  phase: "commit_summary" | "release_note" | "docs";
  state: "running" | "waiting" | "failed" | "done";
  at: string;
  summary: string | null;
}

export interface InstanceState {
  /** L'ordine dell'array È la catena. */
  providers: AiProvider[];
  models: Partial<Record<AiOperation, AiModelChoice>>;
  automation: {
    rules: AutomationRule[];
    prReview: { enabled: boolean; maxCostUsd: number | null };
  };
  budget: { monthlyUsd: number | null; contentLanguage: "en" | "it" };
  gitAccounts: GitAccount[];
  plugins: RegisteredPlugin[];
  storage: StorageSettings;
  webhook: OutgoingWebhook;
  queuePauses: QueuePause[];
  /** Seme nel Task 2. */
  usage: UsageRecord[];
  /** Seme nel Task 5. */
  nightly: NightlyRow[];
  /**
   * Solo prototipo (riquadro «Prototype only»). `nextTest`: chiave = id del
   * provider o dell'account git, oppure "storage" / "webhook".
   * `nextPluginOutcome`: come finisce la prossima registrazione o il
   * prossimo aggiornamento di un plugin (vale una volta, poi torna `ready`).
   */
  simulate: {
    nextTest: Record<string, TestOutcome>;
    budgetReached: boolean;
    nextPluginOutcome: "ready" | "failed";
  };
}
