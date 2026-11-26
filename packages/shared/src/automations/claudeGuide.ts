import { AUTOMATION_F4_AVAILABILITY } from "./availability.js";
import { STUBWISE_TRIGGER_FIELDS } from "./triggerFields.js";
import type { AutomationFlow } from "./types.js";

/**
 * Area 10, F2 (S1): come è fatto un flusso, per Claude. Il contratto della
 * chat lo porta accanto alle firme delle azioni: senza, il modello inventa la
 * forma dell'inizio (il golden `chat-s1-automation` del 19 nov 2026 proponeva
 * `trigger: { kind: "support.request" }`). Gli eventi e i campi vengono dal
 * motore (`STUBWISE_TRIGGER_FIELDS`), l'esempio è un `AutomationFlow` tipato che
 * `claudeGuide.test.ts` fa validare al motore: la guida non diverge dai tipi.
 */

/** Il posto del reparto nell'esempio: Claude lo sostituisce con l'id da `list_departments`. */
export const CLAUDE_GUIDE_DEPARTMENT_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

export const CLAUDE_AUTOMATION_EXAMPLE: AutomationFlow = {
  titleTemplate: "Urgente: {{richiesta.titolo}}",
  trigger: {
    kind: "stubwise",
    event: "request_created",
    filter: {
      all: [
        { left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "high" } },
        { left: { ref: "richiesta.dal_supporto" }, op: "is", right: { value: true } },
      ],
    },
  },
  steps: [
    {
      id: "s1",
      kind: "notify",
      who: { departmentId: CLAUDE_GUIDE_DEPARTMENT_PLACEHOLDER },
      text: "Richiesta urgente dal supporto: {{richiesta.codice}} — {{richiesta.titolo}}",
      approval: { mode: "auto" },
    },
  ],
};

/** Gli eventi di Stubwise che la build offre, coi loro campi (`chiave (tipo)`). */
function eventLines(): string[] {
  const offered = new Set(AUTOMATION_F4_AVAILABILITY.triggers);
  return Object.entries(STUBWISE_TRIGGER_FIELDS)
    .filter(([event]) => offered.has(`stubwise:${event}` as never))
    .map(([event, fields]) => `  - ${event}: ${fields.map((f) => `${f.key} (${f.type})`).join(", ")}`);
}

export function claudeAutomationGuide(): string {
  return [
    "AUTOMATION FLOWS (the `flow` of createAutomation and saveAutomationDraft)",
    "- A flow is { titleTemplate, trigger, steps }. titleTemplate names each run and may use {{field}}.",
    '- trigger: { kind: "manual" }, or { kind: "stubwise", event, filter? } with one of these events and the fields it gives:',
    ...eventLines(),
    '  Urgency is "low" | "medium" | "high"; dal_supporto is true when the request came from support.',
    '- filter and the `when` of a condition: { left: { ref: "<field>" }, op, right: { value } }, with op one of is, is_not, contains, empty, not_empty, gt, lt; combine with { all: [...] } or { any: [...] }.',
    "- steps, each with a unique id and approval: { mode: \"auto\" }:",
    '  - notify: { kind: "notify", who: { departmentId } | { personId } | { projectRole }, text }. The department id comes from list_departments, the person id from list_people.',
    '  - createTask: { kind: "createTask", title, description, assignee: null | { personId } | { departmentId } | { projectRole }, dueInDays: null | number, project: { mode: "own" }, milestoneRef: null }',
    '  - createRequest: { kind: "createRequest", title, description, project: { mode: "own" } }',
    '  - createMilestone: { kind: "createMilestone", name, dueInDays: null | number, project: { mode: "own" } }',
    '  - condition: { kind: "condition", when, then: [steps], else: [steps] }',
    "- Texts may use {{field}} of the trigger. Stubwise checks the flow before the card: if it answers with errors, fix the flow, do not guess.",
    `- Example, notify a department of urgent requests from support (put the real department id instead of ${CLAUDE_GUIDE_DEPARTMENT_PLACEHOLDER}):`,
    `  ${JSON.stringify(CLAUDE_AUTOMATION_EXAMPLE)}`,
  ].join("\n");
}
