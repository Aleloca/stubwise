import type { Step } from "../../data/types";
import { conditionRefs, evaluate } from "./conditions";
import type { EffectRequest, EngineState, LogRow, ResolvedTarget } from "./engine";
import { AUTOMATION_LIMITS, joinPath, listAt, repeatCap, stepAt } from "./fields";
import { approverReason, describe, projectOf, resolve, show, type ActionStep } from "./preview";

// Il ciclo del motore (vedi `engine.ts`): entrare in un passo, eseguire
// finché si può. Gli input stanno in `engineInputs.ts`.

const DAY = 86_400_000;
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY).toISOString().replace(".000Z", "Z");
export const reached = (now: string, until: string) => Date.parse(now) >= Date.parse(until);

export const EFFECT_KIND: Record<ActionStep["kind"], string> = {
  createTask: "task",
  createMilestone: "milestone",
  createRequest: "request",
  sendEmail: "email",
  notify: "notification",
  startAutomation: "run",
};

export interface Ctx {
  st: EngineState;
  effects: EffectRequest[];
  log: LogRow[];
}

export function row(
  e: Pick<LogRow, "stepId" | "path" | "kind" | "outcome"> & Partial<LogRow>,
): LogRow {
  return { input: {}, output: {}, reason: null, byId: null, effects: [], ...e };
}

// --- il ciclo ---------------------------------------------------------------------

export function fail(c: Ctx, error: string) {
  c.st.status = "failed";
  c.st.error = error;
  c.st.awaiting = null;
  c.st.waitingUntil = null;
}

/** R-J9: oltre il tetto di effetti per esecuzione il passo è un limite e l'esecuzione si ferma. */
function overCap(c: Ctx, step: Step, path: string, input: Record<string, unknown>): boolean {
  if (c.st.effectsSent < AUTOMATION_LIMITS.effectsPerRun) {
    c.st.effectsSent++;
    return false;
  }
  c.log.push(
    row({
      stepId: step.id,
      path,
      kind: step.kind,
      outcome: "limit",
      input,
      reason: `Limite raggiunto: al massimo ${AUTOMATION_LIMITS.effectsPerRun} azioni per esecuzione.`,
    }),
  );
  fail(c, "effect_limit");
  return true;
}

/** Un passo d'azione: progetto, poi approvazione, poi l'effetto. */
export function proceedAction(
  c: Ctx,
  step: ActionStep,
  path: string,
  approval: { edited?: Record<string, string> } | null,
) {
  const st = c.st;
  const target = projectOf(step);
  let resolved: ResolvedTarget | null = null;
  if (target?.mode === "from_client") {
    const clientKey = show(resolve(st, target.clientRef));
    const projectId = st.projects[clientKey];
    if (projectId === undefined) {
      st.awaiting = { kind: "project", path, clientKey, asked: false };
      c.effects.push({
        kind: "resolve_project",
        stepId: step.id,
        path,
        clientRef: target.clientRef,
        clientKey,
      });
      return;
    }
    resolved = { mode: "fixed", projectId };
  } else if (target) resolved = target;

  const { preview, args } = describe(st, step, resolved, approval?.edited);
  if (step.approval.mode === "ask" && !approval) {
    st.status = "waiting_approval";
    // La riga del registro ha la SUA copia dell'anteprima: nascondere una non tocca l'altra (R-J14/R-J16).
    st.awaiting = { kind: "approval", path, who: step.approval.who, preview };
    c.log.push(
      row({
        stepId: step.id,
        path,
        kind: step.kind,
        outcome: "waiting",
        input: structuredClone(preview),
        reason: approverReason(step.approval.who),
      }),
    );
    return;
  }
  if (overCap(c, step, path, preview)) return;
  if (step.kind === "sendEmail") {
    if (st.emailsSent >= AUTOMATION_LIMITS.emailsPerRun) {
      c.log.push(
        row({
          stepId: step.id,
          path,
          kind: step.kind,
          outcome: "limit",
          input: structuredClone(preview),
          reason: `Limite raggiunto: al massimo ${AUTOMATION_LIMITS.emailsPerRun} email per esecuzione.`,
        }),
      );
      return fail(c, "email_limit");
    }
    st.emailsSent++;
  }
  st.status = "running";
  st.awaiting = { kind: "effect", path, preview };
  c.effects.push({
    kind: step.kind,
    stepId: step.id,
    path,
    args,
    ...(resolved ? { projectTarget: resolved } : {}),
  });
}

