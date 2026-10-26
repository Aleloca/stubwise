import type { TFunction } from "i18next";
import { show } from "../../../domain/automations/preview";
import type { SimulationView, Step } from "../../../data/types";
import type { TestState } from "./context";
import { entriesUnder, lastEntry, type Mark } from "./marks";

// Le parole della prova: l'esito breve di una riga («would create a task
// in CBV», «Claude: Tasks found»), il titolo e l'esito di un giro, il
// riepilogo «So far». Tutto al condizionale (shape automation-test §7).

type T = TFunction | ((k: string, o?: Record<string, unknown>) => string);

const under = (path: string, p: string) => p === path || p.startsWith(`${path}/`);

/** L'elemento di un giro di un «Per ogni» in parole (il suo titolo, o il suo nome). */
export function roundTitle(ctx: TestState, blockPath: string, round: number): string {
  const item = ctx.sim?.loopItems?.[blockPath]?.[round];
  if (item === undefined) return "";
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const named = o.titolo ?? o.nome ?? o.title ?? o.name;
    if (named !== undefined) return show(named);
    return (
      Object.values(o)
        .map(show)
        .find((s) => s !== "") ?? ""
    );
  }
  return show(item);
}

/** Cosa farebbe un giro, in parole («would create 1 task», «failed»). */
export function roundOutcome(
  ctx: TestState,
  blockPath: string,
  seg: "forEach" | "repeat",
  round: number,
  t: T,
): string {
  const sim = ctx.sim;
  if (!sim || !ctx.ix) return "";
  const prefix = `${blockPath}/${seg}[${round}]`;
  const tasks = sim.preview.tasks.filter((x) => under(prefix, x.path)).length;
  const emails = sim.preview.emails.filter((x) => under(prefix, x.path)).length;
  const entries = entriesUnder(ctx.ix, prefix);
  if (entries.some((e) => e.outcome === "failed")) return t("automations.test.mark.failed");
  const parts = [
    tasks > 0 ? t("automations.test.summary.tasksOnly", { count: tasks }) : null,
    emails > 0 ? t("automations.test.summary.emails", { count: emails }) : null,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  if (entries.length === 0) return t("automations.test.mark.pending");
  return t("automations.test.mark.done");
}

/** L'esito breve accanto a una riga (12px, a destra). */
export function rowOutcome(
  ctx: TestState,
  step: Step,
  path: string,
  mark: Mark,
  t: T,
): string | null {
  const sim = ctx.sim;
  if (!sim || !ctx.ix) return null;
  if (mark === "failed") return t("automations.test.row.wouldFail");
  if (mark === "skipped") return t("automations.test.row.skipped");
  if (mark === "rejected") return t("automations.test.mark.rejected");
  if (mark === "stopped") {
    const w = sim.waiting;
    if (w?.kind === "approval") return t("automations.test.row.stoppedApproval");
    if (w?.kind === "project") return t("automations.test.row.stoppedProject");
    return t("automations.test.row.stoppedEvent");
  }
  if (mark !== "done") return null;
  const last = lastEntry(ctx.ix, path);
  const entries = ctx.ix.byPath.get(path) ?? [];
  const approved = entries.some((e) => e.outcome === "approved");
  const asked = "approval" in step && step.approval.mode === "ask";
  const tail = approved
    ? ` · ${t(asked ? "automations.test.row.approved" : "automations.test.row.projectChosen")}`
    : "";
  const at = (list: { path: string }[]) => list.find((x) => x.path === path);
  switch (step.kind) {
    case "createTask": {
      const p = at(sim.preview.tasks) as SimulationView["preview"]["tasks"][number] | undefined;
      return (
        (p?.project.code
          ? t("automations.test.row.task", { code: p.project.code })
          : t("automations.test.row.taskAny")) + tail
      );
    }
    case "createMilestone":
      return t("automations.test.row.milestone") + tail;
    case "createRequest":
      return t("automations.test.row.request") + tail;
    case "sendEmail":
      return t("automations.test.row.email") + tail;
    case "notify": {
      const p = sim.preview.notifications.find((x) => x.path === path);
      return t("automations.test.row.notify", { name: ctx.names.person(p?.personId) }) + tail;
    }
    case "startAutomation": {
      const p = sim.preview.starts.find((x) => x.path === path);
      return (
        (p?.code
          ? t("automations.test.row.start", { code: p.code })
          : t("automations.test.row.startAny")) + tail
      );
    }
    case "claude": {
      const out = last?.output.uscita;
      return typeof out === "string"
        ? t("automations.test.row.claude", { outcome: out })
        : t("automations.test.row.claudeFields");
    }
    case "condition":
      return last?.output.ramo === "then"
        ? t("automations.test.row.if")
        : t("automations.test.row.otherwise");
    case "forEach": {
      const n = Number(last?.output.giri ?? 0);
      return n > 0
        ? t("automations.test.row.rounds", { count: n })
        : t("automations.test.row.noRounds");
    }
    case "repeatUntil": {
      const n = Number(last?.output.giri ?? 0);
      if (entries.some((e) => e.outcome === "limit"))
        return t("automations.test.row.limit", { count: n });
      return t("automations.test.row.rounds", { count: n });
    }
    case "wait": {
      const out = last?.output ?? {};
      if (out["risposta.arrivata"] === true) return t("automations.test.row.reply");
      if (out["risposta.arrivata"] === false) return t("automations.test.row.noReply");
      if (out.chiusa === true) return t("automations.test.row.closed");
      const w = step.for;
      const days = "days" in w ? w.days : w.maxDays;
      return t("automations.test.row.waited", { count: days });
    }
  }
}

/** «would create 1 milestone, 3 tasks · would send 1 email»; vuoto se niente. */
export function soFarParts(sim: SimulationView, t: T): string[] {
  const p = sim.preview;
  const out: string[] = [];
  const created: string[] = [];
  if (p.milestones.length > 0)
    created.push(t("automations.test.summary.milestones", { count: p.milestones.length }));
  if (p.tasks.length > 0)
    created.push(
      created.length > 0
        ? t("automations.test.summary.tasks", { count: p.tasks.length })
        : t("automations.test.summary.tasksOnly", { count: p.tasks.length }),
    );
  if (p.requests.length > 0)
    created.push(
      created.length > 0
        ? t("automations.test.summary.requests", { count: p.requests.length })
        : t("automations.test.summary.requestsOnly", { count: p.requests.length }),
    );
  if (created.length > 0) out.push(created.join(", "));
  if (p.emails.length > 0)
    out.push(t("automations.test.summary.emails", { count: p.emails.length }));
  if (p.notifications.length > 0)
    out.push(t("automations.test.summary.notifications", { count: p.notifications.length }));
  if (p.starts.length > 0)
    out.push(t("automations.test.summary.starts", { count: p.starts.length }));
  return out;
}
