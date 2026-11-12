import { z } from "zod";

/**
 * LE PROPOSTE DELLA POSTA, CONDIVISE (area 6, fetta 2, D4): una proposta per
 * email (Message-ID) e progetto, vista dai destinatari in Stubwise membri del
 * progetto, chiusa per tutti dal primo che decide. È la forma di
 * `GET /api/me/mail/proposals` (elenco e per id) e dei suoi esiti.
 *
 * I permessi (`canConfirm`, `canHand`, `canReassign`, `blockedIndices`) e chi
 * manca nel progetto (`outsiders`) li calcola il SERVER: il client li legge,
 * non li deduce. Ogni campo oltre l'identità nasce con un default.
 */

/** I tipi d'azione che una proposta della posta porta. */
export const mailProposalActionTypeSchema = z.enum([
  "create_task",
  "create_backlog_item",
  "update_ticket",
  "comment_ticket",
  "create_milestone",
  "record_decision",
  "choose_project",
]);
export type MailProposalActionType = z.infer<typeof mailProposalActionTypeSchema>;

/**
 * Un'azione proposta. `args` dipende dal tipo (vedi il piano della F2, §4):
 * `create_task` {title, description, assigneeId, dueDate}, `create_backlog_item`
 * {title, description}, `update_ticket` {ticketId, patch}, `comment_ticket`
 * {ticketId, body}, `create_milestone` {name, dueDate}, `record_decision`
 * {ticketId?}, `choose_project` {projectIds}. `label` è già in parole.
 */
export const mailProposalActionSchema = z.object({
  type: mailProposalActionTypeSchema,
  args: z.record(z.string(), z.unknown()).default({}),
  label: z.string().default(""),
});
export type MailProposalAction = z.infer<typeof mailProposalActionSchema>;

/** Una persona come la proposta la mostra (mai l'email). */
export const mailProposalPersonSchema = z.object({ userId: z.uuid(), name: z.string() });

/** Cosa è nato da una conferma: una task, una richiesta, … col suo codice. */
export const mailProposalResultSchema = z.object({
  kind: z.enum(["task", "request", "milestone", "comment", "decision", "ticket_update"]),
  id: z.string(),
  code: z.string().nullable().default(null),
});

/** Da dove viene la proposta, per la riga d'origine in «Da decidere». */
export const mailProposalOriginSchema = z.object({
  threadId: z.string(),
  accountId: z.uuid(),
  from: z.string(),
  subject: z.string().nullable().default(null),
});

export const mailProposalStatusSchema = z.enum(["open", "confirmed", "ignored", "handed", "failed"]);
export type MailProposalStatus = z.infer<typeof mailProposalStatusSchema>;

export const mailProposalSchema = z.object({
  id: z.uuid(),
  /** `email_messages.id` del messaggio, nella casella di chi guarda. */
  messageId: z.uuid(),
  projectId: z.uuid(),
  status: mailProposalStatusSchema,
  createdAt: z.string(),
  /** L'estratto letto dal modello. NON FIDATO. */
  excerpt: z.string().default(""),
  actions: z.array(mailProposalActionSchema).default([]),
  canConfirm: z.boolean().default(false),
  canHand: z.boolean().default(false),
  canReassign: z.boolean().default(false),
  /** Gli indici delle azioni che chi guarda non può confermare. */
  blockedIndices: z.array(z.number().int()).default([]),
  /** Incaricati proposti che NON sono membri del progetto. */
  outsiders: z.array(mailProposalPersonSchema).default([]),
  decidedBy: mailProposalPersonSchema.nullable().default(null),
  decidedAt: z.string().nullable().default(null),
  /** La conferma parziale: le azioni eseguite (vuoto = tutte o nessuna). */
  confirmedIndices: z.array(z.number().int()).default([]),
  results: z.array(mailProposalResultSchema).default([]),
  error: z.string().nullable().default(null),
  handedAt: z.string().nullable().default(null),
  handedBy: mailProposalPersonSchema.nullable().default(null),
  /** Gli ALTRI destinatari membri che la vedono (mai i ccn). */
  sharedWith: z.array(mailProposalPersonSchema).default([]),
  origin: mailProposalOriginSchema.nullable().default(null),
});
export type MailProposal = z.infer<typeof mailProposalSchema>;

export const mailProposalListSchema = z.object({ items: z.array(mailProposalSchema) });
export type MailProposalList = z.infer<typeof mailProposalListSchema>;
