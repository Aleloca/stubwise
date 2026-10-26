import { visitSteps } from "../../domain/automations/fields";
import { validateFlow, type FlowIssue } from "../../domain/automations/validate";
import { fold } from "../../domain/textSearch";
import { copy, gate, state, visibleProjectIds } from "../store";
import type {
  Automation,
  AutomationDecision,
  AutomationDetail,
  AutomationFlow,
  AutomationRow,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunRow,
  AutomationSearchResult,
  AutomationSourceView,
  ClientLinkView,
  RunStatus,
} from "../types";
import { isOpen, publishedVersion } from "./runner";
import {
  approversFor,
  automationById,
  canManageAutomation,
  canManageIntegrations,
  canManageRun,
  canSeeAutomation,
  canSeeRun,
  canSeeSources,
  decidersOf,
  runById,
  runCode,
  stepOfRun,
} from "./visibility";

// Le letture delle Automations (area 7). Tutto passa da `visibility.ts`: un
// oggetto che chi guarda non vede risponde come uno che non esiste (`null`
// o assente dagli elenchi, R-G5). I permessi arrivano calcolati: la UI li
// legge, non li deduce.

// --- errori di configurazione ------------------------------------------------------

/** Le automazioni avviate dal flusso (passi `startAutomation`). */
function startsOf(flow: AutomationFlow): { path: string; automationId: string }[] {
  const out: { path: string; automationId: string }[] = [];
  visitSteps(flow.steps, (step, path) => {
    if (step.kind === "startAutomation") out.push({ path, automationId: step.automationId });
  });
  return out;
}

/** `to` porta (per avvii successivi, sulle versioni pubblicate) di nuovo a `from`? */
function reaches(toId: string, fromId: string, seen = new Set<string>()): boolean {
  if (toId === fromId) return true;
  if (seen.has(toId)) return false;
  seen.add(toId);
  const target = automationById(toId);
  const flow = target && publishedVersion(target)?.flow;
  return !!flow && startsOf(flow).some((s) => reaches(s.automationId, fromId, seen));
}

/**
 * Gli errori di configurazione di un flusso di `a`, visti dal proprietario
 * (`ownerId`; per una bozza mai accesa, chi la accenderebbe): quelli di
 * `validateFlow`, più quelli che chiedono i dati — un «Avvia un'altra
 * automazione» verso una che non esiste o che il proprietario non vede, o
 * che riavvia la stessa (A → … → A).
 */
export function configErrorsOf(a: Automation, flow: AutomationFlow, ownerId: string): FlowIssue[] {
  const asOwner: Automation = { ...a, ownerId };
  const issues = validateFlow(flow, {
    sources: state.automationSources,
    projectId: a.projectId,
    canApprove: (who, projectId) =>
      // Un ruolo in un progetto che si saprà solo dall'evento non si controlla prima.
      ("projectRole" in who && projectId === null && a.projectId === null) ||
      approversFor(asOwner, who, projectId ?? a.projectId).length > 0,
  });
  for (const { path, automationId } of startsOf(flow)) {
    if (!automationId) continue;
    const target = automationById(automationId);
    if (!target || !canSeeAutomation(ownerId, target)) {
      issues.push({
        path,
        code: "unknown_ref",
        message: "L'automazione da avviare non esiste o il proprietario non la vede.",
      });
    } else if (reaches(automationId, a.id)) {
      issues.push({
        path,
        code: "limit",
        message:
          "Avvierebbe di nuovo questa automazione: una catena di avvii non può tornare indietro.",
      });
    }
  }
  return issues;
}

const latest = (a: Automation) => a.versions.at(-1)!;

// --- righe ------------------------------------------------------------------------

const WAITING: ReadonlySet<RunStatus> = new Set([
  "waiting_approval",
  "waiting_event",
  "waiting_project",
]);

function automationRow(me: string, a: Automation): AutomationRow {
  const runs = state.automationRuns.filter((r) => r.automationId === a.id);
  const last = runs.reduce<string | null>(
    (m, r) => (m === null || r.startedAt > m ? r.startedAt : m),
    null,
  );
  return {
    ...copy(a),
    permissions: { manage: canManageAutomation(me, a) },
    openRuns: runs.filter(isOpen).length,
    waitingRuns: runs.filter((r) => WAITING.has(r.status)).length,
    lastRunAt: last,
    hasDraft: latest(a).publishedAt === null,
    configErrorCount: configErrorsOf(a, latest(a).flow, a.ownerId ?? me).length,
  };
}

export function runRow(run: AutomationRun): AutomationRunRow {
  const a = automationById(run.automationId)!;
  return {
    ...copy(run),
    code: runCode(run),
    automationCode: a.code,
    automationName: a.name,
    automationProjectId: a.projectId,
  };
}

/** In corso in alto (aperte), poi dalla più recente. */
const byRecency = (x: AutomationRun, y: AutomationRun) =>
  Number(isOpen(y)) - Number(isOpen(x)) || y.startedAt.localeCompare(x.startedAt) || y.n - x.n;

// --- automazioni ------------------------------------------------------------------

export async function listAutomations(
  filter: { projectId?: string; status?: Automation["status"]; ownerId?: string } = {},
): Promise<AutomationRow[]> {
  const me = await gate("automations.listAutomations");
  return state.automations
    .filter((a) => canSeeAutomation(me, a))
    .filter((a) => filter.projectId === undefined || a.projectId === filter.projectId)
    .filter((a) => filter.status === undefined || a.status === filter.status)
    .filter((a) => filter.ownerId === undefined || a.ownerId === filter.ownerId)
    .sort((x, y) => x.name.localeCompare(y.name) || x.code.localeCompare(y.code))
    .map((a) => automationRow(me, a));
}

