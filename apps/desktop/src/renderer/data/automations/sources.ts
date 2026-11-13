import { chainAllows as chainRule, lookup, evaluate } from "@stubwise/shared";
import {
  copy,
  onAutomationSignal,
  state,
  visibleProjectIds,
  type AutomationSignal,
} from "../store";
import type {
  Automation,
  AutomationTrigger,
  Condition,
  FilterCheck,
  ProjectRequest,
  Task,
} from "../types";
import { ancestorsOf, currentOrigin } from "./effects";
import { enqueue, publishedVersion, startRun } from "./runner";
import { runById, stepOfRun } from "./visibility";

// Da dove partono le esecuzioni (area 7): gli eventi di Stubwise, che le
// scritture di oggi segnalano (`signalAutomations`), le date e le
// ricorrenze valutate sull'«adesso» del prototipo. E dove arrivano gli
// eventi che un'attesa aspetta: la risposta del cliente nella Posta, la
// task chiusa. Le sorgenti esterne (finte) partono da
// `simulateSourceEvent` (writes.ts).
//
// - L'inizio «email in arrivo» legge SOLO le caselle del proprietario
//   (privacy della Posta: nessuna automazione legge la posta di altri).
// - Un'automazione generale parte solo per oggetti di progetti che il suo
//   proprietario vede; una di progetto solo per il suo progetto.
// - Un evento prodotto da un'esecuzione (una task creata da un passo) non
//   riavvia un'automazione già nella sua catena, e la catena si ferma a 3.

type StubwiseEvent = Extract<AutomationTrigger, { kind: "stubwise" }>["event"];

export interface Happening {
  event: StubwiseEvent;
  payload: Record<string, unknown>;
  /** Il progetto dell'oggetto; `null` per la posta. */
  projectId: string | null;
  /** Per la posta: le caselle che contengono il messaggio. */
  mailboxPersonIds?: string[];
}

const projectCode = (id: string) => state.projectsById.get(id)?.code ?? "";

/**
 * L'evento di una task, coi campi che ne leggono le automazioni: quello di
 * un segnale, e quello che la classe di Claude (area 10a) costruisce dagli
 * argomenti di un'azione prima di eseguirla.
 */
export function taskHappening(
  event: "task_created" | "task_closed",
  t: Pick<Task, "code" | "title" | "projectId" | "assigneeId" | "statusId">,
): Happening {
  return {
    event,
    projectId: t.projectId,
    payload: {
      task: {
        codice: t.code,
        titolo: t.title,
        progetto: projectCode(t.projectId),
        incaricato: t.assigneeId ?? "",
        stato: state.statusById.get(t.statusId)?.name ?? "",
      },
    },
  };
}

/** I dati di una richiesta che ne leggono le automazioni (creata o convertita). */
function requestPayload(r: ProjectRequest): Record<string, unknown> {
  return {
    codice: r.code,
    titolo: r.title,
    descrizione: r.description,
    progetto: projectCode(r.projectId),
    richiedente: r.requesterIds[0] ?? "",
    urgenza: r.urgency,
    dal_supporto: r.origin?.kind === "support",
  };
}

/** Gli eventi di un segnale, coi dati che ne leggono le automazioni (anche gli esempi della prova). */
export function happenings(signal: AutomationSignal): Happening[] {
  switch (signal.kind) {
    case "task_created":
    case "task_closed": {
      const t = state.tasksById.get(signal.taskId);
      if (!t) return [];
      return [taskHappening(signal.kind, t)];
    }
    case "request_created": {
      const r = state.requests.find((x) => x.id === signal.requestId);
      if (!r) return [];
      return [{ event: "request_created", projectId: r.projectId, payload: { richiesta: requestPayload(r) } }];
    }
    case "request_converted": {
      // Q5 = a: i dati della richiesta e della task nata dalla conversione.
      const r = state.requests.find((x) => x.id === signal.requestId);
      const t = state.tasksById.get(signal.taskId);
      if (!r || !t) return [];
      return [
        {
          event: "request_converted",
          projectId: r.projectId,
          payload: {
            richiesta: requestPayload(r),
            ...taskHappening("task_created", t).payload,
          },
        },
      ];
    }
    case "milestone_reached": {
      const m = state.milestones.find((x) => x.id === signal.milestoneId);
      if (!m) return [];
      return [
        {
          event: "milestone_reached",
          projectId: m.projectId,
          payload: { traguardo: { nome: m.name, progetto: projectCode(m.projectId) } },
        },
      ];
    }
    case "mail_received":
      return signal.messageIds.flatMap((id) => {
        const m = state.mailMessages.find((x) => x.id === id);
        if (!m) return [];
        return [
          {
            event: "mail_received" as const,
            projectId: null,
            mailboxPersonIds: m.mailboxPersonIds,
            payload: { email: { mittente: m.from.email, oggetto: m.subject, testo: m.text } },
          },
        ];
      });
  }
}

/**
 * Il filtro dell'inizio vale per l'evento? Una regola sola: la usano l'avvio
 * vero (`startsOn`) e la prova (D3, area 10b), così non possono divergere.
 */
export function passesStartFilter(t: AutomationTrigger, payload: Record<string, unknown>): boolean {
  return t.kind !== "stubwise" || !t.filter || evaluate(t.filter, (key) => lookup(payload, key));
}

/** I confronti di una condizione, anche dentro i gruppi. */
export const leavesOf = (c: Condition): Condition[] =>
  c.all || c.any ? [...(c.all ?? []), ...(c.any ?? [])].flatMap(leavesOf) : [c];

/**
 * L'esito di ogni confronto del filtro dell'inizio sull'evento, col valore
 * letto (D3): la prova lo mostra, la pagina non lo ricalcola.
 */
