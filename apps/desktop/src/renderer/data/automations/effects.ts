import type { EffectRequest } from "../../domain/automations/engine";
import { createMilestoneAs, createRequestAs, createTaskAs } from "../api-mutations";
import { lower } from "../mail/compose";
import { canSeeMessage } from "../mail/visibility";
import { sendNow } from "../mail/send";
import { runHref } from "../routes";
import { newId, state } from "../store";
import type { Automation, AutomationRun } from "../types";
import { fakeClaude } from "./claudeFake";
import {
  asFailure,
  bouncedFailure,
  failed,
  planEmail,
  planMilestone,
  planNotify,
  planRequest,
  planStart,
  planTask,
  resolveProject,
  runLimitFailure,
  type ActionEffect,
  type EffectOutcome,
  type ThreadOf,
} from "./plans";
import { runCode } from "./visibility";

// L'UNICO esecutore degli effetti delle automazioni (area 7). Il motore
// chiede (`EffectRequest`), questo modulo fa — con le scritture di oggi, a
// nome del PROPRIETARIO dell'automazione e coi suoi permessi — e risponde
// con l'input che rientra nel motore. Nessun altro punto del prototipo crea
// task, traguardi, richieste, email o notifiche per un'automazione.
//
// - Permesso perso (il proprietario non vede più il progetto, o non ha il
//   permesso di creare) → `permission_lost`, mai un'azione a nome di altri.
// - Le email partono SOLO da una casella del proprietario (`sendNow` della
//   Posta, area 6): senza casella `mailbox_missing`, account scaduto
//   `mailbox_expired`. Il limite di 20 email vale per la catena intera
//   degli avvii (`startAutomation`).
// - Il progetto «del cliente» si trova nella tabella cliente → progetto;
//   uno che il proprietario non vede vale come non trovato (R-G5): l'attesa
//   «scegli il progetto».
// - Ogni task e traguardo creato porta `automationRef`.
// - Ogni azione è un PIANO (`plans.ts`: controlli e risoluzioni, senza
//   scrivere) seguito dalla scrittura. La prova (`simulate.ts`) usa gli
//   stessi piani e non scrive mai.
// Gli errori sono codici macchina; la prosa sta solo nel `reason` della riga.

export { CHAIN_MAX, type EffectOutcome } from "./plans";

export interface EffectEnv {
  run: AutomationRun;
  automation: Automation;
  /** L'«adesso» dell'esecuzione (ISO). */
  now: string;
  /** Avvia l'esecuzione figlia di `startAutomation` (la crea il runner). */
  spawn(target: Automation, event: Record<string, unknown>): AutomationRun | null;
}

/** L'esecuzione che sta eseguendo un effetto adesso: i segnali che produce sono suoi (catene). */
let origin: string | null = null;
export const currentOrigin = (): string | null => origin;

const done = (codes: string[], projectId?: string, reason?: string): EffectOutcome => ({
  input: { kind: "effect_result", ok: true, codes, ...(reason ? { reason } : {}) },
  ...(projectId ? { projectId } : {}),
});

/** Le esecuzioni della stessa catena di avvii (dalla radice). */
export function chainOf(run: AutomationRun): AutomationRun[] {
  let root = run;
  while (root.parentRunId) {
    const parent = state.automationRuns.find((r) => r.id === root.parentRunId);
    if (!parent) break;
    root = parent;
  }
  const out: AutomationRun[] = [];
  const visit = (r: AutomationRun) => {
    out.push(r);
    for (const child of state.automationRuns.filter((c) => c.parentRunId === r.id)) visit(child);
  };
  visit(root);
  return out;
}

