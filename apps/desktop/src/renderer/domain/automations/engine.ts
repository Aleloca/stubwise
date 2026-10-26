import type {
  Approval,
  AutomationFlow,
  AutomationRun,
  ProjectTarget,
  RunLogEntry,
  RunStatus,
  Step,
} from "../../data/types";
import { checkClaudeResult } from "./claudeStep";
import { conditionRefs, evaluate, lookup } from "./conditions";
import { AUTOMATION_LIMITS, joinPath, listAt, stepAt } from "./fields";

// Il motore delle automazioni: puro. `advance` prende lo stato e un input
// (l'evento d'inizio, un'approvazione, il tempo che passa, l'esito di un
// effetto…) e restituisce lo stato nuovo, gli effetti da eseguire e le righe
// del registro (senza `at`: la data la mette chi registra). Non esegue
// niente: le azioni le fa un esecutore (Task 3), e il loro esito rientra
// come input. Il tempo arriva solo dagli input, mai dall'orologio.
//
// Le tre regole dell'anti-obiettivo stanno qui:
// 1. un passo con `approval.mode = "ask"` porta lo stato in
//    `waiting_approval` senza effetti, e solo `approved` lo sblocca: ogni
//    altro input in quello stato è ignorato (nessun effetto, nessuna riga);
// 2. il risultato di Claude passa da `checkClaudeResult`: uscita o campi
//    fuori dal dichiarato fanno fallire il passo, e la motivazione non è mai
//    interpretata;
// 3. ogni passo eseguito scrive una riga, con dati, esito, motivazione e
//    chi ha approvato.
// Un input che lo stato non aspetta è ignorato allo stesso modo.

type ActionStep = Extract<Step, { approval: Approval }>;
type ClaudeStep = Extract<Step, { kind: "claude" }>;
type WaitStep = Extract<Step, { kind: "wait" }>;
export type ActionKind = ActionStep["kind"];

/** Cosa può arrivare a un'attesa: la risposta a un'email (per id del passo), una task chiusa. */
export type EnginePayload =
  | { kind: "reply"; to: string; text: string }
  | { kind: "task_closed"; taskStepId: string };

export type EngineInput =
  | { kind: "start"; event: Record<string, unknown> }
  | { kind: "approved"; byId: string; edited?: Record<string, string> }
  | { kind: "rejected"; byId: string }
  | { kind: "event"; payload: EnginePayload }
  | { kind: "time"; now: string }
  | { kind: "project_chosen"; projectId: string; byId?: string }
  | { kind: "effect_result"; ok: boolean; codes?: string[]; error?: string; reason?: string }
  | { kind: "claude_result"; outcome?: string; fields?: Record<string, unknown>; reason: string };

/** Il progetto in cui agisce un effetto: quello dell'automazione, o uno risolto. */
export type ResolvedTarget = { mode: "own" } | { mode: "fixed"; projectId: string };

export type EffectRequest =
  | {
      kind: ActionKind;
      stepId: string;
      path: string;
      args: Record<string, unknown>;
      projectTarget?: ResolvedTarget;
    }
  | {
      kind: "claude";
      stepId: string;
      path: string;
      step: ClaudeStep;
      vars: Record<string, unknown>;
    }
  /** Trova il progetto dal cliente (tabella cliente → progetto); risponde `project_chosen`, o `effect_result` con `ok: false` se non lo trova. */
  | { kind: "resolve_project"; stepId: string; path: string; clientRef: string; clientKey: string };

/** L'errore di `effect_result` che porta in «scegli il progetto». */
export const PROJECT_NOT_FOUND = "project_not_found";

type Frame =
  /** Una lista di passi; `i` è il prossimo da eseguire. */
  | { t: "list"; base: string; i: number }
  /** Un `forEach`: gli elementi fissati all'ingresso, il giro corrente (-1 prima del primo). */
  | { t: "forEach"; path: string; as: string; items: unknown[]; current: number }
  /** Un `repeatUntil`: i giri fatti, e se si sta eseguendo `onLimit`. */
  | { t: "repeat"; path: string; round: number; onLimit: boolean };

/** Cosa aspetta l'esecuzione, al passo del cursore. */
export type Awaiting =
  /** `asked`: il progetto non è stato trovato e lo sceglie il proprietario (`waiting_project`). */
  | { kind: "project"; path: string; clientKey: string; asked: boolean }
  | {
      kind: "approval";
      path: string;
      who: Extract<Approval, { mode: "ask" }>["who"];
      preview: Record<string, unknown>;
    }
  | { kind: "effect"; path: string; preview: Record<string, unknown> }
  | { kind: "claude"; path: string; input: Record<string, unknown> }
  | { kind: "wait"; path: string; until: string };

