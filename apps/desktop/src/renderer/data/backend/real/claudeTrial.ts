import {
  passesStartFilter,
  type AutomationTrigger,
  type ClaudeActionGroupView,
  type Reader,
  type SimulationExample,
} from "@stubwise/shared";
import type { ConversationEvent, TrialOutcome, Utterance } from "../../types";
import { liveAutomations } from "./automationsLive";
import { session } from "./client";
import { listPeople } from "./people";

// La prova di Claude nella build app (area 10, F2, S1). Nel prototipo la fa
// il motore della conversazione (`data/claude/trial.ts`, `trialAs`); qui il
// server crea solo la bozza (`createAutomation`, sempre spenta), e la prova
// la fa il RENDERER, sulla sua simulazione, come la prova a mano:
// - gli esempi sono quelli veri del server (`GET …/examples?version=draft`,
//   in ordine dal più recente): il primo che passa il filtro dell'inizio e,
//   se l'inizio ha un filtro, il primo che non passa (decisione 2a, 46);
// - si va avanti passo per passo e ci si ferma prima di un passo di Claude o
//   di un costo da confermare: la prova di Claude non spende;
// - chi approverebbe si nomina solo se chi chiede lo vede (R-G5).
// Una prova che finisce bene segna la bozza provata come quella a mano
// (decisione 1a, 46: la specifica è il prototipo); niente altro si scrive.

/** Ciò che la prova legge di una simulazione (un sottoinsieme di `SimulationView`). */
export interface TrialSim {
  status: TrialOutcome["status"];
  filteredOut?: boolean;
  current: { kind: string } | null;
  costToConfirm?: unknown;
  waiting: { kind: string; who?: unknown } | null;
  preview: {
    tasks: unknown[];
    milestones: unknown[];
    requests: unknown[];
    emails: unknown[];
    notifications: unknown[];
  };
}

export interface TrialDeps {
  automationIdOf(code: string): Promise<string | null>;
  draftTrigger(automationId: string): Promise<AutomationTrigger>;
  listExamples(automationId: string): Promise<SimulationExample[]>;
  start(automationId: string, event: Record<string, unknown>): Promise<string>;
  step(simId: string): Promise<TrialSim>;
  get(simId: string): Promise<TrialSim | null>;
}

export type TrialResult = TrialOutcome & { label: Utterance; written: boolean };

export type TrialRun =
  | { status: "skipped" }
  | {
      status: "done";
      automationId: string;
      code: string;
      wants: ("passes" | "fails")[];
      results: TrialResult[];
      openSimId: string | null;
    };

/** Oltre questi passi la prova si ferma dov'è: un flusso non finisce in un ciclo della prova. */
const MAX_STEPS = 100;

const TERMINAL = new Set(["done", "failed", "cancelled"]);

const hasFilter = (t: AutomationTrigger) => t.kind === "stubwise" && !!t.filter;

/** Va avanti finché la prova può farlo da sola: mai dentro un passo di Claude o un costo. */
async function advance(deps: TrialDeps, simId: string): Promise<TrialSim | null> {
  let view = await deps.get(simId);
  for (let i = 0; view && i < MAX_STEPS; i++) {
    if (view.status !== "running" || view.costToConfirm) break;
    if (!view.current || view.current.kind === "claude") break;
    view = await deps.step(simId);
  }
  return view;
}

function outcomeOf(
  simId: string,
  view: TrialSim,
  visible: (personId: string) => boolean,
): TrialOutcome {
  const who = view.waiting?.kind === "approval" ? view.waiting.who : null;
  const personId =
    who && typeof who === "object" && "personId" in who && typeof who.personId === "string"
      ? who.personId
      : null;
  return {
    simId,
    status: view.filteredOut ? "filtered_out" : view.status,
    tasks: view.preview.tasks.length,
    notifications: view.preview.notifications.length,
    emails: view.preview.emails.length,
    requests: view.preview.requests.length,
    milestones: view.preview.milestones.length,
    approverId:
      view.status === "waiting_approval" && personId && visible(personId) ? personId : null,
    stoppedAtClaude: !TERMINAL.has(view.status) && view.current?.kind === "claude",
  };
}

export function createTrialRunner(
  deps: TrialDeps,
  opts: { visible?: (personId: string) => boolean } = {},
) {
  const visible = opts.visible ?? (() => false);
  return {
    async run(code: string): Promise<TrialRun> {
      try {
        const automationId = await deps.automationIdOf(code);
        if (!automationId) return { status: "skipped" };
        const [trigger, examples] = await Promise.all([
          deps.draftTrigger(automationId),
          deps.listExamples(automationId),
        ]);
        const passes = examples.find((e) => passesStartFilter(trigger, e.event));
        const fails = hasFilter(trigger)
          ? examples.find((e) => !passesStartFilter(trigger, e.event))
          : undefined;
        const results: TrialResult[] = [];
        for (const e of [passes, fails]) {
          if (!e) continue;
          const simId = await deps.start(automationId, e.event);
          const view = await advance(deps, simId);
          if (!view) continue;
          results.push({
            ...outcomeOf(simId, view, visible),
            label: { key: "claude.trial.example", params: { code: e.code ?? "", title: e.label } },
            written: false,
          });
        }
        const first = passes ? (results[0] ?? null) : null;
        return {
          status: "done",
          automationId,
          code,
          wants: hasFilter(trigger) ? ["passes", "fails"] : ["passes"],
          results,
          openSimId:
            first && first.status !== "filtered_out" && first.status !== "failed"
              ? first.simId
              : null,
        };
      } catch {
        return { status: "skipped" };
      }
    },
  };
}