export function startFilterChecks(
  t: AutomationTrigger,
  payload: Record<string, unknown>,
): FilterCheck[] {
  if (t.kind !== "stubwise" || !t.filter) return [];
  const read = (key: string) => lookup(payload, key);
  return leavesOf(t.filter).map((condition) => ({
    condition: copy(condition),
    value: condition.left && "ref" in condition.left ? (read(condition.left.ref) ?? null) : null,
    matches: evaluate(condition, read),
  }));
}

/** L'automazione parte per questo evento? Proprietario, progetto, caselle, filtro. */
function startsOn(a: Automation, h: Happening): boolean {
  const t = publishedVersion(a)?.flow.trigger;
  if (a.status !== "active" || !a.ownerId || t?.kind !== "stubwise" || t.event !== h.event)
    return false;
  if (h.event === "mail_received") {
    if (!h.mailboxPersonIds?.includes(a.ownerId)) return false;
  } else {
    if (h.projectId === null || !visibleProjectIds(a.ownerId).has(h.projectId)) return false;
    if (a.projectId !== null && a.projectId !== h.projectId) return false;
  }
  return passesStartFilter(t, h.payload);
}

/**
 * Le automazioni attive che partirebbero per l'evento, adesso (`startsOn`):
 * la classe calcolata di Claude (area 10a) ne fa un motivo per chiedere.
 * In bozza o in pausa non partono, quindi non contano.
 */
export function automationsStartingOn(h: Happening): string[] {
  return state.automations.filter((a) => startsOn(a, h)).map((a) => a.id);
}

/** Un evento nato dentro un'esecuzione: niente cicli, catena di al massimo 3. */
function chainAllows(a: Automation, originRunId: string | null): boolean {
  const origin = originRunId ? runById(originRunId) : undefined;
  if (!origin) return true;
  // La regola è del motore condiviso (area 7, F1): la stessa del server.
  return chainRule(ancestorsOf(origin), a.id);
}

/** Le attese che l'evento sblocca: la risposta a un'email, una task chiusa. */
function wakeWaits(signal: AutomationSignal): void {
  for (const run of state.automationRuns) {
    if (run.status !== "waiting_event") continue;
    const step = stepOfRun(run);
    if (step?.kind !== "wait") continue;
    const w = step.for;
    const made = (stepId: string, kind: string) =>
      run.log
        .filter((e) => e.stepId === stepId && e.outcome === "ok")
        .flatMap((e) => e.effects.filter((x) => x.kind === kind).map((x) => x.code));
    if (signal.kind === "mail_received" && "replyTo" in w) {
      const sent = made(w.replyTo, "email")
        .map((id) => state.mailMessages.find((m) => m.id === id))
        .filter((m) => m !== undefined);
      const reply = signal.messageIds
        .map((id) => state.mailMessages.find((m) => m.id === id))
        .find(
          (m) =>
            m &&
            m.from.personId === null &&
            sent.some(
              (s) =>
                s.threadId === m.threadId && m.mailboxPersonIds.includes(s.from.personId ?? ""),
            ),
        );
      if (reply) {
        void enqueue(run.id, {
          kind: "event",
          payload: { kind: "reply", to: w.replyTo, text: reply.text },
        });
      }
    }
    if (signal.kind === "task_closed" && "taskClosed" in w) {
      const code = state.tasksById.get(signal.taskId)?.code;
      if (code && made(w.taskClosed, "task").includes(code)) {
        void enqueue(run.id, {
          kind: "event",
          payload: { kind: "task_closed", taskStepId: w.taskClosed },
        });
      }
    }
  }
}

/** Gli inizi `stubwise` e le attese, agganciati alle scritture di oggi. */
onAutomationSignal((signal) => {
  // Letto subito: un segnale nato dentro un effetto appartiene a quell'esecuzione.
  const origin = currentOrigin();
  wakeWaits(signal);
  for (const h of happenings(signal)) {
    for (const a of state.automations) {
      if (startsOn(a, h) && chainAllows(a, origin))
        startRun(a, h.payload, { parentRunId: origin, origin: "stubwise" });
    }
  }
});

// --- date e ricorrenze --------------------------------------------------------------

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Una RRULE semplice (`FREQ=DAILY|WEEKLY;BYDAY=MO,TH;BYHOUR=9`) cade
 * nell'«adesso» dato? Il giorno deve essere fra quelli della regola (ogni
 * giorno per `DAILY`), l'ora raggiunta.
 */
export function scheduleDue(rule: string, at: string): boolean {
  const parts = Object.fromEntries(
    rule.split(";").map((p) => p.split("=") as [string, string | undefined]),
  );
  const d = new Date(at);
  const hour = Number(parts.BYHOUR ?? 0);
  if (!Number.isFinite(hour) || d.getUTCHours() < hour) return false;
  if (parts.FREQ === "DAILY") return true;
  if (parts.FREQ !== "WEEKLY") return false;
  return (parts.BYDAY ?? "").split(",").includes(DAYS[d.getUTCDay()]!);
}

/** Le automazioni con una data o una ricorrenza che cade adesso e non sono ancora partite oggi. */
export function dueSchedules(at: string): Automation[] {
  const today = at.slice(0, 10);
  return state.automations.filter((a) => {
    const t = publishedVersion(a)?.flow.trigger;
    if (a.status !== "active" || t?.kind !== "schedule" || !scheduleDue(t.rule, at)) return false;
    return !state.automationRuns.some(
      (r) =>
        r.automationId === a.id && r.origin === "schedule" && r.startedAt.slice(0, 10) === today,
    );
  });
}
