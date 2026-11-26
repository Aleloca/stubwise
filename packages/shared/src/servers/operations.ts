import { z } from "zod";

// Le operazioni sui server (area 8, F4b). Le regole stanno in CLAUDE.md
// («Stubwise non fa deploy; il merge è il confine dei RILASCI») e in
// docs/invariants/server-operations.md. Qui l'insieme CHIUSO delle azioni
// (`SERVER_ACTIONS`), la serializzazione CANONICA di un comando firmato, le
// letture SSH (`SSH_READS`), i tetti dell'analisi e l'attribuzione del guasto
// a un progetto. ⚠️ Aggiungere un'azione è un cambio di prodotto, non una
// modifica di codice.

/** Il nome di un container come lo accetta Docker; niente `/`, spazi, `;`, `$`, a capo. */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;
const containerSchema = z.string().regex(CONTAINER_NAME_RE);
const timeoutSchema = z.number().int().min(1).max(120);

export type ServerActionKind = "change" | "read";

/** L'insieme chiuso: azione, tipo, schema STRETTO dei parametri. */
export const SERVER_ACTIONS = [
  { action: "container.restart", kind: "change", params: z.strictObject({ container: containerSchema, timeoutSeconds: timeoutSchema }) },
  { action: "container.stop", kind: "change", params: z.strictObject({ container: containerSchema, timeoutSeconds: timeoutSchema }) },
  { action: "container.start", kind: "change", params: z.strictObject({ container: containerSchema }) },
  {
    action: "docker.prune",
    kind: "change",
    params: z.strictObject({ what: z.enum(["images_unused", "build_cache", "stopped_containers"]) }),
  },
  {
    action: "container.logs",
    kind: "read",
    params: z.strictObject({ container: containerSchema, lines: z.number().int().min(1).max(500), sinceMinutes: z.number().int().min(1).max(1440) }),
  },
  { action: "container.state", kind: "read", params: z.strictObject({ container: containerSchema }) },
] as const;

export type ServerActionName = (typeof SERVER_ACTIONS)[number]["action"];

const actionVariant = <A extends (typeof SERVER_ACTIONS)[number]>(a: A) =>
  z.strictObject({ action: z.literal(a.action), params: a.params });

/** Un'azione con i suoi parametri: fuori dall'insieme, o con un parametro in più, non passa. */
export const serverActionSchema = z.discriminatedUnion("action", [
  actionVariant(SERVER_ACTIONS[0]),
  actionVariant(SERVER_ACTIONS[1]),
  actionVariant(SERVER_ACTIONS[2]),
  actionVariant(SERVER_ACTIONS[3]),
  actionVariant(SERVER_ACTIONS[4]),
  actionVariant(SERVER_ACTIONS[5]),
]);
/** Un'azione: il tipo CORRELA l'azione ai suoi parametri (il `switch` sull'azione li restringe). */
export type ServerAction = {
  [A in (typeof SERVER_ACTIONS)[number] as A["action"]]: { action: A["action"]; params: z.infer<A["params"]> };
}[ServerActionName];

export const serverActionKind = (action: string): ServerActionKind | null =>
  SERVER_ACTIONS.find((a) => a.action === action)?.kind ?? null;

const changeActions = SERVER_ACTIONS.filter((a) => a.kind === "change");

/** Un passo di un piano di correzione: SOLO azioni che cambiano (le letture sono dell'analisi). */
export const serverPlanStepSchema = z.discriminatedUnion("action", [
  actionVariant(SERVER_ACTIONS[0]).extend({ why: z.string().min(1).max(500) }),
  actionVariant(SERVER_ACTIONS[1]).extend({ why: z.string().min(1).max(500) }),
  actionVariant(SERVER_ACTIONS[2]).extend({ why: z.string().min(1).max(500) }),
  actionVariant(SERVER_ACTIONS[3]).extend({ why: z.string().min(1).max(500) }),
]);
export const serverPlanSchema = z.strictObject({ steps: z.array(serverPlanStepSchema).min(1).max(10) });
export type ServerPlan = z.infer<typeof serverPlanSchema>;
export const SERVER_CHANGE_ACTIONS: readonly string[] = changeActions.map((a) => a.action);

