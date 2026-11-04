import type { AutomationFlow, Condition, Step } from "../../data/types";
import type { T } from "../claude/context";

// La bozza che Claude scrive da una frase (area 10b, S1): solo i blocchi che
// il motore sa fare, niente di inventato. Il filtro sta sull'inizio (D3,
// maintainer); i passi «Parte da solo», tranne l'email, che «Chiede
// approvazione al proprietario»: un'email al cliente non parte mai da sola
// da una bozza scritta da Claude. Puro: i testi dei passi li scrive `t`
// nella lingua di chi chiede, come li scriverebbe la persona a mano; i dati
// dell'evento restano riferimenti (`{{richiesta.titolo}}`).

/** Ciò che Claude ha capito della frase: l'evento, il filtro, i passi in ordine. */
export interface FlowSpec {
  event: "request_created";
  when: { fromSupport?: boolean; urgency?: "low" | "medium" | "high" };
  steps: (
    | { kind: "createTask"; departmentId: string; dueInDays: number }
    | { kind: "notify"; departmentId: string }
    | { kind: "sendEmail" }
  )[];
}

const AUTO = { mode: "auto" } as const;
const ref = (key: string) => `{{richiesta.${key}}}`;

/** Il titolo di ogni esecuzione: il codice e il titolo della richiesta. */
export const RUN_TITLE = `${ref("codice")} ${ref("titolo")}`;

/** Il filtro dell'inizio: una condizione per dato chiesto, tutte insieme; nessuna, nessun filtro. */
function startFilter(when: FlowSpec["when"]): Condition | undefined {
  const all: Condition[] = [];
  if (when.urgency) {
    all.push({ left: { ref: "richiesta.urgenza" }, op: "is", right: { value: when.urgency } });
  }
  if (when.fromSupport !== undefined) {
    all.push({
      left: { ref: "richiesta.dal_supporto" },
      op: "is",
      right: { value: when.fromSupport },
    });
  }
  return all.length > 0 ? { all } : undefined;
}

/** Il flusso coi soli blocchi del motore: il filtro sull'inizio (D3, maintainer), passi «Parte da solo», l'email «Chiede approvazione al proprietario». */
export function draftFlow(spec: FlowSpec, t: T): AutomationFlow {
  const K = "claude.answers.automation.flow";
  const urgent = spec.when.urgency === "high";
  const filter = startFilter(spec.when);
  const steps: Step[] = spec.steps.map((s, i): Step => {
    const id = `claude-${i + 1}`;
    switch (s.kind) {
      case "createTask":
        return {
          id,
          kind: "createTask",
          title: ref("titolo"),
          description: ref("descrizione"),
          assignee: { departmentId: s.departmentId },
          dueInDays: s.dueInDays,
          project: { mode: "own" },
          milestoneRef: null,
          approval: AUTO,
        };
      case "notify":
        return {
          id,
          kind: "notify",
          who: { departmentId: s.departmentId },
          text: t(urgent ? `${K}.noticeUrgent` : `${K}.notice`, { title: ref("titolo") }),
          approval: AUTO,
        };
      case "sendEmail":
        return {
          id,
          kind: "sendEmail",
          to: ref("richiedente"),
          subject: ref("titolo"),
          body: t(`${K}.emailBody`),
          attachRefs: [],
          approval: { mode: "ask", who: { owner: true } },
        };
    }
  });
  return {
    trigger: { kind: "stubwise", event: spec.event, ...(filter ? { filter } : {}) },
    steps,
    titleTemplate: RUN_TITLE,
  };
}
