import type { AiModelChoice, AiOperation } from "@stubwise/shared";
import { TODAY, daysFromToday } from "../seed/dates";
import { NIGHTLY_ROWS } from "../seed/nightly";
import { seedUsage } from "../seed/usage";
import type { AutomationRule, InstanceState } from "./state";

// Il seme dello stato d'istanza (area 9b, design «Dati finti»). Lo legge
// `freshState` di `store.ts`, quindi qui non si importa né lo store né il
// caveau dei segreti (`admin/secrets.ts`): lo store lo raggiungerebbe, e con
// lui le letture del registro (`architecture.secrets.test.ts`). I segreti del
// seme hanno un id e le ultime 4 cifre fissi, senza valore nel caveau:
// nessuno li ha mai visti in questa sessione, e una sostituzione li
// dimentica come ogni altro.

/** I modelli fissati da env sul worker (`ENV_MODELS`): vincono sul default, non su un'impostazione. */
export const ENV_MODELS: Partial<Record<AiOperation, AiModelChoice>> = { mail_classify: "haiku" };

/** Gli id degli account git del seme: i repository del seme (`seed/docs/repositories.ts`) li nominano. */
export const SEED_GIT_ACCOUNT_IDS = {
  bitbucketAudin: "git-bitbucket-audin",
  githubStubwise: "git-github-stubwise",
} as const;

const DEFAULT_RULE = {
  autoFix: false,
  maxEffort: 2,
  planApprovalMinEffort: null,
  maxCostUsd: null,
} as const;

/** Le regole d'automazione per tipo di task: tutte spente, fino a effort 2. */
function defaultRules(): AutomationRule[] {
  return (["bug", "feature", "activity"] as const).map((taskType) => ({
    taskType,
    ...DEFAULT_RULE,
  }));
}

const at = (days: number, hm: string): string => `${daysFromToday(days)}T${hm}:00Z`;

