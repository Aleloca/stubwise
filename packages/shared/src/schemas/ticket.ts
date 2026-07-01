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

export const ticketTypeSchema = z.enum(["bug", "feature", "task", "feedback", "review"]);
export type TicketType = z.infer<typeof ticketTypeSchema>;

export const ticketPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const ticketSourceSchema = z.enum([
  "manual",
  "sdk_error",
  "sdk_feedback",
  "api",
  "slack",
  "webhook",
]);
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

/**
 * Stato della PR aperta dal fix su un singolo repo di un ticket (Fase 3, fix
 * multi-repo): "open" (in attesa di merge), "merged" (mergiata) o
 * "closed_unmerged" (chiusa senza merge). L'enum Postgres deriva da questo
 * schema: valori e validazione non possono divergere.
 */
export const prStateSchema = z.enum(["open", "merged", "closed_unmerged"]);
export type PrState = z.infer<typeof prStateSchema>;

/**
 * Proiezione pubblica dello stato PR per-repo di un ticket (Fase 3): una voce
 * per ogni repository effettivamente modificato dal fix, con il branch, la PR
 * aperta (se già aperta) e il suo stato. È l'unico legame ticket↔repo esposto:
 * il ticket appartiene solo al progetto. Popolata dopo l'esecuzione dell'agente;
 * vuota prima. `repositoryName` è opzionale (comodità di UI); slug e id sono
 * sempre presenti.
 */
export const ticketRepositorySchema = z.object({
  repositoryId: z.uuid(),
  repositorySlug: z.string().min(1),
  repositoryName: z.string().min(1).optional(),
  branch: z.string().min(1),
  prUrl: z.url().nullable(),
  prState: prStateSchema,
});
export type TicketRepository = z.infer<typeof ticketRepositorySchema>;
