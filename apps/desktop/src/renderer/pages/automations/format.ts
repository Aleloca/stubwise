import type { TFunction } from "i18next";
import { availableFields, stepAt, visitSteps } from "../../domain/automations/fields";
import type {
  AutomationFlow,
  AutomationRunRow,
  AutomationSourceView,
  AutomationTrigger,
  Condition,
  DataField,
  Operand,
  RunLogEntry,
  Step,
} from "../../data/types";
import { formatDate } from "../../notifications/time";

// Le parole delle Automations: l'inizio, i passi, le condizioni, la frase di
// «adesso» di un'esecuzione. Tutto da template i18n e dai dati della riga:
// nessuna frase scritta dal modello (shape automations.md §7), salvo la
// motivazione di Claude, che è sua e si mostra come tale.

/** I nomi che le frasi citano, risolti dalla pagina (persone, progetti, sorgenti, reparti). */
export interface Names {
  person(id: string | null | undefined): string;
  project(id: string | null | undefined): { code: string; name: string } | null;
  source(id: string): AutomationSourceView | undefined;
  department(id: string): string;
}

// --- l'inizio ---------------------------------------------------------------------

/** Il giorno della settimana di una RRULE (`MO`…), nella lingua di chi legge. */
function weekday(code: string, language: string): string | null {
  const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const i = days.indexOf(code);
  if (i < 0) return null;
  // Il 5 gennaio 2026 è un lunedì.
  return new Intl.DateTimeFormat(language, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 0, 5 + i)),
  );
}

/** «Every Monday at 9:00», «Every day at 8:30»; una regola che non so leggere: «On a schedule». */
export function scheduleWords(rule: string, t: TFunction, language: string): string {
  const parts = Object.fromEntries(
    rule.split(";").map((p) => p.split("=") as [string, string]),
  ) as Record<string, string | undefined>;
  const time = `${Number(parts.BYHOUR ?? 9)}:${String(Number(parts.BYMINUTE ?? 0)).padStart(2, "0")}`;
  if (parts.FREQ === "DAILY") return t("automations.trigger.daily", { time });
  if (parts.FREQ === "WEEKLY" && parts.BYDAY) {
    const day = weekday(parts.BYDAY.split(",")[0]!, language);
    if (day) return t("automations.trigger.weekly", { day, time });
  }
  if (parts.FREQ === "MONTHLY" && parts.BYMONTHDAY) {
    return t("automations.trigger.monthly", { day: parts.BYMONTHDAY, time });
  }
  return t("automations.trigger.schedule");
}

/** L'inizio in parole: «When a deal is won on Audin», «Every Monday at 9:00», «Started by hand». */
export function triggerWords(
  trigger: AutomationTrigger,
  names: Names,
  t: TFunction,
  language: string,
  projectId: string | null = null,
): string {
  switch (trigger.kind) {
    case "source": {
      const source = names.source(trigger.sourceId)?.name ?? t("automations.trigger.aSource");
      return trigger.event === "deal_won"
        ? t("automations.trigger.dealWon", { source })
        : t("automations.trigger.webhook", { source });
    }
    case "stubwise": {
      const code = names.project(projectId)?.code;
      const base = t(`automations.trigger.stubwise.${trigger.event}`);
      return code && trigger.event !== "mail_received"
        ? t("automations.trigger.inProject", { what: base, code })
        : base;
    }
    case "schedule":
      return scheduleWords(trigger.rule, t, language);
    case "manual":
      return t("automations.trigger.manual");
  }
}

/** L'inizio come complemento: «by a deal won on Audin», «on schedule», «by hand». */
export function startedByWords(trigger: AutomationTrigger, names: Names, t: TFunction): string {
  switch (trigger.kind) {
    case "source": {
      const source = names.source(trigger.sourceId)?.name ?? t("automations.trigger.aSource");
      return trigger.event === "deal_won"
        ? t("automations.startedBy.dealWon", { source })
        : t("automations.startedBy.webhook", { source });
    }
    case "stubwise":
      return t(`automations.startedBy.stubwise.${trigger.event}`);
    case "schedule":
      return t("automations.startedBy.schedule");
    case "manual":
      return t("automations.startedBy.manual");
  }
}

/**
 * I problemi di un'automazione (shape §5): quelli della versione pubblicata
 * (un'attiva o in pausa: le esecuzioni si fermeranno lì) e quelli della bozza
 * (mai accesa, o la versione successiva). `blocking` sono quelli che fermano
 * l'azione primaria: accendere una bozza o pubblicare → la bozza; riaccendere
 * una in pausa → la pubblicata. Elenco, «Needs attention», toast e dialoghi
 * leggono tutti da qui.
 */
