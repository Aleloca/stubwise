import {
  validateServerPlan,
  type AttributionInput,
  type PlanValidation,
  type ServerAction,
  type ServerPlan,
} from "@stubwise/shared";
import { utterance } from "../../domain/claude/answers";
import { commandInput, truncateOutput } from "../../domain/servers/commands";
import { actionKey } from "../../domain/servers/fixPlan";
import i18n from "../../i18n";
import type {
  EpisodeReason,
  MonitoredServer,
  ScriptStep,
  ServerCommandMeta,
  ServerService,
} from "../types";
import { docker, heaviest, pct, readSteps, serviceOfCheck, type ServerRead } from "./scripts";

// Gli script della correzione di un server (area 8, F4b, solo prototipo).
// Claude guarda i container con le letture dell'AGENTE (`container.state`),
// propone un piano di sole azioni dell'insieme CHIUSO (`SERVER_ACTIONS`,
// validato con `serverPlanSchema` di `@stubwise/shared`) e si ferma; solo
// dopo l'approvazione di una persona l'agente esegue le azioni, una alla
// volta (`tool: "server.fix"`, `serverCommand` con l'id del piano
// approvato), poi Claude controlla. Mai l'SSH, mai un comando libero, mai un
// rilascio (anti-obiettivo 1): nessun pull, aggiornamento d'immagine,
// ricreazione o deploy — l'insieme chiuso non sa esprimerli.

type PlanStep = ServerPlan["steps"][number];

/**
 * Un passo come azione CORRELATA ai suoi parametri (`ServerAction` di
 * shared): l'inferenza dello schema del piano non restringe i parametri
 * sull'azione, il tipo di shared sì. Solo azioni che cambiano: le letture
 * non entrano in un piano (`serverPlanSchema`).
 */
type ChangeAction = Exclude<ServerAction, { action: "container.logs" | "container.state" }>;
const asAction = (step: PlanStep): ChangeAction => step as unknown as ChangeAction;

/** Il container di un passo; `null` per «libera spazio», che tocca tutto il server. */
export const containerOf = (step: PlanStep): string | null => {
  const a = asAction(step);
  return a.action === "docker.prune" ? null : a.params.container;
};

/** Il servizio su cui agire: quello che la diagnosi nomina (fra backtick), se è del server; altrimenti il più pesante. */
function targetOf(s: MonitoredServer, by: "cpu" | "mem", diagnosis: string): ServerService | null {
  return s.services.find((x) => diagnosis.includes(`\`${x.name}\``)) ?? heaviest(s, by);
}

const restartOf = (x: ServerService | null, why: string): PlanStep[] =>
  x?.source === "docker"
    ? [{ action: "container.restart", params: { container: x.name, timeoutSeconds: 30 }, why }]
    : [];

function stepsOf(s: MonitoredServer, reason: EpisodeReason, diagnosis: string): PlanStep[] {
  switch (reason.kind) {
    case "memory": {
      const top = targetOf(s, "mem", diagnosis);
      return restartOf(
        top,
        `Restarts \`${top?.name}\`, so its memory comes back; it starts again from a clean state.`,
      );
    }
    case "cpu": {
      const top = targetOf(s, "cpu", diagnosis);
      return restartOf(top, `Restarts \`${top?.name}\`, which is using most of the CPU.`);
    }
    case "disk":
      return docker(s).length > 0
        ? [
            {
              action: "docker.prune",
              params: { what: "images_unused" },
              why: "Removes the images no container uses: nothing running is touched.",
            },
            {
              action: "docker.prune",
              params: { what: "build_cache" },
              why: "Removes Docker's build cache.",
            },
          ]
        : [];
    case "check": {
      const service = serviceOfCheck(s, reason.checkId);
      return restartOf(service, `Restarts \`${service?.name}\`, so the check can answer again.`);
    }
    case "agent_silent":
      // L'agente che non risponde non esegue niente: nessuna azione serve.
      return [];
  }
}

