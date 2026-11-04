import type { T } from "../../domain/claude/context";
import i18n from "../../i18n";
import { pickTrialExamples } from "../automations/examples";
import { trialAs } from "../automations/simulate";
import type { Automation, EventDraft, ScriptStep } from "../model";
import { PEOPLE } from "../seed/people";
import { state } from "../store";
import type { ExecutedDraft } from "./actions";

// La prova di Claude nel flusso della libera (area 10b, S1): dopo che
// `prepareExecuted` ha creato la bozza, `freeTurn` la prova qui sugli esempi
// scelti, senza effetti (`trialAs` scrive solo la prova in memoria e il
// `testedRev` della bozza, come la prova a mano). Sta in `data/claude/`
// perché il controllo «Claude non accende mai un'automazione»
// (`neverInCatalog.test.ts`) la copra: è l'unico codice di Claude che scrive
// su un'automazione fuori dal catalogo.

type TrialDraft = Extract<EventDraft, { type: "trial" }>;
type TrialResult = NonNullable<TrialDraft["results"]>[number];

/** Un esempio che la fa partire: né escluso dal filtro dell'inizio, né fallito. */
const trialPasses = (r: TrialResult) => r.status !== "filtered_out" && r.status !== "failed";

/**
 * Area 10b (S1): le prove `pending` del motore, dopo `prepareExecuted`. Ogni
 * prova riguarda l'`executed` che la precede: se ha creato un'automazione
 * (`done`), Claude ne sceglie gli esempi (`pickTrialExamples`) e la prova su
 * ognuno (`trialAs`, senza effetti), poi dice l'esito del primo che passa e
 * che è spenta. Se non è partita o è diventata una scheda, la prova è
 * `skipped` e non dice niente. Le prove sono a nome di chi chiede, come la
 * creazione.
 */
export function prepareTrials(
  me: string,
  input: ScriptStep[],
  prepared: { steps: ScriptStep[]; executed: Map<ScriptStep, ExecutedDraft | null> },
): ScriptStep[] {
  const resolved = new Map<ScriptStep, ScriptStep[]>();
  let before: ScriptStep | null = null;
  for (const step of input) {
    if (step.step !== "event") continue;
    if (step.event.type === "executed" && step.event.status === "pending") before = step;
    if (step.event.type !== "trial" || step.event.status !== "pending") continue;
    const created = before ? (prepared.executed.get(before) ?? null) : null;
    resolved.set(step, trialSteps(me, step.event, created));
  }
  return prepared.steps.flatMap((s) => resolved.get(s) ?? [s]);
}

function trialSteps(me: string, trial: TrialDraft, created: ExecutedDraft | null): ScriptStep[] {
  const skipped: ScriptStep[] = [{ step: "event", event: { ...trial, status: "skipped" } }];
  if (!created || created.status !== "done") return skipped;
  const ref = state.claudeActions
    .filter((r) => r.groupId === created.groupId)
    .flatMap((r) => r.objects)
    .find((o) => o.kind === "automation");
  const a = ref && state.automations.find((x) => x.id === ref.id);
  if (!a) return skipped;
  let results: TrialResult[];
  try {
    results = pickTrialExamples(me, a.id, trial.wants).flatMap((example) =>
      // Un esempio che Claude non è riuscito a scrivere non si prova (T3).
      example
        ? [{ ...trialAs(me, a.id, example.event), label: example.label, written: example.written }]
        : [],
    );
  } catch {
    return skipped;
  }
  const first = results.find(trialPasses) ?? null;
  const t = i18n.t.bind(i18n) as T;
  return [
    {
      step: "event",
      event: {
        ...trial,
        status: "done",
        automationId: a.id,
        code: a.code,
        results,
        openSimId: first?.simId ?? null,
      },
    },
    { step: "say", text: trialOutcome(t, a, first) },
    { step: "say", text: t("claude.answers.automation.off") },
  ];
}

/**
 * La frase dell'esito, dal primo esempio che passa: i conteggi maggiori di
 * zero nell'ordine «task · email · avvisi · richieste · traguardi», le
 * persone contate e non nominate ([AU 5]), e l'approvazione che la fermerebbe
 * col nome di chi approva, se chi chiede lo vede (R-G5).
 */
function trialOutcome(t: T, a: Automation, first: TrialResult | null): string {
  const K = "claude.answers.automation.outcome";
  if (!first) return t(`${K}.none`);
  const flow = a.versions.at(-1)!.flow;
  const taskStep = flow.steps.find((s) => s.kind === "createTask");
  const assignee = taskStep?.kind === "createTask" ? taskStep.assignee : null;
  const department =
    assignee && "departmentId" in assignee
      ? state.departments.find((d) => d.id === assignee.departmentId)?.name
      : undefined;
  const parts: string[] = [];
  if (first.tasks > 0) {
    parts.push(
      first.tasks === 1 && department
        ? t(`${K}.task`, { department })
        : t(`${K}.tasks`, { count: first.tasks }),
    );
  }
  if (first.emails > 0) parts.push(t(`${K}.emails`, { count: first.emails }));
  if (first.notifications > 0) {
    parts.push(t(`${K}.notifications`, { count: first.notifications }));
  }
  if (first.requests > 0) parts.push(t(`${K}.requests`, { count: first.requests }));
  if (first.milestones > 0) parts.push(t(`${K}.milestones`, { count: first.milestones }));
  const waiting = first.status === "waiting_approval";
  const name = first.approverId ? PEOPLE.find((p) => p.id === first.approverId)?.name : undefined;
  if (parts.length === 0) {
    if (!waiting) return t(`${K}.nothing`);
    return name ? t(`${K}.waitOnlyFor`, { name }) : t(`${K}.waitOnlyAny`);
  }
  const wait = !waiting ? "" : name ? t(`${K}.waitFor`, { name }) : t(`${K}.waitAny`);
  const list = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(parts);
  const sentence = t(`${K}.sentence`, { parts: list, wait });
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