/** Le automazioni sopra un'esecuzione nella catena, la sua compresa. */
export function ancestorsOf(run: AutomationRun): AutomationRun[] {
  const out = [run];
  let cur = run;
  while (cur.parentRunId) {
    const parent = state.automationRuns.find((r) => r.id === cur.parentRunId);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

const emailsSent = (runs: AutomationRun[]) =>
  runs.reduce(
    (n, r) => n + r.log.filter((e) => e.kind === "sendEmail" && e.outcome === "ok").length,
    0,
  );

// --- le azioni ----------------------------------------------------------------------

function createTask(eff: ActionEffect, env: EffectEnv, owner: string) {
  const { automation: a, run } = env;
  const p = planTask(eff, a, owner, env.now);
  if (!p.ok) return p.outcome;
  const { plan } = p;
  const milestone = state.milestones.find(
    (m) => m.id === plan.milestoneCode && m.projectId === plan.projectId,
  );
  // Origine e riferimento entrano alla creazione: decidono l'avviso
  // («task.created_by_automation», non «task.created»).
  const task = createTaskAs(
    owner,
    {
      projectId: plan.projectId,
      title: plan.title,
      description: plan.description,
      assigneeId: plan.assignee.assigneeId,
      departmentId: plan.departmentId ?? undefined,
      dueDate: plan.dueDate,
      milestoneId: milestone?.id ?? null,
    },
    { source: "automation", automationRef: { automationId: a.id, runId: run.id } },
  );
  return done([task.code], plan.projectId, plan.assignee.reason);
}

function createMilestone(eff: ActionEffect, env: EffectEnv, owner: string) {
  const p = planMilestone(eff, env.automation, owner, env.now);
  if (!p.ok) return p.outcome;
  const milestone = createMilestoneAs(owner, p.plan.projectId, {
    name: p.plan.name,
    dueDate: p.plan.dueDate,
  });
  milestone.automationRef = { automationId: env.automation.id, runId: env.run.id };
  return done([milestone.id], p.plan.projectId);
}

function createRequest(eff: ActionEffect, env: EffectEnv, owner: string) {
  const p = planRequest(eff, env.automation, owner);
  if (!p.ok) return p.outcome;
  const request = createRequestAs(owner, p.plan);
  return done([request.code], p.plan.projectId);
}

function sendEmail(eff: ActionEffect, env: EffectEnv, owner: string) {
  const p = planEmail(
    eff,
    owner,
    emailsSent(chainOf(env.run)),
    (to) => threadFor(env.run, owner, to),
    (i) => `att-${env.run.id}-${eff.stepId}-${i}`,
    env.automation.mailbox ?? null,
  );
  if (!p.ok) return p.outcome;
  const message = sendNow(owner, p.plan.input, { from: env.automation.mailbox ?? null });
  if (message.delivery?.state !== "sent") return bouncedFailure(p.plan.to);
  return done([message.id]);
}

/**
 * Le email di un'esecuzione allo stesso indirizzo stanno in UNA
 * conversazione (il promemoria risponde alla richiesta): la risposta del
 * cliente vi arriva comunque risponda, e sblocca l'attesa del passo che la
 * aspetta. Una conversazione che il proprietario non vede (è cambiato) ne
 * apre una nuova.
 */
function threadFor(run: AutomationRun, owner: string, to: string): ThreadOf {
  const sent = run.log
    .filter((e) => e.kind === "sendEmail" && e.outcome === "ok")
    .flatMap((e) => e.effects.map((x) => x.code));
  const prior = sent
    .map((id) => state.mailMessages.find((m) => m.id === id))
    .filter(
      (m) =>
        m?.delivery?.state === "sent" &&
        m.from.personId === owner &&
        m.to.some((a) => lower(a.email) === lower(to)),
    )
    .at(-1);
  const last = prior
    ? state.mailMessages
        .filter((m) => m.threadId === prior.threadId && canSeeMessage(owner, m))
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1)
    : undefined;
  return last
    ? { threadId: last.threadId, mode: "reply" as const, replyToMessageId: last.id, quote: false }
    : { threadId: null, mode: "new" as const, replyToMessageId: null };
}

function notify(eff: ActionEffect, env: EffectEnv, owner: string) {
  const p = planNotify(eff, env.automation, owner);
  if (!p.ok) return p.outcome;
  const code = runCode(env.run);
  const notification = {
    id: newId("n"),
    kind: "automation.notify",
    projectId: p.plan.projectId,
    objectCode: code,
    departmentId: null,
    recipientIds: [p.plan.personId],
    title: `${env.automation.name} · ${code}`,
    body: p.plan.text,
    createdAt: env.now,
    read: false,
    archived: false,
    snoozedUntil: null,
    link: runHref(env.automation.code, env.run.n),
  };
  state.notifications.push(notification);
  return done([notification.id]);
}

function startAutomation(eff: ActionEffect, env: EffectEnv, owner: string) {
  const p = planStart(
    eff,
    owner,
    ancestorsOf(env.run).map((r) => r.automationId),
  );
  if (!p.ok) return p.outcome;
  const child = env.spawn(p.plan, env.run.event);
  if (!child) return runLimitFailure(p.plan.name);
  return done([runCode(child)]);
}

// --- l'esecutore ------------------------------------------------------------------

/** Esegue un effetto a nome del proprietario e restituisce l'input da rimettere nel motore. */
export function executeEffect(eff: EffectRequest, env: EffectEnv): EffectOutcome {
  const owner = env.automation.ownerId;
  if (eff.kind === "claude") {
    return { input: fakeClaude(eff.step, eff.vars, owner) };
  }
  if (!owner) {
    return failed(
      "permission_lost",
      { code: "noOwner" },
      "Permesso perso: l'automazione non ha un proprietario.",
    );
  }
  if (eff.kind === "resolve_project") return resolveProject(eff, owner);
  origin = env.run.id;
  try {
    switch (eff.kind) {
      case "createTask":
        return createTask(eff, env, owner);
      case "createMilestone":
        return createMilestone(eff, env, owner);
      case "createRequest":
        return createRequest(eff, env, owner);
      case "sendEmail":
        return sendEmail(eff, env, owner);
      case "notify":
        return notify(eff, env, owner);
      case "startAutomation":
        return startAutomation(eff, env, owner);
    }
  } catch (error) {
    return asFailure(error, owner);
  } finally {
    origin = null;
  }
}