/** Un'automazione con versioni, errori di configurazione ed esecuzioni; `null` se non la vedo. */
export async function getAutomation(id: string): Promise<AutomationDetail | null> {
  const me = await gate("automations.getAutomation");
  const a = automationById(id);
  if (!a || !canSeeAutomation(me, a)) return null;
  const owner = a.ownerId ?? me;
  const live = publishedVersion(a);
  return {
    automation: automationRow(me, a),
    configErrors: configErrorsOf(a, latest(a).flow, owner),
    liveErrors: live ? configErrorsOf(a, live.flow, owner) : [],
    runs: state.automationRuns
      .filter((r) => r.automationId === a.id)
      .sort(byRecency)
      .slice(0, 20)
      .map(runRow),
  };
}

export async function searchAutomations(q: string): Promise<AutomationSearchResult[]> {
  const me = await gate("automations.searchAutomations");
  const needle = fold(q.trim());
  if (!needle) return [];
  const has = (...fields: string[]) => fields.some((f) => fold(f).includes(needle));
  const out: AutomationSearchResult[] = [];
  for (const a of state.automations) {
    if (canSeeAutomation(me, a) && has(a.code, a.name)) {
      out.push({
        kind: "automation",
        id: a.id,
        code: a.code,
        label: a.name,
        route: `#/automations?automation=${a.id}`,
      });
    }
  }
  for (const run of [...state.automationRuns].sort(byRecency)) {
    const code = runCode(run);
    if (canSeeRun(me, run) && has(code, run.title)) {
      out.push({
        kind: "run",
        id: run.id,
        code,
        label: run.title,
        route: `#/automations?run=${run.id}`,
      });
    }
  }
  return out;
}

// --- esecuzioni -------------------------------------------------------------------

export async function listRuns(
  filter: { automationId?: string; projectId?: string; status?: RunStatus } = {},
): Promise<AutomationRunRow[]> {
  const me = await gate("automations.listRuns");
  return state.automationRuns
    .filter((r) => canSeeRun(me, r))
    .filter((r) => filter.automationId === undefined || r.automationId === filter.automationId)
    .filter(
      (r) =>
        filter.projectId === undefined ||
        r.projectIds.includes(filter.projectId) ||
        automationById(r.automationId)?.projectId === filter.projectId,
    )
    .filter((r) => filter.status === undefined || r.status === filter.status)
    .sort(byRecency)
    .map(runRow);
}

/** Un'esecuzione col suo registro e i permessi; `null` se non la vedo (R-G5). */
export async function getRun(id: string): Promise<AutomationRunDetail | null> {
  const me = await gate("automations.getRun");
  const run = runById(id);
  if (!run || !canSeeRun(me, run)) return null;
  const a = automationById(run.automationId)!;
  const deciders = decidersOf(run);
  const parent = run.parentRunId ? runById(run.parentRunId) : undefined;
  return {
    ...runRow(run),
    flow: copy(a.versions.find((v) => v.n === run.version)!.flow),
    deciders,
    permissions: {
      manage: canManageRun(me, run),
      approve: run.status === "waiting_approval" && deciders.includes(me),
      chooseProject: run.status === "waiting_project" && deciders.includes(me),
    },
    parent: parent && canSeeRun(me, parent) ? { id: parent.id, code: runCode(parent) } : null,
    children: state.automationRuns
      .filter((c) => c.parentRunId === run.id && canSeeRun(me, c))
      .map((c) => ({ id: c.id, code: runCode(c), status: c.status })),
  };
}

/**
 * «Da decidere» (area 7): i passi che aspettano la MIA approvazione e i
 * progetti che devo scegliere (sono il proprietario). Chi decide si risolve
 * adesso: un approvatore che non vede più il progetto non ce l'ha.
 */
export async function listMyApprovals(): Promise<AutomationDecision[]> {
  const me = await gate("automations.listMyApprovals");
  return state.automationRuns
    .filter((r) => decidersOf(r).includes(me))
    .sort((x, y) => (x.log.at(-1)?.at ?? "").localeCompare(y.log.at(-1)?.at ?? ""))
    .map((run) => {
      const a = automationById(run.automationId)!;
      const progetto = run.pending?.preview.progetto;
      return {
        kind: run.status === "waiting_project" ? ("project" as const) : ("approval" as const),
        runId: run.id,
        code: runCode(run),
        title: run.title,
        automationId: a.id,
        automationName: a.name,
        projectId: typeof progetto === "string" ? progetto : a.projectId,
        stepKind: stepOfRun(run)?.kind ?? "createTask",
        preview: copy(run.pending?.preview ?? {}),
        since: run.log.at(-1)?.at ?? run.startedAt,
      };
    });
}

// --- sorgenti e tabella cliente → progetto -------------------------------------------

export async function listSources(): Promise<AutomationSourceView[]> {
  const me = await gate("automations.listSources");
  if (!canSeeSources(me)) return [];
  const manage = canManageIntegrations(me);
  return state.automationSources.map((s) => ({ ...copy(s), permissions: { manage } }));
}

export async function listClientLinks(): Promise<ClientLinkView[]> {
  const me = await gate("automations.listClientLinks");
  if (!canSeeSources(me)) return [];
  const visible = visibleProjectIds(me);
  return state.clientProjectLinks.map((l) => {
    const projectVisible = visible.has(l.projectId);
    // Un progetto che non vedo resta senza id (R-G5): la riga dice solo «un progetto».
    return { ...copy(l), projectId: projectVisible ? l.projectId : "", projectVisible };
  });
}
