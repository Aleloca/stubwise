import { visitSteps } from "../../domain/automations/fields";
import { clientDataFlow, newContractFlow } from "../seed/automations/automations";
import { copy } from "../store";
import type { AutomationFlow } from "../types";

// I due modelli di «New automation» (shape builder §«Modelli», [A 20]): i
// flussi dei due esempi del seme, con le scelte personali VUOTE — la
// sorgente dell'inizio, chi approva, i reparti — così arrivano già segnate
// come problemi da completare, mai riempite con persone o reparti del seme.
// La casella si sceglie accendendo (non sta nel flusso). I ruoli nel
// progetto («il Project Lead») non sono scelte personali e restano.

export type AutomationTemplateKind = "newContract" | "askClient";

export function templateFlow(kind: AutomationTemplateKind): AutomationFlow {
  const flow = copy(
    kind === "newContract"
      ? newContractFlow("Benvenuti in Audin, {{cliente.nome}}")
      : clientDataFlow,
  );
  if (flow.trigger.kind === "source") flow.trigger = { ...flow.trigger, sourceId: "" };
  visitSteps(flow.steps, (step) => {
    if ("approval" in step && step.approval.mode === "ask")
      step.approval = { mode: "ask", who: { personId: "" } };
    if (step.kind === "createTask" && step.assignee && "departmentId" in step.assignee)
      step.assignee = { departmentId: "" };
  });
  return flow;
}