export function problemsOf(a: {
  status: "draft" | "active" | "paused";
  hasDraft: boolean;
  configErrorCount: number;
  liveErrorCount: number;
}) {
  const live = a.status === "draft" ? 0 : a.liveErrorCount;
  const draft = a.status === "draft" || a.hasDraft ? a.configErrorCount : 0;
  const blocking = a.status === "paused" ? live : a.status === "draft" || a.hasDraft ? draft : 0;
  return { live, draft, total: live + draft, blocking };
}

/** Quanti passi ha un flusso, rami compresi. */
export function stepCount(flow: AutomationFlow): number {
  let n = 0;
  visitSteps(flow.steps, () => (n += 1));
  return n;
}

/** I passi che fanno qualcosa con un'email: chi accende deve avere una casella. */
export function sendsEmail(flow: AutomationFlow): boolean {
  let yes = false;
  visitSteps(flow.steps, (s) => {
    if (s.kind === "sendEmail") yes = true;
  });
  return yes;
}

// --- i dati e le loro etichette ------------------------------------------------------

/**
 * Le etichette di tutti i dati di un flusso (inizio, campi di Claude, elementi
 * dei cicli, risposte attese), per chiave: le frasi citano l'etichetta, mai
 * la chiave (che resta nel tooltip).
 */
export function fieldLabels(
  flow: AutomationFlow,
  sources: AutomationSourceView[],
): Map<string, DataField> {
  const out = new Map<string, DataField>();
  const add = (fs: DataField[]) => {
    for (const f of fs) if (!out.has(f.key)) out.set(f.key, f);
  };
  add(availableFields(flow, "", sources));
  visitSteps(flow.steps, (step, path) => {
    add(availableFields(flow, path, sources));
    if (step.kind === "claude") add(step.fields);
  });
  return out;
}

/** Un testo con `{{chiave}}` diviso in pezzi: testo e riferimenti (gettoni). */
export type TemplatePart = { text: string } | { ref: string; label: string };

