import { z } from "zod";
import { ticketStatusSchema } from "./ticket.js";

/**
 * Milestone di PROGETTO: raggruppa i ticket verso un obiettivo con scadenza.
 *
 * Gli schemi vivono qui, e non solo dentro la rotta del server, perché la web
 * app li usa per tipare il proprio client: prima aveva le sue interfacce
 * scritte a mano, ed è così che la creazione dalla UI è potuta divergere dal
 * body che il server esigeva senza che nulla se ne accorgesse.
 *
 * `repositoryId` NON fa parte della proiezione pubblica: dalla fase 5 è un
 * dettaglio d'origine nullable sulla riga, non un'informazione di prodotto.
 */
export const milestoneStatusSchema = z.enum(["open", "closed"]);
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;

export const milestoneSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  /** Descrizione libera; null = nessuna. */
  description: z.string().nullable(),
  /** Scadenza ISO 8601; null = nessuna scadenza. */
  dueDate: z.iso.datetime().nullable(),
  status: milestoneStatusSchema,
  /**
   * Quando la milestone è stata chiusa; null se aperta (riaprirla lo azzera).
   * `status` dice CHE è chiusa, questo QUANDO — è il dato che serve alla
   * timeline di progetto per collocare l'evento.
   */
  closedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Milestone = z.infer<typeof milestoneSchema>;

/**
 * Avanzamento di una milestone: totale, completati e ripartizione per stato.
 *
 * `byStatus` è un record PARZIALE: il server oggi emette tutti gli stati, ma
 * promettere al client che ci siano sempre tutti è una garanzia che nessuno
 * vuole dover mantenere quando l'insieme degli stati cambia — e i consumatori
 * leggono comunque una chiave alla volta.
 */
export const milestoneCountsSchema = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  byStatus: z.partialRecord(ticketStatusSchema, z.number().int()),
});
export type MilestoneCounts = z.infer<typeof milestoneCountsSchema>;

/** Milestone con avanzamento (lista, dettaglio, PATCH). */
export const milestoneWithCountsSchema = milestoneSchema.extend({
  counts: milestoneCountsSchema,
});
export type MilestoneWithCounts = z.infer<typeof milestoneWithCountsSchema>;

const nameSchema = z.string().min(1).max(200);
const descriptionSchema = z.string().max(5000).nullable();
// ISO datetime o null (azzeramento). `.optional()` separa "campo assente" da "null".
const dueDateSchema = z.iso.datetime().nullable();

/**
 * Body di creazione. `repositoryId` è OPZIONALE: la milestone appartiene al
 * progetto, e la web app non lo manda. Quando c'è, deve appartenere a quel
 * progetto (400 altrimenti).
 */
export const milestoneDraftSchema = z.object({
  projectId: z.uuid(),
  repositoryId: z.uuid().optional(),
  name: nameSchema,
  description: descriptionSchema.optional(),
  dueDate: dueDateSchema.optional(),
  status: milestoneStatusSchema.optional(),
});
export type MilestoneDraft = z.infer<typeof milestoneDraftSchema>;

/**
 * Body di modifica: tutti i campi opzionali, gli assenti restano invariati.
 * `closedAt` NON è modificabile a mano — lo governa il passaggio di `status`,
 * così non può esistere una milestone chiusa senza data di chiusura.
 */
export const milestonePatchSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  dueDate: dueDateSchema.optional(),
  status: milestoneStatusSchema.optional(),
});
export type MilestonePatch = z.infer<typeof milestonePatchSchema>;
