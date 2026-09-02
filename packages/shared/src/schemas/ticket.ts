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
  "widget",
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

/**
 * Forma pubblica di un ticket nelle risposte API: la riga del DB con le date
 * in ISO 8601. Alimenta anche l'OpenAPI generata.
 */
export const ticketSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  type: ticketTypeSchema,
  priority: ticketPrioritySchema,
  status: ticketStatusSchema,
  source: ticketSourceSchema,
  assigneeId: z.uuid().nullable(),
  // Milestone a cui il ticket è assegnato; null = nessuna milestone.
  milestoneId: z.uuid().nullable(),
  // Stima di sforzo 1–5 del triage AI; null finché il ticket non è triagiato.
  effort: effortSchema.nullable(),
  labels: z.array(z.string()),
  technicalPayload: z.unknown().nullable(),
  occurrences: z.number().int(),
  lastSeenAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Ticket = z.infer<typeof ticketSchema>;

/**
 * Dettaglio del ticket: la forma pubblica più lo stato PR per-repo (Fase 3,
 * fix multi-repo). `repositories` elenca una voce per ogni repository
 * effettivamente modificato dal fix (righe `ticket_repositories`), con branch,
 * PR e stato. Vuoto prima dell'esecuzione dell'agente. È l'unico legame
 * ticket↔repo: il ticket appartiene solo al progetto.
 */
export const ticketDetailSchema = ticketSchema.extend({
  // Piano di implementazione e contenuto d'origine (design/piano collegati al
  // ticket): testo libero, null finché non impostati. Solo nel dettaglio: sono
  // potenzialmente grandi e fuori posto nelle liste.
  implementationPlan: z.string().nullable(),
  originContent: z.string().nullable(),
  repositories: z.array(ticketRepositorySchema),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

/**
 * Item della lista ticket: la forma pubblica più il conteggio dei repository
 * toccati (righe `ticket_repositories`), utile ai badge di board/lista senza
 * caricare l'elenco completo per ogni ticket.
 */
export const ticketListItemSchema = ticketSchema.extend({
  repositoryCount: z.number().int(),
});
export type TicketListItem = z.infer<typeof ticketListItemSchema>;

/**
 * Pagina della lista ticket: gli item più il cursore della pagina successiva
 * (null sull'ultima). L'involucro sta qui accanto agli item e non nelle rotte
 * perché lo leggono in tre — server, SPA e app mobile — e una copia per
 * lettore è esattamente ciò che questo pacchetto esiste per evitare.
 */
export const ticketPageSchema = z.object({
  items: z.array(ticketListItemSchema),
  nextCursor: z.string().nullable(),
});
export type TicketPage = z.infer<typeof ticketPageSchema>;
