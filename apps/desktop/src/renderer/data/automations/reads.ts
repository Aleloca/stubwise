import { visitSteps } from "../../domain/automations/fields";
import { projectOf } from "../../domain/automations/preview";
import { validateFlow, type FlowIssue } from "../../domain/automations/validate";
import { fold } from "../../domain/textSearch";
import { automationHref, runHref } from "../routes";
import { copy, gate, state, visibleProjectIds } from "../store";
import { notFound } from "../writer";
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
import { pendingEffectOf } from "./pendingEffect";
import { viewRun } from "./runView";
import { isOpen, publishedVersion, sweepApprovals } from "./runner";
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
  flowFor,
  keepHiddenProjects,
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
    if (!target || !canSeeAutomation(ownerId, target) || !canManageAutomation(ownerId, target)) {
      issues.push({
        path,
        code: "unknown_ref",
        message:
          "L'automazione da avviare non esiste, o il proprietario non la vede o non può gestirla.",
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
  personApprovers(a, flow, issues);
  return issues;
}

/**
 * R-J11: una persona indicata come approvatore deve vedere ogni progetto in
 * cui il passo può agire, quando si sa già prima dell'evento: quello
 * dell'automazione o quello fisso, e per «il progetto del cliente» (anche
 * dei passi senza progetto di una generale che ne risolve uno) ogni
 * progetto della tabella cliente → progetto.
 */
function personApprovers(a: Automation, flow: AutomationFlow, issues: FlowIssue[]): void {
  const table = [...new Set(state.clientProjectLinks.map((l) => l.projectId))];
  let usesClient = false;
  visitSteps(flow.steps, (step) => {
    if (projectOf(step)?.mode === "from_client") usesClient = true;
  });
  visitSteps(flow.steps, (step, path) => {
    if (!("approval" in step) || step.approval.mode !== "ask") return;
    const who = step.approval.who;
    if (!("personId" in who) || !who.personId) return;
    const t = projectOf(step);
    const candidates =
      t?.mode === "own"
        ? [a.projectId]
        : t?.mode === "fixed"
          ? [t.projectId]
          : t?.mode === "from_client" || (!t && a.projectId === null && usesClient)
            ? table
            : [a.projectId];
    const sees = visibleProjectIds(who.personId);
    if (!candidates.some((p) => p !== null && !sees.has(p))) return;
    if (issues.some((i) => i.path === path && i.code === "approver_cant_see")) return;
    issues.push({
      path,
      code: "approver_cant_see",
      message: "Chi deve approvare non vede uno dei progetti in cui il passo può agire.",
    });
  });
}

const latest = (a: Automation) => a.versions.at(-1)!;

// --- righe ------------------------------------------------------------------------

const WAITING: ReadonlySet<RunStatus> = new Set([
  "waiting_approval",
  "waiting_event",
  "waiting_project",
]);

export function automationRow(me: string, a: Automation): AutomationRow {
  const live = publishedVersion(a);
  const runs = state.automationRuns.filter((r) => r.automationId === a.id);
  const last = runs.reduce<string | null>(
    (m, r) => (m === null || r.startedAt > m ? r.startedAt : m),
    null,
  );
  return {
    ...copy(a),
    // R-G5: un progetto fisso che non vedo non ha id nemmeno nel flusso.
    versions: a.versions.map((v) => ({ ...copy(v), flow: flowFor(me, v.flow) })),
    permissions: { manage: canManageAutomation(me, a) },
    openRuns: runs.filter(isOpen).length,
    waitingRuns: runs.filter((r) => WAITING.has(r.status)).length,
    lastRunAt: last,
    hasDraft: latest(a).publishedAt === null,
    configErrorCount: configErrorsOf(a, latest(a).flow, a.ownerId ?? me).length,
    liveErrorCount: live ? configErrorsOf(a, live.flow, a.ownerId ?? me).length : 0,
  };
}

export function runRow(me: string, source: AutomationRun): AutomationRunRow {
  const run = viewRun(me, source);
  const a = automationById(run.automationId)!;
  return {
    ...run,
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
  sweepApprovals();
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
  sweepApprovals();
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
      .map((r) => runRow(me, r)),
  };
}

/**
 * Gli errori di configurazione di un flusso NON ancora salvato, come li
 * avrebbe la bozza di `id` (stesso proprietario di `getAutomation`): il
 * costruttore li mostra mentre la bozza si salva. Non scrive niente.
 */
export async function checkDraft(id: string, flow: AutomationFlow): Promise<FlowIssue[]> {
  const me = await gate("automations.checkDraft");
  const a = automationById(id);
  if (!a || !canSeeAutomation(me, a)) throw notFound();
  // Come al salvataggio: i progetti fissi che non vedo restano quelli della versione (R-G5).
  const next = copy(flow);
  keepHiddenProjects(me, latest(a).flow, next);
  return configErrorsOf(a, next, a.ownerId ?? me);
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
        route: automationHref(a.code),
        status: a.status,
      });
    }
  }
  for (const source of [...state.automationRuns].sort(byRecency)) {
    if (!canSeeRun(me, source)) continue;
    // Il titolo come lo vede chi cerca (R-J13: senza l'oggetto di un'email altrui).
    const run = viewRun(me, source);
    const code = runCode(run);
    const a = automationById(run.automationId)!;
    if (has(code, run.title)) {
      out.push({
        kind: "run",
        id: run.id,
        code,
        label: run.title,
        route: runHref(a.code, run.n),
        status: run.status,
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
  sweepApprovals();
  // Un progetto che non vedo risponde come uno che non esiste (R-J12).
  if (filter.projectId !== undefined && !visibleProjectIds(me).has(filter.projectId)) return [];
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
    .map((r) => runRow(me, r));
}

/** Un'esecuzione col suo registro e i permessi; `null` se non la vedo (R-G5). */
export async function getRun(id: string): Promise<AutomationRunDetail | null> {
  const me = await gate("automations.getRun");
  sweepApprovals();
  const run = runById(id);
  if (!run || !canSeeRun(me, run)) return null;
  const a = automationById(run.automationId)!;
  const deciders = decidersOf(run);
  const parent = run.parentRunId ? runById(run.parentRunId) : undefined;
  const row = runRow(me, run);
  return {
    ...row,
    pendingEffect: pendingEffectOf(me, run, row),
    flow: flowFor(me, a.versions.find((v) => v.n === run.version)!.flow),
    deciders,
    ownerId: a.ownerId,
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
  sweepApprovals();
  return state.automationRuns
    .filter((r) => decidersOf(r).includes(me))
    .sort((x, y) => (x.log.at(-1)?.at ?? "").localeCompare(y.log.at(-1)?.at ?? ""))
    .map((source) => {
      const run = viewRun(me, source);
      const a = automationById(run.automationId)!;
      const progetto = run.pending?.preview.progetto;
      const client = run.pending?.preview.clientName;
      const cliente = (run.event.cliente as { nome?: unknown } | undefined)?.nome;
      return {
        kind: run.status === "waiting_project" ? ("project" as const) : ("approval" as const),
        runId: run.id,
        code: runCode(run),
        title: run.title,
        automationId: a.id,
        automationName: a.name,
        projectId: typeof progetto === "string" ? progetto : a.projectId,
        stepKind: stepOfRun(source)?.kind ?? "createTask",
        preview: copy(run.pending?.preview ?? {}),
        since: run.log.at(-1)?.at ?? run.startedAt,
        cursor: source.cursor ?? "",
        automationCode: a.code,
        n: run.n,
        automationVisible: canSeeAutomation(me, a),
        clientName:
          typeof client === "string" ? client : typeof cliente === "string" ? cliente : "",
        effect: pendingEffectOf(me, source, run),
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