export interface FixPlan {
  /** Le letture dei container prima del piano, via agente. */
  reads: ServerRead[];
  /** Il piano validato; `null` se nessuna azione dell'insieme chiuso serve. */
  plan: ServerPlan | null;
  /**
   * Senza piano, perché (un CODICE, mai testo del modello, come `planError`
   * del server): nessuna azione serve, o il piano non stava nelle regole.
   */
  error: "no_plan" | Extract<PlanValidation, { ok: false }>["reason"] | null;
  planText: string;
  summary: string;
}

const agentRead = (id: string, action: "container.state", service: ServerService): ServerRead => ({
  id,
  params: { service: service.name },
  command: {
    action,
    params: { container: service.name },
    kind: "read",
    via: "agent",
    approvalId: null,
    exitCode: 0,
  },
  output: JSON.stringify(
    {
      State: { Status: service.state, Running: service.state === "running" },
      RestartCount: service.restarts ?? 0,
      Image: service.image ?? null,
    },
    null,
    2,
  ),
});

/** Un'azione in parole, in inglese come il resto dei dati (la UI la traduce da `serverPlan`). */
function stepLine(plan: PlanStep): string {
  const step = asAction(plan);
  switch (step.action) {
    case "container.restart":
      return `Restart \`${step.params.container}\` (stop waits up to ${step.params.timeoutSeconds} s)`;
    case "container.stop":
      return `Stop \`${step.params.container}\` (waits up to ${step.params.timeoutSeconds} s)`;
    case "container.start":
      return `Start \`${step.params.container}\``;
    case "docker.prune":
      return {
        images_unused: "Free up space: remove the unused images",
        build_cache: "Free up space: remove the build cache",
        stopped_containers: "Free up space: remove the stopped containers",
      }[step.params.what];
  }
}

/**
 * Il piano della correzione: i passi per i motivi dell'episodio, una volta
 * ciascuno, validati (`validateServerPlan`); le note di chi ha avviato e le
 * indicazioni di chi ha rifiutato il piano di prima, se ci sono.
 * `diagnosis`: il testo della task (il servizio che nomina).
 * `ctx`: il progetto della task e i progetti del server coi loro container
 * (R0-D) — un passo su un container non del progetto non entra.
 */
export function fixPlan(
  s: MonitoredServer,
  reasons: EpisodeReason[],
  diagnosis: string,
  ctx: { projectId: string; serverProjects: AttributionInput["serverProjects"] },
  instructions?: string,
  notes?: string,
): FixPlan {
  const steps: PlanStep[] = [];
  for (const reason of reasons)
    for (const step of stepsOf(s, reason, diagnosis))
      if (!steps.some((x) => JSON.stringify(x) === JSON.stringify(step))) steps.push(step);
  const checked =
    steps.length > 0
      ? validateServerPlan({
          plan: { steps },
          projectId: ctx.projectId,
          serverProjects: ctx.serverProjects,
          seenContainers: docker(s).map((x) => x.name),
        })
      : null;
  const plan = checked?.ok ? checked.plan : null;
  const targets = (plan?.steps ?? []).flatMap((x) => containerOf(x) ?? []);
  const lines = [
    `## Fix plan for ${s.code} ${s.name}`,
    "",
    `The monitoring agent on ${s.code} runs these actions one at a time, and only after a person who can approve plans approves this plan. Nothing else can run: no commands, no deploys.`,
    "",
    "### Actions",
    "",
    ...(plan
      ? plan.steps.flatMap((x, i) => [`${i + 1}. ${stepLine(x)}`, `   ${x.why}`])
      : ["None of the allowed actions fixes this: no plan."]),
    "",
    "### Check",
    "",
    "Afterwards Claude reads the containers again through the agent and says whether the problem is gone.",
    ...(notes ? ["", "### Notes from the person who started the fix", "", notes] : []),
    ...(instructions ? ["", "### Instructions from the review", "", instructions] : []),
  ];
  const n = plan?.steps.length ?? 0;
  return {
    reads: s.services
      .filter((x) => targets.includes(x.name))
      .map((x) => agentRead("containerState", "container.state", x)),
    plan,
    // Il motivo di `validateServerPlan` così com'è: lo stesso codice del server.
    error: plan ? null : checked && !checked.ok ? checked.reason : "no_plan",
    planText: lines.join("\n"),
    summary:
      n > 0
        ? `${n} action${n === 1 ? "" : "s"} on ${s.code} through the monitoring agent, then a check.`
        : `No allowed action fixes this on ${s.code}.`,
  };
}

