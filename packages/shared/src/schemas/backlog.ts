import { z } from "zod";
import { effortSchema, ticketPrioritySchema } from "./ticket.js";

/**
 * Ciclo di vita di una voce del backlog di discovery: `new` (appena intaccata,
 * in attesa di intake), `refining` (in raffinamento via chat), `ready` (pronta
 * alla conversione in ticket), `converted` (già trasformata in ticket) o
 * `archived` (scartata). L'enum Postgres deriva da questo schema: valori e
 * validazione non possono divergere.
 */
export const backlogItemStatusSchema = z.enum([
  "new",
  "refining",
  "ready",
  "converted",
  "archived",
]);
export type BacklogItemStatus = z.infer<typeof backlogItemStatusSchema>;

/** Livello di rischio stimato per l'implementazione di una voce del backlog. */
export const backlogRiskSchema = z.enum(["low", "medium", "high"]);
export type BacklogRisk = z.infer<typeof backlogRiskSchema>;

/** L'urgenza riusa la scala di priority dei ticket (low/medium/high/urgent). */
export const backlogUrgencySchema = ticketPrioritySchema;

/** Origine di una voce del backlog: deviata da un ticket o creata a mano. */
export const backlogItemSourceSchema = z.enum(["ticket", "manual"]);
export type BacklogItemSource = z.infer<typeof backlogItemSourceSchema>;

/**
 * Tipo di job del backlog: `intake` (prima elaborazione di una voce: dedup +
 * metadati suggeriti) o `deep_dive` (approfondimento sul repo collegato).
 */
export const backlogJobKindSchema = z.enum(["intake", "deep_dive"]);
export type BacklogJobKind = z.infer<typeof backlogJobKindSchema>;

/** Stato di un job del backlog nella coda del worker. */
export const backlogJobStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type BacklogJobStatus = z.infer<typeof backlogJobStatusSchema>;

/**
 * Metadati suggeriti dall'AI in attesa di conferma umana. Restano separati dai
 * campi confermati sulla voce (effort/risk/urgency): l'umano li promuove
 * esplicitamente durante il raffinamento.
 */
export const backlogSuggestedSchema = z.object({
  effort: effortSchema.optional(),
  risk: backlogRiskSchema.optional(),
  riskNote: z.string().optional(),
  urgency: backlogUrgencySchema.optional(),
  reason: z.string().optional(),
});
export type BacklogSuggested = z.infer<typeof backlogSuggestedSchema>;

/**
 * Aggiornamento parziale di una voce del backlog. I campi valorizzabili sono
 * nullable (per azzerarli) e opzionali (per non toccarli).
 */
export const updateBacklogItemSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  status: backlogItemStatusSchema.optional(),
  effort: effortSchema.nullable().optional(),
  risk: backlogRiskSchema.nullable().optional(),
  riskNote: z.string().nullable().optional(),
  urgency: backlogUrgencySchema.nullable().optional(),
});
export type UpdateBacklogItemInput = z.infer<typeof updateBacklogItemSchema>;

/** Creazione manuale di una voce del backlog (non deviata da un ticket). */
export const createBacklogItemSchema = z.object({
  projectId: z.uuid(),
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
});
export type CreateBacklogItemInput = z.infer<typeof createBacklogItemSchema>;