export function templateParts(text: string, labels: Map<string, DataField>): TemplatePart[] {
  const out: TemplatePart[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    const ref = m[1]!;
    out.push({ ref, label: labels.get(ref)?.label ?? ref });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Il testo di un modello con le etichette al posto dei riferimenti (per i nomi accessibili). */
export const templatePlain = (text: string, labels: Map<string, DataField>) =>
  templateParts(text, labels)
    .map((p) => ("text" in p ? p.text : p.label))
    .join("");

function operandWords(o: Operand | undefined, labels: Map<string, DataField>, t: TFunction) {
  if (!o) return "";
  if ("ref" in o) return labels.get(o.ref)?.label ?? o.ref;
  if (o.value === true) return t("automations.condition.true");
  if (o.value === false) return t("automations.condition.false");
  return t("automations.condition.quoted", { value: String(o.value ?? "") });
}

/** Una condizione in parole: «Reparto is “Development”», gruppi con «and» / «or». */
export function conditionWords(c: Condition, labels: Map<string, DataField>, t: TFunction): string {
  if (c.all)
    return c.all.map((x) => conditionWords(x, labels, t)).join(t("automations.condition.and"));
  if (c.any)
    return c.any.map((x) => conditionWords(x, labels, t)).join(t("automations.condition.or"));
  const left = operandWords(c.left, labels, t);
  const right = operandWords(c.right, labels, t);
  return t(`automations.condition.op.${c.op ?? "is"}`, { left, right });
}

// --- i passi in parole («How it works») -------------------------------------------

function projectWords(step: Step, names: Names, t: TFunction): string | null {
  if (!("project" in step)) return null;
  const p = step.project;
  if (p.mode === "from_client") return t("automations.steps.inClientProject");
  if (p.mode === "fixed") {
    const prj = names.project(p.projectId);
    return prj
      ? t("automations.steps.inProject", { code: prj.code })
      : t("automations.steps.inHiddenProject");
  }
  return null;
}

function assigneeWords(
  a: Extract<Step, { kind: "createTask" }>["assignee"],
  names: Names,
  t: TFunction,
): string {
  if (a === null) return t("automations.steps.unassigned");
  if ("personId" in a) return t("automations.steps.forPerson", { name: names.person(a.personId) });
  if ("departmentId" in a) {
    return t("automations.steps.forDepartment", { name: names.department(a.departmentId) });
  }
  return t("automations.steps.forRole", {
    role: t(`automations.roles.${a.projectRole}`, a.projectRole),
  });
}

/**
 * La frase di un passo, con i riferimenti come `{{chiave}}` (la UI li rende
 * gettoni) e i dettagli dopo un « · ».
 */
export function stepSentence(
  step: Step,
  flow: AutomationFlow,
  names: Names,
  labels: Map<string, DataField>,
  t: TFunction,
  automationCode: (id: string) => string | null,
): { text: string; details: string[] } {
  const details: string[] = [];
  const project = projectWords(step, names, t);
  switch (step.kind) {
    case "createTask":
      details.push(assigneeWords(step.assignee, names, t));
      if (step.dueInDays !== null)
        details.push(t("automations.steps.dueIn", { count: step.dueInDays }));
      if (project) details.push(project);
      return { text: t("automations.steps.createTask", { title: step.title }), details };
    case "createMilestone":
      if (step.dueInDays !== null)
        details.push(t("automations.steps.dueIn", { count: step.dueInDays }));
      if (project) details.push(project);
      return { text: t("automations.steps.createMilestone", { name: step.name }), details };
    case "createRequest":
      if (project) details.push(project);
      return { text: t("automations.steps.createRequest", { title: step.title }), details };
    case "sendEmail":
      return {
        text: t("automations.steps.sendEmail", { subject: step.subject, to: step.to }),
        details,
      };
    case "notify":
      return {
        text: t("automations.steps.notify", {
          // La chiave di un dato si legge come gettone, come un modello `{{…}}`.
          who:
            step.personRef && !step.personRef.includes("{{")
              ? `{{${step.personRef}}}`
              : step.personRef,
          text: step.text,
        }),
        details,
      };
    case "startAutomation":
      return {
        text: t("automations.steps.startAutomation", {
          code: automationCode(step.automationId) ?? t("automations.steps.anAutomation"),
        }),
        details,
      };
    case "wait": {
      const f = step.for;
      if ("days" in f) return { text: t("automations.steps.waitDays", { count: f.days }), details };
      if ("replyTo" in f) {
        const target = findStep(flow, f.replyTo);
        const subject = target?.kind === "sendEmail" ? target.subject : "";
        details.push(t("automations.steps.upTo", { count: f.maxDays }));
        return { text: t("automations.steps.waitReply", { subject }), details };
      }
      details.push(t("automations.steps.upTo", { count: f.maxDays }));
      return { text: t("automations.steps.waitTask"), details };
    }
    case "claude":
      return { text: t("automations.steps.claude", { instruction: step.instruction }), details };
    case "condition":
      return {
        text: t("automations.steps.condition", { when: conditionWords(step.when, labels, t) }),
        details,
      };
    case "forEach":
      return {
        text: t("automations.steps.forEach", { list: labels.get(step.list)?.label ?? step.list }),
        details,
      };
    case "repeatUntil":
      return {
        text: t("automations.steps.repeatUntil", {
          until: conditionWords(step.until, labels, t),
          count: step.max,
        }),
        details,
      };
  }
}

/** Un passo per id, in tutto l'albero. */
export function findStep(flow: AutomationFlow, id: string): Step | null {
  let found: Step | null = null;
  visitSteps(flow.steps, (s) => {
    if (s.id === id) found = s;
  });
  return found;
}

/** «Step 4 · Send email “Welcome”»: dove sta un problema, in parole (mai il percorso). */
export function positionWords(flow: AutomationFlow, path: string, t: TFunction): string {
  if (path === "trigger" || path === "") return t("automations.problems.atStart");
  const number = displayNumber(path);
  const step = stepAt(flow.steps, path.replace(/\[\d+\]/g, "[0]"));
  const name = step ? t(`automations.kind.${step.kind}`) : "";
  return t("automations.problems.at", { number, name });
}

/**
 * Il numero di un passo nel riassunto: «4», «2.1», «3.1.2». I rami e i giri
 * non contano come livello numerato, i passi annidati sì.
 */
export function displayNumber(path: string): string {
  return path
    .split("/")
    .filter((s) => /^\d+$/.test(s))
    .map((s) => String(Number(s) + 1))
    .join(".");
}

// --- esecuzioni ---------------------------------------------------------------------

const DAY = 86_400_000;

/** I giorni interi fra due istanti (almeno 0). */
export const daysBetween = (from: string, to: string) =>
  Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / DAY));