/** Lo stato d'istanza del seme, nuovo a ogni chiamata. */
export function seedInstanceState(): InstanceState {
  return {
    providers: [
      {
        id: "prv-team-max",
        name: "Team Max",
        kind: "subscription",
        enabled: true,
        secretId: "sec-seed-prv-team-max",
        last4: "4f1c",
        quota: { fiveHourPct: 22, weeklyPct: 41, readAt: `${TODAY}T08:40:00Z`, limitedUntil: null },
        lastTest: { at: at(-3, "09:12"), outcome: "ok" },
        createdAt: at(-120, "10:00"),
      },
      {
        // Vicino alla soglia della settimana: la riga dice «near».
        id: "prv-backup-max",
        name: "Backup Max",
        kind: "subscription",
        enabled: true,
        secretId: "sec-seed-prv-backup-max",
        last4: "b7d0",
        quota: { fiveHourPct: 64, weeklyPct: 87, readAt: `${TODAY}T08:40:00Z`, limitedUntil: null },
        lastTest: { at: at(-3, "09:13"), outcome: "ok" },
        createdAt: at(-60, "10:00"),
      },
      {
        // Le sessioni del seme (`seed/runs.ts`) la nominano già.
        id: "prv-billing-key",
        name: "Billing key",
        kind: "api_key",
        enabled: true,
        secretId: "sec-seed-prv-billing-key",
        last4: "9e2b",
        quota: null,
        lastTest: { at: at(-10, "15:30"), outcome: "ok" },
        createdAt: at(-200, "10:00"),
      },
    ],
    models: { fix_plan: "opus" },
    automation: {
      rules: defaultRules().map((r) =>
        r.taskType === "bug" ? { ...r, autoFix: true, maxEffort: 2 } : r,
      ),
      prReview: { enabled: true, maxCostUsd: 2 },
    },
    budget: { monthlyUsd: 600, contentLanguage: "en" },
    gitAccounts: [
      {
        id: SEED_GIT_ACCOUNT_IDS.bitbucketAudin,
        name: "Bitbucket Audin",
        provider: "bitbucket",
        workspace: "audin",
        secretId: "sec-seed-git-bitbucket-audin",
        last4: "k2p8",
        defaultReviewer: false,
        lastValidation: { at: at(-5, "11:00"), outcome: "ok" },
        createdAt: at(-180, "10:00"),
      },
      {
        id: SEED_GIT_ACCOUNT_IDS.githubStubwise,
        name: "GitHub Stubwise",
        provider: "github",
        workspace: null,
        secretId: "sec-seed-git-github-stubwise",
        last4: "x9qa",
        defaultReviewer: true,
        lastValidation: { at: at(-5, "11:01"), outcome: "ok" },
        createdAt: at(-240, "10:00"),
      },
    ],
    plugins: [
      {
        id: "plg-superpowers",
        slug: "superpowers",
        name: "superpowers",
        url: "https://github.com/obra/superpowers",
        ref: "v4.0.3",
        sha: "3f9c2a17d6b04e8a91c5f0e2b7d4a6c8e1f03b59",
        subdir: null,
        status: "ready",
        smoke: "passed",
        error: null,
        inventory: {
          skills: [
            {
              name: "brainstorming",
              description: "Turns a rough idea into a design before any code.",
            },
            { name: "writing-plans", description: "Writes a step-by-step plan from a design." },
            {
              name: "test-driven-development",
              description: "Writes the failing test first, then the code.",
            },
            {
              name: "systematic-debugging",
              description: "Finds the cause of a bug before changing anything.",
            },
            {
              name: "verification-before-completion",
              description: "Runs the checks before saying the work is done.",
            },
            { name: "using-git-worktrees", description: "Works in a separate git worktree." },
            {
              name: "finishing-a-development-branch",
              description: "Merges or opens a pull request at the end.",
            },
            {
              name: "dispatching-parallel-agents",
              description: "Splits independent work across agents.",
            },
            {
              name: "subagent-driven-development",
              description: "Runs a plan task by task with one agent each.",
            },
          ],
          hooks: [
            {
              key: "SessionStart#0",
              event: "SessionStart",
              command: "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
            },
          ],
        },
        registeredById: "p-roberta",
        updatedAt: at(-14, "16:20"),
      },
      {
        id: "plg-lint-helpers",
        slug: "lint-helpers",
        name: "lint-helpers",
        url: "https://github.com/audin-dev/lint-helpers",
        ref: "main",
        sha: null,
        subdir: null,
        status: "failed",
        smoke: null,
        error: "The plugin contains a symlink (hooks/run.sh): plugins with symlinks are refused.",
        inventory: null,
        registeredById: "p-roberta",
        updatedAt: at(-2, "10:05"),
      },
    ],
    storage: {
      endpoint: "https://s3.eu-south-1.amazonaws.com",
      region: "eu-south-1",
      bucket: "stubwise-files",
      accessKeyId: "AKIAPROTOTYPE4STUB",
      secretId: "sec-seed-storage",
      last4: "w3m7",
      attachmentsEnabled: true,
      lastTest: { at: at(-7, "12:00"), outcome: "ok" },
    },
    webhook: {
      enabled: true,
      format: "slack",
      url: "https://hooks.slack.com/services/T01AUDIN/B07STUB/prototype",
      events: {
        "ticket.created": true,
        "job.pr_opened": true,
        "job.failed": true,
        monitor: true,
      },
      lastTest: { at: at(-4, "17:45"), outcome: "ok" },
    },
    // La coda di STW in pausa da Roberta, ieri alle 18:00.
    queuePauses: [{ projectId: "prj-stw", byId: "p-roberta", at: at(-1, "18:00") }],
    usage: seedUsage(),
    nightly: NIGHTLY_ROWS.map((r) => ({ ...r })),
    simulate: { nextTest: {}, budgetReached: false, nextPluginOutcome: "ready" },
  };
}

/**
 * L'istanza appena installata (area 9a, «Reset to empty instance»): nessun
 * provider, account, plugin; archiviazione e webhook spenti, nessun budget,
 * l'automazione tutta spenta. Le app Google sono in `state.googleWorkspaces`,
 * che l'istanza vuota svuota come ogni tabella.
 */
export function emptyInstanceState(): InstanceState {
  return {
    providers: [],
    models: {},
    automation: { rules: defaultRules(), prReview: { enabled: false, maxCostUsd: null } },
    budget: { monthlyUsd: null, contentLanguage: "en" },
    gitAccounts: [],
    plugins: [],
    storage: {
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: "",
      secretId: null,
      last4: null,
      attachmentsEnabled: false,
      lastTest: null,
    },
    webhook: { enabled: false, format: "slack", url: null, events: {}, lastTest: null },
    queuePauses: [],
    usage: [],
    nightly: [],
    simulate: { nextTest: {}, budgetReached: false, nextPluginOutcome: "ready" },
  };
}
