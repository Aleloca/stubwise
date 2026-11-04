import { evaluate, lookup } from "../../domain/automations/conditions";
import { triggerFields } from "../../domain/automations/fields";
import { show } from "../../domain/automations/preview";
import { gate, now, state, visibleProjectIds, type AutomationSignal } from "../store";
import type { AutomationFlow, Condition, SimulationExample, Utterance } from "../types";
import { forbidden, invalid, notFound } from "../writer";
import { happenings, leavesOf, passesStartFilter } from "./sources";
import { automationById, canManageAutomation, canSeeAutomation, canSeeRun } from "./visibility";

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

type Signal = { signal: AutomationSignal; label: string; code: string | null; at: string | null };

/**
 * Gli eventi veri che chi prova vede, dal più recente: quelli che il filtro
 * dell'inizio fa passare (`passes: true`, la prova a mano) o quelli che non
 * fa passare (`passes: false`, l'esempio «non partirebbe» di Claude).
 */
function visibleEvents(
  me: string,
  flow: AutomationFlow,
  projectId: string | null,
  signals: Signal[],
  passes: boolean,
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
    .filter(
      ({ h }) => (!t.filter || evaluate(t.filter, (key) => lookup(h.payload, key))) === passes,
    )
    .sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""))
    .slice(0, MAX_EXAMPLES)
    .map(({ h, label, code, at }) => ({ label, code, at, event: h.payload }));
}

const fromSignals = (
  me: string,
  flow: AutomationFlow,
  projectId: string | null,
  signals: Signal[],
): SimulationExample[] => visibleEvents(me, flow, projectId, signals, true);

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
      // Quando è arrivato un evento: la prima esecuzione nata da lui fra quelle che chi prova vede (R-G5).
      const arrivedAt = new Map<string, string>();
      for (const r of state.automationRuns) {
        if (!canSeeRun(me, r)) continue;
        const key = JSON.stringify(r.event);
        const prev = arrivedAt.get(key);
        if (prev === undefined || r.startedAt < prev) arrivedAt.set(key, r.startedAt);
      }
      return source.sampleEvents
        .map((event, i) => {
          const chiusa = lookup(event, "trattativa.chiusaIl");
          // La data: quella dell'evento, se la porta; altrimenti quando è arrivato.
          const arrived = arrivedAt.get(JSON.stringify(event));
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

// --- gli esempi della prova di Claude (area 10b) --------------------------------------

/** Un esempio per la prova di Claude: un evento vero (`written: false`) o scritto da lui. */
export interface TrialExample {
  event: Record<string, unknown>;
  /** La riga dell'esempio, come chiave e parametri (si legge nella lingua di chi guarda). */
  label: Utterance;
  written: boolean;
}

/** I valori noti di un dato che è un elenco chiuso: il «diverso» di un esempio che non passa. */
const CLOSED_VALUES: Record<string, readonly string[]> = {
  "richiesta.urgenza": ["low", "medium", "high"],
};

/** Scrive `value` in `event` al percorso puntato di `key` («richiesta.urgenza»). */
function setAt(event: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur = event;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
}

/** Un valore diverso da `value` per il dato `key`: un altro dell'elenco chiuso, il contrario, o vuoto. */
function otherThan(key: string, value: unknown): unknown {
  if (typeof value === "boolean") return !value;
  const closed = CLOSED_VALUES[key];
  if (closed) return closed.find((v) => v !== value) ?? "";
  if (typeof value === "number") return value + 1;
  return "";
}

/**
 * Un evento scritto da Claude coi dati dell'inizio: ogni campo con un valore
 * neutro (il nome del campo per un testo, chi prova per una persona, il
 * progetto dell'automazione, la data di oggi), poi i confronti `is` e
 * `contains` del filtro soddisfatti; per un esempio che non deve passare, il
 * primo confronto rotto. Non si legge da niente che chi prova non veda.
 */
function writtenEvent(
  me: string,
  flow: AutomationFlow,
  projectCode: string | null,
  passes: boolean,
): Record<string, unknown> {
  const event: Record<string, unknown> = {};
  for (const f of triggerFields(flow, state.automationSources)) {
    const value =
      f.key.endsWith(".progetto") && projectCode !== null
        ? projectCode
        : f.type === "boolean"
          ? false
          : f.type === "number"
            ? 0
            : f.type === "person"
              ? me
              : f.type === "date"
                ? now().slice(0, 10)
                : f.key.endsWith(".codice") || f.type === "email"
                  ? ""
                  : f.label;
    setAt(event, f.key, value);
  }
  const t = flow.trigger;
  if (t.kind !== "stubwise" || !t.filter) return event;
  const leaves = leavesOf(t.filter).filter(
    (c): c is Condition & { left: { ref: string }; right: { value: unknown } } =>
      (c.op === "is" || c.op === "contains") &&
      c.left !== undefined &&
      "ref" in c.left &&
      c.right !== undefined &&
      "value" in c.right,
  );
  for (const c of leaves) setAt(event, c.left.ref, c.right.value);
  const first = leaves[0];
  if (!passes && first) setAt(event, first.left.ref, otherThan(first.left.ref, first.right.value));
  return event;
}

/**
 * Per ogni `want`, l'evento più recente della sorgente che chi chiede vede e
 * che il filtro fa passare (o no); se non c'è, uno scritto da Claude dai
 * campi dell'inizio, `written: true` («Example written by Claude»). Solo chi
 * gestisce l'automazione (come la prova); sola lettura.
 *
 * `null` al posto di un `want`: Claude non è riuscito a scrivere un esempio
 * da quella parte del filtro (un `any` che non sa rompere, un `gt`, nessun
 * filtro per «non passa»…). L'evento scritto si verifica col filtro vero
 * (`passesStartFilter`) prima di restituirlo: un esempio dalla parte
 * sbagliata farebbe dire alla prova ciò che il dato non dimostra (I1). Il
 * risultato resta allineato a `wants`.
 */
export function pickTrialExamples(
  me: string,
  automationId: string,
  wants: ("passes" | "fails")[],
): (TrialExample | null)[] {
  const a = automationById(automationId);
  if (!a || !canSeeAutomation(me, a)) throw notFound();
  if (!canManageAutomation(me, a)) throw forbidden();
  const last = a.versions.at(-1)!;
  if (last.publishedAt !== null) throw invalid("no_draft");
  const flow = last.flow;
  const project = a.projectId === null ? null : (state.projectsById.get(a.projectId) ?? null);
  return wants.map((want) => {
    const passes = want === "passes";
    const [found] = visibleEvents(me, flow, a.projectId, stubwiseSignals(me, flow), passes);
    if (found) {
      return {
        event: structuredClone(found.event),
        label: {
          key: "claude.trial.example",
          params: { code: found.code ?? "", title: found.label },
        },
        written: false,
      };
    }
    const event = writtenEvent(me, flow, project?.code ?? null, passes);
    if (passesStartFilter(flow.trigger, event) !== passes) return null;
    return { event, label: { key: "claude.trial.exampleWritten" }, written: true };
  });
}