export interface EngineState {
  flow: AutomationFlow;
  status: RunStatus;
  started: boolean;
  event: Record<string, unknown>;
  /** Le variabili scritte dai passi (chiavi piatte, es. "analisi.task"). */
  vars: Record<string, unknown>;
  /** L'ultima ora nota (dall'inizio o da un input `time`). */
  now: string;
  stack: Frame[];
  /** Il percorso (R-J5) del passo corrente. */
  cursor: string | null;
  awaiting: Awaiting | null;
  waitingUntil: string | null;
  /** Cliente → progetto, risolti in questa esecuzione. */
  projects: Record<string, string>;
  /** I codici creati da ogni passo (per `milestoneRef`). */
  created: Record<string, string[]>;
  emailsSent: number;
  /** Un codice macchina (`permission_lost`, `unknown_outcome`, `limit`…). */
  error: string | null;
}

export type LogRow = Omit<RunLogEntry, "at">;

export interface EngineStep {
  state: EngineState;
  effects: EffectRequest[];
  log: LogRow[];
}

const DAY = 86_400_000;
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY).toISOString().replace(".000Z", "Z");
const reached = (now: string, until: string) => Date.parse(now) >= Date.parse(until);

const EFFECT_KIND: Record<ActionKind, string> = {
  createTask: "task",
  createMilestone: "milestone",
  createRequest: "request",
  sendEmail: "email",
  notify: "notification",
  startAutomation: "run",
};

/** Uno stato nuovo, prima dell'inizio: lo avvia l'input `start`. */
export function initialState(flow: AutomationFlow, now: string): EngineState {
  return {
    flow,
    status: "running",
    started: false,
    event: {},
    vars: {},
    now,
    stack: [],
    cursor: null,
    awaiting: null,
    waitingUntil: null,
    projects: {},
    created: {},
    emailsSent: 0,
    error: null,
  };
}

interface Ctx {
  st: EngineState;
  effects: EffectRequest[];
  log: LogRow[];
}

function row(e: Pick<LogRow, "stepId" | "path" | "kind" | "outcome"> & Partial<LogRow>): LogRow {
  return { input: {}, output: {}, reason: null, byId: null, effects: [], ...e };
}

// --- dati e testi ---------------------------------------------------------------

/** Il valore di una chiave: la variabile di un `forEach` (dal più interno), le variabili, l'evento. */
function resolve(st: EngineState, key: string): unknown {
  for (let k = st.stack.length - 1; k >= 0; k--) {
    const f = st.stack[k]!;
    if (f.t !== "forEach" || f.current < 0) continue;
    const item = f.items[f.current];
    if (key === f.as) return item;
    if (key.startsWith(`${f.as}.`)) {
      return item !== null && typeof item === "object"
        ? lookup(item as Record<string, unknown>, key.slice(f.as.length + 1))
        : undefined;
    }
  }
  if (Object.prototype.hasOwnProperty.call(st.vars, key)) return st.vars[key];
  return lookup(st.event, key);
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(show).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return show(o.nome ?? o.titolo ?? o.name ?? "");
  }
  return String(v);
}

const render = (st: EngineState, text: string) =>
  text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => show(resolve(st, key)));

/** L'anteprima (cosa vede chi approva, l'input della riga) e gli argomenti dell'effetto. */
function describe(
  st: EngineState,
  step: ActionStep,
  target: ResolvedTarget | null,
  edited: Record<string, string> = {},
) {
  const progetto = target?.mode === "fixed" ? { progetto: target.projectId } : {};
  const pick = (key: string, value: string) => edited[key] ?? value;
  switch (step.kind) {
    case "createTask": {
      const titolo = pick("titolo", render(st, step.title));
      const descrizione = pick("descrizione", render(st, step.description));
      const ms = step.milestoneRef ? (st.created[step.milestoneRef]?.at(-1) ?? null) : null;
      return {
        preview: { titolo, descrizione, ...progetto },
        args: {
          title: titolo,
          description: descrizione,
          assignee: step.assignee,
          dueInDays: step.dueInDays,
          milestoneCode: ms,
        },
      };
    }
    case "createMilestone": {
      const nome = pick("nome", render(st, step.name));
      return { preview: { nome, ...progetto }, args: { name: nome, dueInDays: step.dueInDays } };
    }
    case "createRequest": {
      const titolo = pick("titolo", render(st, step.title));
      const descrizione = pick("descrizione", render(st, step.description));
      return {
        preview: { titolo, descrizione, ...progetto },
        args: { title: titolo, description: descrizione },
      };
    }
    case "sendEmail": {
      const to = pick("to", render(st, step.to));
      const subject = pick("subject", render(st, step.subject));
      const body = pick("body", render(st, step.body));
      const attachments = step.attachRefs.map((r) => resolve(st, r));
      return {
        preview: {
          to,
          subject,
          body,
          ...(attachments.length ? { allegati: attachments.map(show) } : {}),
        },
        args: { to, subject, body, attachments },
      };
    }
    case "notify": {
      const ref = step.personRef.includes("{{") ? render(st, step.personRef) : step.personRef;
      const person = resolve(st, ref);
      const personId = typeof person === "string" && person !== "" ? person : ref;
      const testo = pick("testo", render(st, step.text));
      return { preview: { persona: personId, testo }, args: { personId, text: testo } };
    }
    case "startAutomation":
      return {
        preview: { automazione: step.automationId },
        args: { automationId: step.automationId },
      };
  }
}

