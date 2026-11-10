import { z } from "zod";

/**
 * Una voce di Claude in «Da decidere» (integrazione area 3, fetta 3b), nella
 * forma `ConversationClaudeDecision` del prototipo: un piano che aspetta chi
 * guarda (con `plans.approve` nel progetto) o una domanda aperta a cui può
 * rispondere (il richiedente del job o `plans.approve`). La calcola il server
 * coi permessi di chi guarda: il client la legge, non la deduce.
 *
 * Forma PIATTA (un `kind` e campi facoltativi), non un'unione discriminata:
 * `readerSchema` non attraversa le unioni discriminate, e l'app parsa così.
 */
export const claudeDecisionViewSchema = z.object({
  /** `<job>:plan` o `<job>:<domanda>`. */
  id: z.string(),
  kind: z.enum(["question", "plan"]),
  /** La sessione dell'agente del job, se c'è (il prototipo la chiama conversazione). */
  conversationId: z.uuid().nullable().default(null),
  conversationKind: z.enum(["task_run"]).default("task_run"),
  /** Il titolo della task. */
  title: z.string(),
  /** Chi ha avviato il lavoro; `null` se il sistema o un utente eliminato. */
  ownerId: z.uuid().nullable().default(null),
  projectId: z.uuid(),
  taskId: z.uuid(),
  requestId: z.uuid().nullable().default(null),
  /** `<PROGETTO>-<n>`. */
  objectCode: z.string().nullable().default(null),
  /** Quando Claude ha chiesto (la domanda) o ha consegnato il piano. */
  at: z.iso.datetime(),
  // --- solo `question`
  questionId: z.uuid().optional(),
  text: z.string().optional(),
  options: z
    .array(z.object({ label: z.string(), consequence: z.string().optional(), recommended: z.boolean().default(false) }))
    .optional(),
  // --- solo `plan`
  /** Il job del piano: la decisione vale solo per questo piano. */
  planId: z.uuid().optional(),
  summary: z.string().optional(),
  /** Solo la correzione di un server (area 8b) lo usa: qui sempre `null`. */
  blockedReason: z.string().nullable().default(null),
  serverCode: z.string().nullable().default(null),
  /** Il dettaglio del ticket nel web vecchio, dove si decide oggi. */
  webHref: z.string(),
});
export type ClaudeDecisionView = z.infer<typeof claudeDecisionViewSchema>;