// --- Il comando firmato ------------------------------------------------------

export interface ServerCommandPayload {
  v: 1;
  serverId: string;
  commandId: string;
  action: string;
  params: Record<string, unknown>;
  /** null per una lettura dell'analisi (Q2 = a: senza approvazione). */
  approvalId: string | null;
  issuedAt: string;
  expiresAt: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

/**
 * La stringa che il server firma e l'agente verifica: chiavi ordinate a ogni
 * livello, nessuno spazio. Ogni campo è coperto: cambiarne uno invalida la
 * firma.
 */
export function canonicalCommandPayload(p: ServerCommandPayload): string {
  return canonical(p);
}

// --- Le letture SSH (Q3 = b) -------------------------------------------------

type SshArgv = (p: Record<string, number>) => string[];
const sshRead = <R extends string, P extends z.ZodType>(read: R, params: P, argv: SshArgv, needsJournalGroup = false) => ({ read, params, argv, needsJournalGroup });
const noParams = z.strictObject({});

/** Le letture via SSH: argv FISSI, parametri solo numerici; mai una scrittura. */
export const SSH_READS = [
  sshRead("processes", z.strictObject({ top: z.number().int().min(1).max(50) }), () => ["ps", "-eo", "pid,user,pcpu,pmem,etime,comm", "--sort=-pcpu"]),
  sshRead("disk", noParams, () => ["df", "-P"]),
  sshRead("memory", noParams, () => ["cat", "/proc/meminfo"]),
  sshRead("load", noParams, () => ["cat", "/proc/loadavg"]),
  sshRead("uptime", noParams, () => ["uptime"]),
  sshRead("listening", noParams, () => ["ss", "-ltn"]),
  sshRead("failed_units", noParams, () => ["systemctl", "--failed", "--no-legend"]),
  sshRead(
    "journal_errors",
    z.strictObject({ lines: z.number().int().min(1).max(200) }),
    (p) => ["journalctl", "-p", "err", "-n", String(p["lines"]), "--no-pager"],
    true,
  ),
] as const;

export type SshReadName = (typeof SSH_READS)[number]["read"];

const readVariant = <R extends (typeof SSH_READS)[number]>(r: R) => z.strictObject({ read: z.literal(r.read), params: r.params });
export const sshReadSchema = z.discriminatedUnion("read", [
  readVariant(SSH_READS[0]),
  readVariant(SSH_READS[1]),
  readVariant(SSH_READS[2]),
  readVariant(SSH_READS[3]),
  readVariant(SSH_READS[4]),
  readVariant(SSH_READS[5]),
  readVariant(SSH_READS[6]),
  readVariant(SSH_READS[7]),
]);
export type SshRead = z.infer<typeof sshReadSchema>;

// --- I tetti dell'analisi (F4b-2 = b, Impostazioni) --------------------------

export const serverAnalysisLimitsSchema = z.object({
  enabled: z.boolean().default(true),
  maxMinutes: z.number().int().min(1).max(60).default(10),
  maxCostUsd: z.number().min(0.1).max(20).default(1),
  maxAgentReads: z.number().int().min(0).max(200).default(30),
  maxSshReads: z.number().int().min(0).max(200).default(30),
});
export type ServerAnalysisLimits = z.infer<typeof serverAnalysisLimitsSchema>;

/**
 * I tetti salvati (`instance_settings.server_analysis_limits`), o i default:
 * una riga assente o corrotta non toglie i tetti, li riporta ai default.
 * Server e worker leggono da qui.
 */
export function readServerAnalysisLimits(raw: unknown): ServerAnalysisLimits {
  const parsed = serverAnalysisLimitsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : serverAnalysisLimitsSchema.parse({});
}

// --- L'attribuzione del guasto a un progetto (F4b-4) -------------------------

export interface AttributionInput {
  /** I progetti i cui ambienti usano il server, coi container di ciascun ambiente su QUEL server. */
  serverProjects: readonly {
    projectId: string;
    projectCode: string;
    environments: readonly { name: string; containers: readonly string[] }[];
  }[];
  /** I container che l'agente ha riportato nell'ultimo campione. */
  seenContainers: readonly string[];
  /** Ciò che l'analisi dichiara (contenuto del modello: non fidato). */
  cause: { projectCode: string | null; containers: readonly string[] };
}

export type Attribution =
  | { kind: "attributed"; projectId: string; projectCode: string }
  | {
      kind: "undetermined";
      reason: "no_project" | "project_not_on_server" | "no_containers" | "unknown_container" | "no_container_of_project" | "containers_of_other_project";
    };

/**
 * Il progetto dichiarato dall'analisi vale solo se lo DIMOSTRANO i container:
 * il progetto usa quel server; i container citati esistono sul server; almeno
 * uno è legato a un ambiente di quel progetto (la lista dell'ambiente, o — se
 * vuota — il container col NOME dell'ambiente); nessuno è legato a un ALTRO
 * progetto. Un server di un solo progetto: quel progetto. Altrimenti «non
 * determinato»: niente task di correzione, niente piano. Così un testo ostile
 * non sposta il piano dove chi attacca può approvare.
 */
export function attributeServerCause(input: AttributionInput): Attribution {
  const seen = new Set(input.seenContainers);
  const cited = [...new Set(input.cause.containers)];
  if (cited.some((c) => !seen.has(c))) return { kind: "undetermined", reason: "unknown_container" };

  const owners = new Map<string, Set<string>>();
  for (const p of input.serverProjects) {
    for (const env of p.environments) {
      const containers = env.containers.length > 0 ? env.containers : [env.name];
      for (const c of containers) owners.set(c, (owners.get(c) ?? new Set()).add(p.projectId));
    }
  }

  if (input.serverProjects.length === 1) {
    const only = input.serverProjects[0]!;
    if (input.cause.projectCode !== null && input.cause.projectCode !== only.projectCode) {
      return { kind: "undetermined", reason: "project_not_on_server" };
    }
    return { kind: "attributed", projectId: only.projectId, projectCode: only.projectCode };
  }

  if (input.cause.projectCode === null) return { kind: "undetermined", reason: "no_project" };
  const project = input.serverProjects.find((p) => p.projectCode === input.cause.projectCode);
  if (!project) return { kind: "undetermined", reason: "project_not_on_server" };
  if (cited.length === 0) return { kind: "undetermined", reason: "no_containers" };
  if (cited.some((c) => [...(owners.get(c) ?? [])].some((id) => id !== project.projectId))) {
    return { kind: "undetermined", reason: "containers_of_other_project" };
  }
  if (!cited.some((c) => owners.get(c)?.has(project.projectId))) {
    return { kind: "undetermined", reason: "no_container_of_project" };
  }
  return { kind: "attributed", projectId: project.projectId, projectCode: project.projectCode };
}

// --- L'analisi di un server: gli strumenti (area 8, F4b, S5) -----------------

/** Il server MCP dell'analisi (e della correzione) di un server. */
export const SERVER_MCP_SERVER_NAME = "stubwise_server";

/**
 * Gli strumenti dell'analisi: SOLE LETTURE più UNO strutturato finale. Nessuno
 * strumento cambia qualcosa (un test lo verifica sull'elenco): le letture
 * dell'agente diventano comandi `read` firmati e registrati.
 */
export const SERVER_ANALYSIS_READ_TOOLS = [
  "server_overview",
  "server_metrics",
  "server_environments",
  "container_logs",
  "container_state",
  "ssh_read",
] as const;
export const SERVER_ANALYSIS_TOOLS = [...SERVER_ANALYSIS_READ_TOOLS, "report_server_diagnosis"] as const;
export type ServerAnalysisTool = (typeof SERVER_ANALYSIS_TOOLS)[number];
/**
 * Gli strumenti della sessione che propone un piano nuovo per una task di
 * server (S6, `server_fix`): le stesse letture, e al posto del resoconto UNO
 * strumento che propone il piano (validato dal ponte, mai eseguito).
 */
export const SERVER_FIX_TOOLS = [...SERVER_ANALYSIS_READ_TOOLS, "propose_server_plan"] as const;
export type ServerOpsTool = ServerAnalysisTool | "propose_server_plan";

/**
 * L'unico strumento con cui l'analisi finisce. Contenuto del modello: NON
 * fidato. Il progetto si valida (`attributeServerCause`), i passi del piano si
 * validano contro l'insieme chiuso nella correzione (S6): qui si salvano come
 * proposta grezza, mai come comando.
 */
export const serverDiagnosisReportSchema = z
  .object({
    summary: z.string().min(1).max(8000),
    cause: z
      .object({
        projectCode: z.string().max(40).nullable(),
        containers: z.array(z.string().max(128)).max(20).default([]),
        why: z.string().max(4000).default(""),
      })
      .strict(),
    fix: z
      .object({
        steps: z
          .array(z.object({ action: z.string().max(64), params: z.record(z.string(), z.unknown()).default({}), why: z.string().max(2000).default("") }).strict())
          .max(10),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ServerDiagnosisReport = z.infer<typeof serverDiagnosisReportSchema>;

// --- Il piano di correzione, validato (area 8, F4b, S6) ----------------------

export type PlanValidation =
  | { ok: true; plan: ServerPlan }
  | {
      ok: false;
      reason: "schema" | "unknown_container" | "container_of_other_project" | "container_not_of_project";
      step: number | null;
    };

/**
 * Un piano proposto (contenuto del modello: NON fidato) diventa una proposta
 * salvabile solo se: è nello schema chiuso (solo azioni che cambiano, 1–10
 * passi, parametri stretti); ogni container è VISTO sul server ed è legato a
 * un ambiente del progetto ATTRIBUITO (la lista dell'ambiente, o il nome
 * dell'ambiente se la lista è vuota) e a nessun altro progetto. Una pulizia
 * (`docker.prune`) non nomina container ed è ammessa su ogni server (F4b-8 =
 * c): agisce su TUTTO il server, e chi approva lo vede prima (l'avviso coi
 * progetti toccati lo calcola il server nella vista della correzione). Il
 * testo libero non diventa mai un comando.
 */
/**
 * Di quali progetti è ogni container del server: la lista dell'ambiente, o —
 * se è vuota — il container col NOME dell'ambiente (la regola della fase 8).
 */
export function containerOwners(serverProjects: AttributionInput["serverProjects"]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const p of serverProjects) {
    for (const env of p.environments) {
      for (const c of env.containers.length > 0 ? env.containers : [env.name]) owners.set(c, (owners.get(c) ?? new Set()).add(p.projectId));
    }
  }
  return owners;
}

export function validateServerPlan(input: {
  plan: unknown;
  projectId: string;
  serverProjects: AttributionInput["serverProjects"];
  seenContainers: readonly string[];
}): PlanValidation {
  const parsed = serverPlanSchema.safeParse(input.plan);
  if (!parsed.success) return { ok: false, reason: "schema", step: null };
  const seen = new Set(input.seenContainers);
  const owners = containerOwners(input.serverProjects);
  for (const [i, step] of parsed.data.steps.entries()) {
    if (step.action === "docker.prune") continue;
    const container = (step.params as { container: string }).container;
    if (!seen.has(container)) return { ok: false, reason: "unknown_container", step: i };
    const of = owners.get(container) ?? new Set<string>();
    if ([...of].some((id) => id !== input.projectId)) return { ok: false, reason: "container_of_other_project", step: i };
    if (!of.has(input.projectId)) return { ok: false, reason: "container_not_of_project", step: i };
  }
  return { ok: true, plan: parsed.data };
}