/** L'uscita finta di un'azione: quello che l'agente riporta (contenuto NON fidato). */
function outputOf(plan: PlanStep): string {
  const step = asAction(plan);
  switch (step.action) {
    case "container.restart":
      return `container ${step.params.container} restarted (stopped in 2.1s, running)`;
    case "container.stop":
      return `container ${step.params.container} stopped`;
    case "container.start":
      return `container ${step.params.container} started`;
    case "docker.prune":
      return {
        images_unused: "Deleted images: 14\nTotal reclaimed space: 38.2GB",
        build_cache: "Deleted build cache objects: 212\nTotal reclaimed space: 6.4GB",
        stopped_containers: "Deleted containers: 3\nTotal reclaimed space: 120MB",
      }[step.params.what];
  }
}

/**
 * L'azione di un passo approvato, come la esegue l'agente (`tool:
 * "server.fix"`): il comando dell'insieme chiuso con l'id del piano che la
 * copre, l'uscita intera e `truncated` oltre `COMMAND_OUTPUT_MAX_LINES`
 * righe. Chi la esegue la passa UNA alla volta, ricontrollando prima.
 */
export function fixStepAction(step: PlanStep, approvalId: string): ScriptStep {
  const command: ServerCommandMeta = {
    action: step.action,
    params: { ...step.params },
    kind: "change",
    via: "agent",
    approvalId,
    exitCode: 0,
  };
  const key = `claude.serverFix.actions.${actionKey(step.action)}`;
  const params = Object.fromEntries(Object.entries(step.params).map(([k, v]) => [k, String(v)]));
  const output = outputOf(step);
  return {
    step: "action",
    tool: "server.fix",
    serverCommand: command,
    label: i18n.t(key, params),
    labelText: utterance(key, params),
    input: commandInput(command),
    result: output,
    ...(truncateOutput(output).truncated ? { truncated: true } : {}),
  };
}

/** Che cosa dice il controllo per un motivo, e su quale container rilegge lo stato. */
function checkPhrase(reason: EpisodeReason, ok: boolean): string {
  switch (reason.kind) {
    case "memory":
      return ok ? "memory at 41%" : `memory still at ${pct(reason.valuePct)}`;
    case "cpu":
      return ok ? "CPU back to normal" : `CPU still at ${pct(reason.valuePct)}`;
    case "disk":
      return ok ? "disk at 61%" : `disk still at ${pct(reason.valuePct)}`;
    case "check":
      return ok ? "the check answers again" : "the check still doesn't answer";
    case "agent_silent":
      return ok ? "the agent reports again" : "the agent still doesn't report";
  }
}

/**
 * Il controllo finale: lo stato dei container toccati, riletto via agente,
 * e la riga `server_check` con `resolved` esplicito (R-L3): è lei, non
 * l'esito della sessione, a dire risolto o no. Le misure vengono
 * dall'ultimo campione dell'agente.
 */
export function fixCheck(
  s: MonitoredServer,
  plan: ServerPlan,
  reasons: EpisodeReason[],
  resolved: boolean,
): ScriptStep[] {
  const touched = plan.steps.flatMap((x) => containerOf(x) ?? []);
  const reads = s.services
    .filter((x) => touched.includes(x.name))
    .map((x) => agentRead("containerState", "container.state", x));
  const what = reasons.map((r) => checkPhrase(r, resolved)).join(", ");
  return [
    ...readSteps(reads),
    {
      step: "event",
      event: {
        type: "work_result",
        kind: "server_check",
        text: `Check after the fix: ${resolved ? "resolved" : "not resolved"}${what ? ` — ${what}` : ""}`,
        resolved,
        ...(what ? { detail: what } : {}),
      },
    },
  ];
}