const APPROVER: (who: Extract<Approval, { mode: "ask" }>["who"]) => string = (who) =>
  "owner" in who
    ? "Chiede l'approvazione del proprietario."
    : "personId" in who
      ? "Chiede l'approvazione della persona indicata."
      : `Chiede l'approvazione del ruolo «${who.projectRole}» nel progetto.`;

// --- il ciclo ---------------------------------------------------------------------

function fail(c: Ctx, error: string) {
  c.st.status = "failed";
  c.st.error = error;
  c.st.awaiting = null;
  c.st.waitingUntil = null;
}

const projectOf = (step: Step): ProjectTarget | null =>
  step.kind === "createTask" || step.kind === "createMilestone" || step.kind === "createRequest"
    ? step.project
    : null;

/** Un passo d'azione: progetto, poi approvazione, poi l'effetto. */
function proceedAction(
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
    st.awaiting = { kind: "approval", path, who: step.approval.who, preview };
    c.log.push(
      row({
        stepId: step.id,
        path,
        kind: step.kind,
        outcome: "waiting",
        input: preview,
        reason: APPROVER(step.approval.who),
      }),
    );
    return;
  }
  if (step.kind === "sendEmail") {
    if (st.emailsSent >= AUTOMATION_LIMITS.emailsPerRun) {
      c.log.push(
        row({
          stepId: step.id,
          path,
          kind: step.kind,
          outcome: "limit",
          input: preview,
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
      st.stack.push({ t: "forEach", path, as: step.as, items, current: -1 });
      return;
    }
    case "repeatUntil":
      st.stack.push({ t: "repeat", path, round: 0, onLimit: false });
      return;
    case "claude": {
      const input = Object.fromEntries(step.inputs.map((k) => [k, resolve(st, k)]));
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
function run(c: Ctx) {
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
      const max = Math.min(step.max, AUTOMATION_LIMITS.repeatMax);
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

// --- gli input --------------------------------------------------------------------

const currentStep = (st: EngineState) =>
  st.cursor === null ? null : stepAt(st.flow.steps, st.cursor);

function finishWait(
  c: Ctx,
  step: WaitStep,
  path: string,
  output: Record<string, unknown>,
  reason: string | null,
) {
  const st = c.st;
  Object.assign(
    st.vars,
    Object.fromEntries(Object.entries(output).filter(([k]) => k.startsWith("risposta."))),
  );
  c.log.push(
    row({
      stepId: step.id,
      path,
      kind: "wait",
      outcome: "ok",
      input: { ...step.for },
      output,
      reason,
    }),
  );
  st.status = "running";
  st.awaiting = null;
  st.waitingUntil = null;
}

function handle(c: Ctx, input: EngineInput) {
  const st = c.st;
  const aw = st.awaiting;
  switch (input.kind) {
    case "start": {
      if (st.started) return;
      st.started = true;
      st.event = input.event;
      c.log.push(
        row({
          stepId: "trigger",
          path: "trigger",
          kind: "trigger",
          outcome: "ok",
          output: input.event,
        }),
      );
      st.stack = [{ t: "list", base: "", i: 0 }];
      return;
    }
    case "approved": {
      if (st.status !== "waiting_approval" || aw?.kind !== "approval") return;
      const step = currentStep(st) as ActionStep;
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: step.kind,
          outcome: "approved",
          byId: input.byId,
        }),
      );
      st.awaiting = null;
      return proceedAction(c, step, aw.path, { edited: input.edited });
    }
    case "rejected": {
      if (st.status !== "waiting_approval" || aw?.kind !== "approval") return;
      const step = currentStep(st)!;
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: step.kind,
          outcome: "rejected",
          byId: input.byId,
          input: aw.preview,
        }),
      );
      st.status = "cancelled";
      st.error = "rejected";
      st.awaiting = null;
      return;
    }
    case "event": {
      if (st.status !== "waiting_event" || aw?.kind !== "wait") return;
      const step = currentStep(st) as WaitStep;
      const w = step.for;
      const p = input.payload;
      if (p.kind === "reply" && "replyTo" in w && p.to === w.replyTo) {
        return finishWait(
          c,
          step,
          aw.path,
          { "risposta.arrivata": true, "risposta.testo": p.text },
          null,
        );
      }
      if (p.kind === "task_closed" && "taskClosed" in w && p.taskStepId === w.taskClosed) {
        return finishWait(c, step, aw.path, { chiusa: true }, null);
      }
      return;
    }
    case "time": {
      if (Date.parse(input.now) > Date.parse(st.now)) st.now = input.now;
      if (st.status !== "waiting_event" || aw?.kind !== "wait" || !reached(st.now, aw.until))
        return;
      const step = currentStep(st) as WaitStep;
      const w = step.for;
      if ("days" in w) return finishWait(c, step, aw.path, {}, null);
      const reason = `Nessuna risposta entro ${w.maxDays} giorni.`;
      // R-J2: scaduta l'attesa la risposta è assente, mai quella di prima.
      if ("replyTo" in w)
        return finishWait(
          c,
          step,
          aw.path,
          { "risposta.arrivata": false, "risposta.testo": "" },
          reason,
        );
      return finishWait(
        c,
        step,
        aw.path,
        { chiusa: false },
        `La task non è stata chiusa entro ${w.maxDays} giorni.`,
      );
    }
    case "project_chosen": {
      if (aw?.kind !== "project") return;
      const step = currentStep(st) as ActionStep;
      st.projects[aw.clientKey] = input.projectId;
      if (aw.asked) {
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: step.kind,
            outcome: "approved",
            byId: input.byId ?? null,
            input: { clientKey: aw.clientKey },
            output: { progetto: input.projectId },
            reason: "Progetto scelto a mano.",
          }),
        );
      }
      st.status = "running";
      st.awaiting = null;
      return proceedAction(c, step, aw.path, null);
    }
    case "effect_result": {
      if (aw?.kind === "project" && !aw.asked && !input.ok && input.error === PROJECT_NOT_FOUND) {
        const step = currentStep(st)!;
        aw.asked = true;
        st.status = "waiting_project";
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: step.kind,
            outcome: "waiting",
            input: { clientKey: aw.clientKey },
            reason:
              input.reason ??
              "Il cliente non è nella tabella cliente → progetto: deve scegliere il proprietario.",
          }),
        );
        return;
      }
      if (aw?.kind !== "effect") return;
      const step = currentStep(st) as ActionStep;
      st.awaiting = null;
      if (!input.ok) {
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: step.kind,
            outcome: "failed",
            input: aw.preview,
            reason: input.reason ?? input.error ?? null,
          }),
        );
        return fail(c, input.error ?? "effect_failed");
      }
      const codes = input.codes ?? [];
      st.created[step.id] = codes;
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: step.kind,
          outcome: "ok",
          input: aw.preview,
          output: step.kind === "sendEmail" ? { inviata: true } : {},
          reason: input.reason ?? null,
          effects: codes.map((code) => ({ kind: EFFECT_KIND[step.kind], code })),
        }),
      );
      return;
    }
    case "claude_result": {
      if (aw?.kind !== "claude") return;
      const step = currentStep(st) as ClaudeStep;
      st.awaiting = null;
      const check = checkClaudeResult(step, input);
      const uscita = input.outcome === undefined ? {} : { uscita: input.outcome };
      if (!check.ok) {
        const why = {
          unknown_outcome: `Claude ha restituito un'uscita non prevista dal passo («${input.outcome ?? "nessuna"}»).`,
          bad_field: "Claude ha restituito campi non previsti dal passo o del tipo sbagliato.",
          too_many: `Claude ha restituito un elenco oltre il limite di ${AUTOMATION_LIMITS.forEachRounds} elementi.`,
        }[check.error];
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: "claude",
            outcome: "failed",
            input: aw.input,
            output: uscita,
            reason: why,
          }),
        );
        return fail(c, check.error);
      }
      const fields = input.fields ?? {};
      Object.assign(st.vars, fields);
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: "claude",
          outcome: "ok",
          input: aw.input,
          output: { ...uscita, ...fields },
          reason: input.reason,
        }),
      );
      if (input.outcome !== undefined)
        st.stack.push({ t: "list", base: joinPath(aw.path, input.outcome), i: 0 });
      return;
    }
  }
}