/** Le cose create da un'esecuzione, per tipo: «6 tasks, 1 milestone, 2 emails». */
export function createdSummary(log: RunLogEntry[], t: TFunction): string {
  const counts = new Map<string, number>();
  for (const e of log) {
    if (e.outcome !== "ok") continue;
    for (const x of e.effects) counts.set(x.kind, (counts.get(x.kind) ?? 0) + 1);
  }
  return ["task", "milestone", "request", "email", "notification", "run"]
    .filter((k) => counts.has(k))
    .map((k) => t(`automations.created.${k}`, { count: counts.get(k)! }))
    .join(", ");
}

/** La parola di un codice d'errore (`permission_lost` → «permission lost»). */
export function errorWords(code: string | null, t: TFunction): string {
  return t(`automations.errors.${code ?? "other"}`, {
    defaultValue: t("automations.errors.other"),
  });
}

/** Il cliente dell'evento, se l'evento lo porta. */
export function clientOf(event: Record<string, unknown>): string | null {
  const c = event.cliente as { nome?: unknown } | undefined;
  return typeof c?.nome === "string" && c.nome ? c.nome : null;
}

/** L'ultima riga di un passo nel registro. */
const lastAt = (log: RunLogEntry[], path: string | null) =>
  path === null ? undefined : [...log].reverse().find((e) => e.path === path);

/**
 * La frase di adesso di un'esecuzione (shape §5): «Waiting for Rossi Srl to
 * reply · 3 days», «Matteo Conti must approve an email», «Failed at “Create
 * task”: permission lost», «Finished in 2 days · 6 tasks…».
 */
export function nowPhrase(run: AutomationRunRow, names: Names, t: TFunction, now: string): string {
  const step = lastAt(run.log, run.cursor);
  const kind = step?.kind && step.kind !== "trigger" ? step.kind : null;
  switch (run.status) {
    case "running":
      return t("automations.now.running");
    case "waiting_approval": {
      const who = (run.pending?.approverIds ?? []).map((id) => names.person(id));
      const what = t(`automations.approvalOf.${kind ?? "other"}`, {
        defaultValue: t("automations.approvalOf.other"),
      });
      return who.length > 0
        ? t("automations.now.mustApprove", { who: who.join(", "), what })
        : t("automations.now.approval", { what });
    }
    case "waiting_project": {
      const owner = names.person(run.pending?.approverIds[0]);
      const client =
        (run.pending?.preview.clientName as string | undefined) ?? clientOf(run.event) ?? "";
      return t("automations.now.mustChoose", { who: owner, client });
    }
    case "waiting_event": {
      const since = step?.at ?? run.startedAt;
      const days = daysBetween(since, now);
      const wait = step?.input as { replyTo?: string; days?: number; taskClosed?: string };
      if (wait?.replyTo) {
        const client = clientOf(run.event);
        return client
          ? t("automations.now.waitingReplyFrom", { client, count: days })
          : t("automations.now.waitingReply", { count: days });
      }
      if (wait?.taskClosed) return t("automations.now.waitingTask", { count: days });
      return t("automations.now.waitingTime", { count: days });
    }
    case "suspended":
      return t("automations.now.suspended", { code: run.automationCode });
    case "failed": {
      const failed = [...run.log].reverse().find((e) => e.outcome === "failed");
      const name =
        failed?.kind && failed.kind !== "trigger" ? t(`automations.kind.${failed.kind}`) : "";
      return name
        ? t("automations.now.failedAt", { step: name, error: errorWords(run.error, t) })
        : t("automations.now.failed", { error: errorWords(run.error, t) });
    }
    case "done": {
      const days = daysBetween(run.startedAt, run.endedAt ?? now);
      const created = createdSummary(run.log, t);
      const took =
        days === 0 ? t("automations.now.doneToday") : t("automations.now.doneIn", { count: days });
      return created ? `${took} · ${created}` : took;
    }
    case "cancelled": {
      const by = [...run.log]
        .reverse()
        .find((e) => e.outcome === "cancelled" || e.outcome === "rejected");
      if (run.error === "rejected" && by?.byId) {
        return t("automations.now.rejectedBy", { who: names.person(by.byId) });
      }
      return by?.byId
        ? t("automations.now.cancelledBy", { who: names.person(by.byId) })
        : t("automations.now.cancelled");
    }
  }
}

/** La data breve di un istante («Oct 23»). */
export const shortDate = (iso: string, language: string) => formatDate(iso, language);

/** L'ora «09:12» di un istante (UTC, come il resto del prototipo). */
export function clock(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Un'esecuzione finita (le fallite restano «da sistemare» finché qualcuno non agisce). */
export const isFinished = (status: string) => TERMINAL.has(status);
