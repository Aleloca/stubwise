import { lookup, evaluate } from "../../domain/automations/conditions";
import { onAutomationSignal, state, visibleProjectIds, type AutomationSignal } from "../store";
import type { Automation, AutomationTrigger } from "../types";
import { ancestorsOf, CHAIN_MAX, currentOrigin } from "./effects";
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

interface Happening {
  event: StubwiseEvent;
  payload: Record<string, unknown>;
  /** Il progetto dell'oggetto; `null` per la posta. */
  projectId: string | null;
  /** Per la posta: le caselle che contengono il messaggio. */
  mailboxPersonIds?: string[];
}

const projectCode = (id: string) => state.projectsById.get(id)?.code ?? "";

function happenings(signal: AutomationSignal): Happening[] {
  switch (signal.kind) {
    case "task_created":
    case "task_closed": {
      const t = state.tasksById.get(signal.taskId);
      if (!t) return [];
      return [
        {
          event: signal.kind,
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
        },
      ];
    }
    case "request_created": {
      const r = state.requests.find((x) => x.id === signal.requestId);
      if (!r) return [];
      return [
        {
          event: "request_created",
          projectId: r.projectId,
          payload: {
            richiesta: {
              codice: r.code,
              titolo: r.title,
              descrizione: r.description,
              progetto: projectCode(r.projectId),
              richiedente: r.requesterIds[0] ?? "",
            },
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
  return !t.filter || evaluate(t.filter, (key) => lookup(h.payload, key));
}

/** Un evento nato dentro un'esecuzione: niente cicli, catena di al massimo 3. */
function chainAllows(a: Automation, originRunId: string | null): boolean {
  const origin = originRunId ? runById(originRunId) : undefined;
  if (!origin) return true;
  const chain = ancestorsOf(origin);
  return !chain.some((r) => r.automationId === a.id) && chain.length < CHAIN_MAX;
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
      if (startsOn(a, h) && chainAllows(a, origin)) startRun(a, h.payload, origin);
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
      (r) => r.automationId === a.id && r.parentRunId == null && r.startedAt.slice(0, 10) === today,
    );
  });
}
