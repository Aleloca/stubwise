import { gate, state, visibleProjectIds } from "../store";
import type {
  AutomationOrigin,
  AutomationRef,
  AutomationRun,
  MyAutomationRun,
  ProjectAutomationRun,
  ProjectAutomationsView,
} from "../types";
import { can, viewerFor } from "../viewer";
import { automationRow, runRow, viewRun } from "./reads";
import { isOpen, sweepApprovals } from "./runner";
import {
  automationById,
  canManageRun,
  canSeeAutomation,
  canSeeRun,
  decidersOf,
  runCode,
} from "./visibility";

// Le letture dei punti d'ingresso delle Automations (shape automations.md
// §6, Task 8): il blocco Home, la sezione del progetto, l'origine di una
// task o di un traguardo. Stessa regola di `reads.ts`: ciò che chi guarda
// non vede risponde come ciò che non esiste (R-G5), e un'esecuzione si
// legge sempre passata da `viewRun` (R-J12, R-J13, R-J16).

const lastAt = (r: AutomationRun) => r.log.at(-1)?.at ?? r.startedAt;

/**
 * Il blocco Home «Automations» (shape [A 25]): le esecuzioni che mi
 * riguardano — che aspettano me, fallite di automazioni che posso gestire,
 * non finite di automazioni di cui sono il proprietario —, in quest'ordine
 * e poi dalla più recente. Le stesse di `#/automations?view=runs&mine=1`.
 */
export async function listMyRuns(): Promise<MyAutomationRun[]> {
  const me = await gate("automations.listMyRuns");
  sweepApprovals();
  const rank = { waiting_me: 0, failed: 1, owner: 2 } as const;
  const out: MyAutomationRun[] = [];
  for (const r of state.automationRuns) {
    if (!canSeeRun(me, r)) continue;
    const concern = decidersOf(r).includes(me)
      ? "waiting_me"
      : r.status === "failed" && canManageRun(me, r)
        ? "failed"
        : isOpen(r) && automationById(r.automationId)?.ownerId === me
          ? "owner"
          : null;
    if (concern) out.push({ ...runRow(me, r), concern });
  }
  return out.sort(
    (x, y) =>
      rank[x.concern] - rank[y.concern] ||
      y.startedAt.localeCompare(x.startedAt) ||
      x.code.localeCompare(y.code),
  );
}

/**
 * La sezione «Automations» di un progetto (shape [A 22], [A 23]); `null`
 * se il progetto non lo vedo. Le esecuzioni di una generale che ha agito
 * qui arrivano a ogni membro, ma a chi non vede la generale solo con
 * codice, titolo e stato (niente registro, niente nome, niente link).
 */
export async function getProjectAutomations(
  projectId: string,
): Promise<ProjectAutomationsView | null> {
  const me = await gate("automations.getProjectAutomations");
  sweepApprovals();
  if (!state.projectsById.has(projectId) || !visibleProjectIds(me).has(projectId)) return null;
  const own = state.automations
    .filter((a) => a.projectId === projectId && canSeeAutomation(me, a))
    .sort((x, y) => x.name.localeCompare(y.name) || x.code.localeCompare(y.code));
  const ownIds = new Set(own.map((a) => a.id));
  const isGeneral = (r: AutomationRun) => automationById(r.automationId)?.projectId === null;
  const acted = state.automationRuns.filter(
    (r) => isGeneral(r) && r.projectIds.includes(projectId),
  );

  const runs: ProjectAutomationRun[] = state.automationRuns
    .filter((r) => isOpen(r) && (ownIds.has(r.automationId) || acted.includes(r)))
    .sort((x, y) => y.startedAt.localeCompare(x.startedAt) || y.n - x.n)
    .map((r) => {
      const linkable = canSeeRun(me, r);
      const seen = viewRun(me, r);
      const a = automationById(r.automationId)!;
      return {
        id: r.id,
        n: r.n,
        code: runCode(r),
        title: seen.title,
        status: r.status,
        startedAt: r.startedAt,
        automationCode: a.code,
        automationName: linkable ? a.name : "",
        linkable,
      };
    });

  const general = [...new Set(acted.map((r) => r.automationId))]
    .map((id) => automationById(id)!)
    .filter((a) => canSeeAutomation(me, a))
    .map((a) => {
      const mine = acted.filter((r) => r.automationId === a.id);
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        lastActedAt: mine.map(lastAt).sort().at(-1)!,
        runCount: mine.length,
      };
    })
    .sort((x, y) => y.lastActedAt.localeCompare(x.lastActedAt));

  const canCreate = can(viewerFor(me), "automations.manage", projectId);
  return {
    // La voce c'è se questa persona riceve qualcosa da vedere, o può crearne.
    show: own.length > 0 || runs.length > 0 || general.length > 0 || canCreate,
    canCreate,
    automations: own.map((a) => automationRow(me, a)),
    runs,
    general,
  };
}

/**
 * L'origine di una task o di un traguardo creati da un'esecuzione (shape
 * [A 24]): codice e nome dell'automazione, numero dell'esecuzione e la riga
 * del registro che ha creato `createdCode` (il codice della task, l'id del
 * traguardo) — solo se chi guarda vede l'automazione; altrimenti solo che
 * l'ha creata un'automazione.
 */
export async function automationOrigin(
  ref: AutomationRef,
  createdCode: string,
): Promise<AutomationOrigin> {
  const me = await gate("automations.automationOrigin");
  const a = automationById(ref.automationId);
  const run = state.automationRuns.find((r) => r.id === ref.runId);
  if (!a || !run || run.automationId !== a.id || !canSeeAutomation(me, a))
    return { visible: false };
  const entry = run.log.find((e) => e.effects.some((x) => x.code === createdCode))?.path ?? null;
  return { visible: true, code: a.code, name: a.name, n: run.n, entry };
}
