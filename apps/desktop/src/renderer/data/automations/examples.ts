import { evaluate, lookup } from "../../domain/automations/conditions";
import { show } from "../../domain/automations/preview";
import { gate, now, state, visibleProjectIds, type AutomationSignal } from "../store";
import type { AutomationFlow, SimulationExample } from "../types";
import { forbidden, invalid, notFound } from "../writer";
import { happenings } from "./sources";
import { automationById, canManageAutomation, canSeeAutomation } from "./visibility";

// Gli eventi d'esempio della prova (area 7, shape «Choose an example»): per
// un inizio da sorgente gli eventi d'esempio della sorgente collegata; per
// un inizio di Stubwise gli oggetti VERI più recenti che corrispondono
// all'inizio (filtro compreso), costruiti con gli stessi dati che ne
// leggerebbe un'esecuzione (`happenings`), e solo fra quelli che chi prova
// vede: task, richieste e traguardi dei suoi progetti (e del progetto
// dell'automazione), email SOLO delle sue caselle (R-J13: la prova non
// legge la posta di altri, nemmeno quella del proprietario). Per una
// ricorrenza o un avvio a mano, la data di oggi. Sola lettura.

const MAX_EXAMPLES = 10;

function fromSignals(
  me: string,
  flow: AutomationFlow,
  projectId: string | null,
  signals: { signal: AutomationSignal; label: string; code: string | null; at: string | null }[],
): SimulationExample[] {
  const t = flow.trigger;
  if (t.kind !== "stubwise") return [];
  const visible = visibleProjectIds(me);
  return signals
    .flatMap(({ signal, label, code, at }) =>
      happenings(signal).map((h) => ({ h, label, code, at })),
    )
    .filter(({ h }) => h.event === t.event)
    .filter(({ h }) =>
      h.event === "mail_received"
        ? h.mailboxPersonIds?.includes(me) === true
        : h.projectId !== null &&
          visible.has(h.projectId) &&
          (projectId === null || h.projectId === projectId),
    )
    .filter(({ h }) => !t.filter || evaluate(t.filter, (key) => lookup(h.payload, key)))
    .sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""))
    .slice(0, MAX_EXAMPLES)
    .map(({ h, label, code, at }) => ({ label, code, at, event: h.payload }));
}

function stubwiseSignals(me: string, flow: AutomationFlow) {
  const t = flow.trigger;
  if (t.kind !== "stubwise") return [];
  switch (t.event) {
    case "task_created":
    case "task_closed":
      return state.tasks
        .filter((x) => (t.event === "task_closed" ? x.closedAt !== null : true))
        .map((x) => ({
          signal: { kind: t.event, taskId: x.id } as AutomationSignal,
          label: x.title,
          code: x.code,
          at: t.event === "task_closed" ? x.closedAt : x.createdAt,
        }));
    case "request_created":
      return state.requests.map((r) => ({
        signal: { kind: "request_created", requestId: r.id } as AutomationSignal,
        label: r.title,
        code: r.code,
        at: r.createdAt,
      }));
    case "milestone_reached":
      return state.milestones
        .filter((m) => m.closed)
        .map((m) => ({
          signal: { kind: "milestone_reached", milestoneId: m.id } as AutomationSignal,
          label: m.name,
          code: null,
          at: m.dueDate,
        }));
    case "mail_received":
      // La posta arrivata, non quella che ho mandato; le caselle le filtra `fromSignals`.
      return state.mailMessages
        .filter((m) => m.from.personId !== me && (!m.delivery || m.delivery.state === "sent"))
        .map((m) => ({
          signal: { kind: "mail_received", messageIds: [m.id] } as AutomationSignal,
          label: m.subject,
          code: null,
          at: m.at,
        }));
  }
}

/** La riga d'un evento di una sorgente: il suo primo dato con un nome (trattativa, cliente…). */
const sampleLabel = (event: Record<string, unknown>, i: number) =>
  Object.values(event)
    .map(show)
    .find((s) => s.trim() !== "") ?? `Evento ${i + 1}`;

/**
 * Gli esempi per provare una versione (`"draft"`: la bozza): solo chi
 * gestisce l'automazione (come la prova).
 */
export async function listSimulationExamples(
  automationId: string,
  version: number | "draft",
): Promise<SimulationExample[]> {
  const me = await gate("automations.listSimulationExamples");
  const a = automationById(automationId);
  if (!a || !canSeeAutomation(me, a)) throw notFound();
  if (!canManageAutomation(me, a)) throw forbidden();
  const last = a.versions.at(-1)!;
  const v =
    version === "draft"
      ? last.publishedAt === null
        ? last
        : undefined
      : a.versions.find((x) => x.n === version);
  if (!v) throw invalid(version === "draft" ? "no_draft" : "version");
  const t = v.flow.trigger;
  switch (t.kind) {
    case "source": {
      const source = state.automationSources.find((s) => s.id === t.sourceId);
      // Una sorgente scaduta o scollegata non manda eventi: «No recent events».
      if (!source || source.status !== "connected") return [];
      return source.sampleEvents
        .map((event, i) => {
          const chiusa = lookup(event, "trattativa.chiusaIl");
          // La data: quella dell'evento, se la porta; altrimenti quando è arrivato (la prima esecuzione nata da lui).
          const same = JSON.stringify(event);
          const arrived = state.automationRuns
            .filter((r) => JSON.stringify(r.event) === same)
            .map((r) => r.startedAt)
            .sort()[0];
          return {
            label: sampleLabel(event, i),
            code: null,
            at: typeof chiusa === "string" ? chiusa : (arrived ?? null),
            event: structuredClone(event),
          };
        })
        .sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
    }
    case "stubwise":
      return fromSignals(me, v.flow, a.projectId, stubwiseSignals(me, v.flow));
    case "schedule":
    case "manual":
      return [
        {
          label: now().slice(0, 10),
          code: null,
          at: now(),
          event: { avvio: { data: now().slice(0, 10) } },
        },
      ];
  }
}