/**
 * Un passo del motore. Puro: lo stato in ingresso non cambia. Un input che
 * lo stato non aspetta non produce effetti né righe (regola 1).
 */
export function advance(state: EngineState, input: EngineInput): EngineStep {
  const c: Ctx = { st: structuredClone(state), effects: [], log: [] };
  const terminal =
    state.status === "done" || state.status === "failed" || state.status === "cancelled";
  if (terminal || (!state.started && input.kind !== "start")) {
    if (input.kind === "time" && Date.parse(input.now) > Date.parse(state.now))
      c.st.now = input.now;
    return { state: c.st, effects: [], log: [] };
  }
  handle(c, input);
  run(c);
  return { state: c.st, effects: c.effects, log: c.log };
}

/**
 * Lo stato di un'esecuzione salvata, ricostruito dal cursore (R-J5): le
 * liste, i giri dei cicli (elementi del `forEach` riletti dalle variabili),
 * cosa aspetta. Per un'esecuzione `waiting_*` aspetta lo stesso input di
 * prima; per ogni altro stato (sospesa, fallita da riprovare) il passo del
 * cursore riparte al prossimo input (anche solo `time`).
 */
export function restoreState(
  flow: AutomationFlow,
  run: Pick<AutomationRun, "event" | "vars" | "cursor" | "status" | "waitingUntil" | "log">,
  now: string,
): EngineState {
  const st = initialState(flow, now);
  st.started = true;
  st.event = structuredClone(run.event);
  st.vars = structuredClone(run.vars);
  for (const e of run.log) {
    if (e.kind === "sendEmail" && e.outcome === "ok") st.emailsSent++;
    if (e.effects.length > 0) st.created[e.stepId] = e.effects.map((x) => x.code);
  }
  if (run.cursor === null) {
    st.status = run.status;
    return st;
  }
  const segs = run.cursor.split("/");
  let base = "";
  let path = "";
  let step: Step | null = null;
  for (let k = 0; k < segs.length; k += 2) {
    const i = Number(segs[k]);
    const last = k === segs.length - 1;
    path = joinPath(base, String(i));
    step = stepAt(flow.steps, path);
    if (!step) throw new Error(`Percorso non valido: ${run.cursor}`);
    // Il passo del cursore: già iniziato se si aspetta, da rieseguire altrimenti.
    const waiting = run.status.startsWith("waiting_");
    st.stack.push({ t: "list", base, i: last && !waiting ? i : i + 1 });
    if (last) break;
    const seg = segs[k + 1]!;
    const round = /\[(\d+)\]$/.exec(seg);
    if (step.kind === "forEach") {
      const items = resolve(st, step.list);
      st.stack.push({
        t: "forEach",
        path,
        as: step.as,
        items: Array.isArray(items) ? items : [],
        current: Number(round![1]),
      });
    } else if (step.kind === "repeatUntil") {
      st.stack.push(
        seg === "onLimit"
          ? { t: "repeat", path, round: step.max, onLimit: true }
          : { t: "repeat", path, round: Number(round![1]) + 1, onLimit: false },
      );
    }
    base = joinPath(path, seg);
  }
  st.cursor = run.cursor;
  if (!run.status.startsWith("waiting_")) return st;

  st.status = run.status;
  if (run.status === "waiting_event" && step!.kind === "wait") {
    st.waitingUntil = run.waitingUntil;
    st.awaiting = { kind: "wait", path, until: run.waitingUntil ?? now };
  } else if (
    run.status === "waiting_approval" &&
    "approval" in step! &&
    step.approval.mode === "ask"
  ) {
    const target = projectOf(step);
    const projectId = run.log.at(-1)?.input.progetto;
    const resolved: ResolvedTarget | null =
      target?.mode === "from_client"
        ? typeof projectId === "string"
          ? { mode: "fixed", projectId }
          : null
        : target;
    if (target?.mode === "from_client" && resolved?.mode === "fixed") {
      st.projects[show(resolve(st, target.clientRef))] = resolved.projectId;
    }
    st.awaiting = {
      kind: "approval",
      path,
      who: step.approval.who,
      preview: describe(st, step, resolved).preview,
    };
  } else if (run.status === "waiting_project" && "approval" in step!) {
    const target = projectOf(step);
    const clientKey = target?.mode === "from_client" ? show(resolve(st, target.clientRef)) : "";
    st.awaiting = { kind: "project", path, clientKey, asked: true };
  } else {
    throw new Error(`Stato ${run.status} incoerente col passo ${path}`);
  }
  return st;
}
