import { visitSteps } from "../../domain/automations/fields";
import { clientDataFlow, newContractFlow } from "../seed/automations/automations";
import { copy } from "../store";
import type { AutomationFlow, Step } from "../types";

// I due modelli di «New automation» (shape builder §«Modelli», [A 20]): i
// flussi dei due esempi del seme, con le scelte personali VUOTE — la
// sorgente dell'inizio, le persone che approvano, i reparti — così arrivano
// già segnate come problemi da completare, mai riempite con persone o
// reparti del seme. «Chiede al proprietario» e i ruoli nel progetto non sono
// scelte personali e restano. La casella si sceglie accendendo.
//
// I testi (oggetti, corpi, istruzioni, uscite, campi di Claude) seguono la
// lingua di chi crea: italiano come il seme, o inglese. Le etichette dei
// dati delle sorgenti sono del seme e restano come sono.

export type AutomationTemplateKind = "newContract" | "askClient";

/** I testi inglesi dei due modelli, per testo italiano del seme. */
const EN: Record<string, string> = {
  "Nuovo contratto – {{cliente.nome}}": "New contract – {{cliente.nome}}",
  "Leggi il contratto e i prodotti venduti. Indica il prodotto principale e l'elenco delle task di attivazione, ciascuna col reparto che se ne occupa (Sales, Support, Development o Administration).":
    "Read the contract and the products sold. Name the main product and list the activation tasks, each with the department that handles it (Sales, Support, Development or Administration).",
  "Prodotto principale": "Main product",
  "Task di attivazione": "Activation tasks",
  Titolo: "Title",
  Reparto: "Department",
  "Attivazione {{analisi.prodotto}} – {{cliente.nome}}":
    "Activation of {{analisi.prodotto}} – {{cliente.nome}}",
  "Dal contratto «{{trattativa.titolo}}» con {{cliente.nome}}.":
    "From the contract “{{trattativa.titolo}}” with {{cliente.nome}}.",
  "Benvenuti in Audin, {{cliente.nome}}": "Welcome to Audin, {{cliente.nome}}",
  "Gentile {{cliente.nome}},\n\ngrazie per averci scelto. Nei prossimi giorni il nostro team vi contatterà per l'attivazione di {{analisi.prodotto}}.\n\nA presto,\nil team Audin":
    "Dear {{cliente.nome}},\n\nthank you for choosing us. In the next few days our team will contact you to activate {{analisi.prodotto}}.\n\nBest regards,\nthe Audin team",
  "Dati per {{richiesta.funzione}} – {{cliente.nome}}":
    "Data for {{richiesta.funzione}} – {{cliente.nome}}",
  "Ci servono alcuni dati per attivare {{richiesta.funzione}}":
    "We need some information to activate {{richiesta.funzione}}",
  "Gentile {{cliente.nome}},\n\nper attivare {{richiesta.funzione}} ci servono: {{richiesta.dati}}\n\nPuò rispondere direttamente a questa email.\n\nGrazie,\nil team Audin":
    "Dear {{cliente.nome}},\n\nto activate {{richiesta.funzione}} we need: {{richiesta.dati}}\n\nYou can reply directly to this email.\n\nThank you,\nthe Audin team",
  "Promemoria: dati per attivare {{richiesta.funzione}}":
    "Reminder: information to activate {{richiesta.funzione}}",
  "Gentile {{cliente.nome}},\n\nle ricordiamo che per attivare {{richiesta.funzione}} ci servono: {{richiesta.dati}}\n\nGrazie,\nil team Audin":
    "Dear {{cliente.nome}},\n\na reminder that to activate {{richiesta.funzione}} we need: {{richiesta.dati}}\n\nThank you,\nthe Audin team",
  "Chiamare {{cliente.nome}}: nessuna risposta alla richiesta dati":
    "Call {{cliente.nome}}: no reply to the information request",
  "Dopo la richiesta e due promemoria il cliente non ha risposto. Dati richiesti: {{richiesta.dati}}":
    "After the request and two reminders the client hasn't replied. Information requested: {{richiesta.dati}}",
  "Attivare {{richiesta.funzione}} per {{cliente.nome}}":
    "Activate {{richiesta.funzione}} for {{cliente.nome}}",
  "Il cliente ha mandato tutto: {{risposta.testo}}":
    "The client sent everything: {{risposta.testo}}",
  "Confronta la risposta del cliente con i dati richiesti. Rispondi «tutto presente» se c'è tutto, altrimenti «mancano informazioni» e scrivi cosa manca.":
    "Compare the client's reply with the information requested. Answer “all present” if everything is there, otherwise “something is missing” and write what is missing.",
  "tutto presente": "all present",
  "mancano informazioni": "something is missing",
  "Cosa manca": "What is missing",
  "Mancano ancora alcuni dati per {{richiesta.funzione}}":
    "Some information for {{richiesta.funzione}} is still missing",
  "Gentile {{cliente.nome}},\n\ngrazie della risposta. Per completare l'attivazione ci mancano: {{verifica.mancanti}}\n\nGrazie,\nil team Audin":
    "Dear {{cliente.nome}},\n\nthank you for your reply. To complete the activation we still need: {{verifica.mancanti}}\n\nThank you,\nthe Audin team",
  "Completare i dati di {{cliente.nome}} con una telefonata":
    "Complete {{cliente.nome}}'s information with a phone call",
  "Mancano ancora: {{verifica.mancanti}}": "Still missing: {{verifica.mancanti}}",
};

/** Traduce i testi di un passo (e i nomi delle uscite di Claude coi loro rami). */
function translate(step: Step): void {
  const tr = (s: string) => EN[s] ?? s;
  const rec = step as unknown as Record<string, unknown>;
  for (const k of ["title", "description", "name", "subject", "body", "instruction"])
    if (typeof rec[k] === "string") rec[k] = tr(rec[k] as string);
  if (step.kind === "claude") {
    step.outcomes = step.outcomes.map(tr);
    step.branches = Object.fromEntries(Object.entries(step.branches).map(([k, v]) => [tr(k), v]));
    step.fields = step.fields.map((f) => ({
      ...f,
      label: tr(f.label),
      of: f.of?.map((x) => ({ ...x, label: tr(x.label) })),
    }));
  }
}

export function templateFlow(kind: AutomationTemplateKind, language = "it"): AutomationFlow {
  const flow = copy(
    kind === "newContract"
      ? newContractFlow("Benvenuti in Audin, {{cliente.nome}}")
      : clientDataFlow,
  );
  if (flow.trigger.kind === "source") flow.trigger = { ...flow.trigger, sourceId: "" };
  visitSteps(flow.steps, (step) => {
    // Le persone che approvano sono scelte personali: vuote. Il proprietario resta.
    if ("approval" in step && step.approval.mode === "ask" && "personId" in step.approval.who)
      step.approval = { mode: "ask", who: { personId: "" } };
    if (step.kind === "createTask" && step.assignee && "departmentId" in step.assignee)
      step.assignee = { departmentId: "" };
  });
  if (language.startsWith("en")) {
    flow.titleTemplate = EN[flow.titleTemplate] ?? flow.titleTemplate;
    visitSteps(flow.steps, translate);
  }
  return flow;
}