function enterStep(c: Ctx, step: Step, path: string) {
  const st = c.st;
  st.cursor = path;
  switch (step.kind) {
    case "condition": {
      const yes = evaluate(step.when, (k) => resolve(st, k));
      const input = Object.fromEntries(conditionRefs(step.when).map((k) => [k, resolve(st, k)]));
      c.log.push(
        row({
          stepId: step.id,
          path,
          kind: "condition",
          outcome: "ok",
          input,
          output: { ramo: yes ? "then" : "else" },
        }),
      );
      st.stack.push({ t: "list", base: joinPath(path, yes ? "then" : "else"), i: 0 });
      return;
    }
    case "forEach": {
      const items = resolve(st, step.list);
      if (!Array.isArray(items)) {
        c.log.push(
          row({
            stepId: step.id,
            path,
            kind: "forEach",
            outcome: "failed",
            input: { list: step.list },
            reason: `«${step.list}» non è un elenco.`,
          }),
        );
        return fail(c, "bad_list");
      }
      if (items.length > AUTOMATION_LIMITS.forEachRounds) {
        c.log.push(
          row({
            stepId: step.id,
            path,
            kind: "forEach",
            outcome: "limit",
            input: { list: step.list },
            output: { elementi: items.length },
            reason: `Limite raggiunto: al massimo ${AUTOMATION_LIMITS.forEachRounds} giri.`,
          }),
        );
        return fail(c, "limit");
      }
      st.loops[path] = items;
      st.stack.push({ t: "forEach", path, as: step.as, items, current: -1 });
      return;
    }
    case "repeatUntil":
      st.stack.push({ t: "repeat", path, round: 0, onLimit: false });
      return;
    case "claude": {
      const input = Object.fromEntries(step.inputs.map((k) => [k, resolve(st, k)]));
      if (overCap(c, step, path, input)) return;
      st.awaiting = { kind: "claude", path, input };
      c.effects.push({ kind: "claude", stepId: step.id, path, step, vars: input });
      return;
    }
    case "wait": {
      const w = step.for;
      const days = "days" in w ? w.days : w.maxDays;
      const until = addDays(st.now, days);
      st.status = "waiting_event";
      st.awaiting = { kind: "wait", path, until };
      st.waitingUntil = until;
      c.log.push(row({ stepId: step.id, path, kind: "wait", outcome: "waiting", input: { ...w } }));
      return;
    }
    default:
      return proceedAction(c, step, path, null);
  }
}

/** Esegue finché può: si ferma su un'attesa, un effetto da eseguire, la fine o un errore. */
export function run(c: Ctx) {
  const st = c.st;
  while (st.status === "running" && st.awaiting === null) {
    const top = st.stack.at(-1);
    if (!top) {
      st.status = "done";
      st.cursor = null;
      st.waitingUntil = null;
      return;
    }
    if (top.t === "list") {
      const list = listAt(st.flow.steps, top.base) ?? [];
      if (top.i >= list.length) {
        st.stack.pop();
        continue;
      }
      const path = joinPath(top.base, String(top.i));
      const step = list[top.i]!;
      top.i++;
      enterStep(c, step, path);
    } else if (top.t === "forEach") {
      const step = stepAt(st.flow.steps, top.path)! as Extract<Step, { kind: "forEach" }>;
      if (top.current + 1 < top.items.length) {
        top.current++;
        st.stack.push({ t: "list", base: joinPath(top.path, `forEach[${top.current}]`), i: 0 });
      } else {
        st.stack.pop();
        delete st.loops[top.path];
        st.cursor = top.path;
        c.log.push(
          row({
            stepId: step.id,
            path: top.path,
            kind: "forEach",
            outcome: "ok",
            input: { list: step.list },
            output: { giri: top.items.length },
          }),
        );
      }
    } else {
      const step = stepAt(st.flow.steps, top.path)! as Extract<Step, { kind: "repeatUntil" }>;
      if (top.onLimit) {
        st.stack.pop();
        continue;
      }
      st.cursor = top.path;
      const base = { stepId: step.id, path: top.path, kind: "repeatUntil" as const };
      const input = Object.fromEntries(conditionRefs(step.until).map((k) => [k, resolve(st, k)]));
      const max = repeatCap(step.max);
      // R-J4: la condizione si controlla prima di ogni giro.
      if (evaluate(step.until, (k) => resolve(st, k))) {
        st.stack.pop();
        c.log.push(
          row({
            ...base,
            outcome: top.round === 0 ? "skipped" : "ok",
            input,
            output: { giri: top.round },
            reason: top.round === 0 ? "La condizione è già vera: nessun giro." : null,
          }),
        );
      } else if (top.round >= max) {
        top.onLimit = true;
        c.log.push(
          row({
            ...base,
            outcome: "limit",
            input,
            output: { giri: top.round },
            reason: `Limite raggiunto: ${max} giri.`,
          }),
        );
        st.stack.push({ t: "list", base: joinPath(top.path, "onLimit"), i: 0 });
      } else {
        st.stack.push({ t: "list", base: joinPath(top.path, `repeat[${top.round}]`), i: 0 });
        top.round++;
      }
    }
  }
}