// --- il cablaggio nella conversazione -------------------------------------------

type GroupView = Reader<ClaudeActionGroupView>;

/** Le dipendenze vere: le automazioni e la simulazione del renderer (`automationsLive.ts`). */
function liveRunner() {
  const deps: TrialDeps = {
    automationIdOf: async (code) =>
      (await liveAutomations.listAutomations({})).find((a) => a.code === code)?.id ?? null,
    draftTrigger: async (id) => {
      const detail = await liveAutomations.getAutomation(id);
      const last = detail?.automation.versions.at(-1);
      if (!last) throw new Error("not_found");
      return last.flow.trigger as AutomationTrigger;
    },
    listExamples: (id) => liveAutomations.listSimulationExamples(id, "draft"),
    start: (id, event) => liveAutomations.startSimulation(id, "draft", event),
    step: (simId) => liveAutomations.simulationStep(simId, { kind: "next" }) as Promise<TrialSim>,
    get: (simId) => liveAutomations.getSimulation(simId) as Promise<TrialSim | null>,
  };
  return {
    async run(code: string): Promise<TrialRun> {
      // Chi approverebbe, per nome, solo se chi chiede lo vede (R-G5).
      const seen = new Set((await listPeople().catch(() => [])).map((p) => p.id));
      return createTrialRunner(deps, { visible: (id) => seen.has(id) }).run(code);
    },
  };
}

let makeRunner: () => { run(code: string): Promise<TrialRun> } = liveRunner;

/** Per i test: un runner finto (`null` rimette quello vero). */
export function setTrialRunnerForTests(
  make: (() => { run(code: string): Promise<TrialRun> }) | null,
): void {
  makeRunner = make ?? liveRunner;
}

interface Cached {
  run: TrialRun | null;
  promise: Promise<TrialRun>;
}

/**
 * Le prove, PER PERSONA e per gruppo: una prova si fa una volta in questa
 * finestra (le sue simulazioni vivono qui, e la riga le apre). Riaperta la
 * conversazione in un'altra finestra si rifà: non crea niente, e il
 * riquadro non naviga su una conversazione letta (`pageActions.ts`).
 */
const trialsByPerson = new Map<string, Map<string, Cached>>();

function trialsOfMe(): Map<string, Cached> {
  const me = session.personId ?? "";
  let map = trialsByPerson.get(me);
  if (!map) trialsByPerson.set(me, (map = new Map()));
  return map;
}

/** Cambio di persona o test: via le prove. */
export function forgetTrials(): void {
  trialsByPerson.clear();
}

/** Il codice dell'automazione che il gruppo ha creato, se ne ha creata una. */
function createdCodeOf(g: GroupView | undefined): string | null {
  const a = g?.actions.find((x) => x.fn === "createAutomation");
  return a?.codes[0] ?? null;
}

function cachedFor(groupId: string, code: string, onSettled?: () => void): Cached {
  const map = trialsOfMe();
  let c = map.get(groupId);
  if (!c) {
    const entry: Cached = { run: null, promise: Promise.resolve({ status: "skipped" }) };
    entry.promise = makeRunner()
      .run(code)
      .catch((): TrialRun => ({ status: "skipped" }))
      .then((run) => {
        entry.run = run;
        onSettled?.();
        return run;
      });
    map.set(groupId, (c = entry));
  }
  return c;
}

function trialEvent(groupId: string, at: string, run: TrialRun | null): ConversationEvent {
  const base = { id: `trial:${groupId}`, at, type: "trial" as const };
  if (!run) return { ...base, status: "pending", wants: ["passes"] } as ConversationEvent;
  if (run.status === "skipped")
    return { ...base, status: "skipped", wants: ["passes"] } as ConversationEvent;
  return {
    ...base,
    status: "done",
    wants: run.wants,
    automationId: run.automationId,
    code: run.code,
    results: run.results,
    openSimId: run.openSimId,
  } as ConversationEvent;
}

/**
 * Area 10, F2 (S1): dopo ogni riga eseguita che ha creato un'automazione, la
 * riga della prova (`trial`), solo per l'autore della conversazione (la
 * prova la fa chi ha chiesto la bozza). In attesa finché la prova non è
 * finita; `onSettled` dice quando rileggere.
 */
export function withTrialEvents(
  extra: ConversationEvent[],
  groups: readonly GroupView[],
  owner: boolean,
  onSettled?: () => void,
): ConversationEvent[] {
  if (!owner) return extra;
  return extra.flatMap((e) => {
    if (e.type !== "executed") return [e];
    const code = createdCodeOf(groups.find((g) => g.id === e.groupId));
    if (!code) return [e];
    return [e, trialEvent(e.groupId, e.at, cachedFor(e.groupId, code, onSettled).run)];
  });
}

/** Lo stesso, aspettando le prove (il dettaglio della conversazione). */
export async function withSettledTrialEvents(
  extra: ConversationEvent[],
  groups: readonly GroupView[],
  owner: boolean,
): Promise<ConversationEvent[]> {
  if (!owner) return extra;
  const pending: Promise<TrialRun>[] = [];
  for (const e of extra) {
    if (e.type !== "executed") continue;
    const code = createdCodeOf(groups.find((g) => g.id === e.groupId));
    if (code) pending.push(cachedFor(e.groupId, code).promise);
  }
  await Promise.all(pending);
  return withTrialEvents(extra, groups, owner);
}
