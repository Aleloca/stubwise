import { z } from "zod";

export const ticketStatusSchema = z.enum([
  "open",
  "triaged",
  "in_progress",
  "in_review",
  "done",
  "closed",
]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const ticketTypeSchema = z.enum(["bug", "feature", "task", "feedback"]);
export type TicketType = z.infer<typeof ticketTypeSchema>;

export const ticketPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const ticketSourceSchema = z.enum(["manual", "sdk_error", "sdk_feedback", "api"]);
export type TicketSource = z.infer<typeof ticketSourceSchema>;

/**
 * Stima di sforzo di un ticket: intero 1–5, prodotto dal triage e usato dal
 * gate di automazione (auto-fix solo se `effort <= maxEffort`). La scala e le
 * etichette italiane sono l'unica fonte di verità, condivise tra worker
 * (prompt), server (validazione) e web (UI).
 */
export const effortSchema = z.number().int().min(1).max(5);
export type Effort = z.infer<typeof effortSchema>;

/** Etichette italiane della scala di sforzo, indicizzate per valore 1–5. */
export const EFFORT_LABELS: Record<number, string> = {
  1: "Banale",
  2: "Piccolo",
  3: "Medio",
  4: "Grande",
  5: "Molto grande",
};
