import { z } from "zod";
import { milestoneSchema } from "./milestone.js";

/**
 * `GET /api/projects/pulses` (lotto 7, voce 4): il polso dei progetti calcolato
 * dal SERVER, con la formula di `pulseOf` (`tasks/pulse.ts`) sugli stessi dati
 * che il renderer leggeva con otto letture per progetto — le task aperte per
 * famiglia, le ferme, il traguardo aperto più vicino, le decisioni rivolte a
 * chi guarda, le richieste da trasformare, Claude al lavoro e in attesa di chi
 * guarda. Le task si contano senza il tetto delle 2000 righe dell'elenco
 * (`truncated` solo oltre {@link PROJECT_PULSES_TASK_CAP}).
 */
export const PROJECT_PULSES_TASK_CAP = 10_000;

export const projectPulseViewSchema = z.object({
  projectId: z.uuid(),
  open: z.object({ todo: z.number().int(), active: z.number().int() }),
  stalled: z.number().int(),
  waitingOnMe: z.boolean(),
  claudeWorking: z.boolean(),
  /** Il traguardo aperto con la scadenza più vicina (anche passata); null se nessuno. */
  nextMilestone: milestoneSchema.nullable(),
  /** Di cosa è fatto `waitingOnMe` (additivo: per dirlo nella riga). */
  waiting: z
    .object({ decisionsForMe: z.number().int(), requestsToConvert: z.number().int(), claudeWaitingForMe: z.number().int() })
    .default({ decisionsForMe: 0, requestsToConvert: 0, claudeWaitingForMe: 0 }),
  /** Le task aperte hanno superato il tetto: i numeri sono «almeno». */
  truncated: z.boolean().default(false),
});
export type ProjectPulseView = z.infer<typeof projectPulseViewSchema>;

export const projectPulsesQuerySchema = z.object({
  /** CSV di id; assente = tutti i progetti che chi guarda vede. Un progetto invisibile non compare. */
  projectIds: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0))
    .pipe(z.array(z.uuid()).max(500))
    .optional(),
});

export const projectPulsesResponseSchema = z.object({ items: z.array(projectPulseViewSchema) });
export type ProjectPulsesResponse = z.infer<typeof projectPulsesResponseSchema>;
